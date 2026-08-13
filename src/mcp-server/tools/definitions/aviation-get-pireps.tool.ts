/**
 * @fileoverview Tool to fetch recent Pilot Reports (PIREPs) near an airport or within a bounding box.
 * @module mcp-server/tools/definitions/aviation-get-pireps
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatDegrees } from '@/mcp-server/tools/format-degrees.js';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';
import { AWC_MAX_ROWS, isUpstreamCapped } from '@/services/aviation-weather/awc-limits.js';
import { isBboxOrdered } from '@/services/aviation-weather/bbox.js';

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
  .describe('Geographic bounding box for area PIREP search.');

const TurbulenceLayerSchema = z
  .object({
    base_ft: z
      .number()
      .nullable()
      .describe('Turbulence layer base altitude in feet MSL, or null if not specified.'),
    top_ft: z
      .number()
      .nullable()
      .describe('Turbulence layer top altitude in feet MSL, or null if not specified.'),
    intensity: z
      .string()
      .describe('Turbulence intensity (e.g., NEG, LGT, LGT-MOD, MOD, SEV, EXTRM).'),
    type: z
      .string()
      .nullable()
      .describe('Turbulence type (e.g., CHOP, CAT), or null if not reported.'),
    frequency: z
      .string()
      .nullable()
      .describe('Turbulence frequency (e.g., OCNL, CONT), or null if not reported.'),
  })
  .describe('A reported turbulence layer.');

const IcingLayerSchema = z
  .object({
    base_ft: z
      .number()
      .nullable()
      .describe('Icing layer base altitude in feet MSL, or null if not specified.'),
    top_ft: z
      .number()
      .nullable()
      .describe('Icing layer top altitude in feet MSL, or null if not specified.'),
    intensity: z.string().describe('Icing intensity (e.g., NEG, TRC, LGT, MOD, SEV).'),
    type: z
      .string()
      .nullable()
      .describe('Icing type (e.g., RIME, MIXED, CLEAR), or null if not reported.'),
  })
  .describe('A reported icing layer.');

const PirepCloudLayerSchema = z
  .object({
    cover: z
      .string()
      .describe(
        'Cloud cover code: FEW, SCT, BKN, OVC, SKC, or CLR. The field also carries the flight-condition markers VMC and IMC, which describe the flight environment rather than a cloud layer and arrive with no base or top.',
      ),
    base_ft: z
      .number()
      .nullable()
      .describe('Cloud base altitude in feet MSL, or null if the pilot reported no base.'),
    top_ft: z
      .number()
      .nullable()
      .describe('Cloud top altitude in feet MSL, or null if the pilot reported no top.'),
  })
  .describe('A cloud layer, whose base and top are each present only if reported.');

/** Radius applied to a station_id search when distance_nm is omitted. */
const DEFAULT_DISTANCE_NM = 100;

/**
 * The parameters that narrow a PIREP query before the upstream row cap applies.
 * The altitude bounds are deliberately absent: they are applied to the page the
 * cap already returned, so they cannot reach a report the cap dropped.
 */
const NARROWING_LEVERS = 'a smaller bbox, a smaller distance_nm, or a shorter hours';

/**
 * Render a vertical extent where either bound may be unreported — shared by the
 * cloud, turbulence, and icing layers, which all carry the same pair. Each
 * available bound renders on its own, so a layer reporting only a base keeps
 * that base instead of losing it to a range that cannot be drawn. A layer with
 * neither bound renders nothing; that is the common case, and an empty range
 * would be a placeholder standing in for an altitude nobody reported.
 */
function altitudeExtent(base_ft: number | null, top_ft: number | null): string {
  if (base_ft != null && top_ft != null) {
    return `${base_ft.toLocaleString()}–${top_ft.toLocaleString()} ft`;
  }
  if (base_ft != null) return `${base_ft.toLocaleString()} ft base, top unknown`;
  if (top_ft != null) return `base unknown, ${top_ft.toLocaleString()} ft top`;
  return '';
}

