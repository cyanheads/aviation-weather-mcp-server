/**
 * @fileoverview Prompt for a structured preflight weather briefing.
 * Guides the LLM to call METAR, TAF, PIREPs, and advisories in sequence — chunked to
 * each tool's station limit, bounded to the planned cruise level and route corridor
 * where those were supplied — and to synthesize a weather-risk summary that names the
 * assessments it could not make.
 * @module mcp-server/prompts/definitions/aviation-preflight-brief
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

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

/** Degrees of margin added to each side of the route-waypoint envelope. */
const ROUTE_CORRIDOR_MARGIN_DEG = 1;

const ICAO = '[A-Z]{4}';
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

/** Collapses float representation artifacts at the resolution AWC publishes. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
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
    "Build a preflight weather briefing for a flight. Calls aviation_get_metar, aviation_get_taf, aviation_get_pireps, and aviation_get_advisories in sequence — chunked to each tool's station limit — and synthesizes a weather-risk summary with flight categories, active hazards, and the assessments that could not be made. Provide departure and destination ICAO IDs (e.g., KSEA, KJFK); alternates, planned departure time, cruise altitude, and route waypoints are optional and each narrows one step of the briefing.",
  args: z.object({
    departure_icao: z
      .string()
      .regex(/^[A-Z]{4}$/)
      .describe('Departure airport ICAO identifier, 4 uppercase letters (e.g., KSEA).'),
    destination_icao: z
      .string()
      .regex(/^[A-Z]{4}$/)
      .describe('Destination airport ICAO identifier, 4 uppercase letters (e.g., KJFK).'),
    alternates: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(ALTERNATES_PATTERN)
          .describe('Comma-separated 4-letter ICAO identifiers (e.g., "KBFI,KBOS").'),
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
        'Optional planned departure time as an ISO 8601 UTC timestamp (e.g., "2026-03-14T15:00Z"). Selects the TAF forecast period the briefing is read against. Omit it and the briefing still generates, stating that no forecast period could be tied to a flight window.',
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
        'Optional planned cruise altitude in feet MSL, digits only (e.g., "9500"; "35000" for FL350). Bounds the PIREP search to a ±3,000 ft band around it. Omit it and the briefing still generates, stating that no cruise-level hazard assessment could be made.',
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
        'Optional route waypoints as semicolon-separated "lat,lon" pairs in decimal degrees (e.g., "47.45,-122.31;40.64,-73.78"). Their bounding envelope, widened by 1°, becomes the advisories bbox. Coordinates only — no place names or identifiers, which nothing in this server geocodes. Omit it and the briefing still generates, stating that advisories could not be bounded to a route corridor.',
      ),
  }),
  generate: (args) => {
    const alternates = args.alternates
      ? args.alternates
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const allIcaos = [args.departure_icao, args.destination_icao, ...alternates];

    const cruiseAltitudeFt = args.cruise_altitude
      ? Number.parseInt(args.cruise_altitude, 10)
      : undefined;
    /**
     * The floor is clamped because a briefing instruction reading
     * `altitude_min_ft: -1500` is nonsense on its face; the ceiling needs no
     * clamp, since the input is bounded to six digits and PIREP altitudes are
     * MSL with no upper limit worth asserting here.
     */
    const cruiseBand =
      cruiseAltitudeFt === undefined
        ? undefined
        : {
            min: Math.max(0, cruiseAltitudeFt - CRUISE_BAND_HALF_WIDTH_FT),
            max: cruiseAltitudeFt + CRUISE_BAND_HALF_WIDTH_FT,
          };

    /**
     * The corridor box is the waypoint envelope plus a margin. Two waypoints on
     * nearly the same latitude — KSEA to KJFK is within half a degree — would
     * otherwise envelope to a sliver no advisory polygon intersects, so the
     * margin is what makes the box a corridor rather than a line. Clamping to
     * the valid coordinate range catches the margin overflowing near a pole or
     * the antimeridian; the waypoints themselves are already in range.
     */
    const waypoints = args.route_waypoints ? parseWaypoints(args.route_waypoints) : [];
    const routeBbox = waypoints.length
      ? {
          minLat: round6(
            Math.max(-90, Math.min(...waypoints.map(([lat]) => lat)) - ROUTE_CORRIDOR_MARGIN_DEG),
          ),
          minLon: round6(
            Math.max(
              -180,
              Math.min(...waypoints.map(([, lon]) => lon)) - ROUTE_CORRIDOR_MARGIN_DEG,
            ),
          ),
          maxLat: round6(
            Math.min(90, Math.max(...waypoints.map(([lat]) => lat)) + ROUTE_CORRIDOR_MARGIN_DEG),
          ),
          maxLon: round6(
            Math.min(180, Math.max(...waypoints.map(([, lon]) => lon)) + ROUTE_CORRIDOR_MARGIN_DEG),
          ),
        }
      : undefined;

    const tafTimingLine = args.departure_time
      ? `\`aviation_get_taf\` takes no time parameter — from the \`forecast_periods\` it returns, select the period whose \`from\`/\`to\` window covers the planned departure time ${args.departure_time}, and read the departure assessment from that period`
      : 'No departure time was supplied, so no forecast period can be tied to a flight window — cover the whole valid period and state that the departure-time assessment could not be made';

    const pirepAltitudeLine = cruiseBand
      ? `Pass \`altitude_min_ft: ${cruiseBand.min}\` and \`altitude_max_ft: ${cruiseBand.max}\` — the planned cruise altitude of ${cruiseAltitudeFt} ft MSL ±${CRUISE_BAND_HALF_WIDTH_FT} ft`
      : 'No cruise altitude was supplied, so the search cannot be bounded to a cruise level — report the altitudes as flown and state that the cruise-level hazard assessment could not be made';

    const advisoriesCall = routeBbox
      ? `Call \`aviation_get_advisories\` with \`bbox: { minLat: ${routeBbox.minLat}, minLon: ${routeBbox.minLon}, maxLat: ${routeBbox.maxLat}, maxLon: ${routeBbox.maxLon} }\` — the envelope of the supplied route waypoints widened by ${ROUTE_CORRIDOR_MARGIN_DEG}° on each side. Widen it further if the filed route leaves that box`
      : 'Call `aviation_get_advisories` unfiltered — no route waypoints were supplied, so advisories cannot be bounded to a route corridor; state that the corridor-scoped assessment could not be made';

    const gaps = [
      ...(args.departure_time
        ? []
        : ['No departure time supplied — the forecast could not be aligned to a flight window']),
      ...(cruiseBand
        ? []
        : ['No cruise altitude supplied — PIREPs could not be bounded to a cruise level']),
      ...(routeBbox
        ? []
        : ['No route waypoints supplied — advisories could not be bounded to a route corridor']),
      'Any station that returned no data, and anything the tools reported as partial, truncated, or limited',
    ]
      .map((gap) => `     - ${gap}`)
      .join('\n');

    const header = [
      `**Departure:** ${args.departure_icao}`,
      `**Destination:** ${args.destination_icao}`,
      ...(alternates.length ? [`**Alternates:** ${alternates.join(', ')}`] : []),
      ...(args.departure_time ? [`**Departure time:** ${args.departure_time}`] : []),
      ...(cruiseAltitudeFt === undefined
        ? []
        : [`**Cruise altitude:** ${cruiseAltitudeFt} ft MSL`]),
      ...(routeBbox
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

3. **PIREPs** — Call \`aviation_get_pireps\` centered on ${args.departure_icao} and ${args.destination_icao}
   - ${pirepAltitudeLine}
   - Report any significant turbulence (MOD or greater) or icing (LGT or greater)
   - Note altitude ranges where hazards were reported
   - Absence of PIREPs does not guarantee smooth conditions

4. **Advisories** — ${advisoriesCall}
   - List any active domestic SIGMETs (turbulence, icing, IFR, convective)
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
