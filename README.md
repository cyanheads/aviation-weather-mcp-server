<div align="center">
  <h1>@cyanheads/aviation-weather-mcp-server</h1>
  <p><b>Fetch METARs, TAFs, PIREPs, and domestic SIGMETs from the NWS Aviation Weather Center via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/aviation-weather-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/aviation-weather-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/aviation-weather-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/aviation-weather-mcp-server/releases/latest/download/aviation-weather-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=aviation-weather-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYXZpYXRpb24td2VhdGhlci1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22aviation-weather-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Faviation-weather-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://aviation-weather.caseyjhand.com/mcp](https://aviation-weather.caseyjhand.com/mcp)

</div>

---

## Overview

Aviation weather from the NWS Aviation Weather Center — METARs, TAFs, PIREPs, and domestic SIGMETs. Look up stations, fetch current and forecast conditions, and pull pilot reports and hazard advisories from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `aviation_find_stations` | Resolve airports and weather stations by identifier, bounding box, or US state. Returns ICAO/IATA/FAA IDs, coordinates, elevation, and available data types. |
| `aviation_get_metar` | Get current weather observations (METARs) for named airports, or survey every reporting station in a bounding box. Returns decoded wind, visibility, ceiling, present weather, temp/dewpoint, altimeter, cloud layers, flight category (VFR/MVFR/IFR/LIFR), and the raw METAR string. |
| `aviation_get_taf` | Get Terminal Aerodrome Forecasts for one or more airports. Returns each forecast period with valid times, surface wind, low-level wind shear, visibility, decoded weather, cloud layers, and vertical visibility into a forecast obscuration, plus the raw TAF string. |
| `aviation_get_pireps` | Get recent Pilot Reports near an airport or within a bounding box. Returns decoded turbulence, icing, and cloud reports with altitude, aircraft type, intensity, outside air temperature, wind aloft, flight weather, and the raw PIREP string. |
| `aviation_get_advisories` | Get active domestic SIGMETs for a region. Returns hazard type (CONVECTIVE, TURBULENCE, ICING, IFR), severity, altitude range, valid period, polygon coordinates, and raw text. |

### Prompts

| Prompt | Description |
|:-----|:------------|
| `aviation_preflight_brief` | Structure a preflight weather briefing for a flight, calling the tools above in sequence and synthesizing a weather-risk summary. |

---

## Capability reference

### `aviation_find_stations` <sub>tool</sub>

- Look up one or more stations by identifier (up to 20 per call) — a lookup matches the registry's own ID, which for an airport is its 4-character ICAO ID (e.g., `KSEA`, `K0S9`); a 3-letter IATA code never resolves, though each record includes its IATA/FAA aliases when available
- Discover stations within a geographic bounding box, or list stations for one of the 50 US states or DC via two-letter USPS code
- Returns `data_types` (METAR, TAF, etc.) so agents can confirm what's available before querying
- Every result states whether the upstream 400-row cap cut it; `limit` (1–400) bounds how many stations a `bbox` or `state` search returns, ordered by ICAO identifier ascending with identifier-less stations last — rejected alongside `station_ids`, since that mode already names the set. An area search returning more than 130 stations with no `limit` says so and names the lever; omitting `limit` still returns every match
- An ID lookup names every identifier that resolved to nothing, separating a 3-letter IATA code (never resolves) from an identifier the registry simply does not list
- Whitespace around an ID is trimmed rather than failing the batch; only an empty or whitespace-only entry is rejected

---

### `aviation_get_metar` <sub>tool</sub>

- `station_ids` (1–10 per call — 4 uppercase letters or digits, so `K0S9`-style identifiers work) for named airports, or `bbox` to survey every reporting station in an area — mutually exclusive
- `hours` (1–12) is a lookback window, not a row limit: with `station_ids` every observation inside it is returned, and with `bbox` the result is the latest observation per station
- `flight_category` (e.g., `["IFR", "LIFR"]`) narrows a `bbox` survey to the stations in those categories — judged on each station's latest observation, applied before `limit`, and disclosed with the count surveyed before it; a station AWC could not rate never matches, and a survey the filter empties returns an empty result that says so. Rejected alongside `station_ids`
- A `bbox` survey states whether the upstream 400-row cap cut it and, above `hours: 1`, names `hours` as the first lever — a wide window spends the cap on repeat readings rather than on more stations; `limit` (1–400) bounds how many stations come back, ordered by station ID ascending, and is rejected alongside `station_ids`. A survey returning more than 40 stations with no `limit` says so and names the levers; omitting `limit` still returns every station
- Flight category (VFR/MVFR/IFR/LIFR) returned directly from the AWC API; decodes wind, visibility, present weather, and cloud layers alongside the raw METAR string
- Ceiling reports both height and kind (measured, or indefinite for vertical visibility into an obscuration) — `sky_condition` distinguishes a reported clear sky from an unreported one when `clouds` is empty
- `metar_type` distinguishes routine `METAR` from special `SPECI` observations
- Every batch reports which requested stations came back, naming missing IDs with recovery guidance

---

### `aviation_get_taf` <sub>tool</sub>

- Accepts 1–4 ICAO station IDs per call
- Structured forecast periods with change types (`FM`, `TEMPO`, `BECMG`) and probabilities; weather decoded group by group beside the raw groups
- Forecast obscurations keep their layer and carry the vertical visibility into them, rather than reading as clear sky; `sky_condition` distinguishes an unamended period from a stated clear sky
- Text the upstream decoder left undecoded — often a fourth cloud layer — is surfaced per period in `not_decoded` rather than dropped
- Low-level wind shear (`WS020/20040KT`) decoded to the shear-layer top and forecast wind at that height
- `valid_from` / `valid_to` in ISO 8601 for time comparisons
- Every batch reports which requested stations came back, naming missing IDs with recovery guidance

