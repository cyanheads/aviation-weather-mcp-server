/**
 * @fileoverview Tests for the aviation_get_metar tool.
 * @module tests/tools/aviation-get-metar.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationGetMetar } from '@/mcp-server/tools/definitions/aviation-get-metar.tool.js';
import type { NormalizedMetar } from '@/services/aviation-weather/types.js';

// ---------------------------------------------------------------------------
// Service mock
// ---------------------------------------------------------------------------

vi.mock('@/services/aviation-weather/aviation-weather-service.js', () => ({
  getAviationWeatherService: vi.fn(),
}));

import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const mockFetchMetar = vi.fn<ReturnType<typeof getAviationWeatherService>['fetchMetar']>();

beforeEach(() => {
  vi.mocked(getAviationWeatherService).mockReturnValue({
    fetchMetar: mockFetchMetar,
  } as unknown as ReturnType<typeof getAviationWeatherService>);
  mockFetchMetar.mockReset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ksea: NormalizedMetar = {
  station_id: 'KSEA',
  name: 'Seattle-Tacoma International Airport',
  lat: 47.4499,
  lon: -122.3117,
  elevation_ft: 433,
  flight_category: 'VFR',
  metar_type: 'METAR',
  observed_at: '2026-01-15T18:53:00.000Z',
  wind: { direction_deg: 180, speed_kt: 10, gust_kt: null },
  visibility_sm: '10+',
  ceiling_ft: null,
  ceiling_type: null,
  clouds: [{ cover: 'FEW', base_ft: 4500 }],
  sky_condition: null,
  present_weather: null,
  temp_c: 8,
  dewpoint_c: 3,
  altimeter_inhg: 30.01,
  raw_metar: 'KSEA 151853Z 18010KT 10SM FEW045 08/03 A3001 RMK AO2',
};

/**
 * An obscured sky — the `VV002` group decodes to an OVX layer at 200 ft, which
 * is an indefinite ceiling rather than no ceiling. Modeled on the live record
 * `SPECI KDBQ 131018Z AUTO 16004KT 1/4SM FG VV002 21/21 A2990`.
 */
const obscuredMetar: NormalizedMetar = {
  station_id: 'KDBQ',
  name: 'Dubuque Rgnl',
  lat: 42.4,
  lon: -90.7,
  elevation_ft: 1076,
  flight_category: 'LIFR',
  metar_type: 'SPECI',
  observed_at: '2026-08-13T10:18:00.000Z',
  wind: { direction_deg: 160, speed_kt: 4, gust_kt: null },
  visibility_sm: '1/4',
  ceiling_ft: 200,
  ceiling_type: 'indefinite',
  clouds: [{ cover: 'OVX', base_ft: 200 }],
  sky_condition: null,
  present_weather: { raw: 'FG', decoded: 'fog' },
  temp_c: 21,
  dewpoint_c: 21,
  altimeter_inhg: 29.9,
  raw_metar: 'SPECI KDBQ 131018Z AUTO 16004KT 1/4SM FG VV002 21/21 A2990 RMK AO2',
};

/** A measured ceiling — an overcast layer base, the ordinary case. */
const overcastMetar: NormalizedMetar = {
  ...ksea,
  flight_category: 'IFR',
  ceiling_ft: 900,
  ceiling_type: 'measured',
  clouds: [
    { cover: 'SCT', base_ft: 500 },
    { cover: 'OVC', base_ft: 900 },
  ],
  present_weather: { raw: '-RA', decoded: 'light rain' },
};

/**
 * Two space-delimited weather groups, live on the CONUS feed. The proximity
 * scopes the thunderstorm alone — the rain is at the field, not in the vicinity.
 */
const multiGroupMetar: NormalizedMetar = {
  ...ksea,
  present_weather: { raw: 'VCTS -RA', decoded: 'thunderstorm in the vicinity; light rain' },
};

/** A group the decoder does not recognize, carried through as its raw token. */
const unresolvedWeatherMetar: NormalizedMetar = {
  ...ksea,
  present_weather: { raw: '-SHRA XX', decoded: 'light rain showers; XX' },
};

/**
 * Sparse upstream observation — the groups AWC omitted come back unknown.
 * Modeled on `METAR KACY 130954Z A2984 RMK AO2 SLPNO $`, which carries no wind,
 * temperature, or dewpoint at all.
 */
const sparseMetar: NormalizedMetar = {
  station_id: 'KACY',
  name: 'KACY',
  lat: 39.45,
  lon: -74.57,
  elevation_ft: 59,
  flight_category: 'unknown',
  metar_type: 'METAR',
  observed_at: '2026-01-15T18:00:00.000Z',
  wind: { direction_deg: null, speed_kt: null, gust_kt: null },
  visibility_sm: 'unknown',
  ceiling_ft: null,
  ceiling_type: null,
  clouds: [],
  sky_condition: null,
  present_weather: null,
  temp_c: null,
  dewpoint_c: null,
  altimeter_inhg: null,
  raw_metar: 'METAR KACY 130954Z A2984 RMK AO2 SLPNO $',
};

/**
 * Every numeric observation genuinely reading zero — calm wind at a sea-level
 * field, freezing temperature and dewpoint. None of these is a missing value.
 */
const calmMetar: NormalizedMetar = {
  station_id: 'KMSY',
  name: 'New Orleans Intl',
  lat: 29.99,
  lon: -90.25,
  elevation_ft: 0,
  flight_category: 'VFR',
  metar_type: 'METAR',
  observed_at: '2026-01-15T18:00:00.000Z',
  wind: { direction_deg: 0, speed_kt: 0, gust_kt: null },
  visibility_sm: '10+',
  ceiling_ft: null,
  ceiling_type: null,
  clouds: [],
  sky_condition: 'CLR',
  present_weather: null,
  temp_c: 0,
  dewpoint_c: 0,
  altimeter_inhg: 30.0,
  raw_metar: 'METAR KMSY 151800Z 00000KT 10SM CLR 00/00 A3000',
};

/**
 * An explicit clear report. `SPECI KVCT 131049Z AUTO 15005KT 2 1/2SM BR CLR
 * 25/24 A2995` — AWC encodes no layer for a `CLR` group and states the
 * condition in the record's own `cover` field instead.
 */
const clearMetar: NormalizedMetar = {
  ...ksea,
  station_id: 'KVCT',
  name: 'Victoria Rgnl',
  clouds: [],
  ceiling_ft: null,
  ceiling_type: null,
  sky_condition: 'CLR',
  raw_metar: 'SPECI KVCT 131049Z AUTO 15005KT 2 1/2SM BR CLR 25/24 A2995 RMK AO2',
};

/**
 * An observation carrying no sky-condition group at all — an AO1 station whose
 * sensor reports none. `METAR KJDN 131048Z AUTO 03008KT 14/12 A3002 RMK AO1`
 * arrives with an empty cloud array and no `cover` field, the same empty array
 * a `CLR` report produces.
 */
const unreportedSkyMetar: NormalizedMetar = {
  ...ksea,
  station_id: 'KJDN',
  name: 'Jordan',
  clouds: [],
  ceiling_ft: null,
  ceiling_type: null,
  sky_condition: null,
  raw_metar: 'METAR KJDN 131048Z AUTO 03008KT 14/12 A3002 RMK AO1 SLP155 P0006 T0139',
};

