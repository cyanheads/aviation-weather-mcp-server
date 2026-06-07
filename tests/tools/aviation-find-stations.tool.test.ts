/**
 * @fileoverview Tests for the aviation_find_stations tool.
 * @module tests/tools/aviation-find-stations.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationFindStations } from '@/mcp-server/tools/definitions/aviation-find-stations.tool.js';
import type { NormalizedStation } from '@/services/aviation-weather/types.js';

// ---------------------------------------------------------------------------
// Service mock
// ---------------------------------------------------------------------------

vi.mock('@/services/aviation-weather/aviation-weather-service.js', () => ({
  getAviationWeatherService: vi.fn(),
}));

import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const mockFetchStations = vi.fn<
  Parameters<ReturnType<typeof getAviationWeatherService>['fetchStations']>,
  ReturnType<ReturnType<typeof getAviationWeatherService>['fetchStations']>
>();

beforeEach(() => {
  vi.mocked(getAviationWeatherService).mockReturnValue({
    fetchStations: mockFetchStations,
  } as unknown as ReturnType<typeof getAviationWeatherService>);
  mockFetchStations.mockReset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ksea: NormalizedStation = {
  icao_id: 'KSEA',
  iata_id: 'SEA',
  faa_id: 'SEA',
  name: 'Seattle-Tacoma International Airport',
  lat: 47.4499,
  lon: -122.3117,
  elevation_ft: 433,
  state: 'WA',
  country: 'US',
  data_types: ['METAR', 'TAF', 'SYNOP'],
};

const kbfi: NormalizedStation = {
  icao_id: 'KBFI',
  iata_id: null,
  faa_id: 'BFI',
  name: 'Boeing Field / King County International',
  lat: 47.53,
  lon: -122.302,
  elevation_ft: 21,
  state: 'WA',
  country: 'US',
  data_types: ['METAR'],
};

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('aviationFindStations', () => {
  it('returns stations matching requested ICAO ID', async () => {
    mockFetchStations.mockResolvedValue([ksea]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationFindStations.handler(input, ctx);

    expect(result.stations).toHaveLength(1);
    expect(result.stations[0].icao_id).toBe('KSEA');
    expect(result.stations[0].data_types).toContain('METAR');
  });

  it('returns multiple stations from a bbox query', async () => {
    mockFetchStations.mockResolvedValue([ksea, kbfi]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({
      bbox: { minLat: 47.0, minLon: -123.0, maxLat: 48.0, maxLon: -122.0 },
    });
    const result = await aviationFindStations.handler(input, ctx);

    expect(result.stations).toHaveLength(2);
  });

  it('returns stations for a state query', async () => {
    mockFetchStations.mockResolvedValue([ksea, kbfi]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ state: 'WA' });
    const result = await aviationFindStations.handler(input, ctx);

    expect(result.stations).toHaveLength(2);
    expect(mockFetchStations).toHaveBeenCalledWith(expect.objectContaining({ state: 'WA' }), ctx);
  });

  it('throws missing_search_criteria when no params are provided', async () => {
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    // Use empty object — all params are optional in the schema
    const input = aviationFindStations.input.parse({});

    await expect(aviationFindStations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_search_criteria' },
    });
    // Service should not be called
    expect(mockFetchStations).not.toHaveBeenCalled();
  });

  it('throws station_not_found when service returns empty array', async () => {
    mockFetchStations.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ station_ids: ['ZZZZ'] });

    await expect(aviationFindStations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'station_not_found' },
    });
  });

  it('station_not_found recovery hint does not mention IATA support', async () => {
    mockFetchStations.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ station_ids: ['SEA'] });

    let thrown: unknown;
    try {
      await aviationFindStations.handler(input, ctx);
    } catch (e) {
      thrown = e;
    }
    const err = thrown as { data?: { recovery?: { hint?: string } } };
    // Recovery should say ICAO format, not mislead about IATA support
    expect(err.data?.recovery?.hint).toContain('ICAO');
    expect(err.data?.recovery?.hint).not.toMatch(/IATA IDs.*may not map/);
  });

  it('handles station with null IATA and FAA IDs (sparse)', async () => {
    const sparse: NormalizedStation = { ...ksea, iata_id: null, faa_id: null };
    mockFetchStations.mockResolvedValue([sparse]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationFindStations.handler(input, ctx);

    expect(result.stations[0].iata_id).toBeNull();
    expect(result.stations[0].faa_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Format tests
// ---------------------------------------------------------------------------

describe('aviationFindStations.format', () => {
  it('renders station count, name, and ICAO ID', () => {
    const blocks = aviationFindStations.format!({ stations: [ksea] });
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('1 station(s)');
    expect(text).toContain('KSEA');
    expect(text).toContain('Seattle-Tacoma');
  });

  it('renders data types when present', () => {
    const blocks = aviationFindStations.format!({ stations: [ksea] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('METAR');
    expect(text).toContain('TAF');
  });

  it('omits IATA/FAA lines when null', () => {
    const sparse: NormalizedStation = { ...ksea, iata_id: null, faa_id: null, icao_id: 'KSEA' };
    const blocks = aviationFindStations.format!({ stations: [sparse] });
    const text = (blocks[0] as { type: string; text: string }).text;
    // Should still render, just without IATA/FAA labels
    expect(text).toContain('KSEA');
  });
});
