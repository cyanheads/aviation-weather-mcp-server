# aviation-weather-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `aviation_get_metar` | Current weather observations for named airports, or an area survey of every reporting station in a bounding box. Returns decoded fields (wind direction/speed/gusts, visibility, ceiling and its kind, present weather, temp/dewpoint, altimeter, cloud layers) plus the computed flight category (VFR/MVFR/IFR/LIFR) and the raw METAR string. Accepts 1–10 ICAO station IDs, or a bbox. | `station_ids?: string[]`, `bbox?: {minLat, minLon, maxLat, maxLon}`, `hours?: number (1–12 lookback window, default 1)`, `limit?: number (1–400 response bound, bbox only)`, `flight_category?: ('VFR' \| 'MVFR' \| 'IFR' \| 'LIFR')[] (bbox only)` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_get_taf` | Terminal Aerodrome Forecast for one or more airports. Returns each forecast period with valid times, wind, visibility, decoded weather, and cloud layers, plus the raw TAF string. Accepts 1–4 ICAO station IDs. | `station_ids: string[]` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_get_pireps` | Recent Pilot Reports near an airport or within a bounding box. Returns decoded turbulence/icing/cloud reports with altitude, aircraft type, intensity, outside air temperature, wind aloft, flight weather, and the raw pirep string. | `station_id?: string`, `bbox?: {minLat, minLon, maxLat, maxLon}`, `distance_nm?: number (station_id only, 100 when omitted)`, `hours?: number (1–12, default 3)`, `altitude_min_ft?: number`, `altitude_max_ft?: number`, `min_intensity?: 'lgt' \| 'mod' \| 'sev'`, `limit?: number (1–400 response bound)` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_get_advisories` | Domestic/international SIGMETs and CWAs with independent source coverage, nullable decoded fields, multipart geometry and original bulletins. AIRMET requests are rejected. | `hazard?: enum`, `bbox?: {minLat, minLon, maxLat, maxLon}`, `advisory_type?: 'sigmet' \| 'isigmet' \| 'cwa' \| 'airmet' \| 'all'`, `limit?: positive integer` | `readOnlyHint: true, idempotentHint: true` |
| `aviation_find_stations` | Resolve an airport or weather reporting station by ICAO ID, or discover stations within a bounding box or US state. Returns ICAO/IATA/FAA IDs, coordinates, elevation, and available data types. | `station_ids?: string[]`, `bbox?: {minLat, minLon, maxLat, maxLon}`, `state?: string (2-letter)`, `limit?: number (1–400 response bound, bbox/state only)` | `readOnlyHint: true, idempotentHint: true, openWorldHint: false` |

### Resources

None. All data is time-sensitive (METARs valid ~1 hour, advisories minutes to hours) — stable-URI resources would deliver stale data. Tool-only surface is correct.

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `aviation_preflight_brief` | Structures a preflight weather briefing for one or more airports. Guides the LLM to call METAR, TAF, PIREPs, and advisories in sequence — chunked to each tool's station limit, bounded to the planned cruise level and route corridor where those were supplied — and synthesize a weather-risk summary that names the assessments it could not make. | `departure_icao: string`, `destination_icao: string`, `alternates?: string`, `departure_time?: string`, `cruise_altitude?: string`, `route_waypoints?: string` |

All six args are strings: `prompts/get` carries arguments as `{ [key: string]: string }` on the wire, so a numeric Zod type would reject every real client's call. Each optional field also accepts `''` — a form-based client sends one for a field left blank — and reads it as omitted. Shape is enforced by regex so it reaches the caller as a JSON Schema `pattern`: four ASCII letters or digits in either case for each identifier, ISO 8601 UTC ending in `Z` for `departure_time`, digits-only feet MSL for `cruise_altitude`, and semicolon-separated `lat,lon` pairs for `route_waypoints`. Identifiers are uppercased before generation. See decisions 30 and 31.

---

## Overview

Aviation weather from the NWS Aviation Weather Center (aviationweather.gov) — METARs, TAFs, PIREPs, domestic/international SIGMETs and CWAs. AIRMETs are not served. Keyless, no authentication required. Covers the AWC Data API at `https://aviationweather.gov/api/data/`.

**Audience:** Pilots (GA and commercial), flight dispatchers, drone operators, aviation enthusiasts, and agents answering questions like "What's the weather at KSEA?", "Is it VFR at my destination?", "Any SIGMETs along this route?"

**Not a replacement for official preflight briefing.** This data is informational only; real flight planning requires an authorized source (Leidos/1800wxbrief.com). The server surfaces this framing via its `instructions` field.

---

## Requirements

- Keyless REST — no API key or auth required
- Primary data types: METAR, TAF, PIREP, domestic SIGMET (`/airsigmet`), international SIGMET (`/isigmet`), and CWA (`/cwa`). AIRMET products are not read
- All endpoints return JSON when `format=json` is passed; raw coded text is also available but not used (we surface `rawOb`/`rawTAF`/`rawAirSigmet` directly in structured output)
- METAR/TAF and international SIGMET coverage are global; PIREPs, domestic SIGMETs and CWAs are US-centric
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
| METAR | get current/recent by ICAO IDs, or survey a bounding box | `GET /metar?ids=&format=json&hours=` · `GET /metar?bbox=&format=json&hours=` |
| TAF | get current by ICAO IDs | `GET /taf?ids=&format=json` |
| PIREP | list recent by station + distance, or by bbox; narrowed upstream by altitude band and minimum intensity | `GET /pirep?id=&format=json&distance=&age=&level=&inten=` |
| AIRSIGMET | list active, narrowed upstream by hazard and client-side by bbox | `GET /airsigmet?format=json&hazard=` |
| International SIGMET | list active, narrowed upstream by hazard and client-side by bbox | `GET /isigmet?format=json&hazard=` |
| CWA | list active, narrowed upstream by hazard and client-side by bbox | `GET /cwa?format=json&hazard=` |

---

## Tool Design Details

### `aviation_get_metar`

**Input schema:**
```
station_ids: z.array(z.string().regex(/^[A-Za-z0-9]{4}$/).describe('ICAO station ID')).min(1).max(10).optional()   // ASCII letters or digits, normalized to uppercase in the handler (decision 31)
bbox: z.object({ minLat, minLon, maxLat, maxLon }).optional()   // area survey — the latest observation per station in the box (decision 34)
hours: z.number().int().min(1).max(12).default(1)   // a lookback window, not a row limit; with station_ids every observation inside it is returned, and with bbox it shapes the draw the row cap applies to
limit: z.number().int().min(1).max(400).optional()   // bbox mode only — a response bound, not an area narrowing; ordered by station_id ascending
flight_category: z.array(z.enum(['VFR', 'MVFR', 'IFR', 'LIFR'])).min(1).optional()   // bbox mode only — keeps the stations in these categories, after the reduction to one per station and before limit; 'unknown' never matches (decision 37)
```

Exactly one of `station_ids` or `bbox` is required, mutually exclusive.

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
clouds: { cover: string, base_ft: number }[]   // base_ft is feet AGL; at most four layers, AWC's decode limit (decision 32); empty whenever the observation published no layer heights
sky_condition: string | null // cover — the group stated when there are no layer heights (CLR/SKC/CAVOK, or OVX for a VV/// obscuration); null when clouds carries layers, and when nothing was reported
present_weather: { raw: string, decoded: string } | null   // wxString, both forms
temp_c: number | null
dewpoint_c: number | null
altimeter_inhg: number | null
raw_metar: string            // rawOb
```

An empty `clouds` array and `sky_condition` are read together: the array empties for a clear sky, for an obscuration with no determinable height, and for an observation that stated nothing, and only `sky_condition` separates them — see decision 21.

`speed_kt`, `temp_c`, `dewpoint_c`, and `altimeter_inhg` are null when upstream omitted the group. 0 is a real reading for every one of them (calm wind, freezing point), so it cannot double as "not reported". `elevation_ft` stays a plain number: AWC never returned a null METAR `elev` in any sampled region, its schema declares `default: 0`, and 0 is correct for a sea-level field.

`wind.direction_deg` is null in two cases, and `speed_kt` is what separates them — the same pair `aviation_get_taf` carries. A variable wind arrives as `wdir: "VRB"` beside a real speed; an observation with no wind group at all (a sensor that sent none) arrives as `wdir: null, wspd: null`. `content[]` renders the first `variable at N kt` and the second `not reported`, never `variable`, and a calm `00000KT` stays `0° at 0 kt`.

**Design note:** a `bbox` survey returns one observation per station — the latest inside the `hours` window — reduced in the tool after the draw, because `/metar` windows on `hours` alone and rejects any other key. Cap detection reads the pre-reduction row count, and the truncation notice names `hours` as its first lever above `hours: 1`; at the minimum of 1 it leads with the quadrants. See decision 34.

**Design note:** `flight_category` narrows a survey by condition, client-side: `/metar` takes no category parameter, so the draw and its cap are untouched. The filter reads each station's latest observation and runs before `limit`; a survey it empties is returned as an empty result whose notice names the filter, not as `no_stations_found`. See decision 37.

**Error contract:**
```
{ reason: 'no_stations_found', code: NotFound, when: 'No station returned data — none of the requested IDs, or none inside the box', recovery: mode-agnostic in the contract; the throw site sends a hint branched on the mode that drew nothing — see decision 34 }
{ reason: 'missing_location', code: ValidationError, when: 'Neither station_ids nor bbox provided', recovery: 'Provide station_ids for named airports or bbox for an area survey.' }
{ reason: 'conflicting_location', code: ValidationError, when: 'Both station_ids and bbox provided', recovery: 'Provide station_ids OR bbox, not both.' }
{ reason: 'invalid_bbox', code: ValidationError, when: 'The bounding box is inverted', recovery: 'Ensure minLat <= maxLat and minLon <= maxLon.' }
{ reason: 'conflicting_limit', code: ValidationError, when: 'limit provided together with station_ids', recovery: 'Drop limit, or replace station_ids with bbox.' }
{ reason: 'conflicting_flight_category', code: ValidationError, when: 'flight_category provided together with station_ids', recovery: "Drop flight_category and read each named station's flight_category, or replace station_ids with bbox." }
```

Guard order is `missing_location` → `conflicting_location` → `invalid_bbox` → `conflicting_limit` → `conflicting_flight_category`, so a location-mode mistake is always reported ahead of a filter mistake — the order `aviation_find_stations` and `aviation_get_pireps` use.

**Enrichment contract** — two disclosures on disjoint modes (decisions 17, 18, 24, 34, 36, and 37):
```
requested:    string[]        // station_ids mode — station IDs as requested
returned:     string[]        // station_ids mode — distinct station IDs present in the result, counted per station not per row
partial:      boolean         // station_ids mode — true when a requested station returned nothing
missing:      string[]        // station_ids mode — only when non-empty
truncated:    boolean         // bbox mode — true when the draw hit the 400-row upstream cap
shown:        number          // bbox mode — stations returned, after the reduction to one row each, any flight_category filter, and any limit
surveyed:     number          // only when a bbox call supplied flight_category — stations before the filter selected from them
cap:          number          // only when truncated — the upstream row maximum applied
upstreamRows: number          // only when the reduction narrowed a truncated draw
limited:      boolean         // only when a bbox call supplied a limit — true when it withheld matching stations
matched:      number          // only when limited — stations the draw held before the limit selected from them, after any flight_category filter
notice:       string          // whichever disclosures fired, in pipeline order — the narrowing levers, what the filter kept or that it emptied the result, what a limit withheld, the limit lever on a survey of more than 40 stations that set none; or the IDs that returned nothing
```

Only `bbox` reaches the row cap (`station_ids` is bounded at 10 by the input schema) and accepts a filter or a `limit`, and only `station_ids` has a request to reconcile, so the reconciliation never co-occurs with the rest and `notice` is shared without conflating anything. The survey statements *can* co-occur, and there the notice states each in turn — cap, filter, limit, size — see decisions 24 and 36.

### `aviation_get_taf`

**Input schema:**
```
station_ids: z.array(z.string().regex(/^[A-Za-z0-9]{4}$/).describe('ICAO station ID')).min(1).max(4)   // ASCII letters or digits, normalized to uppercase in the handler (decision 31)
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
  clouds: { cover: string, base_ft: number, type: string | null }[]   // base_ft is feet AGL; at most three layers, AWC's decode limit; empty whenever the period published no layer heights
  sky_condition: string | null   // the group the period forecast when its cover carries no height (SKC/NSC, or OVX for an obscuration with no vertical visibility); null when clouds carries layers, and when the period carried no cloud element
  not_decoded: string | null     // notDecoded, trimmed — text AWC attached to the period without decoding it; null when empty or whitespace-only; never reassigned or parsed into clouds
}]
raw_taf: string              // rawTAF
```

`wind.speed_kt` is null when the period carries no wind element — a TEMPO or PROB group amending only visibility, weather, or cloud, which is 13% of live CONUS forecast periods. `wdir` is null on exactly those, and the string `VRB` on a variable wind that does carry a speed; both normalize to `direction_deg: null`, so `speed_kt` is what separates "no wind forecast" from "variable". 0 kt stays a forecast calm.

**Design note:** `wxString` from the API is one or more space-delimited weather groups (e.g., `-SHRA`, `-SHRA BR`). Both forms are carried, matching `aviation_get_metar`'s `present_weather` — see decision 14 for how a group is decoded and what happens when one does not resolve.

**Design note:** an empty `clouds` array is read with `sky_condition`, which separates a forecast clear sky from a period that amended nothing about cloud — see decision 21.

**Design note:** `vertical_visibility_ft` and the `OVX` layer that carries the same height are gated on the period's own obscuration — see decision 15. `wind_shear` is one nullable object rather than three nullable scalars, and its `speed_kt` is a wind velocity rather than a shear magnitude — see decision 16.

**Design note:** `not_decoded` surfaces what the decoder left over — usually a fourth cloud layer — on the period AWC attached it to, which can be the period after the one whose text it came from. `format()` renders it on its own line after the clouds, marked as a partial decode and pointing at the raw TAF — see decision 32.

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
station_id: z.string().regex(/^[A-Za-z0-9]{4}$/).optional().describe('Center ICAO station for radial search.')   // ASCII letters or digits, normalized to uppercase in the handler (decision 31)
bbox: z.object({ minLat, minLon, maxLat, maxLon }).optional()
distance_nm: z.number().int().min(10).max(500).optional().describe('Search radius in nautical miles around station_id. 100 when omitted.')
hours: z.number().int().min(1).max(12).default(3).describe('How far back to look.')
altitude_min_ft: z.number().int().min(0).max(60000).optional().describe('Filter by minimum altitude in feet MSL (e.g., 18000 for FL180).')   // 0 ft to FL600 — decision 33
altitude_max_ft: z.number().int().min(0).max(60000).optional().describe('Filter by maximum altitude in feet MSL (e.g., 35000 for FL350).')   // 0 ft to FL600 — decision 33
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
pirep_type: string          // PIREP, Urgent PIREP, AIREP, AMDAR; other source types preserved
braking_action: string | null // decoded brkAction, unchanged when nonempty; never inferred from remarks
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
temp_c: number | null        // temp — /TA on a PIREP, MS/PS on an AIREP; null when absent or /TA UNKN, 0 is a reading
wind: { direction_deg: number, speed_kt: number } | null   // wdir/wspd — /WV on a PIREP, dddfffKT on an AIREP; null unless both decoded; direction as reported, magnetic on a PIREP /WV, unconverted (decision 35)
weather: { raw: string, decoded: string } | null           // wxString — the /WX group, never /RM, both forms
raw_pirep: string            // rawOb
```

