/**
 * @fileoverview Tool to fetch recent Pilot Reports (PIREPs) near an airport or within a bounding box.
 * @module mcp-server/tools/definitions/aviation-get-pireps
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { formatDegrees } from '@/mcp-server/tools/format-degrees.js';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';
import {
  AWC_MAX_ROWS,
  isUpstreamCapped,
  PIREP_LEVEL_BAND_FT,
  pushablePirepLevel,
} from '@/services/aviation-weather/awc-limits.js';
import { isBboxOrdered } from '@/services/aviation-weather/bbox.js';
import type { NormalizedPirep } from '@/services/aviation-weather/types.js';

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
    cover: z
      .string()
      .describe(
        'Cloud cover code: FEW, SCT, BKN, OVC, SKC, or CLR. SKC and CLR state a clear sky and never carry a base or top. The field also carries the flight-condition markers VMC and IMC, which describe the flight environment rather than a cloud layer and arrive with no base or top.',
      ),
    base_ft: z
      .number()
      .nullable()
      .describe('Cloud base altitude in feet MSL, or null if the pilot reported no base.'),
    top_ft: z
      .number()
      .nullable()
      .describe('Cloud top altitude in feet MSL, or null if the pilot reported no top.'),
  })
  .describe('A cloud layer, whose base and top are each present only if reported.');

/** Radius applied to a station_id search when distance_nm is omitted. */
const DEFAULT_DISTANCE_NM = 100;

/** The schema floor of distance_nm — below it, the radius cannot narrow. */
const MIN_DISTANCE_NM = 10;

/** The schema ceilings of the two widening levers — past them, neither widens. */
const MAX_DISTANCE_NM = 500;
const MAX_HOURS = 12;

/**
 * The parameters that widen an empty PIREP search, naming only the ones this
 * call can still pull — the widening counterpart of `narrowingLevers`.
 * `distance_nm` belongs to the `station_id` search and is rejected beside a
 * `bbox`; a wider box belongs to the area search; and neither `distance_nm`
 * nor `hours` goes past its schema maximum. Null when nothing is left to widen.
 */
function wideningLevers(
  mode: 'station_id' | 'bbox',
  hours: number,
  radiusNm: number,
): string | null {
  const expandable = [
    mode === 'station_id' && radiusNm < MAX_DISTANCE_NM ? 'distance_nm' : null,
    hours < MAX_HOURS ? 'hours' : null,
  ].filter(Boolean);
  const expand =
    expandable.length > 0
      ? `expand the ${expandable.join(' or ')} ${expandable.length > 1 ? 'parameters' : 'parameter'}`
      : null;
  return [mode === 'bbox' ? 'widen the bbox' : null, expand].filter(Boolean).join(' or ') || null;
}

/**
 * AWC's rejection text for a `/pirep` center identifier it cannot resolve. The
 * endpoint answers `{"status":"error","error":"Invalid location specified"}`
 * under HTTP 400, which the service surfaces as the error message. It is the
 * only part of that rejection that names the center: the status and the code it
 * classifies to are shared with every other parameter the endpoint refuses.
 */
const AWC_UNRECOGNIZED_CENTER = 'Invalid location specified';

/**
 * Ceiling of the altitude band, in feet MSL — FL600, above the altitude any
 * pilot report carries.
 *
 * The bound is upstream-facing as much as domain-facing. `pushablePirepLevel`
 * centres the requested band, so an unbounded top derives a `level` centre of
 * the same magnitude: a band of 9,997,000–10,003,000 ft sends `level=100000`,
 * which AWC answers with HTTP 400 `Invalid value for level` — a rejection
 * naming a parameter the caller never set and cannot see.
 */
const PIREP_ALTITUDE_CEILING_FT = 60000;

