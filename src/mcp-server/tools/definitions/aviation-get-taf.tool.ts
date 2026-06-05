/**
 * @fileoverview Tool to fetch Terminal Aerodrome Forecasts (TAFs) for one or more airports.
 * @module mcp-server/tools/definitions/aviation-get-taf
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const TafCloudLayerSchema = z
  .object({
    cover: z.string().describe('Sky cover code: FEW, SCT, BKN, OVC, SKC, CLR.'),
    base_ft: z.number().describe('Cloud base altitude in feet MSL.'),
    type: z
      .string()
      .nullable()
      .describe('Cloud type qualifier: CB (cumulonimbus), TCU (towering cumulus), or null.'),
  })
  .describe('A forecast cloud layer.');

const ForecastPeriodSchema = z
  .object({
    from: z.string().describe('Period start time in ISO 8601 format (UTC).'),
    to: z.string().describe('Period end time in ISO 8601 format (UTC).'),
    change_type: z
      .string()
      .nullable()
      .describe(
        'Change indicator: FM (from), TEMPO (temporary), BECMG (becoming), or null for the base period.',
      ),
    probability: z
      .number()
      .nullable()
      .describe('Probability percentage (30 or 40) for TEMPO/PROB groups. Null if not specified.'),
    wind: z
      .object({
        direction_deg: z
          .number()
          .nullable()
          .describe('Forecast wind direction in degrees true. Null when variable.'),
        speed_kt: z.number().describe('Forecast wind speed in knots.'),
        gust_kt: z.number().nullable().describe('Forecast gust speed in knots, or null if none.'),
      })
      .describe('Forecast wind conditions for this period.'),
    visibility_sm: z
      .string()
      .nullable()
      .describe('Forecast visibility in statute miles (e.g., "6", "1/2"). Null if not specified.'),
    weather: z
      .string()
      .nullable()
      .describe(
        'Decoded weather condition (e.g., "light rain showers", "thunderstorm with rain"). Null if none.',
      ),
    clouds: z.array(TafCloudLayerSchema).describe('Forecast cloud layers for this period.'),
  })
  .describe('A single TAF forecast period.');

export const aviationGetTaf = tool('aviation_get_taf', {
  title: 'Get Terminal Aerodrome Forecast (TAF)',
  description:
    'Get the Terminal Aerodrome Forecast (TAF) for one or more airports. Returns each forecast period with valid times, wind, visibility, decoded weather conditions, and cloud layers, plus the raw TAF string. TAFs cover the next 24–30 hours and are issued only for airports with scheduled commercial service; check data_types from aviation_find_stations to confirm TAF availability. Accepts 1–4 ICAO station IDs (e.g., KSEA, KJFK).',
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
      .max(4)
      .describe('ICAO station IDs to query. 1–4 stations per call.'),
  }),
  output: z.object({
    forecasts: z
      .array(
        z
          .object({
            station_id: z.string().describe('ICAO 4-letter station identifier (e.g., KSEA).'),
            name: z.string().describe('Human-readable station or airport name.'),
            issued_at: z.string().describe('TAF issue time in ISO 8601 format (UTC).'),
            valid_from: z
              .string()
              .describe('Forecast validity period start in ISO 8601 format (UTC).'),
            valid_to: z.string().describe('Forecast validity period end in ISO 8601 format (UTC).'),
            forecast_periods: z
              .array(ForecastPeriodSchema)
              .describe('Ordered list of forecast periods from base to end of validity.'),
            raw_taf: z
              .string()
              .describe(
                'Original encoded TAF string (e.g., "TAF KSEA 041730Z 0418/0524 18010KT P6SM SKC ...").',
              ),
          })
          .describe('A Terminal Aerodrome Forecast for one station.'),
      )
      .describe('TAF forecasts, one per requested station.'),
  }),
  errors: [
    {
      reason: 'no_taf_available',
      code: JsonRpcErrorCode.NotFound,
      when: 'Station does not issue TAFs or no TAF is currently available.',
      recovery:
        'Not all airports have TAFs — only major airports with scheduled commercial service typically issue them. Check data_types from aviation_find_stations to confirm TAF capability. Smaller airports may only have METARs.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching TAFs', { stationIds: input.station_ids });
    const svc = getAviationWeatherService();
    const forecasts = await svc.fetchTaf(input.station_ids, ctx);

    if (forecasts.length === 0) {
      throw ctx.fail('no_taf_available', `No TAF data found for: ${input.station_ids.join(', ')}`, {
        stationIds: input.station_ids,
        ...ctx.recoveryFor('no_taf_available'),
      });
    }

    ctx.log.info('TAFs retrieved', { count: forecasts.length });
    return { forecasts };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const taf of result.forecasts) {
      lines.push(`## ${taf.station_id} — ${taf.name}`);
      lines.push(`**Issued:** ${taf.issued_at} | **Valid:** ${taf.valid_from} → ${taf.valid_to}`);
      lines.push('');

      for (const period of taf.forecast_periods) {
        const changeLabel = period.change_type ? `**${period.change_type}** ` : '';
        const probLabel = period.probability ? ` (${period.probability}%)` : '';
        lines.push(`### ${changeLabel}${period.from} → ${period.to}${probLabel}`);

        const gustStr = period.wind.gust_kt != null ? ` gusting ${period.wind.gust_kt} kt` : '';
        const dirStr =
          period.wind.direction_deg != null ? `${period.wind.direction_deg}°` : 'variable';
        lines.push(`**Wind:** ${dirStr} at ${period.wind.speed_kt} kt${gustStr}`);

        if (period.visibility_sm != null) {
          lines.push(`**Visibility:** ${period.visibility_sm} sm`);
        }
        if (period.weather) {
          lines.push(`**Weather:** ${period.weather}`);
        }
        if (period.clouds.length > 0) {
          const cloudStr = period.clouds
            .map((c) => `${c.cover} @ ${c.base_ft} ft${c.type ? ` (${c.type})` : ''}`)
            .join(', ');
          lines.push(`**Clouds:** ${cloudStr}`);
        }
        lines.push('');
      }

      lines.push(`**Raw TAF:** \`${taf.raw_taf}\``);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
