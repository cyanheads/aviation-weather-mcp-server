/**
 * @fileoverview Tool to fetch current weather observations (METARs) for one or more airports.
 * @module mcp-server/tools/definitions/aviation-get-metar
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatDegrees } from '@/mcp-server/tools/format-degrees.js';
import { formatSkyLine } from '@/mcp-server/tools/format-sky-condition.js';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';
import { AWC_MAX_ROWS, isUpstreamCapped } from '@/services/aviation-weather/awc-limits.js';
import { isBboxOrdered } from '@/services/aviation-weather/bbox.js';
import type { NormalizedMetar } from '@/services/aviation-weather/types.js';

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
  .describe('Geographic bounding box for an area observation survey.');

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

/** The decoded form of a `VVhhh` or `VV///` group — the sky is obscured. */
const OBSCURATION_COVER = 'OVX';

/** Render a numeric observation, or an explicit unknown when upstream omitted it. */
function measurement(value: number | null, unit: string): string {
  return value != null ? `${value}${unit}` : 'unknown';
}

/** Prevailing visibility with its unit, or an explicit unreported state. */
function visibility(sm: string): string {
  return sm === 'unknown' ? 'not reported' : `${sm} sm`;
}

/**
 * Render the wind. A null direction carries two meanings, and the speed is what
 * separates them: beside a speed it is a `VRB` group, and with no speed the
 * observation carried no wind group at all — there is then no direction to call
 * variable and no speed to call calm. A calm `00000KT` is `0° at 0 kt`, never
 * the unreported state.
 */
function wind({ direction_deg, speed_kt, gust_kt }: NormalizedMetar['wind']): string {
  if (speed_kt == null) return 'not reported';
  const direction = direction_deg != null ? `${direction_deg}°` : 'variable';
  const gust = gust_kt != null ? ` gusting ${gust_kt} kt` : '';
  return `${direction} at ${speed_kt} kt${gust}`;
}

/**
 * Render the ceiling with its kind.
 *
 * A null height carries two meanings and they are not the same claim. Where no
 * broken, overcast, or obscuration layer was reported the reading is "none" —
 * never "clear", which would assert a sky state the observation does not
 * support, since few and scattered layers can sit above a station with no
 * ceiling. Where the station reported an obscuration but no vertical visibility
 * into it — a `VV///` group, which AWC publishes as `cover: OVX` with no layer
 * and no `vertVis` — the report *has* a ceiling under FAA AIM 7-1-29 and its
 * height is what is missing, so "none" states the opposite of the observation,
 * on records flagged IFR and LIFR where it costs most.
 *
 * `sky_condition` is the discriminator for the same reason it is on the cloud
 * line: it is populated only when the observation published no layer heights,
 * so an `OVX` value there beside a null height is exactly the undetermined
 * case, and the numeric `VVhhh` records keep publishing their height untouched. Reading the raw text
 * instead would misfire on a `VV` group inside a `TEMPO` clause — live `USTR …
 * NSC … TEMPO 0300 FG VV002` forecasts one and reports none.
 */
function ceiling(
  ft: number | null,
  type: 'measured' | 'indefinite' | null,
  skyCondition: string | null,
): string {
  if (ft == null) {
    return skyCondition === OBSCURATION_COVER
      ? 'not determinable — sky obscured, no vertical visibility reported'
      : 'none';
  }
  const kind =
    type === 'indefinite' ? 'indefinite — vertical visibility into an obscuration' : 'measured';
  return `${ft} ft (${kind})`;
}

/**
 * The latest observation per station, ordered by station ID ascending.
 *
 * A bbox draw carries every observation inside the `hours` window for every
 * station in the box — 52 rows across 9 stations in a live 1°×1° draw at
 * `hours=3` — and `/metar` defines no parameter that restricts it to the latest
 * reading, so the reduction happens here, after the row cap has been read off
 * the draw. `observed_at` is a fixed-width ISO 8601 UTC string, so comparing two
 * of them as strings compares the instants they name.
 *
 * Station IDs are compared code unit by code unit rather than by locale, so the
 * order cannot move with the runtime's collation and the same query with the
 * same limit returns the same stations.
 */
