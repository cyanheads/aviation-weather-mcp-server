/**
 * @fileoverview Tool to resolve airport/weather stations by identifier, bounding box, or US state.
 * @module mcp-server/tools/definitions/aviation-find-stations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { formatDegrees } from '@/mcp-server/tools/format-degrees.js';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';
import { AWC_MAX_ROWS, isUpstreamCapped } from '@/services/aviation-weather/awc-limits.js';
import { isBboxOrdered } from '@/services/aviation-weather/bbox.js';
import { isSupportedState } from '@/services/aviation-weather/state-bboxes.js';
import type { NormalizedStation } from '@/services/aviation-weather/types.js';

/** Bounding box schema shared across tools. */
const BboxSchema = z
  .object({
    minLat: z.number().min(-90).max(90).describe('Southern boundary latitude in decimal degrees.'),
    minLon: z
      .number()
      .min(-180)
      .max(180)
      .describe('Western boundary longitude in decimal degrees.'),
    maxLat: z.number().min(-90).max(90).describe('Northern boundary latitude in decimal degrees.'),
    maxLon: z
      .number()
      .min(-180)
      .max(180)
      .describe('Eastern boundary longitude in decimal degrees.'),
  })
  .describe('Geographic bounding box for spatial queries.');

/**
 * An IATA code: exactly three letters. Used only to split the identifiers that
 * resolved to nothing. This is the one shape whose failure has a known cause —
 * a lookup matches the registry's own `id`, so an IATA code never resolves even
 * for a station whose entry lists one — which makes its fix (use the ICAO ID)
 * different from an identifier the registry simply does not carry.
 */
const IATA_IDENT = /^[A-Za-z]{3}$/;

/**
 * Recovery guidance for the identifiers a lookup did not resolve.
 *
 * The claim is scoped to the registry and stops there. `EGTF` (Fairoaks) and
 * `LFOX` (Étampes) are real ICAO-identified aerodromes that answer HTTP 204
 * from `stationinfo`, so absence from AWC's station list says nothing about
 * whether the airport exists.
 *
 * Only one shape is diagnosable, and it is not the four-letter one. A lookup
 * matches the registry's own identifier, which carries whatever shape the site
 * has — `NUET2` and `46114` both resolve — so an unresolved identifier of an
 * unexpected length is simply absent, and telling its caller the format is
 * wrong would send them to fix something that was never the problem. A
 * three-letter IATA code is the exception: it never resolves, even for a
 * station whose entry lists one, so it is worth naming on its own.
 */
function unresolvedStationNotice(missing: string[]): string {
  const iataShaped = missing.filter((id) => IATA_IDENT.test(id));
  const notCarried = missing.filter((id) => !IATA_IDENT.test(id));
  const lines: string[] = [];
  if (notCarried.length > 0) {
    lines.push(
      `Not present in the AWC station registry: ${notCarried.join(', ')}. The registry does not list every station, so this says nothing about whether the site exists. Search by bbox or state to find nearby reporting stations.`,
    );
  }
  if (iataShaped.length > 0) {
    lines.push(
      `Not present, and shaped like a 3-letter IATA code: ${iataShaped.join(', ')}. A lookup matches the registry's own identifier, so an IATA code never resolves even for a station whose entry carries one. Use the ICAO ID (KSEA, not SEA), or search by bbox or state.`,
    );
  }
  return lines.join(' ');
}

/**
 * The ordering a `limit` selects under: `icao_id` ascending, rows carrying none
 * last, ties broken by the registry `id` ascending.
 *
 * Stations carry no natural rank, so a limit without a defined order returns a
 * different subset each call for the same query. Ordering on the registry `id`
 * alone gives one and is useless: a live California draw holds 270 rows of
 * which 49 are identifier-less NDBC sites, and the numeric ids many of them
 * carry sort ahead of every `K***` airport, so the first ten rows were ten
 * buoys with no identifier and no data products — nothing a caller can hand to
 * `aviation_get_metar`, and no way to see why, since decision 22 keeps `id` out
 * of the output. Leading on `icao_id` puts airports on the first page and
 * leaves the identifier-less rows reachable at the tail rather than dropped.
 *
 * `id` stays as the tiebreak because it is unique and present on every row,
 * which is what makes the order total — `icao_id` is null across those 49 rows
 * and cannot separate them. Both are compared by code unit rather than by
 * locale, so the order cannot move with the runtime's collation.
 */
