/**
 * Minimal, self-contained client for the unofficial LibreLink Up API.
 *
 * Replaces `libre-link-unofficial-api`, which is unmaintained (latest publish
 * 1.0.0-alpha.7, March 2025) and hardcodes `version: 4.7.0` with no supported
 * way to add the `Account-Id` header the API has required since October 2025.
 *
 * Verified API contract (as of 2025-09):
 *   - `version` header must be >= 4.16.0, else HTTP 403 with body status 920.
 *   - `Account-Id` header (SHA-256 hex of the authenticated user id) is required
 *     on every authenticated request, else HTTP 400 `RequiredHeaderMissing`.
 */

import { createHash } from 'crypto';

/** Lowest `version` header the API currently accepts. */
export const MINIMUM_LLU_VERSION = '4.16.0';

export const REGION_URLS: Record<string, string> = {
  US: 'https://api-us.libreview.io',
  EU: 'https://api-eu.libreview.io'
};

export type LibreLinkErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'TERMS_NOT_ACCEPTED'
  | 'API_VERSION_UNSUPPORTED'
  | 'MISSING_ACCOUNT_ID'
  | 'REGION_ERROR'
  | 'TOKEN_EXPIRED'
  | 'RATE_LIMITED'
  | 'NO_CONNECTIONS'
  | 'SENSOR_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_API_ERROR';

export class LibreLinkApiError extends Error {
  readonly code: LibreLinkErrorCode;
  readonly httpStatus?: number;
  readonly apiStatus?: number;
  readonly endpoint?: string;

  constructor(
    code: LibreLinkErrorCode,
    message: string,
    details: { httpStatus?: number; apiStatus?: number; endpoint?: string } = {}
  ) {
    super(message);
    this.name = 'LibreLinkApiError';
    this.code = code;
    this.httpStatus = details.httpStatus;
    this.apiStatus = details.apiStatus;
    this.endpoint = details.endpoint;
  }
}

export interface RawGlucoseItem {
  Timestamp: string;
  FactoryTimestamp?: string;
  ValueInMgPerDl: number;
  Value?: number;
  TrendArrow?: number;
  MeasurementColor?: number;
  isHigh?: boolean;
  isLow?: boolean;
  type?: number;
}

export interface LibreActiveSensor {
  sensor: { deviceId: string; sn: string; a: number; w?: number; pt?: number };
  device: { did: string; dtid: number; v?: string };
}

export interface LibreGraphResponse {
  connection: {
    id: string;
    patientId: string;
    sensor?: LibreActiveSensor['sensor'];
    glucoseItem?: RawGlucoseItem;
    glucoseMeasurement?: RawGlucoseItem;
    [key: string]: any;
  };
  activeSensors: LibreActiveSensor[];
  graphData: RawGlucoseItem[];
}

export interface LibreLinkApiOptions {
  email: string;
  password: string;
  region?: string;
  /** `version` header. Values below {@link MINIMUM_LLU_VERSION} are raised to it. */
  version?: string;
  /** Pin a specific patient when the account follows more than one. */
  patientId?: string;
}

/** `4.16.0` -> [4, 16, 0]; tolerant of extra or missing segments. */
function parseVersion(version: string): number[] {
  return version.split('.').map(part => parseInt(part, 10) || 0);
}

export function isVersionAtLeast(version: string, minimum: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }

  return true;
}

/** Never let a stale configured version reintroduce the 403/920 failure. */
export function resolveLluVersion(configured?: string): string {
  if (!configured || !isVersionAtLeast(configured, MINIMUM_LLU_VERSION)) {
    return MINIMUM_LLU_VERSION;
  }
  return configured;
}

