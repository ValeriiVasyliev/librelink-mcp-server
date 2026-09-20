import {
  GlucoseReading,
  GlucoseStats,
  TrendAnalysis,
  DataCoverage,
  GlucoseEvent,
  LibreLinkConfig
} from './types.js';

/** A gap longer than this breaks a run; the LibreLink graph feed is ~15 min. */
const MAX_GAP_MINUTES = 30;

/** ATTD/ADA consensus: an event is >=15 min beyond a bound, and ends after >=15 min back inside. */
const MIN_EVENT_MINUTES = 15;

/** "Extended" hyperglycemia, in minutes above the target ceiling. */
const MIN_HYPER_MINUTES = 60;

/** Consecutive readings must move this far to count as a turn rather than noise (mg/dL). */
const SWING_THRESHOLD = 30;

/**
 * A rise spread over longer than this is all-day drift rather than a discrete
 * excursion. Six hours, not two: a rebound from a treated hypo can climb for
 * most of an afternoon, and that is exactly the excursion worth reporting.
 */
const MAX_EXCURSION_MINUTES = 360;

/** GMI is only defined over >=14 days of CGM data. */
const MIN_GMI_DAYS = 14;

/** A time-of-day pattern needs more than one instance before it is a pattern. */
const MIN_PATTERN_DAYS = 3;

/** Minimum readings inside a time-of-day window before it is worth judging. */
const MIN_WINDOW_READINGS = 4;

interface Run {
  start: Date;
  end: Date;
  durationMinutes: number;
  extremeValue: number;
}

interface Excursion {
  amplitude: number;
  durationMinutes: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}

export class GlucoseAnalytics {
  private config: LibreLinkConfig;

  constructor(config: LibreLinkConfig) {
    this.config = config;
  }

