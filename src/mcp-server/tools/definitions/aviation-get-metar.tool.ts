/**
 * @fileoverview Tool to fetch current weather observations (METARs) for one or more airports.
 * @module mcp-server/tools/definitions/aviation-get-metar
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatDegrees } from '@/mcp-server/tools/format-degrees.js';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const CloudLayerSchema = z
  .object({
    cover: z
      .string()
      .describe(
        'Sky cover code: FEW, SCT, BKN, OVC, SKC, CLR, CAVOK, or OVX. OVX is the decoded form of a VVhhh group — the sky is obscured and the base is the vertical visibility into it, not a cloud bottom.',
      ),
    base_ft: z.number().describe('Cloud base altitude in feet AGL.'),
  })
  .describe('A reported cloud layer.');

/** Render a numeric observation, or an explicit unknown when upstream omitted it. */
function measurement(value: number | null, unit: string): string {
  return value != null ? `${value}${unit}` : 'unknown';
}

/**
 * Render the ceiling with its kind. A null ceiling means no broken, overcast,
 * or obscuration layer was reported — "none", never "clear", which would assert
 * a sky state the observation does not support (few and scattered layers can
 * sit above a station with no ceiling).
 */
function ceiling(ft: number | null, type: 'measured' | 'indefinite' | null): string {
  if (ft == null) return 'none';
  const kind =
    type === 'indefinite' ? 'indefinite — vertical visibility into an obscuration' : 'measured';
  return `${ft} ft (${kind})`;
}

export const aviationGetMetar = tool('aviation_get_metar', {
  title: 'Get METAR Weather Observations',
  description:
    'Get current weather observations (METARs) for one or more airports. Returns decoded fields — wind direction/speed/gusts, visibility, ceiling with its kind (measured, or indefinite for vertical visibility into an obscuration), present weather, temperature, dewpoint, altimeter, cloud layers — plus the computed flight category (VFR/MVFR/IFR/LIFR) and the raw METAR string. Accepts 1–10 ICAO station IDs (e.g., KSEA, KJFK). Use aviation_find_stations to resolve or verify an ICAO ID, or to discover nearby stations.',
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
                speed_kt: z
                  .number()
                  .nullable()
                  .describe(
                    'Wind speed in knots. 0 is calm (a reported 00000KT); null means the observation carried no wind group, so the speed is unknown.',
                  ),
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
                'Ceiling in feet AGL — the lowest broken, overcast, or obscuration layer. Per FAA AIM 7-1-13 the ceiling is the lowest broken or overcast layer, or the vertical visibility into an obscuration; few and scattered layers are never ceilings. Null when the observation reported no such layer.',
              ),
            ceiling_type: z
              .enum(['measured', 'indefinite'])
              .nullable()
              .describe(
                'How the ceiling height was determined: "measured" for a broken or overcast layer base, "indefinite" for vertical visibility into an obscuration (an OVX layer). Null exactly when ceiling_ft is null.',
              ),
            clouds: z
              .array(CloudLayerSchema)
              .describe('All reported cloud layers from lowest to highest.'),
            present_weather: z
              .object({
                raw: z
                  .string()
                  .describe('Weather group exactly as encoded (e.g., "FG", "-SHRA", "+RA BR").'),
                decoded: z
                  .string()
                  .describe(
                    'Plain-English reading of the group (e.g., "fog", "light rain showers").',
                  ),
              })
              .nullable()
              .describe(
                'Present weather at the station, or null when the observation carried no weather group (a dry, unobscured day).',
              ),
            temp_c: z
              .number()
              .nullable()
              .describe(
                'Temperature in degrees Celsius. 0 is a real reading; null means the observation carried no temperature, so it is unknown.',
              ),
            dewpoint_c: z
              .number()
              .nullable()
              .describe(
                'Dewpoint in degrees Celsius. 0 is a real reading; null means the observation carried no dewpoint, so it is unknown.',
              ),
            altimeter_inhg: z
              .number()
              .nullable()
              .describe(
                'Altimeter setting in inches of mercury, or null when the observation carried no altimeter group (common at stations reporting sea-level pressure only).',
              ),
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
        `**Location:** ${formatDegrees(obs.lat)}, ${formatDegrees(obs.lon)} | **Elevation:** ${obs.elevation_ft} ft`,
      );
      lines.push('');

      const gustStr = obs.wind.gust_kt != null ? ` gusting ${obs.wind.gust_kt} kt` : '';
      const dirStr = obs.wind.direction_deg != null ? `${obs.wind.direction_deg}°` : 'variable';
      const speedStr = obs.wind.speed_kt != null ? `${obs.wind.speed_kt} kt` : 'unknown speed';
      lines.push(`**Wind:** ${dirStr} at ${speedStr}${gustStr}`);
      lines.push(
        `**Visibility:** ${obs.visibility_sm} sm | **Ceiling:** ${ceiling(obs.ceiling_ft, obs.ceiling_type)}`,
      );
      if (obs.present_weather) {
        lines.push(
          `**Present weather:** ${obs.present_weather.raw} (${obs.present_weather.decoded})`,
        );
      }
      lines.push(
        `**Temperature:** ${measurement(obs.temp_c, '°C')} | **Dewpoint:** ${measurement(obs.dewpoint_c, '°C')} | **Altimeter:** ${measurement(obs.altimeter_inhg, ' inHg')}`,
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
