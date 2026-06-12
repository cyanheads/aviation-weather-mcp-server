/**
 * @fileoverview Tool to fetch recent Pilot Reports (PIREPs) near an airport or within a bounding box.
 * @module mcp-server/tools/definitions/aviation-get-pireps
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
    cover: z.string().describe('Cloud cover code (e.g., FEW, SCT, BKN, OVC).'),
    base_ft: z.number().describe('Cloud base altitude in feet MSL.'),
    top_ft: z.number().describe('Cloud top altitude in feet MSL.'),
  })
  .describe('A cloud layer with base and top altitudes.');

export const aviationGetPireps = tool('aviation_get_pireps', {
  title: 'Get Pilot Reports (PIREPs)',
  description:
    'Get recent Pilot Reports (PIREPs) near an airport or within a bounding box. Returns decoded turbulence, icing, and cloud reports with altitude, aircraft type, intensity, and the raw PIREP string. Requires either station_id (ICAO center point for radial search, e.g., KSEA) or bbox (area search) — not both. Coverage is US-centric; PIREPs are sparse and absence of reports does not imply smooth conditions.',
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
      .default(100)
      .describe(
        'Search radius in nautical miles around station_id. Only used when station_id is provided. Default 100.',
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
      .describe('Filter by minimum altitude in feet MSL (e.g., 18000 for FL180). Optional.'),
    altitude_max_ft: z
      .number()
      .int()
      .optional()
      .describe('Filter by maximum altitude in feet MSL (e.g., 35000 for FL350). Optional.'),
  }),
  output: z.object({
    pireps: z
      .array(
        z
          .object({
            observed_at: z.string().describe('Observation time in ISO 8601 format (UTC).'),
            lat: z.number().describe('Latitude of the PIREP location in decimal degrees.'),
            lon: z.number().describe('Longitude of the PIREP location in decimal degrees.'),
            altitude_ft: z.number().describe('Reported altitude in feet MSL.'),
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
                'Turbulence layers reported. Empty array if no turbulence encountered (NEG).',
              ),
            icing: z
              .array(IcingLayerSchema)
              .describe('Icing layers reported. Empty array if no icing encountered (NEG).'),
            clouds: z
              .array(PirepCloudLayerSchema)
              .nullable()
              .describe('Cloud layers with base and top altitudes, or null if not reported.'),
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
  ],

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

    ctx.log.info('Fetching PIREPs', {
      stationId: input.station_id,
      hasBbox: !!input.bbox,
      distanceNm: input.distance_nm,
      hours: input.hours,
    });

    const svc = getAviationWeatherService();
    let pireps = await svc.fetchPireps(
      {
        ...(input.station_id ? { stationId: input.station_id } : {}),
        ...(input.bbox ? { bbox: input.bbox } : {}),
        distanceNm: input.distance_nm,
        hours: input.hours,
      },
      ctx,
    );

    const rawCount = pireps.length;

    // Client-side altitude filter (capture to const so TypeScript narrows inside the callback)
    const altMin = input.altitude_min_ft;
    const altMax = input.altitude_max_ft;
    if (altMin != null) pireps = pireps.filter((p) => p.altitude_ft >= altMin);
    if (altMax != null) pireps = pireps.filter((p) => p.altitude_ft <= altMax);

    // Sort by observation time descending
    pireps.sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime());

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

      const message = altFiltered
        ? `No PIREPs in the search area matched the altitude filter (${altRange}). ${rawCount} report(s) were found at other altitudes.`
        : `No PIREPs found in the search area for the past ${input.hours} hour(s).`;

      const recovery = altFiltered
        ? `Remove or adjust altitude_min_ft / altitude_max_ft. ${rawCount} PIREP(s) exist in the area at other altitudes.`
        : 'Expand the distance_nm or hours parameters, or try a different region. PIREPs are sparse; absence of reports does not mean smooth conditions.';

      throw ctx.fail('no_pireps_found', message, { recovery: { hint: recovery } });
    }

    ctx.log.info('PIREPs retrieved', { count: pireps.length });
    return { pireps };
  },

  format: (result) => {
    const lines: string[] = [`**${result.pireps.length} PIREP(s) found**\n`];
    for (const p of result.pireps) {
      lines.push(`## ${p.pirep_type} — ${p.observed_at}`);
      lines.push(
        `**Location:** ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} | **Altitude:** ${p.altitude_ft.toLocaleString()} ft`,
      );
      if (p.aircraft_type) lines.push(`**Aircraft:** ${p.aircraft_type}`);

      if (p.turbulence.length > 0) {
        lines.push('**Turbulence:**');
        for (const t of p.turbulence) {
          const altStr =
            t.base_ft != null && t.top_ft != null
              ? ` (${t.base_ft.toLocaleString()}–${t.top_ft.toLocaleString()} ft)`
              : '';
          const details = [t.intensity, t.type, t.frequency].filter(Boolean).join(', ');
          lines.push(`  - ${details}${altStr}`);
        }
      }

      if (p.icing.length > 0) {
        lines.push('**Icing:**');
        for (const i of p.icing) {
          const altStr =
            i.base_ft != null && i.top_ft != null
              ? ` (${i.base_ft.toLocaleString()}–${i.top_ft.toLocaleString()} ft)`
              : '';
          const details = [i.intensity, i.type].filter(Boolean).join(', ');
          lines.push(`  - ${details}${altStr}`);
        }
      }

      if (p.clouds && p.clouds.length > 0) {
        const cloudStr = p.clouds
          .map((c) => `${c.cover} ${c.base_ft.toLocaleString()}–${c.top_ft.toLocaleString()} ft`)
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
