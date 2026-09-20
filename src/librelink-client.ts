import {
  LibreLinkUpApi,
  LibreLinkApiError,
  RawGlucoseItem,
  LibreActiveSensor,
  LibreGraphResponse
} from './librelink-api.js';
import { GlucoseReading, SensorInfo, TrendType, LibreLinkConfig } from './types.js';

/** LibreLink Up `TrendArrow` values, in API order. */
const TREND_ARROW_MAP: TrendType[] = [
  TrendType.FLAT,             // 0 - NotComputable
  TrendType.SINGLE_DOWN,      // 1
  TrendType.FORTY_FIVE_DOWN,  // 2
  TrendType.FLAT,             // 3
  TrendType.FORTY_FIVE_UP,    // 4
  TrendType.SINGLE_UP         // 5
];

/** Device type ids we can name with confidence. */
const DEVICE_TYPE_NAMES: Record<number, string> = {
  40066: 'FreeStyle Libre 3'
};

/** A reading older than this is not treated as a live sensor value. */
const STALE_READING_MS = 15 * 60 * 1000;

export interface ConnectionValidationResult {
  valid: boolean;
  code?: string;
  message?: string;
}

export class LibreLinkClient {
  private api: LibreLinkUpApi;
  private config: LibreLinkConfig;
  private lastReading: GlucoseReading | null = null;
  private cache: Map<string, { data: any; timestamp: number }> = new Map();

  constructor(config: LibreLinkConfig) {
    this.config = config;
    this.api = new LibreLinkUpApi({
      email: config.credentials.email,
      password: config.credentials.password,
      region: config.client.region,
      version: config.client.version
    });
  }

  /** The `version` header actually in use, after the minimum is enforced. */
  get lluVersion(): string {
    return this.api.lluVersion;
  }

  private mapTrendArrow(trendArrow?: number): TrendType {
    if (typeof trendArrow !== 'number') {
      return TrendType.FLAT;
    }
    return TREND_ARROW_MAP[trendArrow] ?? TrendType.FLAT;
  }

  private mapGlucoseReading(item: RawGlucoseItem): GlucoseReading {
    const value = item.ValueInMgPerDl;
    const isHigh = value > this.config.ranges.target_high;
    const isLow = value < this.config.ranges.target_low;

    return {
      value,
      timestamp: new Date(item.Timestamp),
      trend: this.mapTrendArrow(item.TrendArrow),
      isHigh,
      isLow,
      color: isHigh ? 'red' : isLow ? 'orange' : 'green'
    };
  }

  private getCachedData(key: string): any | null {
    if (!this.config.cache.enabled) {
      return null;
    }

    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }

    const isExpired = Date.now() - cached.timestamp > this.config.cache.ttl_minutes * 60 * 1000;
    if (isExpired) {
      this.cache.delete(key);
      return null;
    }

