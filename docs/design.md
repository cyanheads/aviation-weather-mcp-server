# aviation-weather-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `aviation_get_metar` | Current weather observations for one or more airports. Returns decoded fields (wind direction/speed/gusts, visibility, ceiling, temp/dewpoint, altimeter, cloud layers) plus the computed flight category (VFR/MVFR/IFR/LIFR) and the raw METAR string. Accepts 1–10 ICAO station IDs. | `station_ids: string[]`, `hours?: number (1–12, default 1)` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_get_taf` | Terminal Aerodrome Forecast for one or more airports. Returns each forecast period with valid times, wind, visibility, weather codes, and cloud layers, plus the raw TAF string. Accepts 1–4 ICAO station IDs. | `station_ids: string[]` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_get_pireps` | Recent Pilot Reports near an airport or within a bounding box. Returns decoded turbulence/icing/cloud reports with altitude, aircraft type, intensity, and the raw pirep string. | `station_id?: string`, `bbox?: {minLat, minLon, maxLat, maxLon}`, `distance_nm?: number (default 100)`, `hours?: number (1–12, default 3)` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_get_advisories` | Active SIGMETs and AIRMETs for a region. Returns each advisory with hazard type (CONVECTIVE, TURBULENCE, ICING, IFR, MTN OBSCN), severity, altitude range, valid period, polygon coordinates, and raw text. Accepts optional hazard filter or bounding box. | `hazard?: enum`, `bbox?: {minLat, minLon, maxLat, maxLon}`, `advisory_type?: 'sigmet' \| 'airmet' \| 'all'` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_find_stations` | Resolve an airport or weather reporting station by ICAO ID, or discover stations within a bounding box or US state. Returns ICAO/IATA/FAA IDs, coordinates, elevation, and available data types. | `station_ids?: string[]`, `bbox?: {minLat, minLon, maxLat, maxLon}`, `state?: string (2-letter)` | `readOnlyHint: true, idempotentHint: true, openWorldHint: false` |

### Resources

None. All data is time-sensitive (METARs valid ~1 hour, advisories minutes to hours) — stable-URI resources would deliver stale data. Tool-only surface is correct.

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `aviation_preflight_brief` | Structures a preflight weather briefing for one or more airports. Guides the LLM to call METAR, TAF, and advisories in sequence and synthesize a go/no-go picture with flight categories and active hazards. | `departure_icao: string`, `destination_icao: string`, `alternates?: string` |

---

## Overview

Aviation weather from the NWS Aviation Weather Center (aviationweather.gov) — METARs, TAFs, PIREPs, and SIGMETs/AIRMETs decoded and ready for agent use. Keyless, no authentication required. Covers the AWC Data API at `https://aviationweather.gov/api/data/`.

**Audience:** Pilots (GA and commercial), flight dispatchers, drone operators, aviation enthusiasts, and agents answering questions like "What's the weather at KSEA?", "Is it VFR at my destination?", "Any SIGMETs along this route?"

**Not a replacement for official preflight briefing.** This data is informational only; real flight planning requires an authorized source (Leidos/1800wxbrief.com). The server surfaces this framing via its `instructions` field.

---

## Requirements

- Keyless REST — no API key or auth required
- Primary data types: METAR, TAF, PIREP, AIRSIGMET (SIGMETs + AIRMETs combined endpoint)
- All endpoints return JSON when `format=json` is passed; raw coded text is also available but not used (we surface `rawOb`/`rawTAF`/`rawAirSigmet` directly in structured output)
- METAR/TAF coverage is global; PIREPs and SIGMETs/AIRMETs are US-centric
- Station IDs are ICAO format (`KSEA`, `KJFK`, etc.); the `stationinfo` endpoint resolves IATA/FAA IDs
- No geocoding in the API — inputs must be ICAO IDs or coordinates/bbox
- Flight category (VFR/MVFR/IFR/LIFR) is returned directly by the METAR endpoint as `fltCat` — no need to compute client-side
- Rate limits: not documented; keyless public API — implement retry with backoff

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `aviation-weather-service` | AWC Data API (`https://aviationweather.gov/api/data/`) | All 5 tools |

