# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
