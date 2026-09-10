# aviation-weather-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `aviation_get_metar` | Current weather observations for one or more airports. Returns decoded fields (wind direction/speed/gusts, visibility, ceiling and its kind, present weather, temp/dewpoint, altimeter, cloud layers) plus the computed flight category (VFR/MVFR/IFR/LIFR) and the raw METAR string. Accepts 1–10 ICAO station IDs. | `station_ids: string[]`, `hours?: number (1–12 lookback window, default 1)` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_get_taf` | Terminal Aerodrome Forecast for one or more airports. Returns each forecast period with valid times, wind, visibility, decoded weather, and cloud layers, plus the raw TAF string. Accepts 1–4 ICAO station IDs. | `station_ids: string[]` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_get_pireps` | Recent Pilot Reports near an airport or within a bounding box. Returns decoded turbulence/icing/cloud reports with altitude, aircraft type, intensity, and the raw pirep string. | `station_id?: string`, `bbox?: {minLat, minLon, maxLat, maxLon}`, `distance_nm?: number (station_id only, 100 when omitted)`, `hours?: number (1–12, default 3)`, `altitude_min_ft?: number`, `altitude_max_ft?: number`, `min_intensity?: 'lgt' \| 'mod' \| 'sev'`, `limit?: number (1–400 response bound)` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_get_advisories` | Active domestic SIGMETs for a region. Returns each advisory with hazard type (CONVECTIVE, TURBULENCE, ICING, IFR), severity, altitude range, valid period, polygon coordinates, and raw text. Accepts optional hazard filter or bounding box. AIRMETs are not served — a request for one is rejected. | `hazard?: enum`, `bbox?: {minLat, minLon, maxLat, maxLon}`, `advisory_type?: 'sigmet' \| 'airmet' \| 'all'` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_find_stations` | Resolve an airport or weather reporting station by ICAO ID, or discover stations within a bounding box or US state. Returns ICAO/IATA/FAA IDs, coordinates, elevation, and available data types. | `station_ids?: string[]`, `bbox?: {minLat, minLon, maxLat, maxLon}`, `state?: string (2-letter)`, `limit?: number (1–400 response bound, bbox/state only)` | `readOnlyHint: true, idempotentHint: true, openWorldHint: false` |

### Resources

None. All data is time-sensitive (METARs valid ~1 hour, advisories minutes to hours) — stable-URI resources would deliver stale data. Tool-only surface is correct.

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `aviation_preflight_brief` | Structures a preflight weather briefing for one or more airports. Guides the LLM to call METAR, TAF, PIREPs, and advisories in sequence — chunked to each tool's station limit, bounded to the planned cruise level and route corridor where those were supplied — and synthesize a weather-risk summary that names the assessments it could not make. | `departure_icao: string`, `destination_icao: string`, `alternates?: string`, `departure_time?: string`, `cruise_altitude?: string`, `route_waypoints?: string` |

All six args are strings: `prompts/get` carries arguments as `{ [key: string]: string }` on the wire, so a numeric Zod type would reject every real client's call. Each optional field also accepts `''` — a form-based client sends one for a field left blank — and reads it as omitted. Shape is enforced by regex so it reaches the caller as a JSON Schema `pattern`: four uppercase letters for each identifier, ISO 8601 UTC ending in `Z` for `departure_time`, digits-only feet MSL for `cruise_altitude`, and semicolon-separated `lat,lon` pairs for `route_waypoints`. See decision 30.

---

## Overview

Aviation weather from the NWS Aviation Weather Center (aviationweather.gov) — METARs, TAFs, PIREPs, and domestic SIGMETs decoded and ready for agent use. Keyless, no authentication required. Covers the AWC Data API at `https://aviationweather.gov/api/data/`.

**Audience:** Pilots (GA and commercial), flight dispatchers, drone operators, aviation enthusiasts, and agents answering questions like "What's the weather at KSEA?", "Is it VFR at my destination?", "Any SIGMETs along this route?"

**Not a replacement for official preflight briefing.** This data is informational only; real flight planning requires an authorized source (Leidos/1800wxbrief.com). The server surfaces this framing via its `instructions` field.

---

## Requirements

