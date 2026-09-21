# Configuration

## Location

`~/.librelink-mcp/config.json`

The directory is created with mode `700` and the file with mode `600`, then
`chmod`ed again after every write. It holds a plaintext LibreLink password, so
those permissions are the only thing protecting it — do not relax them, copy
the file into a repository, or include it in a backup that syncs elsewhere.

## Shape

```json
{
  "credentials": { "email": "", "password": "" },
  "client":      { "version": "4.16.0", "region": "US" },
  "cache":       { "enabled": true, "ttl_minutes": 5 },
  "ranges":      { "target_low": 70, "target_high": 180 }
}
```

A missing file yields the defaults above. A partial file is merged over them
per section, so an older config gains new keys without being rewritten. A
malformed file logs a warning and falls back to defaults rather than crashing
the server.

### `credentials`

Email and password for a LibreLink **Up** (follower) account — the account
that *follows* a sensor wearer, not the wearer's own LibreLink app login. A
wearer account has no connections and produces `NO_CONNECTIONS`.

### `client.version`

The `version` header sent to the API. Values below `MINIMUM_LLU_VERSION`
(`4.16.0`) are raised to it automatically, so a stale config cannot
reintroduce the 403/920 failure. Raise it only if Abbott lifts the floor
again.

### `client.region`

`US` → `https://api-us.libreview.io`, `EU` → `https://api-eu.libreview.io`.
A region redirect from the API is followed automatically, so a wrong value
usually self-corrects at the cost of one extra round trip.

### `cache`

In-memory only; nothing is written to disk and the cache dies with the
process. One entry backs `get_current_glucose`, `get_glucose_history` and
`get_sensor_info`. Sensors report every 15 minutes, so the 5-minute default
never withholds a new reading for long. Lower it only if you are prepared to
hit the API's rate limits.

### `ranges`

Used for time-in-range, event detection, and the `isHigh` / `isLow` / `color`
fields on every reading. Validation: `target_low` 50–150, `target_high`
100–300, low strictly below high.

These are conventions, not medical advice. 70–180 mg/dL is the standard adult
target; your clinician may set something different.

## Setting it

Interactively:

```bash
npm run configure
```

This is the only supported way to set the email and password. The prompt does
not echo the password, and the file is written with mode `600` inside a
directory forced to `700` on every save.

Everything else — region and target ranges — can also be set through the MCP
tools `configure_credentials` and `configure_ranges`, see [tools.md](tools.md).
Those tools reject `email` and `password`: arguments to an MCP tool land in the
host's conversation history, so credentials must not travel that way.

Editing the JSON by hand works too; the server reads it at startup, so restart
the MCP host afterwards.

> The config file holds your LibreLink password in plaintext. File permissions
> are the only thing protecting it, so keep it off shared or backed-up volumes.

## Registering the server

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "librelink": {
      "command": "node",
      "args": ["/absolute/path/to/librelink-mcp-server/dist/index.js"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add librelink -- node /absolute/path/to/librelink-mcp-server/dist/index.js
```

The path must point at the **built** `dist/index.js`. Run `npm run build`
first, and again after any source change — the host loads the built file once
at startup, so a rebuild needs a host restart to take effect.