Single service, single upstream. The service handles HTTP fetch with timeout, retry with exponential backoff, and response parsing/normalization. All tools route through it.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `AWC_BASE_URL` | No | Override for base URL (default: `https://aviationweather.gov/api/data`). Useful for testing against a mock or staging instance. |
| `AWC_TIMEOUT_MS` | No | Request timeout in milliseconds (default: `10000`). |

No API key required. Config schema is minimal.

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with `AWC_BASE_URL` and `AWC_TIMEOUT_MS`
2. **Service** — `src/services/aviation-weather/aviation-weather-service.ts` with `fetchMetar`, `fetchTaf`, `fetchPireps`, `fetchAdvisories`, `fetchStations` methods; retry + timeout via `withRetry`/`fetchWithTimeout`
3. **Service types** — `src/services/aviation-weather/types.ts` (raw API response shapes + normalized output types)
4. **Tools** — in this order: `aviation_find_stations` → `aviation_get_metar` → `aviation_get_taf` → `aviation_get_pireps` → `aviation_get_advisories`
5. **Prompt** — `aviation_preflight_brief`
6. **Cleanup** — remove echo definitions, wire all definitions into `createApp()`

Each step is independently testable.

---

## Domain Mapping

| Noun | Operations | API Endpoint |
|:-----|:-----------|:-------------|
| Station | find by ICAO IDs, find by bbox, find by US state | `GET /stationinfo` |
| METAR | get current/recent by ICAO IDs | `GET /metar?ids=&format=json&hours=` |
| TAF | get current by ICAO IDs | `GET /taf?ids=&format=json` |
| PIREP | list recent by station + distance, or by bbox | `GET /pirep?id=&format=json&distance=&hours=` |
| AIRSIGMET | list active by type and/or bbox | `GET /airsigmet?format=json&type=` |

---

## Tool Design Details

### `aviation_get_metar`

**Input schema:**
```
station_ids: z.array(z.string().regex(/^[A-Z]{4}$/).describe('ICAO station ID')).min(1).max(10)
hours: z.number().int().min(1).max(12).default(1).describe('Hours of history to return (1–12). Default 1 returns only the most recent observation per station.')
```

**Output schema (per station):**
```
station_id: string           // icaoId
name: string                 // human-readable station name
lat / lon: number
elevation_ft: number
flight_category: 'VFR' | 'MVFR' | 'IFR' | 'LIFR'  // fltCat — the headline
metar_type: 'METAR' | 'SPECI'   // metarType — SPECI = special observation triggered by significant weather change
observed_at: string          // ISO 8601 from obsTime (unix → date)
wind: { direction_deg: number | null, speed_kt: number, gust_kt: number | null }
visibility_sm: string        // '10+', '3', '1/2' etc.
ceiling_ft: number | null    // lowest BKN or OVC layer base
clouds: { cover: string, base_ft: number }[]
temp_c: number
dewpoint_c: number
altimeter_inhg: number
raw_metar: string            // rawOb
```

**Error contract:**
```
{ reason: 'no_stations_found', code: NotFound, when: 'None of the requested station IDs returned data', recovery: 'Verify ICAO IDs with aviation_find_stations.' }
```

### `aviation_get_taf`

**Input schema:**
```
station_ids: z.array(z.string().regex(/^[A-Z]{4}$/).describe('ICAO station ID')).min(1).max(4)
```

**Output schema (per station):**
```
station_id: string
name: string
issued_at: string            // ISO 8601 from issueTime
valid_from: string           // ISO 8601 from validTimeFrom
valid_to: string             // ISO 8601 from validTimeTo
forecast_periods: [{
  from: string,              // ISO 8601 from timeFrom
  to: string,                // ISO 8601 from timeTo
  change_type: string | null // fcstChange: 'FM', 'TEMPO', 'BECMG', null
  probability: number | null // probability
  wind: { direction_deg: number | null, speed_kt: number, gust_kt: number | null }
  visibility_sm: string | null
  weather: string | null     // wxString decoded (e.g. '-SHRA' → 'light rain showers')
  clouds: { cover: string, base_ft: number, type: string | null }[]
}]
raw_taf: string              // rawTAF
```