function latestPerStation(observations: NormalizedMetar[]): NormalizedMetar[] {
  const latest = new Map<string, NormalizedMetar>();
  for (const observation of observations) {
    const held = latest.get(observation.station_id);
    if (!held || observation.observed_at > held.observed_at) {
      latest.set(observation.station_id, observation);
    }
  }
  return [...latest.values()].sort((a, b) =>
    a.station_id < b.station_id ? -1 : a.station_id > b.station_id ? 1 : 0,
  );
}

/**
 * What a request-imposed `limit` withheld, stated so it cannot be read as the
 * upstream row cap. The two say opposite things about what was examined: a
 * capped draw is one AWC never served past, while a limited result counted every
 * station it is selecting from. The count is scoped to the draw it was taken
 * from — on a capped draw it describes that draw, not the box — and names the
 * flight-category filter where one chose the stations it counts.
 */
function limitNotice(shown: number, matched: number, capped: boolean, filtered: boolean): string {
  const noun = filtered ? 'station(s) matching flight_category' : null;
  const scope = capped
    ? `${matched} ${noun ?? 'station(s)'} inside the capped draw`
    : `${matched} ${noun ?? 'matching station(s)'}`;
  return `The request limited this result to the first ${shown} of ${scope}, ordered by station ID ascending. That is not the upstream cap — every station counted here was examined, and raising or dropping limit returns the ones it withheld.`;
}

/** The flight categories AWC computes. A station it could not rate reads `unknown`. */
const FLIGHT_CATEGORIES = ['VFR', 'MVFR', 'IFR', 'LIFR'] as const;

/**
 * What the flight-category filter did to the survey, stated as a stage with
 * its own before and after counts — decision 18's rule for a client-side
 * filter. A filter that emptied the result says so outright, since an empty
 * survey is otherwise indistinguishable from an empty box. The count of
 * stations AWC could not rate is named apart, because no filter can reach
 * them and a caller surveying for poor conditions should know they exist.
 */
function categoryNotice(
  categories: readonly string[],
  surveyed: NormalizedMetar[],
  matched: number,
  capped: boolean,
): string {
  const where = capped ? 'inside the capped draw' : 'surveyed in the box';
  const unrated = surveyed.filter(
    (s) => !(FLIGHT_CATEGORIES as readonly string[]).includes(s.flight_category),
  ).length;
  const unratedNote =
    unrated > 0
      ? ` ${unrated} of those reported no category AWC could determine (unknown), which no filter matches.`
      : '';
  if (matched === 0) {
    // With every category already named there is nothing left to widen to.
    const lever = categories.length < FLIGHT_CATEGORIES.length ? 'Widen or drop' : 'Drop';
    return `The flight_category filter (${categories.join(', ')}) emptied this result: none of the ${surveyed.length} station(s) ${where} reported ${categories.join(' or ')}.${unratedNote} ${lever} flight_category to see them.`;
  }
  return `The flight_category filter (${categories.join(', ')}) kept ${matched} of the ${surveyed.length} station(s) ${where}; the other ${surveyed.length - matched} did not match.${unratedNote}`;
}

/**
 * Stations past which a survey that set no `limit` is told the lever exists.
 * It is the largest multiple of 10 whose `structuredContent` fits the
 * framework's 24,000-byte overflow budget at the heaviest measured per-station
 * cost — see decision 36 in docs/design.md.
 */
const SIZE_NOTICE_THRESHOLD = 40;

/**
 * The size lever, for a survey that is large only because the call set no
 * `limit`. A limit here keeps an alphabetical slice rather than a region, so
 * the sentence says so and names the levers that do narrow by place or by
 * condition — the filter only where the caller has not already set it.
 */
function sizeNotice(shown: number, filtered: boolean): string {
  const conditionLever = filtered
    ? ''
    : ' To survey for particular conditions rather than every station, set flight_category.';
  return `This result returned ${shown} stations because no limit was set. Setting limit bounds the response without changing the area searched, but it keeps the first stations by station ID ascending — an alphabetical slice, not a region — so a smaller bbox is the lever for a smaller area.${conditionLever}`;
}

/** The schema ceiling of `hours`, past which raising it cannot draw more. */
const MAX_HOURS = 12;

