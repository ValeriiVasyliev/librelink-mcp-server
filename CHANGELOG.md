# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

A review of the whole tree found no backdoors, no unexpected network
destinations (only `api-us`/`api-eu.libreview.io`), no install hooks in any of
the 120 transitive dependencies, and no code that logs a credential. It did
surface three weaknesses in how credentials are handled locally.

- **`configure_credentials` no longer accepts `email` or `password`.**
  Arguments passed to an MCP tool are recorded in the host's conversation
  history, which is not an appropriate store for a password. The tool now takes
  only `region`, and **rejects** the credential fields rather than ignoring
  them, so a caller that sent a password learns it was not stored and should
  treat the value as exposed. Credentials are set with `npm run configure`.

  This is a breaking change to that tool's schema. The other seven tools are
  unchanged.

- **`npm run configure` no longer echoes the password.** The prompt used plain
  `readline`, so the password appeared on screen and stayed in terminal
  scrollback. Input is now masked. A blank answer at the email or password
  prompt keeps the stored value, so re-running configure to change only the
  region can no longer wipe a credential.

- **Config directory permissions are re-asserted on every save.** `mkdirSync`
  applies its `mode` only when it actually creates the directory, and even then
  the process umask can loosen it, so a directory created by an earlier version
  could sit at `755`. Every save now forces `700` on the directory alongside
  the existing `600` on the file.

The config file still holds the password in plaintext; file permissions remain
the only thing protecting it.

### Fixed — tests

- **`npm test` no longer exits 0 when MCP tests fail.** `test-mcp.js` reported
  failures in its output but never set a non-zero exit code, which had hidden a
  stale assertion in that file.

- **The MCP suite no longer authenticates as the real user.** It relied on
  `configure_credentials` overwriting the config with test data as a side
  effect to reach an unauthenticated state. With that side effect gone, the
  auth-failure tests were passing against the runner's live LibreLink account.
  The suite now writes its own fixture config before starting the server, and
  still backs up and restores the real file.

### Fixed — analytics

The analytics module reported reassuring findings it had no data to support.
Every item below is a case of that same failure.

- **Empty windows no longer read as good control.** With no readings between
  23:00 and 06:00, overnight SD defaulted to `0`; the `< 10` check passed and
  the response claimed *"Excellent overnight glucose stability."* Two readings
  anywhere in the day were enough to produce it, alongside *"Good postprandial
  glucose control"* from an identical `0` default on meal response. Both
  metrics now return `null` with the reason in `notAssessed`.

- **Dawn phenomenon no longer fires on missing data.** A missing hourly bucket
  was read as an average of `0`, so any 08:00 reading produced a rise of its
  full value against a nonexistent 04:00 baseline. Four flat 150 mg/dL
  readings at 08:00 were reported as a dawn phenomenon. Detection now requires
  readings in the 04:00 hour and in at least one of 06:00 / 08:00, and returns
  `null` otherwise.

- **Multi-hour excursions are now detected.** Meal response tested three
  consecutive points for a local peak with a 30 mg/dL step. A rise spread over
  hours never produced one, so a climb from 62 to 322 mg/dL registered as no
  excursion — and the `< 20` branch then reported it as *"Good postprandial
  glucose control."* Replaced with threshold-based swing detection, which
  tracks a running extreme and records a turn once the value reverses by
  30 mg/dL. Reported as `mealResponse` and `largestExcursion`.

- **Events are measured in time, not reading counts.** Hypo and hyper
  detection counted consecutive readings and assumed six were "~1 hour". The
  feed is 15-minute, so six readings are 90 minutes. Readings either side of a
  multi-hour sensor outage also counted as contiguous. Runs are now built from
  timestamps, split on gaps over 30 minutes, and merged when separated by less
  than 15 minutes per the ATTD/ADA event definition. Events carry `start`,
  `end`, `durationMinutes` and `extremeValue`.

- **GMI is withheld below 14 days.** GMI is an A1c estimate defined only over
  >= 14 days of CGM data. Computed over an 11-hour window it was the mean
  presented as an A1c. Now `null`, with a caveat naming the requirement. A
  further caveat notes when time-in-range and CV come from a short window, as
  their usual targets are also 14-day figures.

