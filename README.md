# LibreLink MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](https://www.typescriptlang.org/)

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that provides Claude Desktop with secure access to your FreeStyle LibreLink continuous glucose monitoring (CGM) data.

![LibreLink MCP Demo](https://img.shields.io/badge/Demo-Working%20with%20Real%20Data-green)

## 🌟 Features

- **Real-time glucose monitoring** - Get current readings with trend arrows
- **Historical data analysis** - Retrieve glucose history over customizable periods
- **Comprehensive analytics** - Time-in-range, GMI, variability metrics
- **Pattern recognition** - Dawn phenomenon, meal responses, stability analysis
- **Privacy-first design** - All data stays local on your machine
- **Secure credential management** - Local encrypted storage
- **Cross-platform health integration** - Works alongside other health MCP servers

## 📋 Prerequisites

- **LibreLinkUp follower account**: This server reads glucose data through the LibreLink **Up** (follower) API, so it needs credentials for an account that *follows* a sensor wearer — not the wearer's own LibreLink app account. See [Account requirements](#-account-requirements).
- **Compatible Sensor**: FreeStyle Libre 2 or 3 with LibreLinkUp sharing enabled
- **Node.js**: Version 18.0.0 or higher
- **Claude Desktop**: For MCP integration

## 🚀 Quick Start

### 1. Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/librelink-mcp-server.git
cd librelink-mcp-server

# Install dependencies
npm install

# Build the project
npm run build
```

### 2. Configuration

```bash
# Configure your LibreLink credentials
npm run configure
```

You'll be prompted for:
- **Email**: Your LibreLinkUp **follower** account email (see [Account requirements](#-account-requirements))
- **Password**: That account's password
- **Region**: US or EU (based on your location)
- **Target ranges**: Glucose target ranges (default: 70-180 mg/dL)

### 3. Test Connection

```bash
# Test your LibreLink connection
node test-real-connection.js
```

### 4. Claude Desktop Integration

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "librelink": {
      "command": "node",
      "args": ["/path/to/librelink-mcp-server/dist/index.js"]
    }
  }
}
```

### 5. Restart Claude Desktop

Restart Claude Desktop to load the new MCP server.

## 👤 Account requirements

LibreLink Up exposes glucose data through **connections**: a sensor wearer (a *patient* account) shares
their data with a *follower* (care) account, and the follower reads it. This server authenticates as the
follower.

If you configure the wearer's own LibreLink credentials, login succeeds but `llu/connections` returns an
empty list, and every glucose tool fails with `NO_CONNECTIONS`. To set sharing up:

1. In the **LibreLink** app (the wearer's app), open **Connected Apps → LibreLinkUp**.
2. Invite a follower by email. Use an email address that is not the wearer's LibreLink login.
3. Install the **LibreLinkUp** app, sign up with that email, and accept the invitation.
4. Run `npm run configure` and enter the **LibreLinkUp follower** email and password.

You can confirm the account type at any time:

```bash
node diagnose-account.js
```

An `accountType` of `pat` with zero connections means you configured the wearer's account.

## 🔄 LibreLink Up API compatibility (October 2025 change)

### Root cause of the `403 / status 920` error

Around October 2025 Abbott tightened the LibreLink Up API. Requests now fail unless they carry two things:

```text
Error fetching data from Libre Link Up API with status 403.
{ "data": { "minimumVersion": "4.16.0" }, "status": 920 }
```

Verified against the live API:

| Request | Result |
|---|---|
| `version: 4.7.0`, no `Account-Id` | `HTTP 403`, body `status: 920`, `minimumVersion: 4.16.0` |
| `version: 4.16.0`, no `Account-Id` | `HTTP 400`, body `{"message":"RequiredHeaderMissing"}` |
| `version: 4.16.0` **and** `Account-Id` | `HTTP 200` |

The previous dependency, `libre-link-unofficial-api`, hardcodes `version: 4.7.0` (its last release,
`1.0.0-alpha.7`, predates the change) and never sends `Account-Id`. It also offers no supported way to add
the header — its request builder is private and overwrites caller-supplied headers.

### The fix

`libre-link-unofficial-api` was replaced with a dedicated client, `src/librelink-api.ts`, that sends the
headers the API now requires. No other functionality changed: all 8 MCP tools keep the same names,
arguments and output shapes.

### Required request headers

| Header | Value | Notes |
|---|---|---|
| `product` | `llu.android` | Constant |
| `version` | `>= 4.16.0` | Below this the API returns `403` / `920` |
| `Account-Id` | SHA-256 hex digest of the authenticated user's id | Required on every **authenticated** request; omitted on login |
| `Authorization` | `Bearer <token>` | From the login response's `authTicket` |
| `content-type` | `application/json` | |

`Account-Id` is derived at runtime from the `data.user.id` the login response returns. No account id is
ever hardcoded, and the value is never logged.

### Configuration requirements

`~/.librelink-mcp/config.json` gains no new required fields. `client.version` now defaults to `4.16.0`,
and any configured value below the minimum is **raised to `4.16.0` at runtime** so an old saved config
cannot reintroduce the failure. Set it explicitly only if Abbott raises the minimum again before this
project is updated:

```json
{
  "client": { "version": "4.16.0", "region": "EU" }
}
```

`client.region` (`US` or `EU`) selects the starting host. If the API answers with a redirect, the client
resolves the correct regional host automatically, so a wrong region self-corrects.

## 🩸 Usage Examples

Once integrated with Claude Desktop, you can ask:

### Basic Glucose Queries
- *"What's my current glucose level?"*
- *"Show me my glucose readings from the past 6 hours"*
- *"What's my average glucose today?"*

### Analytics & Insights
- *"Calculate my time in range for this week"*
- *"Analyze my glucose patterns and trends"*
- *"Do I have dawn phenomenon?"*
- *"How stable are my overnight glucose levels?"*

### Health Correlations
When combined with other health MCP servers:
- *"How does my sleep quality affect my glucose control?"*
- *"Compare my glucose variability with my stress levels"*
- *"Show the impact of my supplements on glucose stability"*

## 🛠 Available MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_current_glucose` | Real-time glucose reading with trend | None |
| `get_glucose_history` | Historical glucose data | `hours` (default: 24) |
| `get_glucose_stats` | Statistics and time-in-range | `days` (default: 7) |
| `get_glucose_trends` | Pattern analysis | `period` (daily/weekly/monthly) |
| `get_sensor_info` | Sensor status and info | None |
| `configure_credentials` | Update LibreLink credentials | `email`, `password`, `region` |
| `configure_ranges` | Set target glucose ranges | `target_low`, `target_high` |
| `validate_connection` | Test LibreLink connection | None |

## 📊 Sample Output

### Current Glucose Reading
```json
{
  "current_glucose": 105,
  "timestamp": "2025-07-14T21:19:24.000Z",
  "trend": "Flat",
  "status": "Normal",
  "color": "green"
}
```

### Glucose Statistics
```json
{
  "analysis_period_days": 7,
  "average_glucose": 93.46,
  "glucose_management_indicator": 5.55,
  "time_in_range": {
    "target_70_180": 100.0,
    "below_70": 0.0,
    "above_180": 0.0
  },
  "variability": {
    "standard_deviation": 7.52,
    "coefficient_of_variation": 8.04
  }
}
```

### Trend Analysis
```json
{
  "period": "daily",
  "patterns": [
    "Good postprandial glucose control",
    "Excellent overnight glucose stability"
  ],
  "dawn_phenomenon": false,
  "meal_response_average": 0,
  "overnight_stability": 2.08
}
```

## 🔧 Development

### Running Tests

```bash
# Run all tests
npm test

# Test MCP protocol
npm run test:mcp

# Test analytics with mock data
npm run test:analytics

# Test the LibreLink Up API client (mocked HTTP, no credentials needed)
npm run test:api

# Test with real LibreLink data (requires configuration)
node test-real-data.js
```

### Building

```bash
# Build TypeScript
npm run build

# Type checking
npm run typecheck

# Development mode
npm run dev
```

### Project Structure

```
librelink-mcp-server/
├── src/
│   ├── index.ts              # Main MCP server
│   ├── librelink-api.ts      # LibreLink Up HTTP client (auth, headers, regions, errors)
│   ├── librelink-client.ts   # Glucose-domain wrapper over the API client
│   ├── glucose-analytics.ts  # Analytics and statistics
│   ├── config.ts             # Configuration management
│   ├── configure.ts          # CLI configuration tool
│   └── types.ts              # TypeScript definitions
├── config/
│   └── default.json          # Default configuration
├── test-*.js                 # Test suites
├── package.json
└── README.md
```

## 🔒 Security & Privacy

### Data Privacy
- **Local processing only** - No data sent to external servers
- **Your data stays on your machine** - Complete privacy control
- **No analytics or tracking** - Zero telemetry

### Credential Security
- **Local storage** - Credentials stored in `~/.librelink-mcp/config.json`
- **File permissions** - Written with, and enforced at, mode `600` (user read/write only); the config directory is `700`
- **No cloud storage** - Never uploaded or shared

### Security Best Practices
```bash
# Verify file permissions
ls -la ~/.librelink-mcp/config.json
# Should show: -rw------- (user read/write only)

# Optional: Encrypt config directory
# (Implementation details in documentation)
```

## ⚠️ Important Notes

### LibreLink API Usage
- This project uses an **unofficial API** through reverse engineering
- **Not affiliated with Abbott** or FreeStyle Libre
- **Use at your own discretion** and ensure compliance with LibreLink terms
- **API may change** - community maintained compatibility

### Data Sharing Requirements
- Ensure your **LibreLink app has LibreLinkUp sharing enabled**
- Your **sensor must be active** and transmitting data
- **LibreLinkUp follower account** credentials required — the wearer's own LibreLink account has no
  connections and cannot be read. See [Account requirements](#-account-requirements).

### Sensor Compatibility
- ✅ **FreeStyle Libre 2**
- ✅ **FreeStyle Libre 3**
- ❓ **FreeStyle Libre 1** (may work, not tested)

## 🐛 Troubleshooting

Every failure is reported with a specific error code, so the code tells you which problem you have.
An authentication or API-compatibility failure is never reported as a sensor problem.

| Code | Meaning | What to do |
|---|---|---|
| `API_VERSION_UNSUPPORTED` | `HTTP 403` / `status 920` — the API requires a newer client version | See [below](#http-403--status-920) |
| `MISSING_ACCOUNT_ID` | `HTTP 400 RequiredHeaderMissing` — the `Account-Id` header was not sent | Re-run `validate_connection`; if it persists, the login response shape changed |
| `INVALID_CREDENTIALS` | The API rejected the email/password | Confirm they work in the LibreLinkUp app |
| `TERMS_NOT_ACCEPTED` | The account must accept updated terms or privacy policy | Sign in once with the LibreLinkUp app and accept the prompts |
| `NO_CONNECTIONS` | Login worked, but no patient is shared with this account | See [Account requirements](#-account-requirements) |
| `SENSOR_UNAVAILABLE` | Connected, but the sensor returned no data | Sensor may be warming up, out of Bluetooth range, or expired |
| `TOKEN_EXPIRED` | The auth token was rejected | Handled automatically by one re-login; persistent failures mean the password changed |
| `REGION_ERROR` | The regional host could not be resolved | Check `client.region` in the config and your network |
| `RATE_LIMITED` | `HTTP 429` or `status 429` | Wait a few minutes before retrying; avoid repeated login attempts |
| `NETWORK_ERROR` | The API host was unreachable | Check internet connectivity and LibreLink service status |
| `UNKNOWN_API_ERROR` | An unrecognised API response | Report it with the HTTP and API status from the message |

### HTTP 403 / status 920

```text
Error fetching data from Libre Link Up API with status 403.
{ "data": { "minimumVersion": "4.16.0" }, "status": 920 }
```

The API is rejecting the `version` header as too old. Since this fix the client enforces a floor of
`4.16.0`, so you should only see this if Abbott has raised the minimum again.

1. Check the version actually being sent — the error message states it.
2. Confirm you are running the current build: `npm run build`.
3. Raise the minimum: set `client.version` in `~/.librelink-mcp/config.json` to the `minimumVersion`
   in the error, then restart the server. Values **below** the built-in floor are ignored.
4. If a newer version alone does not help and you now get `HTTP 400 RequiredHeaderMissing`, the API has
   added another required header; open an issue.

### "No connections found" / `NO_CONNECTIONS`

Login succeeded, so the credentials are correct — the account simply follows no sensor wearer. This is
almost always because the **wearer's own** LibreLink credentials were configured instead of a
**LibreLinkUp follower** account. See [Account requirements](#-account-requirements).

### Authentication failures

- Confirm the email and password work in the **LibreLinkUp** app.
- `TERMS_NOT_ACCEPTED` means the account has a pending terms-of-use prompt; only the app can clear it.
- The region self-corrects via redirect, so a wrong `client.region` is not the cause.

### Getting Help

1. **Run diagnostics**:
   ```bash
   node diagnose-account.js
   ```

2. **Check logs**: Look for error messages in the console output

3. **Test connection**:
   ```bash
   node test-real-connection.js
   ```

4. **Open an issue**: Include diagnostic output and error messages

## 🤝 Contributing

We welcome contributions! Please:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes** with tests
4. **Follow the existing code style**
5. **Submit a pull request**

### Development Guidelines
- **TypeScript required** - Maintain type safety
- **Test coverage** - Add tests for new features
- **Documentation** - Update README for new functionality
- **Security first** - Never commit credentials or sensitive data

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **libre-link-unofficial-api** - The original API client this project was built on, and the source of
  the response type definitions. Replaced by `src/librelink-api.ts` in the October 2025 API fix.
- **MCP Protocol** - Anthropic's Model Context Protocol
- **FreeStyle Libre Community** - Inspiration and reverse engineering efforts
- **Open Source Diabetes Projects** - Nightscout, OpenAPS, and others

## ⭐ Support

If this project helps you manage your diabetes with AI assistance, please:
- ⭐ **Star the repository**
- 🐛 **Report issues** you encounter
- 💡 **Suggest improvements**
- 🤝 **Contribute** to the project

---

**Disclaimer**: This is an unofficial project not affiliated with Abbott or FreeStyle Libre. Use responsibly and in compliance with applicable terms of service. Always consult healthcare professionals for medical decisions.