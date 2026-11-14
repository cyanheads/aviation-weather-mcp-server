/**
 * @fileoverview Tool to fetch Terminal Aerodrome Forecasts (TAFs) for one or more airports.
 * @module mcp-server/tools/definitions/aviation-get-taf
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatSkyLine } from '@/mcp-server/tools/format-sky-condition.js';
import {
  cappedLimitSchema,
  clampResultLimit,
  continuationNotice,
  pageResults,
} from '@/mcp-server/tools/result-page.js';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';
import { AWC_MAX_ROWS, isUpstreamCapped } from '@/services/aviation-weather/awc-limits.js';
import { isBboxOrdered } from '@/services/aviation-weather/bbox.js';
import { HistoryAnchorSchema } from '@/services/aviation-weather/history-anchor.js';
import { isSupportedState } from '@/services/aviation-weather/supported-states.js';

/**
 * Change indicators that amend a prevailing forecast rather than replacing it.
 * A group of one of these kinds carrying no cloud element leaves the prevailing
 * cloud standing; an `FM` group or the base period has nothing to inherit, so
 * the same absent element means the forecast simply did not state one.
 */
const AMENDING_CHANGE_TYPES = new Set(['TEMPO', 'PROB', 'BECMG']);

/** How a period with neither layers nor a sky-condition group reads. */
function unamendedCloudReading(changeType: string | null): string {
  return changeType != null && AMENDING_CHANGE_TYPES.has(changeType.toUpperCase())
    ? 'not amended — this period carries no cloud element, so the prevailing forecast stands'
    : 'not specified';
}

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
    transition_end: z
      .string()
      .nullable()
      .describe(
        'BECMG transition end in ISO 8601 UTC, independently of the period end. Null when AWC did not supply it.',
      ),
    altimeter_hpa: z
      .number()
      .nullable()
      .describe('Forecast altimeter setting in hPa. Null when AWC did not supply it.'),
    temperature_forecasts: z
      .array(
        z
          .object({
            kind: z.string().describe('AWC extremum code, typically MAX or MIN.'),
            valid_at: z
              .string()
              .describe(
                'Time of the extremum in ISO 8601 UTC, which can fall outside this period.',
              ),
            temperature_c: z.number().describe('Forecast surface temperature in degrees Celsius.'),
          })
          .describe('One decoded temperature extremum.'),
      )
      .describe('Temperature extrema attached by AWC. Empty when AWC supplied none.'),
    icing_turbulence: z
      .array(
        z
          .object({
            kind: z.string().describe('AWC layer code, typically ICE or TURB.'),
            intensity_code: z.number().int().describe('Intensity code as decoded by AWC.'),
            min_altitude_ft: z
              .number()
              .nullable()
              .describe('Lower bound in feet as reported by AWC. Null when unspecified.'),
            max_altitude_ft: z
              .number()
              .nullable()
              .describe('Upper bound in feet as reported by AWC. Null when unspecified.'),
          })
          .describe('One decoded icing or turbulence layer.'),
      )
      .describe('Icing and turbulence layers attached by AWC. Empty when AWC supplied none.'),
    change_type: z
      .string()
      .nullable()
      .describe(
        'Change indicator: FM (from), TEMPO (temporary), BECMG (becoming), PROB (a standalone probability group), or null for the base period. A PROB30 or PROB40 qualifying a temporary group arrives as TEMPO; standing alone, with no temporary group after it, it arrives as PROB. Either way the percentage is in probability.',
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
    clouds: z
      .array(TafCloudLayerSchema)
      .describe(
        'Forecast cloud layers for this period, as AWC decoded them — at most three, so a further layer is left out of this array and its text surfaces in not_decoded, with raw_taf the complete source. Empty whenever the period published no layer heights, which covers a forecast clear sky and a period carrying no cloud element at all; sky_condition distinguishes them. An empty array is not a forecast of a clear sky on its own.',
      ),
    sky_condition: z
      .string()
      .nullable()
      .describe(
        'The sky condition this period forecast when it published no layer heights: SKC or NSC for a clear or insignificant-cloud forecast (a CAVOK group arrives as NSC), OVX for a forecast obscuration carrying no vertical visibility. Null when clouds carries layers — those are the statement — and also when the period carried no cloud element at all. An empty clouds array beside a null here forecasts nothing about cloud; on a TEMPO, PROB, or BECMG group that means the prevailing forecast stands unchanged, never that the sky will be clear.',
      ),
    not_decoded: z
      .string()
      .nullable()
      .describe(
        'Text AWC attached to this period without decoding it, trimmed — usually a cloud layer past the three-layer decode limit, sometimes another group such as VV///. Null when nothing was left undecoded. Non-null marks a partial decode. Upstream can attach the leftover of one group, such as a TEMPO, to the period after it, so the text is published on the period it arrived on and never reassigned or parsed into clouds; raw_taf is the complete forecast.',
      ),
  })
  .describe('A single TAF forecast period.');