`cover` also carries `SKC`, `CLR`, and the flight-condition markers `VMC`/`IMC`, all published with neither bound — a layer with neither bound is kept for its cover rather than dropped. `CLR`, `VMC`, and `IMC` arrive with `base: 0, top: 0`; `SKC` arrives with bounds AWC synthesized, which are dropped (decision 20). An empty `turbulence`/`icing` array means the report carried no such group; an explicit negative report is a layer with intensity `NEG`.

Each icing layer is admitted on its own: AWC marks a layer it synthesized by concatenating type text onto the intensity code, and such a layer is dropped rather than cleaned up — see decision 20. `turbulence` needs no equivalent: its intensities are clean codes throughout.

`temp_c`, `wind`, and `weather` publish what AWC already decodes from `/TA`, `/WV`, and `/WX`. `weather` replaced `remarks`, which held the same `wxString` under a name that pointed at `/RM` — see decision 35.

**Error contract:**
```
{ reason: 'no_pireps_found', code: NotFound, when: 'No pilot reports found in the search area/time window', recovery: mode-agnostic in the contract ('Widen the search — a larger distance_nm (up to 500) on a station_id search, a larger bbox on an area search, or a longer hours while it is below 12 — or try a different region. …'); the throw site sends a hint naming only the levers the call can still widen — decision 18 }
{ reason: 'station_not_recognized', code: NotFound, when: 'AWC does not recognize station_id as a PIREP search center', recovery: 'Confirm the identifier with aviation_find_stations, or search the same area with bbox, which needs no center station.' }
{ reason: 'missing_location', code: ValidationError, when: 'Neither station_id nor bbox provided', recovery: 'Provide station_id for a radial search or bbox for an area search.' }
{ reason: 'conflicting_location', code: ValidationError, when: 'Both station_id and bbox provided', recovery: 'Provide station_id OR bbox, not both.' }
{ reason: 'invalid_bbox', code: ValidationError, when: 'The bounding box is inverted', recovery: 'Ensure minLat <= maxLat and minLon <= maxLon.' }
{ reason: 'conflicting_distance', code: ValidationError, when: 'distance_nm provided together with bbox', recovery: 'Drop distance_nm, or replace bbox with station_id.' }
{ reason: 'invalid_altitude_range', code: ValidationError, when: 'altitude_min_ft > altitude_max_ft', recovery: 'Ensure altitude_min_ft <= altitude_max_ft, or drop one bound.' }
```

Guard order is `missing_location` → `conflicting_location` → `invalid_bbox` → `conflicting_distance` → `invalid_altitude_range`, so a location-mode mistake is always reported ahead of a filter mistake. Equal altitude bounds are a valid degenerate range, mirroring `isBboxOrdered`'s `<=`. `station_not_recognized` is not an input guard: it is raised from the upstream call, and only for the one rejection whose text names the center (decision 33).

**Enrichment contract** (see decisions 18, 24, and 36):
```
truncated:    boolean         // always — true when the page hit the 400-row upstream cap
shown:        number          // always — reports returned after geographic selection, altitude filtering and any limit
cap:          number          // only when truncated — the upstream row maximum applied
upstreamRows: number          // when geographic selection or altitude filtering narrowed capped candidate draws; sum before filtering/deduplication
limited:      boolean         // only when the call supplied a limit — true when it withheld matching reports
matched:      number          // only when limited — reports that matched before the limit selected from them
notice:       string          // whichever disclosures fired — the narrowing levers, what a limit withheld, and the limit lever on a result of more than 50 reports that set none
```

Detection reads each candidate draw before geographic selection and altitude filtering. The service supplies the sum of raw rows and whether any individual draw reached 400; two uncapped antimeridian draws totaling over 400 are not truncated. The service deduplicates wrapped draws and selects the nautical circle before the handler filters altitude, sorts, and applies `limit`. Both successful and emptied capped draws disclose partial coverage. `level`, `inten`, and `age` remain upstream filters on every candidate request.

When a capped page is then emptied by the altitude filter, `no_pireps_found` says the area was searched only in part and points at the same narrowing levers. It does not report the capped page's row count as the reports present in the area — that count describes the page, not the area, and the filter never saw beyond it. An empty draw under an upstream narrowing gets its own message, since the query never asked for the whole area to begin with.

### `aviation_get_advisories`

**Input schema:**
```
advisory_type: z.enum(['sigmet', 'isigmet', 'cwa', 'airmet', 'all']).default('all')
hazard: z.enum(['CONVECTIVE', 'TURBULENCE', 'ICING', 'IFR', 'TS', 'MTW', 'DS', 'SS', 'TC', 'VA', 'PCPN', 'UNK', 'MTN OBSCN', 'SURFACE WIND', 'LLWS']).optional()
bbox: z.object({ minLat, minLon, maxLat, maxLon }).optional() // ordered input; bounding-envelope overlap on every source geometry part
altitude_ft: z.number().min(0).optional() // finite feet MSL, nearest-100-ft rounding
limit: z.number().int().min(1).optional() // no default or automatic cap
```

**Output schema (per advisory):**
```
advisory_type: string // SIGMET, ISIGMET or CWA
source: 'sigmet' | 'isigmet' | 'cwa'
series_id / hazard / issued_by / valid_from / valid_to / raw_text: string | null
fir_id / fir_name / qualifier: string | null
tendency / issued_by_name: string | null // international chng / CWA office name, otherwise null
severity: number | null // domestic numeric value; null for international/CWA
altitude_low_ft / altitude_high_ft: number | null // decoded feet MSL, never inferred from raw text
movement: { direction_deg: number | null, speed_kt: number | null, direction_text?: string | null, stationary?: boolean | null } | null
polygon: Point[] | null // compatibility field for a single area; null for multipart, LINE or missing geometry
geometry: { kind: string | null, parts: Point[][] } | null // source-native kind, intact rings/lines
```

**Sources and filtering:** `/airsigmet` supplies domestic SIGMETs, `/isigmet` disjoint international products, and `/cwa` Center Weather Advisories. The deprecated SIGMET feeds preserve domestic severity/movement and reliable international selection; unified `/sigmet` has no documented domestic classifier. Domestic supports `CONVECTIVE→conv`, `TURBULENCE→turb`, `ICING→ice`, `IFR→ifr`; international supports `TS→ts`, turbulence/icing plus `MTW`, `DS`, `SS`, `TC`, `VA`; CWA supports `TS`, turbulence/icing, `IFR`, `PCPN`, `UNK` with lowercase upstream tokens. Unsupported pairs are not_applicable. Bbox compares each part's bounding envelope, with sequential date-line unwrapping, rather than exact polygon intersection. Ordered bbox input is unchanged.

