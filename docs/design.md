# aviation-weather-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `aviation_get_metar` | Current weather observations for one or more airports. Returns decoded fields (wind direction/speed/gusts, visibility, ceiling and its kind, present weather, temp/dewpoint, altimeter, cloud layers) plus the computed flight category (VFR/MVFR/IFR/LIFR) and the raw METAR string. Accepts 1–10 ICAO station IDs. | `station_ids: string[]`, `hours?: number (1–12, default 1)` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_get_taf` | Terminal Aerodrome Forecast for one or more airports. Returns each forecast period with valid times, wind, visibility, decoded weather, and cloud layers, plus the raw TAF string. Accepts 1–4 ICAO station IDs. | `station_ids: string[]` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_get_pireps` | Recent Pilot Reports near an airport or within a bounding box. Returns decoded turbulence/icing/cloud reports with altitude, aircraft type, intensity, and the raw pirep string. | `station_id?: string`, `bbox?: {minLat, minLon, maxLat, maxLon}`, `distance_nm?: number (station_id only, 100 when omitted)`, `hours?: number (1–12, default 3)` | `readOnlyHint: true, idempotentHint: true` |
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
| PIREP | list recent by station + distance, or by bbox | `GET /pirep?id=&format=json&distance=&age=` |
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
wind: { direction_deg: number | null, speed_kt: number | null, gust_kt: number | null }
visibility_sm: string        // '10+', '3', '1/2' etc.
ceiling_ft: number | null    // lowest BKN, OVC, or OVX layer base, feet AGL
ceiling_type: 'measured' | 'indefinite' | null   // null exactly when ceiling_ft is null
clouds: { cover: string, base_ft: number }[]   // base_ft is feet AGL
present_weather: { raw: string, decoded: string } | null   // wxString, both forms
temp_c: number | null
dewpoint_c: number | null
altimeter_inhg: number | null
raw_metar: string            // rawOb
```

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
  change_type: string | null // fcstChange: 'FM', 'TEMPO', 'BECMG', null
  probability: number | null // probability
  wind: { direction_deg: number | null, speed_kt: number | null, gust_kt: number | null }
  wind_shear: { height_ft: number, direction_deg: number, speed_kt: number } | null  // wshearHgt/Dir/Spd, passed through unconverted
  visibility_sm: string | null
  vertical_visibility_ft: number | null   // vertVis, already in feet; non-null only on an obscured period
  weather: { raw: string, decoded: string } | null   // wxString, both forms
  clouds: { cover: string, base_ft: number, type: string | null }[]   // base_ft is feet AGL
}]
raw_taf: string              // rawTAF
```

`wind.speed_kt` is null when the period carries no wind element — a TEMPO or PROB group amending only visibility, weather, or cloud, which is 13% of live CONUS forecast periods. `wdir` is null on exactly those, and the string `VRB` on a variable wind that does carry a speed; both normalize to `direction_deg: null`, so `speed_kt` is what separates "no wind forecast" from "variable". 0 kt stays a forecast calm.

