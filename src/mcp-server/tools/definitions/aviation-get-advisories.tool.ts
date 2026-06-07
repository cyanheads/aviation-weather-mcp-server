/**
 * @fileoverview Tool to fetch active SIGMETs and AIRMETs for a region.
 * @module mcp-server/tools/definitions/aviation-get-advisories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

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
  async handler(input, ctx) {
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
      if (a.severity != null) lines.push(`**Severity:** ${a.severity}`);
      lines.push(`**Issued by:** ${a.issued_by} | **Valid:** ${a.valid_from} → ${a.valid_to}`);

      const altLow = a.altitude_low_ft != null ? `${a.altitude_low_ft.toLocaleString()} ft` : 'SFC';
      const altHigh =
        a.altitude_high_ft != null ? `${a.altitude_high_ft.toLocaleString()} ft` : 'UNL';
      lines.push(`**Altitude:** ${altLow} – ${altHigh}`);

      if (a.movement) {
        const movDir =
          a.movement.direction_deg != null ? `${a.movement.direction_deg}°` : 'stationary';
        const movSpd = a.movement.speed_kt != null ? ` at ${a.movement.speed_kt} kt` : '';
        lines.push(`**Movement:** ${movDir}${movSpd}`);
      }

      if (a.polygon.length > 0) {
        const pts = a.polygon.map((p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`).join(' → ');
        lines.push(`**Polygon (${a.polygon.length} pts):** ${pts}`);
      }

      lines.push(`**Raw text:** \`${a.raw_text}\``);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