**Error contract:**
```
{ reason: 'invalid_bbox', code: ValidationError, when: 'The bounding box is inverted', recovery: 'Ensure minLat <= maxLat and minLon <= maxLon.' }
{ reason: 'airmet_not_served', code: ValidationError, when: 'advisory_type "airmet", or MTN OBSCN/SURFACE WIND/LLWS', recovery: 'Use SIGMET/CWA selections; AIRMET information lives on separate G-AIRMET and textual AIRMET products.' }
{ reason: 'hazard_not_supported', code: ValidationError, when: 'No selected source supports the hazard', recovery: 'Choose a compatible product/hazard pair or omit the hazard.' }
{ reason: 'advisory_sources_failed', code: ServiceUnavailable, when: 'Every applicable source failed', recovery: 'Retry later or request one product separately; no weather absence was established.' }
```

Independent applicable products run concurrently under one 45-second deadline spanning fetches, body reads, retry attempts and backoffs. Caller cancellation aborts every leg and propagates. Partial failures preserve healthy products; unreadable/non-array/empty non-204 bodies never establish zero. Only readable arrays or HTTP 204 do. Empty/unreadable rows are skipped with disclosure; meaningful sparse bulletins remain. Domestic numeric movement is preserved; international direction stays source-native in `direction_text` and decoded `spd` stays knots. CWA movement/severity are null. Raw bulletins use fences longer than embedded backtick runs. All fields and enrichment reach structured and readable surfaces.

**Enrichment contract** (see decision 23):
```
coverage: { source, status: 'ok' | 'failed' | 'not_applicable', drawn: number | null, cancelled: number | null, altitude_filter: 'upstream' | 'client' | null, altitude_unknown: number | null, message?: string }[]
altitude_selection?: { requested_ft, level, band_low_ft, band_high_ft } // rounded integer level and effective feet-MSL band
partial: boolean // failed source or skipped unreadable rows
drawn / matched / returned / unlocated: number // bbox only; returned also present with explicit limit
total: number // explicit limit only, matches before limit
truncated: boolean // explicit limit only, true if matches withheld
notice?: string // readable coverage, empty/filter stage, partial coverage and limit recovery
```

Source `drawn` and bbox `drawn` count decoded active rows after product/hazard/altitude selection and before bbox; `matched` precedes limit and `returned` follows it. `unlocated` is separate from proven-outside rows. No bbox means no bbox-specific counts/notices. An explicit limit sorts by source/issuer/series/validity (raw text breaks remaining ties), discloses totals and offers omission/raising as recovery. It has no default and no upstream cap claim. Empty hazard-scoped notices never assert other hazards are active; altitude-scoped empty notices name altitude selection before bbox.

`TS` and `CONVECTIVE` are aliases at the query boundary: domestic sends `conv`, international and CWA send `ts`. Output hazards remain source-native; matching stays upstream. Finite primary domestic altitude bounds take precedence, falling back to alternate bounds only when unavailable. This preserves existing finite values and zero rather than asserting an unsupported alternate precedence. Finite source longitudes outside [-180,180] wrap modulo 360 before storage and shortest-arc envelope matching; already canonical coordinates, including 180, stay unchanged. Malformed vertices still invalidate all parts.

A CWA cancellation is a `CNL CWA <number>` action at the start of the body following its validity header, not a substring elsewhere in an active bulletin. Remove it before all active counts; readable feeds disclose `cancelled` (including zero), unavailable feeds null. Cancellation is successful decoding and does not set `partial`.

When `altitude_ft` is supplied, `level=Math.round(altitude_ft/100)` selects AWC's documented ±3,000 ft band for domestic/international SIGMETs. Echo requested feet, effective integer level and band with lower edge clamped to zero. CWA filtering uses inclusive local interval overlap because its upstream schema does not document `level`. Retain CWA rows with either bound unknown; unknown is neither SFC nor UNL. Preserve upstream-selected SIGMET rows without guessing a second filter. `altitude_filter` names each readable source's mechanism; `altitude_unknown` counts retained decoded unknown bounds before bbox, never records withheld upstream. Both are null without altitude selection or available coverage. Unknown altitude alone is not partial coverage. The preflight prompt forwards explicitly supplied cruise feet, including zero, without dropping its route bbox.

International `tendency` preserves `chng` as an open nullable token; CWA `issued_by_name` preserves the office name. International movement keeps all existing values, including the `-` sentinel, and renders direction text and speed together. Add nullable `stationary`: true only for an unquoted standalone bulletin `STNR` token, false for non-sentinel decoded direction plus positive speed, otherwise null. Missing/sentinel direction or zero speed alone proves no stationarity. Domestic numeric movement remains unchanged and CWA movement stays null.

### `aviation_find_stations`

**Input schema:**
```
station_ids: z.array(z.string().regex(/\S/)).min(1).max(20).optional()   // comma-split and token-trimmed handler-side, 1–20 expanded tokens; empty tokens rejected; registry IDs retain their broader grammar
bbox: z.object({ minLat, minLon, maxLat, maxLon }).optional().describe('Return all stations in bounding box.')
state: z.string().length(2).optional().describe('Two-letter USPS code for one of the 50 US states or DC (e.g., "WA").')
limit: z.number().int().min(1).max(400).optional()   // bbox and state modes only — a response bound, not an area narrowing; rejected alongside station_ids. Ordered by icao_id asc, identifier-less last, tiebroken by registry id — see decision 26
```

Exactly one of `station_ids`, `bbox`, or `state` is required.