/**
 * An obscuration whose vertical visibility the station could not determine —
 * `METAR WBGG 092300Z 00000KT 2000 HZ VV/// 24/24 Q1009`, reported IFR. AWC
 * publishes no layer for a `VV///` group and carries `OVX` in `cover`, so this
 * lands in the same empty cloud array as a clear sky while meaning its opposite.
 */
const indeterminateObscurationMetar: NormalizedMetar = {
  ...ksea,
  station_id: 'WBGG',
  name: 'Kuching',
  flight_category: 'IFR',
  visibility_sm: '1.25',
  clouds: [],
  ceiling_ft: null,
  ceiling_type: null,
  sky_condition: 'OVX',
  present_weather: { raw: 'HZ', decoded: 'haze' },
  raw_metar: 'METAR WBGG 092300Z 00000KT 2000 HZ VV/// 24/24 Q1009 NOSIG',
};

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('aviationGetMetar', () => {
  it('returns observations for valid station IDs', async () => {
    mockFetchMetar.mockResolvedValue([ksea]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      station_id: 'KSEA',
      flight_category: 'VFR',
      visibility_sm: '10+',
    });
    expect(mockFetchMetar).toHaveBeenCalledWith({ stationIds: ['KSEA'], hours: 1 }, ctx);
  });

  it('passes hours parameter to the service', async () => {
    mockFetchMetar.mockResolvedValue([ksea, { ...ksea, observed_at: '2026-01-15T17:53:00.000Z' }]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'], hours: 3 });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result.observations).toHaveLength(2);
    expect(mockFetchMetar).toHaveBeenCalledWith({ stationIds: ['KSEA'], hours: 3 }, ctx);
  });

  it('throws no_stations_found when service returns empty array', async () => {
    mockFetchMetar.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['ZZZZ'] });

    await expect(aviationGetMetar.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_stations_found' },
    });
  });

  it('handles sparse upstream payload without crashing', async () => {
    mockFetchMetar.mockResolvedValue([sparseMetar]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KACY'] });
    const result = await aviationGetMetar.handler(input, ctx);

    const obs = result.observations[0]!;
    expect(obs.ceiling_ft).toBeNull();
    expect(obs.wind.direction_deg).toBeNull();
    expect(obs.clouds).toHaveLength(0);
  });

  it('accepts visib as string from upstream (e.g. "10+")', async () => {
    const obs = { ...ksea, visibility_sm: '10+' };
    mockFetchMetar.mockResolvedValue([obs]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(typeof result.observations[0]!.visibility_sm).toBe('string');
    expect(result.observations[0]!.visibility_sm).toBe('10+');
  });
});

// ---------------------------------------------------------------------------
// station_ids mode, pinned whole — every row inside the window, in the order
// upstream served them, disclosing the reconciliation and nothing else
// ---------------------------------------------------------------------------

