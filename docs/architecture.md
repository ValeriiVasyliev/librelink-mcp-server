# Architecture

## Components

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | MCP server: tool definitions, request routing, JSON response shaping |
| `src/librelink-api.ts` | Self-contained HTTP client for the unofficial LibreLink Up API |
| `src/librelink-client.ts` | Domain wrapper: maps raw API payloads to typed readings, caches |
| `src/glucose-analytics.ts` | Statistics and pattern detection over readings |
| `src/config.ts` | Credential and range storage in `~/.librelink-mcp/config.json` |
| `src/configure.ts` | Interactive CLI for first-time setup (`npm run configure`) |
| `src/types.ts` | Shared interfaces |

Transport is stdio; the server is launched by the MCP host (Claude Desktop,
Claude Code) and speaks to it over stdin/stdout. Nothing listens on a port and
no data leaves the machine except the calls to LibreLink's own API.

## Request flow

```
MCP host
   │  tool call
   ▼
index.ts ──────────────► config.ts        (credentials, target ranges)
   │
   ▼
librelink-client.ts ───► cache (5 min TTL, in-memory)
   │                        │ hit → return
   │ miss                   │
   ▼                        │
librelink-api.ts            │
   │  login → JWT + Account-Id                       
   │  GET /llu/connections/{patientId}/graph
   ▼                        │
LibreLink Up API ───────────┘
   │
   ▼  raw payload
librelink-client.ts  maps to GlucoseReading[]
   │
   ▼
glucose-analytics.ts  stats / trends
   │
   ▼
index.ts  JSON response
```

### One fetch backs three tools

`get_current_glucose`, `get_glucose_history` and `get_sensor_info` all read
from the same `/graph` response. `LibreLinkClient.getGraph()` fetches it once
and caches it under a single key, so a conversation that touches all three
tools makes one HTTP request rather than three. This matters: the API
rate-limits aggressively.

Cache TTL defaults to 5 minutes and is configurable
(`cache.ttl_minutes`). Sensors report every 15 minutes, so a 5-minute TTL
never hides a new reading for long.

## Authentication

The API requires three things on every authenticated request:

1. `product: llu.android`
2. `version` header **>= 4.16.0** — below this the API returns HTTP 403 with
   body status `920`. `resolveLluVersion()` raises any configured value below
   the minimum, so a stale config cannot reintroduce the failure.
3. `Account-Id` header — the SHA-256 hex digest of the authenticated user id.
   Missing it yields HTTP 400 `RequiredHeaderMissing`.

Login returns a JWT plus its expiry; `ensureAuthenticated()` re-logs in when
the token is unusable.

Region (`US` / `EU`) selects the base URL. If the API responds with a region
redirect, `resolveRegion()` follows it.

## Error model

`LibreLinkApiError` carries a typed `code`, so failures can be reported for
what they are rather than collapsed into a generic "check your credentials":

`INVALID_CREDENTIALS`, `TERMS_NOT_ACCEPTED`, `API_VERSION_UNSUPPORTED`,
`MISSING_ACCOUNT_ID`, `REGION_ERROR`, `TOKEN_EXPIRED`, `RATE_LIMITED`,
`NO_CONNECTIONS`, `SENSOR_UNAVAILABLE`, `NETWORK_ERROR`, `UNKNOWN_API_ERROR`.

`LibreLinkClient.rethrow()` preserves typed errors verbatim and wraps only
genuinely unexpected ones. Error messages never include credentials.

## Design constraints

- **Privacy-first.** All processing is local. The only outbound calls are to
  `api-us.libreview.io` / `api-eu.libreview.io`.
- **Unofficial API.** There is no contract. Abbott can change headers or
  payloads without notice; see [limitations.md](limitations.md).
- **Honest output.** Analytics never reports a metric it lacks the data to
  support. See [analytics.md](analytics.md).
