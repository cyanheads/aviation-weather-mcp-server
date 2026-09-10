/**
 * @fileoverview Tests for the aviation_preflight_brief prompt.
 * @module tests/prompts/aviation-preflight-brief.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { aviationPreflightBrief } from '@/mcp-server/prompts/definitions/aviation-preflight-brief.prompt.js';

type Args = Record<string, string>;

/** Parses args and renders the single user message, the way a client's `prompts/get` does. */
async function render(args: Args): Promise<string> {
  const parsed = aviationPreflightBrief.args!.parse(args);
  const messages = await aviationPreflightBrief.generate(parsed);
  return (messages[0]!.content as { type: string; text: string }).text;
}

/** Every line carrying a call to the named tool. */
function callLines(text: string, toolName: string): string[] {
  return text.split('\n').filter((line) => line.includes(`Call \`${toolName}\``));
}

/** The ICAO identifiers listed on one call line. */
function stationsOn(line: string): string[] {
  return line.split(' for: ')[1]?.split(', ') ?? [];
}

/** N distinct valid ICAO identifiers — KAAA, KAAB, KAAC, … */
function icaos(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) =>
      `KA${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
  );
}

describe('aviationPreflightBrief', () => {
  it('generates a single user message for a simple departure/destination pair', async () => {
    const parsed = aviationPreflightBrief.args!.parse({
      departure_icao: 'KSEA',
      destination_icao: 'KJFK',
    });
    const messages = await aviationPreflightBrief.generate(parsed);

    expect(messages).toBeInstanceOf(Array);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content.type).toBe('text');
  });

  it('includes departure and destination ICAOs in the generated text', async () => {
    const text = await render({ departure_icao: 'KSEA', destination_icao: 'KJFK' });

    expect(text).toContain('KSEA');
    expect(text).toContain('KJFK');
  });

  it('includes all alternates in the generated tool call list', async () => {
    const text = await render({
      departure_icao: 'KBOS',
      destination_icao: 'KLGA',
      alternates: 'KEWR,KPHL',
    });

    expect(text).toContain('KBOS');
    expect(text).toContain('KLGA');
    expect(text).toContain('KEWR');
    expect(text).toContain('KPHL');
  });

  it('includes alternates in the TAF instruction line, not just the METAR call', async () => {
    const text = await render({
      departure_icao: 'KSEA',
      destination_icao: 'KSFO',
      alternates: 'KBFI,KRNT',
    });

    // Isolate the TAF step — alternates must be listed here, not only in the METAR list above
    const tafLine = callLines(text, 'aviation_get_taf')[0];
    expect(tafLine).toBeDefined();
    expect(tafLine).toContain('KSEA');
    expect(tafLine).toContain('KSFO');
    expect(tafLine).toContain('KBFI');
    expect(tafLine).toContain('KRNT');
  });

  it('lists the same station set in the METAR step as in the TAF step', async () => {
    const text = await render({
      departure_icao: 'KSEA',
      destination_icao: 'KSFO',
      alternates: 'KBFI,KRNT',
    });
    const metarStations = callLines(text, 'aviation_get_metar').flatMap(stationsOn);
    const tafStations = callLines(text, 'aviation_get_taf').flatMap(stationsOn);

    expect(metarStations).toEqual(['KSEA', 'KSFO', 'KBFI', 'KRNT']);
    expect(tafStations).toEqual(metarStations);
  });

  it('references all four aviation tools in the instructions', async () => {
    const text = await render({ departure_icao: 'KSFO', destination_icao: 'KLAX' });

    expect(text).toContain('aviation_get_metar');
    expect(text).toContain('aviation_get_taf');
    expect(text).toContain('aviation_get_pireps');
    expect(text).toContain('aviation_get_advisories');
  });

  it('orders the briefing steps METAR, TAF, PIREPs, advisories, then summary', async () => {
    const text = await render({ departure_icao: 'KSEA', destination_icao: 'KJFK' });

    const positions = [
      text.indexOf('aviation_get_metar'),
      text.indexOf('aviation_get_taf'),
      text.indexOf('aviation_get_pireps'),
      text.indexOf('aviation_get_advisories'),
      text.indexOf('5. **'),
    ];
    expect(positions.every((i) => i > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('does not send the briefing after AIRMETs the advisories tool rejects', async () => {
    const text = await render({ departure_icao: 'KSFO', destination_icao: 'KLAX' });

    /**
     * `aviation_get_advisories` throws `airmet_not_served`, so an advisories
     * step that asks for AIRMETs walks the model into a hard failure partway
     * through a brief. Naming the gap is the point — silently listing only
     * SIGMETs would read as a route cleared of AIRMET-class hazards.
     */
    expect(text).toMatch(/domestic SIGMETs/);
    expect(text).toMatch(/AIRMETs are not available/);
    expect(text).toMatch(/do not request one/);
  });

  it('omits alternates section when alternates is not provided', async () => {
    const text = await render({ departure_icao: 'KSEA', destination_icao: 'KORD' });

    expect(text).not.toContain('**Alternates:**');
  });

  it('includes disclaimer about official briefing sources', async () => {
    const text = await render({ departure_icao: 'KMIA', destination_icao: 'KATL' });

    expect(text).toContain('informational purposes only');
    expect(text).toContain('1800wxbrief.com');
  });

  it('trims whitespace from alternate IDs', async () => {
    const text = await render({
      departure_icao: 'KSEA',
      destination_icao: 'KSFO',
      alternates: ' KBFI , KRNT ',
    });

    expect(callLines(text, 'aviation_get_metar').flatMap(stationsOn)).toEqual([
      'KSEA',
      'KSFO',
      'KBFI',
      'KRNT',
    ]);
  });

  describe('identifier validation', () => {
    it('rejects a departure identifier that is not four uppercase letters', () => {
      expect(() =>
        aviationPreflightBrief.args!.parse({
          departure_icao: 'ksea',
          destination_icao: 'KJFK',
        }),
      ).toThrow();
    });

    it('rejects a three-letter IATA destination identifier', () => {
      expect(() =>
        aviationPreflightBrief.args!.parse({
          departure_icao: 'KSEA',
          destination_icao: 'JFK',
        }),
      ).toThrow();
    });

    it('rejects an alternates list carrying a malformed entry', () => {
      expect(() =>
        aviationPreflightBrief.args!.parse({
          departure_icao: 'KSEA',
          destination_icao: 'KJFK',
          alternates: 'KBFI,SEA',
        }),
      ).toThrow();
    });

    it('accepts an empty alternates string from a form-based client', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        alternates: '',
      });

      expect(text).not.toContain('**Alternates:**');
    });
  });

  describe('departure_time', () => {
    it('points the agent at the forecast period covering the supplied time', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        departure_time: '2026-03-14T15:00Z',
      });

      expect(text).toContain('**Departure time:** 2026-03-14T15:00Z');
      expect(text).toContain('takes no time parameter');
      expect(text).toContain(
        '`from`/`to` window covers the planned departure time 2026-03-14T15:00Z',
      );
    });

    it('accepts a full ISO timestamp with seconds and milliseconds', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        departure_time: '2026-03-14T15:00:00.000Z',
      });

      expect(text).toContain('2026-03-14T15:00:00.000Z');
    });

    it('still generates a brief and names the gap when omitted', async () => {
      const text = await render({ departure_icao: 'KSEA', destination_icao: 'KJFK' });

      expect(text).toContain('aviation_get_taf');
      expect(text).toContain('No departure time was supplied');
      expect(text).toContain(
        'No departure time supplied — the forecast could not be aligned to a flight window',
      );
      expect(text).not.toContain('**Departure time:**');
    });

    it.each([
      ['a space-separated timestamp', '2026-03-14 15:00'],
      ['prose', 'tomorrow at 3pm'],
      ['a UTC offset instead of Z', '2026-03-14T15:00-07:00'],
      ['a bare time', '15:00Z'],
    ])('rejects %s', (_label, departure_time) => {
      expect(() =>
        aviationPreflightBrief.args!.parse({
          departure_icao: 'KSEA',
          destination_icao: 'KJFK',
          departure_time,
        }),
      ).toThrow();
    });

    it('treats an empty string from a form-based client as omitted', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        departure_time: '',
      });

      expect(text).toContain('No departure time was supplied');
    });
  });

  describe('cruise_altitude', () => {
    it('derives a ±3,000 ft PIREP band from the supplied altitude', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        cruise_altitude: '9500',
      });

      expect(text).toContain('**Cruise altitude:** 9500 ft MSL');
      expect(text).toContain('`altitude_min_ft: 6500`');
      expect(text).toContain('`altitude_max_ft: 12500`');
    });

    it('clamps the band floor at the surface for a low cruise altitude', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        cruise_altitude: '2000',
      });

      expect(text).toContain('`altitude_min_ft: 0`');
      expect(text).toContain('`altitude_max_ft: 5000`');
      expect(text).not.toContain('altitude_min_ft: -');
    });

    it('still generates a brief and names the gap when omitted', async () => {
      const text = await render({ departure_icao: 'KSEA', destination_icao: 'KJFK' });

      expect(text).toContain('aviation_get_pireps');
      expect(text).toContain('No cruise altitude was supplied');
      expect(text).toContain(
        'No cruise altitude supplied — PIREPs could not be bounded to a cruise level',
      );
      expect(text).not.toContain('altitude_min_ft');
    });

    it.each([
      ['flight-level shorthand', 'FL350'],
      ['a thousands separator', '9,500'],
      ['a negative altitude', '-2000'],
      ['a decimal altitude', '9500.5'],
    ])('rejects %s', (_label, cruise_altitude) => {
      expect(() =>
        aviationPreflightBrief.args!.parse({
          departure_icao: 'KSEA',
          destination_icao: 'KJFK',
          cruise_altitude,
        }),
      ).toThrow();
    });

    it('treats an empty string from a form-based client as omitted', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        cruise_altitude: '',
      });

      expect(text).toContain('No cruise altitude was supplied');
    });
  });

  describe('route_waypoints', () => {
    it('threads the padded waypoint envelope into the advisories bbox', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        route_waypoints: '47.45,-122.31;40.64,-73.78',
      });

      expect(text).toContain(
        '`bbox: { minLat: 39.64, minLon: -123.31, maxLat: 48.45, maxLon: -72.78 }`',
      );
    });

    it('envelopes every waypoint, not just the first pair', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        route_waypoints: '47.45,-122.31;44.88,-93.22;40.64,-73.78',
      });

      // The Minneapolis leg sits inside the endpoints' latitude span but must
      // still be read: an envelope taken from the first pair alone would be
      // indistinguishable here, so the third waypoint is pushed north of both.
      const wider = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        route_waypoints: '47.45,-122.31;51.10,-93.22;40.64,-73.78',
      });

      expect(text).toContain('maxLat: 48.45');
      expect(wider).toContain('maxLat: 52.1');
    });

    it('clamps a margin that would overflow the valid coordinate range', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        route_waypoints: '89.5,179.4;88.0,178.0',
      });

      expect(text).toContain('maxLat: 90');
      expect(text).toContain('maxLon: 180');
    });

    it('still generates a brief and names the gap when omitted', async () => {
      const text = await render({ departure_icao: 'KSEA', destination_icao: 'KJFK' });

      expect(text).toContain('Call `aviation_get_advisories` unfiltered');
      expect(text).toContain('no route waypoints were supplied');
      expect(text).toContain(
        'No route waypoints supplied — advisories could not be bounded to a route corridor',
      );
      expect(text).not.toContain('bbox:');
    });

    it.each([
      ['space-separated coordinates', '47.45 -122.31'],
      ['ICAO identifiers', 'KSEA;KJFK'],
      ['a place name', 'Seattle'],
      ['an out-of-range latitude', '200.0,-122.31;40.64,-73.78'],
      ['an out-of-range longitude', '47.45,-999.9;40.64,-73.78'],
      ['a half pair', '47.45,-122.31;40.64'],
    ])('rejects %s', (_label, route_waypoints) => {
      expect(() =>
        aviationPreflightBrief.args!.parse({
          departure_icao: 'KSEA',
          destination_icao: 'KJFK',
          route_waypoints,
        }),
      ).toThrow();
    });

    it('treats an empty string from a form-based client as omitted', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        route_waypoints: '',
      });

      expect(text).toContain('no route waypoints were supplied');
    });

    it('never instructs aviation_find_stations to resolve raw coordinates', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        route_waypoints: '47.45,-122.31;40.64,-73.78',
      });

      // Nothing in this server geocodes (design decision 3), and
      // `aviation_find_stations` takes station_ids, bbox, or state only — a
      // waypoint reaches the briefing as a bbox or not at all.
      expect(text).not.toContain('aviation_find_stations');
    });
  });

  describe('station-list chunking', () => {
    it('keeps a single TAF call at the 4-station limit', async () => {
      const [departure, destination, ...alternates] = icaos(4);
      const text = await render({
        departure_icao: departure!,
        destination_icao: destination!,
        alternates: alternates.join(','),
      });
      const lines = callLines(text, 'aviation_get_taf');

      expect(lines).toHaveLength(1);
      expect(stationsOn(lines[0]!)).toEqual(icaos(4));
    });

    it('splits the TAF call one station over the 4-station limit', async () => {
      const [departure, destination, ...alternates] = icaos(5);
      const text = await render({
        departure_icao: departure!,
        destination_icao: destination!,
        alternates: alternates.join(','),
      });
      const lines = callLines(text, 'aviation_get_taf');

      expect(lines).toHaveLength(2);
      expect(stationsOn(lines[0]!)).toEqual(icaos(5).slice(0, 4));
      expect(stationsOn(lines[1]!)).toEqual(icaos(5).slice(4));
      expect(text).toContain('`aviation_get_taf` accepts at most 4 stations per call');
    });

    it('keeps a single METAR call at the 10-station limit', async () => {
      const [departure, destination, ...alternates] = icaos(10);
      const text = await render({
        departure_icao: departure!,
        destination_icao: destination!,
        alternates: alternates.join(','),
      });
      const lines = callLines(text, 'aviation_get_metar');

      expect(lines).toHaveLength(1);
      expect(stationsOn(lines[0]!)).toEqual(icaos(10));
    });

    it('splits the METAR call one station over the 10-station limit', async () => {
      const [departure, destination, ...alternates] = icaos(11);
      const text = await render({
        departure_icao: departure!,
        destination_icao: destination!,
        alternates: alternates.join(','),
      });
      const lines = callLines(text, 'aviation_get_metar');

      expect(lines).toHaveLength(2);
      expect(stationsOn(lines[0]!)).toEqual(icaos(11).slice(0, 10));
      expect(stationsOn(lines[1]!)).toEqual(icaos(11).slice(10));
      expect(text).toContain('`aviation_get_metar` accepts at most 10 stations per call');
    });

    it('covers every station exactly once across both tools when chunking', async () => {
      const [departure, destination, ...alternates] = icaos(11);
      const text = await render({
        departure_icao: departure!,
        destination_icao: destination!,
        alternates: alternates.join(','),
      });

      expect(callLines(text, 'aviation_get_metar').flatMap(stationsOn)).toEqual(icaos(11));

      const tafLines = callLines(text, 'aviation_get_taf');
      expect(tafLines).toHaveLength(3);
      expect(tafLines.every((line) => stationsOn(line).length <= 4)).toBe(true);
      expect(tafLines.flatMap(stationsOn)).toEqual(icaos(11));
    });
  });

  describe('synthesis step', () => {
    it('asks for a weather-risk summary instead of a Go/No-Go recommendation', async () => {
      const text = await render({ departure_icao: 'KDEN', destination_icao: 'KDFW' });

      expect(text).toContain('**Weather risk**');
      expect(text).toContain('stated as risk rather than as a Go/No-Go recommendation');
      expect(text).toContain('no pilot, aircraft, or operational-minima context');
    });

    it('always asks for gaps and uncertainty, including tool-reported shortfalls', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        departure_time: '2026-03-14T15:00Z',
        cruise_altitude: '9500',
        route_waypoints: '47.45,-122.31;40.64,-73.78',
      });

      expect(text).toContain('**Gaps and uncertainty**');
      expect(text).toContain('partial, truncated, or limited');
      expect(text).not.toContain('No departure time supplied');
      expect(text).not.toContain('No cruise altitude supplied');
      expect(text).not.toContain('No route waypoints supplied');
    });

    it('lists every missing optional argument as a gap when none are supplied', async () => {
      const text = await render({ departure_icao: 'KSEA', destination_icao: 'KJFK' });
      const gapSection = text.split('**Gaps and uncertainty**')[1] ?? '';

      expect(gapSection).toContain('No departure time supplied');
      expect(gapSection).toContain('No cruise altitude supplied');
      expect(gapSection).toContain('No route waypoints supplied');
    });
  });
});