describe('aviationGetMetar station_ids mode', () => {
  /** A second station, so the batch spans two. */
  const kpdx: NormalizedMetar = { ...ksea, station_id: 'KPDX', name: 'Portland Intl' };
  /** An earlier KSEA observation — a second row for a station already present. */
  const kseaEarlier: NormalizedMetar = { ...ksea, observed_at: '2026-01-15T17:53:00.000Z' };

  it('returns every observation in the window, one row per station/time pair', async () => {
    mockFetchMetar.mockResolvedValue([ksea, kseaEarlier, kpdx]);
    const result = await runToolContract(aviationGetMetar, {
      station_ids: ['KSEA', 'KPDX'],
      hours: 3,
    });
    const { observations } = result.structuredContent as { observations: NormalizedMetar[] };

    expect(observations.map((o) => [o.station_id, o.observed_at])).toEqual([
      ['KSEA', ksea.observed_at],
      ['KSEA', kseaEarlier.observed_at],
      ['KPDX', kpdx.observed_at],
    ]);
  });

  it('discloses the request reconciliation and no area-survey field', async () => {
    mockFetchMetar.mockResolvedValue([ksea, kseaEarlier, kpdx]);
    const result = await runToolContract(aviationGetMetar, {
      station_ids: ['KSEA', 'KPDX'],
      hours: 3,
    });

    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual([
      'observations',
      'partial',
      'requested',
      'returned',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Unknown observations vs. genuine zeros (issue #15)
// ---------------------------------------------------------------------------

describe('aviationGetMetar unknown vs. genuine zero', () => {
  it('carries unreported observations through as null', async () => {
    mockFetchMetar.mockResolvedValue([sparseMetar]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KACY'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result.observations[0]).toMatchObject({
      temp_c: null,
      dewpoint_c: null,
      altimeter_inhg: null,
      wind: { speed_kt: null },
    });
  });

  it('carries genuine zero readings through as 0', async () => {
    mockFetchMetar.mockResolvedValue([calmMetar]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KMSY'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result.observations[0]).toMatchObject({
      temp_c: 0,
      dewpoint_c: 0,
      elevation_ft: 0,
      wind: { speed_kt: 0 },
    });
  });

  it('accepts both shapes against the declared output schema', async () => {
    mockFetchMetar.mockResolvedValue([sparseMetar, calmMetar]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KACY', 'KMSY'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(aviationGetMetar.output));
  });

  it('keeps elevation_ft a required number so a sea-level field stays 0', () => {
    const elevation = aviationGetMetar.output.shape.observations.element.shape.elevation_ft;

    expect(elevation.safeParse(0).success).toBe(true);
    expect(elevation.safeParse(null).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Output-schema datum (issue #13) — aerodrome cloud heights are AGL, station
// elevation is MSL. A client that adds elevation to an AGL value is the failure
// this guards against.
// ---------------------------------------------------------------------------

describe('aviationGetMetar output datum', () => {
  const observation = aviationGetMetar.output.shape.observations.element.shape;

  it('describes the ceiling in feet AGL', () => {
    expect(observation.ceiling_ft.description).toContain('AGL');
    expect(observation.ceiling_ft.description).not.toContain('MSL');
  });

  it('describes cloud bases in feet AGL', () => {
    const base = observation.clouds.element.shape.base_ft.description;
    expect(base).toContain('AGL');
    expect(base).not.toContain('MSL');
  });

  it('keeps station elevation in feet MSL', () => {
    expect(observation.elevation_ft.description).toContain('MSL');
    expect(observation.elevation_ft.description).not.toContain('AGL');
  });
});

// ---------------------------------------------------------------------------
// Obscuration and present weather (issue #16) — an obscuration is a ceiling,
// and the weather group must survive to both response surfaces
// ---------------------------------------------------------------------------

describe('aviationGetMetar obscuration', () => {
  const observation = aviationGetMetar.output.shape.observations.element.shape;

  it('accepts an indefinite ceiling against the declared output schema', async () => {
    mockFetchMetar.mockResolvedValue([obscuredMetar, overcastMetar, ksea, sparseMetar]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KDBQ'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(aviationGetMetar.output));
  });

  it('carries the obscuration ceiling and its kind through the handler', async () => {
    mockFetchMetar.mockResolvedValue([obscuredMetar]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KDBQ'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result.observations[0]).toMatchObject({
      ceiling_ft: 200,
      ceiling_type: 'indefinite',
      flight_category: 'LIFR',
    });
  });

  it('admits only the two ceiling kinds plus null', () => {
    expect(observation.ceiling_type.safeParse('measured').success).toBe(true);
    expect(observation.ceiling_type.safeParse('indefinite').success).toBe(true);
    expect(observation.ceiling_type.safeParse(null).success).toBe(true);
    expect(observation.ceiling_type.safeParse('estimated').success).toBe(false);
  });

  it('defines the ceiling as including an obscuration, in feet AGL', () => {
    const description = observation.ceiling_ft.description ?? '';
    expect(description).toContain('AGL');
    expect(description).toMatch(/obscuration/i);
    expect(description).not.toMatch(/lowest BKN or OVC layer base/);
  });

  it('names the cover codes the field actually emits', () => {
    const description = observation.clouds.element.shape.cover.description ?? '';
    for (const code of ['FEW', 'SCT', 'BKN', 'OVC', 'SKC', 'CLR', 'OVX', 'CAVOK']) {
      expect(description).toContain(code);
    }
  });

  it('carries present weather as a raw group plus decoded text', async () => {
    mockFetchMetar.mockResolvedValue([obscuredMetar]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KDBQ'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result.observations[0]!.present_weather).toEqual({ raw: 'FG', decoded: 'fog' });
  });

  it('leaves present weather null on a dry observation', async () => {
    mockFetchMetar.mockResolvedValue([ksea]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result.observations[0]!.present_weather).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-group present weather (issue #21) — a wxString is space-delimited and
// every group has to reach both response surfaces decoded
// ---------------------------------------------------------------------------

describe('aviationGetMetar present weather', () => {
  const presentWeather = aviationGetMetar.output.shape.observations.element.shape.present_weather;

  /** Run the handler over one observation and return it. */
  async function handle(observation: NormalizedMetar) {
    mockFetchMetar.mockResolvedValue([observation]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetMetar.handler(input, ctx);
    return result.observations[0]!;
  }

  it('carries every decoded group to structuredContent', async () => {
    expect((await handle(multiGroupMetar)).present_weather).toEqual({
      raw: 'VCTS -RA',
      decoded: 'thunderstorm in the vicinity; light rain',
    });
  });

  it('keeps an unresolved group recoverable from the raw field', async () => {
    expect((await handle(unresolvedWeatherMetar)).present_weather).toEqual({
      raw: '-SHRA XX',
      decoded: 'light rain showers; XX',
    });
  });

  it('accepts a multi-group observation against the declared output schema', async () => {
    mockFetchMetar.mockResolvedValue([multiGroupMetar, unresolvedWeatherMetar, ksea]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(aviationGetMetar.output));
  });

  it('names the verbatim passthrough in the decoded description', () => {
    // A consumer that does not know an unrecognized group comes back coded
    // will paraphrase the raw token as a decoded reading.
    expect(presentWeather.unwrap().shape.decoded.description ?? '').toMatch(/raw token/);
  });
});

// ---------------------------------------------------------------------------
// Format tests
// ---------------------------------------------------------------------------

describe('aviationGetMetar.format', () => {
  it('renders station ID, flight category, and raw METAR', () => {
    const blocks = aviationGetMetar.format!({ observations: [ksea] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('KSEA');
    expect(text).toContain('VFR');
    expect(text).toContain(ksea.raw_metar);
  });

  it('renders variable wind direction as "variable"', () => {
    const obs: NormalizedMetar = {
      ...ksea,
      wind: { direction_deg: null, speed_kt: 5, gust_kt: null },
    };
    const blocks = aviationGetMetar.format!({ observations: [obs] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('variable');
  });

  it('renders gust speed when present', () => {
    const obs: NormalizedMetar = {
      ...ksea,
      wind: { direction_deg: 270, speed_kt: 15, gust_kt: 25 },
    };
    const blocks = aviationGetMetar.format!({ observations: [obs] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('25');
  });

  it('renders the sky condition an observation with no layers reported', () => {
    const blocks = aviationGetMetar.format!({ observations: [clearMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('**Clouds:** CLR');
  });

  it('renders cloud layers when present', () => {
    const obs: NormalizedMetar = {
      ...ksea,
      clouds: [{ cover: 'BKN', base_ft: 1800 }],
      ceiling_ft: 1800,
    };
    const blocks = aviationGetMetar.format!({ observations: [obs] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('BKN');
    expect(text).toContain('1800');
  });

  // A content[]-only client never sees structuredContent, so the unreported
  // state has to survive into the rendered text rather than reading as a
  // measurement — neither a calm nor a variable wind.
  it('renders an observation with no wind group as not reported, not 0 kt or variable', () => {
    const blocks = aviationGetMetar.format!({ observations: [sparseMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('**Wind:** not reported\n');
    expect(text).not.toContain('at 0 kt');
    expect(text).not.toContain('variable');
  });

  it('renders a calm wind as 0 kt', () => {
    const blocks = aviationGetMetar.format!({ observations: [calmMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('at 0 kt');
    expect(text).not.toContain('unknown');
  });

  it('never interpolates a bare null into the rendered text', () => {
    const blocks = aviationGetMetar.format!({ observations: [sparseMetar, calmMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).not.toMatch(/\bnull\b/);
  });

  it('renders unreported temperature, dewpoint, and altimeter as unknown', () => {
    const blocks = aviationGetMetar.format!({ observations: [sparseMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('**Temperature:** unknown');
    expect(text).toContain('**Dewpoint:** unknown');
    expect(text).toContain('**Altimeter:** unknown');
    expect(text).not.toContain('0°C');
    expect(text).not.toContain('0 inHg');
  });

  it('renders genuine zero temperature and dewpoint as 0°C', () => {
    const blocks = aviationGetMetar.format!({ observations: [calmMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('**Temperature:** 0°C');
    expect(text).toContain('**Dewpoint:** 0°C');
  });

  it('renders a sea-level field elevation as 0 ft', () => {
    const blocks = aviationGetMetar.format!({ observations: [calmMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('**Elevation:** 0 ft');
  });

  // Issue #16 — a content[]-only client reading "Ceiling: Clear" under an
  // obscured sky is the failure this whole change exists to remove.
  it('names an obscuration as an indefinite ceiling, never as Clear', () => {
    const blocks = aviationGetMetar.format!({ observations: [obscuredMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**Ceiling:** 200 ft');
    expect(text).toContain('indefinite');
    expect(text).not.toContain('Ceiling:** Clear');
  });

  it('marks a broken or overcast ceiling as measured', () => {
    const blocks = aviationGetMetar.format!({ observations: [overcastMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**Ceiling:** 900 ft (measured)');
  });

  it('renders no ceiling as none rather than an affirmative Clear', () => {
    const blocks = aviationGetMetar.format!({ observations: [ksea] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**Ceiling:** none');
    expect(text).not.toContain('Ceiling:** Clear');
  });

  it('renders present weather as the raw group plus its decoded reading', () => {
    const blocks = aviationGetMetar.format!({ observations: [obscuredMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('FG');
    expect(text).toContain('fog');
  });

  it('renders every group of a multi-group observation', () => {
    const blocks = aviationGetMetar.format!({ observations: [multiGroupMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain(
      '**Present weather:** VCTS -RA (thunderstorm in the vicinity; light rain)',
    );
  });

  it('renders an unresolved group as its raw token rather than half-translated', () => {
    const blocks = aviationGetMetar.format!({ observations: [unresolvedWeatherMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('-SHRA XX (light rain showers; XX)');
    expect(text).not.toContain('light XX');
  });

  it('omits the present-weather line on a dry observation', () => {
    const blocks = aviationGetMetar.format!({ observations: [ksea] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).not.toContain('**Present weather:**');
  });

  it('renders coordinates at the resolution upstream supplied', () => {
    const blocks = aviationGetMetar.format!({ observations: [ksea] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**Location:** 47.4499, -122.3117');
  });

  it('does not pad a low-precision coordinate', () => {
    const blocks = aviationGetMetar.format!({ observations: [sparseMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**Location:** 39.45, -74.57');
    expect(text).not.toContain('39.4500');
  });
});

// ---------------------------------------------------------------------------
// Wind line (issue #38) — a null direction is a variable wind only when a speed
// rides beside it; with no speed the observation carried no wind group at all
// ---------------------------------------------------------------------------

describe('aviationGetMetar wind line', () => {
  /** Render one observation carrying `wind` and return its text block. */
  function render(wind: NormalizedMetar['wind']): string {
    const blocks = aviationGetMetar.format!({ observations: [{ ...ksea, wind }] });
    return (blocks[0] as { type: string; text: string }).text;
  }

  it('renders a directional wind with its direction and speed', () => {
    expect(render({ direction_deg: 180, speed_kt: 10, gust_kt: null })).toContain(
      '**Wind:** 180° at 10 kt\n',
    );
  });

  it('renders a VRB wind that carries a speed as variable', () => {
    // Raw `VRB05KT` — wdir arrives as the string 'VRB' beside a real speed.
    expect(render({ direction_deg: null, speed_kt: 5, gust_kt: null })).toContain(
      '**Wind:** variable at 5 kt\n',
    );
  });

  it('renders a calm wind as 0° at 0 kt, distinct from an unreported one', () => {
    // Raw `00000KT` — 0 and null must stay distinguishable on the rendered line.
    expect(render({ direction_deg: 0, speed_kt: 0, gust_kt: null })).toContain(
      '**Wind:** 0° at 0 kt\n',
    );
  });

  it.each([
    ['a directional wind', { direction_deg: 270, speed_kt: 15, gust_kt: 25 }, '270° at 15 kt'],
    ['a variable wind', { direction_deg: null, speed_kt: 8, gust_kt: 18 }, 'variable at 8 kt'],
  ])('appends the gust to %s', (_label, wind, reading) => {
    expect(render(wind)).toContain(`**Wind:** ${reading} gusting ${wind.gust_kt} kt\n`);
  });

  it('keeps the structured wind all null for an observation with no wind group', async () => {
    mockFetchMetar.mockResolvedValue([sparseMetar]);
    const result = await runToolContract(aviationGetMetar, { station_ids: ['KACY'], hours: 1 });

    expect(result.structuredContent).toMatchObject({
      observations: [
        expect.objectContaining({
          wind: { direction_deg: null, speed_kt: null, gust_kt: null },
        }),
      ],
    });
  });

  it('renders an observation with no wind group as not reported, never as variable', () => {
    // Live KPVF: `METAR KPVF 221555Z AUTO 10SM CLR 19/05 A3001 RMK AO1` — the
    // sensor sent no wind group, so there is no direction to call variable.
    const text = render({ direction_deg: null, speed_kt: null, gust_kt: null });

    expect(text).toContain('**Wind:** not reported\n');
    expect(text).not.toMatch(/\*\*Wind:\*\* variable/);
    expect(text).not.toContain('unknown speed');
  });

  it('keeps an unreported wind distinguishable on both surfaces in one batch', async () => {
    // A calm, a variable, and a missing wind group side by side: three different
    // readings on structuredContent, and three different lines in content[].
    const kvrb: NormalizedMetar = {
      ...ksea,
      station_id: 'KVRB',
      name: 'Vero Beach',
      wind: { direction_deg: null, speed_kt: 4, gust_kt: null },
    };
    mockFetchMetar.mockResolvedValue([calmMetar, kvrb, sparseMetar]);
    const result = await runToolContract(aviationGetMetar, {
      station_ids: ['KMSY', 'KVRB', 'KACY'],
      hours: 1,
    });

    expect(result.structuredContent).toMatchObject({
      observations: [
        expect.objectContaining({ wind: { direction_deg: 0, speed_kt: 0, gust_kt: null } }),
        expect.objectContaining({ wind: { direction_deg: null, speed_kt: 4, gust_kt: null } }),
        expect.objectContaining({ wind: { direction_deg: null, speed_kt: null, gust_kt: null } }),
      ],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('**Wind:** 0° at 0 kt');
    expect(text).toContain('**Wind:** variable at 4 kt');
    expect(text).toContain('**Wind:** not reported');
  });

  it('states both null cases in the direction description, and what separates them', () => {
    const description =
      aviationGetMetar.output.shape.observations.element.shape.wind.shape.direction_deg
        .description ?? '';

    expect(description).toMatch(/VRB|variable/i);
    expect(description).toMatch(/no wind group/i);
    expect(description).toContain('speed_kt');
  });
});

// ---------------------------------------------------------------------------
// Partial-batch disclosure (issue #18) — a station that returns nothing was
// dropped without a trace, so a partial result read as full route coverage
// ---------------------------------------------------------------------------

describe('aviationGetMetar partial-batch disclosure', () => {
  /** A second station, so a batch can come back short. */
  const kpdx: NormalizedMetar = { ...ksea, station_id: 'KPDX', name: 'Portland Intl' };

  /** Run the handler over a batch and return the enrichment it accumulated. */
  async function enrichmentFor(station_ids: string[], observations: NormalizedMetar[], hours = 1) {
    mockFetchMetar.mockResolvedValue(observations);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids, hours });
    await aviationGetMetar.handler(input, ctx);
    return getEnrichment(ctx);
  }

  it('names the station that returned no data', async () => {
    expect(await enrichmentFor(['KSEA', 'KZZZ'], [ksea])).toMatchObject({
      requested: ['KSEA', 'KZZZ'],
      returned: ['KSEA'],
      partial: true,
      missing: ['KZZZ'],
    });
  });

  it('carries recovery guidance on a partial result', async () => {
    const notice = (await enrichmentFor(['KSEA', 'KZZZ'], [ksea])).notice;

    expect(notice).toContain('KZZZ');
    expect(String(notice)).toMatch(/aviation_find_stations/);
  });

  it('states completeness affirmatively on a full batch', async () => {
    const enrichment = await enrichmentFor(['KSEA', 'KPDX'], [ksea, kpdx]);

    expect(enrichment).toMatchObject({
      requested: ['KSEA', 'KPDX'],
      returned: ['KSEA', 'KPDX'],
      partial: false,
    });
    expect(enrichment).not.toHaveProperty('missing');
  });

  it('leaves the notice off a complete batch', async () => {
    expect(await enrichmentFor(['KSEA'], [ksea])).not.toHaveProperty('notice');
  });

  it('counts distinct stations, not observation rows', async () => {
    // `hours: 12` returns one row per observation, so a station reporting six
    // times must appear once in `returned` and never in `missing`.
    const rows = Array.from({ length: 6 }, (_, i) => ({
      ...ksea,
      observed_at: `2026-01-15T${String(6 + i).padStart(2, '0')}:53:00.000Z`,
    }));
    const enrichment = await enrichmentFor(['KSEA', 'KPDX'], [...rows, kpdx], 12);

    expect(enrichment).toMatchObject({
      returned: ['KSEA', 'KPDX'],
      partial: false,
    });
  });

  it('states no cause for an omission', async () => {
    // Three upstream conditions produce the same missing row and the response
    // cannot tell them apart, so the guidance names candidates, never a verdict.
    const notice = String((await enrichmentFor(['KSEA', 'KZZZ'], [ksea])).notice);

    expect(notice).toMatch(/\bmay\b/);
    expect(notice).not.toMatch(/\b(is not a known station|does not transmit|is stale)\b/);
  });

  it('still throws rather than disclosing an empty result as a partial one', async () => {
    mockFetchMetar.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KZZZ', 'KZZY'] });

    await expect(aviationGetMetar.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_stations_found' },
    });
    expect(getEnrichment(ctx)).not.toHaveProperty('partial');
  });

  it('reaches structuredContent and content[] through the real tool pipeline', async () => {
    mockFetchMetar.mockResolvedValue([ksea]);
    const result = await runToolContract(aviationGetMetar, {
      station_ids: ['KSEA', 'KZZZ'],
      hours: 1,
    });

    expect(result.structuredContent).toMatchObject({
      partial: true,
      missing: ['KZZZ'],
      requested: ['KSEA', 'KZZZ'],
      returned: ['KSEA'],
    });

    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('KZZZ');
    expect(text).toContain('aviation_find_stations');
  });

  it.each([['ksea'], ['SEA'], ['KSEATTLE'], ['']])(
    'rejects %p before reconciliation can run',
    (id) => {
      // Comparing the requested IDs against upstream `icaoId` is only a sound
      // set operation because the input contract fixes them at four uppercase
      // letters or digits — a relaxed input would surface a casing mismatch as
      // a missing station rather than as the input error it is.
      expect(aviationGetMetar.input.safeParse({ station_ids: [id], hours: 1 }).success).toBe(false);
    },
  );

  it('rejects an empty batch rather than reconciling nothing', () => {
    expect(aviationGetMetar.input.safeParse({ station_ids: [], hours: 1 }).success).toBe(false);
  });

  it('rejects a batch past the 10-station cap', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `KZZ${String.fromCharCode(65 + i)}`);

    expect(aviationGetMetar.input.safeParse({ station_ids: ids, hours: 1 }).success).toBe(false);
  });

  it('leaves the observations payload and its rendering untouched', async () => {
    mockFetchMetar.mockResolvedValue([ksea]);
    const result = await runToolContract(aviationGetMetar, {
      station_ids: ['KSEA', 'KZZZ'],
      hours: 1,
    });

    expect(result.structuredContent).toMatchObject({
      observations: [expect.objectContaining({ station_id: 'KSEA' })],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('## KSEA — Seattle-Tacoma International Airport');
  });
});

// ---------------------------------------------------------------------------
// Digit-bearing station identifiers (issue #37) — a US airport with no
// three-letter FAA identifier takes a K + FAA-ID form that carries digits, and
// AWC serves METARs for it
// ---------------------------------------------------------------------------

describe('aviationGetMetar digit-bearing station identifiers', () => {
  /** Live K0S9: `METAR K0S9 221615Z AUTO 27004KT 10SM CLR 16/11 A3005 RMK AO2`. */
  const k0s9: NormalizedMetar = {
    ...clearMetar,
    station_id: 'K0S9',
    name: 'Port Townsend/Jefferson Cnty, WA, US',
    raw_metar: 'METAR K0S9 221615Z AUTO 27004KT 10SM CLR 16/11 A3005 RMK AO2',
  };
  const ks52: NormalizedMetar = { ...k0s9, station_id: 'KS52', name: 'Methow Valley State' };

  it('sends the identifiers upstream and reconciles them like any other', async () => {
    mockFetchMetar.mockResolvedValue([ks52, k0s9]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KS52', 'K0S9'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(mockFetchMetar).toHaveBeenCalledWith({ stationIds: ['KS52', 'K0S9'], hours: 1 }, ctx);
    expect(result.observations.map((o) => o.station_id)).toEqual(['KS52', 'K0S9']);
    expect(getEnrichment(ctx)).toMatchObject({ returned: ['KS52', 'K0S9'], partial: false });
  });

  it('reaches both response surfaces through the real tool pipeline', async () => {
    mockFetchMetar.mockResolvedValue([k0s9]);
    const result = await runToolContract(aviationGetMetar, {
      station_ids: ['K0S9', 'KS52'],
      hours: 1,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      observations: [expect.objectContaining({ station_id: 'K0S9' })],
      missing: ['KS52'],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('## K0S9 — Port Townsend/Jefferson Cnty, WA, US');
    expect(text).toContain('**No data returned for:** KS52');
  });

  it('describes the identifier shape as letters or digits', () => {
    const element = aviationGetMetar.input.shape.station_ids.unwrap().element;

    expect(element.description ?? '').toMatch(/digit/i);
    expect(aviationGetMetar.errors?.[0]?.recovery ?? '').not.toMatch(/4-letter/);
  });
});

// ---------------------------------------------------------------------------
// Reported clear sky vs. unreported sky (issue #27) — AWC encodes no layer for
// a clear-sky group, so a clear report and a report carrying no sky-condition
// group arrive as the same empty array. Only one of them is a clear sky.
// ---------------------------------------------------------------------------

describe('aviationGetMetar sky condition', () => {
  /** Render one observation and return its text block. */
  function render(obs: NormalizedMetar): string {
    const blocks = aviationGetMetar.format!({ observations: [obs] });
    return (blocks[0] as { type: string; text: string }).text;
  }

  it('renders a reported clear sky as the code the observation carried', () => {
    expect(render(clearMetar)).toContain(
      '**Clouds:** CLR (clear or no significant cloud reported)',
    );
  });

  it('renders an unreported sky as unreported, never as clear', () => {
    const text = render(unreportedSkyMetar);

    expect(text).toContain('**Clouds:** not reported');
    expect(text).not.toMatch(/\*\*Clouds:\*\* Clear/);
    expect(text).not.toMatch(/\bclear\b/i);
  });

  it('renders an obscuration with no determinable height as obscured, never as clear', () => {
    // `VV///` — the sky is obscured and the station could not measure how far up
    // it can see. Rendering this as a clear sky inverts an IFR observation.
    const text = render(indeterminateObscurationMetar);

    expect(text).toContain('**Clouds:** OVX (sky obscured — no layer height reported)');
    expect(text).not.toMatch(/\bclear\b/i);
  });

  it.each([
    ['CAVOK', 'ceiling and visibility OK'],
    ['SKC', 'sky clear'],
  ])('renders a %s report as its own condition', (code, reading) => {
    expect(render({ ...clearMetar, sky_condition: code })).toContain(
      `**Clouds:** ${code} (${reading})`,
    );
  });

  it('leaves an observation with real layers rendering exactly as before', () => {
    expect(render(overcastMetar)).toContain('**Clouds:** SCT @ 500 ft, OVC @ 900 ft');
  });

  it('carries the distinction on structuredContent, not only in the rendered text', async () => {
    mockFetchMetar.mockResolvedValue([clearMetar, unreportedSkyMetar]);
    const result = await runToolContract(aviationGetMetar, {
      station_ids: ['KVCT', 'KJDN'],
      hours: 1,
    });

    expect(result.structuredContent).toMatchObject({
      observations: [
        expect.objectContaining({ station_id: 'KVCT', sky_condition: 'CLR', clouds: [] }),
        expect.objectContaining({ station_id: 'KJDN', sky_condition: null, clouds: [] }),
      ],
    });
  });

  it('reaches a content[]-only client with both states distinguishable', async () => {
    mockFetchMetar.mockResolvedValue([clearMetar, unreportedSkyMetar]);
    const result = await runToolContract(aviationGetMetar, {
      station_ids: ['KVCT', 'KJDN'],
      hours: 1,
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

    expect(text).toContain('**Clouds:** CLR');
    expect(text).toContain('**Clouds:** not reported');
  });

  it('leaves an obscuration that does carry a height reading as a layer', () => {
    // Regression on decision 12 — a `VV002` group still decodes to an OVX layer
    // with an indefinite ceiling, and states no separate sky condition.
    const text = render(obscuredMetar);

    expect(text).toContain('**Clouds:** OVX @ 200 ft');
    expect(text).toContain('**Ceiling:** 200 ft');
    expect(text).toContain('indefinite');
  });

  it('names the empty-array ambiguity in the clouds description', () => {
    const clouds =
      aviationGetMetar.output.shape.observations.element.shape.clouds.description ?? '';

    expect(clouds).toMatch(/sky_condition/);
  });

  it('states in the sky_condition description that a null with no layers is unreported', () => {
    const sky =
      aviationGetMetar.output.shape.observations.element.shape.sky_condition.description ?? '';

    expect(sky).toMatch(/never a clear one|not.*clear/i);
    expect(sky).toMatch(/OVX/);
  });

  it('describes the OVX marker by the layer height it lacks, not by an undetermined measurement', () => {
    // The field is set from an empty cloud array alone, and `computeCeiling`'s
    // documented vertVis backstop reaches that state on an observation whose
    // vertical visibility *was* determined: AWC publishes the OVX layer with a
    // null base and holds the height on the record. What OVX marks there is a
    // layer that carried no height, which is true in both cases.
    const sky =
      aviationGetMetar.output.shape.observations.element.shape.sky_condition.description ?? '';

    expect(sky).toMatch(/carried no height/i);
    expect(sky).not.toMatch(/could not determine/i);
  });
});

// ---------------------------------------------------------------------------
// An undetermined ceiling is not the absence of one — the same never-assert
// rule as the sky condition above, one field over
// ---------------------------------------------------------------------------

describe('aviationGetMetar ceiling on an obscuration of undetermined height', () => {
  /** Render one observation and return its text block. */
  function render(obs: NormalizedMetar): string {
    const blocks = aviationGetMetar.format!({ observations: [obs] });
    return (blocks[0] as { type: string; text: string }).text;
  }

  it('renders a VV/// obscuration as not determinable rather than as no ceiling', () => {
    // `METAR VOGA 092300Z 00000KT 0100 ... FG VV/// 27/26 Q1011`, reported
    // LIFR. FAA AIM 7-1-29 counts vertical visibility into an obscuration as a
    // ceiling, so this report has one and its height is what is missing.
    const text = render(indeterminateObscurationMetar);

    expect(text).toContain('**Ceiling:** not determinable');
    expect(text).not.toContain('**Ceiling:** none');
  });

  it('still renders no ceiling as none when no such layer was reported', () => {
    // A few or scattered layer over a station with no ceiling — `none` is the
    // correct reading there, and the two must not collapse into one word.
    const text = render(ksea);

    expect(text).toContain('**Ceiling:** none');
    expect(text).not.toContain('not determinable');
  });

  it('leaves a numeric vertical visibility rendering its height', () => {
    // Regression: `VV002` publishes a layer and a height, and that path was
    // already correct. 5 of the 8 OVX records in a 1,849-record live corpus.
    const text = render(obscuredMetar);

    expect(text).toContain(
      '**Ceiling:** 200 ft (indefinite — vertical visibility into an obscuration)',
    );
    expect(text).not.toContain('not determinable');
  });

  it('keeps a surface-level indefinite ceiling at 0 ft rather than reading it as absent', () => {
    // `SPECI USCC ... FG VV000`, reported LIFR — the most hazardous value the
    // field holds and the one a truthiness guard drops.
    const text = render({
      ...obscuredMetar,
      ceiling_ft: 0,
      clouds: [{ cover: 'OVX', base_ft: 0 }],
    });

    expect(text).toContain('**Ceiling:** 0 ft (indefinite');
    expect(text).not.toContain('not determinable');
  });

  it('states both meanings of a null ceiling in the ceiling_ft description', () => {
    const description =
      aviationGetMetar.output.shape.observations.element.shape.ceiling_ft.description ?? '';

    expect(description).toMatch(/determin/i);
    expect(description).toMatch(/OVX|obscuration/);
  });
});

// ---------------------------------------------------------------------------
// Rendered unreported states carry no unit, and input descriptions state what
// the endpoint does rather than what a caller might assume
// ---------------------------------------------------------------------------

describe('aviationGetMetar description and unit accuracy', () => {
  it('renders an unreported visibility without a unit', () => {
    const blocks = aviationGetMetar.format!({ observations: [sparseMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**Visibility:** not reported');
    expect(text).not.toContain('unknown sm');
  });

  it('still renders a reported visibility with its unit', () => {
    const blocks = aviationGetMetar.format!({ observations: [ksea] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**Visibility:** 10+ sm');
  });

  it('does not claim the default hours returns one observation per station', () => {
    // `hours` is a lookback window, not a row limit. At hours=1 every one of 10
    // live half-hourly stations returned two observations, against one each
    // from 9 hourly-reporting US majors.
    const description = aviationGetMetar.input.shape.hours.description ?? '';

    expect(description).not.toMatch(/only the most recent/i);
    expect(description).toMatch(/lookback|window|every observation/i);
  });

  it('states the empty-cloud fact without instructing the reader', () => {
    const description =
      aviationGetMetar.output.shape.observations.element.shape.clouds.description ?? '';

    expect(description).toMatch(/sky_condition/);
    expect(description).not.toMatch(/\bread\b/i);
  });

  it('describes the bbox mode as one observation per station', () => {
    const description = aviationGetMetar.output.shape.observations.description ?? '';

    expect(description).toMatch(/bbox/);
    expect(description).toMatch(/latest observation/i);
  });

  it('names the four-layer decode limit and raw_metar as the complete source (issue #39)', () => {
    // AWC decodes at most four METAR layers: `KPHX … SCT034 BKN043 BKN060 BKN140
    // BKN250` arrives with four entries and BKN250 gone, with no marker.
    const description =
      aviationGetMetar.output.shape.observations.element.shape.clouds.description ?? '';

    expect(description).toMatch(/four/i);
    expect(description).toContain('raw_metar');
    expect(description).not.toMatch(/\ball reported\b/i);
  });
});

// ---------------------------------------------------------------------------
// bbox area survey (issue #43) — a box draws every observation each station
// made inside the window, so the tool reduces it to the latest per station and
// discloses the cap it read off the draw
// ---------------------------------------------------------------------------

describe('aviationGetMetar bbox survey', () => {
  const bbox = { minLat: 47, minLon: -123, maxLat: 48, maxLon: -122 };

  /** One observation at a station and time, otherwise the KSEA fixture. */
  function observation(station_id: string, observed_at: string): NormalizedMetar {
    return { ...ksea, station_id, name: `${station_id} field`, observed_at };
  }

  /** Run the handler over a bbox draw and return its result. */
  async function survey(drawn: NormalizedMetar[], input: Record<string, unknown> = {}) {
    mockFetchMetar.mockResolvedValue(drawn);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const parsed = aviationGetMetar.input.parse({ bbox, ...input });
    const result = await aviationGetMetar.handler(parsed, ctx);
    return { result, enrichment: getEnrichment(ctx) };
  }

  /** A draw of `rows` observations spread evenly over `stations` stations. */
  function draw(stations: number, rows: number): NormalizedMetar[] {
    return Array.from({ length: rows }, (_, i) =>
      observation(
        `K${String(i % stations).padStart(3, '0')}`,
        `2026-01-15T${String(6 + Math.floor(i / stations)).padStart(2, '0')}:53:00.000Z`,
      ),
    );
  }

  it('sends the box and the lookback window to the service, naming no station', async () => {
    mockFetchMetar.mockResolvedValue([ksea]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ bbox, hours: 3 });
    await aviationGetMetar.handler(input, ctx);

    expect(mockFetchMetar).toHaveBeenCalledWith({ bbox, hours: 3 }, ctx);
  });

  it('returns the latest observation per station, one row each', async () => {
    // Upstream serves every observation inside the window for every station in
    // the box — 52 rows across 9 stations in a live 1°×1° draw at hours=3.
    const { result } = await survey(
      [
        observation('KPLU', '2026-01-15T16:35:00.000Z'),
        observation('KPWT', '2026-01-15T16:35:00.000Z'),
        observation('KPLU', '2026-01-15T16:15:00.000Z'),
        observation('KPWT', '2026-01-15T16:07:00.000Z'),
        observation('KPLU', '2026-01-15T16:00:00.000Z'),
      ],
      { hours: 3 },
    );

    expect(result.observations.map((o) => [o.station_id, o.observed_at])).toEqual([
      ['KPLU', '2026-01-15T16:35:00.000Z'],
      ['KPWT', '2026-01-15T16:35:00.000Z'],
    ]);
  });

  it('keeps the latest reading however the draw was ordered', async () => {
    // Upstream serves newest first today, and the reduction does not lean on it.
    const { result } = await survey([
      observation('KSEA', '2026-01-15T15:00:00.000Z'),
      observation('KSEA', '2026-01-15T17:00:00.000Z'),
      observation('KSEA', '2026-01-15T16:00:00.000Z'),
    ]);

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.observed_at).toBe('2026-01-15T17:00:00.000Z');
  });

  it('orders the result by station ID ascending', async () => {
    const { result } = await survey([
      observation('KTIW', '2026-01-15T16:00:00.000Z'),
      observation('K0S9', '2026-01-15T16:00:00.000Z'),
      observation('KPLU', '2026-01-15T16:00:00.000Z'),
      observation('KBFI', '2026-01-15T16:00:00.000Z'),
    ]);

    expect(result.observations.map((o) => o.station_id)).toEqual(['K0S9', 'KBFI', 'KPLU', 'KTIW']);
  });

  it('returns the same stations on an identical repeated call', async () => {
    const drawn = draw(12, 60);
    const first = await survey(drawn, { limit: 5 });
    const second = await survey(drawn, { limit: 5 });

    expect(second.result.observations.map((o) => o.station_id)).toEqual(
      first.result.observations.map((o) => o.station_id),
    );
  });

  it('discloses an uncapped survey affirmatively and reconciles no request', async () => {
    const { enrichment } = await survey(draw(3, 9));

    expect(enrichment).toEqual({ truncated: false, shown: 3 });
  });

  // -------------------------------------------------------------------------
  // Mode guards
  // -------------------------------------------------------------------------

  it('rejects a call naming neither station_ids nor bbox', async () => {
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({});

    await expect(aviationGetMetar.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'missing_location', recovery: { hint: expect.any(String) } },
    });
    expect(mockFetchMetar).not.toHaveBeenCalled();
  });

  it('rejects a call naming both station_ids and bbox', async () => {
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'], bbox });

    await expect(aviationGetMetar.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'conflicting_location' },
    });
    expect(mockFetchMetar).not.toHaveBeenCalled();
  });

  it.each([
    ['an inverted latitude', { ...bbox, minLat: 49 }],
    ['an inverted longitude', { ...bbox, minLon: -121 }],
    ['both bounds inverted', { minLat: 48, minLon: -122, maxLat: 47, maxLon: -123 }],
  ])('rejects %s before any upstream request', async (_label, inverted) => {
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ bbox: inverted });

    await expect(aviationGetMetar.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_bbox' },
    });
    expect(mockFetchMetar).not.toHaveBeenCalled();
  });

  it('accepts a degenerate zero-area box, which is ordered', async () => {
    mockFetchMetar.mockResolvedValue([ksea]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({
      bbox: { minLat: 47, minLon: -122, maxLat: 47, maxLon: -122 },
    });

    await expect(aviationGetMetar.handler(input, ctx)).resolves.toMatchObject({
      observations: [expect.objectContaining({ station_id: 'KSEA' })],
    });
  });

  it('rejects a limit alongside station_ids, which already names the set', async () => {
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'], limit: 5 });

    await expect(aviationGetMetar.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'conflicting_limit' },
    });
    expect(mockFetchMetar).not.toHaveBeenCalled();
  });

  it('reports a location-mode mistake ahead of a limit mistake', async () => {
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'], bbox, limit: 5 });

    await expect(aviationGetMetar.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_location' },
    });
  });

  it.each([0, 401])('rejects a limit of %i at the schema', (limit) => {
    expect(aviationGetMetar.input.safeParse({ bbox, limit }).success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Empty box
  // -------------------------------------------------------------------------

  it('words an empty box for the mode that produced it', async () => {
    mockFetchMetar.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ bbox, hours: 2 });

    await expect(aviationGetMetar.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('bounding box'),
      data: {
        reason: 'no_stations_found',
        recovery: { hint: expect.stringContaining('Widen the bounding box') },
      },
    });
  });

  it('keeps the station_ids wording on an empty batch', async () => {
    mockFetchMetar.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KZZZ'] });

    await expect(aviationGetMetar.handler(input, ctx)).rejects.toMatchObject({
      message: 'No METAR data found for: KZZZ',
      data: {
        stationIds: ['KZZZ'],
        recovery: { hint: expect.stringContaining('aviation_find_stations') },
      },
    });
  });

  // -------------------------------------------------------------------------
  // limit
  // -------------------------------------------------------------------------

  it('bounds the reduced result and says what it withheld', async () => {
    const { result, enrichment } = await survey(draw(9, 45), { limit: 4 });

    expect(result.observations).toHaveLength(4);
    expect(enrichment).toMatchObject({ truncated: false, shown: 4, limited: true, matched: 9 });
    expect(String(enrichment.notice)).toContain('4 of 9 matching station(s)');
    expect(String(enrichment.notice)).toContain('not the upstream cap');
  });

  it('affirms a limit that had nothing to withhold', async () => {
    const { result, enrichment } = await survey(draw(3, 9), { limit: 10 });

    expect(result.observations).toHaveLength(3);
    expect(enrichment).toMatchObject({ limited: false, shown: 3 });
    expect(enrichment).not.toHaveProperty('matched');
    expect(enrichment).not.toHaveProperty('notice');
  });

  it('treats a limit equal to the station count as not biting', async () => {
    const { enrichment } = await survey(draw(3, 9), { limit: 3 });

    expect(enrichment).toMatchObject({ limited: false, shown: 3 });
  });

  it('emits no limited field for a survey that set no limit', async () => {
    const { enrichment } = await survey(draw(3, 9));

    expect(enrichment).not.toHaveProperty('limited');
    expect(enrichment).not.toHaveProperty('matched');
  });

  it('counts the limit in stations, not in drawn observations', async () => {
    // 30 rows over 5 stations: a limit of 2 returns two stations, never two rows
    // off the front of the draw.
    const { result } = await survey(draw(5, 30), { limit: 2 });

    expect(result.observations).toHaveLength(2);
    expect(new Set(result.observations.map((o) => o.station_id)).size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Upstream row cap
  // -------------------------------------------------------------------------

  it('discloses a capped draw and names hours as the lever', async () => {
    // Live: a WA-sized box at hours=12 caps at 400 rows covering 61 stations.
    const { enrichment } = await survey(draw(61, 400), { hours: 12 });

    expect(enrichment).toMatchObject({
      truncated: true,
      cap: 400,
      shown: 61,
      upstreamRows: 400,
    });
    expect(String(enrichment.notice)).toContain('400 observations');
    expect(String(enrichment.notice)).toContain('only 61 of them');
    expect(String(enrichment.notice)).toMatch(/lower hours/i);
  });

  it('reads the cap off the drawn rows, not off the station count', async () => {
    // 400 rows over 61 stations: a returned count of 61 sits far below the cap
    // and cannot reveal the truncation on its own.
    const { result, enrichment } = await survey(draw(61, 400));

    expect(result.observations).toHaveLength(61);
    expect(enrichment.truncated).toBe(true);
  });

  it('leaves a draw one row short of the cap untruncated', async () => {
    const { enrichment } = await survey(draw(61, 399));

    expect(enrichment).toMatchObject({ truncated: false });
    expect(enrichment).not.toHaveProperty('cap');
    expect(enrichment).not.toHaveProperty('upstreamRows');
  });

  it('composes the cap and the limit as two disclosures in one notice', async () => {
    const { enrichment } = await survey(draw(61, 400), { limit: 10 });

    expect(enrichment).toMatchObject({
      truncated: true,
      cap: 400,
      shown: 10,
      limited: true,
      matched: 61,
      upstreamRows: 400,
    });
    const notice = String(enrichment.notice);
    expect(notice).toContain('its per-request maximum');
    expect(notice).toContain('10 of 61 station(s) inside the capped draw');
    expect(notice).toContain('not the upstream cap');
  });

  it('scopes the matched count to the capped draw rather than to the box', async () => {
    const { enrichment } = await survey(draw(61, 400), { limit: 10 });

    expect(String(enrichment.notice)).toContain('inside the capped draw');
  });

  // -------------------------------------------------------------------------
  // Mode exclusivity and both response surfaces
  // -------------------------------------------------------------------------

  it('reconciles no request on a bbox survey', async () => {
    const { enrichment } = await survey(draw(3, 9));

    for (const key of ['requested', 'returned', 'partial', 'missing']) {
      expect(enrichment).not.toHaveProperty(key);
    }
  });

  it('discloses no survey field on a station_ids batch', async () => {
    mockFetchMetar.mockResolvedValue([ksea]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'] });
    await aviationGetMetar.handler(input, ctx);

    for (const key of ['truncated', 'shown', 'limited', 'matched', 'cap', 'upstreamRows']) {
      expect(getEnrichment(ctx)).not.toHaveProperty(key);
    }
  });

  it('reaches structuredContent and content[] through the real tool pipeline', async () => {
    mockFetchMetar.mockResolvedValue([
      observation('KPWT', '2026-01-15T16:35:00.000Z'),
      observation('KPLU', '2026-01-15T16:35:00.000Z'),
      observation('KPLU', '2026-01-15T16:00:00.000Z'),
    ]);
    const result = await runToolContract(aviationGetMetar, { bbox, hours: 3, limit: 1 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      observations: [expect.objectContaining({ station_id: 'KPLU' })],
      truncated: false,
      shown: 1,
      limited: true,
      matched: 2,
    });

    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('## KPLU — KPLU field');
    expect(text).not.toContain('## KPWT');
    expect(text).toContain('**Stations returned:** 1');
    expect(text).toContain('**Limited by the request:** true');
    expect(text).toContain('**Stations drawn before the limit:** 2');
  });

  it('renders a capped survey on the content[] surface', async () => {
    mockFetchMetar.mockResolvedValue(draw(61, 400));
    const result = await runToolContract(aviationGetMetar, { bbox, hours: 12 });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

    expect(text).toContain('**Truncated at the upstream row cap:** true');
    expect(text).toContain('**Upstream row maximum:** 400');
    expect(text).toContain('400 observations');
  });

  // -------------------------------------------------------------------------
  // What `truncated` claims — the row cap is the only thing it reads. AWC also
  // thins a dense box by station priority, independently of the cap and with no
  // signal in the response, so a draw under the cap is not a complete box.
  // -------------------------------------------------------------------------

  /** The advertised description of the `truncated` enrichment field. */
  function truncatedDescription(): string {
    return aviationGetMetar.enrichment?.truncated?.description ?? '';
  }

  it('reads truncated off the row cap alone', async () => {
    expect((await survey(draw(3, 9))).enrichment).toMatchObject({ truncated: false, shown: 3 });
    expect((await survey(draw(61, 400))).enrichment).toMatchObject({ truncated: true, cap: 400 });
  });

  it('claims only that the draw did not reach the row cap', () => {
    expect(truncatedDescription()).not.toMatch(/drawn in full/i);
    expect(truncatedDescription()).toMatch(/row cap/i);
  });

  it('says a dense box can be thinned without reaching the cap', () => {
    const description = truncatedDescription();

    expect(description).toMatch(/priority/i);
    expect(description).toMatch(/not a completeness claim/i);
  });

  it('keeps the trailer label keyed to the cap', () => {
    expect(aviationGetMetar.enrichmentTrailer?.truncated?.label).toBe(
      'Truncated at the upstream row cap',
    );
  });
});
