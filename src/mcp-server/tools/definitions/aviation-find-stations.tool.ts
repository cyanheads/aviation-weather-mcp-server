/**
 * @fileoverview Tool to resolve airport/weather stations by ICAO ID, bounding box, or US state.
 * @module mcp-server/tools/definitions/aviation-find-stations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatDegrees } from '@/mcp-server/tools/format-degrees.js';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';
import { AWC_MAX_ROWS, isUpstreamCapped } from '@/services/aviation-weather/awc-limits.js';
import { isBboxOrdered } from '@/services/aviation-weather/bbox.js';
import { isSupportedState } from '@/services/aviation-weather/state-bboxes.js';

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
 * An ICAO station identifier: exactly four letters. Used only to split the
 * identifiers that resolved to nothing — one that is not in this shape cannot
 * reach the registry at all, and its fix (use the ICAO ID) differs from an
 * ICAO-shaped ID the registry does not carry.
 */
const ICAO_IDENT = /^[A-Za-z]{4}$/;

/**
 * Recovery guidance for the identifiers a lookup did not resolve.
 *
 * The claim is scoped to the registry and stops there. `EGTF` (Fairoaks) and
 * `LFOX` (Étampes) are real ICAO-identified aerodromes that answer HTTP 204
 * from `stationinfo`, so absence from AWC's station list says nothing about
 * whether the airport exists.
 */
function unresolvedStationNotice(missing: string[]): string {
  const notIcao = missing.filter((id) => !ICAO_IDENT.test(id));
  const notCarried = missing.filter((id) => ICAO_IDENT.test(id));
  const lines: string[] = [];
  if (notCarried.length > 0) {
    lines.push(
      `Not present in the AWC station registry: ${notCarried.join(', ')}. The registry does not list every ICAO-identified aerodrome, so this says nothing about whether the airport exists. Search by bbox or state to find nearby reporting stations.`,
    );
  }
  if (notIcao.length > 0) {
    lines.push(
      `Not in ICAO format: ${notIcao.join(', ')}. The lookup is ICAO-only, and a 3-letter IATA code never resolves even for a station whose entry carries it. Use the 4-letter ICAO ID (KSEA, not SEA), or search by bbox or state.`,
    );
  }
  return lines.join(' ');
}