export const aviationGetTaf = tool('aviation_get_taf', {
  title: 'Get Terminal Aerodrome Forecast (TAF)',
  description:
    'Get Terminal Aerodrome Forecasts (TAFs) for 1–4 named stations, an area bounding box, or a US state or DC. Returns forecast periods, winds, wind shear, visibility, weather, cloud layers, vertical visibility, and raw TAFs. Check each forecast’s validity window for the time of interest. Use aviation_find_stations to check station forecast capability.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    station_ids: z
      .array(
        z
          .string()
          .regex(
            /^[A-Za-z0-9]{4}$/,
            'Use a 4-character ICAO ID containing ASCII letters or digits (e.g., KSEA, K0S9), in either case. For an IATA/FAA code, use aviation_find_stations with state or bbox to find the ICAO ID; do not infer a mapping.',
          )
          .describe(
            'ICAO station ID: 4 ASCII letters or digits, case-insensitive and normalized to uppercase (e.g., KSEA, KJFK, K36U).',
          ),
      )
      .min(1)
      .max(4)
      .optional()
      .describe('ICAO station IDs to query. 1–4 stations per call.'),
    bbox: z
      .object({
        minLat: z
          .number()
          .min(-90)
          .max(90)
          .describe('Southern boundary latitude in decimal degrees.'),
        minLon: z
          .number()
          .min(-180)
          .max(180)
          .describe('Western boundary longitude in decimal degrees.'),
        maxLat: z
          .number()
          .min(-90)
          .max(90)
          .describe('Northern boundary latitude in decimal degrees.'),
        maxLon: z
          .number()
          .min(-180)
          .max(180)
          .describe('Eastern boundary longitude in decimal degrees.'),
      })
      .optional()
      .describe('Geographic bounding box for a forecast survey.'),
    state: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe(
        'Two-letter US state or DC code, case-insensitive. Returns forecasts available through the AWC state selector.',
      ),
    limit: cappedLimitSchema().describe(
      `Maximum forecasts to return from offset in a bbox or state survey. The served maximum is ${AWC_MAX_ROWS} when limit is supplied. Omit to return all remaining matches.`,
    ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Zero-based survey start ordered by station ID, issue time descending, then raw bulletin.',
      ),
    as_of: HistoryAnchorSchema.optional().describe(
      'Historical issuance reference as YYYY-MM-DDTHH:mm:ssZ or YYYY-MM-DDTHH:mm:ss.sssZ within the previous 30 days. Check the returned validity window separately. Omit for current forecasts.',
    ),
  }),
  output: z.object({
    forecasts: z
      .array(
        z
          .object({
            station_id: z
              .string()
              .describe(
                'ICAO station identifier, 4 uppercase letters or digits (e.g., KSEA, K36U).',
              ),
            name: z.string().describe('Human-readable station or airport name.'),
            amended: z
              .boolean()
              .nullable()
              .describe(
                'Whether the recognizable bulletin header carries AMD. Null when the header cannot be classified.',
              ),
            remarks: z
              .string()
              .nullable()
              .describe('AWC bulletin remarks, trimmed. Null when no remarks were decoded.'),
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
      .describe('TAF products returned for the selected stations or survey.'),
  }),
  errors: [
    {
      reason: 'missing_location',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No location selector was provided.',
      recovery: 'Provide station_ids, bbox, or state to select forecasts.',
    },
    {
      reason: 'conflicting_location',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than one location selector was provided.',
      recovery: 'Choose one selector: station_ids, bbox, or state.',
    },
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The bounding box has inverted latitude or longitude bounds.',
      recovery: 'Set minLat at or below maxLat and minLon at or below maxLon.',
    },
    {
      reason: 'invalid_state',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The state code is outside the 50 US states and DC.',
      recovery: 'Use a US state or DC code, or provide a bounding box.',
    },
    {
      reason: 'conflicting_offset',
      code: JsonRpcErrorCode.ValidationError,
      when: 'offset was supplied for a named station lookup.',
      recovery: 'Drop offset or run a bbox or state survey.',
    },
    {
      reason: 'conflicting_limit',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A caller limit was provided for a named lookup.',
      recovery: 'Drop limit or select an area with bbox or state.',
    },
    {
      reason: 'future_as_of',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The historical reference time is in the future.',
      recovery: 'Use a UTC timestamp at or before the current time.',
      thrownBy: 'service',
    },
    {
      reason: 'outside_retention',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The historical reference time predates the AWC retention window.',
      recovery: 'Use a UTC timestamp within the past 30 days.',
      thrownBy: 'service',
    },
    {
      reason: 'no_taf_available',
      code: JsonRpcErrorCode.NotFound,
      when: 'The selected stations or survey returned no forecasts for the requested time.',
      // Most airports issue no TAF at all, so a miss is an ordinary answer to
      // the lookup rather than an incident.
      severity: 'notice',
      recovery:
        'Check data_types from aviation_find_stations for TAF capability. Use bbox around the airport to look for other reporting stations.',
    },
  ],

  enrichment: {
    nextOffset: z
      .number()
      .int()
      .optional()
      .describe(
        'Offset for the next page of the currently available draw. Present only while matches remain.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'Whether a survey reached the upstream row cap. A value of false only says the draw fell below the cap.',
      ),
    cap: z.number().optional().describe('Upstream forecast row cap, shown when reached.'),
    shown: z.number().optional().describe('Forecasts shown from a survey after any limit.'),
    limited: z
      .boolean()
      .optional()
      .describe(
        'Whether the caller limit withheld forecasts from this draw. Present when a survey has a limit.',
      ),
    matched: z
      .number()
      .optional()
      .describe(
        'Forecasts in the draw before paging. Present when offset was supplied or limit withheld matches.',
      ),
    requested: z
      .array(z.string().describe('An ICAO station ID as requested.'))
      .optional()
      .describe('Station IDs this call asked for, in the order given.'),
    returned: z
      .array(z.string().describe('An ICAO station ID present in the result.'))
      .optional()
      .describe('Distinct station IDs that produced a forecast.'),
    partial: z
      .boolean()
      .optional()
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
        'Guidance about missing named stations, a capped survey, or a survey limited by the caller.',
      ),
  },

  enrichmentTrailer: {
    nextOffset: { label: 'Next offset' },
    requested: { render: (ids) => `**Requested:** ${ids?.join(', ')}` },
    returned: { render: (ids) => `**Returned:** ${ids?.join(', ')}` },
    missing: { render: (ids) => `**No forecast returned for:** ${ids?.join(', ')}` },
    partial: { label: 'Partial result' },
    truncated: { label: 'Truncated at the upstream row cap' },
    cap: { label: 'Upstream row maximum' },
    shown: { label: 'Forecasts returned' },
    limited: { label: 'Limited by the request' },
    matched: { label: 'Forecasts matched before paging' },
  },

  async handler(input, ctx) {
    const stationIds = input.station_ids?.map((id) => id.toUpperCase());
    const state = input.state?.toUpperCase();
    const { bbox, offset, as_of: asOf } = input;
    const location = stationIds ?? (bbox ? { bbox } : state ? { state } : undefined);
    if (!location) {
      throw ctx.fail('missing_location', 'Provide station_ids, bbox, or state.');
    }
    if (Number(!!stationIds) + Number(!!bbox) + Number(!!state) > 1) {
      throw ctx.fail(
        'conflicting_location',
        'Provide exactly one of station_ids, bbox, and state.',
      );
    }
    if (bbox && !isBboxOrdered(bbox)) {
      throw ctx.fail('invalid_bbox', 'Bounding box bounds must be in ascending order.');
    }
    if (state && !isSupportedState(state)) {
      throw ctx.fail('invalid_state', `Unsupported state code: ${state}.`);
    }
    if (stationIds && offset !== undefined) {
      throw ctx.fail('conflicting_offset', 'offset applies only to bbox and state surveys.');
    }
    if (stationIds && input.limit !== undefined) {
      throw ctx.fail('conflicting_limit', 'limit applies to bbox and state surveys.');
    }
    ctx.log.info('Fetching TAFs', { location });
    const svc = getAviationWeatherService();
    const forecasts = asOf
      ? await svc.fetchTaf(location, ctx, asOf)
      : await svc.fetchTaf(location, ctx);

    if (forecasts.length === 0) {
      const anchor = asOf ? ` at the issuance reference ${asOf}` : '';
      const scope =
        stationIds?.join(', ') ?? (state ? `AWC's ${state} survey` : 'the bounding box');
      throw ctx.fail(
        'no_taf_available',
        `No TAF data found for: ${scope}${anchor}`,
        stationIds
          ? { stationIds }
          : {
              ...(state ? { state } : { bbox }),
              recovery: {
                hint: 'Try a wider bounding box and check station forecast capability with aviation_find_stations.',
              },
            },
      );
    }
    if (!stationIds) {
      const capped = isUpstreamCapped(forecasts.length);
      const { limit, notice: clampNotice } = clampResultLimit(
        input.limit,
        'aviation_get_taf',
        ctx.log,
      );
      const ordered =
        limit === undefined && offset === undefined
          ? forecasts
          : forecasts.toSorted(
              (a, b) =>
                a.station_id.localeCompare(b.station_id) ||
                b.issued_at.localeCompare(a.issued_at) ||
                a.raw_taf.localeCompare(b.raw_taf),
            );
      const { rows: selected, nextOffset } = pageResults(ordered, offset, limit);
      const limited = limit !== undefined && nextOffset !== undefined;
      const capHint = state
        ? 'Search smaller geographic boxes within the state and combine the results.'
        : 'Search smaller bounding boxes and combine the results.';
      const notice = [
        capped ? `AWC reached its ${AWC_MAX_ROWS}-row cap. ${capHint}` : '',
        offset !== undefined
          ? `Returned ${selected.length} of ${forecasts.length} matching forecasts from offset ${offset} in this draw.`
          : limited
            ? `The caller limit shows ${selected.length} of ${forecasts.length} forecasts in this draw.`
            : '',
        clampNotice,
        nextOffset === undefined ? null : continuationNotice(nextOffset),
      ]
        .filter(Boolean)
        .join(' ');
      if (capped) {
        ctx.enrich.truncated({ shown: selected.length, cap: AWC_MAX_ROWS, guidance: notice });
      } else {
        ctx.enrich({ truncated: false, shown: selected.length });
        if (notice) ctx.enrich.notice(notice);
      }
      if (limit !== undefined) ctx.enrich({ limited });
      if (limited || offset !== undefined) ctx.enrich({ matched: forecasts.length });
      if (nextOffset !== undefined) ctx.enrich({ nextOffset });
      return { forecasts: selected };
    }

    // Upstream drops a station that issued no forecast without reporting it, so
    // a route check asking for departure, destination, and alternate cannot see
    // which leg came back empty — or that anything is missing at all.
    const returned = [...new Set(forecasts.map((f) => f.station_id))];
    const missing = stationIds.filter((id) => !returned.includes(id));
    ctx.enrich({ requested: stationIds, returned, partial: missing.length > 0 });
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
    if (result.forecasts.length === 0)
      return [{ type: 'text', text: 'No forecast in this result.' }];
    const lines: string[] = [];
    for (const taf of result.forecasts) {
      lines.push(`## ${taf.station_id} — ${taf.name}`);
      lines.push(`**Issued:** ${taf.issued_at} | **Valid:** ${taf.valid_from} → ${taf.valid_to}`);
      lines.push(`**Amended:** ${taf.amended === null ? 'unknown' : taf.amended ? 'yes' : 'no'}`);
      if (taf.remarks !== null) lines.push(`**Remarks:** ${taf.remarks}`);
      lines.push('');

      for (const period of taf.forecast_periods) {
        const changeLabel = period.change_type ? `**${period.change_type}** ` : '';
        // A forecast probability of 0 is a value, not an absence — a truthiness
        // guard here would drop it.
        const probLabel = period.probability != null ? ` (${period.probability}%)` : '';
        lines.push(`### ${changeLabel}${period.from} → ${period.to}${probLabel}`);
        if (period.transition_end !== null)
          lines.push(`**Transition end:** ${period.transition_end}`);
        if (period.altimeter_hpa !== null) lines.push(`**Altimeter:** ${period.altimeter_hpa} hPa`);
        for (const temperature of period.temperature_forecasts) {
          lines.push(
            `**Temperature forecast:** ${temperature.kind} ${temperature.temperature_c} °C at ${temperature.valid_at}`,
          );
        }
        for (const layer of period.icing_turbulence) {
          lines.push(
            `**Icing or turbulence:** ${layer.kind} code ${layer.intensity_code}, minimum ${layer.min_altitude_ft === null ? 'unknown' : `${layer.min_altitude_ft} ft`}, maximum ${layer.max_altitude_ft === null ? 'unknown' : `${layer.max_altitude_ft} ft`}`,
          );
        }

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
        // An empty cloud array used to render "Clear". Most of them are an
        // explicit SKC or NSC forecast whose layer carries no height — 546 of
        // 723 across 3,349 live periods — and the rest are amendment groups
        // that never mentioned cloud, where "Clear" invented a forecast.
        lines.push(
          `**Clouds:** ${formatSkyLine(
            period.clouds.map((c) => `${c.cover} @ ${c.base_ft} ft${c.type ? ` (${c.type})` : ''}`),
            period.sky_condition,
            unamendedCloudReading(period.change_type),
          )}`,
        );
        // Usually the highest layer past the three-layer decode limit, and often
        // the only broken or overcast one, so dropping it silently cost the
        // period its ceiling. Upstream can attach it to the period after the one
        // whose text it came from, which the line says rather than guessing.
        if (period.not_decoded != null) {
          lines.push(
            `**Not decoded:** \`${period.not_decoded}\` (partial decode — AWC attached this text to the period without decoding it, and it can belong to the group before; the raw TAF below is the complete forecast)`,
          );
        }
        lines.push('');
      }

      lines.push(`**Raw TAF:** \`${taf.raw_taf}\``);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
