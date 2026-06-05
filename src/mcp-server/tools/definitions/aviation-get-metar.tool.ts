/**
 * @fileoverview Tool to fetch current weather observations (METARs) for one or more airports.
 * @module mcp-server/tools/definitions/aviation-get-metar
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const CloudLayerSchema = z
  .object({
    cover: z.string().describe('Sky cover code: FEW, SCT, BKN, OVC, SKC, CLR.'),
    base_ft: z.number().describe('Cloud base altitude in feet MSL.'),
  })
  .describe('A reported cloud layer.');

export const aviationGetMetar = tool('aviation_get_metar', {
  title: 'Get METAR Weather Observations',
  description:
    'Get current weather observations (METARs) for one or more airports. Returns decoded fields — wind direction/speed/gusts, visibility, ceiling, temperature, dewpoint, altimeter, cloud layers — plus the computed flight category (VFR/MVFR/IFR/LIFR) and the raw METAR string. Accepts 1–10 ICAO station IDs (e.g., KSEA, KJFK). Use aviation_find_stations to resolve or verify an ICAO ID, or to discover nearby stations.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    station_ids: z
      .array(
        z
          .string()
          .regex(/^[A-Z]{4}$/)
          .describe('4-letter ICAO station ID (e.g., KSEA, KJFK).'),
      )
      .min(1)
      .max(10)
      .describe('ICAO station IDs to query. 1–10 stations per call.'),
    hours: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(1)
      .describe(
        'Hours of observation history to return (1–12). Default 1 returns only the most recent observation per station.',
      ),
  }),
  output: z.object({
    observations: z
      .array(
        z
          .object({
            station_id: z.string().describe('ICAO 4-letter station identifier (e.g., KSEA).'),
            name: z.string().describe('Human-readable station or airport name.'),
            lat: z.number().describe('Station latitude in decimal degrees.'),
            lon: z.number().describe('Station longitude in decimal degrees.'),
            elevation_ft: z.number().describe('Station elevation in feet MSL.'),
            flight_category: z
              .string()
              .describe(
                'Flight category: VFR, MVFR, IFR, or LIFR based on ceiling and visibility.',
              ),
            metar_type: z
              .string()
              .describe(
                'METAR (routine) or SPECI (special observation triggered by significant weather change).',
              ),
            observed_at: z.string().describe('Observation time in ISO 8601 format (UTC).'),
            wind: z
              .object({
                direction_deg: z
                  .number()
                  .nullable()
                  .describe('Wind direction in degrees true. Null when variable.'),
                speed_kt: z.number().describe('Wind speed in knots.'),
                gust_kt: z
                  .number()
                  .nullable()
                  .describe('Gust speed in knots, or null if no gusts reported.'),
              })
              .describe('Wind conditions at the station.'),
            visibility_sm: z
              .string()
              .describe('Prevailing visibility in statute miles (e.g., "10+", "3", "1/2").'),
            ceiling_ft: z
              .number()
              .nullable()
              .describe(
                'Ceiling in feet MSL — lowest BKN or OVC layer base. Null when sky is clear.',
              ),
            clouds: z
              .array(CloudLayerSchema)
              .describe('All reported cloud layers from lowest to highest.'),
            temp_c: z.number().describe('Temperature in degrees Celsius.'),
            dewpoint_c: z.number().describe('Dewpoint in degrees Celsius.'),
            altimeter_inhg: z.number().describe('Altimeter setting in inches of mercury.'),
            raw_metar: z
              .string()
              .describe(
                'Original encoded METAR string (e.g., "KSEA 041453Z 18006KT 10SM FEW035 09/03 A2991").',
              ),
          })
          .describe('A single weather observation from one station at one time.'),
      )
      .describe(
        'Weather observations, one per station/time pair. Multiple entries per station when hours > 1.',
      ),
  }),
  errors: [
    {
      reason: 'no_stations_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'None of the requested station IDs returned METAR data.',
      recovery:
        'Verify ICAO IDs with aviation_find_stations. Not all stations transmit METARs. Check that the station IDs are 4-letter ICAO format (e.g., KSEA not SEA).',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching METARs', { stationIds: input.station_ids, hours: input.hours });
    const svc = getAviationWeatherService();
    const observations = await svc.fetchMetar(input.station_ids, input.hours, ctx);

    if (observations.length === 0) {
      throw ctx.fail(
        'no_stations_found',
        `No METAR data found for: ${input.station_ids.join(', ')}`,
        {
          stationIds: input.station_ids,
          ...ctx.recoveryFor('no_stations_found'),
        },
      );
    }

    ctx.log.info('METARs retrieved', { count: observations.length });
    return { observations };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const obs of result.observations) {
      lines.push(`## ${obs.station_id} — ${obs.name}`);
      lines.push(
        `**Flight Category:** ${obs.flight_category} | **Type:** ${obs.metar_type} | **Observed:** ${obs.observed_at}`,
      );
      lines.push(
        `**Location:** ${obs.lat.toFixed(4)}, ${obs.lon.toFixed(4)} | **Elevation:** ${obs.elevation_ft} ft`,
      );
      lines.push('');

      const gustStr = obs.wind.gust_kt != null ? ` gusting ${obs.wind.gust_kt} kt` : '';
      const dirStr = obs.wind.direction_deg != null ? `${obs.wind.direction_deg}°` : 'variable';
      lines.push(`**Wind:** ${dirStr} at ${obs.wind.speed_kt} kt${gustStr}`);
      lines.push(
        `**Visibility:** ${obs.visibility_sm} sm | **Ceiling:** ${obs.ceiling_ft != null ? `${obs.ceiling_ft} ft` : 'Clear'}`,
      );
      lines.push(
        `**Temperature:** ${obs.temp_c}°C | **Dewpoint:** ${obs.dewpoint_c}°C | **Altimeter:** ${obs.altimeter_inhg} inHg`,
      );

      if (obs.clouds.length > 0) {
        lines.push(
          `**Clouds:** ${obs.clouds.map((c) => `${c.cover} @ ${c.base_ft} ft`).join(', ')}`,
        );
      } else {
        lines.push(`**Clouds:** Clear`);
      }

      lines.push(`**Raw METAR:** \`${obs.raw_metar}\``);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
