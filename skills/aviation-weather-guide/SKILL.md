---
name: aviation-weather-guide
description: Use aviation_* tools for regional weather surveys, airport comparisons, and route assessments that need station identity, forecast timing, or incomplete coverage reconciled before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.1"
---

## Scope

Use this guide to combine observations, forecasts, pilot reports, and active advisories. METAR, TAF and PIREP lookups accept a UTC `as_of` within the past 30 days. Include seconds and a trailing `Z`.

## Identifiers

When starting from an IATA or FAA code, discover stations geographically with aviation_find_stations and match the returned identifier fields to the requested airport. Carry its returned ICAO identifier into weather calls. Registry entries without an ICAO identifier are not interchangeable with airports accepted by those calls. Check the station's available products before treating a missing TAF as an unexpected failure.

## Gates

- Before calling a regional survey complete, account for both upstream omissions and response limits. A METAR survey can silently omit lower-priority stations even below the reported row cap. A false truncation flag does not prove every station was included.
- Before reporting no relevant weather, distinguish an empty search from a filter that removed results, missing station data, and incomplete source coverage. State the area, time window, and products actually assessed.
- Before interpreting missing decoded cloud or hazard fields as benign conditions, read the raw report when the distinction matters. An empty cloud array is not itself clear sky; an empty PIREP hazard array is not an explicit negative report.
- Before extending an airport or endpoint assessment to a route, establish which parts of that route the searches covered. Missing route coordinates, forecast timing, or altitude context remain assessment gaps.

## Core chain

Resolve the airport and available products with aviation_find_stations when needed, retrieve observations and forecasts for the resolved station, then reconcile requested stations against those that returned data. Preserve missing stations in the assessment rather than silently comparing only the airports that answered.

## Workflows

### Regional survey

Use aviation_get_metar and aviation_get_taf with `bbox` or `state` for conditions and forecasts across an area. If an airport has no TAF, query a nearby bbox and retain the original forecast gap. Weather state searches use AWC's weather selector. Use aviation_find_stations for registry membership or to identify candidates for named follow-up. Its US state snapshot refreshes on demand after 24 hours.

To continue a limited response, reuse its search arguments and set `offset` to `nextOffset`. Later pages use the currently available draw. Preserve upstream-cap and partial-coverage notices across calls, and account for possible overlap or gaps if the draw changes. A condition filter and paging both operate on available matches. Use smaller boxes to recover geographic omissions or shorter METAR lookbacks with successive earlier anchors to collect separate time windows. Compare timestamps before selecting the latest overlapping METAR.

### Past conditions

Anchor METAR and PIREP lookbacks at the assessment time with `as_of`. A historical TAF lookup selects by issuance time. Check the returned issue time and forecast validity separately, since the forecast may have been issued by the anchor and begin later. Carry a retention rejection or an in-range data gap into the assessment.

### Airport comparison and route assessment

With direct tool calls, separate current conditions from trends: aviation_get_metar can return several observations per named station. Use their timestamps to select the current reading and retain earlier readings only when evaluating change.

Read aviation_get_taf at the relevant flight time. Start with the prevailing conditions inside `[valid_from, valid_to)`, then report each active TEMPO or PROB overlay, including combined PROB TEMPO, separately. Treat BECMG as a transition until `transition_end`. If that time is unknown, leave the establishment time unresolved. Carry forward prevailing elements unaffected by a conditional change. Retain missing or out-of-validity forecasts as gaps.

Named aviation_find_stations lookups supply source-published airport magnetic_declination when available, with east-positive signed degrees and exact source text. A null value is unknown; a supplementary lookup failure adds a notice without invalidating station identity. The source supplies no epoch, so do not describe this as a current geomagnetic model or apply an airport value to every PIREP report location.

For route weather, use route coordinates already known to the task when choosing an area search. The server does not geocode named waypoints. PIREPs near departure and destination alone do not establish conditions between them; sparse or absent reports do not establish smooth or ice-free conditions.

The user-invoked aviation_preflight_brief prompt supplies its own call sequence and derives searches from the context supplied to it. Review that generated scope before using its output as a route assessment; direct-tool guidance above does not change what the prompt requests. Carry unassessed route segments and flight times into the final summary.
