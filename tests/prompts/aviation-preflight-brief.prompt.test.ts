/**
 * @fileoverview Tests for the aviation_preflight_brief prompt.
 * @module tests/prompts/aviation-preflight-brief.prompt.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { aviationPreflightBrief } from '@/mcp-server/prompts/definitions/aviation-preflight-brief.prompt.js';
import { aviationGetPireps } from '@/mcp-server/tools/definitions/aviation-get-pireps.tool.js';
import { pushablePirepLevel } from '@/services/aviation-weather/awc-limits.js';

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
    it('accepts digit-bearing identifiers and briefs them like any other (issue #37)', async () => {
      // K0S9 and KS52 are METAR stations whose K + FAA-ID form carries digits;
      // K36U also issues TAFs. Every weather tool the briefing calls takes them.
      const text = await render({
        departure_icao: 'K0S9',
        destination_icao: 'KS52',
        alternates: 'K36U, KBFI',
      });

      expect(callLines(text, 'aviation_get_metar').flatMap(stationsOn)).toEqual([
        'K0S9',
        'KS52',
        'K36U',
        'KBFI',
      ]);
      expect(callLines(text, 'aviation_get_taf').flatMap(stationsOn)).toEqual([
        'K0S9',
        'KS52',
        'K36U',
        'KBFI',
      ]);
      expect(text).toContain('Call `aviation_get_pireps` centered on K0S9 and KS52');
    });

    it('describes each identifier argument as letters or digits', () => {
      const args = aviationPreflightBrief.args!.shape;

      expect(args.departure_icao.description ?? '').toMatch(/digit/i);
      expect(args.destination_icao.description ?? '').toMatch(/digit/i);
      expect(JSON.stringify(z.toJSONSchema(aviationPreflightBrief.args!))).not.toMatch(
        /\b(4|four)[- ]letter\b|\b4 uppercase letters\b(?! or digits)/i,
      );
    });

    it('rejects a departure identifier that is not four uppercase letters or digits', () => {
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

    it.each([
      ['a lowercase departure', { departure_icao: 'k0s9' }],
      ['a three-character departure', { departure_icao: 'K0S' }],
      ['a five-character destination', { destination_icao: 'K0S9X' }],
      ['an alternate carrying a lowercase entry', { alternates: 'KBFI,k0s9' }],
      ['an alternate carrying a five-character entry', { alternates: 'KBFI,KS52X' }],
    ])('rejects %s', (_label, override) => {
      expect(() =>
        aviationPreflightBrief.args!.parse({
          departure_icao: 'KSEA',
          destination_icao: 'KJFK',
          ...override,
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

    /**
     * The band the briefing instructs, read back out of the rendered text. A
     * bound the prompt emitted as a negative number does not match, which is
     * itself the failure — the tool would reject it.
     */
    function bandFrom(text: string): { altitude_min_ft: number; altitude_max_ft: number } | null {
      const min = /`altitude_min_ft: (\d+)`/.exec(text)?.[1];
      const max = /`altitude_max_ft: (\d+)`/.exec(text)?.[1];
      return min && max ? { altitude_min_ft: Number(min), altitude_max_ft: Number(max) } : null;
    }

    /** The maximum `aviation_get_pireps` advertises on its altitude bounds. */
    function advertisedCeiling(): unknown {
      const schema = z.toJSONSchema(aviationGetPireps.input) as {
        properties?: Record<string, { maximum?: unknown }>;
      };
      return schema.properties?.altitude_max_ft?.maximum;
    }

    it('clamps the band ceiling for a cruise altitude near it', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        cruise_altitude: '59000',
      });

      expect(text).toContain('`altitude_min_ft: 56000`');
      expect(text).toContain('`altitude_max_ft: 60000`');
    });

    it('collapses to the ceiling rather than inverting for an absurd cruise altitude', async () => {
      // `cruise_altitude` admits six digits, so the band can be derived far
      // above anything the tool accepts. Clamping only the top would leave
      // min above max — a band the tool rejects as inverted, which is the
      // same broken recommendation in a different disguise.
      const band = bandFrom(
        await render({
          departure_icao: 'KSEA',
          destination_icao: 'KJFK',
          cruise_altitude: '999999',
        }),
      );

      expect(band).toEqual({ altitude_min_ft: 60000, altitude_max_ft: 60000 });
    });

    it('clamps at exactly the ceiling the tool advertises', async () => {
      // Pins the prompt's own constant to the tool's bound, so moving one
      // without the other fails here rather than in a briefing.
      const band = bandFrom(
        await render({
          departure_icao: 'KSEA',
          destination_icao: 'KJFK',
          cruise_altitude: '999999',
        }),
      );

      expect(band?.altitude_max_ft).toBe(advertisedCeiling());
    });

    it('names the half-width and the cruise altitude on an unclamped band', async () => {
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        cruise_altitude: '9500',
      });

      expect(text).toContain('±3000 ft band around the planned cruise altitude of 9500 ft MSL');
      // Nothing was rounded, so the line says nothing about rounding.
      expect(text).not.toContain('rounded');
    });

    it('describes a band the ceiling collapsed by what it is, not by a centre outside it', async () => {
      // Above 63,000 ft the clamp collapses the band to a single altitude, and
      // the derived centre then sits nowhere near the bounds beside it — so
      // "the ±3,000 ft band around 1000000 ft MSL" would describe nothing.
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        cruise_altitude: '999999',
      });

      expect(text).toContain('`altitude_min_ft: 60000` and `altitude_max_ft: 60000`');
      expect(text).toContain('highest altitude `aviation_get_pireps` searches');
      expect(text).not.toContain('±3000 ft band around 1000000');
    });

    it('names the rounded centre when the cruise altitude is off the grid', async () => {
      // The band is centred on 9,500 ft, so a line claiming ±3,000 ft around
      // 9,501 ft would not describe the bounds beside it.
      const text = await render({
        departure_icao: 'KSEA',
        destination_icao: 'KJFK',
        cruise_altitude: '9501',
      });

      expect(text).toContain('**Cruise altitude:** 9501 ft MSL');
      expect(text).toContain('±3000 ft band around 9500 ft MSL');
      expect(text).toContain('9501 ft rounded to the nearest 100 ft');
    });

    it.each([
      ['at the floor', '2000', 0, 5000],
      ['at the ceiling', '59000', 56000, 60000],
    ])(
      'says what bounded a band clamped %s rather than asserting a symmetry the numbers deny',
      async (_label, cruise_altitude, min, max) => {
        const text = await render({
          departure_icao: 'KSEA',
          destination_icao: 'KJFK',
          cruise_altitude,
        });

        expect(text).toContain(`\`altitude_min_ft: ${min}\``);
        expect(text).toContain(`\`altitude_max_ft: ${max}\``);
        expect(text).toContain('range `aviation_get_pireps` accepts');
      },
    );

    it.each(['0', '1', '2000', '59000', '60000', '99000', '999999'])(
      'derives a band AWC can search upstream for a clamped cruise altitude of %s ft',
      async (cruise_altitude) => {
        // Clamping narrows the band below the full ±3,000 ft width, which
        // leaves slack for the centre's rounding to a whole flight level — so
        // a clamped band is pushed upstream rather than filtered client-side
        // out of a page the row cap may already have cut.
        const band = bandFrom(
          await render({ departure_icao: 'KSEA', destination_icao: 'KJFK', cruise_altitude }),
        );

        expect(band).not.toBeNull();
        expect(pushablePirepLevel(band!.altitude_min_ft, band!.altitude_max_ft)).toBeDefined();
      },
    );

    it('derives a band AWC can search from a cruise altitude off the flight-level grid', async () => {
      // 9,501 ft is the shape this guards: a full-width band centred one foot
      // off a whole flight level fits no centre at all, so its bounds would be
      // filtered client-side out of a page the 400-row cap may already have
      // cut — the outcome the band exists to avoid.
      const band = bandFrom(
        await render({
          departure_icao: 'KSEA',
          destination_icao: 'KJFK',
          cruise_altitude: '9501',
        }),
      );

      expect(band).toEqual({ altitude_min_ft: 6500, altitude_max_ft: 12500 });
      expect(pushablePirepLevel(band!.altitude_min_ft, band!.altitude_max_ft)).toBe(95);
    });

    it('derives an ordered, pushable band from every cruise altitude swept', async () => {
      /**
       * Dense across both clamp regions and the rounding boundaries between
       * them, sparse but deliberately off-grid through the middle, plus the
       * extremes the six-digit input admits. A failure names the altitudes
       * rather than only the count.
       */
      const sweep = [
        ...Array.from({ length: 6001 }, (_, i) => i),
        ...Array.from({ length: 4501 }, (_, i) => 56000 + i),
        ...Array.from({ length: 1000 }, (_, i) => 6000 + i * 50),
        ...Array.from({ length: 1000 }, (_, i) => 6000 + i * 50 + 1),
        99000,
        123456,
        987654,
        999999,
      ];

      const broken: { cruise: number; band: unknown }[] = [];
      for (const cruise of sweep) {
        const band = bandFrom(
          await render({
            departure_icao: 'KSEA',
            destination_icao: 'KJFK',
            cruise_altitude: String(cruise),
          }),
        );
        const ordered = band != null && band.altitude_min_ft <= band.altitude_max_ft;
        const pushable =
          band != null &&
          pushablePirepLevel(band.altitude_min_ft, band.altitude_max_ft) !== undefined;
        if (!ordered || !pushable) broken.push({ cruise, band });
      }

      expect(broken).toEqual([]);
    });

    it.each(['0', '1', '2000', '9500', '35000', '57000', '59999', '60000', '99000', '999999'])(
      'recommends a band aviation_get_pireps accepts for a cruise altitude of %s ft',
      async (cruise_altitude) => {
        // The failure mode this guards: a briefing that instructs a call the
        // tool's own schema then rejects.
        const band = bandFrom(
          await render({ departure_icao: 'KSEA', destination_icao: 'KJFK', cruise_altitude }),
        );

        expect(band).not.toBeNull();
        expect(band!.altitude_min_ft).toBeLessThanOrEqual(band!.altitude_max_ft);
        expect(aviationGetPireps.input.safeParse({ station_id: 'KSEA', ...band }).success).toBe(
          true,
        );
      },
    );
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
