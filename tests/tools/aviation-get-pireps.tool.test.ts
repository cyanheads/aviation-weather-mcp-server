/**
 * @fileoverview Tests for the aviation_get_pireps tool.
 * @module tests/tools/aviation-get-pireps.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationGetPireps } from '@/mcp-server/tools/definitions/aviation-get-pireps.tool.js';
import type { NormalizedPirep } from '@/services/aviation-weather/types.js';

// ---------------------------------------------------------------------------
// Service mock
// ---------------------------------------------------------------------------

vi.mock('@/services/aviation-weather/aviation-weather-service.js', () => ({
  getAviationWeatherService: vi.fn(),
}));

import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const mockFetchPireps = vi.fn<
  Parameters<ReturnType<typeof getAviationWeatherService>['fetchPireps']>,
  ReturnType<ReturnType<typeof getAviationWeatherService>['fetchPireps']>
>();

beforeEach(() => {
  vi.mocked(getAviationWeatherService).mockReturnValue({
    fetchPireps: mockFetchPireps,
  } as unknown as ReturnType<typeof getAviationWeatherService>);
  mockFetchPireps.mockReset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** PIREP at FL270 with both turbulence and icing layers. */
const pirep: NormalizedPirep = {
  observed_at: '2026-01-15T18:30:00.000Z',
  lat: 47.5,
  lon: -122.3,
  altitude_ft: 27000,
  aircraft_type: 'B737',
  pirep_type: 'PIREP',
  turbulence: [
    { base_ft: 24000, top_ft: 28000, intensity: 'MOD', type: 'CAT', frequency: 'OCNL' },
    { base_ft: 20000, top_ft: 22000, intensity: 'LGT', type: 'CHOP', frequency: null },
  ],
  icing: [
    { base_ft: 10000, top_ft: 14000, intensity: 'LGT', type: 'RIME' },
    { base_ft: 14000, top_ft: 18000, intensity: 'MOD', type: 'MIXED' },
  ],
  clouds: [{ cover: 'BKN', base_ft: 8000, top_ft: 15000 }],
  visibility_sm: 10,
  remarks: 'LIGHT CHOP BELOW 220',
  raw_pirep:
    'KSEA UA /OV KSEA /TM 1830 /FL270 /TP B737 /TB MOD CAT OCNL 240-280 /IC LGT RIME 100-140',
};

/** Minimal PIREP — most optional fields null/empty. */
const minimalPirep: NormalizedPirep = {
  observed_at: '2026-01-15T17:00:00.000Z',
  lat: 45.0,
  lon: -120.0,
  altitude_ft: 8000,
  aircraft_type: null,
  pirep_type: 'PIREP',
  turbulence: [],
  icing: [],
  clouds: null,
  visibility_sm: null,
  remarks: null,
  raw_pirep: 'KPDX UA /OV KPDX /TM 1700 /FL080 /TP UNKN /SK NEG',
};

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('aviationGetPireps', () => {
  it('returns pireps for a station_id query', async () => {
    mockFetchPireps.mockResolvedValue([pirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA' });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps).toHaveLength(1);
    expect(mockFetchPireps).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'KSEA', distanceNm: 100, hours: 3 }),
      ctx,
    );
  });

  it('returns pireps for a bbox query', async () => {
    mockFetchPireps.mockResolvedValue([pirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      bbox: { minLat: 45.0, minLon: -125.0, maxLat: 49.0, maxLon: -116.0 },
    });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps).toHaveLength(1);
    expect(mockFetchPireps).toHaveBeenCalledWith(
      expect.objectContaining({
        bbox: { minLat: 45.0, minLon: -125.0, maxLat: 49.0, maxLon: -116.0 },
      }),
      ctx,
    );
  });

  it('applies altitude_min_ft client-side filter', async () => {
    // Return one pirep at FL270 and one at FL080
    mockFetchPireps.mockResolvedValue([pirep, minimalPirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      station_id: 'KSEA',
      altitude_min_ft: 20000,
    });
    const result = await aviationGetPireps.handler(input, ctx);

    // Only the FL270 pirep passes the filter
    expect(result.pireps).toHaveLength(1);
    expect(result.pireps[0].altitude_ft).toBe(27000);
  });

  it('applies altitude_max_ft client-side filter', async () => {
    mockFetchPireps.mockResolvedValue([pirep, minimalPirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      station_id: 'KSEA',
      altitude_max_ft: 10000,
    });
    const result = await aviationGetPireps.handler(input, ctx);

    // Only the FL080 pirep passes the filter
    expect(result.pireps).toHaveLength(1);
    expect(result.pireps[0].altitude_ft).toBe(8000);
  });

  it('sorts pireps by observed_at descending', async () => {
    // minimalPirep is earlier (17:00), pirep is later (18:30)
    mockFetchPireps.mockResolvedValue([minimalPirep, pirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA' });
    const result = await aviationGetPireps.handler(input, ctx);

    // Most recent first
    expect(result.pireps[0].observed_at).toBe(pirep.observed_at);
    expect(result.pireps[1].observed_at).toBe(minimalPirep.observed_at);
  });

  it('throws missing_location when neither station_id nor bbox provided', async () => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({});

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_location' },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it('throws no_pireps_found when service returns empty array', async () => {
    mockFetchPireps.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA' });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_pireps_found' },
    });
  });

  it('throws no_pireps_found when altitude filter removes all results', async () => {
    mockFetchPireps.mockResolvedValue([minimalPirep]); // FL080
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      station_id: 'KSEA',
      altitude_min_ft: 30000,
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_pireps_found' },
    });
  });

  it('handles multi-layer turbulence and icing arrays', async () => {
    mockFetchPireps.mockResolvedValue([pirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA' });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps[0].turbulence).toHaveLength(2);
    expect(result.pireps[0].icing).toHaveLength(2);
    expect(result.pireps[0].turbulence[0].intensity).toBe('MOD');
    expect(result.pireps[0].icing[1].intensity).toBe('MOD');
  });
});

// ---------------------------------------------------------------------------
// Format tests
// ---------------------------------------------------------------------------

describe('aviationGetPireps.format', () => {
  it('renders PIREP count, type, and altitude', () => {
    const blocks = aviationGetPireps.format!({ pireps: [pirep] });
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('1 PIREP(s)');
    expect(text).toContain('PIREP');
    expect(text).toContain('27,000');
  });

  it('renders turbulence details', () => {
    const blocks = aviationGetPireps.format!({ pireps: [pirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('MOD');
    expect(text).toContain('CAT');
  });

  it('renders icing details', () => {
    const blocks = aviationGetPireps.format!({ pireps: [pirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('LGT');
    expect(text).toContain('RIME');
  });

  it('renders raw PIREP string', () => {
    const blocks = aviationGetPireps.format!({ pireps: [pirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain(pirep.raw_pirep);
  });

  it('renders minimal PIREP without crashing when optional fields are null', () => {
    const blocks = aviationGetPireps.format!({ pireps: [minimalPirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('PIREP');
    expect(text).toContain(minimalPirep.raw_pirep);
  });
});