**Note:** `stationinfo` requires `ids` or `bbox`. State searches instead filter the complete AWC `stations.cache.json.gz` snapshot by US country and registry state assignment. `isSupportedState` accepts the 50 states and DC before any request. Decision 39 defines freshness and failure semantics.

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
magnetic_declination?: { degrees: number | null, source: string } | null  // source-published airport variation, east positive, no epoch; null for area/absent/unavailable
```

**Error contract:**
```
{ reason: 'station_not_found', code: NotFound, when: 'None of the requested IDs match any known station, or the bbox or state search found none', recovery: mode-agnostic in the contract; the throw site sends a hint branched on the mode — an identifier lookup keeps "A lookup matches the registry's own identifier … (KSEA, not SEA). Use bbox or state to discover identifiers by location.", a bbox search is told to widen the box, and a state search to use an explicit bbox — decision 18 }
{ reason: 'missing_search_criteria', code: ValidationError, when: 'None of station_ids, bbox, or state provided', recovery: 'Provide exactly one of station_ids, bbox, or state.' }
{ reason: 'conflicting_location', code: ValidationError, when: 'More than one of station_ids, bbox, or state provided', recovery: 'Provide exactly one location mode per call.' }
{ reason: 'invalid_bbox', code: ValidationError, when: 'The bounding box is inverted', recovery: 'Ensure minLat <= maxLat and minLon <= maxLon.' }
{ reason: 'invalid_state', code: ValidationError, when: 'The state code is not one of the 50 US states or DC', recovery: 'Use a USPS code for a state or DC; territories are unsupported — search them with bbox.' }
{ reason: 'conflicting_limit', code: ValidationError, when: 'limit provided together with station_ids', recovery: 'Drop limit, or replace station_ids with bbox or state.' }
{ reason: 'invalid_station_ids', code: ValidationError, when: 'Expanded identifiers contain an empty token or exceed twenty', recovery: 'Provide 1–20 identifiers after splitting commas, with no empty tokens.' }
{ reason: 'upstream_rejected', code: InvalidParams, when: 'The registry rejected the request as malformed', recovery: mode-agnostic in the contract; the throw site sends a hint branched on the mode that built the query — see decision 28 }
```

`conflicting_location` is checked ahead of `invalid_state`, so combining a bogus `state` with another location mode reports the mode conflict. `conflicting_limit` is checked last of the input guards, so a location-mode mistake is always reported ahead of a filter mistake — the order `aviation_get_pireps` uses for `conflicting_distance`. `upstream_rejected` is not an input guard: it is raised from the upstream call itself, and only for the one classification a malformed request produces (decision 28).

**Enrichment contract** — three disclosures on disjoint modes (decisions 18, 22, 24, and 36):
```
truncated:    boolean         // always — true when the draw hit the 400-row upstream cap
shown:        number          // always — stations returned, after any state filter and any limit
cap:          number          // only when truncated — the upstream row maximum applied
upstreamRows: number          // retained optional compatibility field; complete state mode does not emit it
limited:      boolean         // only when the call supplied a limit — true when it withheld matching stations
matched:      number          // only when limited — stations that matched before the limit selected from them
requested:    string[]        // station_ids mode — the identifiers as the caller spelled them, trimmed
returned:     string[]        // station_ids mode — the requested identifiers that resolved
partial:      boolean         // station_ids mode — true when a requested identifier resolved to nothing
missing:      string[]        // station_ids mode — only when non-empty
notice:       string          // whichever disclosures fired — cap, limit, more than 110 area stations with no limit, missing identifiers, or unavailable supplementary variation
```

Only `bbox` can reach the stationinfo row cap. Both `bbox` and `state` accept a `limit` and carry the size sentence; only `station_ids` has a request to reconcile. `returned` and `missing` deduplicate case-insensitively under the first token spelling, matching the registry's own `id`. Commas split entries before per-token trimming, and the expanded list retains the twenty-identifier bound; empty tokens and excess tokens raise `invalid_station_ids` after the existing mode/limit guards.

Bbox cap detection reads the drawn row count before any limit. State snapshots are complete and always set `truncated: false`; `upstreamRows` remains advertised for compatibility but is not emitted by state mode. An empty valid state selection stays `station_not_found`; a failed snapshot fetch or validation is an upstream availability error, never an empty result.

---

## Design Decisions

**1. `fltCat` is returned by the API — no client-side computation needed.**
The AWC METAR endpoint returns `fltCat` directly in the JSON response. Initial assumption was that flight category would need to be computed from ceiling + visibility; it doesn't. This simplifies the service layer significantly.

**2. The AIRSIGMET endpoint has no type filter, and serves no AIRMETs at all.**
During live probing, `type=airmet` and `type=sigmet` returned the same 15 convective SIGMETs. That was first read as fair weather — no AIRMETs active at query time — and the reading was wrong. `/airsigmet` defines no `type` parameter, and the AWC API answers HTTP 200 while silently dropping query keys it does not recognize, so the filter never applied; the deprecated plural `types=` is equally inert. Re-probed with `hazard=conv`, the bodies with `type=airmet`, with `types=airmet`, and with neither are byte-identical, while `hazard=turb` returns 204 and `hazard=nonsense` returns 400 — the endpoint honors the parameters it defines, so `type=` is being dropped rather than applied and matched.

The endpoint cannot return an AIRMET under any parameter: its schema titles it "Domestic SIGMETs" and pins `airSigmetType` to `enum: [SIGMET]`. CONUS text AIRMETs no longer exist — NWS Service Change Notice 24-92 retired them effective 2025-01-27 1900Z in favor of the Graphical AIRMET, with Alaska and Hawaii unaffected — and AWC serves the replacements on separate endpoints (`/gairmet`, `/airmet`) whose shapes do not fit this tool's output schema. So the dead `type=` key comes out of the URL, and an AIRMET request is rejected with a typed reason instead of being answered with SIGMETs. Restoring the capability behind real sources is #29.

**3. No geocoding — ICAO IDs are the interface.**
The AWC Data API does not geocode. All tools take ICAO station IDs or coordinates as input. `aviation_find_stations` provides the lookup from human-readable names via bbox/state queries. Agents needing "nearest airport to lat/lon" should chain with `openstreetmap-mcp-server`.

**4. State membership follows the complete registry.**
The API does not accept a `state` query parameter for `stationinfo`. A state search selects US records by source state assignment from the complete registry snapshot (decision 39), rather than approximating membership geographically.

The supported set covers the 50 states plus DC. DC's registry includes `WASD2`, an identifier-less mesonet site; nearby KDCA, KIAD and KBWI carry VA or MD. Territories remain unsupported because upstream represents them by country rather than a US state assignment; use bbox.

Validation lives in the handler rather than a schema `z.enum()`: an enum mismatch is raised by the SDK transport as JSON-RPC -32602 before the handler runs, which bypasses the tool's typed `reason`/`recovery` contract.

**5. PIREPs use `icaoId: "KWBC"` for the center — not the station queried.**
All PIREP responses have `icaoId` set to `KWBC` (the collection center), not the station the search was centered on. The actual location is in `lat`/`lon`. This is a quirk of the API and should be documented in the service layer.

**6. Advisories bbox filtering is client-side, and it is the only filter that stays here.**
The advisory endpoints do not expose a bbox filter. The service fetches the applicable active products and tests each geometry part's bounding envelope, unwrapping consecutive longitudes across the date line so a 179°E/179°W area does not falsely match Greenwich. Multipart rings remain separate. The result can be large, especially with international products; the caller can select a product/hazard or explicitly bound output with `limit` (decision 38).

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

*Never drop a value the structured result carries.* Coordinates render at the resolution AWC published — no fixed decimal count in either direction, since `toFixed` truncated the 5-decimal station coordinates that make up most of the `stationinfo` feed and padded 1-decimal ones into false precision. The single shared renderer rounds at 6 decimal places (~0.11 m, finer than any AWC endpoint publishes) purely to collapse float representation artifacts such as K2S8's `47.75419998168945`. A hazard layer renders each bound it has, so a turbulence report giving only a base keeps that base rather than losing it to a range that cannot be drawn. A TAF period's undecoded text renders on a line of its own rather than vanishing with the decode (decision 32).

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
Stationinfo bbox, METAR bbox and PIREP queries can reach AWC's 400-row ceiling, and the OpenAPI schema exposes no pagination. Detection reads the draw before any local reduction or limit; a returned count below 400 cannot prove the draw was uncapped. State membership instead comes from the complete registry (decision 39), outside this API cap.

Cap disclosure does not automatically reassemble bbox or weather queries. The caller paces smaller queries and unions their results; a larger response limit cannot recover rows the upstream never served. Complete state membership uses a separate metadata snapshot because registry state assignments cannot be inferred reliably from geography.

*Every suggestion names only levers the same call can use.* This holds for cap guidance, empty-result hints and notices, partial-batch notices, and declared recoveries alike. A lever the call cannot pull sends the caller into a rejection or a no-op, so a suggestion is scoped by the search mode and by the schema bounds of the value it moves:
- `distance_nm` is offered only on a `station_id` search, since it is `conflicting_distance` beside a `bbox`.
- A different `bbox` is offered only on an area search.
- A shorter `hours` is offered only above the minimum of 1, and a longer one only below the maximum of 12.
- A smaller `distance_nm` is offered only above the minimum of 10, and a larger one only below the maximum of 500.
- A widened `flight_category` is offered only while some category is still unnamed.

The rule is the one `min_intensity` and a pushed altitude band already followed — a lever already pulled is not offered back — widened to levers the mode or a bound rules out. A declared `errors[]` recovery is static and cannot see the call, so it states the mode-scoped form of every lever ("a larger distance_nm on a station_id search, a larger bbox on an area search"), and the throw site sends the branched hint — decision 28's split between contract and throw site.

What the rule changed:

| Tool | Site | Change |
|:--|:--|:--|
| `aviation_get_pireps` | Cap guidance, and the recovery for an altitude-emptied capped page | Scoped by mode and by the `hours` minimum |
| `aviation_get_pireps` | `no_pireps_found` hints (plain, upstream-narrowed, altitude-emptied) and its contract recovery | Scoped by mode and by the `hours` and `distance_nm` maxima; the radial hint with both levers usable is unchanged |
| `aviation_get_metar` | Cap guidance | Leads with the quadrants at `hours: 1` |
| `aviation_get_metar` | Empty-box hint, the missing-station notice, and the `no_stations_found` contract | Drop "raise hours" / "Widen hours" at the maximum of 12 |
| `aviation_get_metar` | Filter-emptied notice | Says only "Drop" when all four categories were named |
| `aviation_find_stations` | `station_not_found` | Branched by mode: an area search is told to widen the box or use an explicit bbox, not to "use bbox or state"; an identifier lookup keeps its hint |

Suggestions checked against the rule and already correct:

| Tool | Site | Why it holds |
|:--|:--|:--|
| `aviation_get_pireps` | `station_not_recognized` | Raised only on a `station_id` search, and names `bbox` as a replacement search |
| `aviation_get_pireps` | `conflicting_distance`, `missing_location`, `conflicting_location`, `invalid_bbox`, `invalid_altitude_range` | Name the fix for the call as sent |
| `aviation_get_pireps` | The limit notice and the size sentence | Offer `min_intensity` only when unset; the size sentence fires only with no `limit` |
| `aviation_get_pireps` | The altitude-band note | An altitude bound is usable in both modes |
| `aviation_get_metar` | The `station_ids` empty hint | Names no widening lever |
| `aviation_get_metar` | The limit notice and the size sentence | Survey mode only; `flight_category` is offered only when unset |
| `aviation_get_metar` | `conflicting_*`, `missing_location`, `invalid_bbox` | Name the fix for the call as sent |
| `aviation_get_metar` | The `hours` description's "lower it before narrowing the box" | Describes the parameter for every call, not one at its minimum |
| `aviation_find_stations` | Cap guidance | Bbox mode only; names smaller bbox queries |
| `aviation_find_stations` | `upstream_rejected` | Already mode-branched |
| `aviation_find_stations` | The unresolved-identifier notice | `station_ids` mode only; bbox and state are named as the other search modes |
| `aviation_find_stations` | `invalid_state` | Names bbox for territories |
| `aviation_find_stations` | The limit and size notices | Area modes only |
| `aviation_get_taf` | `no_taf_available` and the missing-station notice | Name `aviation_find_stations`' data_types, which is usable from any call |
| `aviation_get_advisories` | Empty-draw notice | Branched on the stage that emptied it: "widen the bbox, or drop it" only when a bbox emptied a non-empty draw, "drop the hazard filter" only when one was set |
| `aviation_get_advisories` | `invalid_bbox` and `airmet_not_served` | Name the values the tool accepts |
| Preflight prompt | Its one suggestion ("widen it further if the filed route leaves that box") | Applies to the advisories bbox it just built |
| `src/index.ts` instructions | Their pointer to `aviation_find_stations` | Holds for any call |

Detection is `drawn rows >= 400`, read before local filtering or a limit. A genuine 400-row complete API draw is conservatively reported as capped. State snapshots are not API draws and never use this test.

The two tools' empty-result errors remain asymmetric. `no_pireps_found` can distinguish a capped page narrowed to nothing by an altitude filter. `station_not_found` needs no capped-empty branch: bbox stationinfo has no local membership filter and state membership uses the complete snapshot.

**19. A PIREP flight level is trusted only where the raw group corroborates it, and the narrowing AWC can express is sent upstream.**
Two changes on the same premise: upstream's free-text fields are read for what they can actually establish, and the query is narrowed where the narrowing still counts.

*The zero sentinel is settled by a round-trip, not a token list.* Decision 10 established the raw `/FL…/` group as the discriminator and enumerated the three tokens sampling had found. The enumeration cannot hold — the field is pilot-entered free text, and a 1,236-report live corpus carries call signs (`/FLB78X/`), station identifiers (`/FLKGRR/`), aircraft types (`/FLP28A/`), transpositions (`/FLDRD/`), and cloud groups (`/FLBKN0/`), none of them in the list and all resolving to `fltLvl: 0`. A shape test of "not digits and not `SFC`" does not hold either, and fails in both directions. It misses `/FL2130/`, `/FL1000/`, `/FL4000/`, and `/FL0303/` — all digits, all resolving to `fltLvl: 0`, four of them against six non-numeric cases in the same corpus, so the numeric failure is comparably common rather than a corner. And it destroys `/FL030-000/`, which is neither digits nor `SFC` and which AWC parsed correctly to the midpoint `fltLvl: 15`.

What separates the two is whether the group round-trips: a group AWC read produces the value it names, so a `fltLvl` of 0 is a reading only where the group is a zero-valued digit string. The test is therefore scoped to `fltLvl === 0` and cannot touch a report with any other altitude, which is what keeps `/FL030-000/` intact. `/FLSFC/` stays excluded on its own terms — the substituted field elevation is a real altitude, and it is genuinely 0 at a sea-level field. A report with no `/FL` group at all (an AIREP encodes `F370` instead) has nothing to contradict its value and keeps it.

*Altitude and intensity are pushed to AWC.* Both filters previously ran on the page the 400-row cap had already cut, so they could only subtract from what survived truncation. `/pirep` declares `level` and `inten`, and filtering before the cap changes which reports exist to filter: a CONUS box at `age=12` returns a capped 400 rows holding 41 reports in the FL160–220 band, where the same query with `level=190` returns 217 rows — uncapped — with 199 in that band.

`level` is not a range. AWC documents it as "Level +-3000' to search", and `level=190` draws exactly FL160–220 against the live endpoint, so it does not map onto `altitude_min_ft`/`altitude_max_ft`. It composes with them instead: where a centre exists whose upstream band contains the requested one, the existing client-side filter trims that superset to the exact range. Exposing `level` directly was rejected — it would give the tool two ways to say one thing, and the upstream band width is an implementation detail of how the request is built rather than a contract the caller should learn. The client-side filter still runs after the upstream one, which is also what keeps the `fltLvl: 0` reports `level` admits out of a bounded result.

Fitting the 6,000 ft width is necessary but not sufficient, because the centre is a whole flight level. Rounding shifts the band by up to 50 ft, so a near-full-width request can be left with a sliver outside what gets drawn: 17,950–23,950 ft rounds to `level=210`, which draws FL180–240 and misses the bottom 50 ft. Reports in a sliver go undrawn rather than trimmed, which is a silent loss rather than a filter — so the centre is computed and then checked, and a band that does not contain both bounds is not pushed at all. That containment check is the whole test: a band wider than 6,000 ft has no centre that holds it and fails the same check, so there is no separate width guard beside it. A wider band, a single bound, and a sliver all behave exactly as before.

`inten` has no existing input to compose with, so `min_intensity` is a new one. It selects **reports**, not layers: a live `inten=mod` draw returns reports whose layers include `NEG` and `SEV` alongside the `MOD` that matched, so the description says so — a caller reading it as a layer filter would see a `NEG` layer in a moderate-turbulence result and conclude the tool is broken.

Neither parameter changes what the cap disclosure means. They narrow what AWC draws, so the drawn row count decision 18 reads is still AWC's own page size, and `truncated` still reports that page rather than a post-filter count.

**20. A synthesized icing layer is dropped rather than repaired, and the test is per layer; a sky-clear cloud layer drops its synthesized bounds.**
AWC's decoder adds an icing layer to reports whose text never mentioned ice — `NEGclr`, an empty type, and bounds borrowed from elsewhere in the same record. A live `BNA UA /OV BNA/TM 2134/FL330/TP B763/SK SKC/TB NEG/RM ZME62` carries no `/IC` group at all yet arrives with icing bounds of `330`/`600`, which are its own `SK SKC` cloud layer — so normalization published a reported icing layer spanning 33,000–60,000 ft for a report that never mentioned ice. That is worse than an empty result: the empty array already means "the pilot said nothing either way", and a synthesized default contradicts it on a safety-relevant field where clear and rime ice are handled differently.

*The concatenation is the marker, and dropping is the only honest response to it.* Across a 1,900-report corpus every `icgInt` value is either a clean code — `NEG` 122, `LGT` 79, `MOD` 13, `TRC` 5, `LGT-MOD` 4 — or the concatenated `NEGclr`, 126 of them. Stripping the suffix and keeping the layer is the tempting repair and it is the wrong one: the suffix is the layer's *only* tell, so a stripped layer publishes borrowed bounds as `NEG (24,000–60,000 ft)`, indistinguishable from a pilot's observation, where the raw form at least announced itself as odd. Removing the sole disclosure a bad row carries is a regression even when the row was already bad. Dropping is also the safe direction under decision 13: an omitted negative report costs the caller a "no ice reported", while a kept synthetic one asserts an altitude band nobody flew.

*The test is per layer, not per report.* Every concatenation in the corpus sits in the second slot — `icgInt1` is a clean code in all 223 of its occurrences — and 18 of them ride on reports whose first slot is a genuine reading, so a report-level test publishes the synthetic layer beside the real one. One report carries a concatenated second layer as its *only* icing (`TIX … /IC +8C`, an undecodable stray temperature), where a report-level test would publish a wholly invented negative report.

*One mechanism, not two.* A raw-text `/IC`-group gate was the first shape of this fix and earns no place beside the per-layer test: every layer on a report carrying no icing group is concatenated, 108 of 108, so the gate catches a strict subset of the same 126 and would never fire on anything the layer test missed. Two mechanisms guarding one concern is maintenance cost with no coverage behind it.

Two-part ranges carry no trailing lowercase run and are preserved unsplit, matching turbulence. Genuine second layers exist and survive — a live `icgInt2` of `LGT`/`MIXED` and one of `MOD`/`MIXED`, both clean codes.

*The same synthesis reaches the cloud layer, on `SKC`, and gets the same answer.* AWC decodes `/SK SKC` into a layer whose `base` is the report's own altitude — or the top of the layer beneath it, on `SK OVC011-TOP017/SKC` — and whose `top` is always `60000`: every one of the 21 `SKC` layers in a 799-report corpus had that shape, and `CAD … /FL050/ … /SK SKC` arrives as `5000`/`60000`. The zero-as-unknown rule (decision 10) never catches it, so a clear-sky report rendered as `SKC 5,000–60,000 ft`, an extent nobody reported. A sky-clear cover states that there is no layer, so it has nothing to bound: `SKC` and `CLR` publish `base_ft` and `top_ft` as null whatever upstream attached, and render as the cover alone. The rule is per layer, as the icing test is, so a real layer beneath a stacked `SKC` keeps its bounds. It keys on the cover rather than on the `60000` top because the cover is what makes any bound meaningless; `CLR` needs no repair today (its one occurrence in the corpus was `0/0`, as were all 11 `VMC`/`IMC` markers) and is covered by the same statement. The layer is kept, unlike a synthesized icing layer, because the cover itself is the pilot's report — only the bounds were invented.

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

`/airsigmet`'s own `hazard` parameter sidesteps it: its schema enumerates `conv | turb | ice | ifr`. Passing the tool's own spelling through verbatim rejects `CONVECTIVE` and `TURBULENCE`, while `ICING` and `IFR` case-fold onto recognized tokens and can answer 204. URL assertions therefore pin the mappings rather than treating a successful empty response as proof of a correct filter. Source-specific documented mappings live in `advisory-products.ts`; `isAdvisoryHazard` narrows the public vocabulary and `supportsAdvisoryHazard` distinguishes incompatible product/hazard pairs (decision 38).

*The bbox does not follow, and the split is not an inconsistency.* `/airsigmet` defines no bbox parameter (decision 6). Pushing the axis that has an upstream parameter and keeping the one that does not is the whole rule.

*The empty draw is disclosed by stage.* A draw of zero after product/hazard selection precedes bbox and cannot be blamed on geography. A positive draw may contain matches, located rows outside the bbox, and unlocated rows whose intersection is unknown. `drawn`, `matched`, `returned` and `unlocated` distinguish those stages even when some matches survive. Counts describe readable sources only, with `coverage`/`partial` carrying unavailable products and skipped rows. A malformed body is a failed source with a null count, never a zero draw.

*A hazard-scoped zero says nothing about other hazards.* AWC answers the same HTTP 204 for a hazard class with nothing active and for a feed with nothing active at all. The notice names the applied hazard and readable sources, then offers dropping the hazard filter; it never asserts other classes are active. No second unfiltered request is made solely to sharpen that message.

**24. A caller's `limit` is a third number, and it is disclosed apart from the row cap.**
Every parameter on `aviation_get_pireps` and `aviation_find_stations` before this one changes *what is searched*, so the only way to spend fewer tokens was to ask a different question — a smaller box discards the corridor the caller asked about in order to see more of a corner of it. `limit` bounds the response instead, leaving the query identical. A live `state: "CA"` draw held 270 stations and was not capped, so no existing disclosure fires and nothing narrows without changing the question.

*The two tools share one vocabulary, because they are one mechanism.* Input `limit`; enrichment `limited` and `matched`; the same wording for what each says. A caller who learns the concept on one tool recognizes it on the other, and the alternative — a per-tool spelling — makes two lessons out of one.

*A result can now be short for two independent reasons, and conflating them costs the caller a query.* Decision 18's `truncated` says AWC stopped at 400 rows and the rest were never drawn; `limited` says every matching row *was* examined and the caller asked to see fewer. Read as a cap, a limit sends the caller off to narrow a search that had no need of it. They co-occur — a CONUS PIREP box at `hours=12` caps at 400 and can still be limited to 10 — and the three counts are then all different: 400 drawn, however many survived the client-side filter, and the number returned. `matched` is the middle one and is scoped to what it was counted from, saying "inside the capped page" when the capped page is what it counted; the rows the cap dropped were never examined, so no count can include them. The framework's `ctx.enrich.total()` was rejected for exactly this: it writes `totalCount` and renders "N total", which asserts an area-wide total on a page that is a slice of the area.

*One `notice` carries both, in turn.* `ctx.enrich.truncated()` writes `notice` last-wins, so the two disclosures compose into one string rather than overwriting each other — the cap states its own case and its lever, then the limit states that it is not the cap.

*`limited` is emitted only when a limit was supplied.* Decision 17's affirmative-completeness rule earns its place where a count cannot establish the fact; here a caller who set no limit already knows none applied, and `truncated: false` already affirms the draw was whole. Emitting it unconditionally would also add a field to every existing caller's response, which this addition should not do. A caller who *did* set one is owed the affirmative: `limited: false` separates a limit that withheld nothing from one that bit.

*Without a limit, the source order is retained.* Large area results get the size notice defined in decision 36. `shown` counts rows after any filter and limit; a cap notice describes the source draw independently of that returned count.

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

*The schema rejects empty or whitespace-only entries.* Its `/\S/` grammar deliberately accepts broader registry IDs. After comma expansion, the handler also rejects empty tokens and lists exceeding twenty identifiers (decision 39); it never imposes the weather tools' four-character ICAO shape on buoys and mesonet sites.

**28. An upstream rejection is re-raised as a declared reason, and the endpoint and body stay in the logs.**
Where AWC still rejects a request the framework's status ladder classifies the 400 as `InvalidParams` and annotates it with the redacted endpoint in the message and the upstream response body in `data`. The query string is redacted before it reaches the client, so the identifiers themselves do not escape — but the origin, the path, and AWC's own error text do, and none of them says what the caller should change. The handler re-raises that one classification as `upstream_rejected` with the contract's recovery hint, threading the original through as `cause` so the upstream detail stays in the logs and out of the payload.

*Only that one code is converted.* A 5xx is still `ServiceUnavailable`, a timeout still `Timeout`, an abandoned request still `RequestCancelled`; reading any of them as malformed input would tell a caller to fix an input that was fine. The narrow catch is also why this does not contradict the handlers-throw rule — nothing is swallowed, and one classification is translated because the framework's generic one leaks upstream internals on a public surface.

*The hint is branched on search mode.* Identifier rejection guidance names embedded spaces and unsupported separators; bbox rejection guidance names a smaller box or direct identifiers. Complete-state snapshot failures are availability errors, so they never blame the caller's valid state code. The contract retains mode-agnostic recovery wording, overridden at each rejection site.

*The 200-with-error-body path is not in scope and is left as it is.* `fetchJson` has a branch for AWC answering HTTP 200 with `{"status":"error", …}`, which passes that text through as a `ServiceUnavailable` message. It is unreachable for the failure recorded here — AWC pairs its error body with a 400, so the fetch throws first — and it is shared by all five tools, so tightening it belongs to a change that considers all of them.

**29. A lookup matches the registry's own identifier, and only one wrong shape is diagnosable.**
The tool advertised that station IDs "must be 4-letter ICAO format" and that "the upstream API only accepts ICAO format." Both are false, and decision 27 had already committed to the opposite by imposing no shape at the schema. `stationinfo?ids=NUET2` (a mesonet site) and `ids=46114` (an NDBC buoy) each return their row; what the lookup matches is the registry's own `id`, which for an airport happens to be its ICAO identifier and for other sites is whatever that site carries. The description, the field description, the `station_not_found` recovery hint, and the README now say that instead. Nothing about the schema or the request changed — the tool was describing itself wrongly, on the exact field this batch reworked, while the same release documented the opposite.

*The unresolved-identifier guidance splits on IATA, not on length.* It used to divide the missing identifiers into ICAO-shaped and everything else, telling the second group their format was wrong. Under a registry-`id` match that is a misdiagnosis: an unresolved four-character identifier and an unresolved five-character one are both simply absent, and `ids=46999` answers the same HTTP 204 as an unlisted ICAO identifier, so shape was never the discriminator. One shape is still worth naming on its own — a 3-letter IATA code never resolves, even for a station whose entry lists one — so that case keeps its own line and everything else is reported as absent from the registry.

*This is the ordering change's consequence, which is why it lands here rather than later.* Decision 26 moved identifier-less sites into the visible tail of a limited result. A caller who meets a buoy there and tries to look it up by the identifier they were shown was, until this change, told by the tool's own description that only ICAO identifiers resolve.

**30. Flight context is optional, and an absent one is named in the briefing rather than refused at the schema.**
`departure_time`, `cruise_altitude`, and `route_waypoints` are the flight context decision 7 describes. All three are optional, and requiring them was rejected: the prompt's three existing args are the only ones any current call sends, so a required field fails every one of them, and it buys nothing the optional form does not. The synthesis step already reports what it could not assess — a missing departure time or cruise altitude is exactly such a gap, and a schema rejection tells the caller strictly less than a briefing that names it.

*Absence is disclosed twice, at the step and in the summary.* The step that would have used the argument says so where the instruction would have gone — the TAF step states no forecast period can be tied to a flight window, the PIREP step that the search cannot be bounded to a cruise level, the advisories step that they cannot be bounded to a route corridor — and each also appears under **Gaps and uncertainty** in the summary, beside the standing instruction to report any station that returned no data and anything the tools flagged as partial, truncated, or limited. The step line is where the model is deciding what to call; the summary line is what the reader ends up holding. One without the other loses half the disclosure.

*Identifier arguments enforce the weather tools' shape.* `departure_icao` and `destination_icao` require four ASCII letters or digits, and `alternates` requires a comma-separated list of the same identifiers, with surrounding whitespace allowed. Decision 31 defines the shared case acceptance and normalization. `aviation_find_stations` deliberately does not get this pattern (decision 27): it matches the registry's own `id`, which for a buoy or mesonet site may have another shape.

*The PIREP band is ±3,000 ft because that is the width AWC searches.* Decision 19 established that `/pirep`'s `level` parameter is a centre with a fixed ±3,000 ft band and that `aviation_get_pireps` pushes the bounds upstream only when a centre exists whose band contains them. A band derived as cruise ±3,000 ft is that shape, so the briefing's own instruction is one the tool can push — which matters because pushing it is what keeps the query off the 400-row cap. Any other half-width would have produced a band the tool has to filter client-side out of a possibly-cut page.

*The fit is exact rather than generous, so the centre is put on the flight-level grid first.* A band of precisely the upstream width is contained by one centre only — its own midpoint — and that centre is a whole flight level, so bounds of 6,500–12,500 ft send `level=95` while 6,501–12,501 ft fit no centre at all and are filtered client-side. That is a property of `aviation_get_pireps`, and stays one for any caller passing such a band directly. The prompt does not hand it one: the cruise altitude is rounded to the nearest 100 ft before the band is derived, so a planned 9,501 ft instructs 6,500–12,500 ft rather than a band nothing can push. The header still reports the altitude as supplied, and the instruction names the rounded centre only where it moved, so the briefing never quietly redescribes the flight. Where the ceiling collapses the band to a single altitude, the instruction says that outright rather than naming a centre that sits outside the bounds printed beside it.

*Both ends are then clamped to the range the tool accepts* — 0 ft to FL600 (decision 33) — rather than going outside it: the floor is the correct trade against printing `altitude_min_ft: -1500` into a briefing, and the ceiling against printing a top the tool then rejects. Rounding precedes the clamp so the clamp keeps the last word at either end, and neither step can reorder the bounds, since both are derived from one centre and passed through the same monotonic clamp. Clamping both ends rather than one is what keeps the band ordered in the first place: `cruise_altitude` admits six digits, so clamping only the top would leave the floor above it and instruct a band the tool refuses as inverted; the same clamp on both ends collapses that case to a degenerate band at the ceiling, which is valid and pushes as `level=600`. Every band the prompt can derive is therefore ordered, inside the accepted range, and pushable — verified exhaustively against `pushablePirepLevel` across all 1,000,000 cruise altitudes the six-digit input admits, with a sampled sweep over both clamp regions and the rounding boundaries standing guard in the test suite. The prompt mirrors the tool's bound as its own constant, as it already mirrors each station tool's per-call limit, and a test pins the two together so moving one without the other fails there rather than in a briefing.

*A route waypoint is a coordinate, and it reaches the briefing as a bbox or not at all.* Nothing in this server geocodes and `aviation_find_stations` has no lat/lon-plus-radius input (decision 3), so `route_waypoints` takes decimal-degree pairs only — no place names, no identifiers — and the generated text turns them into an `aviation_get_advisories` bbox. A separate bbox argument was rejected as a second way to say one thing: the bbox is the waypoints' envelope, so two corner waypoints express one directly, and one argument leaves no precedence rule to invent. The envelope is widened by 1° per side, because KSEA→KJFK is within half a degree of latitude end to end and a bare envelope of two such points is a sliver no advisory polygon intersects — the margin is what makes the box a corridor rather than a line, and the text says so and tells the reader to widen it further for a route that leaves the box. The margin is also the only thing that can overflow a valid coordinate: waypoints are range-checked at the schema, so the clamp to ±90/±180 exists for a route near a pole or the antimeridian and never to quietly repair a bad input.

*The station list is chunked to each tool's own limit, because the default route already exceeds one.* `aviation_get_metar` bounds `station_ids` to 10 and `aviation_get_taf` to 4, while `alternates` is unbounded — so departure, destination, and three alternates is five stations and an unchunked instruction walks the model into a schema rejection partway through a brief. The instruction splits into as many calls as the bound requires and states the bound when it does; at or under the limit the single-call wording is unchanged.

*Nothing about the departure time reaches a tool.* No endpoint here takes a time parameter, so alignment is guidance in the generated text: select the `forecast_periods[]` entry whose `from`/`to` window covers the departure time from what `aviation_get_taf` already returned. The argument's ISO 8601 UTC shape is the shape those fields are published in, so a period boundary can be pasted back in verbatim. A UTC offset is rejected rather than converted — aviation time is Zulu, and silently reinterpreting an offset is how a briefing ends up read against the wrong period.

**31. Weather station identifiers are four ASCII letters or digits, accepted in either case and normalized to uppercase.**
The weather tools and preflight identifier arguments advertise `/^[A-Za-z0-9]{4}$/`. Digits preserve AWC's US airport identifiers (`K0S9`, `KS52`, and TAF station `K36U`); accepting either ASCII case matches AWC's case-insensitive lookup. Validation precedes normalization, so Unicode case expansions such as `kßa` cannot become an accepted `KSSA`. Each handler uppercases before querying or reconciling, and the prompt uppercases before generating every call and header. Exact-string reconciliation therefore compares canonical IDs without reporting a lowercase request as missing.

Three- and five-character values remain invalid. Direct IDs retain their whitespace rejection, while comma-separated alternates retain surrounding whitespace support. Shape errors name `KSEA` and `K0S9` and direct an IATA/FAA caller to `aviation_find_stations` with `state` or `bbox`; no mapping is inferred. Station finder's broader registry-ID grammar is unchanged (decision 27).

An identifier AWC's PIREP endpoint does not know meets the declared `station_not_recognized` reason rather than a bare 400 (decision 33).

**32. Text the TAF decoder left undecoded is published where AWC attached it, and never parsed.**
AWC's TAF decoder emits at most three cloud layers per period and puts the rest into a per-period `notDecoded` string that normalization never read, so the leftover reached neither response surface and `raw_taf` was its only trace. It is usually the highest layer and often the only broken or overcast one, so the decoded period lost its ceiling: live `LGKR`'s `PROB40 TEMPO … SCT016 FEW018CB BKN020 BKN080` decodes three layers and drops `BKN080`. 22 of 3,820 periods across seven regional draws carried a non-empty value, mostly outside CONUS, and not all of them are cloud groups — `LFRB`'s is `VV///`. `forecast_periods[].not_decoded` now carries the trimmed text, null when empty or whitespace-only, and `format()` renders it on its own line after the clouds, marked as a partial decode and pointing at the raw TAF.