**Design note:** `wxString` from the API is the raw weather group (e.g., `-SHRA`, `TSRA`). The service should decode common codes to plain English and include both the raw and decoded forms.

**Error contract:**
```
{ reason: 'no_taf_available', code: NotFound, when: 'Station does not issue TAFs (not a TAF-capable station)', recovery: 'Not all airports have TAFs. Check siteType from aviation_find_stations. VFR advisory airports may only have METARs.' }
```

### `aviation_get_pireps`

**Input schema:**
```
station_id: z.string().regex(/^[A-Z]{4}$/).optional().describe('Center ICAO station for radial search.')
bbox: z.object({ minLat, minLon, maxLat, maxLon }).optional()
distance_nm: z.number().int().min(10).max(500).default(100).describe('Search radius in nautical miles around station_id.')
hours: z.number().int().min(1).max(12).default(3).describe('How far back to look.')
altitude_min_ft: z.number().int().optional().describe('Filter by minimum altitude in feet MSL (e.g., 18000 for FL180).')
altitude_max_ft: z.number().int().optional().describe('Filter by maximum altitude in feet MSL (e.g., 35000 for FL350).')
```

Note: `station_id` or `bbox` is required (mutually exclusive, validate in handler).

**Output schema (per PIREP):**
```
observed_at: string          // ISO 8601 from obsTime
lat / lon: number
altitude_ft: number          // fltLvl * 100 (flight level to feet)
aircraft_type: string | null // acType
pirep_type: 'PIREP' | 'AIREP'
turbulence: {               // API reports up to 2 layers (tbBas1/tbTop1/tbInt1/tbType1/tbFreq1 + tbBas2/...)
  base_ft: number | null,
  top_ft: number | null,
  intensity: string,         // e.g. 'NEG', 'LGT', 'LGT-MOD', 'MOD', 'SEV'
  type: string | null,       // e.g. 'CHOP', 'CAT'
  frequency: string | null   // tbFreq: 'OCNL', 'CONT' etc.
}[]                          // array — include both layers when reported, omit empty ones (empty intensity string = not reported)
icing: {                    // API reports up to 2 layers (icgBas1/icgTop1/icgInt1/icgType1 + icgBas2/...)
  base_ft: number | null,
  top_ft: number | null,
  intensity: string,
  type: string | null
}[]                          // array — include both layers when reported, omit empty ones
clouds: { cover: string, base_ft: number, top_ft: number }[] | null
visibility_sm: number | null
remarks: string | null       // wxString or remarks
raw_pirep: string            // rawOb
```

**Error contract:**
```
{ reason: 'no_pireps_found', code: NotFound, when: 'No pilot reports found in the search area/time window', recovery: 'Expand the distance_nm or hours parameters, or try a different region. PIREPs are sparse; absence of reports does not mean smooth conditions.' }
{ reason: 'missing_location', code: InvalidParams, when: 'Neither station_id nor bbox provided', recovery: 'Provide station_id for a radial search or bbox for an area search.' }
```

### `aviation_get_advisories`

**Input schema:**
```
advisory_type: z.enum(['sigmet', 'airmet', 'all']).default('all').describe('Filter by advisory type. "sigmet" includes convective SIGMETs. "airmet" includes AIRMET Sierra (IFR/mountain), Tango (turbulence), Zulu (icing).')
hazard: z.enum(['CONVECTIVE', 'TURBULENCE', 'ICING', 'IFR', 'MTN OBSCN', 'SURFACE WIND', 'LLWS']).optional()
bbox: z.object({ minLat, minLon, maxLat, maxLon }).optional().describe('Geographic filter — returns advisories whose polygon overlaps the bbox.')
```

