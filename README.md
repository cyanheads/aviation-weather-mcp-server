<div align="center">
  <h1>@cyanheads/aviation-weather-mcp-server</h1>
  <p><b>Fetch METARs, TAFs, PIREPs, and SIGMETs/AIRMETs from the NWS Aviation Weather Center via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/aviation-weather-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/aviation-weather-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/aviation-weather-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/aviation-weather-mcp-server/releases/latest/download/aviation-weather-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=aviation-weather-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYXZpYXRpb24td2VhdGhlci1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22aviation-weather-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Faviation-weather-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Five tools covering aviation weather — station lookup, current observations, terminal forecasts, pilot reports, and active advisories:

| Tool | Description |
|:-----|:------------|
| `aviation_find_stations` | Resolve airports and weather stations by ICAO ID, bounding box, or US state. Returns ICAO/IATA/FAA IDs, coordinates, elevation, and available data types. |
| `aviation_get_metar` | Get current weather observations (METARs) for one or more airports. Returns decoded wind, visibility, ceiling, temp/dewpoint, altimeter, cloud layers, flight category (VFR/MVFR/IFR/LIFR), and the raw METAR string. |
| `aviation_get_taf` | Get Terminal Aerodrome Forecasts for one or more airports. Returns each forecast period with valid times, wind, visibility, weather codes, and cloud layers, plus the raw TAF string. |
| `aviation_get_pireps` | Get recent Pilot Reports near an airport or within a bounding box. Returns decoded turbulence, icing, and cloud reports with altitude, aircraft type, intensity, and the raw PIREP string. |
| `aviation_get_advisories` | Get active SIGMETs and AIRMETs for a region. Returns hazard type (CONVECTIVE, TURBULENCE, ICING, IFR, MTN OBSCN), severity, altitude range, valid period, polygon coordinates, and raw text. |

### `aviation_find_stations`

Resolve and discover weather stations by multiple search modes.

- Look up one or more stations by ICAO, IATA, or FAA ID (up to 20 IDs per call)
- Discover all stations within a geographic bounding box
- List stations for a US state via two-letter abbreviation (uses bbox + client-side state filter)
- Returns `data_types` (METAR, TAF, etc.) so agents can confirm what's available before querying

---

### `aviation_get_metar`

Fetch current or recent METAR observations (1–10 stations per call).

- `hours` parameter (1–12) returns observation history per station; default 1 returns only the most recent
- Flight category (VFR/MVFR/IFR/LIFR) is returned directly from the AWC API — no client-side computation needed
- Decodes cloud layers, wind with gusts, and visibility in addition to the raw METAR string
- METAR type field distinguishes `METAR` (routine) from `SPECI` (special observation triggered by significant weather change)

---

### `aviation_get_taf`

Fetch Terminal Aerodrome Forecasts for 1–4 airports.

- Returns structured forecast periods with change types (`FM`, `TEMPO`, `BECMG`) and probabilities
- Common weather codes (e.g., `-SHRA`, `TSRA`) decoded to plain English alongside the raw string
- `valid_from` / `valid_to` in ISO 8601 for straightforward time comparisons

---

### `aviation_get_pireps`

Search for recent Pilot Reports by station+radius or bounding box.

- `station_id` + `distance_nm` (10–500 nm, default 100) for radial search around an airport
- `bbox` for geographic area search — useful for en-route corridor checks
- `altitude_min_ft` / `altitude_max_ft` filters to isolate reports at cruise altitude
- Turbulence and icing arrays include up to two layers per report (as reported by the API)
- Note: absence of PIREPs does not mean smooth conditions — they are sparse by nature

---

### `aviation_get_advisories`

List currently active SIGMETs and AIRMETs.

- `advisory_type` filter: `sigmet`, `airmet`, or `all` (default)
- `hazard` filter: `CONVECTIVE`, `TURBULENCE`, `ICING`, `IFR`, `MTN OBSCN`, `SURFACE WIND`, `LLWS`
- `bbox` filter applied client-side (AWC API returns all active advisories; the tool filters by polygon overlap)
- During fair-weather periods, no AIRMETs may be active — an empty result is a valid state, not an error

---

## Prompts

| Type | Name | Description |
|:-----|:-----|:------------|
| Prompt | `aviation_preflight_brief` | Structure a preflight weather briefing for one or more airports. Guides the LLM to call `aviation_get_metar`, `aviation_get_taf`, and `aviation_get_advisories` in sequence and synthesize a go/no-go picture with flight categories and active hazards. |

All resource data is reachable via tools. This server has no resources — all aviation weather data is time-sensitive (METARs valid ~1 hour, advisories minutes to hours) and unsuitable for stable-URI resources.

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Aviation-weather-specific:

- Keyless — no API key or authentication required; all data is from the public AWC Data API
- Single service (`aviation-weather-service`) with retry + exponential backoff for the keyless public endpoint
- Raw coded strings (`rawOb`, `rawTAF`, `rawAirSigmet`) surfaced alongside decoded fields so agents have both layers
- State→bbox table enables US-state station queries that the AWC API doesn't natively support
- Server-level `instructions` field surfaces the "not an official briefing" safety disclaimer to all clients on `initialize`

Agent-friendly output:

- Flight category (`VFR`/`MVFR`/`IFR`/`LIFR`) as a discriminated string field — agents can branch on it without parsing ceiling + visibility
- Structured error contracts with typed `reason` fields and `recovery` hints (e.g., "Verify ICAO IDs with `aviation_find_stations`")
- `aviation_preflight_brief` prompt encodes the correct METAR → TAF → PIREPs → advisories briefing sequence that agents frequently get wrong by omitting steps

---

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "aviation-weather": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/aviation-weather-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "aviation-weather": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/aviation-weather-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "aviation-weather": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/aviation-weather-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required — the AWC Data API is fully public and keyless.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/aviation-weather-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd aviation-weather-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if you need to override AWC_BASE_URL or AWC_TIMEOUT_MS
```

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `AWC_BASE_URL` | Base URL for the NWS AWC Data API. | `https://aviationweather.gov/api/data` |
| `AWC_TIMEOUT_MS` | Per-request timeout in milliseconds (1000–60000). | `10000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

- **Build and run:**

  ```sh
  bun run rebuild
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t aviation-weather-mcp-server .
docker run --rm -p 3010:3010 aviation-weather-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/aviation-weather-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/prompts and inits services. |
| `src/config` | Server-specific env var parsing (`AWC_BASE_URL`, `AWC_TIMEOUT_MS`). |
| `src/services/aviation-weather` | AWC Data API client — HTTP fetch, retry with exponential backoff, response normalization. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). |
| `tests/` | Unit and integration tests mirroring `src/`. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and prompts via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

> **Not an official preflight briefing.** Data from the AWC is informational only. Real flight planning requires an authorized source (e.g., Leidos/1800wxbrief.com). The server surfaces this disclaimer via its `instructions` field sent on every `initialize`.

---

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