- Keyless REST — no API key or auth required
- Primary data types: METAR, TAF, PIREP, AIRSIGMET (domestic SIGMETs; the endpoint's `airSigmetType` is pinned to `SIGMET` and it serves no AIRMETs)
- All endpoints return JSON when `format=json` is passed; raw coded text is also available but not used (we surface `rawOb`/`rawTAF`/`rawAirSigmet` directly in structured output)
- METAR/TAF coverage is global; PIREPs and SIGMETs are US-centric
- Station IDs are ICAO format (`KSEA`, `KJFK`, etc.); the `stationinfo` endpoint accepts ICAO IDs only and returns IATA/FAA aliases in each record
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
| PIREP | list recent by station + distance, or by bbox; narrowed upstream by altitude band and minimum intensity | `GET /pirep?id=&format=json&distance=&age=&level=&inten=` |
| AIRSIGMET | list active, narrowed upstream by hazard and client-side by bbox | `GET /airsigmet?format=json&hazard=` |

---

## Tool Design Details

### `aviation_get_metar`

**Input schema:**
```
station_ids: z.array(z.string().regex(/^[A-Z]{4}$/).describe('ICAO station ID')).min(1).max(10)
hours: z.number().int().min(1).max(12).default(1)   // a lookback window, not a row limit — every observation inside it is returned
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
wind: { direction_deg: number | null, speed_kt: number | null, gust_kt: number | null }
visibility_sm: string        // '10+', '3', '1/2' etc.; 'unknown' when no visibility group was reported
ceiling_ft: number | null    // lowest BKN, OVC, or OVX layer base, feet AGL; null both for no such layer and for an obscuration of undetermined height, which sky_condition: 'OVX' marks
ceiling_type: 'measured' | 'indefinite' | null   // null exactly when ceiling_ft is null
clouds: { cover: string, base_ft: number }[]   // base_ft is feet AGL; empty whenever the observation published no layer heights
sky_condition: string | null // cover — the group stated when there are no layer heights (CLR/SKC/CAVOK, or OVX for a VV/// obscuration); null when clouds carries layers, and when nothing was reported
present_weather: { raw: string, decoded: string } | null   // wxString, both forms
temp_c: number | null
dewpoint_c: number | null
altimeter_inhg: number | null
raw_metar: string            // rawOb
```

An empty `clouds` array and `sky_condition` are read together: the array empties for a clear sky, for an obscuration with no determinable height, and for an observation that stated nothing, and only `sky_condition` separates them — see decision 21.

`speed_kt`, `temp_c`, `dewpoint_c`, and `altimeter_inhg` are null when upstream omitted the group. 0 is a real reading for every one of them (calm wind, freezing point), so it cannot double as "not reported". `elevation_ft` stays a plain number: AWC never returned a null METAR `elev` in any sampled region, its schema declares `default: 0`, and 0 is correct for a sea-level field.

**Error contract:**
```
{ reason: 'no_stations_found', code: NotFound, when: 'None of the requested station IDs returned data', recovery: 'Verify ICAO IDs with aviation_find_stations.' }
```

**Enrichment contract** (see decision 17):
```
requested: string[]           // always — station IDs as requested
returned:  string[]           // always — distinct station IDs present in the result, counted per station not per row
partial:   boolean            // always — true when a requested station returned nothing
missing:   string[]           // only when non-empty
notice:    string             // only on a partial result — recovery guidance
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
  change_type: string | null // fcstChange: 'FM', 'TEMPO', 'BECMG', 'PROB' (a standalone probability group), null
  probability: number | null // probability
  wind: { direction_deg: number | null, speed_kt: number | null, gust_kt: number | null }
  wind_shear: { height_ft: number, direction_deg: number, speed_kt: number } | null  // wshearHgt/Dir/Spd, passed through unconverted
  visibility_sm: string | null
  vertical_visibility_ft: number | null   // vertVis, already in feet; non-null only on an obscured period
  weather: { raw: string, decoded: string } | null   // wxString, both forms
  clouds: { cover: string, base_ft: number, type: string | null }[]   // base_ft is feet AGL; empty whenever the period published no layer heights
  sky_condition: string | null   // the group the period forecast when its cover carries no height (SKC/NSC, or OVX for an obscuration with no vertical visibility); null when clouds carries layers, and when the period carried no cloud element
}]
raw_taf: string              // rawTAF
```

`wind.speed_kt` is null when the period carries no wind element — a TEMPO or PROB group amending only visibility, weather, or cloud, which is 13% of live CONUS forecast periods. `wdir` is null on exactly those, and the string `VRB` on a variable wind that does carry a speed; both normalize to `direction_deg: null`, so `speed_kt` is what separates "no wind forecast" from "variable". 0 kt stays a forecast calm.

**Design note:** `wxString` from the API is one or more space-delimited weather groups (e.g., `-SHRA`, `-SHRA BR`). Both forms are carried, matching `aviation_get_metar`'s `present_weather` — see decision 14 for how a group is decoded and what happens when one does not resolve.

**Design note:** an empty `clouds` array is read with `sky_condition`, which separates a forecast clear sky from a period that amended nothing about cloud — see decision 21.

**Design note:** `vertical_visibility_ft` and the `OVX` layer that carries the same height are gated on the period's own obscuration — see decision 15. `wind_shear` is one nullable object rather than three nullable scalars, and its `speed_kt` is a wind velocity rather than a shear magnitude — see decision 16.

**Error contract:**
```
{ reason: 'no_taf_available', code: NotFound, when: 'Station does not issue TAFs (not a TAF-capable station)', recovery: 'Not all airports have TAFs. Check siteType from aviation_find_stations. VFR advisory airports may only have METARs.' }
```

**Enrichment contract** (see decision 17 — the same shape on `aviation_get_metar`):
```
requested: string[]           // always — station IDs as requested
returned:  string[]           // always — distinct station IDs present in the result
partial:   boolean            // always — true when a requested station returned nothing
missing:   string[]           // only when non-empty
notice:    string             // only on a partial result — recovery guidance
```

### `aviation_get_pireps`

**Input schema:**
```
station_id: z.string().regex(/^[A-Z]{4}$/).optional().describe('Center ICAO station for radial search.')
bbox: z.object({ minLat, minLon, maxLat, maxLon }).optional()
distance_nm: z.number().int().min(10).max(500).optional().describe('Search radius in nautical miles around station_id. 100 when omitted.')
hours: z.number().int().min(1).max(12).default(3).describe('How far back to look.')
altitude_min_ft: z.number().int().optional().describe('Filter by minimum altitude in feet MSL (e.g., 18000 for FL180).')
altitude_max_ft: z.number().int().optional().describe('Filter by maximum altitude in feet MSL (e.g., 35000 for FL350).')
min_intensity: z.enum(['lgt', 'mod', 'sev']).optional().describe('Return only reports carrying at least one turbulence or icing layer at this intensity or above. Selects reports, not layers.')
limit: z.number().int().min(1).max(400).optional()   // a response bound, not a search narrowing — applied last, after the sort
```

Note: `station_id` or `bbox` is required (mutually exclusive, validate in handler).

`distance_nm` carries no schema default — the handler must tell an omitted value from an explicit one to reject `bbox` + `distance_nm`, so the 100 nm fallback is applied on the `station_id` path instead.

`min_intensity` maps to the upstream `inten` and is sent as given; the advertised enum is lowercase, and a different casing is rejected by the schema rather than coerced, so the error names the valid options. The altitude bounds have no upstream counterpart of the same shape — `level` is a centre point with a fixed ±3,000 ft band, not a range — so they stay the caller-facing contract and the handler derives a `level` centre from them where the resulting band contains the whole request. See decision 19.

**Output schema (per PIREP):**
```
observed_at: string          // ISO 8601 from obsTime
lat / lon: number
altitude_ft: number | null   // fltLvl * 100 (flight level to feet); null when the raw flight-level group carries no usable altitude
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
  intensity: string,         // always a clean code; a concatenated value marks a synthesized layer
  type: string | null        // icgType1: 'RIME', 'MIXED', 'CLEAR'; empty string upstream → null
}[]                          // array — layers AWC synthesized are dropped, per layer
clouds: { cover: string, base_ft: number | null, top_ft: number | null }[] | null
visibility_sm: number | null
remarks: string | null       // wxString or remarks
raw_pirep: string            // rawOb
```

`cover` also carries `SKC`, `CLR`, and the flight-condition markers `VMC`/`IMC`, which arrive with `base: 0, top: 0` — a layer with neither bound is kept for its cover rather than dropped. An empty `turbulence`/`icing` array means the report carried no such group; an explicit negative report is a layer with intensity `NEG`.

Each icing layer is admitted on its own: AWC marks a layer it synthesized by concatenating type text onto the intensity code, and such a layer is dropped rather than cleaned up — see decision 20. `turbulence` needs no equivalent: its intensities are clean codes throughout.

**Error contract:**
```
{ reason: 'no_pireps_found', code: NotFound, when: 'No pilot reports found in the search area/time window', recovery: 'Expand the distance_nm or hours parameters, or try a different region. PIREPs are sparse; absence of reports does not mean smooth conditions.' }
{ reason: 'missing_location', code: ValidationError, when: 'Neither station_id nor bbox provided', recovery: 'Provide station_id for a radial search or bbox for an area search.' }
{ reason: 'conflicting_location', code: ValidationError, when: 'Both station_id and bbox provided', recovery: 'Provide station_id OR bbox, not both.' }
{ reason: 'invalid_bbox', code: ValidationError, when: 'The bounding box is inverted', recovery: 'Ensure minLat <= maxLat and minLon <= maxLon.' }
{ reason: 'conflicting_distance', code: ValidationError, when: 'distance_nm provided together with bbox', recovery: 'Drop distance_nm, or replace bbox with station_id.' }
{ reason: 'invalid_altitude_range', code: ValidationError, when: 'altitude_min_ft > altitude_max_ft', recovery: 'Ensure altitude_min_ft <= altitude_max_ft, or drop one bound.' }
```

Guard order is `missing_location` → `conflicting_location` → `invalid_bbox` → `conflicting_distance` → `invalid_altitude_range`, so a location-mode mistake is always reported ahead of a filter mistake. Equal altitude bounds are a valid degenerate range, mirroring `isBboxOrdered`'s `<=`.

**Enrichment contract** (see decisions 18 and 24):
```
truncated:    boolean         // always — true when the page hit the 400-row upstream cap
shown:        number          // always — reports returned, after any altitude filter and any limit
cap:          number          // only when truncated — the upstream row maximum applied
upstreamRows: number          // only when the altitude filter narrowed a truncated page
limited:      boolean         // only when the call supplied a limit — true when it withheld matching reports
matched:      number          // only when limited — reports that matched before the limit selected from them
notice:       string          // whichever disclosures fired — the narrowing levers, and what a limit withheld
```

Detection reads the row count upstream served, before the altitude filter selects from it. `fetchPireps` applies no client-side filter of its own, so that count is the length the handler receives; the altitude filter runs afterwards in the handler, which is why the disclosure is computed there and not from the returned count. The `level` and `inten` parameters narrow what AWC *draws*, so the count stays the drawn row count and the disclosure keeps describing AWC's own page — see decision 19.

When a capped page is then emptied by the altitude filter, `no_pireps_found` says the area was searched only in part and points at the same narrowing levers. It does not report the capped page's row count as the reports present in the area — that count describes the page, not the area, and the filter never saw beyond it. An empty draw under an upstream narrowing gets its own message, since the query never asked for the whole area to begin with.

### `aviation_get_advisories`

**Input schema:**
```
advisory_type: z.enum(['sigmet', 'airmet', 'all']).default('all').describe('Filter by advisory type. "sigmet" and "all" both return the active domestic SIGMET set. "airmet" is rejected — the upstream feed cannot return one.')
hazard: z.enum(['CONVECTIVE', 'TURBULENCE', 'ICING', 'IFR', 'MTN OBSCN', 'SURFACE WIND', 'LLWS']).optional()
bbox: z.object({ minLat, minLon, maxLat, maxLon }).optional().describe('Geographic filter — returns advisories whose polygon overlaps the bbox.')
```

**Output schema (per advisory):**
```
advisory_type: string        // airSigmetType, which the endpoint's schema pins to 'SIGMET'
series_id: string            // seriesId — unique advisory identifier
hazard: string               // one of CONVECTIVE, TURBULENCE, ICING, IFR — the four classes /airsigmet enumerates
severity: number | null      // severity field from API (integer, e.g. 5); null when the advisory stated none
issued_by: string            // icaoId of issuing center
valid_from / valid_to: string // ISO 8601 (converted from unix timestamps validTimeFrom/validTimeTo)
altitude_low_ft: number | null   // altitudeLow1 — use the primary (1) pair; altitudeLow2/altitudeHi2 are rarely set
altitude_high_ft: number | null  // altitudeHi1
movement: { direction_deg: number | null, speed_kt: number | null } | null
polygon: { lat: number, lon: number }[]   // coords array
raw_text: string             // rawAirSigmet
```

**Design note on filtering:** The two filters sit on opposite sides of the request. `hazard` maps to `/airsigmet`'s own `hazard` parameter (`CONVECTIVE` → `conv`, `TURBULENCE` → `turb`, `ICING` → `ice`, `IFR` → `ifr`), so AWC does the matching against its own record vocabulary — see decision 23. `bbox` has no upstream counterpart and stays a client-side bounding-box intersection against each advisory's `coords` polygon — see decision 6.

**Error contract:**
```
{ reason: 'invalid_bbox', code: ValidationError, when: 'The bounding box is inverted', recovery: 'Ensure minLat <= maxLat and minLon <= maxLon.' }
{ reason: 'airmet_not_served', code: ValidationError, when: 'advisory_type "airmet", or a hazard naming an AIRMET-family phenomenon (MTN OBSCN, SURFACE WIND, LLWS)', recovery: 'Use advisory_type "sigmet"/"all" and the CONVECTIVE, TURBULENCE, ICING, or IFR hazards; AIRMET information lives on the G-AIRMET and textual AIRMET products this tool does not read.' }
```

An empty result is not an error — fair weather is a valid state, so no `no_advisories` reason exists; the empty path carries an enrichment notice instead (decision 23). `invalid_bbox` is checked ahead of `airmet_not_served`, so a malformed box is reported before the unsupported product. The rejection is raised in the handler rather than by narrowing the Zod enum, so the caller receives the typed reason and recovery instead of a transport-level `-32602`; `advisory_type` keeps all three enum members for that reason, and so the parameter remains the discriminator when AIRMET-family sources are added (#29).

The `airmet_not_served` guard also does the type narrowing. `isSigmetHazard` is a type predicate over the four hazards that map to an upstream token, so only a `SigmetHazard` reaches `fetchAdvisories` — which is what makes the rejection a compile-time requirement rather than a convention, and leaves no reachable path on which AWC could answer `400 Invalid value for hazard`. `advisoryType`'s `'sigmet' | 'all'` union does the same job for the product axis.

**Enrichment contract** (see decision 23):
```
notice: string               // only on an empty result — the stage that emptied it, and the filter to broaden
```

No `truncated`/`cap` pair joins it. Only two of the five tools can reach the 400-row cap and this is not one of them; were the pair added, detection would read the drawn row count the way decision 18 requires — the count this notice already reports.

### `aviation_find_stations`

**Input schema:**
```
station_ids: z.array(z.string().regex(/\S/)).min(1).max(20).optional()   // trimmed handler-side; empty or whitespace-only is rejected, and no shape is imposed — see decision 27
bbox: z.object({ minLat, minLon, maxLat, maxLon }).optional().describe('Return all stations in bounding box.')
state: z.string().length(2).optional().describe('Two-letter USPS code for one of the 50 US states or DC (e.g., "WA").')
limit: z.number().int().min(1).max(400).optional()   // bbox and state modes only — a response bound, not an area narrowing; rejected alongside station_ids. Ordered by icao_id asc, identifier-less last, tiebroken by registry id — see decision 26
```

Exactly one of `station_ids`, `bbox`, or `state` is required.

**Note:** The API requires either `ids` or `bbox` — `state` is not a supported API filter. For `state` queries, the tool uses a pre-built bbox approximation per state (`src/services/aviation-weather/state-bboxes.ts`), then client-side filters by the `state` field in the response. The table covers the 50 states plus DC; anything else is rejected handler-side by `isSupportedState` before a request goes out.

**Output schema (per station):**
```
icao_id: string | null
iata_id: string | null
faa_id: string | null
name: string
lat / lon: number
elevation_ft: number | null  // null when no elevation is on file upstream; 0 is a sea-level site
state: string
country: string
data_types: string[]         // siteType: ['METAR', 'TAF', etc.]
```

**Error contract:**
```
{ reason: 'station_not_found', code: NotFound, when: 'None of the requested IDs match any known station', recovery: "A lookup matches the registry's own identifier, which for an airport is its 4-letter ICAO ID (KSEA, not SEA). Use bbox or state to discover identifiers by location." }
{ reason: 'missing_search_criteria', code: ValidationError, when: 'None of station_ids, bbox, or state provided', recovery: 'Provide exactly one of station_ids, bbox, or state.' }
{ reason: 'conflicting_location', code: ValidationError, when: 'More than one of station_ids, bbox, or state provided', recovery: 'Provide exactly one location mode per call.' }
{ reason: 'invalid_bbox', code: ValidationError, when: 'The bounding box is inverted', recovery: 'Ensure minLat <= maxLat and minLon <= maxLon.' }
{ reason: 'invalid_state', code: ValidationError, when: 'The state code is not one of the 50 US states or DC', recovery: 'Use a USPS code for a state or DC; territories are unsupported — search them with bbox.' }
{ reason: 'conflicting_limit', code: ValidationError, when: 'limit provided together with station_ids', recovery: 'Drop limit, or replace station_ids with bbox or state.' }
{ reason: 'upstream_rejected', code: InvalidParams, when: 'The registry rejected the request as malformed', recovery: mode-agnostic in the contract; the throw site sends a hint branched on the mode that built the query — see decision 28 }
```

`conflicting_location` is checked ahead of `invalid_state`, so combining a bogus `state` with another location mode reports the mode conflict. `conflicting_limit` is checked last of the input guards, so a location-mode mistake is always reported ahead of a filter mistake — the order `aviation_get_pireps` uses for `conflicting_distance`. `upstream_rejected` is not an input guard: it is raised from the upstream call itself, and only for the one classification a malformed request produces (decision 28).

**Enrichment contract** — three disclosures on disjoint modes (decisions 18, 22, and 24):
```
truncated:    boolean         // always — true when the draw hit the 400-row upstream cap
shown:        number          // always — stations returned, after any state filter and any limit
cap:          number          // only when truncated — the upstream row maximum applied
upstreamRows: number          // only when the state filter narrowed a truncated draw
limited:      boolean         // only when the call supplied a limit — true when it withheld matching stations
matched:      number          // only when limited — stations that matched before the limit selected from them
requested:    string[]        // station_ids mode — the identifiers as the caller spelled them, trimmed
returned:     string[]        // station_ids mode — the requested identifiers that resolved
partial:      boolean         // station_ids mode — true when a requested identifier resolved to nothing
missing:      string[]        // station_ids mode — only when non-empty
notice:       string          // whichever disclosures fired — the narrowing lever, what a limit withheld, or the cause and fix
```

Only `bbox` and `state` can reach the row cap (`station_ids` is bounded at 20 by the input schema) and accept a `limit`, and only `station_ids` has a request to reconcile, so the reconciliation never co-occurs with the other two and `notice` is shared without conflating anything. The cap and the limit *can* co-occur, and there the notice states each in turn — see decision 24. `returned` and `missing` deduplicate the way upstream does — a repeated or differently-cased identifier appears once, under its first spelling — and reconciliation matches the registry's own `id`, which is why `NormalizedStation` carries it. See decision 22.

Cap detection reads the drawn row count, never the returned one. The state mode filters its draw inside `fetchStations` and reports that pre-filter size back through the `onPreFilterRows` callback; the `station_ids` and `bbox` modes return their draw unfiltered and report nothing, because there the rows returned are the rows drawn. `upstreamRows` is emitted only where a filter moved the count, since elsewhere it would restate `shown`. An empty result stays `station_not_found` and carries no disclosure.

---

## Design Decisions

**1. `fltCat` is returned by the API — no client-side computation needed.**
The AWC METAR endpoint returns `fltCat` directly in the JSON response. Initial assumption was that flight category would need to be computed from ceiling + visibility; it doesn't. This simplifies the service layer significantly.

**2. The AIRSIGMET endpoint has no type filter, and serves no AIRMETs at all.**
During live probing, `type=airmet` and `type=sigmet` returned the same 15 convective SIGMETs. That was first read as fair weather — no AIRMETs active at query time — and the reading was wrong. `/airsigmet` defines no `type` parameter, and the AWC API answers HTTP 200 while silently dropping query keys it does not recognize, so the filter never applied; the deprecated plural `types=` is equally inert. Re-probed with `hazard=conv`, the bodies with `type=airmet`, with `types=airmet`, and with neither are byte-identical, while `hazard=turb` returns 204 and `hazard=nonsense` returns 400 — the endpoint honors the parameters it defines, so `type=` is being dropped rather than applied and matched.

The endpoint cannot return an AIRMET under any parameter: its schema titles it "Domestic SIGMETs" and pins `airSigmetType` to `enum: [SIGMET]`. CONUS text AIRMETs no longer exist — NWS Service Change Notice 24-92 retired them effective 2025-01-27 1900Z in favor of the Graphical AIRMET, with Alaska and Hawaii unaffected — and AWC serves the replacements on separate endpoints (`/gairmet`, `/airmet`) whose shapes do not fit this tool's output schema. So the dead `type=` key comes out of the URL, and an AIRMET request is rejected with a typed reason instead of being answered with SIGMETs. Restoring the capability behind real sources is #29.

**3. No geocoding — ICAO IDs are the interface.**
The AWC Data API does not geocode. All tools take ICAO station IDs or coordinates as input. `aviation_find_stations` provides the lookup from human-readable names via bbox/state queries. Agents needing "nearest airport to lat/lon" should chain with `openstreetmap-mcp-server`.

**4. `stationinfo` with `state` uses bbox workaround.**
The API does not accept a `state` query parameter for `stationinfo`. The live probe with `state=WA` returned `{"status":"error","error":"Must specify station IDs or bounding box, zoom, and density"}`. The service maintains a state→approximate-bbox table and client-side filters the results by the `state` field.

The table covers the 50 states plus DC. DC is a real AWC jurisdiction but holds exactly one station — `WASD2` ("Washington DC"), a mesonet site with every identifier null; the region's airports (KDCA, KIAD, KBWI) carry `VA` or `MD`. US territories (PR, VI, GU, MP, AS) are deliberately excluded: AWC leaves `state` empty on their stations and identifies them by `country`, so a bbox entry would filter down to zero rows rather than working. Supporting them needs a country-based filter path, not another table row.

Validation lives in the handler rather than a schema `z.enum()`: an enum mismatch is raised by the SDK transport as JSON-RPC -32602 before the handler runs, which bypasses the tool's typed `reason`/`recovery` contract.

**5. PIREPs use `icaoId: "KWBC"` for the center — not the station queried.**
All PIREP responses have `icaoId` set to `KWBC` (the collection center), not the station the search was centered on. The actual location is in `lat`/`lon`. This is a quirk of the API and should be documented in the service layer.

**6. Advisories bbox filtering is client-side, and it is the only filter that stays here.**
The AIRSIGMET endpoint doesn't support bbox filtering in the API itself — its parameter list is `format`, the deprecated `types`, `hazard`, and `level`, with no bbox among them. The service fetches the active advisories and filters by bounding-box overlap against `coords` polygons. This is acceptable because the active advisory set is small: 16 rows in every draw taken during decision 23's verification, across twelve draws over eight minutes.

The hazard axis is not in the same position — `/airsigmet` does define a `hazard` parameter, so that filter is applied upstream (decision 23). The two are not a matched pair to keep symmetric: one has an upstream parameter and one does not, so the split follows what AWC actually defines.

**7. Prompt included despite read-only server.**
The `aviation_preflight_brief` prompt earns its place: a preflight briefing has a well-established structure (METAR → TAF → PIREPs → advisories) that agents frequently get wrong by omitting steps. The prompt encodes the correct sequence and synthesis pattern.

It is also the only place the flight itself can be described. Every tool here is keyed to a station, a box, or a hazard class — none of them takes a departure time, a cruise level, or a route — so an agent asked for "a briefing for this flight" has nowhere to put that context and answers with station weather instead. The prompt collects it and spends it on the steps that can use it: a cruise altitude becomes the PIREP altitude band, route waypoints become the advisory bbox, and a departure time becomes the instruction to read the TAF period whose valid window covers it. What it does not do is convert the result into a Go/No-Go verdict — that decision needs pilot currency, aircraft capability, and operational minima, none of which this server holds. See decision 30.

**8. The PIREP lookback parameter is `age`, not `hours`.**
`/pirep` declares `id, distance, bbox, format, age, level, inten, date` — no `hours`. The endpoint returns HTTP 200 and silently drops query keys it does not recognize, so sending `hours` produced the same fixed window for every value in both query modes. `/metar` and `/taf` do define a separate, correctly-named `hours` parameter, so the mismatch is specific to `/pirep`. The tool's public `hours` input keeps its name; only the outgoing key differs.

**9. `distance_nm` alongside `bbox` is rejected, not forwarded.**
A live sweep against a fixed bbox with `distance` at 1, 10, 50, 100, 200, 500 and omitted returned byte-identical PIREP sets — upstream ignores `distance` without an `id` center point to measure from, so there is nothing to forward it to. Rejecting the combination is the only way the caller learns the radius did nothing.

**10. An unavailable numeric observation is null, never 0.**
0 is a plausible aviation reading for every affected field — calm wind, a freezing temperature, a sea-level station — so it cannot double as "upstream reported nothing". Two upstream mechanisms feed the ambiguity and need different handling. METAR `wspd`/`temp`/`dewp`/`altim` and station `elev` arrive as genuine nulls, so the `?? 0` fallbacks became `?? null`. PIREP `fltLvl` and cloud `base`/`top` instead arrive as a literal `0`, which no null guard can catch.

For PIREP altitude the discriminator is the raw `/FL…/` group, not the numeric value and not `fltLvlType`. `fltLvl: 0` alone cannot separate `/FLDURD/` (no altitude given) from `/FL000/` (a reported flight level of zero); both occur in the same snapshot. `fltLvlType` is phase of flight, and plenty of DURC/DURD reports carry a real numeric level. `/FLSFC/` is left alone — AWC substitutes the field elevation in hundreds of feet, which the existing ×100 conversion renders correctly.

The group is read by whether it round-trips to the value AWC produced, not by matching a list of tokens — see decision 19.

Once altitude is nullable, `altitude_min_ft`/`altitude_max_ft` must choose explicitly rather than inherit a choice from the sentinel: an unknown altitude cannot be shown to satisfy a bound, so either bound drops it. The zero sentinel previously made the two bounds disagree — `min` discarded these reports, `max` kept them.

**11. Aerodrome cloud heights are AGL; pilot and advisory heights are MSL.**
METAR/TAF `clouds[].base_ft` and METAR `ceiling_ft` are heights above the field, passed through from AWC unchanged (a `BKN030` group decodes to `base: 3000` AGL). Labeling them MSL invited a client to add station elevation to an already-AGL number — at KASE (7,822 ft field elevation) that misjudges the layer by roughly 7,800 ft. PIREP heights stay MSL because pilots read altitude off the altimeter, and SIGMET/AIRMET vertical extents stay MSL because they are flight-level references (FAA AIM 7-1-14, 7-1-29). Station and METAR `elevation_ft` are MSL by definition.

**12. An obscuration is a ceiling, and its kind travels with its height.**
FAA AIM 7-1-29, on METAR sky condition: "the ceiling is the lowest broken or overcast layer, or vertical visibility into an obscuration." `OVX` — the decoded form of a `VVhhh` group — therefore joins `BKN` and `OVC` as a ceiling-bearing cover, and the lowest qualifying layer wins regardless of which of the three it is. Excluding `OVX` made an obscured sky report `ceiling_ft: null` beside a `flight_category` of `LIFR` and an `OVX` layer in `clouds[]`, so one response asserted three incompatible things.

An indefinite ceiling is not the same measurement as a broken layer at the same height — the AIM notes that "with the exception of indefinite ceilings, all automated ceiling heights are measured", and ATIS/AWOS phraseology says "INDEFINITE CEILING" for one and "CEILING" for the other. `ceiling_type` carries that distinction on both response surfaces, so no caller has to know that `OVX` is special or re-parse `raw_metar` to find out.

**METAR `vertVis` is in hundreds of feet, and TAF `vertVis` is in feet.** The AWC schema documents both as "Vertical visibility in feet"; only TAF matches. Every live METAR pairs `VV002` with `vertVis: 2` and a `clouds[].base` of 200, while the TAF for the same station and hour reports `vertVis: 200` with a null base. The METAR height is therefore derived from `clouds[].base_ft`, with `vertVis × 100` as the fallback for an obscuration AWC published with no base. No conversion may be shared between the two endpoints: the error is a factor of 100, and in the dangerous direction — reading METAR `vertVis` as feet turns a 200 ft indefinite ceiling into 2 ft.

**13. `content[]` may omit, but it may never assert or drop.**
`content[]` is prose for a reading model, not a serialization of `structuredContent`, so a line per null would bury the signal. Two rules bound that latitude, and the `format-parity` lint rule reaches neither — it synthesizes a sample where every leaf is populated, so it verifies a field renders *when it has a value* and is blind to what happens when it does not.

*Never state what the structured result does not support.* A null is not a named condition. An advisory with no stated altitude floor is not `SFC` (the hazard reaching the ground) and one with no stated top is not `UNL`; an advisory movement with no direction is not "stationary"; a METAR with no ceiling layer is not "Clear", since few and scattered layers can sit above a station that has no ceiling. Each of these renders as an explicit unreported state instead.

*Never drop a value the structured result carries.* Coordinates render at the resolution AWC published — no fixed decimal count in either direction, since `toFixed` truncated the 5-decimal station coordinates that make up most of the `stationinfo` feed and padded 1-decimal ones into false precision. The single shared renderer rounds at 6 decimal places (~0.11 m, finer than any AWC endpoint publishes) purely to collapse float representation artifacts such as K2S8's `47.75419998168945`. A hazard layer renders each bound it has, so a turbulence report giving only a base keeps that base rather than losing it to a range that cannot be drawn.

*Omission stays correct where absence is the norm and the surrounding text conveys it.* A gust group absent from 94% of observations, a PIREP `visibility_sm` absent from all of one 105-report sample, and METAR present weather absent from 82% of a 400-record sweep are all omitted rather than annotated. An identifier-less station renders no `**IDs:**` label at all — an empty label is itself a dropped-line defect, not a fix for one.

`aviation_get_taf` deliberately does not follow that rule for present weather, and the difference is not drift. Absence is the norm on both tools — 69% of forecast periods against 83% of observations — but a TAF renders a repeating per-period block, where a fixed line set is what lets a reader scan periods against each other; dropping the line from some periods and not others makes the blocks ragged. A METAR renders a single observation, where an omitted line costs nothing. Same principle, different rendering context.

**14. Present weather decodes group by group, and a group that does not resolve stays coded.**
A `wxString` is space-delimited and carries one or more groups. Reading the whole value as a single map key decoded at most the first group and left the rest as raw code — silently, whenever a leading `-`, `+`, or `VC` still rendered in English (`-SHRA BR` → "light SHRA BR", `VCTS -RA` → "in vicinity: TS -RA"). Each group is now read by its FAA AIM categories and the readings are joined with `; `. AIM 7-1-28 lists the codes — eight descriptors, and phenomena grouped as precipitation, obscuration, and other — which is also what retires the flat table's composite entries (`TSRA`, `SHRA`, `FZRA`) and covers the pairs it never listed (`SHRASN`, `TSRAGR`) without growing combinatorially.

Three placements the categories settle and a flat code table could not. *Intensity binds to the first precipitation type, not to the descriptor* — AIM 7-1-29 gives the group format as `Intensity/Proximity/Descriptor/Precipitation/Obstruction to visibility/Other` and states intensity "applies only to the first type of precipitation reported", so `-TSRA` is a thunderstorm with light rain and the string `light thunderstorm` cannot be produced. This was the larger share of wrong readings, outnumbering the undecoded set. *Proximity scopes one group*, so it renders as a per-group suffix: `VCTS -RA` is "thunderstorm in the vicinity; light rain", never a leading phrase claiming the rain is in the vicinity too. *`+FC` is a tornado or waterspout* — its own AIM phenomenon, where `+` is not an intensity and stripping it understates a tornado.

A group whose codes the tables do not cover is handed back verbatim as its own token. Rendering half of one — the qualifier in English while the phenomenon stays coded — is exactly what made the old failure invisible, so `light XX BR` is a shape the decoder cannot produce. That rule is only safe because `raw` is always alongside: `forecast_periods[].weather` therefore moved from a bare decoded string to the `{ raw, decoded }` pair METAR already carried, a breaking output change. Without `raw` a TAF consumer had no recourse when a group did not resolve.

**15. A forecast obscuration is a cloud layer, and the `OVX` layer — not `vertVis` — is what says the period has one.**
The TAF endpoint publishes an obscuration as `{ cover: 'OVX', base: null }` and holds the height in the period's `vertVis`, so filtering baseless layers discarded the layer before the height was ever consulted: a period forecasting `1/4SM FG VV002` returned `clouds: []`, which `format()` rendered as `**Clouds:** Clear` — the opposite of the forecast, and the same defect class decision 12 fixed on the observation side. The layer now takes its base from `vertVis`, which keeps `base_ft` a plain number instead of widening every cloud layer to nullable for one case, and makes one `VV002` group read identically across both tools. `vertical_visibility_ft` names the height beside it for the reason `ceiling_type` earned its place on METAR: no caller should need to know `OVX` is special to find it. No forecast `ceiling_ft` follows — per-period ceiling semantics for `TEMPO` and `PROB` groups are a separate question.

*The unit split governs the whole thing.* TAF `vertVis` is in feet (`VV002` → `200`); METAR's is in hundreds (`VV002` → `2`). `verticalVisibilityFeet()` is METAR-only and must never reach the forecast path — applying it there reports a 200 ft indefinite ceiling as 20,000 ft, overstating clearance by two orders of magnitude. Every height check is an explicit null check, because `VV000` is a real group and the most hazardous value the field holds; a truthiness guard drops exactly that case.

*Gating on the layer rather than the field is what keeps the fix honest.* Upstream repeats `vertVis` onto a later `BECMG` group that carries no `VV` group of its own — live `CYXU`: `3/8SM FG VV001 BECMG 1312/1314 P6SM NSW SKC` arrives with `vertVis: 100` on the `BECMG` period beside an `SKC` layer. Reading the field alone would publish a 100 ft indefinite ceiling under a sky-clear forecast, asserting the very thing this decision exists to stop.

**16. Forecast wind shear is one nullable object, and every field name understates what it holds.**
`WShwshwshws/dddffKT` was dropped entirely, recoverable only by re-parsing `raw_taf` — the parsing this tool exists to do — even though NWSI 10-813 §B2.8 confines the group to the surface–2,000 ft AGL band precisely because that band leaves little room to recover. Upstream populates `wshearHgt`/`wshearDir`/`wshearSpd` together or leaves all three null, so one nullable object beats three nullable scalars, which would admit seven states upstream never produces and force a caller to read all three to learn whether shear was forecast at all. Both values arrive converted — `WS020` reaches the endpoint as `2000` — and the datum is AGL: sampled shear stations sit at 643–1,270 ft MSL and every one reports exactly `2000`, so nothing is scaled or offset.

Two semantics the field names cannot carry, which the descriptions must. `height_ft` is the **top** of the shear layer, not its base or thickness. `speed_kt` is the forecast wind speed **at** that height, not the magnitude of the shear — a reader who takes `speed_kt: 40` as "40 kt of shear" has read a wind velocity as a vector difference, and that is the row that misleads on a safety field. A null is narrower than it looks, too: it means no non-convective LLWS group was issued for that period and nothing more, since the group is excluded from `TEMPO` and `PROB` groups and shear is always assumed present in convective activity. Nothing is propagated forward from an `FM` group that carried shear — upstream attaches the fields only to the period whose text held the group, and copying them onward would publish a forecast the issuing office did not write.

**17. A batch response states its own completeness, through `enrichment` rather than `output`.**
`aviation_get_metar` and `aviation_get_taf` take a batch of station IDs and return only the stations that produced data; upstream omits a missing row with no marker at all. A departure/destination/alternate check that got two stations back could not tell which leg was missing, or that anything was — and the stations most likely to drop out are the small fields that report intermittently, so the gap was widest where a caller was least able to notice it. Completeness is now affirmative in both directions: `partial: false` distinguishes a complete result from a short one, which a bare count never could. Reconciliation counts distinct station IDs, not rows, since `hours > 1` returns a row per observation.

This lives in `enrichment`, not `output`: it is agent-facing context about the request rather than weather data, and the block reaches `structuredContent` and a `content[]` trailer without pulling `format()` parity work along with it. The error path is unchanged and stays the contract for a total miss — error when nothing matched, enrichment when some matched and some did not.

*One missing state, not several.* A station can go missing because the ID is unknown, because it issues no such product, or because it reported nothing inside the lookback, and the weather response cannot tell them apart — AWC omits the row identically in all three cases. Resolving them would take a second `/stationinfo` request per call and still fail, because a registered station with no recent observation is listed as fully capable. So `missing` is flat and the notice names the candidate causes without asserting one, which is the same rule that keeps normalization from fabricating facts out of absent upstream data.

**18. A capped result says so; it does not quietly reassemble itself.**
Every AWC endpoint serves at most 400 rows and the OpenAPI schema neither paginates nor mentions the limit, so a cut page is indistinguishable from a complete one. `aviation_find_stations` and `aviation_get_pireps` are the two tools whose inputs can reach that ceiling, and both then filter client-side — on `state` and on altitude — so a cut page is narrowed again before the caller sees it. A `state: "TX"` query returns 279 stations against a cap of 400, which reads as headroom while a bbox tiling of the same area reaches 298; an altitude band can come back empty because the reports that matched it sat in the part of the window the cap dropped.

The disclosure is the fix, not recovery. Narrowing provably converges — the same query against the same upstream state returns a byte-identical page, and each partition of a capped query is a strict superset of what the capped call held — but only the caller can pace the follow-ups. Partitioning inside a single tool call would issue 5 requests for one state and an unbounded number for a global box, against AWC's published guidance of no more than one request per minute per thread. The cache datasets are complete but a different architecture: a gzipped bulk download with its own refresh semantics and formats the normalizers do not read. Both are out of scope here; the caller who is told the result is capped can finish the job with the levers the tool names.

Detection is `drawn rows >= 400`, read before any client-side filter — the returned count cannot carry it, which is why `fetchStations` hands its pre-filter draw size back to the handler. A genuine 400-row complete result is reported as capped. That false positive over-warns in the safe direction: the caller narrows a query that did not need it, rather than trusting a page that was cut.

The two tools' empty-result errors are deliberately asymmetric. `no_pireps_found` distinguishes a capped page, because an altitude band selecting nothing out of a cut window is ordinary and the old message reported that page's size as an area-wide count. `station_not_found` carries no such branch: reaching it from a capped draw needs a state whose bbox fills all 400 rows without one of the state's own stations among them, and a sweep of all 51 boxes finds Texas the only one that caps at all, keeping 279. Adding the branch would guard a state that cannot occur — leave it out rather than restoring it for symmetry.

**19. A PIREP flight level is trusted only where the raw group corroborates it, and the narrowing AWC can express is sent upstream.**
Two changes on the same premise: upstream's free-text fields are read for what they can actually establish, and the query is narrowed where the narrowing still counts.

*The zero sentinel is settled by a round-trip, not a token list.* Decision 10 established the raw `/FL…/` group as the discriminator and enumerated the three tokens sampling had found. The enumeration cannot hold — the field is pilot-entered free text, and a 1,236-report live corpus carries call signs (`/FLB78X/`), station identifiers (`/FLKGRR/`), aircraft types (`/FLP28A/`), transpositions (`/FLDRD/`), and cloud groups (`/FLBKN0/`), none of them in the list and all resolving to `fltLvl: 0`. A shape test of "not digits and not `SFC`" does not hold either, and fails in both directions. It misses `/FL2130/`, `/FL1000/`, `/FL4000/`, and `/FL0303/` — all digits, all resolving to `fltLvl: 0`, four of them against six non-numeric cases in the same corpus, so the numeric failure is comparably common rather than a corner. And it destroys `/FL030-000/`, which is neither digits nor `SFC` and which AWC parsed correctly to the midpoint `fltLvl: 15`.

What separates the two is whether the group round-trips: a group AWC read produces the value it names, so a `fltLvl` of 0 is a reading only where the group is a zero-valued digit string. The test is therefore scoped to `fltLvl === 0` and cannot touch a report with any other altitude, which is what keeps `/FL030-000/` intact. `/FLSFC/` stays excluded on its own terms — the substituted field elevation is a real altitude, and it is genuinely 0 at a sea-level field. A report with no `/FL` group at all (an AIREP encodes `F370` instead) has nothing to contradict its value and keeps it.

*Altitude and intensity are pushed to AWC.* Both filters previously ran on the page the 400-row cap had already cut, so they could only subtract from what survived truncation. `/pirep` declares `level` and `inten`, and filtering before the cap changes which reports exist to filter: a CONUS box at `age=12` returns a capped 400 rows holding 41 reports in the FL160–220 band, where the same query with `level=190` returns 217 rows — uncapped — with 199 in that band.

`level` is not a range. AWC documents it as "Level +-3000' to search", and `level=190` draws exactly FL160–220 against the live endpoint, so it does not map onto `altitude_min_ft`/`altitude_max_ft`. It composes with them instead: where a centre exists whose upstream band contains the requested one, the existing client-side filter trims that superset to the exact range. Exposing `level` directly was rejected — it would give the tool two ways to say one thing, and the upstream band width is an implementation detail of how the request is built rather than a contract the caller should learn. The client-side filter still runs after the upstream one, which is also what keeps the `fltLvl: 0` reports `level` admits out of a bounded result.

Fitting the 6,000 ft width is necessary but not sufficient, because the centre is a whole flight level. Rounding shifts the band by up to 50 ft, so a near-full-width request can be left with a sliver outside what gets drawn: 17,950–23,950 ft rounds to `level=210`, which draws FL180–240 and misses the bottom 50 ft. Reports in a sliver go undrawn rather than trimmed, which is a silent loss rather than a filter — so the centre is computed and then checked, and a band that does not contain both bounds is not pushed at all. That containment check is the whole test: a band wider than 6,000 ft has no centre that holds it and fails the same check, so there is no separate width guard beside it. A wider band, a single bound, and a sliver all behave exactly as before.

`inten` has no existing input to compose with, so `min_intensity` is a new one. It selects **reports**, not layers: a live `inten=mod` draw returns reports whose layers include `NEG` and `SEV` alongside the `MOD` that matched, so the description says so — a caller reading it as a layer filter would see a `NEG` layer in a moderate-turbulence result and conclude the tool is broken.

Neither parameter changes what the cap disclosure means. They narrow what AWC draws, so the drawn row count decision 18 reads is still AWC's own page size, and `truncated` still reports that page rather than a post-filter count.

**20. A synthesized icing layer is dropped rather than repaired, and the test is per layer.**
AWC's decoder adds an icing layer to reports whose text never mentioned ice — `NEGclr`, an empty type, and bounds borrowed from elsewhere in the same record. A live `BNA UA /OV BNA/TM 2134/FL330/TP B763/SK SKC/TB NEG/RM ZME62` carries no `/IC` group at all yet arrives with icing bounds of `330`/`600`, which are its own `SK SKC` cloud layer — so normalization published a reported icing layer spanning 33,000–60,000 ft for a report that never mentioned ice. That is worse than an empty result: the empty array already means "the pilot said nothing either way", and a synthesized default contradicts it on a safety-relevant field where clear and rime ice are handled differently.

*The concatenation is the marker, and dropping is the only honest response to it.* Across a 1,900-report corpus every `icgInt` value is either a clean code — `NEG` 122, `LGT` 79, `MOD` 13, `TRC` 5, `LGT-MOD` 4 — or the concatenated `NEGclr`, 126 of them. Stripping the suffix and keeping the layer is the tempting repair and it is the wrong one: the suffix is the layer's *only* tell, so a stripped layer publishes borrowed bounds as `NEG (24,000–60,000 ft)`, indistinguishable from a pilot's observation, where the raw form at least announced itself as odd. Removing the sole disclosure a bad row carries is a regression even when the row was already bad. Dropping is also the safe direction under decision 13: an omitted negative report costs the caller a "no ice reported", while a kept synthetic one asserts an altitude band nobody flew.

*The test is per layer, not per report.* Every concatenation in the corpus sits in the second slot — `icgInt1` is a clean code in all 223 of its occurrences — and 18 of them ride on reports whose first slot is a genuine reading, so a report-level test publishes the synthetic layer beside the real one. One report carries a concatenated second layer as its *only* icing (`TIX … /IC +8C`, an undecodable stray temperature), where a report-level test would publish a wholly invented negative report.

*One mechanism, not two.* A raw-text `/IC`-group gate was the first shape of this fix and earns no place beside the per-layer test: every layer on a report carrying no icing group is concatenated, 108 of 108, so the gate catches a strict subset of the same 126 and would never fire on anything the layer test missed. Two mechanisms guarding one concern is maintenance cost with no coverage behind it.

Two-part ranges carry no trailing lowercase run and are preserved unsplit, matching turbulence. Genuine second layers exist and survive — a live `icgInt2` of `LGT`/`MIXED` and one of `MOD`/`MIXED`, both clean codes.

Turbulence is untouched. Its intensities were clean codes across the same corpus, and its bounds keep a zero: `tbBas1: 0` occurs on reports whose raw range reads `030-SFC` or `SFC-060` — a genuine surface-based chop layer — so mirroring the cloud-layer zero-as-unknown rule onto it would fabricate an unknown out of a correct reading. The one class of zero icing bound observed (`icgBas2: 0`) sits entirely on synthesized layers and disappears with the rule above, so no separate zero rule is needed for icing either.

**21. An empty cloud array is not a sky condition, and the condition is read off the record rather than the raw text.**
AWC encodes no cloud layer for any sky-condition group that carries no height, so a clear report, an obscuration whose vertical visibility the station could not determine, and a report that stated no sky condition at all arrive as the same empty array. 585 of 1,849 distinct METARs across 22 regional draws have one; 488 of those stated a condition and 97 stated nothing. Rendering all of them `Clear` asserted a sky state for the 97 and inverted the obscurations — the `VV///` records, reported IFR and LIFR, read as a clear sky.

*The discriminator is already a structured field.* The METAR record's own `cover` holds `CLR`/`SKC`/`CAVOK` on a clear report and `OVX` on a `VV///` obscuration, and the key is **absent from the JSON** — not null — when nothing was read. Two upstream states feed that absence and want the same answer: a station that sent no sky group (54 of the 97) and a sensor that sent a degraded `//////` (16). Nothing needs to be parsed out of `raw_metar`, which is what keeps this from re-deriving the decoding AWC already did. `cover` is not carried when layers exist: it restates them, and it does so inconsistently — 2 of 654 layered records disagree with the most-significant layer, both on a `CB` group.

*A `CLR` value reads wider than the AIM's definition.* AWC folds `NCD` and `NSC` into `CLR` — 88 of 591 — so the rendered reading stays at "clear or no significant cloud reported" rather than naming the AIM's 12,000 ft automated-station threshold, which 15% of the records would not support.

*The TAF side needed the same field for a different reason, and the two agree only where the products do.* A forecast period has no summary field, and the empty array there has two causes rather than three. The dominant one is an explicit clear-sky forecast: AWC publishes `SKC` or `NSC` as a cover with a null base, which `normalizeTafClouds` drops for having no height — 546 of the 723 live periods that normalize to no layers, spread across base, `FM`, `BECMG`, and `PROB` groups alike. The rest, 176 of them and all but one a `TEMPO` or `PROB` group, carried no cloud element at all, where the prevailing forecast's cloud stands unchanged and `Clear` invented a forecast nobody issued. So `sky_condition` on a period is the cover of the heightless layer, which upstream never pairs with a layer carrying a height (0 of 3,349 periods).

That split is what the two tools' wording follows. They state a reported clear sky identically — an `SKC` group renders `SKC (sky clear)` on both — because a clear-sky group carrying no layer height means the same thing in an observation and in a forecast. They diverge exactly where the causes diverge: a METAR with nothing reported says the observation carried no sky-condition group, while a `TEMPO`, `PROB`, or `BECMG` group with no cloud element says the prevailing forecast stands. Forcing one string onto both would have restored the original defect in a quieter form.

*The ceiling reading follows from the same field.* `ceiling_ft` is null both where no broken, overcast, or obscuration layer was reported and where a `VV///` obscuration gave no height, and `**Ceiling:** none` asserted the first for both — on records flagged IFR and LIFR, which is where the claim costs most. The two are separated by `sky_condition`, which is `OVX` exactly in the second case, so the undetermined obscuration now reads as not determinable and the numeric `VVhhh` records keep publishing their height with the indefinite qualifier they already had (5 of the 8 `OVX` records in the 1,849-record corpus, down to a surface-level `VV000` at 0 ft). `ceiling_type` is untouched and stays null exactly when `ceiling_ft` is — the pairing decision 12 established. Keying on `sky_condition` rather than on `raw_metar` also keeps the reading off a `VV` group inside a forecast clause: live `USTR … NSC … TEMPO 0300 FG VV002` reports no obscuration at all and correctly renders no ceiling.

**22. `aviation_find_stations` names the cause of a missing identifier, because here there is only one.**
Decision 17 kept the weather tools' `missing` flat and their notice cause-free: a station can drop out of a METAR or TAF batch three ways and the response cannot tell them apart. Neither ambiguating cause exists on `stationinfo`. The endpoint accepts only `ids`, `bbox`, and `format` — no lookback window a station can fall outside of — and it returns a registered station's row whatever products that station carries; `KAWO` comes back on its `siteType: ["METAR"]` entry regardless of whether it has reported anything. A 20-ID batch of 17 valid identifiers returns all 17, so batch position and size cost nothing either. One cause remains and it is assertable: the identifier did not resolve to a row in the AWC station registry.

*The claim stops at the registry.* `EGTF` (Fairoaks) and `LFOX` (Étampes) are real ICAO-identified aerodromes that answer HTTP 204, so absence from AWC's station list says nothing about whether the airport exists, and the notice says so. It also splits the two fixes, which is the part decision 17 could not afford: an identifier that is not four letters cannot reach the registry at all — `SEA` is Seattle-Tacoma's IATA code and resolves nothing even though KSEA's entry carries it — while an ICAO-shaped identifier the registry does not carry wants a `bbox` or `state` search instead. Both are decidable from what the handler already holds; the equivalent split on the weather tools would have cost a second upstream request and still failed.

*Reconciliation matches the registry's own `id`, and every other key is wrong.* Upstream reorders results alphabetically, so array position mismatches; it case-folds, so exact strings report `ksea` missing; it de-duplicates, so counts report a phantom gap; and 375 of 1,600 rows across four bbox draws carry null ICAO, IATA, and FAA identifiers, so `icao_id` reports an identifier-less station that did resolve. `id` is present on every row and equals `icaoId` wherever that is non-null (0 divergences in 1,600). The IATA and FAA aliases are deliberately not matched — doing so would resolve a requested `SEA` against KSEA's own alias and hide the exact miss the disclosure exists to name. `NormalizedStation` carries `id` for this and the output schema does not publish it, which keeps the `stations` payload unchanged; publishing it would also give the identifier-less rows something to be addressed by, and is left to its own change.

*The whole-batch miss stays an error.* When nothing resolves, AWC answers HTTP 204, the service maps it to an empty array, and `station_not_found` fires with its recovery hint before any reconciliation runs — as do `missing_search_criteria`, `conflicting_location`, `invalid_bbox`, and `invalid_state`, in their existing order.

**23. The advisory hazard is matched by AWC, and an empty result names the stage that emptied it.**
Two changes on one premise: the tool should not have to know how AWC spells a hazard, and a caller should not have to guess why nothing came back.

*The hazard filter moved upstream, which removes the comparison rather than tightening it.* The client-side test required the record's value to **contain** the caller's — `a.hazard.toUpperCase().includes(requested)` — so a shorter upstream token could not match a longer request, and `'TURB'.includes('TURBULENCE')` is `false`. On a hazard surface the resulting empty array reads as "this hazard is not active" rather than as a filter that could not match. The vocabulary that would settle it is not observable and not documented: `AirSigmetJSON.hazard` is a bare `type: string` with `CONVECTIVE` as its only example and no enum, and AWC does not use one convention across its own products — `ISigmetJSON` examples `hazard` as `TURB` while `GairmetJSON` examples it as `IFR`, so no sibling schema licenses an inference. Sampling cannot close it either: across twelve unfiltered draws over eight minutes, all 16 rows in every draw carried `CONVECTIVE` — 192 rows, 16 distinct `seriesId`s, no rotation — while `hazard=turb`, `=ice`, and `=ifr` answered HTTP 204 on all twelve.

`/airsigmet`'s own `hazard` parameter is what sidesteps it. Its schema enumerates `conv | turb | ice | ifr`, and the live endpoint honors them: `hazard=conv` returns exactly the rows the unfiltered draw returns (byte-identical, all twelve draws, since all 16 were convective), the other three return 204, and an unrecognized value returns `400 {"status":"error","error":"Invalid value for hazard"}`. AWC owns the mapping from its filter value to whatever spelling it stores, so the record vocabulary stops being load-bearing for correctness — it is now a documentation gap rather than a defect waiting on weather. **The mapping is a correctness requirement, and skipping it fails in two different directions.** Passing the tool's own enum through verbatim would be rejected for half its values and honored for the other half: `hazard=CONVECTIVE` and `hazard=TURBULENCE` answer 400, while `ICING` and `IFR` answer 204, matched case-insensitively against the documented `ifr` and the undocumented `icing`. So a wrong token in the first two rows is loud — a 400 the framework classifies `InvalidParams` from its status ladder — and a wrong token in the latter two is silent, reading as fair weather for as long as the typo lives. That asymmetry is the argument for the URL assertions in the service test: they are the only gate on the `ICING` and `IFR` rows, since the endpoint will not reject a mistake in either. The four values are mapped, and `isSigmetHazard` narrows the type so nothing else can reach the request. (The live endpoint also accepts three undocumented values — `icing`, `ts`, and `all` — all 204 or unfiltered. They are not used: the documented enum is the surface AWC commits to.)

*The bbox does not follow, and the split is not an inconsistency.* `/airsigmet` defines no bbox parameter (decision 6). Pushing the axis that has an upstream parameter and keeping the one that does not is the whole rule.

*The empty draw is disclosed by stage, decision 22's rule rather than decision 17's.* Decision 17 keeps the weather tools' missing state flat because AWC omits a batch row identically for three causes and separating them would cost a second request and still fail. Decision 22 names a cause on `aviation_find_stations` because exactly one remains and it is assertable. This tool sits between them: an empty result has more than one nameable state, and the two counts that separate them are already in hand — the drawn row count, reported through `onPreFilterRows` the way `fetchStations` reports its own, and the length after the bbox overlap test. A draw of zero was emptied before the bbox ran, so the box is never blamed for one; a non-empty draw returning nothing was emptied by the box alone, and the notice states the drawn count, which is the same count decision 18 reads for cap detection and never the returned one. The count is reported only once a readable array is in hand, so its absence is not a draw of zero — it is no draw at all, the shape a malformed upstream body produces. Nothing is asserted there: an unobserved sky has no stage to name, and defaulting the missing count to zero would have manufactured the fair-weather claim out of silence.

*One boundary the upstream move created, and the notice stays inside it.* AWC answers the same HTTP 204 for a hazard class with nothing active and for a feed with nothing active at all. Once the hazard is applied upstream, one draw cannot tell those apart. The shape #33 was written against — the hazard narrowing a full draw client-side, with the pre-hazard count free — no longer exists. So the hazard branch asserts only what it can: no active domestic SIGMET carries the requested class, and this result says nothing about the others. It does not claim advisories are active elsewhere. Resolving that would take a second, unfiltered draw on every hazard-scoped empty result, against AWC's published guidance of no more than one request per minute per thread, to sharpen a message whose recovery ("drop the hazard filter") is identical either way. The bbox branch has no such limit and does state its count, since the draw it describes was actually served.

**24. A caller's `limit` is a third number, and it is disclosed apart from the row cap.**
Every parameter on `aviation_get_pireps` and `aviation_find_stations` before this one changes *what is searched*, so the only way to spend fewer tokens was to ask a different question — a smaller box discards the corridor the caller asked about in order to see more of a corner of it. `limit` bounds the response instead, leaving the query identical. A live `state: "CA"` draw held 270 stations and was not capped, so no existing disclosure fires and nothing narrows without changing the question.

*The two tools share one vocabulary, because they are one mechanism.* Input `limit`; enrichment `limited` and `matched`; the same wording for what each says. A caller who learns the concept on one tool recognizes it on the other, and the alternative — a per-tool spelling — makes two lessons out of one.

*A result can now be short for two independent reasons, and conflating them costs the caller a query.* Decision 18's `truncated` says AWC stopped at 400 rows and the rest were never drawn; `limited` says every matching row *was* examined and the caller asked to see fewer. Read as a cap, a limit sends the caller off to narrow a search that had no need of it. They co-occur — a CONUS PIREP box at `hours=12` caps at 400 and can still be limited to 10 — and the three counts are then all different: 400 drawn, however many survived the client-side filter, and the number returned. `matched` is the middle one and is scoped to what it was counted from, saying "inside the capped page" when the capped page is what it counted; the rows the cap dropped were never examined, so no count can include them. The framework's `ctx.enrich.total()` was rejected for exactly this: it writes `totalCount` and renders "N total", which asserts an area-wide total on a page that is a slice of the area.

*One `notice` carries both, in turn.* `ctx.enrich.truncated()` writes `notice` last-wins, so the two disclosures compose into one string rather than overwriting each other — the cap states its own case and its lever, then the limit states that it is not the cap.

*`limited` is emitted only when a limit was supplied.* Decision 17's affirmative-completeness rule earns its place where a count cannot establish the fact; here a caller who set no limit already knows none applied, and `truncated: false` already affirms the draw was whole. Emitting it unconditionally would also add a field to every existing caller's response, which this addition should not do. A caller who *did* set one is owed the affirmative: `limited: false` separates a limit that withheld nothing from one that bit.

*A call that sets no limit gains no field and loses none, and its rows arrive in the order they were drawn; two capped-result sentences were reworded.* The limit changes no value on a call that did not set one, and no row moves. What did change is prose in `notice` on two shapes: a capped `state` result on `aviation_find_stations`, and a capped result on `aviation_get_pireps` that the altitude filter then narrowed. Both previously read "the N shown are what survived the filter", and `shown` now means the count after the limit as well — so beside a limit that sentence would attribute the whole reduction to the filter. They now state the post-filter count in its own right. The numbers are the same ones as before; only the sentences carrying them differ.

**25. What a limit omits is answered with a lever, not with a summary of the omissions.**
Returning fewer PIREPs discards a severity signal a pilot is asking about, and the tempting fix is to summarize what was dropped — a count, an altitude span, the highest intensity present. The count is kept (`matched`). The severity summary is not, and the reason is that this tool deliberately does not rank intensities. `min_intensity` is pushed to AWC's `inten` precisely so AWC does the matching against its own vocabulary (decision 19), and `icgInt`/`tbInt` are open free-text-derived codes — `NEG`, `TRC`, `LGT`, `LGT-MOD`, `MOD`, `SEV`, plus two-part ranges. Deriving "the highest intensity omitted" would introduce a second, client-side ranking of that vocabulary, unvalidated and in a tool whose whole intensity story is that it does not own one. On a capped page the summary would also describe the page rather than the area, which is the conflation decision 24 exists to prevent.

So the notice names the lever instead: a limit selects by recency alone, and `min_intensity` makes AWC narrow to the severe reports *before* it applies. That answers the pilot's question with reports rather than with an adjective, and it composes — the two parameters together return the most recent severe reports, bounded.

`aviation_find_stations` has no severity analogue and needs none.

**26. A limited station list is ordered by published identifier, and the identifier mode needs no limit.**
PIREPs are already ordered by observation time descending, so a limit there means "the most recent" and inherits its meaning. Stations carry no natural rank: without a defined order the same query returns a different subset each call, and reproducibility is the property that makes a limit usable at all. The order is `icao_id` ascending, rows carrying no `icao_id` last, ties broken by the registry `id` ascending — both compared by code unit rather than by locale, so the order cannot move with the runtime's collation.

*Reproducibility is necessary and was not sufficient.* Ordering on `id` alone is perfectly deterministic and was the first shape of this decision; it made the first page useless on the exact query the feature was built for. A live `state: "CA"` draw holds 270 rows, 49 of them identifier-less NDBC sites, and the numeric ids many of those carry (`46114`, `46214`, …) sort ahead of every `K***` airport, so `{"state":"CA","limit":10}` returned ten buoys with no identifier and no data products and zero airports — nothing a caller can hand to `aviation_get_metar`. Leading on `icao_id` returns `K18C, K1O2, K1O5, K2O1, K3A6, K4SU, K6L9, K87Q, K97Q, K99Q` for the same query, with `TIBC1`, `TIXC1`, and `UPBC1` at the tail. The identifier-less rows are not dropped, only moved: a caller who wants them raises the limit or pages past the airports.

*`id` stays as the tiebreak because it is the only total key.* `icao_id` is null across those 49 rows and cannot separate them, while `id` is unique and present on every row — the same properties that make it decision 22's reconciliation key.

*What the caller can and cannot verify.* `icao_id` is published, so the primary ordering is legible in the payload. The tiebreak is not: decision 22 deliberately keeps `id` out of the output, so wherever it is the operative key — between two identifier-less rows — the caller cannot see the order they were served, only that it is stable across calls. That is a real limitation of this ordering rather than a gap to paper over; publishing `id` would change the `stations` payload and belongs to its own change.

*The sort runs only when a limit was supplied.* Omitting `limit` returns the draw exactly as it arrives, so no existing caller's ordering moves. Upstream sometimes serves `stationinfo` in that order anyway — `ids=KSEA,KJFK` comes back KJFK first — so the sort can be a near-no-op, but one probe is not a contract, and the buoy case above is precisely where upstream's own order and a useful one diverge.

*`limit` alongside `station_ids` is rejected, not ignored.* The caller has already named the set, and #31's reconciliation covers the gap between what was asked for and what came back. Rejecting follows decision 9's rule for `distance_nm` on a bbox search: a silently inert parameter is one the caller never learns did nothing. It is also what keeps the shared `notice` unambiguous — the reconciliation writes a notice of its own, and with the modes disjoint the two can never overwrite each other.

**27. Whitespace around an identifier is trimmed, and the rejection carries no shape.**
`ids=KSEA ,KJFK` answers HTTP 400 with `{"status":"error","error":"Must specify station IDs or bounding box, zoom, and density"}`, so one stray space cost the batch every station it could have resolved — verified live against `stationinfo`, where the trimmed form of the same request returns both rows. Padding is not a spelling and not a caller error worth failing a batch over. It is trimmed once at the top of the handler, so the outgoing query, the reconciliation, and the disclosure all read the same value and no invisible padding travels into `requested` as something the caller "wrote". Trimming before the deduplication also collapses `KSEA` and `KSEA ` onto one identifier rather than reporting a phantom repeat.

*An empty or whitespace-only entry is rejected at the schema, and nothing else is.* The regex is `/\S/` — has at least one non-whitespace character — which names `station_ids` in its message and lands the issue at the entry's own path. The four-letter ICAO pattern the weather tools use must not be borrowed here: the registry legitimately carries buoys and mesonet sites whose rows have no ICAO, IATA, or FAA identifier at all and are addressable only by a registry `id` of another shape, so a pattern would reject a working search rather than catch a mistake. This is the recovery path `aviation_get_metar` and `aviation_get_taf` point callers at, so narrowing it defeats the disclosure those hints exist to provide.

**28. An upstream rejection is re-raised as a declared reason, and the endpoint and body stay in the logs.**
Where AWC still rejects a request the framework's status ladder classifies the 400 as `InvalidParams` and annotates it with the redacted endpoint in the message and the upstream response body in `data`. The query string is redacted before it reaches the client, so the identifiers themselves do not escape — but the origin, the path, and AWC's own error text do, and none of them says what the caller should change. The handler re-raises that one classification as `upstream_rejected` with the contract's recovery hint, threading the original through as `cause` so the upstream detail stays in the logs and out of the payload.

*Only that one code is converted.* A 5xx is still `ServiceUnavailable`, a timeout still `Timeout`, an abandoned request still `RequestCancelled`; reading any of them as malformed input would tell a caller to fix an input that was fine. The narrow catch is also why this does not contradict the handlers-throw rule — nothing is swallowed, and one classification is translated because the framework's generic one leaks upstream internals on a public surface.

*The hint is branched on the search mode, because the classification is not.* Every rejection out of `fetchStations` converts, whichever mode built the query, so a single `station_ids`-shaped hint would advise a `bbox` or `state` caller about entries and embedded spaces in a parameter they never sent. The three modes get three hints: split a combined `station_ids` entry; retry a refused `bbox` smaller or name the stations directly; and, for `state`, that the state code is not what needs changing at all, since the tool builds that box itself from its own table. No valid input reaches the non-identifier branches today — the schema bounds the bbox and the state box is table-generated — so this is about not shipping a hint that would mislead if upstream ever changed under it. The contract entry keeps the mode-agnostic wording, which is what a client reading the catalog before a call can act on; the throw site overrides it with the specific one.

*The 200-with-error-body path is not in scope and is left as it is.* `fetchJson` has a branch for AWC answering HTTP 200 with `{"status":"error", …}`, which passes that text through as a `ServiceUnavailable` message. It is unreachable for the failure recorded here — AWC pairs its error body with a 400, so the fetch throws first — and it is shared by all five tools, so tightening it belongs to a change that considers all of them.

**29. A lookup matches the registry's own identifier, and only one wrong shape is diagnosable.**
The tool advertised that station IDs "must be 4-letter ICAO format" and that "the upstream API only accepts ICAO format." Both are false, and decision 27 had already committed to the opposite by imposing no shape at the schema. `stationinfo?ids=NUET2` (a mesonet site) and `ids=46114` (an NDBC buoy) each return their row; what the lookup matches is the registry's own `id`, which for an airport happens to be its ICAO identifier and for other sites is whatever that site carries. The description, the field description, the `station_not_found` recovery hint, and the README now say that instead. Nothing about the schema or the request changed — the tool was describing itself wrongly, on the exact field this batch reworked, while the same release documented the opposite.

*The unresolved-identifier guidance splits on IATA, not on length.* It used to divide the missing identifiers into ICAO-shaped and everything else, telling the second group their format was wrong. Under a registry-`id` match that is a misdiagnosis: an unresolved four-character identifier and an unresolved five-character one are both simply absent, and `ids=46999` answers the same HTTP 204 as an unlisted ICAO identifier, so shape was never the discriminator. One shape is still worth naming on its own — a 3-letter IATA code never resolves, even for a station whose entry lists one — so that case keeps its own line and everything else is reported as absent from the registry.

*This is the ordering change's consequence, which is why it lands here rather than later.* Decision 26 moved identifier-less sites into the visible tail of a limited result. A caller who meets a buoy there and tries to look it up by the identifier they were shown was, until this change, told by the tool's own description that only ICAO identifiers resolve.

**30. Flight context is optional, and an absent one is named in the briefing rather than refused at the schema.**
`departure_time`, `cruise_altitude`, and `route_waypoints` are the flight context decision 7 describes. All three are optional, and requiring them was rejected: the prompt's three existing args are the only ones any current call sends, so a required field fails every one of them, and it buys nothing the optional form does not. The synthesis step already reports what it could not assess — a missing departure time or cruise altitude is exactly such a gap, and a schema rejection tells the caller strictly less than a briefing that names it.

*Absence is disclosed twice, at the step and in the summary.* The step that would have used the argument says so where the instruction would have gone — the TAF step states no forecast period can be tied to a flight window, the PIREP step that the search cannot be bounded to a cruise level, the advisories step that they cannot be bounded to a route corridor — and each also appears under **Gaps and uncertainty** in the summary, beside the standing instruction to report any station that returned no data and anything the tools flagged as partial, truncated, or limited. The step line is where the model is deciding what to call; the summary line is what the reader ends up holding. One without the other loses half the disclosure.

*The identifier regex is a tightening, and it is the one behavior change an existing call can notice.* `departure_icao` and `destination_icao` were bare `z.string()` with no shape at all, and `alternates` was an unvalidated comma list — so the prompt accepted `sea` and `` `` and generated a briefing that instructed calls the weather tools then rejected. All three now carry `[A-Z]{4}`, matching what `aviation_get_metar` and `aviation_get_taf` already enforce on the same values. `aviation_find_stations` deliberately does *not* get this pattern (decision 27), and the difference is real rather than an inconsistency: that tool matches the registry's own `id`, which for a buoy or a mesonet site is not four letters.

*The PIREP band is ±3,000 ft because that is the width AWC searches.* Decision 19 established that `/pirep`'s `level` parameter is a centre with a fixed ±3,000 ft band and that `aviation_get_pireps` pushes the bounds upstream only when a centre exists whose band contains them. A band derived as cruise ±3,000 ft is exactly that shape, so the briefing's own instruction is one the tool can push — which matters because pushing it is what keeps the query off the 400-row cap. Any other half-width would have produced a band the tool has to filter client-side out of a possibly-cut page. The floor is clamped at 0 rather than going negative; below 3,000 ft cruise that makes the band asymmetric and no longer pushable, which is the correct trade against printing `altitude_min_ft: -1500` into a briefing.

*A route waypoint is a coordinate, and it reaches the briefing as a bbox or not at all.* Nothing in this server geocodes and `aviation_find_stations` has no lat/lon-plus-radius input (decision 3), so `route_waypoints` takes decimal-degree pairs only — no place names, no identifiers — and the generated text turns them into an `aviation_get_advisories` bbox. A separate bbox argument was rejected as a second way to say one thing: the bbox is the waypoints' envelope, so two corner waypoints express one directly, and one argument leaves no precedence rule to invent. The envelope is widened by 1° per side, because KSEA→KJFK is within half a degree of latitude end to end and a bare envelope of two such points is a sliver no advisory polygon intersects — the margin is what makes the box a corridor rather than a line, and the text says so and tells the reader to widen it further for a route that leaves the box. The margin is also the only thing that can overflow a valid coordinate: waypoints are range-checked at the schema, so the clamp to ±90/±180 exists for a route near a pole or the antimeridian and never to quietly repair a bad input.

*The station list is chunked to each tool's own limit, because the default route already exceeds one.* `aviation_get_metar` bounds `station_ids` to 10 and `aviation_get_taf` to 4, while `alternates` is unbounded — so departure, destination, and three alternates is five stations and an unchunked instruction walks the model into a schema rejection partway through a brief. The instruction splits into as many calls as the bound requires and states the bound when it does; at or under the limit the single-call wording is unchanged.

*Nothing about the departure time reaches a tool.* No endpoint here takes a time parameter, so alignment is guidance in the generated text: select the `forecast_periods[]` entry whose `from`/`to` window covers the departure time from what `aviation_get_taf` already returned. The argument's ISO 8601 UTC shape is the shape those fields are published in, so a period boundary can be pasted back in verbatim. A UTC offset is rejected rather than converted — aviation time is Zulu, and silently reinterpreting an offset is how a briefing ends up read against the wrong period.

---

## Known Limitations

- **Coverage:** METAR/TAF are global; PIREPs and SIGMETs are US-centric (AWC is a US NWS product).
- **Recency:** METARs are typically 20–60 min old. TAFs are 6–30 hour forecasts. PIREPs are real-time but sparse. Advisory set reflects only currently active products.
- **No historical archive:** The API serves recent observations only (`hours` parameter up to 12 for METAR). No multi-day historical queries.
- **400-row result cap:** Every endpoint returns at most 400 entries and offers no pagination surface. `aviation_find_stations` (bbox and state modes) and `aviation_get_pireps` can reach it; both disclose a capped result and name the levers that narrow the query before the cap applies. `aviation_get_pireps` also pushes `min_intensity` and, where the requested band fits the upstream ±3,000 ft width, the altitude bounds — so those queries reach the cap less often to begin with (decision 19). The other three tools' input limits keep them well below it. See decision 18.
- **A `limit` bounds the response, never the search:** `limit` on those same two tools caps how many rows come back without changing what was searched, and says so separately from the cap — a limited result examined every row it counted, while a capped one never drew the rest (decision 24). On `aviation_find_stations` the order is `icao_id` ascending with identifier-less rows last, so an area sample leads with airports (decision 26). It is not pagination: there is no offset or cursor, because the endpoints expose none, so the rows a limit withholds are reachable only by raising or dropping it. What a limit omits is not summarized; on `aviation_get_pireps`, `min_intensity` is the lever that makes a bounded result the severe reports rather than merely the most recent (decision 25).
- **Not an official briefing:** This data does not constitute a regulatory-compliant preflight weather briefing. Pilots flying IFR or in controlled airspace must use an authorized source.
- **AIRSIGMET scope:** The endpoint serves domestic SIGMETs only and cannot return an AIRMET, so `aviation_get_advisories` rejects an AIRMET request rather than answering it (see decision 2); G-AIRMET and textual AIRMET support is tracked in #29. During fair-weather periods no SIGMETs may be active — absence of results is a valid state, not an error, and the notice on an empty result names what emptied it (decision 23).
- **The record's hazard vocabulary for a non-convective domestic SIGMET is unobserved:** `hazard=turb`, `=ice`, and `=ifr` have answered HTTP 204 on every check, so no such row has been available to read, and AWC's schema declares the field a bare string with no enum. Nothing depends on it — the hazard filter is applied by AWC (decision 23) — so this is a documentation gap rather than a limit on what the tool can answer.
- **An empty cloud array carries no sky condition on its own:** AWC encodes no layer for a group with no height, so a `CLR` report, a `VV///` obscuration, and a report that stated no sky condition all arrive as `clouds: []`. `sky_condition` separates them on both response surfaces, and an empty array beside a null reads as unreported rather than clear (decision 21). What stays unavailable is the sky above a station that reported none — no field recovers it, and neither response surface claims otherwise.

---

## API Reference

**Base URL:** `https://aviationweather.gov/api/data`

**Common parameters:**
- `format=json` — required for JSON responses (default is plain text)
- `ids=KSEA,KJFK` — comma-separated ICAO IDs for station-keyed endpoints
- `hours=N` — lookback window for `metar` and `taf` (METAR: 1–12 typical)
- `age=N` — lookback window ("Hours Back") for `pirep`; that endpoint has no `hours` parameter and silently ignores one
- `distance=N` — radius in nautical miles around the `id` center point for PIREP searches; ignored when the search is a bbox
- `level=N` — for `pirep`, a flight-level centre searched with a fixed ±3,000 ft band ("Level +-3000' to search"), not a range: `level=190` returns FL160–220. Applies in both the radial and bbox modes, and admits reports whose flight level did not parse
- `inten=lgt|mod|sev` — for `pirep`, minimum hazard intensity. Selects whole reports carrying at least one turbulence or icing layer at that intensity or above, so a matching report still carries its lighter layers
- `hazard=conv|turb|ice|ifr` — for `airsigmet`, the hazard class. Values are matched case-insensitively; an unrecognized one returns HTTP 400 rather than being dropped, and a recognized one with nothing active returns 204. The tool's own spellings do not substitute: `CONVECTIVE` and `TURBULENCE` return 400, while `ICING` and `IFR` case-fold onto the undocumented `icing` and the documented `ifr` and return 204 — so the mapping in decision 23 is what keeps every outgoing value one this list accepts. `/airsigmet` defines no bbox parameter

**Every endpoint returns at most 400 entries.** The limit is stated under Restrictions in the API documentation, alongside a request-pacing guideline of no more than 1 request/min per thread. The OpenAPI schema declares no `page`, `offset`, `limit`, or cursor parameter on any endpoint and does not mention the cap, so a client parsing the schema cannot learn the limit exists — a capped page is detectable only by counting the rows returned. `stationinfo` accepts only `ids`, `bbox`, and `format`, which leaves a smaller bounding box as its single narrowing lever.

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