function byStationIdentifier(a: NormalizedStation, b: NormalizedStation): number {
  if (a.icao_id !== b.icao_id) {
    if (a.icao_id == null) return 1;
    if (b.icao_id == null) return -1;
    return a.icao_id < b.icao_id ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * What a request-imposed `limit` withheld, stated so it cannot be read as the
 * upstream row cap. The two say opposite things about what was examined: a
 * capped draw is one AWC never served past, while a limited result counted
 * every station it is selecting from. The count is scoped to the draw it was
 * taken from — on a capped draw it describes that draw, not the search area.
 */
function limitNotice(shown: number, matched: number, capped: boolean): string {
  const scope = capped
    ? `${matched} station(s) that matched inside the capped draw`
    : `${matched} matching station(s)`;
  return `The request limited this result to the first ${shown} of ${scope}, ordered by ICAO identifier ascending with identifier-less stations last. That is not the upstream cap — every station counted here was examined, and raising or dropping limit returns the ones it withheld.`;
}

/**
 * Recovery guidance for a request the registry rejected, branched on the mode
 * that built the query. The catch that raises this reads a classification
 * rather than a mode, so a single hint would advise a bbox caller about
 * `station_ids` entries they never sent.
 */
function upstreamRejectionHint(mode: 'station_ids' | 'bbox' | 'state'): string {
  if (mode === 'station_ids') {
    return 'Each station_ids entry must be one identifier on its own, with no embedded space, comma, or other separator — split a combined value into separate entries. To search by location use bbox or state instead.';
  }
  if (mode === 'bbox') {
    return 'The bounding box this call sent was refused rather than answered. Retry with a smaller box, or name the stations directly with station_ids.';
  }
  return 'The state search builds its own bounding box, so the state code is not what needs changing. Search the same area with an explicit bbox, or name the stations directly with station_ids.';
}

export const aviationFindStations = tool('aviation_find_stations', {
  title: 'Find Aviation Weather Stations',
  description:
    "Resolve an airport or weather reporting station by its identifier, or discover stations within a bounding box or US state. Returns all identifier variants (ICAO/IATA/FAA), coordinates, elevation, and available data types (METAR, TAF, SYNOP, etc.). A lookup matches the registry's own identifier, which for an airport is its 4-letter ICAO ID (e.g., KSEA, KJFK); buoys and mesonet sites carry identifiers of other shapes and resolve by those. At least one of station_ids, bbox, or state is required. limit bounds how many stations an area search returns without changing the area searched, and belongs to the bbox and state modes only.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    station_ids: z
      .array(
        z
          .string()
          // Not the four-letter pattern the weather tools use: the registry
          // carries buoys and mesonet sites with no ICAO, IATA, or FAA
          // identifier at all, so a shape constraint would reject a working
          // search. Empty and whitespace-only are the only rejectable entries.
          .regex(/\S/, 'Each station_ids entry must not be empty or whitespace-only.')
          .describe('One station identifier (e.g., KSEA).'),
      )
      .min(1)
      .max(20)
      .optional()
      .describe(
        "One or more station identifiers (e.g., KSEA, KJFK). A lookup matches the registry's own identifier: a 4-letter ICAO ID for an airport, and other shapes for the buoys and mesonet sites the registry also carries, which resolve by those. A 3-letter IATA code (e.g., SEA) never resolves, even for a station whose entry carries one. Whitespace around an entry is trimmed, so a padded identifier resolves the same as the bare one; an empty or whitespace-only entry is rejected. Use bbox or state to discover identifiers by location.",
      ),
    bbox: BboxSchema.optional(),
    state: z
      .string()
      .length(2)
      .optional()
      .describe(
        'Two-letter USPS code for one of the 50 US states or DC (e.g., "WA") to list all stations in that jurisdiction. US territories are not supported — use bbox for those.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(AWC_MAX_ROWS)
      .optional()
      .describe(
        `Maximum stations to return, applied after ordering by ICAO identifier ascending with identifier-less stations last — so the same query with the same limit returns the same stations, and airports rather than unidentified sites lead the first page. It bounds the response without changing the area searched, which a smaller bbox or a different state would. Distinct from the ${AWC_MAX_ROWS}-row upstream cap: a limited result examined every station it counted and withheld some, while a capped one never drew the rest. Belongs to the bbox and state modes; supplying it alongside station_ids is rejected, since that mode already names the set. Omit to return every match. Optional.`,
      ),
  }),
  output: z.object({
    stations: z
      .array(
        z
          .object({
            icao_id: z
              .string()
              .nullable()
              .describe('ICAO 4-letter station ID, or null if not assigned.'),
            iata_id: z.string().nullable().describe('IATA 3-letter code, or null if not assigned.'),
            faa_id: z.string().nullable().describe('FAA identifier, or null if not assigned.'),
            name: z.string().describe('Human-readable site name.'),
            lat: z.number().describe('Latitude in decimal degrees.'),
            lon: z.number().describe('Longitude in decimal degrees.'),
            elevation_ft: z
              .number()
              .nullable()
              .describe(
                'Station elevation in feet MSL. 0 is a sea-level site; null means no elevation is on file upstream, so it is unknown.',
              ),
            state: z
              .string()
              .describe('US state abbreviation, or empty string for non-US stations.'),
            country: z.string().describe('Country code or name.'),
            data_types: z
              .array(z.string().describe('An available data type (e.g., "METAR", "TAF", "SYNOP").'))
              .describe('List of data products available at this station.'),
          })
          .describe('An aviation weather reporting station.'),
      )
      .describe('Matching stations.'),
  }),
  errors: [
    {
      reason: 'station_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'None of the requested IDs match any known station.',
      recovery:
        "A lookup matches the registry's own identifier, which for an airport is its 4-letter ICAO ID (KSEA, not SEA). Use bbox or state to discover identifiers by location.",
    },
    {
      reason: 'missing_search_criteria',
      code: JsonRpcErrorCode.ValidationError,
      when: 'None of station_ids, bbox, or state was provided.',
      recovery:
        'Provide at least one of: station_ids (array of IDs), bbox (lat/lon bounds), or state (2-letter US state abbreviation).',
    },
    {
      reason: 'conflicting_location',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than one of station_ids, bbox, or state was provided.',
      recovery:
        'Provide exactly one location mode per call: station_ids for direct ICAO lookup, or bbox or state to discover stations by location.',
    },
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The bounding box is inverted — minLat > maxLat or minLon > maxLon.',
      recovery:
        'Ensure minLat <= maxLat and minLon <= maxLon. Swap the inverted min/max coordinates and retry.',
    },
    {
      reason: 'invalid_state',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The state code is not one of the 50 US states or DC.',
      recovery:
        'Use a USPS two-letter code for one of the 50 US states or DC (e.g., WA, TX, DC). US territories such as PR, VI, GU, MP, and AS are not supported — their stations carry no state value upstream, so search them with bbox instead.',
    },
    {
      reason: 'conflicting_limit',
      code: JsonRpcErrorCode.ValidationError,
      when: 'limit was provided together with station_ids, where the caller has already named the set.',
      recovery:
        'Drop limit to resolve every identifier you named, or replace station_ids with bbox or state to run an area search the limit can bound.',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The AWC station registry rejected the request as malformed rather than answering it.',
      // The hint the throw site actually sends is branched on the search mode —
      // see `upstreamRejectionHint`. This entry states the mode-agnostic form,
      // which is what a client reading the catalog ahead of a call can act on.
      recovery:
        'Check the search inputs this call sent: one identifier per station_ids entry with no embedded separator, or a bounding box covering the area you meant.',
    },
  ],

  enrichment: {
    truncated: z
      .boolean()
      .describe(
        'True when the upstream draw hit the AWC row cap, so stations inside the search area are missing from this result. False affirms the area was drawn in full, which a count alone cannot establish.',
      ),
    shown: z
      .number()
      .describe(
        'Stations in this result, counted after any client-side state filter and after any limit.',
      ),
    limited: z
      .boolean()
      .optional()
      .describe(
        'True when the requested limit withheld stations that matched — the caller asked to see fewer of them. False affirms the limit did not bite, so every matching station is here. Present only when the call supplied a limit. It never states anything about the upstream cap: a limited result examined every station it counted, while a truncated one never drew the rest.',
      ),
    matched: z
      .number()
      .optional()
      .describe(
        'Stations that matched this query before the limit selected from them. Present only on a limited result. Where the result is also truncated this counts the capped draw and not the search area — the stations the cap dropped were never examined, so no count can include them.',
      ),
    cap: z
      .number()
      .optional()
      .describe(
        'The upstream row maximum that was applied to the draw. Present only on a truncated result.',
      ),
    upstreamRows: z
      .number()
      .optional()
      .describe(
        'Rows AWC returned before the client-side state filter ran. Present only on a truncated state query the filter then narrowed, where the post-filter count sits below the cap and so cannot reveal the truncation on its own.',
      ),
    requested: z
      .array(z.string().describe('A station identifier as requested.'))
      .optional()
      .describe(
        'Station identifiers this call asked for, spelled as the caller wrote them and in the order given. Present only on a station_ids lookup — the bbox and state modes ask for an area, not a list.',
      ),
    returned: z
      .array(z.string().describe('A requested identifier that resolved to a station.'))
      .optional()
      .describe(
        'Requested identifiers that resolved, spelled as the caller wrote them rather than as upstream returned them. Deduplicated the way upstream deduplicates: a repeated or differently-cased identifier appears once, under its first spelling. Present only on a station_ids lookup.',
      ),
    partial: z
      .boolean()
      .optional()
      .describe(
        'True when a requested identifier resolved to nothing. False affirms every requested identifier resolved, which a count cannot establish — upstream case-folds and deduplicates, so a shorter list is not itself a gap. Present only on a station_ids lookup.',
      ),
    missing: z
      .array(z.string().describe('A requested identifier that resolved to no station.'))
      .optional()
      .describe(
        'Requested identifiers absent from the result. Deduplicated the way returned is: a repeated or differently-cased identifier appears once, under its first spelling. Absent when none are missing.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for whichever disclosures fired: the lever that narrows a truncated draw, what a requested limit withheld, or the cause and fix for identifiers that resolved to nothing. The cap and the limit can both fire on one result, and the text keeps them apart; the reconciliation cannot join them, since only bbox and state reach the row cap or accept a limit, and only station_ids reconciles a request.',
      ),
  },

  enrichmentTrailer: {
    truncated: { label: 'Truncated at the upstream row cap' },
    shown: { label: 'Stations returned' },
    cap: { label: 'Upstream row maximum' },
    upstreamRows: { label: 'Rows drawn before the state filter' },
    limited: { label: 'Limited by the request' },
    matched: { label: 'Stations matched before the limit' },
    requested: { render: (ids) => `**Requested:** ${ids?.join(', ')}` },
    returned: { render: (ids) => `**Resolved:** ${ids?.join(', ')}` },
    missing: { render: (ids) => `**Resolved to nothing:** ${ids?.join(', ')}` },
    partial: { label: 'Partial result' },
  },

  async handler(input, ctx) {
    // Whitespace around an identifier is not a caller error worth failing a
    // batch over, and upstream will not tolerate it: `ids=KSEA ,KJFK` answers
    // HTTP 400 and loses both stations. Trimmed once here, so the outgoing
    // query, the reconciliation, and the disclosure all read the same value and
    // no invisible padding travels into the trailer as a caller's "spelling".
    const stationIds = input.station_ids?.map((id) => id.trim());

    if (!stationIds?.length && !input.bbox && !input.state) {
      throw ctx.fail(
        'missing_search_criteria',
        'At least one of station_ids, bbox, or state is required.',
        {
          ...ctx.recoveryFor('missing_search_criteria'),
        },
      );
    }

    const locationModeCount =
      (stationIds?.length ? 1 : 0) + (input.bbox ? 1 : 0) + (input.state ? 1 : 0);
    if (locationModeCount > 1) {
      throw ctx.fail(
        'conflicting_location',
        'Provide exactly one of station_ids, bbox, or state.',
        {
          ...ctx.recoveryFor('conflicting_location'),
        },
      );
    }

    if (input.bbox && !isBboxOrdered(input.bbox)) {
      throw ctx.fail(
        'invalid_bbox',
        'Bounding box is inverted: minLat must be <= maxLat and minLon <= maxLon.',
        { ...ctx.recoveryFor('invalid_bbox') },
      );
    }

    if (input.state && !isSupportedState(input.state)) {
      throw ctx.fail('invalid_state', `Unsupported state code: ${input.state}.`, {
        ...ctx.recoveryFor('invalid_state'),
      });
    }

    // A location-mode mistake is reported ahead of this, matching the order the
    // sibling tools use for a filter that belongs to only one mode.
    if (stationIds?.length && input.limit != null) {
      throw ctx.fail(
        'conflicting_limit',
        'limit bounds an area search and has no effect on a named list of identifiers.',
        { ...ctx.recoveryFor('conflicting_limit') },
      );
    }

    ctx.log.info('Finding aviation stations', {
      stationIds,
      hasBbox: !!input.bbox,
      state: input.state,
      ...(input.limit != null ? { limit: input.limit } : {}),
    });

    const svc = getAviationWeatherService();
    // Reported only by the state mode, which filters its draw inside the
    // service; the other modes return the draw as served.
    let preFilterRows: number | undefined;
    let stations: NormalizedStation[];
    try {
      stations = await svc.fetchStations(
        {
          ...(stationIds?.length ? { stationIds } : {}),
          ...(input.bbox ? { bbox: input.bbox } : {}),
          ...(input.state ? { state: input.state } : {}),
          onPreFilterRows: (rows) => {
            preFilterRows = rows;
          },
        },
        ctx,
      );
    } catch (error) {
      // AWC answers a request it cannot parse with HTTP 400, which the
      // framework's status ladder classifies InvalidParams and annotates with
      // the endpoint that was called and the body it answered with. Neither
      // belongs in a caller-facing payload, and neither says what to change, so
      // that one code is re-raised as the declared reason carrying a hint. The
      // cause is threaded through, so the upstream detail stays in the logs.
      // Every other classification bubbles as it was — a 5xx is still
      // ServiceUnavailable and an abandoned request is still RequestCancelled.
      if (error instanceof McpError && error.code === JsonRpcErrorCode.InvalidParams) {
        // The classification says nothing about which mode built the query, so
        // the hint is chosen here rather than taken from the contract entry —
        // otherwise a bbox caller is advised about station_ids entries they
        // never sent.
        const mode = stationIds?.length ? 'station_ids' : input.bbox ? 'bbox' : 'state';
        throw ctx.fail(
          'upstream_rejected',
          'The AWC station registry rejected this request as malformed.',
          { recovery: { hint: upstreamRejectionHint(mode) } },
          { cause: error },
        );
      }
      throw error;
    }

    if (stations.length === 0) {
      throw ctx.fail('station_not_found', 'No stations found matching the search criteria.', {
        ...ctx.recoveryFor('station_not_found'),
      });
    }

    // Stations that matched the query — everything the limit selects from, and
    // the count the cap disclosure describes the state filter as leaving. The
    // limit runs last, over a defined order, so the same query with the same
    // limit returns the same stations.
    const matched = stations.length;
    const shownStations =
      input.limit != null ? stations.toSorted(byStationIdentifier).slice(0, input.limit) : stations;
    const limited = input.limit != null && matched > input.limit;

    // The cap applies to the draw, not to what survives the state filter, so a
    // state query holding 279 stations can still be a cut page.
    const drawnRows = preFilterRows ?? matched;
    if (isUpstreamCapped(drawnRows)) {
      const scope = input.state
        ? `stations in ${input.state.toUpperCase()} are missing from this result — the state filter left ${matched} of that capped page`
        : 'stations inside the box are missing from this result';
      ctx.enrich.truncated({
        shown: shownStations.length,
        cap: AWC_MAX_ROWS,
        // The cap and the limit are separate disclosures sharing one notice, so
        // the cap states its own case first and the limit appends its own.
        guidance: [
          `AWC served ${drawnRows} rows for this query, its per-request maximum, so ${scope}. Re-run over smaller bbox quadrants and union the results — a smaller box is the only narrowing lever the stationinfo endpoint offers, and it replaces a capped state query too.`,
          limited ? limitNotice(shownStations.length, matched, true) : null,
        ]
          .filter(Boolean)
          .join(' '),
      });
      // Restating the drawn count is only informative where a filter moved it.
      if (drawnRows > matched) ctx.enrich({ upstreamRows: drawnRows });
    } else {
      ctx.enrich({ truncated: false, shown: shownStations.length });
      // Safe to own the notice outright: a limit is rejected alongside
      // station_ids, so the reconciliation below cannot also be writing one.
      if (limited) ctx.enrich.notice(limitNotice(shownStations.length, matched, false));
    }

    // A caller who set no limit already knows none applied, so the affirmative
    // `limited: false` is only owed to one who did — where it separates a limit
    // that bit from one that had nothing to withhold.
    if (input.limit != null) ctx.enrich({ limited });
    if (limited) ctx.enrich({ matched });

    // Upstream omits an identifier that resolved to nothing with no marker at
    // all, so a short list read as a full one. Reconcile against the registry
    // identifiers it did return: matching by array position breaks on the
    // alphabetical reordering, exact strings break on case folding, counts
    // break on de-duplication, and `icao_id` breaks on the 23% of entries that
    // carry no ICAO, IATA, or FAA identifier at all.
    if (stationIds?.length) {
      const resolved = new Set(stations.map((s) => s.id.toUpperCase()));
      const returned: string[] = [];
      const missing: string[] = [];
      // Both lists deduplicate on the same key upstream folds on, so a repeat
      // lands in neither twice: naming one unresolved identifier twice would
      // repeat it in the notice as well.
      const seen = new Set<string>();
      for (const requestedId of stationIds) {
        const key = requestedId.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        (resolved.has(key) ? returned : missing).push(requestedId);
      }
      ctx.enrich({
        requested: stationIds,
        returned,
        partial: missing.length > 0,
      });
      if (missing.length > 0) {
        ctx.enrich({ missing });
        ctx.enrich.notice(unresolvedStationNotice(missing));
      }
    }

    ctx.log.info('Stations found', { count: shownStations.length, matched, drawnRows });
    return { stations: shownStations };
  },

  format: (result) => {
    const lines: string[] = [`**${result.stations.length} station(s) found**\n`];
    for (const s of result.stations) {
      lines.push(`## ${s.name}`);
      const ids = [
        s.icao_id ? `ICAO: ${s.icao_id}` : null,
        s.iata_id ? `IATA: ${s.iata_id}` : null,
        s.faa_id ? `FAA: ${s.faa_id}` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      // Some AWC sites (mesonet stations, DC's WASD2) carry no identifier at all.
      if (ids) lines.push(`**IDs:** ${ids}`);
      lines.push(
        `**Location:** ${formatDegrees(s.lat)}, ${formatDegrees(s.lon)} | **Elevation:** ${s.elevation_ft != null ? `${s.elevation_ft} ft` : 'unknown'}`,
      );
      if (s.state || s.country) {
        lines.push(`**Region:** ${[s.state, s.country].filter(Boolean).join(', ')}`);
      }
      // An empty list is the answer for 55 of 139 stations in one live bbox —
      // dropping the line makes it read as products that were simply not shown.
      lines.push(
        `**Data types:** ${s.data_types.length > 0 ? s.data_types.join(', ') : 'none listed'}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