*It is neither reassigned nor parsed into `clouds`.* Upstream attaches the leftover to the wrong period: on `LGKR`, `VOML`, and `LFRB` the text from a `TEMPO` group surfaces in the next period's `notDecoded`, though that period's own text decoded in full. Moving it back would be the server guessing which period a layer belongs to, and parsing it would add a fabricated layer on top of the guess (decision 13). So the text stays on the period AWC attached it to, and the field description says it can belong to the group before.

*METAR has the smaller form of the same limit and no field to carry it.* AWC decodes at most four METAR layers — `KPHX … SCT034 BKN043 BKN060 BKN140 BKN250` arrives with four entries and `BKN250` gone — and the record has no `notDecoded`. `aviation_get_metar`'s `clouds` description therefore names the four-layer limit and `raw_metar` as the complete source, as `aviation_get_taf`'s names three and `not_decoded`; neither claims to hold every layer.

**33. An AWC rejection carries AWC's own text, and an unrecognized PIREP center is a declared reason.**
AWC answers a request it rejects with HTTP 400 and `{"status":"error","error":"…"}`. `fetchWithTimeout` throws on the status before `fetchJson` reads the body, so every tool surfaced a bare `Fetch failed … Status: 400` and left the explanation in `data.body`. Decision 28 recorded that the 200-with-error-body branch never sees this case and left the fix to a change that considered all five tools.

