/**
 * @fileoverview Prompt for a structured preflight weather briefing.
 * Guides the LLM to call METAR, TAF, PIREPs, and advisories in sequence — chunked to
 * each tool's station limit, bounded to the planned cruise level and route corridor
 * where those were supplied — and to synthesize a weather-risk summary that names the
 * assessments it could not make.
 * @module mcp-server/prompts/definitions/aviation-preflight-brief
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';
import { routeWeatherBoxes } from '@/mcp-server/prompts/route-weather-boxes.js';

/** Stations `aviation_get_metar` accepts per call — its own `station_ids` bound. */
const METAR_STATIONS_PER_CALL = 10;

/** Stations `aviation_get_taf` accepts per call — its own `station_ids` bound. */
const TAF_STATIONS_PER_CALL = 4;

/**
 * Half-width of the PIREP altitude band derived from a cruise altitude, in feet.
 *
 * 3,000 ft is not an arbitrary margin: it is half the fixed band AWC's `level`
 * parameter searches (design decision 19), so a band centred on the cruise
 * altitude is exactly one `aviation_get_pireps` can push upstream instead of
 * filtering a capped page client-side.
 */
const CRUISE_BAND_HALF_WIDTH_FT = 3000;

/**
 * The band `aviation_get_pireps` accepts, in feet MSL — its `altitude_min_ft`
 * and `altitude_max_ft` bounds, mirrored here as `METAR_STATIONS_PER_CALL` and
 * `TAF_STATIONS_PER_CALL` mirror those tools' own limits.
 *
 * A derived band outside it is a call that tool rejects at the schema, so the
 * briefing would instruct a step the model cannot complete. The prompt test
 * pins these to what the tool advertises, so moving one without the other
 * fails there rather than in a briefing.
 */
const CRUISE_BAND_FLOOR_FT = 0;
const CRUISE_BAND_CEILING_FT = 60000;

/** Confine a derived band bound to what `aviation_get_pireps` accepts. */
function clampToPirepBand(ft: number): number {
  return Math.min(CRUISE_BAND_CEILING_FT, Math.max(CRUISE_BAND_FLOOR_FT, ft));
}

/**
 * Feet per flight level — the resolution `/pirep`'s `level` centre is expressed
 * in, and the grid a band has to sit on to be pushed upstream at all.
 *
 * A band of the full ±3,000 ft width is contained by one centre only, its own
 * midpoint, and that centre is a whole flight level: a cruise altitude off this
 * grid therefore yields a band `pushablePirepLevel` declines to send, rather
 * than lose reports in the sliver rounding would leave undrawn (design decision
 * 19). 9,501 ft would otherwise instruct 6,501–12,501 ft, which the tool filters
 * client-side out of a page the 400-row cap may already have cut — the outcome
 * bounding the search to a cruise band exists to avoid.
 */
const FEET_PER_FLIGHT_LEVEL = 100;

/**
 * The PIREP altitude band for a planned cruise altitude: centred on the
 * flight-level grid AWC searches, then held inside the range
 * `aviation_get_pireps` accepts.
 *
 * Rounding precedes the clamp so the clamp keeps the last word at either end,
 * and neither step can reorder the bounds — both are derived from one centre
 * and passed through the same monotonic clamp, so `min <= max` holds for every
 * altitude the six-digit input admits.
 */
function cruiseAltitudeBand(suppliedFt: number): {
  centreFt: number;
  suppliedFt: number;
  min: number;
  max: number;
} {
  const centreFt = Math.round(suppliedFt / FEET_PER_FLIGHT_LEVEL) * FEET_PER_FLIGHT_LEVEL;
  return {
    centreFt,
    suppliedFt,
    min: clampToPirepBand(centreFt - CRUISE_BAND_HALF_WIDTH_FT),
    max: clampToPirepBand(centreFt + CRUISE_BAND_HALF_WIDTH_FT),
  };
}

/** How the band's centre is described, naming the rounding only where it moved. */
function centrePhrase({ centreFt, suppliedFt }: { centreFt: number; suppliedFt: number }): string {
  return centreFt === suppliedFt
    ? `the planned cruise altitude of ${suppliedFt} ft MSL`
    : `${centreFt} ft MSL, the planned cruise altitude of ${suppliedFt} ft rounded to the nearest ${FEET_PER_FLIGHT_LEVEL} ft`;
}

