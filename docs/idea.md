---
name: aviation-weather-mcp-server
description: "Aviation weather via aviationweather.gov — METARs, TAFs, PIREPs, and SIGMETs for flight planning."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/aviation-weather-mcp-server"
created: 2026-05-30
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
pattern: multi-endpoint single-source
complexity: low-medium
api-deps: NOAA/NWS Aviation Weather Center (aviationweather.gov) Data API
api-cost: free (no key; verified keyless)
hostable: true
composes-with: opensky-mcp-server, nws-weather-mcp-server, openstreetmap-mcp-server
---

# aviation-weather-mcp-server

Aviation weather from the NWS Aviation Weather Center ([aviationweather.gov](https://aviationweather.gov/)) — METARs (observations), TAFs (terminal forecasts), PIREPs (pilot reports), and SIGMETs/AIRMETs (hazard advisories). Keyless, decoded for agents.

The fleet's weather is general-public (`nws-weather`) and global (`open-meteo` idea) — but aviation weather is a distinct product with its own coded formats (METAR/TAF), audience (pilots, dispatchers), and hazards (icing, turbulence, ceilings, visibility). It also pairs directly with the `opensky` aviation-tracking idea: where the aircraft is + what the weather is doing there.

**Audience:** Pilots (GA and pro), flight dispatchers, drone operators, aviation enthusiasts, agents answering "what's the weather at KSEA?", "is it VFR at my destination?", or "any SIGMETs along this route?"

## User Goals

- Get current conditions (METAR) for an airport, decoded
- Get the terminal forecast (TAF) for an airport
- Check the flight category (VFR / MVFR / IFR / LIFR) at a field
- See hazard advisories (SIGMETs/AIRMETs) for an area or route
- Read recent pilot reports (PIREPs) near a location

## API Surface

Keyless REST at `aviationweather.gov/api/data/`. Airports use **ICAO IDs** (`KSEA`, `KJFK`); supports single/multiple IDs, state (`@WA`), and bbox. JSON or raw coded text.

| Endpoint | Purpose | Notes |
|:---------|:--------|:------|
| `/metar?ids=&format=json` | Current observations | Decoded fields (temp, wind, visib, altim, clouds) + `rawOb` |
| `/taf?ids=` | Terminal aerodrome forecast | Forecast periods with wind/vis/weather/clouds |
| `/pirep` | Pilot reports | Turbulence, icing, cloud tops — by location/altitude |
| `/airsigmet` | AIRMETs / SIGMETs | Hazard polygons: turbulence, icing, IFR, mountain obscuration, convective |
| `/stationinfo?ids=` | Station/airport metadata | Resolve and locate fields |

METAR JSON returns decoded fields *and* the raw coded string — surface both (pilots read raw; agents reason on decoded).

## Tool Surface (sketch)

```
aviation_get_metar    — current observation(s) for airport ICAO id(s). Decoded: wind
                        (dir/speed/gust), visibility, ceiling/clouds, temp/dewpoint,
                        altimeter, plus the computed flight category (VFR/MVFR/IFR/LIFR)
                        and the raw METAR string. "What's it doing at KSEA right now?"

aviation_get_taf      — terminal aerodrome forecast for airport id(s): each forecast
                        period with valid times, wind, visibility, weather, and clouds,
                        plus the raw TAF. "What's the forecast at my destination?"

aviation_get_advisories — active SIGMETs and AIRMETs for an area, bbox, or near a point:
                        hazard type (turbulence, icing, IFR, mountain obscuration,
                        convective), severity, altitudes, and valid period. Route/area
                        hazard picture.

aviation_get_pireps   — recent pilot reports near a location/route and altitude band:
                        turbulence, icing, cloud layers, remarks. Real-world conditions
                        between the forecasts.

aviation_find_stations — resolve an airport by ICAO/IATA/name to its id, coordinates,
                        and elevation. Helper for the other tools and "near me" queries.
```

## Design Notes

- Low-medium complexity — keyless REST; the real work is **decoding** (translate METAR/TAF codes and surface the derived flight category) and returning **both decoded fields and the raw string** (pilots trust raw; agents reason on structured).
- **Flight category is the headline** — compute VFR/MVFR/IFR/LIFR from ceiling + visibility and lead with it; it's the single most useful at-a-glance signal.
- This is **NWS/NOAA data** (Aviation Weather Center is part of NWS) — but it's a distinct product/audience from `nws-weather`, so it earns its own server rather than folding in. Not part of the `noaa_` cluster naming (the AWC brand is "aviation weather," and pilots know it as such).
- Coverage is global for METAR/TAF (worldwide airports report), but SIGMETs/PIREPs are US-centric — note the boundary.
- Safety framing: this is informational, not an official briefing — note that real flight planning uses an authorized source (Leidos/1800wxbrief). Don't imply it replaces a preflight briefing.
- Composes with `opensky` (aircraft position + the weather there — the standout aviation pairing), `nws-weather` (surface forecast context), `openstreetmap` (locate an airport / nearest field to coordinates).
- Moonshot: a "route weather" workflow — departure/destination/alternates METAR+TAF, flight categories, and any SIGMETs/PIREPs along the great-circle path in one briefing-style call.
- README one-liner: "METARs, TAFs, and hazard advisories for pilots — decoded aviation weather from aviationweather.gov, no key."
