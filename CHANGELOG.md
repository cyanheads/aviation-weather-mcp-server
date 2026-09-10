# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.4.6](changelog/0.4.x/0.4.6.md) — 2026-09-09

aviation_preflight_brief accepts optional departure time, cruise altitude, and route waypoints to narrow its TAF, PIREP, and advisories steps; station calls now chunk to each tool's limit, and its ICAO identifier arguments are validated against the same 4-letter pattern the weather tools enforce.

## [0.4.5](changelog/0.4.x/0.4.5.md) — 2026-09-09

aviation_get_pireps and aviation_find_stations gain a response-size limit, and aviation_find_stations trims and correctly describes its station identifiers.

## [0.4.4](changelog/0.4.x/0.4.4.md) — 2026-09-09

aviation_get_advisories moves hazard filtering upstream to AWC's own vocabulary and discloses which stage produced an empty result.

## [0.4.3](changelog/0.4.x/0.4.3.md) — 2026-09-09

aviation_get_metar and aviation_get_taf disclose a reported/forecast sky condition instead of rendering an empty cloud array as clear, and aviation_find_stations discloses which requested identifiers resolved to nothing.

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-09-09

aviation_get_pireps: a malformed flight-level group no longer reports altitude 0, a synthesized icing layer is dropped instead of published, and altitude/intensity filters are pushed upstream of the 400-row cap via a new min_intensity input.

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-08-25

Adopts @cyanheads/mcp-ts-core 0.12.3 and MCP SDK v2: an argument key no tool schema declares is now rejected by name instead of silently dropped, and .env.example pins MCP_SESSION_MODE=stateless to match the Docker image.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-08-13 · ⚠️ Breaking

aviation_get_advisories rejects AIRMET requests instead of answering with SIGMETs (breaking); aviation_find_stations and aviation_get_pireps disclose results capped at AWC's 400-row maximum

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-08-13 · ⚠️ Breaking

TAF weather field changes from a string to raw/decoded (breaking); forecast obscuration and wind shear restored; batch calls now disclose missing stations

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-08-13 · ⚠️ Breaking

Nullable METAR/TAF/PIREP/station outputs replace fabricated zeros (breaking); ceiling now covers obscured skies; cloud heights corrected to AGL

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-08-13

Fix aviation_get_pireps lookback/filter bugs and validate aviation_find_stations state codes; adopt mcp-ts-core ^0.11.5

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-07-11

Include alternates in aviation_preflight_brief TAF step; reject bbox+state conflicts in aviation_find_stations

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-07-11

Reject conflicting station_ids/bbox/state inputs in aviation_find_stations; correct ICAO-only lookup docs

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-07-11

Fix elevation unit conversion and bbox validation across three tools; adopt mcp-ts-core ^0.10.14

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-20

Adopt mcp-ts-core ^0.10.9; devcheck gains floating-dependency-specifier and plugin-manifest guards; biome 2.5 + dev-dependency refresh; vendored skills resynced

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-12

Adopt mcp-ts-core ^0.10.6; explicit server identity; MCPB bundle agent-doc strip; ValidationError codes for missing-input errors; Dockerfile version label + healthcheck

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-06

Tool description fixes: aviation_find_stations ICAO-only, aviation_get_pireps altitude-filter context, aviation_get_advisories SURFACE WIND vs LLWS differentiation

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-06

Public hosted endpoint — server.json remotes + README hosted section

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 5 tools + 1 prompt over the NWS Aviation Weather Center API (METAR, TAF, PIREP, SIGMET/AIRMET), with security hardening of error responses
