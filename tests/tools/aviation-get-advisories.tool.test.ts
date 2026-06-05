/**
 * @fileoverview Tests for the aviation_get_advisories tool.
 * @module tests/tools/aviation-get-advisories.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationGetAdvisories } from '@/mcp-server/tools/definitions/aviation-get-advisories.tool.js';
import type { NormalizedAdvisory } from '@/services/aviation-weather/types.js';

// ---------------------------------------------------------------------------
// Service mock
// ---------------------------------------------------------------------------

vi.mock('@/services/aviation-weather/aviation-weather-service.js', () => ({
  getAviationWeatherService: vi.fn(),
}));

import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const mockFetchAdvisories = vi.fn<
  Parameters<ReturnType<typeof getAviationWeatherService>['fetchAdvisories']>,
  ReturnType<ReturnType<typeof getAviationWeatherService>['fetchAdvisories']>
>();

beforeEach(() => {
  vi.mocked(getAviationWeatherService).mockReturnValue({
    fetchAdvisories: mockFetchAdvisories,
  } as unknown as ReturnType<typeof getAviationWeatherService>);
  mockFetchAdvisories.mockReset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sigmet: NormalizedAdvisory = {
  advisory_type: 'SIGMET',
  series_id: 'BOSW0',
  hazard: 'CONVECTIVE',
  severity: 3,
  issued_by: 'KKCI',
  valid_from: '2026-01-15T18:00:00.000Z',
  valid_to: '2026-01-15T22:00:00.000Z',
  altitude_low_ft: 5000,
  altitude_high_ft: 25000,
  movement: { direction_deg: 270, speed_kt: 20 },
  polygon: [
    { lat: 42.0, lon: -90.0 },
    { lat: 44.0, lon: -90.0 },
    { lat: 44.0, lon: -87.0 },
    { lat: 42.0, lon: -87.0 },
  ],
  raw_text: 'KKCI SIGW 151800 CONVECTIVE SIGMET BOSW0',
};

const airmet: NormalizedAdvisory = {
  advisory_type: 'AIRMET',
  series_id: 'SFOsierra0',
  hazard: 'IFR',
  severity: null,
  issued_by: 'KSFO',
  valid_from: '2026-01-15T16:00:00.000Z',
  valid_to: '2026-01-15T22:00:00.000Z',
  altitude_low_ft: null,
  altitude_high_ft: null,
  movement: null,
  polygon: [
    { lat: 37.0, lon: -122.0 },
    { lat: 38.0, lon: -122.0 },
    { lat: 38.0, lon: -120.0 },
  ],
  raw_text: 'KSFO SIERRA0 IFR CONDS',
};

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('aviationGetAdvisories', () => {
  it('returns advisories for default "all" type', async () => {
    mockFetchAdvisories.mockResolvedValue([sigmet, airmet]);
    const ctx = createMockContext();
    const input = aviationGetAdvisories.input.parse({});
    const result = await aviationGetAdvisories.handler(input, ctx);

    expect(result.advisories).toHaveLength(2);
    expect(mockFetchAdvisories).toHaveBeenCalledWith(
      expect.objectContaining({ advisoryType: 'all' }),
      ctx,
    );
  });

  it('passes advisory_type filter to the service', async () => {
    mockFetchAdvisories.mockResolvedValue([sigmet]);
    const ctx = createMockContext();
    const input = aviationGetAdvisories.input.parse({ advisory_type: 'sigmet' });
    const result = await aviationGetAdvisories.handler(input, ctx);

    expect(result.advisories).toHaveLength(1);
    expect(mockFetchAdvisories).toHaveBeenCalledWith(
      expect.objectContaining({ advisoryType: 'sigmet' }),
      ctx,
    );
  });

  it('passes hazard filter to the service', async () => {
    mockFetchAdvisories.mockResolvedValue([sigmet]);
    const ctx = createMockContext();
    const input = aviationGetAdvisories.input.parse({ hazard: 'CONVECTIVE' });
    await aviationGetAdvisories.handler(input, ctx);

    expect(mockFetchAdvisories).toHaveBeenCalledWith(
      expect.objectContaining({ hazard: 'CONVECTIVE' }),
      ctx,
    );
  });

  it('passes bbox filter to the service', async () => {
    mockFetchAdvisories.mockResolvedValue([airmet]);
    const ctx = createMockContext();
    const input = aviationGetAdvisories.input.parse({
      bbox: { minLat: 36.0, minLon: -123.0, maxLat: 39.0, maxLon: -119.0 },
    });
    await aviationGetAdvisories.handler(input, ctx);

    expect(mockFetchAdvisories).toHaveBeenCalledWith(
      expect.objectContaining({
        bbox: { minLat: 36.0, minLon: -123.0, maxLat: 39.0, maxLon: -119.0 },
      }),
      ctx,
    );
  });

  it('returns empty advisories array when no advisories are active', async () => {
    mockFetchAdvisories.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = aviationGetAdvisories.input.parse({});
    const result = await aviationGetAdvisories.handler(input, ctx);

    expect(result.advisories).toHaveLength(0);
  });

  it('handles advisory with null altitude and movement (sparse)', async () => {
    mockFetchAdvisories.mockResolvedValue([airmet]);
    const ctx = createMockContext();
    const input = aviationGetAdvisories.input.parse({ advisory_type: 'airmet' });
    const result = await aviationGetAdvisories.handler(input, ctx);

    expect(result.advisories[0].altitude_low_ft).toBeNull();
    expect(result.advisories[0].altitude_high_ft).toBeNull();
    expect(result.advisories[0].movement).toBeNull();
    expect(result.advisories[0].severity).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Format tests
// ---------------------------------------------------------------------------

describe('aviationGetAdvisories.format', () => {
  it('renders advisory count, type, and series_id', () => {
    const blocks = aviationGetAdvisories.format!({ advisories: [sigmet] });
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('1 active advisory');
    expect(text).toContain('SIGMET');
    expect(text).toContain('BOSW0');
  });

  it('renders hazard type', () => {
    const blocks = aviationGetAdvisories.format!({ advisories: [sigmet] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('CONVECTIVE');
  });

  it('renders severity when present', () => {
    const blocks = aviationGetAdvisories.format!({ advisories: [sigmet] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('3');
  });

  it('renders raw text', () => {
    const blocks = aviationGetAdvisories.format!({ advisories: [airmet] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain(airmet.raw_text);
  });

  it('renders valid period', () => {
    const blocks = aviationGetAdvisories.format!({ advisories: [sigmet] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain(sigmet.valid_from);
    expect(text).toContain(sigmet.valid_to);
  });
});
