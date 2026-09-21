# MCP Tools

Eight tools, defined in `src/index.ts`. All responses are JSON in a single
text content block.

## Reading data

### `get_current_glucose`

No parameters.

```json
{
  "current_glucose": 238,
  "timestamp": "2026-09-20T20:45:04.000Z",
  "trend": "Flat",
  "status": "High",
  "color": "red"
}
```

`status` is `High` / `Low` / `Normal` against the configured range.
`trend` is one of `Flat`, `FortyFiveUp`, `SingleUp`, `DoubleUp`,
`FortyFiveDown`, `SingleDown`, `DoubleDown`.

### `get_glucose_history`

| Parameter | Type | Default |
| --- | --- | --- |
| `hours` | number (1–720) | 24 |

```json
{
  "period_hours": 168,
  "total_readings": 46,
  "readings": [
    { "value": 139, "timestamp": "...", "trend": "Flat",
      "isHigh": false, "isLow": false, "color": "green" }
  ]
}
```

Readings are sorted oldest first. **`total_readings` is frequently far smaller
than `hours` implies** — the API returns about 12 hours regardless. See
[limitations.md](limitations.md).

### `get_sensor_info`

No parameters.

```json
{
  "active_sensors": [
    { "deviceId": "...", "serialNumber": "03493WJL6W",
      "activationTime": "2026-09-12T12:42:06.000Z",
      "state": "Active", "deviceType": "FreeStyle Libre 3" }
  ],
  "sensor_count": 1
}
```

`state` is `Active` when the latest reading is under 15 minutes old, otherwise
`No recent data`.

## Analytics

### `get_glucose_stats`

| Parameter | Type | Default |
| --- | --- | --- |
| `days` | number (1–90) | 7 |

```json
{
  "requested_period_days": 14,
  "analyzed_period_days": 0.47,
  "coverage": {
    "readingCount": 46,
    "firstReading": "2026-09-20T08:58:59.000Z",
    "lastReading": "2026-09-20T20:13:59.000Z",
    "spanHours": 11.25,
    "requestedHours": 336,
    "coveragePercent": 3.35,
    "truncated": true
  },
  "average_glucose": 180.67,
  "glucose_management_indicator": null,
  "time_in_range": {
    "target_70_180": 47.83,
    "below_70": 6.52,
    "above_180": 45.65
  },
  "variability": {
    "standard_deviation": 86.18,
    "coefficient_of_variation": 47.7
  },
  "caveats": [
    "Data covers 11.25h of the 336h requested (3.35%). ...",
    "GMI not reported: it requires at least 14 days of data ..."
  ]
}
```

`requested_period_days` is what you asked for; `analyzed_period_days` is what
the data spans. They are usually different.

`glucose_management_indicator` is `null` below 14 days of data.

The `time_in_range` keys reflect the **configured** range. After
`configure_ranges(80, 140)` they become `target_80_140`, `below_80`,
`above_140`.

### `get_glucose_trends`

| Parameter | Type | Default |
| --- | --- | --- |
| `period` | `daily` \| `weekly` \| `monthly` | `weekly` |

```json
{
  "period": "weekly",
  "coverage": { "...": "as above" },
  "patterns": [
    "Large glucose excursions - 2 rise(s) averaging +151 mg/dL, largest +260 mg/dL",
    "Hypoglycemic event - 30 min below 70, nadir 62 mg/dL",
    "Extended hyperglycemia - 300 min above 180, peak 322 mg/dL"
  ],
  "dawn_phenomenon": null,
  "meal_response_average": 151,
  "largest_excursion": 260,
  "overnight_stability": null,
  "hypoglycemic_events": [
    { "start": "2026-09-20T12:43:59.000Z",
      "end": "2026-09-20T13:13:59.000Z",
      "durationMinutes": 30, "extremeValue": 62 }
  ],
  "hyperglycemic_periods": [
    { "start": "2026-09-20T15:13:59.000Z",
      "end": "2026-09-20T20:13:59.000Z",
      "durationMinutes": 300, "extremeValue": 322 }
  ],
  "not_assessed": [
    "Dawn phenomenon: no readings in the 04:00 hour to compare against",
    "Overnight stability: 0 reading(s) between 23:00 and 06:00, fewer than the 4 needed."
  ]
}
```

**A `null` metric means the data could not support it, not that it is fine.**
`not_assessed` gives the reason for each. See [analytics.md](analytics.md).

## Configuration

### `configure_credentials`

| Parameter | Type | Required |
| --- | --- | --- |
| `region` | `US` \| `EU` | yes |

Writes to `~/.librelink-mcp/config.json` with mode `600` and reinitializes the
client. Must be a LibreLink **Up** (follower) account.

**This tool does not accept `email` or `password`, by design.** Arguments passed
to an MCP tool are recorded in the host's conversation history, which is not an
appropriate store for credentials. Passing either parameter is rejected with an
error rather than silently ignored, so a caller that sent a password learns that
it was not stored and should be treated as exposed.

Set credentials locally instead:

```bash
npm run configure
```

That prompt does not echo the password, and writes it to
`~/.librelink-mcp/config.json` (mode `600`, in a directory forced to `700`).

### `configure_ranges`

| Parameter | Type | Required |
| --- | --- | --- |
| `target_low` | number | yes |
| `target_high` | number | yes |

Validated: `target_low` 50–150, `target_high` 100–300, low < high. Affects
time-in-range, event detection, and the `isHigh` / `isLow` / `color` fields on
every reading.

### `validate_connection`

No parameters. Performs a full login, connection lookup and glucose read, and
reports the specific failure code on error rather than a generic message.
