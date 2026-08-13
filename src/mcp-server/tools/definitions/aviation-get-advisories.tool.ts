/**
 * @fileoverview Tool to fetch active SIGMETs and AIRMETs for a region.
 * @module mcp-server/tools/definitions/aviation-get-advisories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatDegrees } from '@/mcp-server/tools/format-degrees.js';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';
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

export const aviationGetAdvisories = tool('aviation_get_advisories', {
  title: 'Get Active Aviation Advisories (SIGMETs / AIRMETs)',
  description:
    'Get active SIGMETs and AIRMETs for a region. Returns each advisory with hazard type (CONVECTIVE, TURBULENCE, ICING, IFR, MTN OBSCN, etc.), severity, altitude range, valid period, polygon coordinates, and raw text. Coverage is US-centric (NWS Aviation Weather Center). During fair-weather periods no advisories may be active — an empty result is normal, not an error. Filter by advisory_type, hazard, or bbox.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    advisory_type: z
      .enum(['sigmet', 'airmet', 'all'])
      .default('all')
      .describe(
        'Filter by advisory type. "sigmet" includes convective SIGMETs. "airmet" includes AIRMET Sierra (IFR/mountain obscuration), Tango (turbulence), and Zulu (icing). "all" returns both.',
      ),
    hazard: z
      .enum(['CONVECTIVE', 'TURBULENCE', 'ICING', 'IFR', 'MTN OBSCN', 'SURFACE WIND', 'LLWS'])
      .optional()
      .describe(
        'Optional hazard filter. CONVECTIVE = convective SIGMETs; TURBULENCE = AIRMET Tango; ICING = AIRMET Zulu; IFR = AIRMET Sierra (IFR conditions); MTN OBSCN = AIRMET Sierra (mountain obscuration); SURFACE WIND = sustained strong surface winds (typically >30 kt); LLWS = low-level wind shear below 2,000 ft AGL.',
      ),
    bbox: BboxSchema.optional(),
  }),
  output: z.object({
    advisories: z
      .array(
        z
          .object({
            advisory_type: z.string().describe('Advisory type: SIGMET or AIRMET.'),
            series_id: z.string().describe('Unique advisory identifier (e.g., BOSMA0).'),
            hazard: z
              .string()
              .describe('Hazard type (e.g., CONVECTIVE, TURBULENCE, ICING, IFR, MTN OBSCN).'),
            severity: z
              .number()
              .nullable()
              .describe(
                'Severity integer for convective SIGMETs (higher = more intense). Null for AIRMETs.',
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
                'Original encoded SIGMET or AIRMET text as issued by the meteorological watch office.',
              ),
          })
          .describe('An active SIGMET or AIRMET advisory.'),
      )
      .describe(
        'Active advisories matching the filter criteria. May be empty during fair weather periods.',
      ),
  }),
  errors: [
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The bounding box is inverted — minLat > maxLat or minLon > maxLon.',
      recovery:
        'Ensure minLat <= maxLat and minLon <= maxLon. Swap the inverted min/max coordinates and retry.',
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

    ctx.log.info('Fetching advisories', {
      advisoryType: input.advisory_type,
      hazard: input.hazard,
      hasBbox: !!input.bbox,
    });

    const svc = getAviationWeatherService();
    const advisories = await svc.fetchAdvisories(
      {
        advisoryType: input.advisory_type,
        ...(input.hazard ? { hazard: input.hazard } : {}),
        ...(input.bbox ? { bbox: input.bbox } : {}),
      },
      ctx,
    );

    ctx.log.info('Advisories retrieved', { count: advisories.length });
    return { advisories };
  },

  format: (result) => {
    const lines: string[] = [`**${result.advisories.length} active advisory(ies)**\n`];
    for (const a of result.advisories) {
      lines.push(`## ${a.advisory_type}: ${a.series_id} — ${a.hazard}`);
      // Severity is populated on convective SIGMETs and null on AIRMETs, so a
      // dropped line reads as a severity the renderer skipped.
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
