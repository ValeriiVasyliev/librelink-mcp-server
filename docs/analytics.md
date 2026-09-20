# Analytics

Implemented in `src/glucose-analytics.ts`. Two entry points:
`calculateGlucoseStats()` and `analyzeTrends()`.

## The contract

**A metric is reported only when the data supports it.** When it does not, the
metric is `null` and the reason appears in `caveats` (stats) or `notAssessed`
(trends).

`null` means *"could not be judged from this data"*. It never means *"fine"*.

This is the rule the module previously broke: with no overnight readings at
all, overnight SD defaulted to `0`, `0 < 10` passed the stability check, and
the response claimed *"Excellent overnight glucose stability."* Two readings
were enough to produce it. See [CHANGELOG](../CHANGELOG.md).

## Thresholds

All defined as named constants at the top of the module.

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_GAP_MINUTES` | 30 | A longer gap between readings breaks a run |
| `MIN_EVENT_MINUTES` | 15 | Minimum duration of a glycemic event |
| `MIN_HYPER_MINUTES` | 60 | Minimum duration of *extended* hyperglycemia |
| `SWING_THRESHOLD` | 30 mg/dL | Movement needed to count as a turn, not noise |
| `MAX_EXCURSION_MINUTES` | 360 | A slower rise is drift, not a discrete excursion |
| `MIN_GMI_DAYS` | 14 | Days of data required before GMI is reported |
| `MIN_PATTERN_DAYS` | 3 | Days required before a time-of-day pattern is a pattern |
| `MIN_WINDOW_READINGS` | 4 | Readings required inside a time-of-day window |

## Statistics

`calculateGlucoseStats(readings, requestedHours?)`

| Field | Notes |
| --- | --- |
| `average` | Mean of all readings, mg/dL |
| `gmi` | `3.31 + 0.02392 × average`. **`null` below 14 days** |
| `timeInRange` | Percentage within the configured range, inclusive |
| `timeBelowRange` | Percentage strictly below `target_low` |
| `timeAboveRange` | Percentage strictly above `target_high` |
| `standardDeviation` | Population SD |
| `coefficientOfVariation` | `SD / mean × 100` |
| `caveats` | Why a metric is null, or should not be read at face value |
| `coverage` | What the data actually spans |

Percentages use the configured `target_low` / `target_high`, not hardcoded
70/180. They always sum to 100.

### Why GMI is withheld

GMI is an A1c estimate and is only defined over **>= 14 days** of CGM data.
Computed over eleven hours it is just the mean wearing an A1c costume — it
looks authoritative and means nothing. Below `MIN_GMI_DAYS` the field is
`null` and a caveat says so.

For the same reason, a caveat notes when time-in-range and CV are computed
over a short window: the familiar targets (>70% in range, CV <= 36%) are
defined over 14 days and are not comparable to a single afternoon.

## Trends

`analyzeTrends(readings, period, requestedHours?)`

### Dawn phenomenon

Compares mean glucose in the 04:00 hour against the 06:00 and 08:00 hours.
Detected when the rise exceeds 20 mg/dL (to 08:00) or 15 mg/dL (to 06:00).

Requires readings in the 04:00 hour *and* in at least one of 06:00 / 08:00.
Without them the result is `null`. Previously a missing hour was read as an
average of `0`, so any morning data at all produced a rise of the full glucose
value and a phantom detection.

Below `MIN_PATTERN_DAYS` a note records that one morning is not a pattern.

### Glucose excursions

Threshold-based swing detection. The series is walked while tracking a running
extreme; a turn is recorded once the value moves `SWING_THRESHOLD` against it.
Trough-to-peak rises of at least 30 mg/dL completed within
`MAX_EXCURSION_MINUTES` are excursions.

Reported as `mealResponse` (mean amplitude) and `largestExcursion`. Both are
`null` when no excursion is found — distinct from a flat trace, which yields
the explicit pattern *"No rises of 30 mg/dL or more in this window."*

The previous implementation tested three consecutive points for a local peak
with a 30 mg/dL step. A rise spread over three hours never produced a single
30-point step, so a climb from 62 to 322 mg/dL registered as no excursion at
all — and the "< 20" branch then reported *"Good postprandial glucose
control."*

A gap longer than `MAX_GAP_MINUTES` resets the walk, so readings either side
of a sensor outage are not joined into a fictitious swing.

### Overnight stability

Population SD of readings between 23:00 and 06:00 **local time**. Requires at
least `MIN_WINDOW_READINGS` readings in that window; otherwise `null` with the
count in `notAssessed`.

### Events

`hypoglycemicEvents` and `hyperglycemicPeriods` are arrays of
`{ start, end, durationMinutes, extremeValue }`.

Runs are built from timestamps, split on gaps over `MAX_GAP_MINUTES`, then
merged when separated by less than `MIN_EVENT_MINUTES` — matching the
ATTD/ADA definition, under which an event ends only after 15 minutes back
inside range. A hypo event needs >= 15 minutes below `target_low`; an extended
hyperglycemic period needs >= 60 minutes above `target_high`.

The previous version counted *consecutive readings* and assumed six of them
were "~1 hour". The feed is 15-minute, so six readings are 90 minutes, and
readings either side of a multi-hour outage counted as contiguous.

## Coverage

Every response carries a `coverage` block:

```json
{
  "readingCount": 46,
  "firstReading": "2026-09-20T08:58:59.000Z",
  "lastReading": "2026-09-20T20:13:59.000Z",
  "spanHours": 11.25,
  "requestedHours": 168,
  "coveragePercent": 6.7,
  "truncated": true
}
```

`truncated` is true below 90% coverage. `requestedHours` defaults to the
observed span, so a caller who asked for no particular window is not told its
data was truncated.

## Input handling

Readings are sorted chronologically on entry; analytics does not depend on the
caller having ordered them. Empty input throws.

## Interpreting output

Everything here is descriptive. The module reports what the trace did — it
does not diagnose, and thresholds are population conventions, not personal
targets. Treatment decisions belong with a clinician.