**Output schema (per advisory):**
```
advisory_type: 'SIGMET' | 'AIRMET'
series_id: string            // seriesId — unique advisory identifier
hazard: string
severity: number | null      // severity field from API (integer, e.g. 5); present on convective SIGMETs, null on AIRMETs
issued_by: string            // icaoId of issuing center
valid_from / valid_to: string // ISO 8601 (converted from unix timestamps validTimeFrom/validTimeTo)
altitude_low_ft: number | null   // altitudeLow1 — use the primary (1) pair; altitudeLow2/altitudeHi2 are rarely set
altitude_high_ft: number | null  // altitudeHi1
movement: { direction_deg: number | null, speed_kt: number | null } | null
polygon: { lat: number, lon: number }[]   // coords array
raw_text: string             // rawAirSigmet
```

**Design note on bbox filtering:** The API does not natively filter by bbox — it returns all active advisories. The service fetches all and the handler filters by polygon/bbox overlap (point-in-polygon or bounding-box intersection). For now a simple bbox intersection check is sufficient.

**Error contract:**
```
{ reason: 'no_advisories', code: NotFound, when: 'No active advisories match the filter criteria', recovery: 'Try without filters to see all active advisories, or check a broader bbox.' }
```

### `aviation_find_stations`

**Input schema:**
```
station_ids: z.array(z.string()).min(1).max(20).optional().describe('One or more ICAO, IATA, or FAA station IDs.')
bbox: z.object({ minLat, minLon, maxLat, maxLon }).optional().describe('Return all stations in bounding box.')
state: z.string().length(2).optional().describe('Two-letter US state abbreviation (e.g., "WA").')
```

At least one of `station_ids`, `bbox`, or `state` is required.

**Note:** The API requires either `ids` or `bbox` — `state` is not a supported API filter. For `state` queries, the tool will use a pre-built bbox approximation per state, then client-side filter by the `state` field in the response.

**Output schema (per station):**
```
icao_id: string | null
iata_id: string | null
faa_id: string | null
name: string
lat / lon: number
elevation_ft: number
state: string
country: string
data_types: string[]         // siteType: ['METAR', 'TAF', etc.]
```

**Error contract:**
```
{ reason: 'station_not_found', code: NotFound, when: 'None of the requested IDs match any known station', recovery: 'ICAO IDs are 4 letters (e.g., KSEA). IATA IDs (3-letter like SEA) may not map 1:1. Try the full name with aviation_find_stations bbox.' }
```

---

## Design Decisions

**1. `fltCat` is returned by the API — no client-side computation needed.**
The AWC METAR endpoint returns `fltCat` directly in the JSON response. Initial assumption was that flight category would need to be computed from ceiling + visibility; it doesn't. This simplifies the service layer significantly.

**2. AIRSIGMET type filter is unreliable for non-convective.**
During live probing, `type=airmet` and `type=sigmet` both returned only SIGMETs (15 convective SIGMETs, no AIRMETs present at query time). The API appears to serve only currently-active advisories — it's common for AIRMETs to be absent during clear weather. The tool accepts an `advisory_type` filter parameter and passes it to the API, but notes to clients that absence of results reflects current conditions, not a query error.

**3. No geocoding — ICAO IDs are the interface.**
The AWC Data API does not geocode. All tools take ICAO station IDs or coordinates as input. `aviation_find_stations` provides the lookup from human-readable names via bbox/state queries. Agents needing "nearest airport to lat/lon" should chain with `openstreetmap-mcp-server`.

**4. `stationinfo` with `state` uses bbox workaround.**
The API does not accept a `state` query parameter for `stationinfo`. The live probe with `state=WA` returned `{"status":"error","error":"Must specify station IDs or bounding box, zoom, and density"}`. The service will maintain a state→approximate-bbox table and client-side filter the results by the `state` field.

**5. PIREPs use `icaoId: "KWBC"` for the center — not the station queried.**
All PIREP responses have `icaoId` set to `KWBC` (the collection center), not the station the search was centered on. The actual location is in `lat`/`lon`. This is a quirk of the API and should be documented in the service layer.