*`fetchJson` now surfaces AWC's text as the message on a 4xx carrying the envelope, for every endpoint* — `AWC API error: Invalid location specified`. The code the status mapped to is kept (`InvalidParams` for a 400), so the error stays non-retryable; `data` is untouched and the original error rides as `cause`. A 5xx is still transient and retried on its own terms, and a 4xx whose body is not the envelope keeps the fetch-failure message, since there is no AWC text to surface. The 200-with-error-body branch is unchanged. A tool that bubbles the rejection now carries AWC's text; the two that convert it keep their own message and leave AWC's text in the cause — `aviation_find_stations` as `upstream_rejected` (decision 28), and `aviation_get_pireps` on a `station_id` search, below.

*`aviation_get_pireps` declares `station_not_recognized`.* The PIREP endpoint resolves the `id` center itself and answers `Invalid location specified` for an identifier it lacks — live `pirep?id=KISN` (closed in 2019), where the replacement `KXWA` answers 204 and a `bbox` over the same area returns reports. The handler reclassifies that rejection by AWC's own text, on a `station_id` search. It becomes a `NotFound` whose recovery names `aviation_find_stations` and `bbox`, with the original as `cause`, logged at `notice` as `station_not_found` is. A `bbox` search sends no center and keeps the rejection as it was; a 5xx, a timeout, and an abandoned request bubble as classified; and an empty result at a recognized center is still `no_pireps_found`. The catch is narrower than the one decision 28 set on `aviation_find_stations`, which converts every rejection out of `fetchStations` whichever mode built the query — here only the rejection naming the center converts, for the reason below. The recovery points at the two moves that work without a recognized center.

*The text is the discriminator, because the classification is not.* `/pirep` refuses other parameters under the same HTTP 400 and the same `InvalidParams`, saying something else — an out-of-range `level` answers `Invalid value for level`, as below. Reading the code alone therefore reported a working station as unrecognized whenever any other parameter was refused, pointing the caller at `aviation_find_stations` for an identifier that was never the problem. Schema bounds do not close that gap — they govern what this server sends, not what AWC rejects — so the catch matches AWC's unrecognized-center text, and every other rejection keeps the text `fetchJson` surfaced, on a radial search exactly as on a bbox one.

