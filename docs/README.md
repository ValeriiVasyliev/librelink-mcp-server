# Documentation

Reference material for `librelink-mcp-server`, a local MCP server that exposes
FreeStyle Libre CGM data to Claude.

For installation and a quick start, see the [root README](../README.md).

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | Components, request flow, caching, error model |
| [analytics.md](analytics.md) | Every metric, its threshold, and when it is withheld |
| [tools.md](tools.md) | The eight MCP tools and their response shapes |
| [configuration.md](configuration.md) | Config file, credentials, target ranges |
| [limitations.md](limitations.md) | What this server cannot do, and why |
| [development.md](development.md) | Build, test, and release |
| [../CHANGELOG.md](../CHANGELOG.md) | Release history |

## The one thing to know first

The LibreLink Up API returns **roughly the last 12 hours** of glucose data,
regardless of the window you ask for. A request for 90 days and a request for
12 hours return the same readings.

Every analytics response therefore carries a `coverage` block stating what the
data actually spans, and metrics that need a longer window (GMI, overnight
stability, dawn phenomenon) return `null` with a stated reason rather than a
number computed from data that is not there. See
[limitations.md](limitations.md).