- **Time-in-range keys reflect the configured range.** The response hardcoded
  `target_70_180` / `below_70` / `above_180` regardless of `configure_ranges`,
  so a user on 80–140 was shown their own numbers under someone else's labels.

- **Analytics no longer depends on caller ordering.** Readings are sorted
  chronologically on entry.

### Fixed — LibreLink Up API

- **HTTP 403 / body status 920.** Replaced the unmaintained
  `libre-link-unofficial-api` dependency with a self-contained client.
  The package pinned `version: 4.7.0` with no supported way to add the
  `Account-Id` header the API has required since October 2025. The client now
  sends `version >= 4.16.0` (raising any lower configured value) and the
  SHA-256 `Account-Id` header on every authenticated request.
- Typed `LibreLinkApiError` codes so failures are reported for what they are.
  An authentication or API-compatibility failure is no longer reported as a
  sensor problem.
- `test-mcp.js` no longer overwrites stored credentials; it backs up and
  restores `~/.librelink-mcp/config.json`.
- Null reference error in glucose reading handling.

### Added

- `coverage` block on every analytics response: `readingCount`,
  `firstReading`, `lastReading`, `spanHours`, `requestedHours`,
  `coveragePercent` and `truncated`. The API returns roughly 12 hours
  regardless of the window requested, and the old responses echoed the
  requested period as though it had been analyzed — a request for 14 days of
  stats was labelled `analysis_period_days: 14` while describing one
  afternoon.
- `caveats` (stats) and `notAssessed` (trends): why a metric is null, or why a
  computed one should not be read at face value.
- `largestExcursion`, `hypoglycemicEvents` and `hyperglycemicPeriods` on trend
  analysis.
- `docs/` directory: architecture, analytics, tool reference, configuration,
  limitations and development guides.
- This changelog.

- Account requirements documentation: a LibreLink **Up** follower account is
  required, not the sensor wearer's own login.
- `test-librelink-api.js`: 68 assertions over a mocked transport.
- Diagnostic scripts `debug-connections.js` and `diagnose-account.js`.
- Improved MCP tool descriptions.

### Changed

- **Breaking (response shape).** `get_glucose_stats` replaces
  `analysis_period_days` with `requested_period_days` and
  `analyzed_period_days`, and `glucose_management_indicator` may be `null`.
  `get_glucose_trends` may return `null` for `dawn_phenomenon`,
  `meal_response_average` and `overnight_stability`. Both gain `coverage`.
  A `null` means the metric could not be judged from the available data — it
  never means the value is fine.
- **Breaking (types).** `GlucoseStats.gmi` is `number | null`;
  `TrendAnalysis.dawnPhenomenon` is `boolean | null`; `mealResponse` and
  `overnightStability` are `number | null`. New `DataCoverage` and
  `GlucoseEvent` interfaces.
- Pattern strings now carry their evidence — durations, peaks and nadirs
  rather than bare counts. *"1 extended hyperglycemic period(s) detected"*
  becomes *"Extended hyperglycemia - 300 min above 180, peak 322 mg/dL"*.
- Excursion wording is "glucose excursions" rather than "postprandial": the
  data cannot establish that a rise followed a meal.
- `generateInsights()` no longer grades control as "excellent" or
  "needs significant improvement"; it states the figure against the
  conventional target and appends any caveats.
- `test-analytics.js` rewritten from a console demo over random data into 40
  assertions that exit non-zero on failure, covering each bug above.

## [1.0.0] — 2025-07-14

Initial release.

- MCP server over stdio with eight tools: `get_current_glucose`,
  `get_glucose_history`, `get_glucose_stats`, `get_glucose_trends`,
  `get_sensor_info`, `configure_credentials`, `configure_ranges`,
  `validate_connection`.
- Glucose analytics: time-in-range, GMI, coefficient of variation, dawn
  phenomenon, meal response, overnight stability.
- Local credential storage in `~/.librelink-mcp/config.json` at mode 600.
- US and EU region support, with a 5-minute response cache.

[Unreleased]: https://github.com/amansk/librelink-mcp-server/compare/main...HEAD
[1.0.0]: https://github.com/amansk/librelink-mcp-server/releases/tag/v1.0.0

<!-- No git tags exist yet; 1.0.0 is the npm package version at the initial
     release commit (1c21459). Tag releases to make these links resolve. -->