**Design note:** `wxString` from the API is one or more space-delimited weather groups (e.g., `-SHRA`, `-SHRA BR`). Both forms are carried, matching `aviation_get_metar`'s `present_weather` — see decision 14 for how a group is decoded and what happens when one does not resolve.

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
```

Note: `station_id` or `bbox` is required (mutually exclusive, validate in handler).

`distance_nm` carries no schema default — the handler must tell an omitted value from an explicit one to reject `bbox` + `distance_nm`, so the 100 nm fallback is applied on the `station_id` path instead.

**Output schema (per PIREP):**
```
observed_at: string          // ISO 8601 from obsTime
lat / lon: number
altitude_ft: number | null   // fltLvl * 100 (flight level to feet); null when the raw report gave no flight level
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
clouds: { cover: string, base_ft: number | null, top_ft: number | null }[] | null
visibility_sm: number | null
remarks: string | null       // wxString or remarks
raw_pirep: string            // rawOb
```

`cover` also carries `SKC`, `CLR`, and the flight-condition markers `VMC`/`IMC`, which arrive with `base: 0, top: 0` — a layer with neither bound is kept for its cover rather than dropped. An empty `turbulence`/`icing` array means the report carried no such group; an explicit negative report is a layer with intensity `NEG`.

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
station_ids: z.array(z.string()).min(1).max(20).optional().describe('One or more 4-letter ICAO station IDs. Lookup is ICAO-only; 3-letter IATA codes return no results.')
bbox: z.object({ minLat, minLon, maxLat, maxLon }).optional().describe('Return all stations in bounding box.')
state: z.string().length(2).optional().describe('Two-letter USPS code for one of the 50 US states or DC (e.g., "WA").')
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
{ reason: 'station_not_found', code: NotFound, when: 'None of the requested IDs match any known station', recovery: 'Station IDs must be 4-letter ICAO format (e.g., KSEA, not SEA). Use bbox or state to discover ICAO IDs by location.' }
{ reason: 'missing_search_criteria', code: ValidationError, when: 'None of station_ids, bbox, or state provided', recovery: 'Provide exactly one of station_ids, bbox, or state.' }
{ reason: 'conflicting_location', code: ValidationError, when: 'More than one of station_ids, bbox, or state provided', recovery: 'Provide exactly one location mode per call.' }
{ reason: 'invalid_bbox', code: ValidationError, when: 'The bounding box is inverted', recovery: 'Ensure minLat <= maxLat and minLon <= maxLon.' }
{ reason: 'invalid_state', code: ValidationError, when: 'The state code is not one of the 50 US states or DC', recovery: 'Use a USPS code for a state or DC; territories are unsupported — search them with bbox.' }
```

`conflicting_location` is checked ahead of `invalid_state`, so combining a bogus `state` with another location mode reports the mode conflict.

---

## Design Decisions

**1. `fltCat` is returned by the API — no client-side computation needed.**
The AWC METAR endpoint returns `fltCat` directly in the JSON response. Initial assumption was that flight category would need to be computed from ceiling + visibility; it doesn't. This simplifies the service layer significantly.

**2. AIRSIGMET type filter is unreliable for non-convective.**
During live probing, `type=airmet` and `type=sigmet` both returned only SIGMETs (15 convective SIGMETs, no AIRMETs present at query time). The API appears to serve only currently-active advisories — it's common for AIRMETs to be absent during clear weather. The tool accepts an `advisory_type` filter parameter and passes it to the API, but notes to clients that absence of results reflects current conditions, not a query error.

**3. No geocoding — ICAO IDs are the interface.**
The AWC Data API does not geocode. All tools take ICAO station IDs or coordinates as input. `aviation_find_stations` provides the lookup from human-readable names via bbox/state queries. Agents needing "nearest airport to lat/lon" should chain with `openstreetmap-mcp-server`.

**4. `stationinfo` with `state` uses bbox workaround.**
The API does not accept a `state` query parameter for `stationinfo`. The live probe with `state=WA` returned `{"status":"error","error":"Must specify station IDs or bounding box, zoom, and density"}`. The service maintains a state→approximate-bbox table and client-side filters the results by the `state` field.

The table covers the 50 states plus DC. DC is a real AWC jurisdiction but holds exactly one station — `WASD2` ("Washington DC"), a mesonet site with every identifier null; the region's airports (KDCA, KIAD, KBWI) carry `VA` or `MD`. US territories (PR, VI, GU, MP, AS) are deliberately excluded: AWC leaves `state` empty on their stations and identifies them by `country`, so a bbox entry would filter down to zero rows rather than working. Supporting them needs a country-based filter path, not another table row.

Validation lives in the handler rather than a schema `z.enum()`: an enum mismatch is raised by the SDK transport as JSON-RPC -32602 before the handler runs, which bypasses the tool's typed `reason`/`recovery` contract.

**5. PIREPs use `icaoId: "KWBC"` for the center — not the station queried.**
All PIREP responses have `icaoId` set to `KWBC` (the collection center), not the station the search was centered on. The actual location is in `lat`/`lon`. This is a quirk of the API and should be documented in the service layer.

