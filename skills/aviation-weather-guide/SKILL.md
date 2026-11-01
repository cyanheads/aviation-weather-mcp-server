---
name: aviation-weather-guide
description: Use aviation_* tools for regional weather surveys, airport comparisons, and route assessments that need station identity, forecast timing, or incomplete coverage reconciled before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this guide when combining aviation weather results into an assessment. The server supplies recent observations, forecasts, pilot reports, and active advisories; it does not provide a historical archive.

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

Use aviation_get_metar for current conditions across an area. If the task needs broader station coverage, repeat the survey with smaller boxes and combine stations across the results; this can recover stations a dense parent box omitted, but does not prove completeness. For overlapping results, compare observation timestamps before selecting a station's current reading. Station registry discovery can identify candidates for named-station follow-up. aviation_find_stations state searches select every US registry member assigned to that state or DC from a complete snapshot fresh for up to 24 hours; a supplied limit can withhold matches. Membership follows source assignments, including offshore sites and questionable coordinates, and does not establish weather-report coverage. Bbox registry draws remain subject to the upstream row cap.

When a draw reaches the upstream cap, narrow the search rather than treating a larger response limit as recovery. Distinguish results withheld by a caller-selected limit from records the upstream never returned. A condition filter selects from the available draw and cannot recover omitted stations.

### Airport comparison and route assessment

With direct tool calls, separate current conditions from trends: aviation_get_metar can return several observations per named station. Use their timestamps to select the current reading and retain earlier readings only when evaluating change.

Read aviation_get_taf against the relevant flight times, using the returned period boundaries and change groups. Do not substitute current METAR conditions for a future forecast or imply a forecast covers a time outside its validity. Retain missing forecasts as gaps.

Named aviation_find_stations lookups supply source-published airport magnetic_declination when available, with east-positive signed degrees and exact source text. A null value is unknown; a supplementary lookup failure adds a notice without invalidating station identity. The source supplies no epoch, so do not describe this as a current geomagnetic model or apply an airport value to every PIREP report location.

For route weather, use route coordinates already known to the task when choosing an area search. The server does not geocode named waypoints. PIREPs near departure and destination alone do not establish conditions between them; sparse or absent reports do not establish smooth or ice-free conditions.

The user-invoked aviation_preflight_brief prompt supplies its own call sequence and derives searches from the context supplied to it. Review that generated scope before using its output as a route assessment; direct-tool guidance above does not change what the prompt requests. Carry unassessed route segments and flight times into the final summary.
