/**
 * @fileoverview Tests for the aviation_get_metar tool.
 * @module tests/tools/aviation-get-metar.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
  present_weather: null,
  temp_c: 0,
  dewpoint_c: 0,
  altimeter_inhg: 30.0,
  raw_metar: 'METAR KMSY 151800Z 00000KT 10SM CLR 00/00 A3000',
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
    expect(mockFetchMetar).toHaveBeenCalledWith(['KSEA'], 1, ctx);
  });

  it('passes hours parameter to the service', async () => {
    mockFetchMetar.mockResolvedValue([ksea, { ...ksea, observed_at: '2026-01-15T17:53:00.000Z' }]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'], hours: 3 });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result.observations).toHaveLength(2);
    expect(mockFetchMetar).toHaveBeenCalledWith(['KSEA'], 3, ctx);
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

  it('renders "Clear" when no clouds', () => {
    const obs: NormalizedMetar = { ...ksea, clouds: [], ceiling_ft: null };
    const blocks = aviationGetMetar.format!({ observations: [obs] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('Clear');
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

  // A content[]-only client never sees structuredContent, so the unknown state
  // has to survive into the rendered text rather than reading as a measurement.
  it('renders an unreported wind speed as unknown, not 0 kt', () => {
    const blocks = aviationGetMetar.format!({ observations: [sparseMetar] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('**Wind:** variable at unknown');
    expect(text).not.toContain('at 0 kt');
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