**6. Advisories bbox filtering is client-side.**
The AIRSIGMET endpoint doesn't support bbox filtering in the API itself. The service fetches all active advisories and filters by bounding-box overlap against `coords` polygons. This is acceptable because the set of active advisories is typically small (<50).

**7. Prompt included despite read-only server.**
The `aviation_preflight_brief` prompt earns its place: a preflight briefing has a well-established structure (METAR → TAF → PIREPs → advisories) that agents frequently get wrong by omitting steps. The prompt encodes the correct sequence and synthesis pattern.

---

## Known Limitations

- **Coverage:** METAR/TAF are global; PIREPs and SIGMETs/AIRMETs are US-centric (AWC is a US NWS product).
- **Recency:** METARs are typically 20–60 min old. TAFs are 6–30 hour forecasts. PIREPs are real-time but sparse. Advisory set reflects only currently active products.
- **No historical archive:** The API serves recent observations only (`hours` parameter up to 12 for METAR). No multi-day historical queries.
- **Not an official briefing:** This data does not constitute a regulatory-compliant preflight weather briefing. Pilots flying IFR or in controlled airspace must use an authorized source.
- **AIRSIGMET scope:** During fair-weather periods, no AIRMETs may be active. Absence of results is a valid state, not an error.

---

## API Reference

**Base URL:** `https://aviationweather.gov/api/data`

**Common parameters:**
- `format=json` — required for JSON responses (default is plain text)
- `ids=KSEA,KJFK` — comma-separated ICAO IDs for station-keyed endpoints
- `hours=N` — lookback window (METAR: 1–12 typical; PIREP: 1–12)
- `distance=N` — radius in nautical miles for PIREP searches

**Timestamp fields are Unix epoch seconds (integers), not ISO strings.** Applies to: METAR `obsTime`, TAF `validTimeFrom`/`validTimeTo`, AIRSIGMET `validTimeFrom`/`validTimeTo`. Convert via `new Date(value * 1000).toISOString()`. METAR `receiptTime`/`reportTime` and TAF `issueTime` are already ISO 8601 strings.

**Confirmed field names (from live probing 2026-06-05):**

METAR: `icaoId, receiptTime, obsTime, reportTime, temp, dewp, wdir, wspd, wgst, visib, altim, slp, qcField, metarType, rawOb, lat, lon, elev, name, cover, clouds[{cover,base}], fltCat`

TAF: `icaoId, dbPopTime, bulletinTime, issueTime, validTimeFrom, validTimeTo, rawTAF, mostRecent, remarks, lat, lon, elev, prior, name, fcsts[{timeFrom, timeTo, timeBec, fcstChange, probability, wdir, wspd, wgst, wshearHgt, wshearDir, wshearSpd, visib, altim, vertVis, wxString, notDecoded, clouds[{cover,base,type}], icgTurb, temp}]`

PIREP: `receiptTime, obsTime, qcField, icaoId, acType, lat, lon, fltLvl, fltLvlType, clouds[{cover,base,top}], visib, wxString, temp, wdir, wspd, icgBas1, icgTop1, icgInt1, icgType1, icgBas2, icgTop2, icgInt2, icgType2, tbBas1, tbTop1, tbInt1, tbType1, tbFreq1, tbBas2, tbTop2, tbInt2, tbType2, tbFreq2, vertGust, brkAction, pirepType, rawOb`

AIRSIGMET: `icaoId, alphaChar, seriesId, receiptTime, creationTime, validTimeFrom, validTimeTo, airSigmetType, hazard, altitudeHi1, altitudeHi2, altitudeLow1, altitudeLow2, movementDir, movementSpd, rawAirSigmet, postProcessFlag, severity, coords[{lat,lon}]`

STATIONINFO: `id, icaoId, iataId, faaId, wmoId, site, lat, lon, elev, state, country, priority, siteType[]`

**Error shape (HTTP 400):**
```json
{ "status": "error", "error": "Must specify station IDs or bounding box, zoom, and density" }
```