export const aviationGetPireps = tool('aviation_get_pireps', {
  title: 'Get Pilot Reports (PIREPs)',
  description:
    'Get recent Pilot Reports (PIREPs) near an airport or within a bounding box. Returns decoded turbulence, icing, and cloud reports with altitude, aircraft type, intensity, and the raw PIREP string. Requires either station_id (ICAO center point for radial search, e.g., KSEA) or bbox (area search) — not both. distance_nm belongs to the station_id search only, and altitude_min_ft must not exceed altitude_max_ft. Coverage is US-centric; PIREPs are sparse and absence of reports does not imply smooth conditions.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Z]{4}$/)
      .optional()
      .describe(
        'ICAO station ID as center point for radial search (e.g., KSEA). Use with distance_nm.',
      ),
    bbox: BboxSchema.optional(),
    distance_nm: z
      .number()
      .int()
      .min(10)
      .max(500)
      .optional()
      .describe(
        'Search radius in nautical miles around station_id, defaulting to 100 when omitted. Belongs to the station_id search only — supplying it alongside bbox is rejected.',
      ),
    hours: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(3)
      .describe('How many hours of history to return. Default 3.'),
    altitude_min_ft: z
      .number()
      .int()
      .optional()
      .describe(
        'Filter by minimum altitude in feet MSL (e.g., 18000 for FL180). Reports with an unknown altitude (altitude_ft null) cannot be shown to satisfy a bound and are dropped whenever either bound is set. Optional.',
      ),
    altitude_max_ft: z
      .number()
      .int()
      .optional()
      .describe(
        'Filter by maximum altitude in feet MSL (e.g., 35000 for FL350). Reports with an unknown altitude (altitude_ft null) cannot be shown to satisfy a bound and are dropped whenever either bound is set. Optional.',
      ),
  }),
  output: z.object({
    pireps: z
      .array(
        z
          .object({
            observed_at: z.string().describe('Observation time in ISO 8601 format (UTC).'),
            lat: z.number().describe('Latitude of the PIREP location in decimal degrees.'),
            lon: z.number().describe('Longitude of the PIREP location in decimal degrees.'),
            altitude_ft: z
              .number()
              .nullable()
              .describe(
                'Reported altitude in feet MSL, or null when the pilot gave no flight level (raw /FLUNKN/, /FLDURC/, or /FLDURD/). A raw /FL000/ is a reported flight level of zero and returns 0.',
              ),
            aircraft_type: z
              .string()
              .nullable()
              .describe('Aircraft type designator (e.g., B737, C172), or null if not reported.'),
            pirep_type: z
              .string()
              .describe('Report type: PIREP (pilot report) or AIREP (position report with wx).'),
            turbulence: z
              .array(TurbulenceLayerSchema)
              .describe(
                'Turbulence layers reported. An explicit negative report is a layer with intensity NEG; an empty array means the PIREP carried no turbulence group, so the pilot said nothing either way.',
              ),
            icing: z
              .array(IcingLayerSchema)
              .describe(
                'Icing layers reported. An explicit negative report is a layer with intensity NEG; an empty array means the PIREP carried no icing group, so the pilot said nothing either way.',
              ),
            clouds: z
              .array(PirepCloudLayerSchema)
              .nullable()
              .describe('Cloud layers, or null if the PIREP carried no sky-condition group.'),
            visibility_sm: z
              .number()
              .nullable()
              .describe('In-flight visibility in statute miles, or null if not reported.'),
            remarks: z
              .string()
              .nullable()
              .describe('Weather remarks or additional conditions, or null if none.'),
            raw_pirep: z
              .string()
              .describe(
                'Original encoded PIREP string (e.g., "SEA UA /OV KSEA/TM 1530/FL080/TP B737/TB LGT").',
              ),
          })
          .describe('A single Pilot Report (PIREP) with decoded hazard information.'),
      )
      .describe(
        'Pilot reports matching the search criteria, ordered by observation time descending.',
      ),
  }),
  errors: [
    {
      reason: 'no_pireps_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No pilot reports found in the search area and time window.',
      recovery:
        'Expand the distance_nm or hours parameters, or try a different region. PIREPs are sparse; absence of reports does not mean smooth conditions.',
    },
    {
      reason: 'missing_location',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither station_id nor bbox was provided.',
      recovery:
        'Provide station_id for a radial search (ICAO ID + distance_nm) or bbox for an area search (minLat, minLon, maxLat, maxLon).',
    },
    {
      reason: 'conflicting_location',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both station_id and bbox were provided.',
      recovery:
        'Provide station_id OR bbox, not both. station_id runs a radial search with distance_nm; bbox runs an area search.',
    },
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The bounding box is inverted — minLat > maxLat or minLon > maxLon.',
      recovery:
        'Ensure minLat <= maxLat and minLon <= maxLon. Swap the inverted min/max coordinates and retry.',
    },
    {
      reason: 'conflicting_distance',
      code: JsonRpcErrorCode.ValidationError,
      when: 'distance_nm was provided together with bbox, where a search radius has no meaning.',
      recovery:
        'Drop distance_nm to search the bbox as drawn, or replace bbox with station_id to run a radial search at that distance.',
    },
    {
      reason: 'invalid_altitude_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'altitude_min_ft is greater than altitude_max_ft, so no report can match both bounds.',
      recovery:
        'Ensure altitude_min_ft <= altitude_max_ft. Swap the two values, or drop one to filter on a single bound.',
    },
  ],

  enrichment: {
    truncated: z
      .boolean()
      .describe(
        'True when the upstream page hit the AWC row cap, so reports inside the search area and time window are missing from this result. False affirms the whole window was searched, which a count alone cannot establish.',
      ),
    shown: z.number().describe('Reports in this result, counted after any altitude filter.'),
    cap: z
      .number()
      .optional()
      .describe(
        'The upstream row maximum that was applied to the page. Present only on a truncated result.',
      ),
    upstreamRows: z
      .number()
      .optional()
      .describe(
        'Reports AWC returned before the altitude filter ran. Present only on a truncated result the filter then narrowed, where the remaining count sits below the cap and so cannot reveal the truncation on its own.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance naming the levers that narrow the query before the cap applies. Present only on a truncated result.',
      ),
  },

  enrichmentTrailer: {
    truncated: { label: 'Truncated at the upstream row cap' },
    shown: { label: 'Reports returned' },
    cap: { label: 'Upstream row maximum' },
    upstreamRows: { label: 'Reports returned before the altitude filter' },
  },

  async handler(input, ctx) {
    if (!input.station_id && !input.bbox) {
      throw ctx.fail(
        'missing_location',
        'Either station_id or bbox is required for PIREP search.',
        {
          ...ctx.recoveryFor('missing_location'),
        },
      );
    }

    if (input.station_id && input.bbox) {
      throw ctx.fail('conflicting_location', 'Provide either station_id or bbox, not both.', {
        ...ctx.recoveryFor('conflicting_location'),
      });
    }

    if (input.bbox && !isBboxOrdered(input.bbox)) {
      throw ctx.fail(
        'invalid_bbox',
        'Bounding box is inverted: minLat must be <= maxLat and minLon <= maxLon.',
        { ...ctx.recoveryFor('invalid_bbox') },
      );
    }

    if (input.bbox && input.distance_nm != null) {
      throw ctx.fail(
        'conflicting_distance',
        'distance_nm is a radius around station_id and has no effect on a bbox search.',
        { ...ctx.recoveryFor('conflicting_distance') },
      );
    }

    // Client-side altitude filter bounds (capture so TypeScript narrows in the
    // filter callbacks below). Equal bounds are a valid, if narrow, range.
    const altMin = input.altitude_min_ft;
    const altMax = input.altitude_max_ft;
    if (altMin != null && altMax != null && altMin > altMax) {
      throw ctx.fail(
        'invalid_altitude_range',
        `Altitude range is inverted: altitude_min_ft (${altMin.toLocaleString()}) must be <= altitude_max_ft (${altMax.toLocaleString()}).`,
        { ...ctx.recoveryFor('invalid_altitude_range') },
      );
    }

    const radiusNm = input.distance_nm ?? DEFAULT_DISTANCE_NM;

    ctx.log.info('Fetching PIREPs', {
      stationId: input.station_id,
      hasBbox: !!input.bbox,
      ...(input.station_id ? { distanceNm: radiusNm } : {}),
      hours: input.hours,
    });

    const svc = getAviationWeatherService();
    let pireps = await svc.fetchPireps(
      {
        ...(input.station_id ? { stationId: input.station_id, distanceNm: radiusNm } : {}),
        ...(input.bbox ? { bbox: input.bbox } : {}),
        hours: input.hours,
      },
      ctx,
    );

    const rawCount = pireps.length;

    // A report whose altitude is unknown cannot be shown to satisfy a bound, so
    // either bound drops it. Both bounds behave the same way — the old zero
    // sentinel made altitude_min_ft discard these and altitude_max_ft keep them.
    if (altMin != null) {
      pireps = pireps.filter((p) => p.altitude_ft != null && p.altitude_ft >= altMin);
    }
    if (altMax != null) {
      pireps = pireps.filter((p) => p.altitude_ft != null && p.altitude_ft <= altMax);
    }

    // Sort by observation time descending
    pireps.sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime());

    // The cap applies to the page upstream served, before the altitude filter
    // selected from it — so it is `rawCount`, never the count left afterwards.
    const capped = isUpstreamCapped(rawCount);

    if (pireps.length === 0) {
      const altFiltered = (altMin != null || altMax != null) && rawCount > 0;
      const altRange =
        altMin != null && altMax != null
          ? `${altMin.toLocaleString()}–${altMax.toLocaleString()} ft`
          : altMin != null
            ? `above ${altMin.toLocaleString()} ft`
            : altMax != null
              ? `below ${altMax.toLocaleString()} ft`
              : null;

      // A capped page cannot support a claim about the whole area: the filter
      // only ever saw the rows the cap left behind, so reporting that page's
      // size as the reports present in the area asserts what was never searched.
      const cappedAndFiltered = altFiltered && capped;

      const message = cappedAndFiltered
        ? `No PIREPs matched the altitude filter (${altRange}) in the part of the search area upstream returned. AWC capped this query at ${AWC_MAX_ROWS} reports, so the area was searched only in part — reports beyond that page were never examined.`
        : altFiltered
          ? `No PIREPs in the search area matched the altitude filter (${altRange}). ${rawCount} report(s) were found at other or unreported altitudes.`
          : `No PIREPs found in the search area for the past ${input.hours} hour(s).`;

      const recovery = cappedAndFiltered
        ? `Narrow the search until it falls under the ${AWC_MAX_ROWS}-report upstream cap — ${NARROWING_LEVERS} — then reapply the altitude filter. The filter runs after the cap, so adjusting altitude_min_ft / altitude_max_ft alone cannot reach a report the cap dropped.`
        : altFiltered
          ? `Remove or adjust altitude_min_ft / altitude_max_ft. ${rawCount} PIREP(s) exist in the area at other or unreported altitudes.`
          : 'Expand the distance_nm or hours parameters, or try a different region. PIREPs are sparse; absence of reports does not mean smooth conditions.';

      throw ctx.fail('no_pireps_found', message, { recovery: { hint: recovery } });
    }

    if (capped) {
      const narrowed =
        pireps.length < rawCount
          ? ` — the ${pireps.length} shown are what survived the altitude filter applied to that capped page`
          : '';
      ctx.enrich.truncated({
        shown: pireps.length,
        cap: AWC_MAX_ROWS,
        guidance: `AWC served ${rawCount} reports for this query, its per-request maximum, so reports inside the search area and the ${input.hours}-hour window are missing from this result${narrowed}. Narrow the search — ${NARROWING_LEVERS} — and re-run. The altitude filter runs after the cap and cannot reach a report the cap dropped.`,
      });
      // Restating the served count is only informative where the filter moved it.
      if (pireps.length < rawCount) ctx.enrich({ upstreamRows: rawCount });
    } else {
      ctx.enrich({ truncated: false, shown: pireps.length });
    }

    ctx.log.info('PIREPs retrieved', { count: pireps.length, rawCount });
    return { pireps };
  },

  format: (result) => {
    const lines: string[] = [`**${result.pireps.length} PIREP(s) found**\n`];
    for (const p of result.pireps) {
      lines.push(`## ${p.pirep_type} — ${p.observed_at}`);
      lines.push(
        `**Location:** ${formatDegrees(p.lat)}, ${formatDegrees(p.lon)} | **Altitude:** ${p.altitude_ft != null ? `${p.altitude_ft.toLocaleString()} ft` : 'unknown'}`,
      );
      if (p.aircraft_type) lines.push(`**Aircraft:** ${p.aircraft_type}`);

      if (p.turbulence.length > 0) {
        lines.push('**Turbulence:**');
        for (const t of p.turbulence) {
          const extent = altitudeExtent(t.base_ft, t.top_ft);
          const details = [t.intensity, t.type, t.frequency].filter(Boolean).join(', ');
          lines.push(`  - ${details}${extent ? ` (${extent})` : ''}`);
        }
      }

      if (p.icing.length > 0) {
        lines.push('**Icing:**');
        for (const i of p.icing) {
          const extent = altitudeExtent(i.base_ft, i.top_ft);
          const details = [i.intensity, i.type].filter(Boolean).join(', ');
          lines.push(`  - ${details}${extent ? ` (${extent})` : ''}`);
        }
      }

      if (p.clouds && p.clouds.length > 0) {
        const cloudStr = p.clouds
          .map((c) => {
            const extent = altitudeExtent(c.base_ft, c.top_ft);
            return extent ? `${c.cover} ${extent}` : c.cover;
          })
          .join(', ');
        lines.push(`**Clouds:** ${cloudStr}`);
      }

      if (p.visibility_sm != null) lines.push(`**Visibility:** ${p.visibility_sm} sm`);
      if (p.remarks) lines.push(`**Remarks:** ${p.remarks}`);
      lines.push(`**Raw:** \`${p.raw_pirep}\``);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