/**
 * What a request-imposed `limit` withheld, stated so it cannot be read as the
 * upstream row cap. The two say opposite things about what was examined: a
 * capped page is one AWC never drew past, while a limited result counted every
 * report it is selecting from. `matched` is scoped to the page it was counted
 * from — on a capped page it describes that page, never the search area.
 *
 * The severity lever is offered only where the caller has not already pulled
 * it. `narrowingLevers` follows the same rule for the same reason: proposing a
 * parameter already in the query sends the caller in a circle, and on a capped
 * result the two halves of one notice would contradict each other — the cap
 * half correctly omitting `min_intensity` while the limit half re-proposed it.
 */
function limitNotice(
  shown: number,
  matched: number,
  capped: boolean,
  minIntensity: string | undefined,
): string {
  const scope = capped
    ? `${matched} report(s) that matched inside the capped page`
    : `${matched} matching report(s)`;
  const severityLever = minIntensity
    ? ''
    : ' A limit selects by recency alone, so set min_intensity to have AWC narrow to the severe reports before it applies.';
  return `The request limited this result to the ${shown} most recent of ${scope}. That is not the upstream cap — every report counted here was examined, and raising or dropping limit returns the ones it withheld.${severityLever}`;
}

/**
 * Reports past which a call that set no `limit` is told the lever exists. It is
 * the largest multiple of 10 whose `structuredContent` fits the framework's
 * 24,000-byte overflow budget at the heaviest measured per-report cost —
 * see decision 36 in docs/design.md.
 */
const SIZE_NOTICE_THRESHOLD = 50;

/**
 * The size lever, for a result that is large only because the call set no
 * `limit`. It states what the lever keeps, since a caller choosing between it
 * and a narrower search needs to know a limit selects by recency. The severity
 * lever is offered only where the caller has not already pulled it, for the
 * reason `limitNotice` gives.
 */
function sizeNotice(shown: number, minIntensity: string | undefined): string {
  const severityLever = minIntensity
    ? ''
    : ' Set min_intensity as well to have AWC narrow to the severe reports before a limit selects by recency.';
  return `This result returned ${shown} reports because no limit was set. Setting limit bounds the response without changing what is searched, keeping the most recent reports.${severityLever}`;
}

/**
 * The parameters that narrow a PIREP query before the upstream row cap applies,
 * naming only the ones this query can still pull. `min_intensity` and an
 * altitude band inside the upstream width are both sent to AWC, so once either
 * is in the query it has already done its narrowing, and offering it back sends
 * the caller in a circle. The same goes for a lever the call cannot use at all:
 * `distance_nm` belongs to the `station_id` search and is rejected beside a
 * `bbox`, a `bbox` belongs to the area search, `distance_nm` cannot go below
 * 10, and `hours` cannot go below 1.
 */