  /** Analytics must not depend on the caller having sorted its input. */
  private sorted(readings: GlucoseReading[]): GlucoseReading[] {
    return [...readings].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * State what the data actually reaches. `requestedHours` defaults to the
   * observed span so that a caller who asked for nothing in particular is not
   * told its data was truncated.
   */
  private describeCoverage(readings: GlucoseReading[], requestedHours?: number): DataCoverage {
    const first = readings[0].timestamp;
    const last = readings[readings.length - 1].timestamp;
    const spanHours = minutesBetween(first, last) / 60;
    const requested = requestedHours ?? spanHours;
    const coveragePercent = requested > 0 ? Math.min((spanHours / requested) * 100, 100) : 100;

    return {
      readingCount: readings.length,
      firstReading: first,
      lastReading: last,
      spanHours: round2(spanHours),
      requestedHours: round2(requested),
      coveragePercent: round2(coveragePercent),
      truncated: coveragePercent < 90
    };
  }

  calculateGlucoseStats(readings: GlucoseReading[], requestedHours?: number): GlucoseStats {
    if (!readings || readings.length === 0) {
      throw new Error('No glucose readings provided for analysis');
    }

    const ordered = this.sorted(readings);
    const coverage = this.describeCoverage(ordered, requestedHours);
    const caveats: string[] = [];

    const values = ordered.map(r => r.value);
    const average = values.reduce((sum, val) => sum + val, 0) / values.length;

    const variance =
      values.reduce((sum, val) => sum + Math.pow(val - average, 2), 0) / values.length;
    const standardDeviation = Math.sqrt(variance);
    const coefficientOfVariation = (standardDeviation / average) * 100;

    if (coverage.truncated) {
      caveats.push(
        `Data covers ${coverage.spanHours}h of the ${coverage.requestedHours}h requested ` +
          `(${coverage.coveragePercent}%). LibreLink Up returns only the recent graph window, ` +
          `so every figure below describes that window, not the requested period.`
      );
    }

    const spanDays = coverage.spanHours / 24;

    // GMI below 14 days is not an A1c estimate, it is an average dressed up as one.
    let gmi: number | null = null;
    if (spanDays >= MIN_GMI_DAYS) {
      gmi = round2(3.31 + 0.02392 * average);
    } else {
      caveats.push(
        `GMI not reported: it requires at least ${MIN_GMI_DAYS} days of data and this window ` +
          `spans ${round2(spanDays)} day(s).`
      );
    }

    if (spanDays < MIN_GMI_DAYS) {
      caveats.push(
        `Time-in-range and variability (CV ${round2(coefficientOfVariation)}%) are computed over ` +
          `${round2(spanDays)} day(s). The usual targets (>70% in range, CV <=36%) are defined ` +
          `over 14 days and should not be compared against this directly.`
      );
    }

    const { target_low, target_high } = this.config.ranges;
    const inRange = values.filter(v => v >= target_low && v <= target_high).length;
    const belowRange = values.filter(v => v < target_low).length;
    const aboveRange = values.filter(v => v > target_high).length;

    return {
      average: round2(average),
      gmi,
      timeInRange: round2((inRange / values.length) * 100),
      timeBelowRange: round2((belowRange / values.length) * 100),
      timeAboveRange: round2((aboveRange / values.length) * 100),
      standardDeviation: round2(standardDeviation),
      coefficientOfVariation: round2(coefficientOfVariation),
      caveats,
      coverage
    };
  }

  analyzeTrends(
    readings: GlucoseReading[],
    period: 'daily' | 'weekly' | 'monthly' = 'weekly',
    requestedHours?: number
  ): TrendAnalysis {
    if (!readings || readings.length === 0) {
      throw new Error('No glucose readings provided for trend analysis');
    }

    const ordered = this.sorted(readings);
    const coverage = this.describeCoverage(ordered, requestedHours);
    const spanDays = coverage.spanHours / 24;

    const patterns: string[] = [];
    const notAssessed: string[] = [];

    if (coverage.truncated) {
      notAssessed.push(
        `Only ${coverage.spanHours}h of the ${coverage.requestedHours}h requested was available; ` +
          `patterns below describe that window only.`
      );
    }

    // Dawn phenomenon
    const dawn = this.detectDawnPhenomenon(ordered);
    if (dawn.detected === null) {
      notAssessed.push(`Dawn phenomenon: ${dawn.reason}`);
    } else if (dawn.detected) {
      patterns.push(
        `Dawn phenomenon detected - glucose rises ${dawn.rise} mg/dL through the early morning`
      );
    }
    if (dawn.detected !== null && spanDays < MIN_PATTERN_DAYS) {
      notAssessed.push(
        `Dawn phenomenon judged from ${round2(spanDays)} day(s); a recurring pattern needs ` +
          `at least ${MIN_PATTERN_DAYS} days.`
      );
    }

    // Meal response
    const excursions = this.findExcursions(ordered);
    let mealResponse: number | null = null;
    let largestExcursion: number | null = null;

    if (excursions.length > 0) {
      mealResponse =
        round2(excursions.reduce((sum, e) => sum + e.amplitude, 0) / excursions.length);
      largestExcursion = round2(Math.max(...excursions.map(e => e.amplitude)));

      if (largestExcursion >= 80) {
        patterns.push(
          `Large glucose excursions - ${excursions.length} rise(s) averaging ` +
            `+${mealResponse} mg/dL, largest +${largestExcursion} mg/dL`
        );
      } else {
        patterns.push(
          `Moderate glucose excursions - ${excursions.length} rise(s) averaging ` +
            `+${mealResponse} mg/dL`
        );
      }
    } else if (ordered.length >= MIN_WINDOW_READINGS) {
      patterns.push(`No rises of ${SWING_THRESHOLD} mg/dL or more in this window`);
    } else {
      notAssessed.push(
        `Meal response: ${ordered.length} reading(s) is too few to identify an excursion.`
      );
    }

    // Overnight stability
    const overnight = ordered.filter(r => {
      const hour = r.timestamp.getHours();
      return hour >= 23 || hour <= 6;
    });

    let overnightStability: number | null = null;
    if (overnight.length >= MIN_WINDOW_READINGS) {
      const values = overnight.map(r => r.value);
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
      overnightStability = round2(Math.sqrt(variance));

      if (overnightStability < 10) {
        patterns.push(
          `Stable overnight - SD ${overnightStability} mg/dL across ${overnight.length} readings`
        );
      } else if (overnightStability > 30) {
        patterns.push(
          `High overnight variability - SD ${overnightStability} mg/dL across ` +
            `${overnight.length} readings`
        );
      }
    } else {
      notAssessed.push(
        `Overnight stability: ${overnight.length} reading(s) between 23:00 and 06:00, ` +
          `fewer than the ${MIN_WINDOW_READINGS} needed.`
      );
    }

    // Events, measured in time rather than in reading counts
    const hypoglycemicEvents = this.findEvents(
      ordered,
      r => r.value < this.config.ranges.target_low,
      MIN_EVENT_MINUTES,
      'min'
    );
    const hyperglycemicPeriods = this.findEvents(
      ordered,
      r => r.value > this.config.ranges.target_high,
      MIN_HYPER_MINUTES,
      'max'
    );

    hypoglycemicEvents.forEach(event => {
      patterns.push(
        `Hypoglycemic event - ${Math.round(event.durationMinutes)} min below ` +
          `${this.config.ranges.target_low}, nadir ${event.extremeValue} mg/dL`
      );
    });
    hyperglycemicPeriods.forEach(event => {
      patterns.push(
        `Extended hyperglycemia - ${Math.round(event.durationMinutes)} min above ` +
          `${this.config.ranges.target_high}, peak ${event.extremeValue} mg/dL`
      );
    });

    return {
      patterns,
      dawnPhenomenon: dawn.detected,
      mealResponse,
      largestExcursion,
      overnightStability,
      hypoglycemicEvents,
      hyperglycemicPeriods,
      notAssessed,
      coverage
    };
  }

  /**
   * Compare the early-morning hours, but only when they actually hold readings.
   * Treating a missing hour as 0 turned any morning data at all into a "rise".
   */
  private detectDawnPhenomenon(
    readings: GlucoseReading[]
  ): { detected: boolean | null; reason?: string; rise?: number } {
    const buckets = new Map<number, number[]>();
    readings.forEach(reading => {
      const hour = reading.timestamp.getHours();
      const bucket = buckets.get(hour);
      if (bucket) {
        bucket.push(reading.value);
      } else {
        buckets.set(hour, [reading.value]);
      }
    });

    const hourlyAverage = (hour: number): number | undefined => {
      const values = buckets.get(hour);
      if (!values || values.length === 0) {
        return undefined;
      }
      return values.reduce((sum, v) => sum + v, 0) / values.length;
    };

    const preDawn = hourlyAverage(4);
    const dawn6 = hourlyAverage(6);
    const dawn8 = hourlyAverage(8);

    if (preDawn === undefined) {
      return { detected: null, reason: 'no readings in the 04:00 hour to compare against' };
    }
    if (dawn6 === undefined && dawn8 === undefined) {
      return { detected: null, reason: 'no readings in the 06:00 or 08:00 hours' };
    }

    const riseTo8 = dawn8 === undefined ? null : dawn8 - preDawn;
    const riseTo6 = dawn6 === undefined ? null : dawn6 - preDawn;

    const detected = (riseTo8 !== null && riseTo8 > 20) || (riseTo6 !== null && riseTo6 > 15);
    const rise = Math.max(riseTo8 ?? -Infinity, riseTo6 ?? -Infinity);

    return { detected, rise: round2(rise) };
  }

  /**
   * Threshold-based swing detection: walk the series tracking the running
   * extreme, and record a turn only once the value has moved SWING_THRESHOLD
   * against it. This catches a slow multi-hour climb, which the previous
   * three-point peak test could not see at all.
   */
  private findExcursions(readings: GlucoseReading[]): Excursion[] {
    if (readings.length < 2) {
      return [];
    }

    const excursions: Excursion[] = [];
    let extreme = readings[0];
    let direction: 'up' | 'down' | 'unknown' = 'unknown';
    let lastTrough: GlucoseReading | null = null;

    const recordRise = (trough: GlucoseReading, peak: GlucoseReading): void => {
      const amplitude = peak.value - trough.value;
      const durationMinutes = minutesBetween(trough.timestamp, peak.timestamp);
      if (amplitude >= SWING_THRESHOLD && durationMinutes <= MAX_EXCURSION_MINUTES) {
        excursions.push({ amplitude, durationMinutes });
      }
    };

    for (let i = 1; i < readings.length; i++) {
      const reading = readings[i];

      // A long gap invalidates the swing in progress; restart from here.
      if (minutesBetween(readings[i - 1].timestamp, reading.timestamp) > MAX_GAP_MINUTES) {
        extreme = reading;
        direction = 'unknown';
        lastTrough = null;
        continue;
      }

      if (direction === 'up') {
        if (reading.value > extreme.value) {
          extreme = reading;
        } else if (extreme.value - reading.value >= SWING_THRESHOLD) {
          if (lastTrough) {
            recordRise(lastTrough, extreme);
          }
          direction = 'down';
          extreme = reading;
        }
      } else if (direction === 'down') {
        if (reading.value < extreme.value) {
          extreme = reading;
        } else if (reading.value - extreme.value >= SWING_THRESHOLD) {
          lastTrough = extreme;
          direction = 'up';
          extreme = reading;
        }
      } else {
        if (reading.value - extreme.value >= SWING_THRESHOLD) {
          lastTrough = extreme;
          direction = 'up';
          extreme = reading;
        } else if (extreme.value - reading.value >= SWING_THRESHOLD) {
          direction = 'down';
          extreme = reading;
        }
      }
    }

    // A rise still in progress at the end of the window is a real excursion.
    if (direction === 'up' && lastTrough) {
      recordRise(lastTrough, extreme);
    }

    return excursions;
  }

  /**
   * Find stretches beyond a bound, measured by elapsed time. The previous
   * version counted consecutive readings and assumed 10 minutes each, so it
   * both mis-sized every event and treated readings either side of a multi-hour
   * data gap as contiguous.
   */
  private findEvents(
    readings: GlucoseReading[],
    beyondBound: (reading: GlucoseReading) => boolean,
    minDurationMinutes: number,
    extreme: 'min' | 'max'
  ): GlucoseEvent[] {
    const runs: Run[] = [];
    let current: GlucoseReading[] = [];

    const flush = (): void => {
      if (current.length === 0) {
        return;
      }
      const values = current.map(r => r.value);
      runs.push({
        start: current[0].timestamp,
        end: current[current.length - 1].timestamp,
        durationMinutes: minutesBetween(current[0].timestamp, current[current.length - 1].timestamp),
        extremeValue: extreme === 'min' ? Math.min(...values) : Math.max(...values)
      });
      current = [];
    };

    readings.forEach((reading, i) => {
      if (i > 0 && minutesBetween(readings[i - 1].timestamp, reading.timestamp) > MAX_GAP_MINUTES) {
        flush();
      }
      if (beyondBound(reading)) {
        current.push(reading);
      } else {
        flush();
      }
    });
    flush();

    // Consensus definition: an event ends only after >=15 min back inside range,
    // so runs closer together than that are one event, not two.
    const merged: Run[] = [];
    runs.forEach(run => {
      const previous = merged[merged.length - 1];
      if (previous && minutesBetween(previous.end, run.start) < MIN_EVENT_MINUTES) {
        previous.end = run.end;
        previous.durationMinutes = minutesBetween(previous.start, run.end);
        previous.extremeValue =
          extreme === 'min'
            ? Math.min(previous.extremeValue, run.extremeValue)
            : Math.max(previous.extremeValue, run.extremeValue);
      } else {
        merged.push({ ...run });
      }
    });

    return merged
      .filter(run => run.durationMinutes >= minDurationMinutes)
      .map(run => ({
        start: run.start,
        end: run.end,
        durationMinutes: round2(run.durationMinutes),
        extremeValue: run.extremeValue
      }));
  }

  generateInsights(readings: GlucoseReading[], requestedHours?: number): string[] {
    const stats = this.calculateGlucoseStats(readings, requestedHours);
    const insights: string[] = [];

    if (stats.timeInRange >= 70) {
      insights.push('Time in range above 70%');
    } else if (stats.timeInRange >= 50) {
      insights.push('Time in range between 50% and 70% - short of the usual 70% target');
    } else {
      insights.push('Time in range below 50% - most readings fall outside the target range');
    }

    if (stats.coefficientOfVariation <= 36) {
      insights.push(`Glucose variability within target (CV ${stats.coefficientOfVariation}%)`);
    } else {
      insights.push(`Glucose variability above target (CV ${stats.coefficientOfVariation}%, target <=36%)`);
    }

    if (stats.gmi === null) {
      insights.push(`GMI not available - ${MIN_GMI_DAYS} days of data required`);
    } else if (stats.gmi < 7.0) {
      insights.push(`GMI ${stats.gmi}% - below the common 7% target`);
    } else {
      insights.push(`GMI ${stats.gmi}% - at or above the common 7% target`);
    }

    return [...insights, ...stats.caveats];
  }
}