/**
 * How the band itself is described, so the sentence matches the bounds beside
 * it.
 *
 * A cruise altitude at or above `CRUISE_BAND_CEILING_FT + CRUISE_BAND_HALF_WIDTH_FT`
 * clamps both ends onto the ceiling, leaving a single altitude whose centre
 * sits outside it — the only case where naming the centre would describe
 * nothing. The floor cannot collapse a band the same way, since the top of a
 * band centred at or above 0 ft is always at least the half-width.
 */
function bandPhrase(band: { centreFt: number; suppliedFt: number; min: number; max: number }) {
  return band.min === band.max
    ? `the highest altitude \`aviation_get_pireps\` searches, since the planned cruise altitude of ${band.suppliedFt} ft MSL is above the ${CRUISE_BAND_FLOOR_FT}–${CRUISE_BAND_CEILING_FT} ft range it accepts`
    : `the ±${CRUISE_BAND_HALF_WIDTH_FT} ft band around ${centrePhrase(band)}, held inside the ${CRUISE_BAND_FLOOR_FT}–${CRUISE_BAND_CEILING_FT} ft range \`aviation_get_pireps\` accepts`;
}

/**
 * The shape `aviation_get_metar`, `aviation_get_taf`, and `aviation_get_pireps`
 * enforce on a station ID — letters or digits, since a US airport whose FAA
 * identifier carries a digit takes a K + FAA-ID form (K0S9, KS52).
 */
const ICAO = '[A-Za-z0-9]{4}';
const ICAO_PATTERN = new RegExp(`^${ICAO}$`);
const ICAO_GUIDANCE =
  'Use a 4-character ICAO ID containing ASCII letters or digits (e.g., KSEA, K0S9), in either case. For an IATA/FAA code, use aviation_find_stations with state or bbox to find the ICAO ID; do not infer a mapping.';
const DECIMAL_DEGREES = String.raw`-?\d{1,3}(?:\.\d+)?`;
const WAYPOINT = String.raw`\s*${DECIMAL_DEGREES}\s*,\s*${DECIMAL_DEGREES}\s*`;

/** Whitespace around each entry is tolerated; the shape of each entry is not. */
const ALTERNATES_PATTERN = new RegExp(String.raw`^\s*${ICAO}(?:\s*,\s*${ICAO})*\s*$`);

/**
 * ISO 8601 UTC, seconds and fractional seconds optional — the shape
 * `aviation_get_taf` publishes its `forecast_periods[].from`/`.to` in, so a
 * period boundary can be pasted back in verbatim. A UTC offset is rejected
 * rather than converted: aviation time is Zulu, and silently reinterpreting an
 * offset is how a briefing ends up aligned to the wrong forecast period.
 */
const DEPARTURE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

/** Feet MSL, digits only — no `FL350` shorthand, no thousands separators. */
const CRUISE_ALTITUDE_PATTERN = /^\d{1,6}$/;

const ROUTE_WAYPOINTS_PATTERN = new RegExp(`^${WAYPOINT}(?:;${WAYPOINT})*$`);

/**
 * Whether every entry is a real coordinate pair. The shape regex bounds each
 * number to three integer digits, which admits a latitude of 200 — clamping it
 * would silently answer a different question than the caller asked, so the
 * range is checked here and a bad pair fails validation instead.
 */
function hasInRangeWaypoints(value: string): boolean {
  return parseWaypoints(value).every(
    ([lat, lon]) => lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180,
  );
}

function parseWaypoints(value: string): [number, number][] {
  return value.split(';').map((pair) => {
    const [lat, lon] = pair.split(',');
    return [Number(lat), Number(lon)] as [number, number];
  });
}

