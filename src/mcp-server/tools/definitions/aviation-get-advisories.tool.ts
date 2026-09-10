/**
 * @fileoverview Tool to fetch active domestic SIGMETs for a region.
 * @module mcp-server/tools/definitions/aviation-get-advisories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatDegrees } from '@/mcp-server/tools/format-degrees.js';
import {
  getAviationWeatherService,
  isSigmetHazard,
  type SigmetHazard,
} from '@/services/aviation-weather/aviation-weather-service.js';
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
  .describe('Geographic bounding box to filter advisories by polygon overlap.');

const PolygonPointSchema = z
  .object({
    lat: z.number().describe('Latitude in decimal degrees.'),
    lon: z.number().describe('Longitude in decimal degrees.'),
  })
  .describe('A polygon vertex as a lat/lon coordinate pair.');

/**
 * Why an empty result is empty, named from the stage that produced it.
 *
 * Two counts settle it. `drawn` is what AWC served — already narrowed by the
 * hazard, which AWC applies — and the returned length is what survived the
 * bbox overlap test. A draw of zero was emptied before the bbox ran, so the box is
 * never blamed for one; a non-empty draw that returns nothing was emptied by
 * the box alone. Reading the drawn count rather than the returned one is the
 * same rule cap detection follows (decision 18).
 *
 * The hazard branch stops short of claiming other advisories are active. AWC
 * answers the same HTTP 204 for a hazard class with nothing active and for a
 * feed with nothing active at all, so once the hazard is applied upstream the
 * counts in hand cannot separate them — naming the filter the caller applied is
 * what the draw supports, and dropping it is the recovery either way.
 */
function emptyDrawNotice(
  drawn: number,
  hazard: SigmetHazard | undefined,
  hasBbox: boolean,
): string {
  if (drawn > 0) {
    const scope = hazard ? ` carrying the ${hazard} hazard` : '';
    return `AWC drew ${drawn} active advisory(ies)${scope}, but no polygon intersects the requested bbox. They are active elsewhere, not absent — widen the bbox, or drop it to see all ${drawn}.`;
  }
  if (hazard) {
    const bboxNote = hasBbox ? ' The bbox never applied: the draw was already empty.' : '';
    return `No active domestic SIGMET carries the ${hazard} hazard. AWC applied that filter to the feed, so this result says nothing about the other hazard classes.${bboxNote} Drop the hazard filter to see the whole active set.`;
  }
  const bboxNote = hasBbox
    ? ' The bbox is not the cause — the unfiltered feed itself is empty.'
    : '';
  return `No domestic SIGMETs are active anywhere right now. This is the normal fair-weather result rather than a filtering artifact.${bboxNote}`;
}

