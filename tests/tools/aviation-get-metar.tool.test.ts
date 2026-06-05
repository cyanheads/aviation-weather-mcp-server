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

const mockFetchMetar = vi.fn<
  Parameters<ReturnType<typeof getAviationWeatherService>['fetchMetar']>,
  ReturnType<ReturnType<typeof getAviationWeatherService>['fetchMetar']>
>();

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
  clouds: [{ cover: 'FEW', base_ft: 4500 }],
  temp_c: 8,
  dewpoint_c: 3,
  altimeter_inhg: 30.01,
  raw_metar: 'KSEA 151853Z 18010KT 10SM FEW045 08/03 A3001 RMK AO2',
};

/** Minimal observation with several nullable fields absent (sparse upstream). */
const sparseMetar: NormalizedMetar = {
  station_id: 'KWMC',
  name: 'KWMC',
  lat: 40.5,
  lon: -118.0,
  elevation_ft: 0,
  flight_category: 'unknown',
  metar_type: 'METAR',
  observed_at: '2026-01-15T18:00:00.000Z',
  wind: { direction_deg: null, speed_kt: 0, gust_kt: null },
  visibility_sm: 'unknown',
  ceiling_ft: null,
  clouds: [],
  temp_c: 0,
  dewpoint_c: 0,
  altimeter_inhg: 0,
  raw_metar: 'KWMC 151800Z 00000KT',
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
    const input = aviationGetMetar.input.parse({ station_ids: ['KWMC'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(result.observations[0].ceiling_ft).toBeNull();
    expect(result.observations[0].wind.direction_deg).toBeNull();
    expect(result.observations[0].clouds).toHaveLength(0);
  });

  it('accepts visib as string from upstream (e.g. "10+")', async () => {
    const obs = { ...ksea, visibility_sm: '10+' };
    mockFetchMetar.mockResolvedValue([obs]);
    const ctx = createMockContext({ errors: aviationGetMetar.errors });
    const input = aviationGetMetar.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetMetar.handler(input, ctx);

    expect(typeof result.observations[0].visibility_sm).toBe('string');
    expect(result.observations[0].visibility_sm).toBe('10+');
  });
});

// ---------------------------------------------------------------------------
// Format tests
// ---------------------------------------------------------------------------

describe('aviationGetMetar.format', () => {
  it('renders station ID, flight category, and raw METAR', () => {
    const blocks = aviationGetMetar.format!({ observations: [ksea] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
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
});
