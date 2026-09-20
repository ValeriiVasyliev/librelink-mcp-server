# Development

## Setup

```bash
npm install
npm run build
```

Node 18+. The project is ES modules (`"type": "module"`), so relative imports
carry a `.js` extension even in TypeScript sources.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run dev` | Run from source via ts-node |
| `npm test` | All three suites below |
| `npm run test:mcp` | MCP protocol handshake and tool listing |
| `npm run test:analytics` | Analytics assertions |
| `npm run test:api` | API client, mocked transport |
| `npm run configure` | Interactive credential setup |

There is no linter configured.

## Tests

All suites are plain Node scripts that exit non-zero on failure — no test
framework. `npm run test:analytics` and `npm run test:api` are hermetic;
`npm run test:mcp` spawns the real server but stubs credentials and restores
`~/.librelink-mcp/config.json` afterwards.

The analytics suite tests against `dist/`, so **build before testing**.

### Against real data

```bash
node test-real-connection.js   # login and connection lookup
node test-real-data.js         # fetch and analyze live readings
node debug-connections.js      # dump raw connection payloads
node diagnose-account.js       # diagnose account-type problems
```

These use your stored credentials and hit the live API. Keep their output off
the record — it contains glucose data.

## Working on analytics

`test-analytics.js` is the regression net for a specific class of bug: the
module reporting a reassuring finding it had no data to support. Each section
pins one behaviour.

When adding a metric, decide what it does when the data is insufficient. The
answer is `null` plus an entry in `caveats` or `notAssessed` — never a
default value that flows into a threshold comparison. `0` is a legitimate
glucose statistic, which is exactly why it is a dangerous "missing" marker:
`0 < 10` reads as excellent stability.

Time-of-day windows use `getHours()`, i.e. **local time**. Build test
timestamps with `new Date(y, m, d, h, min)` rather than UTC strings, or the
suite passes or fails depending on the machine's timezone.

## Working on the API client

`test-librelink-api.js` mocks the transport, so it can assert on headers and
error translation without network access. If Abbott changes the contract,
that suite is where the new expectation belongs — add the case, watch it fail,
then fix the client.

Never log or assert on a full request that contains credentials.

## Release

1. `npm run build && npm test`
2. Update [CHANGELOG.md](../CHANGELOG.md)
3. Bump `version` in `package.json`
4. Tag and push

`prepack` runs the build, so `npm pack` and `npm publish` always ship fresh
output.