export const aviationGetAdvisories = tool('aviation_get_advisories', {
  title: 'Get Active Aviation Advisories (SIGMETs)',
  description:
    'Get active domestic SIGMETs for a region. Returns each advisory with hazard type (CONVECTIVE, TURBULENCE, ICING, IFR), severity, altitude range, valid period, polygon coordinates, and raw text. Coverage is US-centric (NWS Aviation Weather Center). This tool reads the domestic SIGMET feed only and cannot return an AIRMET; requests for one are rejected rather than answered with SIGMETs. During fair-weather periods no advisories may be active — an empty result is normal, not an error. Filter by advisory_type, hazard, or bbox.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    advisory_type: z
      .enum(['sigmet', 'airmet', 'all'])
      .default('all')
      .describe(
        'Filter by advisory type. "sigmet" and "all" both return the active domestic SIGMET set, which is everything this tool serves. "airmet" is rejected with guidance: the upstream feed cannot return an AIRMET, so answering it would mean presenting SIGMETs as AIRMET matches.',
      ),
    hazard: z
      .enum(['CONVECTIVE', 'TURBULENCE', 'ICING', 'IFR', 'MTN OBSCN', 'SURFACE WIND', 'LLWS'])
      .optional()
      .describe(
        'Optional hazard filter, applied upstream by AWC. CONVECTIVE, TURBULENCE, ICING, and IFR are the four hazard classes the domestic SIGMET feed carries, and an empty result under one of them means no advisory of that class is active — it says nothing about the others. MTN OBSCN, SURFACE WIND, and LLWS are AIRMET-family phenomena with no upstream counterpart here and are rejected rather than returning an empty result.',
      ),
    bbox: BboxSchema.optional(),
  }),
  output: z.object({
    advisories: z
      .array(
        z
          .object({
            advisory_type: z
              .string()
              .describe(
                'Advisory type as issued. The domestic SIGMET feed this tool reads emits SIGMET.',
              ),
            series_id: z.string().describe('Unique advisory identifier (e.g., BOSMA0).'),
            hazard: z
              .string()
              .describe('Hazard type — one of CONVECTIVE, TURBULENCE, ICING, or IFR.'),
            severity: z
              .number()
              .nullable()
              .describe(
                'Severity integer for convective SIGMETs (higher = more intense). Null when the advisory stated none.',
              ),
            issued_by: z.string().describe('ICAO ID of the issuing meteorological watch office.'),
            valid_from: z
              .string()
              .describe('Advisory validity start time in ISO 8601 format (UTC).'),
            valid_to: z.string().describe('Advisory validity end time in ISO 8601 format (UTC).'),
            altitude_low_ft: z
              .number()
              .nullable()
              .describe('Lower altitude bound in feet MSL, or null if not specified.'),
            altitude_high_ft: z
              .number()
              .nullable()
              .describe('Upper altitude bound in feet MSL, or null if not specified.'),
            movement: z
              .object({
                direction_deg: z
                  .number()
                  .nullable()
                  .describe('Movement direction in degrees true, or null if stationary.'),
                speed_kt: z
                  .number()
                  .nullable()
                  .describe('Movement speed in knots, or null if stationary.'),
              })
              .nullable()
              .describe('System movement vector, or null if not available.'),
            polygon: z
              .array(PolygonPointSchema)
              .describe('Geographic boundary of the advisory as a polygon of lat/lon points.'),
            raw_text: z
              .string()
              .describe(
                'Original encoded SIGMET text as issued by the meteorological watch office.',
              ),
          })
          .describe('An active SIGMET advisory.'),
      )
      .describe(
        'Active advisories matching the filter criteria. May be empty during fair weather periods.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present only when the result is empty, naming the stage that emptied it: no domestic SIGMETs are active at all, none carry the requested hazard, or none intersect the requested bbox — and which filter to broaden. A hazard-scoped empty draw states only that no advisory carries that hazard; AWC applies the hazard filter, so the response cannot say whether other classes are active.',
      ),
  },

  errors: [
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The bounding box is inverted — minLat > maxLat or minLon > maxLon.',
      recovery:
        'Ensure minLat <= maxLat and minLon <= maxLon. Swap the inverted min/max coordinates and retry.',
    },
    {
      reason: 'airmet_not_served',
      code: JsonRpcErrorCode.ValidationError,
      when: 'advisory_type "airmet" was requested, or a hazard filter naming an AIRMET-family phenomenon (MTN OBSCN, SURFACE WIND, LLWS) with no counterpart on the SIGMET feed.',
      recovery:
        'This tool reads the AWC domestic SIGMET feed, which cannot return an AIRMET — use advisory_type "sigmet" or "all", and the CONVECTIVE, TURBULENCE, ICING, or IFR hazard values. AIRMET information lives on separate products this tool does not read: the Graphical AIRMET (G-AIRMET), which replaced the textual AIRMET over the CONUS in January 2025, and the textual AIRMET feed that continues for the regions outside it.',
    },
  ],
  async handler(input, ctx) {
    if (input.bbox && !isBboxOrdered(input.bbox)) {
      throw ctx.fail(
        'invalid_bbox',
        'Bounding box is inverted: minLat must be <= maxLat and minLon <= maxLon.',
        { ...ctx.recoveryFor('invalid_bbox') },
      );
    }

    // Rejected here rather than by narrowing the Zod enum, so the caller
    // receives the typed reason and its recovery instead of a bare -32602.
    if (input.advisory_type === 'airmet') {
      throw ctx.fail(
        'airmet_not_served',
        'advisory_type "airmet" is not served: the upstream feed behind this tool carries domestic SIGMETs only.',
        { ...ctx.recoveryFor('airmet_not_served') },
      );
    }

    // `/airsigmet` enumerates exactly four hazard classes, so no row it serves
    // can carry any of the rest — filtering on one returned an empty array that
    // read as "this hazard is not active" rather than "this tool cannot answer
    // that". Narrowing here is also what lets a `SigmetHazard` reach the
    // service, so every value it can send upstream is one AWC's enum accepts.
    if (input.hazard && !isSigmetHazard(input.hazard)) {
      throw ctx.fail(
        'airmet_not_served',
        `Hazard "${input.hazard}" is not served: it is an AIRMET-family phenomenon, and the upstream feed behind this tool carries domestic SIGMETs only.`,
        { ...ctx.recoveryFor('airmet_not_served') },
      );
    }

    ctx.log.info('Fetching advisories', {
      advisoryType: input.advisory_type,
      hazard: input.hazard,
      hasBbox: !!input.bbox,
    });

    const svc = getAviationWeatherService();
    // The bbox filter runs inside the service, so the size of the draw it cut
    // reaches here only through this channel.
    let drawnRows: number | undefined;
    const advisories = await svc.fetchAdvisories(
      {
        advisoryType: input.advisory_type,
        ...(input.hazard ? { hazard: input.hazard } : {}),
        ...(input.bbox ? { bbox: input.bbox } : {}),
        onPreFilterRows: (rows) => {
          drawnRows = rows;
        },
      },
      ctx,
    );

    // The count arrives only when AWC served a readable array, so an undefined
    // one is no draw at all rather than a draw of zero. With nothing observed
    // there is no stage to name, and defaulting it to zero would assert a
    // fair-weather sky the tool never saw.
    if (advisories.length === 0 && drawnRows !== undefined) {
      ctx.enrich.notice(emptyDrawNotice(drawnRows, input.hazard, input.bbox != null));
    }

    ctx.log.info('Advisories retrieved', { count: advisories.length, drawnRows });
    return { advisories };
  },

  format: (result) => {
    const lines: string[] = [`**${result.advisories.length} active advisory(ies)**\n`];
    for (const a of result.advisories) {
      lines.push(`## ${a.advisory_type}: ${a.series_id} — ${a.hazard}`);
      // Severity is populated on convective SIGMETs and null where the advisory
      // stated none, so a dropped line reads as a severity the renderer skipped.
      lines.push(`**Severity:** ${a.severity != null ? a.severity : 'not reported'}`);
      lines.push(`**Issued by:** ${a.issued_by} | **Valid:** ${a.valid_from} → ${a.valid_to}`);

      // A bound the advisory never stated is not SFC or UNL. Those name real
      // conditions — the hazard reaching the ground, or having no top — and
      // asserting either from a null claims what the issuing office did not.
      const altLow =
        a.altitude_low_ft != null ? `${a.altitude_low_ft.toLocaleString()} ft` : 'not specified';
      const altHigh =
        a.altitude_high_ft != null ? `${a.altitude_high_ft.toLocaleString()} ft` : 'not specified';
      lines.push(`**Altitude:** ${altLow} – ${altHigh}`);

      const movDir =
        a.movement?.direction_deg != null ? `${a.movement.direction_deg}°` : 'unreported direction';
      const movSpd =
        a.movement?.speed_kt != null ? `${a.movement.speed_kt} kt` : 'unreported speed';
      lines.push(`**Movement:** ${a.movement ? `${movDir} at ${movSpd}` : 'not reported'}`);

      if (a.polygon.length > 0) {
        const pts = a.polygon
          .map((p) => `${formatDegrees(p.lat)},${formatDegrees(p.lon)}`)
          .join(' → ');
        lines.push(`**Polygon (${a.polygon.length} pts):** ${pts}`);
      }

      lines.push(`**Raw text:** \`${a.raw_text}\``);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
