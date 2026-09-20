export interface GlucoseReading {
  value: number;           // mg/dL glucose value
  timestamp: Date;         // Reading timestamp
  trend: TrendType;        // Arrow direction (up/down/stable)
  isHigh: boolean;         // Above target range
  isLow: boolean;          // Below target range
  color: string;           // UI color indicator
}

export enum TrendType {
  FLAT = "Flat",
  FORTY_FIVE_UP = "FortyFiveUp", 
  SINGLE_UP = "SingleUp",
  DOUBLE_UP = "DoubleUp",
  FORTY_FIVE_DOWN = "FortyFiveDown",
  SINGLE_DOWN = "SingleDown", 
  DOUBLE_DOWN = "DoubleDown"
}

export interface HistoricalData {
  graphData: GlucoseReading[];    // Array of historical readings
  glucoseMeasurement: GlucoseReading; // Latest reading
  activeSensors: SensorInfo[];     // Sensor status/info
}

export interface SensorInfo {
  deviceId: string;
  serialNumber: string;
  activationTime: Date;
  state: string;           // "Active", "Expired", etc.
  deviceType: string;      // "FreeStyle Libre 3", etc.
}

export interface LibreLinkConfig {
  credentials: {
    email: string;
    password: string;
  };
  client: {
    version: string;         // LibreLink client version
    region: 'US' | 'EU';     // API region
  };
  cache: {
    enabled: boolean;
    ttl_minutes: number;     // Cache time-to-live
  };
  ranges: {
    target_low: number;      // Target range low (default: 70)
    target_high: number;     // Target range high (default: 180)
  };
}

export interface GlucoseStats {
  average: number;
  /**
   * Glucose Management Indicator. null when the window is shorter than
   * MIN_GMI_DAYS: GMI is only defined over >=14 days of CGM data, and a number
   * derived from a few hours would read as an A1c estimate while being noise.
   */
  gmi: number | null;
  timeInRange: number;           // Percentage in target range
  timeBelowRange: number;        // Percentage below target
  timeAboveRange: number;        // Percentage above target
  standardDeviation: number;
  coefficientOfVariation: number;
  /** Why a metric is null, or why a computed one should not be read at face value. */
  caveats: string[];
  coverage: DataCoverage;
}

/**
 * What the data actually spans, as opposed to what the caller asked for. The
 * LibreLink Up graph endpoint returns roughly the last 12 hours regardless of
 * the requested window, so every result has to state its own reach.
 */
export interface DataCoverage {
  readingCount: number;
  firstReading: Date | null;
  lastReading: Date | null;
  /** Hours between the first and last reading actually returned. */
  spanHours: number;
  /** Hours the caller asked for. */
  requestedHours: number;
  /** spanHours as a percentage of requestedHours. */
  coveragePercent: number;
  /** True when the data covers materially less than was requested. */
  truncated: boolean;
}

/** A contiguous stretch of readings beyond a target bound. */
export interface GlucoseEvent {
  start: Date;
  end: Date;
  durationMinutes: number;
  /** Lowest value for a hypo event, highest for a hyper period. */
  extremeValue: number;
}

export interface TrendAnalysis {
  patterns: string[];
  /** null when the 04:00-08:00 window holds too little data to judge. */
  dawnPhenomenon: boolean | null;
  /** Mean rise of detected meal-sized excursions; null when none were found. */
  mealResponse: number | null;
  /** Largest single rise found, in mg/dL; null when none were found. */
  largestExcursion: number | null;
  /** SD of overnight readings; null when the 23:00-06:00 window is too sparse. */
  overnightStability: number | null;
  hypoglycemicEvents: GlucoseEvent[];
  hyperglycemicPeriods: GlucoseEvent[];
  /** Everything the analysis declined to judge, and why. */
  notAssessed: string[];
  coverage: DataCoverage;
}

export interface MCPError {
  code: string;
  message: string;
  details?: any;
}