**6. Advisories bbox filtering is client-side.**
The AIRSIGMET endpoint doesn't support bbox filtering in the API itself. The service fetches all active advisories and filters by bounding-box overlap against `coords` polygons. This is acceptable because the set of active advisories is typically small (<50).

**7. Prompt included despite read-only server.**
The `aviation_preflight_brief` prompt earns its place: a preflight briefing has a well-established structure (METAR → TAF → PIREPs → advisories) that agents frequently get wrong by omitting steps. The prompt encodes the correct sequence and synthesis pattern.

**8. The PIREP lookback parameter is `age`, not `hours`.**
`/pirep` declares `id, distance, bbox, format, age, level, inten, date` — no `hours`. The endpoint returns HTTP 200 and silently drops query keys it does not recognize, so sending `hours` produced the same fixed window for every value in both query modes. `/metar` and `/taf` do define a separate, correctly-named `hours` parameter, so the mismatch is specific to `/pirep`. The tool's public `hours` input keeps its name; only the outgoing key differs.

**9. `distance_nm` alongside `bbox` is rejected, not forwarded.**
A live sweep against a fixed bbox with `distance` at 1, 10, 50, 100, 200, 500 and omitted returned byte-identical PIREP sets — upstream ignores `distance` without an `id` center point to measure from, so there is nothing to forward it to. Rejecting the combination is the only way the caller learns the radius did nothing.

**10. An unavailable numeric observation is null, never 0.**
0 is a plausible aviation reading for every affected field — calm wind, a freezing temperature, a sea-level station — so it cannot double as "upstream reported nothing". Two upstream mechanisms feed the ambiguity and need different handling. METAR `wspd`/`temp`/`dewp`/`altim` and station `elev` arrive as genuine nulls, so the `?? 0` fallbacks became `?? null`. PIREP `fltLvl` and cloud `base`/`top` instead arrive as a literal `0`, which no null guard can catch.

For PIREP altitude the discriminator is the raw `/FL…/` token, not the numeric value and not `fltLvlType`. `fltLvl: 0` alone cannot separate `/FLDURD/` (no altitude given) from `/FL000/` (a reported flight level of zero); both occur in the same snapshot. `fltLvlType` is phase of flight, and plenty of DURC/DURD reports carry a real numeric level. `/FLSFC/` is left alone — AWC substitutes the field elevation in hundreds of feet, which the existing ×100 conversion renders correctly.

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

---

## Known Limitations

- **Coverage:** METAR/TAF are global; PIREPs and SIGMETs/AIRMETs are US-centric (AWC is a US NWS product).
- **Recency:** METARs are typically 20–60 min old. TAFs are 6–30 hour forecasts. PIREPs are real-time but sparse. Advisory set reflects only currently active products.
- **No historical archive:** The API serves recent observations only (`hours` parameter up to 12 for METAR). No multi-day historical queries.
- **Not an official briefing:** This data does not constitute a regulatory-compliant preflight weather briefing. Pilots flying IFR or in controlled airspace must use an authorized source.
- **AIRSIGMET scope:** During fair-weather periods, no AIRMETs may be active. Absence of results is a valid state, not an error.
- **Empty cloud arrays are ambiguous:** AWC does not encode a clear sky as a layer — a METAR reporting `CLR` and one carrying no sky-condition group at all both arrive as `clouds: []`. Both currently render as `Clear`, which overstates the second case and is the one place the "never state what the structured result does not support" rule above is not yet honored. Separating them requires inspecting the raw observation; tracked in #27.

---

## API Reference

**Base URL:** `https://aviationweather.gov/api/data`

**Common parameters:**
- `format=json` — required for JSON responses (default is plain text)
- `ids=KSEA,KJFK` — comma-separated ICAO IDs for station-keyed endpoints
- `hours=N` — lookback window for `metar` and `taf` (METAR: 1–12 typical)
- `age=N` — lookback window ("Hours Back") for `pirep`; that endpoint has no `hours` parameter and silently ignores one
- `distance=N` — radius in nautical miles around the `id` center point for PIREP searches; ignored when the search is a bbox

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