function chunk(items: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * The call instruction for a station-batch tool, split across as many calls as
 * the tool's own `station_ids` bound requires.
 *
 * A route with three alternates is already five stations, which exceeds
 * `aviation_get_taf`'s limit of four — so an unchunked instruction walks the
 * model into a schema rejection partway through a brief.
 */
function stationCallBlock(toolName: string, stations: string[], perCall: number): string {
  if (stations.length <= perCall) return `Call \`${toolName}\` for: ${stations.join(', ')}`;

  const chunks = chunk(stations, perCall);
  const calls = chunks
    .map((stationIds) => `   - Call \`${toolName}\` for: ${stationIds.join(', ')}`)
    .join('\n');
  return `\`${toolName}\` accepts at most ${perCall} stations per call, so split the ${stations.length} airports across ${chunks.length} calls:\n${calls}`;
}

export const aviationPreflightBrief = prompt('aviation_preflight_brief', {
  description:
    "Build a preflight weather briefing for a flight. Calls aviation_get_metar, aviation_get_taf, aviation_get_pireps, and aviation_get_advisories in sequence — chunked to each tool's station limit — and synthesizes a weather-risk summary with flight categories, active hazards, and the assessments that could not be made. Provide departure and destination ICAO IDs (e.g., KSEA, KJFK); optional alternates, planned departure time, cruise altitude, and route waypoints scope the relevant briefing steps.",
  args: z.object({
    departure_icao: z
      .string()
      .regex(ICAO_PATTERN, ICAO_GUIDANCE)
      .describe(
        'Departure airport ICAO identifier, 4 ASCII letters or digits, case-insensitive and normalized to uppercase (e.g., KSEA, K0S9).',
      ),
    destination_icao: z
      .string()
      .regex(ICAO_PATTERN, ICAO_GUIDANCE)
      .describe(
        'Destination airport ICAO identifier, 4 ASCII letters or digits, case-insensitive and normalized to uppercase (e.g., KJFK, KS52).',
      ),
    alternates: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(ALTERNATES_PATTERN, `Separate alternate ICAO IDs with commas. ${ICAO_GUIDANCE}`)
          .describe(
            'Comma-separated 4-character ICAO identifiers, ASCII letters or digits, case-insensitive and normalized to uppercase (e.g., "KBFI,K0S9").',
          ),
      ])
      .optional()
      .describe('Optional comma-separated alternate airport ICAO IDs (e.g., "KBFI,KBOS").'),
    departure_time: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(DEPARTURE_TIME_PATTERN)
          .describe('ISO 8601 UTC timestamp ending in Z (e.g., "2026-03-14T15:00Z").'),
      ])
      .optional()
      .describe(
        'Optional planned departure time as an ISO 8601 UTC timestamp (e.g., "2026-03-14T15:00Z"). Selects prevailing conditions, transitions and overlapping conditional TAF periods within validity. Omit it and the briefing still generates, stating that no forecast period could be tied to a flight window.',
      ),
    cruise_altitude: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(CRUISE_ALTITUDE_PATTERN)
          .describe('Altitude in feet MSL, digits only (e.g., "9500", "35000" for FL350).'),
      ])
      .optional()
      .describe(
        'Optional planned cruise altitude in feet MSL, digits only (e.g., "9500"; "35000" for FL350). Bounds the PIREP search to a ±3,000 ft band and supplies advisory altitude_ft, including zero. Omit it and the briefing still generates, stating that no cruise-level hazard assessment could be made.',
      ),
    route_waypoints: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(ROUTE_WAYPOINTS_PATTERN)
          .refine(hasInRangeWaypoints)
          .describe(
            'Semicolon-separated "lat,lon" pairs in decimal degrees (e.g., "47.45,-122.31;40.64,-73.78").',
          ),
      ])
      .optional()
      .describe(
        'Optional ordered route waypoints as semicolon-separated "lat,lon" pairs in decimal degrees (e.g., "47.45,-122.31;40.64,-73.78"). Their coordinate envelope plus 1° bounds PIREPs and advisories, split at the date line. Coordinates only — no geocoding. Without waypoints, use available airport METAR coordinates for an explicitly approximate envelope; missing endpoint positions prevent that area assessment.',
      ),
  }),
  generate: (args) => {
    const departure = args.departure_icao.toUpperCase();
    const destination = args.destination_icao.toUpperCase();
    const alternates = args.alternates
      ? args.alternates
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      : [];
    const allIcaos = [departure, destination, ...alternates];

    const cruiseAltitudeFt = args.cruise_altitude
      ? Number.parseInt(args.cruise_altitude, 10)
      : undefined;
    /**
     * The centre is put on the flight-level grid and both ends are then clamped
     * into the band `aviation_get_pireps` accepts. The floor because
     * `altitude_min_ft: -1500` is nonsense on its face, and the ceiling because
     * `cruise_altitude` admits six digits while the tool stops at FL600 — so an
     * unclamped top instructs a call the schema rejects.
     *
     * Clamping both is what keeps the band ordered: clamping only the top would
     * leave the floor above it for a cruise altitude far enough up, and the
     * tool rejects an inverted band as readily as an out-of-range one. The same
     * clamp on both ends collapses that case to a degenerate band at the
     * ceiling instead.
     */
    const cruiseBand =
      cruiseAltitudeFt === undefined ? undefined : cruiseAltitudeBand(cruiseAltitudeFt);

    const waypoints = args.route_waypoints ? parseWaypoints(args.route_waypoints) : [];
    const [firstWaypoint, ...remainingWaypoints] = waypoints;
    const route = firstWaypoint ? routeWeatherBoxes(firstWaypoint, remainingWaypoints) : undefined;

    const tafTimingLine = args.departure_time
      ? `For the planned departure time ${args.departure_time}, first check each TAF using \`valid_from <= departure_time < valid_to\`. Before valid_from or at/after valid_to, report that no valid departure-time forecast is available. Build the prevailing timeline from the initial forecast, FM replacements at their from boundary, and completed BECMG changes in chronological order. A completed BECMG target remains prevailing until superseded, including when transition_end equals that row's to. For an ongoing BECMG, before transition_end report prior prevailing conditions plus the changing target as a transition; at transition_end the target becomes prevailing. Include every TEMPO and PROB overlay with from <= departure_time < to, including TEMPO with a non-null probability, and keep conditional scenarios separate. Carry forward elements a change leaves unchanged, never invent an unreported element or treat a sparse overlay as a complete forecast. An unknown transition end means transition timing is uncertain. Check raw_taf and not_decoded for incomplete decoding. Do not infer an arrival time from departure time. as_of selects an earlier issued bulletin for historical review, not a future departure-time forecast; do not pass a future departure time as as_of`
      : 'No departure time was supplied, so no forecast period can be tied to a flight window — cover the whole valid period and state that the departure-time assessment could not be made';

    const pirepAltitudeLine = cruiseBand
      ? `Pass \`altitude_min_ft: ${cruiseBand.min}\` and \`altitude_max_ft: ${cruiseBand.max}\` — ${bandPhrase(cruiseBand)}`
      : 'No cruise altitude was supplied, so the search cannot be bounded to a cruise level — report the altitudes as flown and state that the cruise-level hazard assessment could not be made';

    const advisoryAltitude =
      cruiseAltitudeFt === undefined
        ? ''
        : `; include \`altitude_ft: ${cruiseAltitudeFt}\` for the planned cruise altitude`;
    const endpointPireps = `Call \`aviation_get_pireps\` centered on ${departure} and ${destination} separately, using each endpoint's station_id`;
    let pirepsCall: string;
    let advisoriesCall: string;
    let routeGap: string | undefined;
    switch (route?.kind) {
      case 'bounded': {
        const boxes = route.boxes.map(
          ({ minLat, minLon, maxLat, maxLon }) =>
            `\`bbox: { minLat: ${minLat}, minLon: ${minLon}, maxLat: ${maxLat}, maxLon: ${maxLon} }\``,
        );
        const pirepAltitude = cruiseBand
          ? `; pass \`altitude_min_ft: ${cruiseBand.min}\` and \`altitude_max_ft: ${cruiseBand.max}\``
          : '';
        pirepsCall = boxes
          .map((box) => `Call \`aviation_get_pireps\` with ${box}${pirepAltitude}`)
          .join('\n   - ');
        advisoriesCall = boxes
          .map((box) => `Call \`aviation_get_advisories\` with ${box}${advisoryAltitude}`)
          .join('\n   - ');
        break;
      }
      case 'ambiguous':
        pirepsCall = `The supplied 180° leg has no unique shortest direction. Report that route-area weather cannot be bounded without intermediate waypoints. Do not make a worldwide advisory request. ${endpointPireps}`;
        advisoriesCall =
          'Do not request a route advisory draw until the route ambiguity is resolved; report the area-assessment gap';
        routeGap = 'Route direction is ambiguous — area hazards could not be assessed';
        break;
      default:
        pirepsCall = `No route waypoints supplied: derive an airport-based approximation from the METAR coordinates of departure, destination and located alternates. Report each missing alternate position. Both endpoints must have usable positions: if either endpoint is missing, report the area-assessment gap and retain only separate endpoint PIREP searches. Do not make a worldwide advisory request. For located airports, use the smallest circular longitude envelope covering their positions, add 1° on every side, round bounds outward to four decimal places and clamp latitude to [-90,90]. Split a wrapped envelope at ±180° into two ordinary ordered boxes. If the latitude envelope includes a pole, use all longitudes; if equally short longitude envelopes are ambiguous, report the gap rather than choosing one. Call \`aviation_get_pireps\` once per derived box only when both endpoints are located; otherwise ${endpointPireps}`;
        advisoriesCall = `Call \`aviation_get_advisories\` once per airport-based box from the PIREP step, only when both endpoints are located${advisoryAltitude}. Otherwise report the area-assessment gap`;
        routeGap =
          'No route waypoints supplied — airport-based approximation only, with every missing position disclosed';
        break;
    }

    const gaps = [
      ...(args.departure_time
        ? []
        : ['No departure time supplied — the forecast could not be aligned to a flight window']),
      ...(cruiseBand
        ? []
        : ['No cruise altitude supplied — PIREPs could not be bounded to a cruise level']),
      ...(routeGap ? [routeGap] : []),
      'Any station that returned no data, and anything the tools reported as partial, truncated, or limited',
    ]
      .map((gap) => `     - ${gap}`)
      .join('\n');

    const header = [
      `**Departure:** ${departure}`,
      `**Destination:** ${destination}`,
      ...(alternates.length ? [`**Alternates:** ${alternates.join(', ')}`] : []),
      ...(args.departure_time ? [`**Departure time:** ${args.departure_time}`] : []),
      ...(cruiseAltitudeFt === undefined
        ? []
        : [`**Cruise altitude:** ${cruiseAltitudeFt} ft MSL`]),
      ...(waypoints.length
        ? [`**Route waypoints:** ${waypoints.map(([lat, lon]) => `${lat},${lon}`).join('; ')}`]
        : []),
    ].join('\n');

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Please provide a preflight weather briefing for the following flight:

${header}

Follow this sequence:

1. **Current conditions (METARs)** — ${stationCallBlock('aviation_get_metar', allIcaos, METAR_STATIONS_PER_CALL)}
   - Report flight category (VFR/MVFR/IFR/LIFR) for each station
   - Note ceiling, visibility, wind, and altimeter

2. **Forecasts (TAFs)** — ${stationCallBlock('aviation_get_taf', allIcaos, TAF_STATIONS_PER_CALL)}
   - ${tafTimingLine}
   - Identify any forecast deterioration or improvement during the planned flight window
   - Flag TEMPO/BECMG/PROB groups that could affect operations

3. **PIREPs** — ${pirepsCall}
   - ${pirepAltitudeLine}
   - On every bbox call omit station_id and distance_nm. Apply the altitude band above to every call, including endpoint fallbacks
   - Supplied waypoint boxes follow shortest consecutive longitude arcs with a 1° margin; these and airport-derived boxes are coordinate-envelope approximations, not exact filed-track intersections. Widen coverage if the route leaves them
   - Deduplicate identical records across boxes; keep distinct reports even when their timestamps match. Do not add overlapping coverage counts. Preserve every draw's partial, truncated, limited and unknown coverage; follow nextOffset if present to continue over the available draw, which may have changed
   - Report any significant turbulence (MOD or greater) or icing (LGT or greater)
   - Note altitude ranges where hazards were reported
   - Absence of PIREPs does not guarantee smooth conditions

4. **Advisories** — ${advisoriesCall}
   - List active domestic SIGMETs, international SIGMETs (including oceanic products), and Center Weather Advisories; the default advisory_type "all" reads all three
   - Read coverage and partial before interpreting any empty result. Failed sources, unreadable rows and unlocated geometry are assessment gaps; bbox counts apply after cancellation removal and product/hazard/altitude selection. If limit withheld matches, omit or raise it before completing the assessment
   - Deduplicate identical advisories across boxes; a shared series ID alone does not make two advisories identical. Do not add overlapping coverage counts. Inspect altitude_selection and per-source altitude_unknown; retained unknown bounds do not prove an altitude match
   - Include valid times and affected altitudes
   - AIRMETs are not available from this server; do not request one. Say so plainly rather than implying the route was cleared of AIRMET-class hazards

5. **Weather-risk summary** — Synthesize the above into:
   - **Weather risk** across the route, stated as risk rather than as a Go/No-Go recommendation — this briefing carries no pilot, aircraft, or operational-minima context, and that decision needs all three
   - **Primary concerns** listed in order of severity
   - **Alternate considerations** if relevant
   - **Gaps and uncertainty** — state plainly what could not be assessed:
${gaps}
   - **Reminder:** This briefing is for informational purposes only. Flight in IMC or controlled airspace requires an official preflight briefing from an authorized source (e.g., 1800wxbrief.com).`,
        },
      },
    ];
  },
});