/** The API expects the SHA-256 hex digest of the authenticated user's id. */
export function computeAccountId(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export class LibreLinkUpApi {
  private readonly email: string;
  private readonly password: string;
  private readonly version: string;
  private readonly preferredPatientId?: string;

  private baseUrl: string;
  private accessToken: string | null = null;
  private tokenExpiresAt: number | null = null;
  private accountId: string | null = null;
  private user: Record<string, any> | null = null;

  constructor(options: LibreLinkApiOptions) {
    if (!options.email || !options.password) {
      throw new LibreLinkApiError(
        'INVALID_CREDENTIALS',
        'LibreLink email and password are required.'
      );
    }

    this.email = options.email;
    this.password = options.password;
    this.version = resolveLluVersion(options.version);
    this.preferredPatientId = options.patientId;
    this.baseUrl = REGION_URLS[(options.region || 'US').toUpperCase()] || REGION_URLS.US;
  }

  get me(): Record<string, any> | null {
    return this.user;
  }

  get apiUrl(): string {
    return this.baseUrl;
  }

  get lluVersion(): string {
    return this.version;
  }

  private buildHeaders(authenticated: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      product: 'llu.android',
      version: this.version,
      'accept-encoding': 'gzip',
      'cache-control': 'no-cache',
      connection: 'Keep-Alive',
      'content-type': 'application/json'
    };

    if (authenticated) {
      if (this.accessToken) {
        headers.Authorization = `Bearer ${this.accessToken}`;
      }
      if (this.accountId) {
        headers['Account-Id'] = this.accountId;
      }
    }

    return headers;
  }

  /**
   * Single request. Translates transport and API failures into typed errors.
   * Never includes credentials or tokens in thrown messages.
   */
  private async request(
    endpoint: string,
    init: { method?: string; body?: string; authenticated?: boolean } = {}
  ): Promise<any> {
    const { method = 'GET', body, authenticated = true } = init;
    const url = `${this.baseUrl}/${endpoint}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.buildHeaders(authenticated),
        ...(body ? { body } : {})
      });
    } catch (error) {
      throw new LibreLinkApiError(
        'NETWORK_ERROR',
        `Could not reach the LibreLink Up API (${this.baseUrl}). Check your network connection.`,
        { endpoint }
      );
    }

    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw this.translateHttpError(response.status, payload, endpoint);
    }

    // The API also signals failure in-band with HTTP 200.
    if (payload && typeof payload.status === 'number' && payload.status !== 0) {
      throw this.translateApiStatus(payload, endpoint);
    }

    return payload;
  }

  private translateHttpError(httpStatus: number, payload: any, endpoint: string): LibreLinkApiError {
    const apiStatus = typeof payload?.status === 'number' ? payload.status : undefined;
    const details = { httpStatus, apiStatus, endpoint };

    if (httpStatus === 403 && apiStatus === 920) {
      const required = payload?.data?.minimumVersion ?? MINIMUM_LLU_VERSION;
      return new LibreLinkApiError(
        'API_VERSION_UNSUPPORTED',
        `LibreLink Up rejected the client version. The API now requires version >= ${required}; ` +
          `this client sent ${this.version}. Update librelink-mcp-server or set client.version in ~/.librelink-mcp/config.json.`,
        details
      );
    }

    if (httpStatus === 400 && /RequiredHeaderMissing/i.test(payload?.message ?? '')) {
      return new LibreLinkApiError(
        'MISSING_ACCOUNT_ID',
        'LibreLink Up rejected the request as missing a required header. The Account-Id header ' +
          '(SHA-256 of the account user id) could not be sent — the session is not fully authenticated.',
        details
      );
    }

    if (httpStatus === 401) {
      return new LibreLinkApiError(
        'TOKEN_EXPIRED',
        'The LibreLink Up authentication token was rejected or has expired.',
        details
      );
    }

    if (httpStatus === 429) {
      return new LibreLinkApiError(
        'RATE_LIMITED',
        'LibreLink Up rate limit reached. Wait before retrying.',
        details
      );
    }

    return new LibreLinkApiError(
      'UNKNOWN_API_ERROR',
      `LibreLink Up returned HTTP ${httpStatus} for ${endpoint}${
        apiStatus !== undefined ? ` (API status ${apiStatus})` : ''
      }.`,
      details
    );
  }

  private translateApiStatus(payload: any, endpoint: string): LibreLinkApiError {
    const apiStatus = payload.status as number;
    const details = { apiStatus, endpoint };

    if (apiStatus === 2) {
      return new LibreLinkApiError(
        'INVALID_CREDENTIALS',
        'LibreLink Up rejected the credentials. Verify the email and password work in the LibreLinkUp app.',
        details
      );
    }

    if (apiStatus === 429) {
      return new LibreLinkApiError(
        'RATE_LIMITED',
        'LibreLink Up rate limit reached. Wait before retrying.',
        details
      );
    }

    if (apiStatus === 4) {
      return new LibreLinkApiError(
        'TERMS_NOT_ACCEPTED',
        'The LibreLink Up account must accept updated terms of use or privacy policy. ' +
          'Sign in with the LibreLinkUp app once and accept the prompts, then retry.',
        details
      );
    }

    return new LibreLinkApiError(
      'UNKNOWN_API_ERROR',
      `LibreLink Up returned API status ${apiStatus} for ${endpoint}.`,
      details
    );
  }

  /**
   * Resolve the regional host for a redirect response.
   * `llu/config/country` is unauthenticated; the `country=DE` query is only a
   * lookup key and returns the full regional map regardless of account country.
   */
  private async resolveRegion(region: string): Promise<string> {
    let payload: any;
    try {
      payload = await this.request('llu/config/country?country=DE', { authenticated: false });
    } catch (error) {
      if (error instanceof LibreLinkApiError && error.code === 'NETWORK_ERROR') {
        throw error;
      }
      throw new LibreLinkApiError(
        'REGION_ERROR',
        `Could not look up the LibreLink Up server for region "${region}".`
      );
    }

    const regionalUrl = payload?.data?.regionalMap?.[region]?.lslApi;
    if (!regionalUrl) {
      throw new LibreLinkApiError(
        'REGION_ERROR',
        `LibreLink Up asked to redirect to region "${region}", but no server is published for it.`
      );
    }

    return normalizeBaseUrl(regionalUrl);
  }

  /** Log in, following at most one regional redirect. */
  async login(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const payload = await this.request('llu/auth/login', {
        method: 'POST',
        authenticated: false,
        body: JSON.stringify({ email: this.email, password: this.password })
      });

      const data = payload?.data;

      if (data?.redirect) {
        if (attempt > 0) {
          throw new LibreLinkApiError(
            'REGION_ERROR',
            'LibreLink Up kept redirecting between regions. Check the configured region.'
          );
        }
        this.baseUrl = await this.resolveRegion(data.region);
        continue;
      }

      const token = data?.authTicket?.token;
      const userId = data?.user?.id;

      if (!token || !userId) {
        throw new LibreLinkApiError(
          'UNKNOWN_API_ERROR',
          'LibreLink Up login succeeded but returned no authentication ticket.',
          { endpoint: 'llu/auth/login' }
        );
      }

      this.accessToken = token;
      this.tokenExpiresAt = typeof data.authTicket.expires === 'number'
        ? data.authTicket.expires * 1000
        : null;
      this.accountId = computeAccountId(userId);
      this.user = data.user;
      return;
    }
  }

  private isTokenUsable(): boolean {
    if (!this.accessToken || !this.accountId) {
      return false;
    }
    if (this.tokenExpiresAt === null) {
      return true;
    }
    // Refresh a minute early rather than racing the expiry.
    return Date.now() < this.tokenExpiresAt - 60_000;
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.isTokenUsable()) {
      await this.login();
    }
  }

  /** Authenticated GET that re-authenticates once on an expired token. */
  private async authenticatedGet(endpoint: string): Promise<any> {
    await this.ensureAuthenticated();

    try {
      return await this.request(endpoint);
    } catch (error) {
      if (error instanceof LibreLinkApiError && error.code === 'TOKEN_EXPIRED') {
        this.accessToken = null;
        this.tokenExpiresAt = null;
        await this.login();
        return await this.request(endpoint);
      }
      throw error;
    }
  }

  async fetchConnections(): Promise<any[]> {
    const payload = await this.authenticatedGet('llu/connections');
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  /**
   * The patient whose data to read. LibreLink Up exposes readings through
   * follower connections, so an account with no shared patients has none.
   */
  async getPatientId(): Promise<string> {
    const connections = await this.fetchConnections();

    if (connections.length === 0) {
      const accountType = this.user?.accountType;
      const hint = accountType === 'pat'
        ? ' This account is a patient (sensor-wearer) account with no LibreLinkUp followers. ' +
          'In the LibreLink app open Connected Apps -> LibreLinkUp, invite a follower account, ' +
          'accept the invitation in the LibreLinkUp app, and configure those follower credentials here.'
        : ' Ensure the sensor wearer has shared their data with this LibreLinkUp account and that ' +
          'the invitation was accepted.';

      throw new LibreLinkApiError(
        'NO_CONNECTIONS',
        `No LibreLinkUp patient connections are available for this account.${hint}`,
        { endpoint: 'llu/connections' }
      );
    }

    if (this.preferredPatientId) {
      const match = connections.find((c: any) => c.patientId === this.preferredPatientId);
      if (match) {
        return match.patientId;
      }
    }

    return connections[0].patientId;
  }

  /** Current reading, graph history and active sensors for the patient. */
  async fetchGraph(): Promise<LibreGraphResponse> {
    const patientId = await this.getPatientId();
    const payload = await this.authenticatedGet(`llu/connections/${patientId}/graph`);

    if (!payload?.data?.connection) {
      throw new LibreLinkApiError(
        'SENSOR_UNAVAILABLE',
        'LibreLink Up returned no connection data for the patient.',
        { endpoint: `llu/connections/${patientId}/graph` }
      );
    }

    return {
      connection: payload.data.connection,
      activeSensors: Array.isArray(payload.data.activeSensors) ? payload.data.activeSensors : [],
      graphData: Array.isArray(payload.data.graphData) ? payload.data.graphData : []
    };
  }

  async fetchLogbook(): Promise<RawGlucoseItem[]> {
    const patientId = await this.getPatientId();
    const payload = await this.authenticatedGet(`llu/connections/${patientId}/logbook`);
    return Array.isArray(payload?.data) ? payload.data : [];
  }
}