*The altitude bounds run 0 ft to FL600, and both ends answer the same problem.* `pushablePirepLevel` centres the requested band, so an unbounded band derives an unbounded centre — and the caller then pays for a parameter they never set and cannot see. The two ends fail differently, and neither failure is one a caller can act on. Below sea level the centre goes negative and AWC rejects it outright: live, `level=-1`, `level=-15`, and `level=-60` all answer HTTP 400 `Invalid value for level`, where `level=0` returns reports. Above FL600 the rejection is not immediate — `level=32768` is still accepted — so a band centred high enough draws a silent empty result about an altitude no pilot report occupies, and only a far enough one 400s (`level=65535` and `level=100000` do; the cutoff sits between 32,768 and 65,535 and is not worth pinning, since FL600 caps the centre at 600). A silent nothing and an unexplained rejection are both worse than a bound the caller can read, and FL600 already sits above the altitude any pilot report carries — so both ends belong on the advertised schema, where a caller sees them before the call rather than in a 400 after it (`api-errors`' rule for a purely structural bound). Both field descriptions restate the range, since a schema rejection carries the framework's `invalid_arguments`, never a declared reason of this tool's.

*The ordering of the two bounds stays in the handler.* `invalid_altitude_range` is a bound the caller is expected to recover from and carries its own recovery hint, so it keeps the declared reason rather than moving to a schema refinement — the same split `api-errors` draws. A band inverted at the extremes of what the schema admits still reaches it.

**34. A METAR area survey is one observation per station, reduced after the draw.**
`aviation_get_metar` took a list of 1–10 identifiers, so "which airports along this route are IFR right now" meant an `aviation_find_stations` bbox search followed by one call per ten stations — a 1°×1° box around Seattle holds 17 stations and a route corridor holds a few hundred. `/metar` accepts the same `bbox=minLat,minLon,maxLat,maxLon` the other endpoints take, so the box reaches the observation endpoint directly.

*The draw is every observation, and no upstream parameter narrows it to the latest.* A live 1°×1° box at `hours=3` returns 52 rows across 9 stations. The endpoint windows on `hours` and nothing else, and it answers a key it does not define with HTTP 400 `Unexpected query parameter provided` — `mostRecent` and an invented name both rejected, where the sibling endpoints silently drop what they do not recognize (decisions 2 and 8). So the reduction to one row per station happens in the tool, keyed on `observed_at`: a fixed-width ISO 8601 UTC string, so comparing two of them as strings compares the instants they name.

*That reduction is also what hides the cap, so detection reads the row count AWC served.* Decision 18's rule applied to a third tool, and for the same reason the state and altitude filters need it: the count the caller receives is stations while the cap is in rows. A WA-sized box at `hours=12` caps at 400 rows covering 61 stations, and 61 against a cap of 400 reads as headroom. `upstreamRows` carries the drawn count where the reduction moved it, as it does on the two tools that filter client-side.

*`hours` is the lever the notice names first, and it belongs to this tool alone.* Elsewhere a capped draw narrows by searching less area; here a wide window spends the cap on repeat readings from the stations already reached rather than on more stations — 400 rows at `hours=12` is under seven observations each from 61 stations. Lowering `hours` buys stations, so it leads, and the quadrant tiling decision 18 describes follows it. At `hours: 1`, the schema's minimum, there is nothing left to lower, so the notice leads with the quadrants alone (decision 18).

*The order is `station_id` ascending, for decision 26's reason.* Observations carry no rank across stations, so a `limit` without a defined order returns a different subset on each identical call. After the reduction the station ID is unique and present on every row, so one key gives a total order with no tiebreak to add, compared code unit by code unit so the order cannot move with the runtime's collation. Unlike `aviation_find_stations` the sort is unconditional rather than limit-gated: the mode is new, so no existing caller's ordering moves.

*The disclosures are mode-exclusive, and that is what made the reconciliation fields optional.* `requested`/`returned`/`partial`/`missing` (decision 17) describe a named batch; `truncated`/`shown`/`cap`/`upstreamRows`/`limited`/`matched` (decisions 18 and 24) describe a drawn area. An enrichment field the handler does not populate fails the effective-output parse if it is required, so the four reconciliation fields are now optional — the advertised `outputSchema` widens every success field regardless, so no existing caller's response changed shape. The `station_ids` mode is otherwise untouched: it returns the draw as served, every observation inside the window, reconciled against the request exactly as before, and rejects a `limit` for decision 26's reason — the caller has already named the set.

**35. A PIREP publishes the temperature, wind, and weather AWC decodes, and `remarks` is renamed `weather`.**
AWC decodes `/TA` into `temp`, `/WV` into `wdir`/`wspd`, and `/WX` into `wxString`, and normalization published only the last — as `remarks`. The temperature was recoverable only by re-parsing `raw_pirep`, which matters most on icing reports: rime at −14 °C and at +3 °C are different reports. `temp_c`, `wind`, and `weather` now carry all three. Across a 799-report corpus (780 PIREP, 19 AIREP), 55 of 60 `/TA` groups decoded and the other 5 were `/TA UNKN`, 11 of 12 `/WV` groups decoded, and AIREPs filled `wdir`/`wspd` from their own `291/035KT` groups on 15 reports and `temp` from `MS51` on 2 — so each description names the value, not only the PIREP group.

*`wind` is one nullable object, for decision 16's reason.* No report in the corpus carried exactly one of `wdir`/`wspd`, so a pair of nullable scalars would admit states upstream never produces. A gust-suffixed `/WV 03020G30` is left undecoded upstream, which makes `wind` null while `raw_pirep` still holds the group; AWC does not decode a gust, so none is published. It leaves `/WV +/- 5KT` and a single-digit AIREP speed (`252/9 KT`) undecoded the same way.

*A PIREP wind direction is magnetic, and it is published unconverted.* AIM TBL 7-1-18, item 10, defines `/WV` as "Direction in degrees magnetic north and speed in knots" — its own example decodes `/WV 290030` as "wind 290 degrees magnetic at 30 knots" — and AWC passes the value through (`/WV 232049KT` arrives as `wdir: 232`). `direction_deg` therefore says it is the direction as reported, magnetic on a PIREP `/WV`, with no conversion applied. It must not borrow the "degrees true" wording of the METAR and TAF winds, which is correct for those products: a caller combining a magnetic wind with a true track misjudges the headwind and crosswind by the local variation. The AIREP direction group's reference is not stated, since no primary source for it was confirmed; the tool converts neither. Both surfaces carry the distinction. The description scopes its variation advice to a PIREP's direction and says an AIREP's reference is not stated. `content[]` renders a PIREP wind as `232° magnetic at 49 kt`, because it sits beside METAR's true-north `232° at 49 kt`, and leaves an AIREP wind unmarked.

*`weather` holds only what AWC decoded from `/WX`.* Free text the decoder cannot read is dropped or trimmed — `CEILING 017` and `2 SM` return null, `RA FL300 AOB` returns `RA` without its altitude qualifier — and a flight visibility AWC can read (`FV08SM`, `10SM`) lands in `visibility_sm` instead. `raw_pirep` is the only source for the rest, and the description says so.

*`remarks` is renamed rather than redescribed, a breaking output change.* `wxString` is AWC's decode of the `/WX` group and never of `/RM`: all 25 non-empty values in the corpus came from `/WX`, while 371 of the 780 PIREPs carried `/RM` text that appears in no decoded field. A schema reader looking in `remarks` for `DURC` or tops found `RA` — the tool's own test fixture had been written the same way. The value also moves from a bare string to the `{ raw, decoded }` pair `aviation_get_metar` (`present_weather`) and `aviation_get_taf` (`weather`) already publish for the same AWC field, through the same decoder, for decision 14's reason: a decoder is only safe beside the raw group it read. Keeping the name `remarks` on that pair would have compounded the mislabel, and it would have kept the name from a real `/RM` field later. `format()` puts temperature and wind on one line when either is present and renders `**Weather:**` in place of `**Remarks:**`; an absent value is omitted, per decision 13.

Ordinary and urgent PIREP winds receive the magnetic label. AIREP, AMDAR, and unfamiliar source types remain unlabelled because their reference is unverified. `pirep_type` stays an open source string. Decoded `brkAction` is published as nullable `braking_action`: missing, null and blank source values become null, while every nonempty code remains unchanged. No remarks parsing or runway-state inference supplements it.

**36. A large result that set no `limit` names the lever, and no tool defaults one.**
`limited` and `truncated` disclose a result cut by the caller or by the upstream cap, and nothing disclosed one that was large only because no `limit` was set: a 200 nm, 12-hour PIREP search around KORD returned 247 reports and about 147 KB with no notice, and a capped CONUS METAR survey's notice never mentioned `limit`. Past a threshold, `notice` now states the size, that `limit` bounds the response without changing what is searched, and what it keeps — the most recent reports on `aviation_get_pireps` (with `min_intensity` named when the call did not set it), an alphabetical slice by station ID on a METAR survey (with a smaller `bbox`, and `flight_category` when unset, named as the levers that narrow by place or condition), and the first stations by ICAO identifier on an `aviation_find_stations` area search. On a capped result it follows the cap guidance in the same notice. It never appears beside a supplied `limit`, and never in either tool's `station_ids` mode.

*One rule produces all three thresholds.* Each is the largest multiple of 10 whose `structuredContent` fits the framework's `DEFAULT_OUTLINE_BUDGET_BYTES` (24,000 bytes) at the measured per-row cost: 443 bytes per report (421 plus the 22-byte nullable braking field) gives 50, 564 per METAR station gives 40, and 207 per registry station (179 plus the 28-byte nullable magnetic variation field) gives 110. Each compares against rows shown after filtering and limits. These thresholds only add guidance; they never truncate results.

*A default `limit` was rejected on all three tools.* It would end the contract that an omitted `limit` returns every match, and it keeps rows the caller never chose: a METAR survey's first stations by ID are the head of the alphabet (the first 50 of one CONUS draw were all Canadian), and a PIREP recency default drops older hazard reports with no summary of what it withheld (decision 25). The first oversized call therefore still costs what it costs, bounded by the upstream cap; the notice makes the second one cheaper.

*One notice, written once.* Every notice writer is last-wins, including the one inside `ctx.enrich.truncated()`, so each handler assembles the statements that fired — cap, then filter, then limit, then size — and writes the notice once.

**37. A METAR survey filters by flight category after the reduction and before the limit, and a survey the filter empties is a result.**
The common reason to survey an area is to find where conditions are poor, and a survey could only return every station — a CONUS box at `hours=1` is about 350 KB across both surfaces, of which 22 of 340 stations were IFR or LIFR in one draw. `limit` cannot answer it, since it selects by station ID. `/metar` takes no category parameter (an unrecognized key answers HTTP 400 `Unexpected query parameter provided`), so `flight_category` is applied in the tool, to AWC's own `fltCat`: the same draw with `["IFR", "LIFR"]` returned those 22 stations in about 26 KB.

*It runs after the reduction and before the limit.* A station is judged by its latest observation, not by an older reading inside the window, and a limit selects from the stations that matched rather than from the whole survey. A station AWC could not rate (`unknown` — 21 of that draw's 340) never matches, and the notice counts those apart, since no filter can reach them and a caller surveying for poor conditions should know they exist.

*It is disclosed as a stage, by decision 18's rule for a client-side filter.* `surveyed` carries the station count before the filter whenever the filter was supplied — equal to the count after it (`matched` where a limit then withheld stations, `shown` otherwise) when it removed nothing — and `notice` states what it kept whenever it removed any station. A repeated category is named once. On a capped draw both counts describe that draw, not the box.

*A survey the filter empties returns an empty result, not `no_stations_found`.* That error means no station inside the box reported a METAR; here stations did, and none were in the requested categories, which is an answer — decision 23's reading of an empty advisory set. The notice names the filter as the stage that emptied the result and how many stations it examined; an empty draw is still the error, raised before the filter runs.

*`station_ids` rejects it as `conflicting_flight_category`,* after `conflicting_limit`, for decision 26's reason: each named station already reports its own category, and a silently inert filter is one the caller never learns did nothing.

---

**38. Advisory coverage follows independent source products, and missing facts remain missing.**
Domestic `/airsigmet`, international `/isigmet` and `/cwa` are separate reads. The two SIGMET feeds are deprecated but active and disjoint by documented coverage. Unified `/sigmet` was rejected because no documented classifier reliably separates domestic/international rows, and subtracting domestic identities would make international availability depend on another feed. Domestic severity and FROM-direction numbers remain intact; international direction stays source-native with already-decoded knots, while CWA supplies neither movement nor severity.

Six legacy strings and compatibility `polygon` are nullable because meaningful sparse bulletins, multipart areas and lines cannot truthfully fill them. `geometry.parts` preserves each ring/line and the source-native kind, including null; finite numeric coordinate strings decode, but no altitude is inferred from raw text. Rows with no meaningful advisory facts are skipped and disclosed. Bulletins render in dynamically sized safe fences without rewriting their text.

Per-source `ok`/`failed`/`not_applicable` coverage prevents an unreadable product from looking like a successful zero. Healthy independent products survive failures; every applicable source failing raises `advisory_sources_failed`. One 45-second deadline covers the entire fanout and retries; caller cancellation propagates. Bbox stage counts exclude failed sources and separate unlocated rows. An explicit optional limit sorts and discloses withheld matches with a retrieval instruction; no automatic cap or default limit changes an unbounded request.

**39. Complete state membership and supplementary airport variation.**

State membership cannot be recovered reliably by widening boxes: the registry assigns offshore sites, eastern-longitude Alaska sites and rows with questionable coordinates to states. Select every US/state-assigned member from the complete gzip registry, preserving source coordinates and the existing normalization. Bbox and identifier modes retain stationinfo. One in-memory US snapshot is fresh for 24 hours after successful validation; metadata changes slowly enough that per-call downloads would spend requests without a meaningful freshness benefit. Refresh is on demand, shared across waiters and atomically replaces the prior snapshot only after complete gzip/JSON/schema and identity validation. No persistent mirror, scheduler or population cap is introduced.

Expired data is never served as fresh: a failed refresh returns an availability error with bbox/identifier alternatives, and the next caller can retry. The configured fetch timeout (10 seconds by default) is capped at 15 seconds for the snapshot request; one 15-second signal also covers the body read and subsequent validation. Cancelling one waiter does not poison others; cancelling the last waiter aborts that refresh. An abandoned refresh cannot overwrite a newer snapshot.

Named station lookups request one supplementary airport batch using distinct resolved ICAO IDs. Only magnetic variation joins back; airport coordinates and aliases never replace station data. `16E`, `13W`, `03W` and bare `0` parse to east-positive degrees while preserving exact source text; unrecognized syntax preserves text with null degrees. Missing airport rows or HTTP 204 mean null variation. An operational airport failure leaves all station results and reconciliation intact, with a notice on both surfaces. Caller cancellation and programmer errors propagate. The base stationinfo leg retains its configured per-attempt timeout and gets a total retry deadline of `max(45000, AWC_TIMEOUT_MS)` milliseconds; previously it had no total deadline. The supplementary leg has a three-second total signal, no retries, and at most the configured per-fetch timeout. Default configuration therefore fits within 48 seconds under the default 60-second MCP budget. An operator choosing a 60-second upstream timeout must allow at least 63 seconds in the client. Published variation has no epoch and is not a current geomagnetic model or a correction at every PIREP location.

**40. Station PIREP searches use nautical circles and preserve legacy availability.**
The service resolves the primary stationinfo position without the optional airport magnetic-variation request, then queries a spherical enclosing bbox and filters by great-circle distance using a mean Earth radius of 3440.065 nautical miles. Generated bounds round outward to four decimal places, which AWC accepts; full double-precision coordinates were rejected. Antimeridian crossings use two concurrent ordinary bboxes, deduplicated by report identity; a circle spanning a pole legitimately spans all longitudes. No tiling, paging, or cap reconstruction runs. The cap is checked per raw draw before any local selection, so filtering cannot turn a partial draw into a complete answer.

Coordinate lookup has one attempt and a three-second total budget. Missing or invalid positions and operational lookup outages keep the existing `id`/integer-`distance` request available with an explicit unverified-radius notice on both response surfaces; stationinfo membership alone never proves a PIREP center invalid. Only the legacy PIREP endpoint's location rejection yields `station_not_recognized`. Caller cancellation and programmer errors propagate. One shared `max(45000, AWC_TIMEOUT_MS)` millisecond deadline includes resolution, candidate draws, retries, backoff, and body reads, preserving configured PIREP per-attempt timeouts. Default configuration stays below the 60-second MCP budget; a configured 60-second attempt requires a corresponding client budget.

## Known Limitations

- **Coverage:** METAR/TAF and international SIGMETs are global; PIREPs, domestic SIGMETs and CWAs are US-centric.
- **Recency:** METARs are typically 20–60 min old. TAFs are 6–30 hour forecasts. PIREPs are real-time but sparse. Advisory set reflects only currently active products.
- **No historical archive:** The API serves recent observations only (`hours` parameter up to 12 for METAR). No multi-day historical queries.
- **400-row result cap:** AWC documents that most endpoints return at most 400 entries and exposes no pagination surface. `aviation_find_stations` bbox mode, `aviation_get_pireps`, and `aviation_get_metar`'s bbox mode detect the cap by drawn count and name narrowing levers, with `hours` first on a METAR survey above `hours: 1` (decision 34). Complete state registry snapshots are outside that cap. PIREPs push supported altitude/intensity bounds upstream (decision 19). Named-station batch limits keep their calls small. Advisory coverage describes readable responses, not proof that upstream returned every active bulletin. See decisions 18, 38 and 39.
- **A dense METAR box is thinned by station priority:** `/metar` drops lower-priority stations from a crowded bbox draw independently of the 400-row cap, and marks it nowhere in the response. A live `{40,-10,60,20}` box at `hours=1` drew 316 rows over 159 stations — under the cap, so `truncated: false` — while its four quadrants union to 298 stations; all 139 interior stations the parent draw missed carry AWC `priority: 4`, and the stations it did keep carry 0–3. It is density-driven and it recurses, so a quadrant dense enough is thinned in turn, while a small box is provably complete. No count or field in a single draw detects it, so `truncated: false` claims only that the cap was not reached (decision 34), and tiling the box into smaller ones and unioning the results is what recovers the missing stations.
- **A `limit` bounds the response, never the search:** Matching rows are counted before a supplied limit. Station results order by ICAO identifier with identifier-less rows last, PIREPs by recency, and METAR surveys by station ID. Omitted rows remain reachable by raising or dropping the limit; there is no pagination. No default limit applies: results above 50 PIREPs, 40 METAR stations or 110 registry stations get guidance instead (decisions 24, 26, 34 and 36).
- **Not an official briefing:** This data does not constitute a regulatory-compliant preflight weather briefing. Pilots flying IFR or in controlled airspace must use an authorized source.
- **Advisory scope:** `/airsigmet` domestic SIGMETs, `/isigmet` international SIGMETs and `/cwa` Center Weather Advisories are independent products. SIGMET feeds are deprecated but active; unified `/sigmet` lacks a documented domestic classifier. AIRMETs remain unavailable (#29). Readable empty arrays/204 are valid, while failed sources never establish quiet weather; coverage and filtering stages are explicit (decisions 23 and 38).
- **Source-native hazard vocabulary:** Domestic turbulence SIGMETs use `TURB`, while convective products use `CONVECTIVE`. Hazard matching stays upstream rather than comparing those record tokens with caller spellings. Domestic finite primary altitude bounds take precedence, with alternate bounds used only when the primary is unavailable; severity remains an uninterpreted domestic source value.
- **Decoded cloud layers are capped upstream:** AWC decodes at most three layers per TAF period and four per METAR. A TAF period's leftover text surfaces in `not_decoded`, possibly on the period after the one it came from; a METAR's fifth layer is dropped with no marker, so `raw_metar` is the complete source (decision 32).
- **An empty cloud array carries no sky condition on its own:** AWC encodes no layer for a group with no height, so a `CLR` report, a `VV///` obscuration, and a report that stated no sky condition all arrive as `clouds: []`. `sky_condition` separates them on both response surfaces, and an empty array beside a null reads as unreported rather than clear (decision 21). What stays unavailable is the sky above a station that reported none — no field recovers it, and neither response surface claims otherwise.

---

## API Reference

**Base URL:** `https://aviationweather.gov/api/data`

**Common parameters:**
- `format=json` — required for JSON responses (default is plain text)
- `ids=KSEA,KJFK` — comma-separated ICAO IDs for station-keyed endpoints
- `bbox=minLat,minLon,maxLat,maxLon` — area filter on `metar`, `pirep`, and `stationinfo`; `/airsigmet` defines none. On `metar` it draws every observation inside the `hours` window for every station in the box, and no parameter restricts that to the latest per station — unlike the endpoints that silently drop a key they do not recognize, `/metar` answers one with HTTP 400 `{"status":"error","error":"Unexpected query parameter provided"}`
- `hours=N` — lookback window for `metar` and `taf` (METAR: 1–12 typical)
- `age=N` — lookback window ("Hours Back") for `pirep`; that endpoint has no `hours` parameter and silently ignores one
- `distance=N` — legacy center-search distance for PIREPs, ignored with bbox. AWC's OpenAPI does not specify its unit or exact geometry; it does not implement this server's nautical-circle contract. Used only when coordinate resolution is unavailable, with an explicit warning
- `level=N` — for `pirep`, a flight-level centre searched with a fixed ±3,000 ft band ("Level +-3000' to search"), not a range: `level=190` returns FL160–220. Applies in both the radial and bbox modes, and admits reports whose flight level did not parse
- `inten=lgt|mod|sev` — for `pirep`, minimum hazard intensity. Selects whole reports carrying at least one turbulence or icing layer at that intensity or above, so a matching report still carries its lighter layers
- `hazard=conv|turb|ice|ifr` — for `airsigmet`, the hazard class. Values are matched case-insensitively; an unrecognized one returns HTTP 400 rather than being dropped, and a recognized one with nothing active returns 204. The tool's own spellings do not substitute: `CONVECTIVE` and `TURBULENCE` return 400, while `ICING` and `IFR` case-fold onto the undocumented `icing` and the documented `ifr` and return 204 — so the mapping in decision 23 is what keeps every outgoing value one this list accepts. `/airsigmet` defines no bbox parameter

**Most endpoints return at most 400 entries**, according to AWC's Restrictions, alongside a request-pacing guideline of no more than 1 request/min per thread. The OpenAPI schema declares no `page`, `offset`, `limit`, or cursor parameter on these endpoints and does not mention the cap. The tested station/METAR/PIREP draws detect it by row count; this generic restriction alone does not establish advisory-product cap behavior. `stationinfo` accepts only `ids`, `bbox`, and `format`, leaving a smaller bounding box as its upstream narrowing lever.

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

`/pirep` answers an `id` center it does not know with the same envelope:

```json
{ "status": "error", "error": "Invalid location specified" }
```

`fetchJson` surfaces the `error` text as the message on any 4xx carrying this envelope (decision 33).