function narrowingLevers(
  mode: 'station_id' | 'bbox',
  hours: number,
  radiusNm: number,
  level: number | undefined,
  minIntensity: string | undefined,
): string {
  return [
    mode === 'bbox' ? 'a smaller bbox' : null,
    mode === 'station_id' && radiusNm > MIN_DISTANCE_NM ? 'a smaller distance_nm' : null,
    hours > 1 ? 'a shorter hours' : null,
    minIntensity ? null : 'min_intensity',
    level != null
      ? null
      : `an altitude band ${PIREP_LEVEL_BAND_FT.toLocaleString()} ft or narrower`,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Where this query's altitude bounds ran relative to the row cap. A band inside
 * the upstream width was sent as a `level` centre and narrowed the page the cap
 * applies to; anything else selected from the page the cap already returned.
 */
function altitudeLeverNote(level: number | undefined): string {
  return level != null
    ? `The altitude band was narrow enough to send to AWC as a search band centred on FL${level}, so it narrowed the page before the cap rather than selecting from it afterwards.`
    : `An altitude band ${PIREP_LEVEL_BAND_FT.toLocaleString()} ft or narrower is sent upstream and narrows the page the cap applies to; a wider band, or a single bound, selects from that page afterwards and cannot reach a report the cap dropped.`;
}

/**
 * Render a vertical extent where either bound may be unreported — shared by the
 * cloud, turbulence, and icing layers, which all carry the same pair. Each
 * available bound renders on its own, so a layer reporting only a base keeps
 * that base instead of losing it to a range that cannot be drawn. A layer with
 * neither bound renders nothing; that is the common case, and an empty range
 * would be a placeholder standing in for an altitude nobody reported.
 */
function altitudeExtent(base_ft: number | null, top_ft: number | null): string {
  if (base_ft != null && top_ft != null) {
    return `${base_ft.toLocaleString()}–${top_ft.toLocaleString()} ft`;
  }
  if (base_ft != null) return `${base_ft.toLocaleString()} ft base, top unknown`;
  if (top_ft != null) return `base unknown, ${top_ft.toLocaleString()} ft top`;
  return '';
}

export const aviationGetPireps = tool('aviation_get_pireps', {
  title: 'Get Pilot Reports (PIREPs)',
  description:
    'Get recent Pilot Reports (PIREPs) near an airport or within a bounding box. Returns decoded turbulence, icing, and cloud reports with altitude, aircraft type, intensity, outside air temperature, wind aloft, flight weather, and the raw PIREP string. Requires either station_id (ICAO center point for radial search, e.g., KSEA) or bbox (area search) — not both. distance_nm belongs to the station_id search only, and altitude_min_ft must not exceed altitude_max_ft. min_intensity restricts the result to reports carrying a turbulence or icing layer at that intensity or above. limit bounds how many reports come back without changing what is searched, keeping the most recent. Coverage is US-centric; PIREPs are sparse and absence of reports does not imply smooth conditions.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Z0-9]{4}$/)
      .optional()
      .describe(
        'ICAO station ID as center point for radial search — 4 uppercase letters or digits (e.g., KSEA, K0S9). Use with distance_nm.',
      ),
    bbox: BboxSchema.optional(),
    distance_nm: z
      .number()
      .int()
      .min(MIN_DISTANCE_NM)
      .max(MAX_DISTANCE_NM)
      .optional()
      .describe(
        'Search radius in nautical miles around station_id, defaulting to 100 when omitted. Belongs to the station_id search only — supplying it alongside bbox is rejected.',
      ),
    hours: z
      .number()
      .int()
      .min(1)
      .max(MAX_HOURS)
      .default(3)
      .describe('How many hours of history to return. Default 3.'),
    altitude_min_ft: z
      .number()
      .int()
      .min(0)
      .max(PIREP_ALTITUDE_CEILING_FT)
      .optional()
      .describe(
        'Filter by minimum altitude in feet MSL (e.g., 18000 for FL180), from 0 to 60000 ft — AWC searches no band below sea level, and none centred above FL600, which is already above the altitude any pilot report carries. Reports with an unknown altitude (altitude_ft null) cannot be shown to satisfy a bound and are dropped whenever either bound is set. Optional.',
      ),
    altitude_max_ft: z
      .number()
      .int()
      .min(0)
      .max(PIREP_ALTITUDE_CEILING_FT)
      .optional()
      .describe(
        'Filter by maximum altitude in feet MSL (e.g., 35000 for FL350), from 0 to 60000 ft — AWC searches no band below sea level, and none centred above FL600, which is already above the altitude any pilot report carries. Reports with an unknown altitude (altitude_ft null) cannot be shown to satisfy a bound and are dropped whenever either bound is set. Optional.',
      ),
    min_intensity: z
      .enum(['lgt', 'mod', 'sev'])
      .optional()
      .describe(
        'Return only reports carrying at least one turbulence or icing layer at this intensity or above. The filter selects reports, not layers — a matching report still carries its lighter layers, so a result may include NEG, TRC, or LGT entries alongside the layer that matched. Optional.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(AWC_MAX_ROWS)
      .optional()
      .describe(
        `Maximum reports to return, applied last — after every filter and after ordering by observation time descending, so a limited result is the most recent reports rather than an arbitrary slice. It bounds the response without changing what is searched, which every other parameter does. Distinct from the ${AWC_MAX_ROWS}-row upstream cap: a limited result examined every report it counted and withheld some, while a capped one never drew the rest. Selection is by recency alone, so pair it with min_intensity to bound a result by severity. Omit to return every match. Optional.`,
      ),
  }),
  output: z.object({
    pireps: z
      .array(
        z
          .object({
            observed_at: z.string().describe('Observation time in ISO 8601 format (UTC).'),
            lat: z.number().describe('Latitude of the PIREP location in decimal degrees.'),
            lon: z.number().describe('Longitude of the PIREP location in decimal degrees.'),
            altitude_ft: z
              .number()
              .nullable()
              .describe(
                'Reported altitude in feet MSL, or null when the raw flight-level group carries no usable altitude. That covers /FLUNKN/ and the during-climb and during-descent markers, and equally any other group AWC could not read — including one made only of digits, such as /FL2130/. A raw /FL000/ is a reported flight level of zero and returns 0.',
              ),
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
                'Turbulence layers reported. An explicit negative report is a layer with intensity NEG; an empty array means the PIREP carried no turbulence group, so the pilot said nothing either way.',
              ),
            icing: z
              .array(IcingLayerSchema)
              .describe(
                'Icing layers the raw report carried. An explicit negative report is a layer with intensity NEG; an empty array means the PIREP carried no icing group, so the pilot said nothing either way. Layers AWC synthesized for a report that never mentioned ice are omitted rather than published.',
              ),
            clouds: z
              .array(PirepCloudLayerSchema)
              .nullable()
              .describe('Cloud layers, or null if the PIREP carried no sky-condition group.'),
            visibility_sm: z
              .number()
              .nullable()
              .describe('In-flight visibility in statute miles, or null if not reported.'),
            temp_c: z
              .number()
              .nullable()
              .describe(
                'Outside air temperature in degrees Celsius at the report altitude, as AWC decoded it — the /TA group on a PIREP, the MS or PS temperature group on an AIREP. 0 is a real reading; null means the report carried none or gave it as unknown (/TA UNKN).',
              ),
            wind: z
              .object({
                direction_deg: z
                  .number()
                  .describe(
                    "Wind direction aloft in degrees, as reported and not converted. A PIREP /WV group is referenced to magnetic north (AIM TBL 7-1-18), unlike the true-north METAR and TAF winds, so apply the local magnetic variation before combining a PIREP's direction with a true track; an AIREP's reference is not stated here.",
                  ),
                speed_kt: z.number().describe('Wind speed aloft in knots. 0 is a reported calm.'),
              })
              .nullable()
              .describe(
                'Wind aloft at the report altitude, as AWC decoded it — the /WV group on a PIREP, the direction/speed group (e.g., 291/035KT) on an AIREP. Null unless AWC decoded both direction and speed. AWC leaves some forms undecoded — a gust suffix (/WV 03020G30), a single-digit AIREP speed (252/9 KT), a variation (/WV +/- 5KT) — and those return null here, with raw_pirep as the only source.',
              ),
            weather: z
              .object({
                raw: z
                  .string()
                  .describe(
                    'Weather groups exactly as encoded, space-delimited (e.g., "+RA", "FG -RA").',
                  ),
                decoded: z
                  .string()
                  .describe(
                    'Plain-English reading of each group, joined with "; " (e.g., "heavy rain", "fog; light rain"). A group the decoder does not recognize is carried through as its own raw token, so compare against raw when a reading still looks coded.',
                  ),
              })
              .nullable()
              .describe(
                'Flight weather AWC decoded from the /WX group, or null when it decoded no weather phenomena from it. A flight visibility AWC can read (FV07SM, 10SM) lands in visibility_sm instead. /WX text AWC cannot decode is dropped or trimmed — CEILING 017 returns null and RA FL300 AOB returns RA alone — so raw_pirep is the only source for it. This is not the /RM remarks text, which AWC does not decode either — raw_pirep carries it.',
              ),
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
      // PIREPs are sparse by nature, so an empty search is the common outcome
      // rather than an incident.
      severity: 'notice',
      recovery:
        'Widen the search — a larger distance_nm (up to 500) on a station_id search, a larger bbox on an area search, or a longer hours while it is below 12 — or try a different region. PIREPs are sparse; absence of reports does not mean smooth conditions.',
    },
    {
      reason: 'station_not_recognized',
      code: JsonRpcErrorCode.NotFound,
      when: 'AWC does not recognize station_id as a PIREP search center — a closed or retired airport, for example — and rejects the request.',
      // An identifier the upstream does not know is an ordinary answer to the
      // lookup, as a registry miss is on aviation_find_stations.
      severity: 'notice',
      recovery:
        'Confirm the identifier with aviation_find_stations, or search the same area with bbox, which needs no center station.',
    },
    {
      reason: 'missing_location',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither station_id nor bbox was provided.',
      recovery:
        'Provide station_id for a radial search (ICAO ID + distance_nm) or bbox for an area search (minLat, minLon, maxLat, maxLon).',
    },
    {
      reason: 'conflicting_location',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both station_id and bbox were provided.',
      recovery:
        'Provide station_id OR bbox, not both. station_id runs a radial search with distance_nm; bbox runs an area search.',
    },
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The bounding box is inverted — minLat > maxLat or minLon > maxLon.',
      recovery:
        'Ensure minLat <= maxLat and minLon <= maxLon. Swap the inverted min/max coordinates and retry.',
    },
    {
      reason: 'conflicting_distance',
      code: JsonRpcErrorCode.ValidationError,
      when: 'distance_nm was provided together with bbox, where a search radius has no meaning.',
      recovery:
        'Drop distance_nm to search the bbox as drawn, or replace bbox with station_id to run a radial search at that distance.',
    },
    {
      reason: 'invalid_altitude_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'altitude_min_ft is greater than altitude_max_ft, so no report can match both bounds.',
      recovery:
        'Ensure altitude_min_ft <= altitude_max_ft. Swap the two values, or drop one to filter on a single bound.',
    },
  ],

  enrichment: {
    truncated: z
      .boolean()
      .describe(
        'True when the upstream page hit the AWC row cap, so reports inside the search area and time window are missing from this result. False affirms the whole window was searched, which a count alone cannot establish.',
      ),
    shown: z
      .number()
      .describe('Reports in this result, counted after any altitude filter and after any limit.'),
    limited: z
      .boolean()
      .optional()
      .describe(
        'True when the requested limit withheld reports that matched — the caller asked to see fewer of them. False affirms the limit did not bite, so every matching report is here. Present only when the call supplied a limit. It never states anything about the upstream cap: a limited result examined every report it counted, while a truncated one never drew the rest.',
      ),
    matched: z
      .number()
      .optional()
      .describe(
        'Reports that matched this query before the limit selected from them. Present only on a limited result. Where the result is also truncated this counts the capped page and not the search area — the reports the cap dropped were never examined, so no count can include them.',
      ),
    cap: z
      .number()
      .optional()
      .describe(
        'The upstream row maximum that was applied to the page. Present only on a truncated result.',
      ),
    upstreamRows: z
      .number()
      .optional()
      .describe(
        'Reports AWC returned before the altitude filter ran. Present only on a truncated result the filter then narrowed, where the remaining count sits below the cap and so cannot reveal the truncation on its own.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for whichever disclosures fired: the levers that narrow the query before the cap applies, what a requested limit withheld, and — on a result of more than 50 reports from a call that set no limit — that limit bounds the response without changing what is searched, keeping the most recent. The cap and either limit statement can fire on one result, and the text keeps them apart.',
      ),
  },

  enrichmentTrailer: {
    truncated: { label: 'Truncated at the upstream row cap' },
    shown: { label: 'Reports returned' },
    cap: { label: 'Upstream row maximum' },
    upstreamRows: { label: 'Reports returned before the altitude filter' },
    limited: { label: 'Limited by the request' },
    matched: { label: 'Reports matched before the limit' },
  },

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

    if (input.station_id && input.bbox) {
      throw ctx.fail('conflicting_location', 'Provide either station_id or bbox, not both.', {
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

    if (input.bbox && input.distance_nm != null) {
      throw ctx.fail(
        'conflicting_distance',
        'distance_nm is a radius around station_id and has no effect on a bbox search.',
        { ...ctx.recoveryFor('conflicting_distance') },
      );
    }

    // Client-side altitude filter bounds (capture so TypeScript narrows in the
    // filter callbacks below). Equal bounds are a valid, if narrow, range.
    const altMin = input.altitude_min_ft;
    const altMax = input.altitude_max_ft;
    if (altMin != null && altMax != null && altMin > altMax) {
      throw ctx.fail(
        'invalid_altitude_range',
        `Altitude range is inverted: altitude_min_ft (${altMin.toLocaleString()}) must be <= altitude_max_ft (${altMax.toLocaleString()}).`,
        { ...ctx.recoveryFor('invalid_altitude_range') },
      );
    }

    const radiusNm = input.distance_nm ?? DEFAULT_DISTANCE_NM;
    const mode = input.station_id ? 'station_id' : 'bbox';

    // Push what upstream can express, so the row cap applies to a page already
    // narrowed. Computed after the inverted-range guard, so no centre is ever
    // derived from a range that cannot match.
    const level = pushablePirepLevel(altMin, altMax);
    // The narrowing levers this call can still pull, for the cap guidance.
    const levers = narrowingLevers(mode, input.hours, radiusNm, level, input.min_intensity);

    ctx.log.info('Fetching PIREPs', {
      stationId: input.station_id,
      hasBbox: !!input.bbox,
      ...(input.station_id ? { distanceNm: radiusNm } : {}),
      hours: input.hours,
      ...(level != null ? { level } : {}),
      ...(input.min_intensity ? { minIntensity: input.min_intensity } : {}),
    });

    const svc = getAviationWeatherService();
    let pireps: NormalizedPirep[];
    try {
      pireps = await svc.fetchPireps(
        {
          ...(input.station_id ? { stationId: input.station_id, distanceNm: radiusNm } : {}),
          ...(input.bbox ? { bbox: input.bbox } : {}),
          hours: input.hours,
          ...(level != null ? { level } : {}),
          ...(input.min_intensity ? { minIntensity: input.min_intensity } : {}),
        },
        ctx,
      );
    } catch (error) {
      // AWC resolves a station_id center itself and answers HTTP 400 `Invalid
      // location specified` for one it does not know (live KISN, closed 2019).
      // Its text is what identifies that rejection, so the text is what this
      // reads: the endpoint refuses other parameters under the same 400 and the
      // same classification — `Invalid value for level` for a band outside what
      // it searches — and reading one of those as an unknown center blames the
      // identifier for something the caller can fix elsewhere. The one shape
      // that names the center is re-raised as the declared reason, with the
      // upstream error kept as the cause. Every other rejection keeps AWC's own
      // text on a radial search exactly as it does on a bbox one, and every
      // other classification — a 5xx, a timeout, an abandoned request — bubbles
      // unchanged.
      if (
        input.station_id &&
        error instanceof McpError &&
        error.code === JsonRpcErrorCode.InvalidParams &&
        error.message.includes(AWC_UNRECOGNIZED_CENTER)
      ) {
        throw ctx.fail(
          'station_not_recognized',
          `AWC does not recognize ${input.station_id} as a PIREP search center.`,
          { ...ctx.recoveryFor('station_not_recognized') },
          { cause: error },
        );
      }
      throw error;
    }

    const rawCount = pireps.length;

    // A report whose altitude is unknown cannot be shown to satisfy a bound, so
    // either bound drops it. Both bounds behave the same way — the old zero
    // sentinel made altitude_min_ft discard these and altitude_max_ft keep them.
    if (altMin != null) {
      pireps = pireps.filter((p) => p.altitude_ft != null && p.altitude_ft >= altMin);
    }
    if (altMax != null) {
      pireps = pireps.filter((p) => p.altitude_ft != null && p.altitude_ft <= altMax);
    }

    // Sort by observation time descending
    pireps.sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime());

    // The cap applies to the page upstream served, before the altitude filter
    // selected from it — so it is `rawCount`, never the count left afterwards.
    const capped = isUpstreamCapped(rawCount);

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

      // What the upstream draw itself was narrowed by, and what the caller can
      // relax to widen it again.
      const drawScope =
        [
          level != null ? `an altitude band centred on FL${level}` : null,
          input.min_intensity
            ? `an intensity of ${input.min_intensity.toUpperCase()} or above`
            : null,
        ]
          .filter(Boolean)
          .join(' and ') || null;
      // Read only where drawScope is set, so the two lists are non-empty together.
      const relaxable = [
        input.min_intensity ? 'min_intensity' : null,
        level != null ? 'altitude_min_ft / altitude_max_ft' : null,
      ]
        .filter(Boolean)
        .join(' or ');

      // The draw is a slice of the search area whenever the cap cut it or an
      // upstream filter narrowed it, and a count taken from a slice cannot be
      // reported as the reports present in the area. The two causes compose —
      // an altitude band can be pushed upstream and still hit the cap — so they
      // are folded into one branch rather than treated as alternatives.
      const partialDraw = capped || drawScope != null;

      let message: string;
      let recovery: string;
      const sparse = 'PIREPs are sparse; absence of reports does not mean smooth conditions.';
      const widen = wideningLevers(mode, input.hours, radiusNm);

      if (altFiltered && partialDraw) {
        const why = [
          capped ? `AWC capped this query at ${AWC_MAX_ROWS} reports` : null,
          drawScope ? `the draw was narrowed upstream to ${drawScope}` : null,
        ]
          .filter(Boolean)
          .join(' and ');
        message = `No PIREPs matched the altitude filter (${altRange}) in the part of the search area this query drew: ${why}, so the area was searched only in part — the ${rawCount} report(s) drawn describe that slice, not the whole area.`;
        recovery = capped
          ? `Narrow the search until it falls under the ${AWC_MAX_ROWS}-report upstream cap — ${levers} — then reapply the altitude filter. ${altitudeLeverNote(level)}`
          : `Relax ${relaxable} to widen the draw${widen ? `, or ${widen}` : ''}. ${altitudeLeverNote(level)}`;
      } else if (altFiltered) {
        message = `No PIREPs in the search area matched the altitude filter (${altRange}). ${rawCount} report(s) were found at other or unreported altitudes.`;
        recovery = `Remove or adjust altitude_min_ft / altitude_max_ft. ${rawCount} PIREP(s) exist in the area at other or unreported altitudes.`;
      } else if (drawScope) {
        message = `No PIREPs matching ${drawScope} were found in the search area for the past ${input.hours} hour(s). That narrowing was applied upstream, so reports outside it were never drawn.`;
        recovery = `Relax ${relaxable}${widen ? `, or ${widen}` : ''}. ${sparse}`;
      } else {
        message = `No PIREPs found in the search area for the past ${input.hours} hour(s).`;
        recovery = widen
          ? `${widen.charAt(0).toUpperCase()}${widen.slice(1)}, or try a different region. ${sparse}`
          : `Try a different region. ${sparse}`;
      }

      throw ctx.fail('no_pireps_found', message, { recovery: { hint: recovery } });
    }

    // Reports that matched the query — everything the limit selects from, and
    // the count the cap disclosure describes the altitude filter as leaving.
    // The limit runs last, after the sort, so a bounded result is the most
    // recent matches rather than an arbitrary slice.
    const matched = pireps.length;
    const shownReports = input.limit != null ? pireps.slice(0, input.limit) : pireps;
    const shown = shownReports.length;
    const limited = input.limit != null && matched > input.limit;

    // The cap, the limit, and the size lever are separate disclosures sharing
    // one notice, and every notice writer is last-wins — so each states its own
    // case in turn and the notice is written once. The size sentence never
    // meets the limit one: it is owed only to a call that set no limit.
    const narrowed =
      matched < rawCount
        ? ` — the altitude filter then narrowed that capped page to ${matched} report(s)`
        : '';
    const notice = [
      capped
        ? `AWC served ${rawCount} reports for this query, its per-request maximum, so reports inside the search area and the ${input.hours}-hour window are missing from this result${narrowed}. Narrow the search — ${levers} — and re-run. ${altitudeLeverNote(level)}`
        : null,
      limited ? limitNotice(shown, matched, capped, input.min_intensity) : null,
      input.limit == null && shown > SIZE_NOTICE_THRESHOLD
        ? sizeNotice(shown, input.min_intensity)
        : null,
    ]
      .filter(Boolean)
      .join(' ');

    if (capped) {
      ctx.enrich.truncated({ shown, cap: AWC_MAX_ROWS, guidance: notice });
      // Restating the served count is only informative where the filter moved it.
      if (matched < rawCount) ctx.enrich({ upstreamRows: rawCount });
    } else {
      ctx.enrich({ truncated: false, shown });
      if (notice) ctx.enrich.notice(notice);
    }

    // A caller who set no limit already knows none applied, so the affirmative
    // `limited: false` is only owed to one who did — where it separates a limit
    // that bit from one that had nothing to withhold.
    if (input.limit != null) ctx.enrich({ limited });
    if (limited) ctx.enrich({ matched });

    ctx.log.info('PIREPs retrieved', { count: shown, matched, rawCount });
    return { pireps: shownReports };
  },

  format: (result) => {
    const lines: string[] = [`**${result.pireps.length} PIREP(s) found**\n`];
    for (const p of result.pireps) {
      lines.push(`## ${p.pirep_type} — ${p.observed_at}`);
      lines.push(
        `**Location:** ${formatDegrees(p.lat)}, ${formatDegrees(p.lon)} | **Altitude:** ${p.altitude_ft != null ? `${p.altitude_ft.toLocaleString()} ft` : 'unknown'}`,
      );
      if (p.aircraft_type) lines.push(`**Aircraft:** ${p.aircraft_type}`);

      if (p.turbulence.length > 0) {
        lines.push('**Turbulence:**');
        for (const t of p.turbulence) {
          const extent = altitudeExtent(t.base_ft, t.top_ft);
          const details = [t.intensity, t.type, t.frequency].filter(Boolean).join(', ');
          lines.push(`  - ${details}${extent ? ` (${extent})` : ''}`);
        }
      }

      if (p.icing.length > 0) {
        lines.push('**Icing:**');
        for (const i of p.icing) {
          const extent = altitudeExtent(i.base_ft, i.top_ft);
          const details = [i.intensity, i.type].filter(Boolean).join(', ');
          lines.push(`  - ${details}${extent ? ` (${extent})` : ''}`);
        }
      }

      if (p.clouds && p.clouds.length > 0) {
        const cloudStr = p.clouds
          .map((c) => {
            const extent = altitudeExtent(c.base_ft, c.top_ft);
            return extent ? `${c.cover} ${extent}` : c.cover;
          })
          .join(', ');
        lines.push(`**Clouds:** ${cloudStr}`);
      }

      if (p.visibility_sm != null) lines.push(`**Visibility:** ${p.visibility_sm} sm`);
      const aloft = [
        p.temp_c != null ? `**Temperature:** ${p.temp_c}°C` : null,
        // A PIREP /WV direction is magnetic (AIM TBL 7-1-18) and sits beside
        // METAR's true-north winds, so the line says so; an AIREP's reference
        // is not stated, so its line asserts none.
        p.wind
          ? `**Wind:** ${p.wind.direction_deg}°${p.pirep_type === 'PIREP' ? ' magnetic' : ''} at ${p.wind.speed_kt} kt`
          : null,
      ].filter(Boolean);
      if (aloft.length > 0) lines.push(aloft.join(' | '));
      if (p.weather) lines.push(`**Weather:** ${p.weather.raw} (${p.weather.decoded})`);
      lines.push(`**Raw:** \`${p.raw_pirep}\``);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