---

### `aviation_get_pireps` <sub>tool</sub>

- `station_id` + `distance_nm` (10–500 nm, 100 when omitted) for radial search, or `bbox` for area search — mutually exclusive; a `station_id` AWC does not recognize as a search center returns a typed error pointing to `aviation_find_stations` or `bbox`
- `altitude_min_ft` / `altitude_max_ft` filter to a cruise-altitude band in feet MSL, from 0 to 60000 ft (min must not exceed max); a report with unknown altitude is dropped once either bound is set
- `min_intensity` (`lgt` / `mod` / `sev`) restricts to reports carrying a turbulence or icing layer at that intensity or above — a matching report still carries its lighter layers
- Turbulence and icing arrays include up to two layers per report; icing layers the API synthesized for a report that never mentioned ice are dropped
- Outside air temperature (`temp_c`), wind aloft (`wind`), and the `/WX` flight weather decoded beside its raw groups (`weather`), for PIREPs and AIREPs alike. The wind direction is published as reported, with no conversion — a PIREP `/WV` direction is magnetic, unlike the true-north METAR and TAF winds
- Every result states whether the upstream 400-row cap cut it, naming only the narrowing levers the call can still use, and `limit` (1–400) bounds how many reports come back, ordered by recency. A result of more than 50 reports with no `limit` says so and names the lever; omitting `limit` still returns every match
- PIREPs are sparse by nature — absence of reports does not mean smooth conditions

---

### `aviation_get_advisories` <sub>tool</sub>

- `advisory_type`: `sigmet` or `all` (default) — both return the active SIGMET set
- `hazard` filter (`CONVECTIVE`, `TURBULENCE`, `ICING`, `IFR`) applied upstream by AWC; `bbox` filtered client-side by polygon overlap
- AIRMETs are not served — the upstream feed carries domestic SIGMETs only, and a request for one (or its `MTN OBSCN` / `SURFACE WIND` / `LLWS` hazards) is rejected with guidance rather than answered with SIGMETs
- An empty result is a valid fair-weather state, and names what emptied it — nothing active, no advisory carrying the hazard, or none intersecting the `bbox` — so a filter that needs broadening isn't mistaken for quiet weather

---

### `aviation_preflight_brief` <sub>prompt</sub>

- Arguments: `departure_icao` and `destination_icao` required; `alternates` (comma-separated ICAOs), `departure_time` (ISO 8601 UTC), `cruise_altitude` (feet MSL), and `route_waypoints` (semicolon-separated `lat,lon` pairs) optional
- Calls `aviation_get_metar`, `aviation_get_taf`, `aviation_get_pireps`, and `aviation_get_advisories` in sequence, chunked to each tool's station-per-call limit
- `departure_time` selects the TAF forecast period the briefing is read against; `cruise_altitude` bounds the PIREP search to a ±3,000 ft band; `route_waypoints` become the advisories `bbox`, widened by 1° on each side
- Omitting any of the three still generates the briefing, naming the assessment it could not make
- Reports weather risk rather than a go/no-go recommendation — that decision needs pilot, aircraft, and operational-minima context this server does not hold

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Aviation-weather-specific:

- Keyless — no API key or authentication required; all data is from the public AWC Data API
- Single service (`aviation-weather-service`) with retry + exponential backoff for the keyless public endpoint
- Raw coded strings (`raw_metar`, `raw_taf`, `raw_pirep`, `raw_text`) surfaced alongside decoded fields so agents have both layers
- State→bbox table enables US-state station queries that the AWC API doesn't natively support
- Server-level `instructions` field surfaces the "not an official briefing" safety disclaimer to all clients on `initialize`

Agent-friendly output:

- Discriminated output — flight category (`VFR`/`MVFR`/`IFR`/`LIFR`) as a typed string field, so agents branch on it without parsing ceiling and visibility
- Structured error contracts — typed `reason` fields with `recovery` hints (e.g., "Verify ICAO IDs with `aviation_find_stations`")
- Partial-result reconciliation — batch tools report `requested` / `returned` / `missing` / `partial` fields, so a short batch is never mistaken for full coverage
- Workflow sequencing — the `aviation_preflight_brief` prompt encodes the correct METAR → TAF → PIREPs → advisories sequence, chunks each step to the tool's station limit, and names the assessments it could not make

---

## Getting started

### Public Hosted Instance

A public hosted instance is available at `https://aviation-weather.caseyjhand.com/mcp`. Add it to your MCP client configuration:

```json
{
  "mcpServers": {
    "aviation-weather": {
      "type": "streamable-http",
      "url": "https://aviation-weather.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `MCP_SESSION_MODE` | HTTP session handling: `auto` (resolves to `stateful`), `stateful`, or `stateless`. The server declares `stateless` in code — no tool here needs a multi-round-trip input — and the shipped `.env.example` and Docker image pin the same value. Setting this overrides the declaration. | `stateless` |
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
- Register new tools and prompts in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

> **Not an official preflight briefing.** Data from the AWC is informational only. Real flight planning requires an authorized source (e.g., Leidos/1800wxbrief.com). The server surfaces this disclaimer via its `instructions` field sent on every `initialize`.

---

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
