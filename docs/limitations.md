# Limitations

## The API returns ~12 hours, whatever you ask for

The LibreLink Up `/graph` endpoint returns the recent graph window — in
practice around 12 hours. `get_glucose_history(hours: 168)` and
`get_glucose_history(hours: 12)` return the same readings.

This is a property of the upstream API, not of this server, and there is no
parameter that widens it. `/llu/connections/{id}/logbook` exposes a longer
history but only of *events* (scans, alarms, notes), not the continuous trace.

**What this server does about it:** it states the discrepancy rather than
hiding it. Every analytics response carries a `coverage` block with the real
span, and `truncated` is true below 90% coverage. Metrics that need a longer
window return `null` with a reason.

**What it means for you:** GMI is unavailable, and time-in-range and CV cannot
be compared against the usual 14-day targets. For a true Ambulatory Glucose
Profile, export from the LibreView web portal.

## Consequences of the short window

| Metric | Effect |
| --- | --- |
| GMI | Always `null` in normal use — needs 14 days |
| Overnight stability | Only available if the window happens to span 23:00–06:00 |
| Dawn phenomenon | Only available if the window spans the 04:00 hour |
| Time in range | Computed, but describes half a day |
| CV / SD | Computed, but not comparable to the 14-day CV <= 36% target |

## Unofficial API

There is no contract and no versioning guarantee. Abbott has broken this
integration before and will again:

- **October 2025** — `Account-Id` header became mandatory; requests without it
  return HTTP 400 `RequiredHeaderMissing`.
- **2025** — the `version` header floor rose to 4.16.0; below it the API
  returns HTTP 403 with body status `920`.

Both are handled, but the next change will not be. If every tool starts
failing at once, `validate_connection` will name the specific error code.

## Account requirements

Reading requires a LibreLink **Up** (follower) account, not the sensor
wearer's own app login. The wearer must have sharing enabled and the follower
must have accepted the invitation. A wearer account authenticates fine and
then returns no connections.

## Not supported

- **No writes.** Nothing in this server can modify LibreLink data, add notes,
  or acknowledge alarms. It is read-only.
- **No alarms or push.** Tools are pull-only; the server cannot notify you of
  a low. `startStream()` exists in the client but is not wired to any tool.
- **No insulin, carb or activity data**, even where LibreLink holds it.
- **No multi-patient support.** The first connection is used.
- **mg/dL only.** `ValueInMgPerDl` is read directly; mmol/L users must divide
  by 18.
- **No linting.** The project has no ESLint or Prettier configuration.

## Clinical scope

The analytics are descriptive. They report what the trace did over the window
available; they do not diagnose, predict, or recommend. Thresholds are
population conventions, not personal targets. This server is not a medical
device and nothing it outputs should drive a treatment decision without a
clinician.