    return cached.data;
  }

  private setCachedData(key: string, data: any): void {
    if (this.config.cache.enabled) {
      this.cache.set(key, {
        data,
        timestamp: Date.now()
      });
    }
  }

  /**
   * One graph fetch backs current glucose, history and sensor info, so a single
   * cache entry keeps all three within the API's rate limits.
   */
  private async getGraph(): Promise<LibreGraphResponse> {
    const cached = this.getCachedData('graph');
    if (cached) {
      return cached;
    }

    const graph = await this.api.fetchGraph();
    this.setCachedData('graph', graph);
    return graph;
  }

  /**
   * Preserve typed API errors verbatim; they already carry an accurate code and
   * a message safe to show. Only genuinely unexpected failures are wrapped.
   */
  private rethrow(error: unknown, fallbackCode: string, fallbackMessage: string): never {
    if (error instanceof LibreLinkApiError) {
      throw error;
    }

    const wrapped = new Error(
      `${fallbackMessage}${error instanceof Error ? `: ${error.message}` : ''}`
    ) as Error & { code: string };
    wrapped.code = fallbackCode;
    throw wrapped;
  }

  async getCurrentGlucose(): Promise<GlucoseReading> {
    try {
      const graph = await this.getGraph();
      const item = graph.connection.glucoseItem ?? graph.connection.glucoseMeasurement;

      if (!item) {
        throw new LibreLinkApiError(
          'SENSOR_UNAVAILABLE',
          'The sensor returned no current glucose measurement. It may be warming up, out of range of the phone, or expired.'
        );
      }

      const reading = this.mapGlucoseReading(item);
      this.lastReading = reading;
      return reading;
    } catch (error) {
      this.rethrow(error, 'GLUCOSE_READ_FAILED', 'Failed to read current glucose');
    }
  }

  async getGlucoseHistory(hours: number = 24): Promise<GlucoseReading[]> {
    try {
      const graph = await this.getGraph();

      if (graph.graphData.length === 0) {
        throw new LibreLinkApiError(
          'SENSOR_UNAVAILABLE',
          'LibreLink Up returned no glucose history. The sensor may be warming up or no data has been uploaded yet.'
        );
      }

      const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
      return graph.graphData
        .map(item => this.mapGlucoseReading(item))
        .filter(reading => reading.timestamp >= cutoffTime)
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    } catch (error) {
      this.rethrow(error, 'HISTORY_READ_FAILED', 'Failed to read glucose history');
    }
  }

  private mapSensor(active: LibreActiveSensor, latestReadingAt: Date | null): SensorInfo {
    const activationTime = new Date(active.sensor.a * 1000);
    const isFresh =
      latestReadingAt !== null && Date.now() - latestReadingAt.getTime() < STALE_READING_MS;

    return {
      deviceId: active.sensor.deviceId,
      serialNumber: active.sensor.sn,
      activationTime,
      state: isFresh ? 'Active' : 'No recent data',
      deviceType: DEVICE_TYPE_NAMES[active.device.dtid] ?? `Unknown (device type ${active.device.dtid})`
    };
  }

  async getSensorInfo(): Promise<SensorInfo[]> {
    try {
      const graph = await this.getGraph();
      const item = graph.connection.glucoseItem ?? graph.connection.glucoseMeasurement;
      const latestReadingAt = item ? new Date(item.Timestamp) : null;

      if (graph.activeSensors.length > 0) {
        return graph.activeSensors.map(sensor => this.mapSensor(sensor, latestReadingAt));
      }

      // The connection can still carry sensor details when activeSensors is empty.
      if (graph.connection.sensor) {
        return [
          this.mapSensor(
            { sensor: graph.connection.sensor, device: { did: '', dtid: -1 } },
            latestReadingAt
          )
        ];
      }

      throw new LibreLinkApiError(
        'SENSOR_UNAVAILABLE',
        'No active sensor is reported for this LibreLinkUp connection.'
      );
    } catch (error) {
      this.rethrow(error, 'SENSOR_INFO_FAILED', 'Failed to read sensor information');
    }
  }

  /**
   * Report why a connection failed rather than collapsing every cause into
   * "check your credentials or sensor" — an auth or API-compatibility failure
   * is not a sensor problem.
   */
  async validateConnection(): Promise<ConnectionValidationResult> {
    try {
      await this.api.login();
      const connections = await this.api.fetchConnections();

      if (connections.length === 0) {
        // Produces the account-type-aware NO_CONNECTIONS message.
        await this.api.getPatientId();
      }

      await this.getCurrentGlucose();
      return { valid: true };
    } catch (error) {
      if (error instanceof LibreLinkApiError) {
        return { valid: false, code: error.code, message: error.message };
      }
      return {
        valid: false,
        code: 'UNKNOWN_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Poll for new readings. Kept for future streaming support. */
  async startStream(
    callback: (reading: GlucoseReading) => void,
    intervalMs: number = 60000
  ): Promise<void> {
    for (;;) {
      this.cache.delete('graph');
      const reading = await this.getCurrentGlucose();

      if (!this.lastReading || reading.timestamp.getTime() !== this.lastReading.timestamp.getTime()) {
        callback(reading);
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}
