/**
 * @fileoverview Tool to fetch Terminal Aerodrome Forecasts (TAFs) for one or more airports.
 * @module mcp-server/tools/definitions/aviation-get-taf
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const TafCloudLayerSchema = z
  .object({
    cover: z
      .string()
      .describe(
        'Sky cover code: FEW, SCT, BKN, OVC, SKC, or OVX. OVX is the decoded form of a VVhhh group — the sky is obscured and the base is the vertical visibility into it, not a cloud bottom.',
      ),
    base_ft: z
      .number()
      .describe(
        'Cloud base altitude in feet AGL. On an OVX layer this is the vertical visibility into the obscuration rather than a layer bottom, and 0 is a surface-level indefinite ceiling.',
      ),
    type: z
      .string()
      .nullable()
      .describe(
        'Cloud type qualifier: CB (cumulonimbus), TCU (towering cumulus), or null. An obscuration can carry one — a VV008CB group is an OVX layer with type CB.',
      ),
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
          .describe(
            'Forecast wind direction in degrees true. Null when the forecast said VRB (variable), and also when the period carries no wind element at all — speed_kt is null in that second case and a number in the first.',
          ),
        speed_kt: z
          .number()
          .nullable()
          .describe(
            'Forecast wind speed in knots. 0 is a forecast calm (a 00000KT group); null means the period amends only visibility, weather, or cloud and carries no wind element, so the wind is unknown rather than calm.',
          ),
        gust_kt: z.number().nullable().describe('Forecast gust speed in knots, or null if none.'),
      })
      .describe('Forecast wind conditions at the surface for this period.'),
    wind_shear: z
      .object({
        height_ft: z
          .number()
          .describe(
            'Top of the shear layer in feet AGL — not the layer base and not its thickness. A WS020 group is 2000 ft.',
          ),
        direction_deg: z
          .number()
          .describe(
            'Forecast wind direction at the top of the shear layer, in degrees true — not a direction of shear.',
          ),
        speed_kt: z
          .number()
          .describe(
            'Forecast wind speed at the top of the shear layer, in knots — the wind at that height, not the magnitude of the shear.',
          ),
      })
      .nullable()
      .describe(
        'Forecast non-convective low-level wind shear (a WS group), confined to the surface–2,000 ft AGL band. A null means no non-convective LLWS group was issued for this period, rather than no shear expected: the group is excluded from TEMPO and PROB groups, and shear is always assumed present in convective activity.',
      ),
    visibility_sm: z
      .string()
      .nullable()
      .describe('Forecast visibility in statute miles (e.g., "6", "1/2"). Null if not specified.'),
    vertical_visibility_ft: z
      .number()
      .nullable()
      .describe(
        'Vertical visibility into a forecast obscuration, in feet AGL — an indefinite ceiling, and the same height as this period OVX cloud layer. 0 is a surface-level indefinite ceiling; null means the period forecasts no obscuration.',
      ),
    weather: z
      .object({
        raw: z
          .string()
          .describe(
            'Weather groups exactly as forecast, space-delimited (e.g., "-SHRA", "-SHRA BR", "VCTS -RA").',
          ),
        decoded: z
          .string()
          .describe(
            'Plain-English reading of each group, joined with "; " (e.g., "light rain showers; mist"). A group the decoder does not recognize is carried through as its own raw token rather than half-translated, so compare against raw when a reading still looks coded.',
          ),
      })
      .nullable()
      .describe(
        'Forecast weather for this period, or null when the period carried no weather group.',
      ),
    clouds: z.array(TafCloudLayerSchema).describe('Forecast cloud layers for this period.'),
  })
  .describe('A single TAF forecast period.');

export const aviationGetTaf = tool('aviation_get_taf', {
  title: 'Get Terminal Aerodrome Forecast (TAF)',
  description:
    'Get the Terminal Aerodrome Forecast (TAF) for one or more airports. Returns each forecast period with valid times, surface wind, low-level wind shear, visibility, decoded weather conditions, cloud layers, and the vertical visibility into a forecast obscuration, plus the raw TAF string. TAFs cover the next 24–30 hours and are issued only for airports with scheduled commercial service; check data_types from aviation_find_stations to confirm TAF availability. Accepts 1–4 ICAO station IDs (e.g., KSEA, KJFK).',
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

  enrichment: {
    requested: z
      .array(z.string().describe('An ICAO station ID as requested.'))
      .describe('Station IDs this call asked for, in the order given.'),
    returned: z
      .array(z.string().describe('An ICAO station ID present in the result.'))
      .describe('Distinct station IDs that produced a forecast.'),
    partial: z
      .boolean()
      .describe(
        'True when a requested station produced no forecast. False affirms the result covers every requested station, so full coverage is distinguishable from a short batch rather than being inferred from the count.',
      ),
    missing: z
      .array(z.string().describe('A requested ICAO station ID that produced no forecast.'))
      .optional()
      .describe('Requested station IDs absent from the result. Absent when none are missing.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance naming the missing station IDs. Present only on a partial result. It lists the candidate causes without asserting one — upstream omits the row either way.',
      ),
  },

  enrichmentTrailer: {
    requested: { render: (ids) => `**Requested:** ${ids.join(', ')}` },
    returned: { render: (ids) => `**Returned:** ${ids.join(', ')}` },
    missing: { render: (ids) => `**No forecast returned for:** ${ids?.join(', ')}` },
    partial: { label: 'Partial result' },
  },

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

    // Upstream drops a station that issued no forecast without reporting it, so
    // a route check asking for departure, destination, and alternate cannot see
    // which leg came back empty — or that anything is missing at all.
    const returned = [...new Set(forecasts.map((f) => f.station_id))];
    const missing = input.station_ids.filter((id) => !returned.includes(id));
    ctx.enrich({ requested: input.station_ids, returned, partial: missing.length > 0 });
    if (missing.length > 0) {
      ctx.enrich({ missing });
      ctx.enrich.notice(
        `No forecast returned for ${missing.join(', ')}. Two conditions produce this and the response cannot tell them apart: the ID may not be a known station, or the station may issue no TAFs. Check data_types from aviation_find_stations to confirm TAF capability.`,
      );
    }

    ctx.log.info('TAFs retrieved', { count: forecasts.length, missing: missing.length });
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
        // A forecast probability of 0 is a value, not an absence — a truthiness
        // guard here would drop it.
        const probLabel = period.probability != null ? ` (${period.probability}%)` : '';
        lines.push(`### ${changeLabel}${period.from} → ${period.to}${probLabel}`);

        // A period with no wind element has no direction to call variable and
        // no speed to call calm. Both come from the same absent group.
        if (period.wind.speed_kt != null) {
          const gustStr = period.wind.gust_kt != null ? ` gusting ${period.wind.gust_kt} kt` : '';
          const dirStr =
            period.wind.direction_deg != null ? `${period.wind.direction_deg}°` : 'variable';
          lines.push(`**Wind:** ${dirStr} at ${period.wind.speed_kt} kt${gustStr}`);
        } else {
          lines.push('**Wind:** not specified');
        }

        // Omitted rather than negated: a null is no LLWS group in a period that
        // can carry one, which is not a forecast of smooth air.
        if (period.wind_shear) {
          lines.push(
            `**Wind shear:** layer top ${period.wind_shear.height_ft} ft AGL, forecast wind ${period.wind_shear.direction_deg}° at ${period.wind_shear.speed_kt} kt`,
          );
        }

        lines.push(
          `**Visibility:** ${period.visibility_sm != null ? `${period.visibility_sm} sm` : 'not specified'}`,
        );
        lines.push(
          `**Weather:** ${period.weather ? `${period.weather.raw} (${period.weather.decoded})` : 'not specified'}`,
        );
        // A forecast vertical visibility of 0 is a surface-level indefinite
        // ceiling — the most hazardous value the field holds, and the one a
        // truthiness guard drops.
        if (period.vertical_visibility_ft != null) {
          lines.push(
            `**Vertical visibility:** ${period.vertical_visibility_ft} ft AGL (indefinite ceiling)`,
          );
        }
        if (period.clouds.length > 0) {
          const cloudStr = period.clouds
            .map((c) => `${c.cover} @ ${c.base_ft} ft${c.type ? ` (${c.type})` : ''}`)
            .join(', ');
          lines.push(`**Clouds:** ${cloudStr}`);
        } else {
          lines.push('**Clouds:** Clear');
        }
        lines.push('');
      }

      lines.push(`**Raw TAF:** \`${taf.raw_taf}\``);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