/**
 * Recovery guidance for a draw that returned nothing, branched on the mode that
 * produced it. The contract entry states the mode-agnostic form, which is what a
 * client reading the catalog ahead of a call can act on; a caller who sent a box
 * named no identifier to verify, and one who named identifiers drew no area to
 * widen. `hours` is offered only below its schema maximum, where raising it can
 * still draw more.
 */
function noDataHint(mode: 'station_ids' | 'bbox', hours: number): string {
  if (mode === 'station_ids') {
    return 'Verify ICAO IDs with aviation_find_stations. Not all stations transmit METARs. Check that each station ID is a 4-character ICAO identifier (e.g., KSEA not SEA).';
  }
  const widen =
    hours < MAX_HOURS ? 'Widen the bounding box or raise hours' : 'Widen the bounding box';
  return `${widen}, then re-run. Confirm the box holds reporting stations with aviation_find_stations, whose data_types names the ones that transmit METARs.`;
}

export const aviationGetMetar = tool('aviation_get_metar', {
  title: 'Get METAR Weather Observations',
  description:
    'Get current weather observations (METARs) for named airports, or survey every reporting station inside a geographic area. Returns decoded fields — wind direction/speed/gusts, visibility, ceiling with its kind (measured, or indefinite for vertical visibility into an obscuration), present weather, temperature, dewpoint, altimeter, cloud layers — plus the computed flight category (VFR/MVFR/IFR/LIFR) and the raw METAR string. Requires either station_ids (1–10 ICAO IDs, e.g., KSEA, KJFK, K0S9) or bbox (area survey) — not both. station_ids returns every observation inside the hours window; bbox returns the latest observation per station in the box, with flight_category keeping only the stations in the categories named (e.g., IFR and LIFR) and limit bounding how many stations come back. Use aviation_find_stations to resolve or verify an ICAO ID, or to discover nearby stations.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    station_ids: z
      .array(
        z
          .string()
          .regex(/^[A-Z0-9]{4}$/)
          .describe('ICAO station ID: 4 uppercase letters or digits (e.g., KSEA, KJFK, K0S9).'),
      )
      .min(1)
      .max(10)
      .optional()
      .describe(
        'ICAO station IDs to query. 1–10 stations per call, and every observation inside the hours window is returned for each. Supplying it alongside bbox is rejected — use bbox to ask about an area rather than a named set.',
      ),
    bbox: BboxSchema.optional(),
    hours: z
      .number()
      .int()
      .min(1)
      .max(MAX_HOURS)
      .default(1)
      .describe(
        'Lookback window in hours (1–12), not a row limit. With station_ids every observation inside the window is returned, so a station reporting more often than hourly yields more than one row per hour: at the default of 1, half-hourly stations return two observations and SPECI-issuing stations can return more, so budget rows by the station reporting interval, never one per station. With bbox the result is reduced to the latest observation per station, but the window still shapes the draw the upstream row cap applies to — a wide window spends that cap on repeat readings from busy stations instead of on more stations, so lower it before narrowing the box.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(AWC_MAX_ROWS)
      .optional()
      .describe(
        `Maximum stations to return, applied after the draw is reduced to the latest observation per station, after any flight_category filter, and ordered by station ID ascending — so the same query with the same limit returns the same stations. It bounds the response without changing the area searched, which a smaller bbox would, and it keeps an alphabetical slice rather than a region or a condition. Distinct from the ${AWC_MAX_ROWS}-row upstream cap: a limited result examined every station it counted and withheld some, while a capped one never drew the rest. Belongs to the bbox mode; supplying it alongside station_ids is rejected, since that mode already names the set. Omit to return every station in the box. Optional.`,
      ),
    flight_category: z
      .array(z.enum(FLIGHT_CATEGORIES).describe('A flight category: VFR, MVFR, IFR, or LIFR.'))
      .min(1)
      .optional()
      .describe(
        'Return only the stations whose flight category is one of these (e.g., ["IFR", "LIFR"] to find where conditions are poor). Applied in the tool after the draw is reduced to the latest observation per station and before limit, so it changes which stations come back, not what AWC draws or the upstream row cap. A station AWC could not rate (flight_category "unknown") never matches. Belongs to the bbox mode; supplying it alongside station_ids is rejected, since each named station already reports its own category. Optional.',
      ),
  }),
  output: z.object({
    observations: z
      .array(
        z
          .object({
            station_id: z
              .string()
              .describe(
                'ICAO station identifier, 4 uppercase letters or digits (e.g., KSEA, K0S9).',
              ),
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
                  .describe(
                    'Wind direction in degrees true. Null when the observation reported a variable wind (VRB), and also when it carried no wind group at all — speed_kt is a number in the first case and null in the second.',
                  ),
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
              .describe(
                'Prevailing visibility in statute miles (e.g., "10+", "3", "1/2"), or the string "unknown" when the observation carried no visibility group. "unknown" is not a measurement and carries no unit.',
              ),
            ceiling_ft: z
              .number()
              .nullable()
              .describe(
                'Ceiling in feet AGL — the lowest broken, overcast, or obscuration layer. Per FAA AIM 7-1-29 the ceiling is the lowest broken or overcast layer, or the vertical visibility into an obscuration; few and scattered layers are never ceilings. Null in two cases that are not the same: the observation reported no such layer, or it reported an obscuration whose vertical visibility the station could not determine (a VV/// group), where the ceiling exists and only its height is missing. A sky_condition of OVX marks the second.',
              ),
            ceiling_type: z
              .enum(['measured', 'indefinite'])
              .nullable()
              .describe(
                'How the ceiling height was determined: "measured" for a broken or overcast layer base, "indefinite" for vertical visibility into an obscuration (an OVX layer). Null exactly when ceiling_ft is null.',
              ),
            clouds: z
              .array(CloudLayerSchema)
              .describe(
                'Cloud layers from lowest to highest, as AWC decoded them — at most four, so a fifth or higher reported layer is left out with no marker and raw_metar is the complete source. Empty whenever the observation published no layer heights, which covers a clear sky, an obscuration with no determinable height, and an observation that reported no sky condition at all; sky_condition distinguishes them. An empty array is not a clear sky on its own.',
              ),
            sky_condition: z
              .string()
              .nullable()
              .describe(
                'The sky condition the observation stated when it published no layer heights: CLR, SKC, or CAVOK for a clear or insignificant-cloud report, OVX for an obscuration whose layer carried no height (a VV/// group, and the opposite of clear). Null when clouds carries layers — those are the statement — and also when the observation carried no sky-condition group at all. An empty clouds array beside a null here is an unreported sky, never a clear one.',
              ),
            present_weather: z
              .object({
                raw: z
                  .string()
                  .describe(
                    'Weather groups exactly as encoded, space-delimited (e.g., "FG", "-SHRA", "VCTS -RA").',
                  ),
                decoded: z
                  .string()
                  .describe(
                    'Plain-English reading of each group, joined with "; " (e.g., "fog", "light rain showers; mist"). A group the decoder does not recognize is carried through as its own raw token rather than half-translated, so compare against raw when a reading still looks coded.',
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
        'Weather observations. With station_ids, one per station/time pair — multiple entries per station when the hours window holds more than one observation. With bbox, one per station: the latest observation inside that window.',
      ),
  }),
  errors: [
    {
      reason: 'no_stations_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No station returned METAR data — none of the requested IDs, or no station inside the bounding box.',
      // A station that transmits no METAR is an ordinary answer to the lookup,
      // not an incident — keep it out of the level upstream faults occupy.
      severity: 'notice',
      // The hint the throw site sends is branched on the mode — see
      // `noDataHint`. This entry states the mode-agnostic form, which is what a
      // client reading the catalog ahead of a call can act on.
      recovery:
        'Verify ICAO IDs with aviation_find_stations, or widen the bounding box and raise hours while it is below 12. Not all stations transmit METARs.',
    },
    {
      reason: 'missing_location',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither station_ids nor bbox was provided.',
      recovery:
        'Provide station_ids for named airports (1–10 ICAO IDs) or bbox for an area survey (minLat, minLon, maxLat, maxLon).',
    },
    {
      reason: 'conflicting_location',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both station_ids and bbox were provided.',
      recovery:
        'Provide station_ids OR bbox, not both. station_ids returns every observation for the IDs you name; bbox returns the latest observation per station in the box.',
    },
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The bounding box is inverted — minLat > maxLat or minLon > maxLon.',
      recovery:
        'Ensure minLat <= maxLat and minLon <= maxLon. Swap the inverted min/max coordinates and retry.',
    },
    {
      reason: 'conflicting_limit',
      code: JsonRpcErrorCode.ValidationError,
      when: 'limit was provided together with station_ids, where the caller has already named the set.',
      recovery:
        'Drop limit to return every observation for the identifiers you named, or replace station_ids with bbox to run an area survey the limit can bound.',
    },
    {
      reason: 'conflicting_flight_category',
      code: JsonRpcErrorCode.ValidationError,
      when: 'flight_category was provided together with station_ids, where the caller has already named the set.',
      recovery:
        "Drop flight_category and read each named station's flight_category field, or replace station_ids with bbox to run an area survey the filter can narrow.",
    },
  ],

  enrichment: {
    requested: z
      .array(z.string().describe('An ICAO station ID as requested.'))
      .optional()
      .describe(
        'Station IDs this call asked for, in the order given. Present only on a station_ids lookup — a bbox survey asks for an area, not a list.',
      ),
    returned: z
      .array(z.string().describe('An ICAO station ID present in the result.'))
      .optional()
      .describe(
        'Distinct station IDs that produced at least one observation. Counted per station, not per row — with hours > 1 a station reporting six times still appears once. Present only on a station_ids lookup.',
      ),
    partial: z
      .boolean()
      .optional()
      .describe(
        'True when a requested station produced no observation. False affirms the result covers every requested station, so full coverage is distinguishable from a short batch rather than being inferred from the count. Present only on a station_ids lookup.',
      ),
    missing: z
      .array(z.string().describe('A requested ICAO station ID that produced no observation.'))
      .optional()
      .describe('Requested station IDs absent from the result. Absent when none are missing.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the upstream draw hit the AWC row cap, so stations inside the box are missing from this result. False says the draw did not reach that cap, which a count alone cannot establish — the draw is reduced to one row per station, so the returned count sits far below the cap either way. It is not a completeness claim: AWC also thins a dense box by station priority, independently of the cap and with nothing in the response to mark it, so re-run over smaller quadrants and union the results when the box must be complete. Present only on a bbox survey.',
      ),
    shown: z
      .number()
      .optional()
      .describe(
        'Stations in this result, counted after the reduction to one observation per station, after any flight_category filter, and after any limit. Present only on a bbox survey.',
      ),
    surveyed: z
      .number()
      .optional()
      .describe(
        'Stations the survey reached — one per station, the latest observation of each — before the flight_category filter selected from them. Present only when a bbox survey supplied flight_category; the count after the filter is shown, or matched where a limit then withheld stations. Where the result is also truncated this counts the capped draw and not the box.',
      ),
    limited: z
      .boolean()
      .optional()
      .describe(
        'True when the requested limit withheld stations that matched — the caller asked to see fewer of them. False affirms the limit did not bite, so every station drawn is here. Present only when a bbox survey supplied a limit. It never states anything about the upstream cap: a limited result examined every station it counted, while a truncated one never drew the rest.',
      ),
    matched: z
      .number()
      .optional()
      .describe(
        'Stations the draw held before the limit selected from them — after the flight_category filter, where one was supplied. Present only on a limited result. Where the result is also truncated this counts the capped draw and not the box — the observations the cap dropped were never examined, so no count can include them.',
      ),
    cap: z
      .number()
      .optional()
      .describe(
        'The upstream row maximum that was applied to the draw. Present only on a truncated result.',
      ),
    upstreamRows: z
      .number()
      .optional()
      .describe(
        'Observations AWC returned before the reduction to one row per station. Present only on a truncated draw the reduction then narrowed, where the station count sits below the cap and so cannot reveal the truncation on its own.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for whichever disclosures fired, in this order: the levers that narrow a truncated draw; what the flight_category filter kept of the stations surveyed, or that it emptied the result; what a requested limit withheld; and — on a survey of more than 40 stations from a call that set no limit — that limit bounds the response but keeps an alphabetical slice, not a region. Or, on a station_ids lookup, the station IDs that returned nothing. The survey statements share one notice and the text keeps them apart; the reconciliation cannot join them, since only bbox reaches the row cap or takes a filter or a limit, and only station_ids reconciles a request.',
      ),
  },

  enrichmentTrailer: {
    requested: { render: (ids) => `**Requested:** ${ids?.join(', ')}` },
    returned: { render: (ids) => `**Returned:** ${ids?.join(', ')}` },
    missing: { render: (ids) => `**No data returned for:** ${ids?.join(', ')}` },
    partial: { label: 'Partial result' },
    truncated: { label: 'Truncated at the upstream row cap' },
    shown: { label: 'Stations returned' },
    surveyed: { label: 'Stations surveyed before the flight category filter' },
    cap: { label: 'Upstream row maximum' },
    upstreamRows: { label: 'Observations drawn before the reduction to one per station' },
    limited: { label: 'Limited by the request' },
    matched: { label: 'Stations matched before the limit' },
  },

  async handler(input, ctx) {
    const stationIds = input.station_ids;

    if (!stationIds && !input.bbox) {
      throw ctx.fail('missing_location', 'Either station_ids or bbox is required.', {
        ...ctx.recoveryFor('missing_location'),
      });
    }

    if (stationIds && input.bbox) {
      throw ctx.fail('conflicting_location', 'Provide either station_ids or bbox, not both.', {
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

    // A location-mode mistake is reported ahead of this, matching the order the
    // sibling tools use for a filter that belongs to only one mode.
    if (stationIds && input.limit != null) {
      throw ctx.fail(
        'conflicting_limit',
        'limit bounds an area survey and has no effect on a named list of identifiers.',
        { ...ctx.recoveryFor('conflicting_limit') },
      );
    }

    // Deduplicated once, so the notice names each category a single time.
    const categories = input.flight_category && [...new Set(input.flight_category)];
    if (stationIds && categories) {
      throw ctx.fail(
        'conflicting_flight_category',
        'flight_category narrows an area survey and has no effect on a named list of identifiers.',
        { ...ctx.recoveryFor('conflicting_flight_category') },
      );
    }

    ctx.log.info('Fetching METARs', {
      stationIds,
      hasBbox: !!input.bbox,
      hours: input.hours,
      ...(input.limit != null ? { limit: input.limit } : {}),
      ...(categories ? { flightCategory: categories } : {}),
    });
    const svc = getAviationWeatherService();
    const drawn = await svc.fetchMetar(
      {
        ...(stationIds ? { stationIds } : {}),
        ...(input.bbox ? { bbox: input.bbox } : {}),
        hours: input.hours,
      },
      ctx,
    );

    if (drawn.length === 0) {
      throw ctx.fail(
        'no_stations_found',
        stationIds
          ? `No METAR data found for: ${stationIds.join(', ')}`
          : `No station inside the bounding box reported a METAR in the past ${input.hours} hour(s).`,
        {
          ...(stationIds ? { stationIds } : { bbox: input.bbox }),
          recovery: { hint: noDataHint(stationIds ? 'station_ids' : 'bbox', input.hours) },
        },
      );
    }

    if (stationIds) {
      // Upstream drops a station that produced nothing without reporting it, so
      // a short batch is otherwise indistinguishable from a complete one.
      // Reconcile on distinct station IDs — hours > 1 returns a row per
      // observation.
      const returned = [...new Set(drawn.map((o) => o.station_id))];
      const missing = stationIds.filter((id) => !returned.includes(id));
      ctx.enrich({ requested: stationIds, returned, partial: missing.length > 0 });
      if (missing.length > 0) {
        ctx.enrich({ missing });
        ctx.enrich.notice(
          `No data returned for ${missing.join(', ')}. Three conditions produce this and the response cannot tell them apart: the ID may not be a known station, the station may transmit no METARs, or it may have reported nothing inside the ${input.hours}-hour lookback. ${input.hours < MAX_HOURS ? 'Widen hours, or verify' : 'Verify'} the IDs with aviation_find_stations.`,
        );
      }

      ctx.log.info('METARs retrieved', { count: drawn.length, missing: missing.length });
      return { observations: drawn };
    }

    // A bbox draw carries every observation each station made inside the window,
    // so it is reduced to the latest per station. The cap is read off the row
    // count AWC served, before that reduction — the station count it leaves sits
    // far below 400 on a draw that was cut.
    const stations = latestPerStation(drawn);
    // The filter reads the reduced survey, so a station is judged by its
    // latest observation, and runs before the limit, so a limit selects from
    // the stations that matched. AWC takes no category parameter — `/metar`
    // rejects an unrecognized key — so the draw and its cap are untouched.
    const selected = categories
      ? stations.filter((s) => (categories as readonly string[]).includes(s.flight_category))
      : stations;
    const matched = selected.length;
    const shownStations = input.limit != null ? selected.slice(0, input.limit) : selected;
    const shown = shownStations.length;
    const limited = input.limit != null && matched > input.limit;
    const capped = isUpstreamCapped(drawn.length);
    // `hours` cannot go below 1, so at 1 the quadrants are the only lever left.
    const capLevers =
      input.hours > 1
        ? 'A wide hours spends the cap on repeat readings from the stations it did reach, so lower hours first; then re-run over smaller bbox quadrants and union the results.'
        : 'Re-run over smaller bbox quadrants and union the results.';

    // The cap, the filter, the limit, and the size lever are separate
    // disclosures sharing one notice, and every notice writer is last-wins —
    // so each states its own case in pipeline order and the notice is written
    // once. It is safe to own it outright: station_ids rejects a filter and a
    // limit and cannot reach the cap, so the reconciliation above never runs
    // on the same call. A filter-emptied survey is still a result, not a
    // missing station — the box answered, and the filter is what emptied it.
    const notice = [
      capped
        ? `AWC served ${drawn.length} observations for this query, its per-request maximum, so stations inside the box are missing from this result — the draw reached only ${stations.length} of them. ${capLevers}`
        : null,
      categories && matched < stations.length
        ? categoryNotice(categories, stations, matched, capped)
        : null,
      limited ? limitNotice(shown, matched, capped, !!categories) : null,
      input.limit == null && shown > SIZE_NOTICE_THRESHOLD ? sizeNotice(shown, !!categories) : null,
    ]
      .filter(Boolean)
      .join(' ');

    if (capped) {
      ctx.enrich.truncated({ shown, cap: AWC_MAX_ROWS, guidance: notice });
      // Restating the drawn count is only informative where the reduction moved it.
      if (drawn.length > stations.length) ctx.enrich({ upstreamRows: drawn.length });
    } else {
      ctx.enrich({ truncated: false, shown });
      if (notice) ctx.enrich.notice(notice);
    }

    // Owed whenever the filter ran, including when it removed nothing: that
    // equality is what tells the caller the filter did not narrow.
    if (categories) ctx.enrich({ surveyed: stations.length });

    // A caller who set no limit already knows none applied, so the affirmative
    // `limited: false` is only owed to one who did — where it separates a limit
    // that bit from one that had nothing to withhold.
    if (input.limit != null) ctx.enrich({ limited });
    if (limited) ctx.enrich({ matched });

    ctx.log.info('METARs retrieved', {
      count: shown,
      matched,
      surveyed: stations.length,
      rawRows: drawn.length,
    });
    return { observations: shownStations };
  },

  format: (result) => {
    // Only a flight_category filter can empty a survey — an empty draw is
    // no_stations_found — and the notice says which stage did it.
    if (result.observations.length === 0) {
      return [{ type: 'text', text: 'No station in this result.' }];
    }
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

      lines.push(`**Wind:** ${wind(obs.wind)}`);
      lines.push(
        `**Visibility:** ${visibility(obs.visibility_sm)} | **Ceiling:** ${ceiling(obs.ceiling_ft, obs.ceiling_type, obs.sky_condition)}`,
      );
      if (obs.present_weather) {
        lines.push(
          `**Present weather:** ${obs.present_weather.raw} (${obs.present_weather.decoded})`,
        );
      }
      lines.push(
        `**Temperature:** ${measurement(obs.temp_c, '°C')} | **Dewpoint:** ${measurement(obs.dewpoint_c, '°C')} | **Altimeter:** ${measurement(obs.altimeter_inhg, ' inHg')}`,
      );

      // An empty cloud array used to render "Clear", which asserted a sky state
      // for the 97 of 1,849 live observations that reported none — and inverted
      // the `VV///` obscurations that land in the same empty array.
      lines.push(
        `**Clouds:** ${formatSkyLine(
          obs.clouds.map((c) => `${c.cover} @ ${c.base_ft} ft`),
          obs.sky_condition,
          'not reported — the observation carried no sky-condition group',
        )}`,
      );

      lines.push(`**Raw METAR:** \`${obs.raw_metar}\``);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