export const aviationFindStations = tool('aviation_find_stations', {
  title: 'Find Aviation Weather Stations',
  description:
    'Resolve an airport or weather reporting station by ICAO identifier, or discover stations within a bounding box or US state. Returns all identifier variants (ICAO/IATA/FAA), coordinates, elevation, and available data types (METAR, TAF, SYNOP, etc.). Station IDs must be 4-letter ICAO format (e.g., KSEA, KJFK). At least one of station_ids, bbox, or state is required.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    station_ids: z
      .array(z.string().describe('A 4-letter ICAO station identifier (e.g., KSEA).'))
      .min(1)
      .max(20)
      .optional()
      .describe(
        'One or more 4-letter ICAO station IDs (e.g., KSEA, KJFK). The upstream API only accepts ICAO format — 3-letter IATA codes (e.g., SEA) will return no results. Use bbox or state to discover ICAO IDs by location.',
      ),
    bbox: BboxSchema.optional(),
    state: z
      .string()
      .length(2)
      .optional()
      .describe(
        'Two-letter USPS code for one of the 50 US states or DC (e.g., "WA") to list all stations in that jurisdiction. US territories are not supported — use bbox for those.',
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
        'Station IDs must be 4-letter ICAO format (e.g., KSEA, not SEA). Use bbox or state to discover ICAO IDs by location.',
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
  ],

  enrichment: {
    truncated: z
      .boolean()
      .describe(
        'True when the upstream draw hit the AWC row cap, so stations inside the search area are missing from this result. False affirms the area was drawn in full, which a count alone cannot establish.',
      ),
    shown: z
      .number()
      .describe('Stations in this result, counted after any client-side state filter.'),
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
        'Guidance for whichever disclosure fired: the lever that narrows a truncated draw, or the cause and fix for identifiers that resolved to nothing. The two cannot co-occur — only bbox and state can reach the row cap, and only station_ids reconciles a request.',
      ),
  },

  enrichmentTrailer: {
    truncated: { label: 'Truncated at the upstream row cap' },
    shown: { label: 'Stations returned' },
    cap: { label: 'Upstream row maximum' },
    upstreamRows: { label: 'Rows drawn before the state filter' },
    requested: { render: (ids) => `**Requested:** ${ids?.join(', ')}` },
    returned: { render: (ids) => `**Resolved:** ${ids?.join(', ')}` },
    missing: { render: (ids) => `**Resolved to nothing:** ${ids?.join(', ')}` },
    partial: { label: 'Partial result' },
  },

  async handler(input, ctx) {
    if (!input.station_ids?.length && !input.bbox && !input.state) {
      throw ctx.fail(
        'missing_search_criteria',
        'At least one of station_ids, bbox, or state is required.',
        {
          ...ctx.recoveryFor('missing_search_criteria'),
        },
      );
    }

    const locationModeCount =
      (input.station_ids?.length ? 1 : 0) + (input.bbox ? 1 : 0) + (input.state ? 1 : 0);
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

    ctx.log.info('Finding aviation stations', {
      stationIds: input.station_ids,
      hasBbox: !!input.bbox,
      state: input.state,
    });

    const svc = getAviationWeatherService();
    // Reported only by the state mode, which filters its draw inside the
    // service; the other modes return the draw as served.
    let preFilterRows: number | undefined;
    const stations = await svc.fetchStations(
      {
        ...(input.station_ids?.length ? { stationIds: input.station_ids } : {}),
        ...(input.bbox ? { bbox: input.bbox } : {}),
        ...(input.state ? { state: input.state } : {}),
        onPreFilterRows: (rows) => {
          preFilterRows = rows;
        },
      },
      ctx,
    );

    if (stations.length === 0) {
      throw ctx.fail('station_not_found', 'No stations found matching the search criteria.', {
        ...ctx.recoveryFor('station_not_found'),
      });
    }

    // The cap applies to the draw, not to what survives the state filter, so a
    // state query holding 279 stations can still be a cut page.
    const drawnRows = preFilterRows ?? stations.length;
    if (isUpstreamCapped(drawnRows)) {
      const scope = input.state
        ? `stations in ${input.state.toUpperCase()} are missing from this result — the ${stations.length} shown are what survived the state filter applied to that capped page`
        : 'stations inside the box are missing from this result';
      ctx.enrich.truncated({
        shown: stations.length,
        cap: AWC_MAX_ROWS,
        guidance: `AWC served ${drawnRows} rows for this query, its per-request maximum, so ${scope}. Re-run over smaller bbox quadrants and union the results — a smaller box is the only narrowing lever the stationinfo endpoint offers, and it replaces a capped state query too.`,
      });
      // Restating the drawn count is only informative where a filter moved it.
      if (drawnRows > stations.length) ctx.enrich({ upstreamRows: drawnRows });
    } else {
      ctx.enrich({ truncated: false, shown: stations.length });
    }

    // Upstream omits an identifier that resolved to nothing with no marker at
    // all, so a short list read as a full one. Reconcile against the registry
    // identifiers it did return: matching by array position breaks on the
    // alphabetical reordering, exact strings break on case folding, counts
    // break on de-duplication, and `icao_id` breaks on the 23% of entries that
    // carry no ICAO, IATA, or FAA identifier at all.
    if (input.station_ids?.length) {
      const resolved = new Set(stations.map((s) => s.id.toUpperCase()));
      const returned: string[] = [];
      const missing: string[] = [];
      // Both lists deduplicate on the same key upstream folds on, so a repeat
      // lands in neither twice: naming one unresolved identifier twice would
      // repeat it in the notice as well.
      const seen = new Set<string>();
      for (const requestedId of input.station_ids) {
        const key = requestedId.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        (resolved.has(key) ? returned : missing).push(requestedId);
      }
      ctx.enrich({
        requested: input.station_ids,
        returned,
        partial: missing.length > 0,
      });
      if (missing.length > 0) {
        ctx.enrich({ missing });
        ctx.enrich.notice(unresolvedStationNotice(missing));
      }
    }

    ctx.log.info('Stations found', { count: stations.length, drawnRows });
    return { stations };
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
