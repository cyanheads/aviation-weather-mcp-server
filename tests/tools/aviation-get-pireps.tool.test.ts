/**
 * @fileoverview Tests for the aviation_get_pireps tool.
 * @module tests/tools/aviation-get-pireps.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationGetPireps } from '@/mcp-server/tools/definitions/aviation-get-pireps.tool.js';
import { AWC_MAX_ROWS } from '@/services/aviation-weather/awc-limits.js';
import type { NormalizedPirep } from '@/services/aviation-weather/types.js';

// ---------------------------------------------------------------------------
// Service mock
// ---------------------------------------------------------------------------

vi.mock('@/services/aviation-weather/aviation-weather-service.js', () => ({
  getAviationWeatherService: vi.fn(),
}));

import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const mockFetchPireps = vi.fn<ReturnType<typeof getAviationWeatherService>['fetchPireps']>();

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
  temp_c: null,
  wind: null,
  weather: null,
  raw_pirep:
    'KSEA UA /OV KSEA /TM 1830 /FL270 /TP B737 /TB MOD CAT OCNL 240-280 /IC LGT RIME 100-140',
};

/**
 * A report carrying all three decoded groups — `/WX +RA`, `/TA 06`, and
 * `/WV 19003KT` — beside `/RM` text AWC does not decode. Modeled on a live
 * report whose weather the tool used to publish as `remarks`.
 */
const aloftPirep: NormalizedPirep = {
  observed_at: '2026-01-15T15:12:00.000Z',
  lat: 35.1,
  lon: -113.8,
  altitude_ft: 10000,
  aircraft_type: 'S22T',
  pirep_type: 'PIREP',
  turbulence: [{ base_ft: null, top_ft: null, intensity: 'NEG', type: null, frequency: null }],
  icing: [],
  clouds: null,
  visibility_sm: null,
  temp_c: 6,
  wind: { direction_deg: 190, speed_kt: 3 },
  weather: { raw: '+RA', decoded: 'heavy rain' },
  raw_pirep: 'GXF UA /OV GBN/TM 1512/FL100/TP S22T/WX +RA/TA 06/WV 19003KT/TB NEG/RM ZAB/FDCS',
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
  temp_c: null,
  wind: null,
  weather: null,
  raw_pirep: 'KPDX UA /OV KPDX /TM 1700 /FL080 /TP UNKN /SK NEG',
};

/**
 * A report encoded `/FLDURD/` — the pilot gave no flight level, so the altitude
 * is unknown rather than ground level. The OVC024 layer has a base and no top.
 */
const unknownAltitudePirep: NormalizedPirep = {
  observed_at: '2026-01-15T16:00:00.000Z',
  lat: 41.0,
  lon: -81.4,
  altitude_ft: null,
  aircraft_type: 'C208',
  pirep_type: 'PIREP',
  turbulence: [],
  icing: [],
  clouds: [{ cover: 'OVC', base_ft: 2400, top_ft: null }],
  visibility_sm: null,
  temp_c: null,
  wind: null,
  weather: null,
  raw_pirep: 'CAK UA /OV CAK/TM 0745/FLDURD/TP C208/SK OVC024',
};

/** A `SK CLR` report — the cover is the whole message; there is no layer to bound. */
const clearSkyPirep: NormalizedPirep = {
  observed_at: '2026-01-15T15:00:00.000Z',
  lat: 41.9,
  lon: -87.9,
  altitude_ft: 11000,
  aircraft_type: 'B753',
  pirep_type: 'PIREP',
  turbulence: [{ base_ft: null, top_ft: null, intensity: 'NEG', type: null, frequency: null }],
  icing: [],
  clouds: [{ cover: 'CLR', base_ft: null, top_ft: null }],
  visibility_sm: null,
  temp_c: null,
  wind: null,
  weather: null,
  raw_pirep: 'ORD UA /OV JOT290013/TM 0925/FL110/TP B753/SK CLR/TB NEG',
};

/** A reported `/FL000/` — a flight level of zero, not a missing altitude. */
const groundLevelPirep: NormalizedPirep = {
  observed_at: '2026-01-15T14:00:00.000Z',
  lat: 38.0,
  lon: -87.5,
  altitude_ft: 0,
  aircraft_type: 'E145',
  pirep_type: 'PIREP',
  turbulence: [{ base_ft: null, top_ft: null, intensity: 'NEG', type: null, frequency: null }],
  icing: [],
  clouds: null,
  visibility_sm: null,
  temp_c: null,
  wind: null,
  weather: null,
  raw_pirep: 'EVV UA /OV EVV/TM 0125/FL000/TP E145/TB NEG/RM DURD RY22 EVV',
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
    expect(result.pireps[0]!.altitude_ft).toBe(27000);
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
    expect(result.pireps[0]!.altitude_ft).toBe(8000);
  });

  it('sorts pireps by observed_at descending', async () => {
    // minimalPirep is earlier (17:00), pirep is later (18:30)
    mockFetchPireps.mockResolvedValue([minimalPirep, pirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA' });
    const result = await aviationGetPireps.handler(input, ctx);

    // Most recent first
    expect(result.pireps[0]!.observed_at).toBe(pirep.observed_at);
    expect(result.pireps[1]!.observed_at).toBe(minimalPirep.observed_at);
  });

  it('throws missing_location when neither station_id nor bbox provided', async () => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({});

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_location' },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it('throws conflicting_location when both station_id and bbox are provided', async () => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      station_id: 'KSEA',
      bbox: { minLat: 25, minLon: -125, maxLat: 49, maxLon: -66 },
      distance_nm: 250,
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_location' },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it('throws invalid_bbox when the bounding box is inverted', async () => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      bbox: { minLat: 49, minLon: -66, maxLat: 25, maxLon: -125 },
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_bbox' },
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

  it('includes altitude filter context in error when filter empties results', async () => {
    mockFetchPireps.mockResolvedValue([minimalPirep]); // FL080
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      station_id: 'KSEA',
      altitude_min_ft: 30000,
    });

    let thrown: unknown;
    try {
      await aviationGetPireps.handler(input, ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const err = thrown as { message: string; data?: { recovery?: { hint?: string } } };
    // Message should mention the altitude filter, not just "no PIREPs found"
    expect(err.message).toContain('altitude filter');
    // Recovery hint should guide the caller to adjust altitude params
    expect(err.data?.recovery?.hint).toContain('altitude_min_ft');
  });

  it('uses generic recovery hint when no altitude filter was applied', async () => {
    mockFetchPireps.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA' });

    let thrown: unknown;
    try {
      await aviationGetPireps.handler(input, ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const err = thrown as { message: string; data?: { recovery?: { hint?: string } } };
    // Message should be the generic "no PIREPs found" text
    expect(err.message).toContain('No PIREPs found in the search area');
    // Recovery should mention distance/hours, not altitude
    expect(err.data?.recovery?.hint).toContain('distance_nm');
  });

  it('handles multi-layer turbulence and icing arrays', async () => {
    mockFetchPireps.mockResolvedValue([pirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA' });
    const result = await aviationGetPireps.handler(input, ctx);

    const report = result.pireps[0]!;
    expect(report.turbulence).toHaveLength(2);
    expect(report.icing).toHaveLength(2);
    expect(report.turbulence[0]!.intensity).toBe('MOD');
    expect(report.icing[1]!.intensity).toBe('MOD');
  });
});

// ---------------------------------------------------------------------------
// distance_nm scope (issue #19) — the radius only means something relative to
// a station_id center point; a bbox search has nothing to measure from
// ---------------------------------------------------------------------------

describe('aviationGetPireps distance_nm scope', () => {
  it('throws conflicting_distance when distance_nm accompanies bbox', async () => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      bbox: { minLat: 45.0, minLon: -125.0, maxLat: 49.0, maxLon: -116.0 },
      distance_nm: 250,
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'conflicting_distance' },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it('throws conflicting_distance for an explicit distance_nm of 100 with bbox', async () => {
    // 100 is the radius a station_id search falls back to. Passing it
    // explicitly alongside bbox must still be refused, so the guard cannot be
    // keyed on the value.
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      bbox: { minLat: 45.0, minLon: -125.0, maxLat: 49.0, maxLon: -116.0 },
      distance_nm: 100,
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_distance' },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it('conflicting_distance recovery points at both ways out', async () => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      bbox: { minLat: 45.0, minLon: -125.0, maxLat: 49.0, maxLon: -116.0 },
      distance_nm: 250,
    });

    let thrown: unknown;
    try {
      await aviationGetPireps.handler(input, ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const err = thrown as { data?: { recovery?: { hint?: string } } };
    expect(err.data?.recovery?.hint).toContain('distance_nm');
    expect(err.data?.recovery?.hint).toContain('station_id');
  });

  it('throws invalid_bbox ahead of conflicting_distance for an inverted bbox', async () => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      bbox: { minLat: 49, minLon: -66, maxLat: 25, maxLon: -125 },
      distance_nm: 250,
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_bbox' },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it('omits distanceNm from the service call for a bbox query', async () => {
    mockFetchPireps.mockResolvedValue([pirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      bbox: { minLat: 45.0, minLon: -125.0, maxLat: 49.0, maxLon: -116.0 },
    });
    await aviationGetPireps.handler(input, ctx);

    expect(mockFetchPireps.mock.calls[0]![0]).not.toHaveProperty('distanceNm');
  });

  it('centers a radial search on a digit-bearing identifier (issue #37)', async () => {
    mockFetchPireps.mockResolvedValue([pirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'K0S9', distance_nm: 50 });
    await aviationGetPireps.handler(input, ctx);

    expect(mockFetchPireps).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'K0S9', distanceNm: 50 }),
      ctx,
    );
  });

  it('forwards an explicit distance_nm for a station_id query', async () => {
    mockFetchPireps.mockResolvedValue([pirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA', distance_nm: 250 });
    await aviationGetPireps.handler(input, ctx);

    expect(mockFetchPireps).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'KSEA', distanceNm: 250 }),
      ctx,
    );
  });
});

// ---------------------------------------------------------------------------
// Altitude range ordering (issue #19)
// ---------------------------------------------------------------------------

describe('aviationGetPireps altitude range', () => {
  it('throws invalid_altitude_range when the bounds are inverted', async () => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      station_id: 'KSEA',
      altitude_min_ft: 30000,
      altitude_max_ft: 10000,
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_altitude_range' },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it('throws invalid_altitude_range in bbox mode too', async () => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      bbox: { minLat: 45.0, minLon: -125.0, maxLat: 49.0, maxLon: -116.0 },
      altitude_min_ft: 30000,
      altitude_max_ft: 10000,
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_altitude_range' },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it('accepts equal bounds as a valid degenerate range', async () => {
    mockFetchPireps.mockResolvedValue([pirep, minimalPirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      station_id: 'KSEA',
      altitude_min_ft: 27000,
      altitude_max_ft: 27000,
    });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps).toHaveLength(1);
    expect(result.pireps[0]!.altitude_ft).toBe(27000);
  });

  it('accepts a correctly-ordered range', async () => {
    mockFetchPireps.mockResolvedValue([pirep, minimalPirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      station_id: 'KSEA',
      altitude_min_ft: 5000,
      altitude_max_ft: 10000,
    });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps).toHaveLength(1);
    expect(result.pireps[0]!.altitude_ft).toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// Altitude bounds — the band is feet MSL and both ends are schema bounds, so a
// band AWC will not search never reaches the request. Below sea level and far
// above FL600 both derive a `level` centre the endpoint answers with HTTP 400
// `Invalid value for level`.
// ---------------------------------------------------------------------------

describe('aviationGetPireps altitude bounds', () => {
  it.each(['altitude_min_ft', 'altitude_max_ft'] as const)('accepts a %s of 0', (field) => {
    expect(aviationGetPireps.input.safeParse({ station_id: 'KSEA', [field]: 0 }).success).toBe(
      true,
    );
  });

  it('accepts a band resting on sea level', () => {
    expect(
      aviationGetPireps.input.safeParse({
        station_id: 'KSEA',
        altitude_min_ft: 0,
        altitude_max_ft: 3000,
      }).success,
    ).toBe(true);
  });

  it.each(['altitude_min_ft', 'altitude_max_ft'] as const)(
    'accepts a %s at the FL600 ceiling',
    (field) => {
      expect(
        aviationGetPireps.input.safeParse({ station_id: 'KSEA', [field]: 60000 }).success,
      ).toBe(true);
    },
  );

  it('accepts a band resting on the ceiling', () => {
    expect(
      aviationGetPireps.input.safeParse({
        station_id: 'KSEA',
        altitude_min_ft: 57000,
        altitude_max_ft: 60000,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a lower bound one foot below sea level', { altitude_min_ft: -1 }],
    ['an upper bound one foot below sea level', { altitude_max_ft: -1 }],
    ['a band wholly below sea level', { altitude_min_ft: -6000, altitude_max_ft: -3000 }],
    ['a band reaching up to sea level', { altitude_min_ft: -3000, altitude_max_ft: 0 }],
    ['a lower bound one foot above the ceiling', { altitude_min_ft: 60001 }],
    ['an upper bound one foot above the ceiling', { altitude_max_ft: 60001 }],
    [
      'a band centred far above any pilot report',
      { altitude_min_ft: 9997000, altitude_max_ft: 10003000 },
    ],
  ])('rejects %s at the schema', (_label, bounds) => {
    expect(aviationGetPireps.input.safeParse({ station_id: 'KSEA', ...bounds }).success).toBe(
      false,
    );
  });

  it('names the offending bound rather than the range guard', () => {
    const result = aviationGetPireps.input.safeParse({
      station_id: 'KSEA',
      altitude_min_ft: -3000,
      altitude_max_ft: 0,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['altitude_min_ft']);
  });

  it.each(['altitude_min_ft', 'altitude_max_ft'] as const)(
    'states both bounds in the %s description',
    (field) => {
      const description = aviationGetPireps.input.shape[field].description ?? '';

      expect(description).toMatch(/0 ft|sea level/);
      expect(description).toMatch(/60000|FL600/);
    },
  );

  it('leaves an inverted band inside the bounds to the handler guard', async () => {
    // The two ends are schema bounds; their ordering is not. A band inverted at
    // the extremes of what the schema admits still earns the declared reason,
    // with its recovery, rather than a bare framework rejection.
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      station_id: 'KSEA',
      altitude_min_ft: 60000,
      altitude_max_ft: 0,
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_altitude_range' },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it.each([
    ['a negative band', { altitude_min_ft: -3000, altitude_max_ft: 0 }],
    ['a band above the ceiling', { altitude_min_ft: 9997000, altitude_max_ft: 10003000 }],
  ])('rejects %s on both surfaces before any request goes out', async (_label, bounds) => {
    const result = await runToolContract(aviationGetPireps, { station_id: 'KSEA', ...bounds });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('altitude_min_ft');
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Upstream narrowing (issue #32) — the altitude band is pushed to AWC as a
// `level` centre when it fits the fixed ±3,000 ft width, and min_intensity is
// forwarded as `inten`; both run before the row cap
// ---------------------------------------------------------------------------

describe('aviationGetPireps upstream narrowing', () => {
  const bbox = { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 };

  /**
   * Run the handler and return the params object handed to the service. The
   * assertions here are about the request that went out, so an altitude band
   * the fixture report falls outside of is not a failure — the empty-result
   * error is raised after the call these tests read.
   */
  async function paramsFor(input: Record<string, unknown>) {
    mockFetchPireps.mockResolvedValue([pirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    try {
      await aviationGetPireps.handler(aviationGetPireps.input.parse(input), ctx);
    } catch {
      // Intentionally ignored — see above.
    }
    return mockFetchPireps.mock.calls[0]![0];
  }

  it('sends the band centre as a flight level, not feet', async () => {
    const params = await paramsFor({
      bbox,
      altitude_min_ft: 18000,
      altitude_max_ft: 20000,
    });
    expect(params).toMatchObject({ level: 190 });
  });

  it.each([
    ['a band exactly at the upstream width', 16000, 22000, 190],
    ['a degenerate band of equal bounds', 27000, 27000, 270],
    ['a band centred on the surface', 0, 3000, 15],
    ['a band whose centre needs rounding', 18000, 20100, 191],
  ])('pushes %s', async (_label, altitude_min_ft, altitude_max_ft, level) => {
    expect(await paramsFor({ bbox, altitude_min_ft, altitude_max_ft })).toMatchObject({ level });
  });

  it.each([
    ['a band wider than the upstream width', { altitude_min_ft: 10000, altitude_max_ft: 30000 }],
    ['a lower bound alone', { altitude_min_ft: 18000 }],
    ['an upper bound alone', { altitude_max_ft: 20000 }],
    ['no altitude bound at all', {}],
  ])('sends no level for %s', async (_label, bounds) => {
    expect(await paramsFor({ bbox, ...bounds })).not.toHaveProperty('level');
  });

  it.each([
    ['a near-full-width band with a half-flight-level centre', 17950, 23950],
    ['the same shape lower down', 4950, 10950],
  ])('sends no level for %s, whose rounded band would miss a sliver', async (_l, min, max) => {
    // Rounding the centre to a whole flight level shifts the band by up to
    // 50 ft. A centre of FL210 for 17,950–23,950 ft draws FL180–240 and leaves
    // the bottom 50 ft undrawn, so reports there would vanish rather than be
    // trimmed. Only a centre whose band contains the whole request is sent.
    expect(
      await paramsFor({ bbox, altitude_min_ft: min, altitude_max_ft: max }),
    ).not.toHaveProperty('level');
  });

  it('forwards min_intensity as the upstream intensity value', async () => {
    expect(await paramsFor({ bbox, min_intensity: 'mod' })).toMatchObject({
      minIntensity: 'mod',
    });
  });

  it('sends no intensity when min_intensity is omitted', async () => {
    expect(await paramsFor({ bbox })).not.toHaveProperty('minIntensity');
  });

  it('pushes both levers in the radial mode as well', async () => {
    expect(
      await paramsFor({
        station_id: 'KDEN',
        distance_nm: 200,
        altitude_min_ft: 18000,
        altitude_max_ft: 20000,
        min_intensity: 'sev',
      }),
    ).toMatchObject({ stationId: 'KDEN', distanceNm: 200, level: 190, minIntensity: 'sev' });
  });

  it('computes no level from an inverted range — the guard fires first', async () => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      bbox,
      altitude_min_ft: 20000,
      altitude_max_ft: 18000,
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_altitude_range' },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it.each([
    ['missing_location', {}],
    ['conflicting_location', { station_id: 'KSEA', bbox }],
    ['conflicting_distance', { bbox, distance_nm: 150 }],
  ])('keeps %s ahead of any filter work', async (reason, input) => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const parsed = aviationGetPireps.input.parse({
      ...input,
      altitude_min_ft: 18000,
      altitude_max_ft: 20000,
      min_intensity: 'mod',
    });

    await expect(aviationGetPireps.handler(parsed, ctx)).rejects.toMatchObject({
      data: { reason },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it('still applies the client-side altitude filter after the upstream band', async () => {
    // The ±3,000 ft band admits FL160–220 for level=190; a report at 21,000 ft
    // survives upstream and must still be trimmed to the requested 18–20k range.
    const inBand = { ...pirep, altitude_ft: 21000 };
    mockFetchPireps.mockResolvedValue([pirep, inBand, unknownAltitudePirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      bbox,
      altitude_min_ft: 18000,
      altitude_max_ft: 20000,
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_pireps_found' },
    });
  });

  it('still drops a null-altitude report the upstream band admitted', async () => {
    // `level` admits reports whose flight level did not parse; the client-side
    // filter is what keeps them out of a bounded result.
    mockFetchPireps.mockResolvedValue([{ ...pirep, altitude_ft: 19000 }, unknownAltitudePirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      bbox,
      altitude_min_ft: 18000,
      altitude_max_ft: 20000,
    });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps).toHaveLength(1);
    expect(result.pireps[0]!.altitude_ft).toBe(19000);
  });

  it('describes min_intensity as selecting reports rather than layers', () => {
    const description = aviationGetPireps.input.shape.min_intensity.description ?? '';
    expect(description).toMatch(/report/i);
    expect(description).toMatch(/lighter layers/i);
  });

  it('names min_intensity in the tool description', () => {
    expect(aviationGetPireps.description).toContain('min_intensity');
  });
});

// ---------------------------------------------------------------------------
// Unknown altitude (issue #15) — an unreported flight level is not ground
// level, and it cannot satisfy either altitude bound
// ---------------------------------------------------------------------------

describe('aviationGetPireps unknown altitude', () => {
  it('returns an unreported altitude as null', async () => {
    mockFetchPireps.mockResolvedValue([unknownAltitudePirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KCAK' });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps[0]!.altitude_ft).toBeNull();
  });

  it('returns a reported /FL000/ as 0', async () => {
    mockFetchPireps.mockResolvedValue([groundLevelPirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KEVV' });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps[0]!.altitude_ft).toBe(0);
  });

  it('keeps unknown-altitude reports when no altitude bound is set', async () => {
    mockFetchPireps.mockResolvedValue([pirep, unknownAltitudePirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA' });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps).toHaveLength(2);
  });

  it('drops unknown-altitude reports under altitude_min_ft', async () => {
    mockFetchPireps.mockResolvedValue([pirep, unknownAltitudePirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA', altitude_min_ft: 1000 });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps).toHaveLength(1);
    expect(result.pireps[0]!.altitude_ft).toBe(27000);
  });

  it('drops unknown-altitude reports under altitude_max_ft too', async () => {
    // The zero sentinel used to make altitude_max_ft silently keep these while
    // altitude_min_ft silently discarded them. Both bounds now agree.
    mockFetchPireps.mockResolvedValue([minimalPirep, unknownAltitudePirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA', altitude_max_ft: 40000 });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps).toHaveLength(1);
    expect(result.pireps[0]!.altitude_ft).toBe(8000);
  });

  it('keeps a reported /FL000/ under an altitude_max_ft bound', async () => {
    mockFetchPireps.mockResolvedValue([groundLevelPirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KEVV', altitude_max_ft: 5000 });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result.pireps[0]!.altitude_ft).toBe(0);
  });

  it('reports unreported altitudes in the empty-result recovery hint', async () => {
    mockFetchPireps.mockResolvedValue([unknownAltitudePirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA', altitude_min_ft: 1000 });

    let thrown: unknown;
    try {
      await aviationGetPireps.handler(input, ctx);
    } catch (e) {
      thrown = e;
    }
    const err = thrown as { message: string; data?: { recovery?: { hint?: string } } };
    expect(err.message).toContain('other or unreported altitudes');
    expect(err.data?.recovery?.hint).toContain('other or unreported altitudes');
  });

  it('accepts null and zero altitudes against the declared output schema', async () => {
    mockFetchPireps.mockResolvedValue([unknownAltitudePirep, groundLevelPirep, clearSkyPirep]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA' });
    const result = await aviationGetPireps.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(aviationGetPireps.output));
  });

  it('documents how each altitude bound treats an unknown altitude', () => {
    const input = aviationGetPireps.input.shape;
    expect(input.altitude_min_ft.description).toMatch(/altitude_ft null/);
    expect(input.altitude_max_ft.description).toMatch(/altitude_ft null/);
  });
});

// ---------------------------------------------------------------------------
// Output-schema language (issues #24 and #13)
// ---------------------------------------------------------------------------

describe('aviationGetPireps output schema language', () => {
  const report = aviationGetPireps.output.shape.pireps.element.shape;
  const cloudLayer = report.clouds.unwrap().element.shape;

  it.each(['turbulence', 'icing'] as const)(
    'does not read an empty %s array as a negative report',
    (field) => {
      // A PIREP that explicitly reports nothing populates the array with a NEG
      // layer; an empty array means the group was absent from the report.
      const description = report[field].description ?? '';
      expect(description).toContain('NEG');
      expect(description).not.toMatch(/Empty array if no \w+ encountered/);
    },
  );

  it('names the cover codes the field actually emits', () => {
    const description = cloudLayer.cover.description ?? '';
    for (const code of ['FEW', 'SCT', 'BKN', 'OVC', 'SKC', 'CLR', 'VMC', 'IMC']) {
      expect(description).toContain(code);
    }
  });

  it('flags that some cover values are not cloud layers', () => {
    expect(cloudLayer.cover.description).toMatch(/rather than a cloud layer/);
  });

  it('says a sky-clear cover never carries bounds', () => {
    // AWC attaches synthesized bounds to SKC; normalization drops them (#52).
    expect(cloudLayer.cover.description).toMatch(/SKC and CLR .*never carry a base or top/);
  });

  it('describes the unknown altitude by the rule rather than by an example token', () => {
    // The three-token list read as exhaustive; the field goes null for any
    // group AWC could not resolve, whatever it happens to spell.
    const description = report.altitude_ft.description ?? '';
    expect(description).not.toMatch(/\/FLUNKN\/, \/FLDURC\/, or \/FLDURD\//);
    expect(description).toMatch(/\/FL000\//);
  });

  it('says an icing layer reflects a reported group rather than an upstream default', () => {
    expect(report.icing.description ?? '').toMatch(/raw report/i);
  });

  it.each(['altitude_ft', 'turbulence', 'icing', 'clouds'] as const)(
    'keeps PIREP heights on the %s branch in feet MSL',
    (field) => {
      // Pilots read altitude off the altimeter, so PIREP heights are MSL —
      // unlike the aerodrome cloud heights on METAR and TAF.
      const descriptions =
        field === 'altitude_ft'
          ? [report.altitude_ft.description]
          : field === 'clouds'
            ? [cloudLayer.base_ft.description, cloudLayer.top_ft.description]
            : [
                report[field].element.shape.base_ft.description,
                report[field].element.shape.top_ft.description,
              ];

      for (const description of descriptions) {
        expect(description).toContain('MSL');
        expect(description).not.toContain('AGL');
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Input schema surface
// ---------------------------------------------------------------------------

describe('aviationGetPireps.input', () => {
  it('leaves distance_nm undefined when omitted', () => {
    // The handler needs to tell "omitted" from an explicit value, so the
    // schema must not stamp a default over the difference.
    expect(aviationGetPireps.input.parse({ station_id: 'KSEA' }).distance_nm).toBeUndefined();
  });

  it('keeps the 10–500 nm distance_nm bounds', () => {
    expect(aviationGetPireps.input.parse({ station_id: 'KSEA', distance_nm: 10 }).distance_nm).toBe(
      10,
    );
    expect(
      aviationGetPireps.input.parse({ station_id: 'KSEA', distance_nm: 500 }).distance_nm,
    ).toBe(500);
    expect(() => aviationGetPireps.input.parse({ station_id: 'KSEA', distance_nm: 9 })).toThrow();
    expect(() => aviationGetPireps.input.parse({ station_id: 'KSEA', distance_nm: 501 })).toThrow();
  });

  it('keeps the hours default at 3 and its 1–12 bounds', () => {
    expect(aviationGetPireps.input.parse({ station_id: 'KSEA' }).hours).toBe(3);
    expect(aviationGetPireps.input.parse({ station_id: 'KSEA', hours: 1 }).hours).toBe(1);
    expect(aviationGetPireps.input.parse({ station_id: 'KSEA', hours: 12 }).hours).toBe(12);
    expect(() => aviationGetPireps.input.parse({ station_id: 'KSEA', hours: 0 })).toThrow();
    expect(() => aviationGetPireps.input.parse({ station_id: 'KSEA', hours: 13 })).toThrow();
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

  it('renders cloud layers with a base and top as a range', () => {
    const blocks = aviationGetPireps.format!({ pireps: [pirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('BKN 8,000–15,000 ft');
  });

  // A content[]-only client sees nothing but this text, so an unknown value has
  // to read as unknown rather than as a measurement of zero.
  it('renders an unreported altitude as unknown, not 0 ft', () => {
    const blocks = aviationGetPireps.format!({ pireps: [unknownAltitudePirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('**Altitude:** unknown');
    expect(text).not.toContain('**Altitude:** 0 ft');
  });

  it('renders a reported /FL000/ altitude as 0 ft', () => {
    const blocks = aviationGetPireps.format!({ pireps: [groundLevelPirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('**Altitude:** 0 ft');
    expect(text).not.toContain('unknown');
  });

  it('names the unknown top of a layer that reported only a base', () => {
    const blocks = aviationGetPireps.format!({ pireps: [unknownAltitudePirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('OVC 2,400 ft base, top unknown');
    expect(text).not.toContain('–0 ft');
  });

  it('names the unknown base of a layer that reported only a top', () => {
    const report: NormalizedPirep = {
      ...unknownAltitudePirep,
      clouds: [{ cover: 'BKN', base_ft: null, top_ft: 6500 }],
    };
    const blocks = aviationGetPireps.format!({ pireps: [report] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('BKN base unknown, 6,500 ft top');
  });

  it.each(['CLR', 'SKC', 'VMC', 'IMC'])('renders a %s marker with no altitude range', (cover) => {
    const report: NormalizedPirep = {
      ...clearSkyPirep,
      clouds: [{ cover, base_ft: null, top_ft: null }],
    };
    const blocks = aviationGetPireps.format!({ pireps: [report] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain(`**Clouds:** ${cover}`);
    expect(text).not.toContain('0–0 ft');
    expect(text).not.toMatch(/\bnull\b/);
  });

  it('renders an explicit NEG turbulence layer rather than omitting it', () => {
    // An empty array means the group was absent; a NEG layer is the pilot
    // saying they hit nothing. The two must not render the same.
    const blocks = aviationGetPireps.format!({ pireps: [clearSkyPirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('**Turbulence:**');
    expect(text).toContain('NEG');
  });

  it('omits the turbulence heading when the report carried no such group', () => {
    const blocks = aviationGetPireps.format!({ pireps: [minimalPirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).not.toContain('**Turbulence:**');
  });

  it('omits the icing heading for a report AWC defaulted an icing layer onto', () => {
    // The upstream NEGclr placeholder no longer reaches normalization, so the
    // report arrives with an empty array and renders no icing section at all.
    const blocks = aviationGetPireps.format!({ pireps: [clearSkyPirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).not.toContain('**Icing:**');
  });

  it('renders a split intensity without the concatenated token', () => {
    const split: NormalizedPirep = {
      ...pirep,
      icing: [{ base_ft: null, top_ft: null, intensity: 'NEG', type: null }],
    };
    const blocks = aviationGetPireps.format!({ pireps: [split] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('**Icing:**');
    expect(text).toContain('- NEG');
    expect(text).not.toContain('NEGclr');
  });

  it('renders an icing type beside its intensity when one was reported', () => {
    const blocks = aviationGetPireps.format!({ pireps: [pirep] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('LGT, RIME');
  });
});

// ---------------------------------------------------------------------------
// One-sided hazard bounds and coordinate precision (issue #14) — a layer that
// reported one bound loses it when the renderer demands both
// ---------------------------------------------------------------------------

describe('aviationGetPireps.format hazard altitude bounds', () => {
  /** Render one report and return its text block. */
  function render(report: NormalizedPirep): string {
    const blocks = aviationGetPireps.format!({ pireps: [report] });
    return (blocks[0] as { type: string; text: string }).text;
  }

  it('renders a turbulence layer that reported only a base', () => {
    // Live: `LAX UA /OV CYNDI/TM 0700/FL180/TP B737/TB LGT 180`.
    const text = render({
      ...pirep,
      turbulence: [{ base_ft: 18000, top_ft: null, intensity: 'LGT', type: null, frequency: null }],
      icing: [],
      clouds: null,
    });

    expect(text).toContain('18,000 ft base');
  });

  it('renders an icing layer that reported only a top', () => {
    // Live: `AKO UA /OV AKO227028/TM 0242/FL170/TP B739/... /IC NEG BLO 170/`.
    const text = render({
      ...pirep,
      turbulence: [],
      icing: [{ base_ft: null, top_ft: 14000, intensity: 'MOD', type: null }],
      clouds: null,
    });

    expect(text).toContain('14,000 ft top');
  });

  it('renders no altitude text for a layer that reported neither bound', () => {
    // The common case — 107 of 111 first-layer turbulence reports in a live
    // CONUS sweep carried neither bound. This is the guard against a renderer
    // that fabricates an empty range to fill the slot.
    const text = render({
      ...pirep,
      turbulence: [{ base_ft: null, top_ft: null, intensity: 'NEG', type: null, frequency: null }],
      icing: [],
      clouds: null,
    });

    expect(text).toContain('- NEG');
    expect(text).not.toContain('()');
    expect(text).not.toMatch(/\bunknown\b/);
  });

  it('keeps a fully bounded layer rendering as a range', () => {
    const text = render(pirep);

    expect(text).toContain('(24,000–28,000 ft)');
    expect(text).toContain('(10,000–14,000 ft)');
  });

  it('renders a bound of 0 rather than reading it as absent', () => {
    // Surface-based layers arrive with base_ft 0. A truthiness guard here would
    // drop a real ground-level bound and render the layer as unlocated.
    const text = render({
      ...pirep,
      turbulence: [],
      icing: [{ base_ft: 0, top_ft: 12000, intensity: 'LGT', type: 'RIME' }],
      clouds: [{ cover: 'BKN', base_ft: 0, top_ft: 4000 }],
    });

    expect(text).toContain('(0–12,000 ft)');
    expect(text).toContain('BKN 0–4,000 ft');
  });

  it('renders coordinates at the resolution upstream published', () => {
    const text = render({ ...pirep, lat: 42.6129, lon: -84.5665 });

    expect(text).toContain('**Location:** 42.6129, -84.5665');
  });

  it('does not pad a low-precision coordinate', () => {
    const text = render({ ...pirep, lat: 36.037, lon: -80.5 });

    expect(text).toContain('36.037, -80.5');
    expect(text).not.toContain('36.0370');
    expect(text).not.toContain('-80.5000');
  });
});

// ---------------------------------------------------------------------------
// Temperature, wind aloft, and flight weather (issue #41) — `remarks` held the
// `/WX` group under a name that pointed at `/RM`, and `/TA` and `/WV` were
// decoded upstream and then dropped
// ---------------------------------------------------------------------------

describe('aviationGetPireps temperature, wind, and weather', () => {
  const report = aviationGetPireps.output.shape.pireps.element.shape;

  /** Run one report through the real tool pipeline and return both surfaces. */
  async function surfaces(reports: NormalizedPirep[]) {
    mockFetchPireps.mockResolvedValue(reports);
    const result = await runToolContract(aviationGetPireps, { station_id: 'KSEA' });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    return { structured: result.structuredContent as { pireps: unknown[] }, text };
  }

  it('publishes temperature, wind, and weather on both surfaces', async () => {
    const { structured, text } = await surfaces([aloftPirep]);

    expect(structured.pireps[0]).toMatchObject({
      temp_c: 6,
      wind: { direction_deg: 190, speed_kt: 3 },
      weather: { raw: '+RA', decoded: 'heavy rain' },
    });
    expect(text).toContain('**Temperature:** 6°C | **Wind:** 190° magnetic at 3 kt');
    expect(text).toContain('**Weather:** +RA (heavy rain)');
  });

  it('carries a sub-zero temperature and a strong wind aloft through unchanged', async () => {
    const { structured, text } = await surfaces([
      { ...aloftPirep, temp_c: -47, wind: { direction_deg: 255, speed_kt: 56 } },
    ]);

    expect(structured.pireps[0]).toMatchObject({
      temp_c: -47,
      wind: { direction_deg: 255, speed_kt: 56 },
    });
    expect(text).toContain('**Temperature:** -47°C | **Wind:** 255° magnetic at 56 kt');
  });

  it('renders a temperature of 0 as a reading', async () => {
    const { structured, text } = await surfaces([{ ...aloftPirep, temp_c: 0, wind: null }]);

    expect(structured.pireps[0]).toMatchObject({ temp_c: 0, wind: null });
    expect(text).toContain('**Temperature:** 0°C');
    expect(text).not.toContain('**Wind:**');
  });

  it('renders wind alone when the report carried no temperature', async () => {
    const { text } = await surfaces([{ ...aloftPirep, temp_c: null }]);

    expect(text).toContain('**Wind:** 190° magnetic at 3 kt');
    expect(text).not.toContain('**Temperature:**');
  });

  it('marks a PIREP wind magnetic and leaves an AIREP wind unmarked', async () => {
    // A PIREP /WV direction is magnetic (AIM TBL 7-1-18) and renders beside
    // METAR's true-north winds, so content[] has to say so. An AIREP's
    // reference is not stated, so its line asserts none.
    const airep: NormalizedPirep = {
      ...aloftPirep,
      pirep_type: 'AIREP',
      temp_c: -51,
      wind: { direction_deg: 291, speed_kt: 35 },
      raw_pirep: 'ARP UAL604 3823N 11419W 0859 F370 MS51 291/035KT',
    };
    const { structured, text } = await surfaces([aloftPirep, airep]);

    expect(structured.pireps).toEqual([
      expect.objectContaining({ pirep_type: 'PIREP', wind: { direction_deg: 190, speed_kt: 3 } }),
      expect.objectContaining({ pirep_type: 'AIREP', wind: { direction_deg: 291, speed_kt: 35 } }),
    ]);
    expect(text).toContain('**Wind:** 190° magnetic at 3 kt');
    expect(text).toContain('**Temperature:** -51°C | **Wind:** 291° at 35 kt');
    expect(text).not.toContain('291° magnetic');
  });

  it('renders no temperature, wind, or weather line for a report carrying none', async () => {
    const { structured, text } = await surfaces([minimalPirep]);

    expect(structured.pireps[0]).toMatchObject({ temp_c: null, wind: null, weather: null });
    expect(text).not.toContain('**Temperature:**');
    expect(text).not.toContain('**Wind:**');
    expect(text).not.toContain('**Weather:**');
  });

  it('keeps remarks off every surface', async () => {
    const { structured, text } = await surfaces([aloftPirep, minimalPirep]);

    expect(report).not.toHaveProperty('remarks');
    for (const row of structured.pireps) expect(row).not.toHaveProperty('remarks');
    expect(text).not.toContain('Remarks');
  });

  it('rejects a report without the three fields at the output schema', () => {
    const { temp_c, wind, weather, ...withoutFields } = aloftPirep;

    expect(aviationGetPireps.output.safeParse({ pireps: [aloftPirep] }).success).toBe(true);
    expect(aviationGetPireps.output.safeParse({ pireps: [withoutFields] }).success).toBe(false);
  });

  it('describes each value by what it holds, not only by the PIREP group', () => {
    // AIREPs populate temperature and wind from their own groups, so a
    // description naming only /TA or /WV would be wrong for them.
    expect(report.temp_c.description).toMatch(/AIREP/);
    expect(report.wind.description).toMatch(/AIREP/);
    expect(report.temp_c.description).toMatch(/0 is a (real )?reading/);
    // The weather value is the /WX group, and /RM stays in raw_pirep alone.
    expect(report.weather.description).toContain('/WX');
    expect(report.weather.description).toMatch(/\/RM/);
  });

  it('references a PIREP wind direction to magnetic north, not true', () => {
    // AIM TBL 7-1-18: /WV is "Direction in degrees magnetic north", and AWC
    // passes it through unconverted. The METAR and TAF wording must not be
    // copied here.
    const description = report.wind.unwrap().shape.direction_deg.description ?? '';

    expect(description).toMatch(/magnetic north/);
    expect(description).toMatch(/not converted/);
    expect(description).not.toMatch(/degrees true/);
    // The variation directive is scoped to a PIREP; an AIREP's reference is
    // unsourced, so the field shared with AIREPs must not claim it.
    expect(description).toMatch(/combining a PIREP's direction with a true track/);
    expect(description).toMatch(/an AIREP's reference is not stated/);
  });

  it('says undecodable /WX text survives only in raw_pirep', () => {
    const description = report.weather.description ?? '';

    expect(description).toMatch(/cannot decode is dropped or trimmed/);
    expect(description).toMatch(/raw_pirep is the only source/);
  });

  it('names the new values in the tool description', () => {
    expect(aviationGetPireps.description).toMatch(/temperature/i);
    expect(aviationGetPireps.description).toMatch(/wind/i);
    expect(aviationGetPireps.description).toMatch(/weather/i);
  });
});

// ---------------------------------------------------------------------------
// Upstream result-cap disclosure (issue #11) — `pirep` serves at most 400 rows,
// and the altitude filter runs after that cap, so it can only ever select from
// the page the cap left behind
// ---------------------------------------------------------------------------

describe('aviationGetPireps truncation disclosure', () => {
  /** A page of distinct reports at one altitude, so a draw can reach the cap. */
  function page(count: number, altitude_ft: number | null = 8000): NormalizedPirep[] {
    return Array.from({ length: count }, (_, i) => ({
      ...minimalPirep,
      altitude_ft,
      observed_at: new Date(Date.UTC(2026, 0, 15, 6, i % 60)).toISOString(),
    }));
  }

  /** Run the handler and return the enrichment it accumulated. */
  async function enrichmentFor(input: Record<string, unknown>, reports: NormalizedPirep[]) {
    mockFetchPireps.mockResolvedValue(reports);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    await aviationGetPireps.handler(aviationGetPireps.input.parse(input), ctx);
    return getEnrichment(ctx);
  }

  /** Run the handler over a page that empties and return the error it threw. */
  async function errorFor(input: Record<string, unknown>, reports: NormalizedPirep[]) {
    mockFetchPireps.mockResolvedValue(reports);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    try {
      await aviationGetPireps.handler(aviationGetPireps.input.parse(input), ctx);
    } catch (e) {
      return e as { message: string; data?: { recovery?: { hint?: string } } };
    }
    throw new Error('handler resolved where it was expected to throw');
  }

  it('discloses a page cut at the upstream maximum', async () => {
    expect(
      await enrichmentFor(
        { bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 }, hours: 12 },
        page(AWC_MAX_ROWS),
      ),
    ).toMatchObject({ truncated: true, shown: AWC_MAX_ROWS, cap: AWC_MAX_ROWS });
  });

  it('carries the pre-filter count when the altitude filter narrowed a capped page', async () => {
    const reports = [...page(AWC_MAX_ROWS - 2, 8000), ...page(2, 33000)];

    expect(
      await enrichmentFor(
        { bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 }, altitude_min_ft: 30000 },
        reports,
      ),
    ).toMatchObject({
      truncated: true,
      shown: 2,
      cap: AWC_MAX_ROWS,
      upstreamRows: AWC_MAX_ROWS,
    });
  });

  it('names the levers that narrow before the cap, and not the altitude filter', async () => {
    const notice = String(
      (
        await enrichmentFor(
          { bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 }, hours: 12 },
          page(AWC_MAX_ROWS),
        )
      ).notice,
    );

    expect(notice).toContain('bbox');
    expect(notice).toContain('hours');
    // The altitude filter runs after the cap, so it can never recover a dropped
    // report — offering it as a lever would send the caller in a circle.
    expect(notice).not.toMatch(/altitude_(min|max)_ft(?!.*cannot)/);
  });

  it('states completeness affirmatively on an uncapped page', async () => {
    const enrichment = await enrichmentFor({ station_id: 'KSEA' }, [pirep, minimalPirep]);

    expect(enrichment).toMatchObject({ truncated: false, shown: 2 });
    expect(enrichment).not.toHaveProperty('cap');
    expect(enrichment).not.toHaveProperty('upstreamRows');
    expect(enrichment).not.toHaveProperty('notice');
  });

  it('omits the pre-filter count when no altitude filter ran', async () => {
    const enrichment = await enrichmentFor(
      { bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 }, hours: 12 },
      page(AWC_MAX_ROWS),
    );

    expect(enrichment).toMatchObject({ truncated: true });
    expect(enrichment).not.toHaveProperty('upstreamRows');
  });

  it('stops claiming an area-wide count when the altitude filter empties a capped page', async () => {
    const err = await errorFor(
      { bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 }, altitude_min_ft: 30000 },
      page(AWC_MAX_ROWS),
    );

    // The capped page holds 400 rows; the area holds more. Reporting 400 as the
    // reports "in the area" is the assertion this fix removes.
    expect(err.message).not.toMatch(/400 report\(s\) were found/);
    expect(err.data?.recovery?.hint).not.toMatch(/400 PIREP\(s\) exist in the area/);
    expect(err.message).toMatch(/in part|partial/i);
    expect(err.data?.recovery?.hint).toContain('bbox');
  });

  it('still reports the upstream count when an uncapped page empties', async () => {
    // Characterization — a single bound pushes no level, so the draw is the
    // whole area and the count is a fact about it. The fix must not weaken
    // this into a hedge.
    const err = await errorFor({ station_id: 'KSEA', altitude_min_ft: 30000 }, page(3));

    expect(err.message).toContain('3 report(s) were found at other or unreported altitudes');
    expect(err.data?.recovery?.hint).toContain('3 PIREP(s) exist in the area');
  });

  it('stops claiming an area-wide count when the draw was narrowed upstream', async () => {
    // An 18,001–18,099 ft band pushes level=181, so AWC drew only FL151–211.
    // The rows that came back describe that band; the area holds more.
    const err = await errorFor(
      {
        bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 },
        altitude_min_ft: 18001,
        altitude_max_ft: 18099,
      },
      page(197, 30000),
    );

    expect(err.message).not.toMatch(/197 report\(s\) were found at other or unreported altitudes/);
    expect(err.data?.recovery?.hint).not.toMatch(/197 PIREP\(s\) exist in the area/);
    expect(err.message).toMatch(/FL181/);
  });

  it('names the intensity filter when it narrowed the draw that then emptied', async () => {
    const err = await errorFor(
      {
        bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 },
        altitude_min_ft: 18001,
        altitude_max_ft: 18099,
        min_intensity: 'mod',
      },
      page(21, 30000),
    );

    expect(err.message).toMatch(/MOD/);
    expect(err.data?.recovery?.hint).toContain('min_intensity');
  });

  it('does not tell a caller to narrow a band already pushed upstream', async () => {
    // A 48 ft band is sent as level=181. Offering "an altitude band 6,000 ft
    // or narrower" as the remaining lever asks for what was already done, and
    // saying the filter ran after the cap is false for this query.
    const err = await errorFor(
      {
        bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 },
        altitude_min_ft: 18001,
        altitude_max_ft: 18049,
      },
      page(AWC_MAX_ROWS, 30000),
    );
    const hint = String(err.data?.recovery?.hint);

    expect(hint).not.toMatch(/6,000 ft or narrower/);
    expect(hint).not.toMatch(/applied after the cap/);
    expect(hint).toContain('bbox');
  });

  it('still offers the altitude band as a lever when none was pushed', async () => {
    const err = await errorFor(
      { bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 }, altitude_min_ft: 30000 },
      page(AWC_MAX_ROWS, 8000),
    );

    expect(String(err.data?.recovery?.hint)).toMatch(/6,000 ft or narrower/);
  });

  it('drops min_intensity from the lever list once the caller has set it', async () => {
    const notice = String(
      (
        await enrichmentFor(
          {
            bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 },
            hours: 12,
            min_intensity: 'mod',
          },
          page(AWC_MAX_ROWS),
        )
      ).notice,
    );

    expect(notice).toContain('bbox');
    expect(notice).not.toMatch(/, min_intensity/);
  });

  it('leaves an empty upstream result an error rather than a truncation disclosure', async () => {
    mockFetchPireps.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA' });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_pireps_found' },
    });
    expect(getEnrichment(ctx)).not.toHaveProperty('truncated');
  });

  it('reaches structuredContent and content[] through the real tool pipeline', async () => {
    mockFetchPireps.mockResolvedValue(page(AWC_MAX_ROWS));
    const result = await runToolContract(aviationGetPireps, {
      bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 },
      hours: 12,
    });

    expect(result.structuredContent).toMatchObject({
      truncated: true,
      shown: AWC_MAX_ROWS,
      cap: AWC_MAX_ROWS,
    });

    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(String(AWC_MAX_ROWS));
    expect(text).toContain('bbox');
  });

  it('leaves the pireps payload and its rendering untouched', async () => {
    mockFetchPireps.mockResolvedValue([pirep]);
    const result = await runToolContract(aviationGetPireps, { station_id: 'KSEA', hours: 3 });

    expect(result.structuredContent).toMatchObject({
      pireps: [expect.objectContaining({ altitude_ft: 27000, aircraft_type: 'B737' })],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('## PIREP — 2026-01-15T18:30:00.000Z');
    expect(text).toContain('MOD, CAT, OCNL (24,000–28,000 ft)');
  });
});

// ---------------------------------------------------------------------------
// Request-imposed limit (issue #34) — every other parameter changes what is
// searched; this one bounds what comes back, and it is a different statement
// from the upstream row cap
// ---------------------------------------------------------------------------

describe('aviationGetPireps request limit', () => {
  const conus = { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 };

  /**
   * A page of distinct reports, newest first by construction so a limit's
   * selection is checkable against a known order.
   */
  function page(count: number, altitude_ft: number | null = 8000): NormalizedPirep[] {
    return Array.from({ length: count }, (_, i) => ({
      ...minimalPirep,
      altitude_ft,
      observed_at: new Date(Date.UTC(2026, 0, 15, 6, 0, 0) - i * 60_000).toISOString(),
      raw_pirep: `REPORT${i}`,
    }));
  }

  /** Run the handler and return both the payload and the enrichment. */
  async function runFor(input: Record<string, unknown>, reports: NormalizedPirep[]) {
    mockFetchPireps.mockResolvedValue(reports);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const result = await aviationGetPireps.handler(aviationGetPireps.input.parse(input), ctx);
    return { result, enrichment: getEnrichment(ctx) };
  }

  it('bounds the result below the match count', async () => {
    const { result, enrichment } = await runFor({ bbox: conus, limit: 5 }, page(50));

    expect(result.pireps).toHaveLength(5);
    expect(enrichment).toMatchObject({ limited: true, matched: 50, shown: 5 });
  });

  it('keeps the most recent reports rather than an arbitrary slice', async () => {
    // Hand the service the page in the worst order for a naive slice: oldest
    // first. The limit runs after the sort, so the newest must survive.
    const reports = page(10);
    const { result } = await runFor({ bbox: conus, limit: 3 }, [...reports].reverse());

    expect(result.pireps.map((p) => p.raw_pirep)).toEqual(['REPORT0', 'REPORT1', 'REPORT2']);
  });

  it('keeps the ordering descending inside a limited result', async () => {
    const { result } = await runFor({ bbox: conus, limit: 4 }, [...page(20)].reverse());
    const times = result.pireps.map((p) => Date.parse(p.observed_at));

    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('states the limit did not bite when it equals the match count', async () => {
    const { result, enrichment } = await runFor({ bbox: conus, limit: 6 }, page(6));

    expect(result.pireps).toHaveLength(6);
    expect(enrichment).toMatchObject({ limited: false, shown: 6 });
    expect(enrichment).not.toHaveProperty('matched');
    expect(enrichment).not.toHaveProperty('notice');
  });

  it('states the limit did not bite when it exceeds the match count', async () => {
    const { result, enrichment } = await runFor({ bbox: conus, limit: 99 }, page(2));

    expect(result.pireps).toHaveLength(2);
    expect(enrichment).toMatchObject({ limited: false, shown: 2 });
    expect(enrichment).not.toHaveProperty('matched');
  });

  it('applies after the altitude filter, not before it', async () => {
    // 3 reports at cruise inside a page of 20; a limit of 2 must select from
    // the 3 that matched, never from the 20 that were drawn.
    const reports = [...page(17, 8000), ...page(3, 33000)];
    const { result, enrichment } = await runFor(
      { bbox: conus, altitude_min_ft: 30000, limit: 2 },
      reports,
    );

    expect(result.pireps).toHaveLength(2);
    expect(result.pireps.every((p) => p.altitude_ft === 33000)).toBe(true);
    expect(enrichment).toMatchObject({ limited: true, matched: 3, shown: 2 });
  });

  it('names the limit in the notice without calling it the upstream cap', async () => {
    const { enrichment } = await runFor({ bbox: conus, limit: 5 }, page(50));
    const notice = String(enrichment.notice);

    expect(notice).toContain('limit');
    expect(notice).toContain('50');
    expect(notice).toMatch(/not the upstream cap/i);
    // The severity signal a limit discards is answered with the lever that
    // recovers it, rather than with a synthesized summary of what was omitted.
    expect(notice).toContain('min_intensity');
  });

  it('drops the severity lever once the caller has already set min_intensity', async () => {
    // The reported case: {station_id, min_intensity: 'sev', limit: 3} ended by
    // telling the caller to set a parameter already in the query.
    const { enrichment } = await runFor(
      { station_id: 'KSEA', min_intensity: 'sev', limit: 3 },
      page(20),
    );
    const notice = String(enrichment.notice);

    expect(notice).toMatch(/not the upstream cap/i);
    expect(notice).not.toContain('min_intensity');
    expect(notice).not.toMatch(/selects by recency alone/);
  });

  it('still offers the severity lever when min_intensity is unset', async () => {
    const { enrichment } = await runFor({ station_id: 'KSEA', limit: 3 }, page(20));

    expect(String(enrichment.notice)).toContain('min_intensity');
  });

  it('does not re-offer min_intensity in one half of a capped notice after suppressing it in the other', async () => {
    // narrowingLevers() already drops a pulled lever; the limit half must not
    // contradict it two sentences later inside the same string.
    const { enrichment } = await runFor(
      { bbox: conus, hours: 12, min_intensity: 'mod', limit: 10 },
      page(AWC_MAX_ROWS),
    );
    const notice = String(enrichment.notice);

    expect(notice).toContain('per-request maximum');
    expect(notice).toMatch(/not the upstream cap/i);
    expect(notice).not.toContain('min_intensity');
  });

  it('discloses a capped page and a request limit as two separate facts', async () => {
    const { result, enrichment } = await runFor(
      { bbox: conus, hours: 12, limit: 10 },
      page(AWC_MAX_ROWS),
    );

    expect(result.pireps).toHaveLength(10);
    expect(enrichment).toMatchObject({
      truncated: true,
      cap: AWC_MAX_ROWS,
      shown: 10,
      limited: true,
      matched: AWC_MAX_ROWS,
    });
  });

  it('keeps the two statements distinguishable in the shared notice', async () => {
    const { enrichment } = await runFor({ bbox: conus, hours: 12, limit: 10 }, page(AWC_MAX_ROWS));
    const notice = String(enrichment.notice);

    // The cap: reports were never drawn, and narrowing the query is the lever.
    expect(notice).toContain('per-request maximum');
    expect(notice).toContain('bbox');
    // The limit: reports were drawn and examined, and raising it returns them.
    expect(notice).toMatch(/not the upstream cap/i);
    expect(notice).toMatch(/every report counted here was examined/i);
    // And the count the limit selected from is scoped to the capped page.
    expect(notice).toMatch(/400 report\(s\) that matched inside the capped page/);
  });

  it('scopes matched to the capped page after the altitude filter narrowed it', async () => {
    // Three numbers, none implying another: 400 drawn, 12 past the altitude
    // filter, 4 returned. `matched` is the middle one and describes the page.
    const reports = [...page(AWC_MAX_ROWS - 12, 8000), ...page(12, 33000)];
    const { enrichment } = await runFor({ bbox: conus, altitude_min_ft: 30000, limit: 4 }, reports);

    expect(enrichment).toMatchObject({
      truncated: true,
      upstreamRows: AWC_MAX_ROWS,
      matched: 12,
      shown: 4,
      limited: true,
    });
  });

  it('keeps upstreamRows keyed on the altitude filter, not on the limit', async () => {
    // A capped page no client-side filter touched: the limit cut the result,
    // but restating the drawn count would only repeat what the cap said.
    const { enrichment } = await runFor({ bbox: conus, hours: 12, limit: 10 }, page(AWC_MAX_ROWS));

    expect(enrichment).toMatchObject({ truncated: true, limited: true });
    expect(enrichment).not.toHaveProperty('upstreamRows');
  });

  it.each([
    ['a radial search', { station_id: 'KSEA' }],
    ['an area search', { bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 } }],
  ])('leaves %s untouched when limit is omitted', async (_label, input) => {
    const { result, enrichment } = await runFor(input, [pirep, minimalPirep]);

    expect(result.pireps).toHaveLength(2);
    expect(enrichment).toMatchObject({ truncated: false, shown: 2 });
    expect(enrichment).not.toHaveProperty('limited');
    expect(enrichment).not.toHaveProperty('matched');
  });

  it('leaves an empty result an error rather than a limit disclosure', async () => {
    mockFetchPireps.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KSEA', limit: 5 });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_pireps_found' },
    });
    expect(getEnrichment(ctx)).not.toHaveProperty('limited');
  });

  it('leaves an altitude-emptied result an error rather than a limit disclosure', async () => {
    mockFetchPireps.mockResolvedValue(page(3, 8000));
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({
      station_id: 'KSEA',
      altitude_min_ft: 30000,
      limit: 5,
    });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_pireps_found' },
    });
    expect(getEnrichment(ctx)).not.toHaveProperty('limited');
  });

  it.each([
    ['missing_location', {}],
    [
      'conflicting_location',
      { station_id: 'KSEA', bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 } },
    ],
    [
      'conflicting_distance',
      { bbox: { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 }, distance_nm: 150 },
    ],
  ])('keeps %s ahead of any limit work', async (reason, input) => {
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const parsed = aviationGetPireps.input.parse({ ...input, limit: 5 });

    await expect(aviationGetPireps.handler(parsed, ctx)).rejects.toMatchObject({
      data: { reason },
    });
    expect(mockFetchPireps).not.toHaveBeenCalled();
  });

  it('does not narrow what is searched', async () => {
    // The whole point of the parameter: the outgoing request is identical, so
    // a limited call and an unlimited one see the same corpus.
    await runFor({ bbox: conus, hours: 12, limit: 5 }, page(50));
    const withLimit = mockFetchPireps.mock.calls[0]![0];
    mockFetchPireps.mockClear();
    await runFor({ bbox: conus, hours: 12 }, page(50));

    expect(withLimit).toEqual(mockFetchPireps.mock.calls[0]![0]);
    expect(withLimit).not.toHaveProperty('limit');
  });

  it.each([
    ['zero', 0],
    ['a negative count', -1],
    ['a fraction', 2.5],
    ['a value above the upstream row cap', AWC_MAX_ROWS + 1],
  ])('rejects %s at the schema', (_label, limit) => {
    expect(aviationGetPireps.input.safeParse({ station_id: 'KSEA', limit }).success).toBe(false);
  });

  it.each([1, AWC_MAX_ROWS])('accepts a limit of %i', (limit) => {
    expect(aviationGetPireps.input.safeParse({ station_id: 'KSEA', limit }).success).toBe(true);
  });

  it('names limit in the tool description', () => {
    expect(aviationGetPireps.description).toContain('limit');
  });

  it('reaches structuredContent and content[] through the real tool pipeline', async () => {
    mockFetchPireps.mockResolvedValue(page(AWC_MAX_ROWS));
    const result = await runToolContract(aviationGetPireps, {
      bbox: conus,
      hours: 12,
      limit: 10,
    });

    expect(result.structuredContent).toMatchObject({
      truncated: true,
      cap: AWC_MAX_ROWS,
      shown: 10,
      limited: true,
      matched: AWC_MAX_ROWS,
    });
    expect((result.structuredContent as { pireps: unknown[] }).pireps).toHaveLength(10);

    // A content[]-only client must learn both facts and be able to tell them
    // apart, not just that the result is short.
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('**Limited by the request:** true');
    expect(text).toContain('**Reports matched before the limit:** 400');
    expect(text).toContain('**Truncated at the upstream row cap:** true');
    expect(text).toMatch(/not the upstream cap/i);
  });

  it('renders the nested hazard layers of every report it did return', async () => {
    // The limit selects whole reports, so a surviving report keeps its full
    // turbulence, icing, and cloud detail on both surfaces.
    mockFetchPireps.mockResolvedValue([pirep, minimalPirep]);
    const result = await runToolContract(aviationGetPireps, { station_id: 'KSEA', limit: 1 });

    expect(result.structuredContent).toMatchObject({
      pireps: [
        expect.objectContaining({
          turbulence: [
            expect.objectContaining({ intensity: 'MOD', type: 'CAT', frequency: 'OCNL' }),
            expect.objectContaining({ intensity: 'LGT', type: 'CHOP' }),
          ],
          icing: [
            expect.objectContaining({ intensity: 'LGT', type: 'RIME' }),
            expect.objectContaining({ intensity: 'MOD', type: 'MIXED' }),
          ],
          clouds: [expect.objectContaining({ cover: 'BKN', base_ft: 8000, top_ft: 15000 })],
        }),
      ],
      limited: true,
      matched: 2,
    });

    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('MOD, CAT, OCNL (24,000–28,000 ft)');
    expect(text).toContain('LGT, CHOP (20,000–22,000 ft)');
    expect(text).toContain('LGT, RIME (10,000–14,000 ft)');
    expect(text).toContain('MOD, MIXED (14,000–18,000 ft)');
    expect(text).toContain('BKN 8,000–15,000 ft');
    expect(text).toContain('1 PIREP(s) found');
  });
});

// ---------------------------------------------------------------------------
// The limit lever on a large unbounded result (issue #46) — a result that is
// large only because no limit was set named neither the size nor the lever
// ---------------------------------------------------------------------------

describe('aviationGetPireps size notice', () => {
  const conus = { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 };
  /** The report count above which a call that set no limit is told about it. */
  const THRESHOLD = 50;

  /** Distinct reports, newest first by construction. */
  function page(count: number, altitude_ft: number | null = 8000): NormalizedPirep[] {
    return Array.from({ length: count }, (_, i) => ({
      ...minimalPirep,
      altitude_ft,
      observed_at: new Date(Date.UTC(2026, 0, 15, 6, 0, 0) - i * 60_000).toISOString(),
      raw_pirep: `REPORT${i}`,
    }));
  }

  /** Run the handler and return both the payload and the enrichment. */
  async function runFor(input: Record<string, unknown>, reports: NormalizedPirep[]) {
    mockFetchPireps.mockResolvedValue(reports);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const result = await aviationGetPireps.handler(aviationGetPireps.input.parse(input), ctx);
    return { result, enrichment: getEnrichment(ctx) };
  }

  /** The enrichment with the one field this issue changes taken out. */
  function withoutNotice(enrichment: Record<string, unknown>) {
    const { notice, ...rest } = enrichment;
    return rest;
  }

  it('keeps the rows, their order, and every non-notice field of a large unbounded result', async () => {
    // Characterization — the size sentence may only add to `notice`.
    const reports = page(THRESHOLD + 1);
    const { result, enrichment } = await runFor(
      { station_id: 'KORD', hours: 12 },
      [...reports].reverse(),
    );

    expect(result.pireps.map((p) => p.raw_pirep)).toEqual(reports.map((p) => p.raw_pirep));
    expect(withoutNotice(enrichment)).toEqual({ truncated: false, shown: THRESHOLD + 1 });
  });

  it('carries no size sentence at exactly the threshold', async () => {
    const { enrichment } = await runFor({ station_id: 'KORD', hours: 12 }, page(THRESHOLD));

    expect(enrichment).not.toHaveProperty('notice');
  });

  it('names limit one report past the threshold, and what it keeps', async () => {
    const { enrichment } = await runFor({ station_id: 'KORD', hours: 12 }, page(THRESHOLD + 1));
    const notice = String(enrichment.notice);

    expect(notice).toContain(`${THRESHOLD + 1} reports`);
    expect(notice).toContain('no limit was set');
    expect(notice).toMatch(/limit bounds the response without changing what is searched/);
    expect(notice).toContain('most recent');
    expect(notice).toContain('min_intensity');
  });

  it('drops min_intensity from the size sentence once the call has set it', async () => {
    const { enrichment } = await runFor(
      { station_id: 'KORD', hours: 12, min_intensity: 'mod' },
      page(THRESHOLD + 1),
    );
    const notice = String(enrichment.notice);

    expect(notice).toContain('no limit was set');
    expect(notice).not.toContain('min_intensity');
  });

  it.each([
    ['a limit that withheld reports', 10],
    ['a limit that withheld nothing', AWC_MAX_ROWS],
  ])('never carries the size sentence beside %s', async (_label, limit) => {
    const { enrichment } = await runFor(
      { station_id: 'KORD', hours: 12, limit },
      page(THRESHOLD + 30),
    );

    expect(String(enrichment.notice ?? '')).not.toContain('no limit was set');
  });

  it('compares the threshold against the reports left after the altitude filter', async () => {
    // 80 drawn, 50 at cruise: the filter is what the caller sees, and 50 is not
    // past the threshold.
    const reports = [...page(30, 8000), ...page(THRESHOLD, 33000)];
    const { enrichment } = await runFor(
      { station_id: 'KORD', hours: 12, altitude_min_ft: 30000 },
      reports,
    );

    expect(enrichment).toMatchObject({ shown: THRESHOLD });
    expect(enrichment).not.toHaveProperty('notice');
  });

  it('follows the cap guidance on a capped result, in one notice', async () => {
    const { enrichment } = await runFor({ bbox: conus, hours: 12 }, page(AWC_MAX_ROWS));
    const notice = String(enrichment.notice);

    expect(enrichment).toMatchObject({ truncated: true, shown: AWC_MAX_ROWS, cap: AWC_MAX_ROWS });
    expect(notice).toContain('per-request maximum');
    expect(notice).toContain(`${AWC_MAX_ROWS} reports because no limit was set`);
    expect(notice.indexOf('per-request maximum')).toBeLessThan(notice.indexOf('no limit was set'));
  });

  it('leaves a capped page the altitude filter narrowed below the threshold without it', async () => {
    const reports = [...page(AWC_MAX_ROWS - 2, 8000), ...page(2, 33000)];
    const { enrichment } = await runFor({ bbox: conus, altitude_min_ft: 30000 }, reports);

    expect(String(enrichment.notice)).toContain('per-request maximum');
    expect(String(enrichment.notice)).not.toContain('no limit was set');
  });

  it('reaches structuredContent and content[] through the real tool pipeline', async () => {
    mockFetchPireps.mockResolvedValue(page(THRESHOLD + 1));
    const result = await runToolContract(aviationGetPireps, { station_id: 'KORD', hours: 12 });

    expect(result.structuredContent).toMatchObject({
      truncated: false,
      shown: THRESHOLD + 1,
      notice: expect.stringContaining('no limit was set'),
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(`${THRESHOLD + 1} PIREP(s) found`);
    expect(text).toMatch(/limit bounds the response without changing what is searched/);
  });

  it('names the threshold behaviour in the notice description', () => {
    expect(aviationGetPireps.enrichment?.notice?.description ?? '').toMatch(/no limit/i);
  });
});

// ---------------------------------------------------------------------------
// Cap guidance names only usable levers (issue #53) — it offered distance_nm
// to a bbox search, a smaller bbox to a radial one, and a shorter hours at 1
// ---------------------------------------------------------------------------

describe('aviationGetPireps cap guidance levers', () => {
  const conus = { minLat: 24, minLon: -125, maxLat: 50, maxLon: -66 };

  /** A capped page of distinct reports at one altitude. */
  function capped(altitude_ft: number | null = 8000): NormalizedPirep[] {
    return Array.from({ length: AWC_MAX_ROWS }, (_, i) => ({
      ...minimalPirep,
      altitude_ft,
      observed_at: new Date(Date.UTC(2026, 0, 15, 6, 0, 0) - i * 60_000).toISOString(),
    }));
  }

  async function noticeFor(input: Record<string, unknown>) {
    mockFetchPireps.mockResolvedValue(capped());
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    await aviationGetPireps.handler(aviationGetPireps.input.parse(input), ctx);
    return String(getEnrichment(ctx).notice);
  }

  it('keeps the bbox lever sentence and drops distance_nm on an area search', async () => {
    const notice = await noticeFor({ bbox: conus, hours: 12 });

    expect(notice).toContain(
      'Narrow the search — a smaller bbox, a shorter hours, min_intensity, an altitude band 6,000 ft or narrower — and re-run.',
    );
    expect(notice).not.toContain('distance_nm');
  });

  it('offers distance_nm and not a smaller bbox on a radial search', async () => {
    const notice = await noticeFor({ station_id: 'KORD', hours: 12 });

    expect(notice).toContain(
      'Narrow the search — a smaller distance_nm, a shorter hours, min_intensity, an altitude band 6,000 ft or narrower — and re-run.',
    );
    expect(notice).not.toContain('a smaller bbox');
  });

  it('does not offer a shorter hours at the minimum of 1', async () => {
    const notice = await noticeFor({ bbox: conus, hours: 1 });

    expect(notice).toContain(
      'Narrow the search — a smaller bbox, min_intensity, an altitude band 6,000 ft or narrower — and re-run.',
    );
    expect(notice).not.toContain('a shorter hours');
  });

  it('offers a shorter hours one step above the minimum', async () => {
    expect(await noticeFor({ bbox: conus, hours: 2 })).toContain('a shorter hours');
  });

  it('does not offer a smaller distance_nm at the minimum of 10', async () => {
    const notice = await noticeFor({ station_id: 'KORD', distance_nm: 10, hours: 12 });

    expect(notice).toContain(
      'Narrow the search — a shorter hours, min_intensity, an altitude band 6,000 ft or narrower — and re-run.',
    );
    expect(notice).not.toContain('distance_nm');
  });

  it('offers a smaller distance_nm one step above the minimum', async () => {
    expect(await noticeFor({ station_id: 'KORD', distance_nm: 11, hours: 12 })).toContain(
      'Narrow the search — a smaller distance_nm, a shorter hours,',
    );
  });

  it('applies the same rule to the recovery of an altitude-emptied capped page', async () => {
    mockFetchPireps.mockResolvedValue(capped(8000));
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ bbox: conus, hours: 1, altitude_min_ft: 30000 });

    let hint = '';
    try {
      await aviationGetPireps.handler(input, ctx);
    } catch (e) {
      hint = String((e as { data?: { recovery?: { hint?: string } } }).data?.recovery?.hint);
    }

    expect(hint).toContain(
      'upstream cap — a smaller bbox, min_intensity, an altitude band 6,000 ft or narrower — then reapply',
    );
    expect(hint).not.toContain('distance_nm');
    expect(hint).not.toContain('a shorter hours');
  });

  it('reaches both surfaces with only the usable levers', async () => {
    mockFetchPireps.mockResolvedValue(capped());
    const result = await runToolContract(aviationGetPireps, { bbox: conus, hours: 12 });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

    expect(String((result.structuredContent as { notice?: string }).notice)).not.toContain(
      'distance_nm',
    );
    expect(text).toContain('Narrow the search — a smaller bbox, a shorter hours,');
    expect(text).not.toContain('distance_nm');
    // The cap guidance still leads, and the size sentence still follows it.
    expect(text.indexOf('per-request maximum')).toBeLessThan(text.indexOf('no limit was set'));
  });
});

// ---------------------------------------------------------------------------
// Empty-result hints name only usable levers (issue #53) — no_pireps_found told
// a bbox search to expand distance_nm, and any search to expand hours at 12
// ---------------------------------------------------------------------------

describe('aviationGetPireps empty-result levers', () => {
  const box = { minLat: 47, minLon: -124, maxLat: 49, maxLon: -121 };
  const SPARSE = 'PIREPs are sparse; absence of reports does not mean smooth conditions.';

  async function hintFor(input: Record<string, unknown>, reports: NormalizedPirep[] = []) {
    mockFetchPireps.mockResolvedValue(reports);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    try {
      await aviationGetPireps.handler(aviationGetPireps.input.parse(input), ctx);
    } catch (e) {
      return String((e as { data?: { recovery?: { hint?: string } } }).data?.recovery?.hint);
    }
    throw new Error('handler resolved where it was expected to throw');
  }

  it('keeps the radial hint byte-identical where both levers are usable', async () => {
    expect(await hintFor({ station_id: 'KSEA' })).toBe(
      `Expand the distance_nm or hours parameters, or try a different region. ${SPARSE}`,
    );
  });

  it('offers a wider bbox, not distance_nm, on an area search', async () => {
    expect(await hintFor({ bbox: box })).toBe(
      `Widen the bbox or expand the hours parameter, or try a different region. ${SPARSE}`,
    );
  });

  it('drops hours at its maximum of 12', async () => {
    expect(await hintFor({ station_id: 'KSEA', hours: 12 })).toBe(
      `Expand the distance_nm parameter, or try a different region. ${SPARSE}`,
    );
    expect(await hintFor({ bbox: box, hours: 12 })).toBe(
      `Widen the bbox, or try a different region. ${SPARSE}`,
    );
  });

  it('drops distance_nm at its maximum of 500', async () => {
    expect(await hintFor({ station_id: 'KSEA', distance_nm: 500, hours: 12 })).toBe(
      `Try a different region. ${SPARSE}`,
    );
    expect(await hintFor({ station_id: 'KSEA', distance_nm: 500, hours: 11 })).toBe(
      `Expand the hours parameter, or try a different region. ${SPARSE}`,
    );
  });

  it('names only usable levers when an upstream narrowing emptied the draw', async () => {
    const hint = await hintFor({ bbox: box, min_intensity: 'sev' });

    expect(hint).toBe(
      `Relax min_intensity, or widen the bbox or expand the hours parameter. ${SPARSE}`,
    );
  });

  it('names only usable levers when the altitude filter emptied a narrowed draw', async () => {
    // A 48 ft band pushes level=181, so the draw was narrowed upstream; the
    // reports it held all sit outside the band.
    const reports = Array.from({ length: 3 }, () => ({ ...minimalPirep, altitude_ft: 30000 }));
    const hint = await hintFor(
      { bbox: box, hours: 12, altitude_min_ft: 18001, altitude_max_ft: 18049 },
      reports,
    );

    expect(hint).toMatch(
      /^Relax altitude_min_ft \/ altitude_max_ft to widen the draw, or widen the bbox\. /,
    );
    expect(hint).not.toContain('distance_nm');
    expect(hint).not.toContain('hours');
  });

  it('keeps the declared recovery accurate for both search modes', () => {
    const recovery =
      aviationGetPireps.errors?.find((e) => e.reason === 'no_pireps_found')?.recovery ?? '';

    expect(recovery).toMatch(/bbox on an area search/);
    expect(recovery).toMatch(/below 12/);
    expect(recovery).toMatch(/a larger distance_nm \(up to 500\) on a station_id search/);
  });

  it('carries the branched hint on both surfaces', async () => {
    mockFetchPireps.mockResolvedValue([]);
    const result = await runToolContract(aviationGetPireps, { bbox: box, hours: 12 });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const structured = result.structuredContent as {
      error?: { data?: { recovery?: { hint?: string } } };
    };

    expect(result.isError).toBe(true);
    expect(structured.error?.data?.recovery?.hint).toBe(
      `Widen the bbox, or try a different region. ${SPARSE}`,
    );
    expect(text).toContain('Widen the bbox, or try a different region.');
    expect(text).not.toContain('distance_nm');
  });
});

// ---------------------------------------------------------------------------
// Unrecognized search center (issue #45) — AWC resolves a station_id center
// itself and answers HTTP 400 `Invalid location specified` for one it does not
// know, such as the closed KISN
// ---------------------------------------------------------------------------

describe('aviationGetPireps unrecognized station_id', () => {
  const bbox = { minLat: 47, minLon: -124, maxLat: 49, maxLon: -121 };

  /** The error the service raises for AWC's HTTP 400 on the PIREP endpoint. */
  function upstreamRejection(): McpError {
    return new McpError(
      JsonRpcErrorCode.InvalidParams,
      'AWC API error: Invalid location specified',
      { status: 400, body: '{"status":"error","error":"Invalid location specified"}' },
    );
  }

  /** Run the handler against a service that rejects with `error`, and return the throw. */
  async function errorFor(
    error: unknown,
    input: Record<string, unknown> = { station_id: 'KISN', distance_nm: 60, hours: 12 },
  ) {
    mockFetchPireps.mockRejectedValue(error);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    try {
      await aviationGetPireps.handler(aviationGetPireps.input.parse(input), ctx);
    } catch (e) {
      return e as McpError;
    }
    throw new Error('handler resolved where it was expected to throw');
  }

  it('raises the declared reason for a station_id AWC does not recognize', async () => {
    const err = await errorFor(upstreamRejection());

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'station_not_recognized' });
    expect(err.message).toContain('KISN');
  });

  it('points the recovery at aviation_find_stations and a bbox search', async () => {
    const err = await errorFor(upstreamRejection());
    const hint = String((err.data as { recovery?: { hint?: string } })?.recovery?.hint);

    expect(hint).toContain('aviation_find_stations');
    expect(hint).toContain('bbox');
  });

  it('keeps the upstream error as the cause, and its detail out of the payload', async () => {
    const upstream = upstreamRejection();
    const err = await errorFor(upstream);
    const payload = JSON.stringify({ message: err.message, data: err.data });

    expect(err.cause).toBe(upstream);
    expect(payload).not.toContain('Invalid location specified');
    expect(payload).not.toContain('"status":"error"');
  });

  it('reclassifies whatever digit-bearing identifier the schema now admits', async () => {
    const err = await errorFor(upstreamRejection(), { station_id: 'K0S9' });

    expect(err.data).toMatchObject({ reason: 'station_not_recognized' });
    expect(err.message).toContain('K0S9');
  });

  it('declares the reason in the contract with the same recovery', () => {
    const entry = aviationGetPireps.errors?.find((e) => e.reason === 'station_not_recognized');

    expect(entry).toMatchObject({ code: JsonRpcErrorCode.NotFound });
    expect(entry?.recovery).toContain('aviation_find_stations');
    expect(entry?.recovery).toContain('bbox');
  });

  it('reaches both response surfaces through the real tool pipeline', async () => {
    mockFetchPireps.mockRejectedValue(upstreamRejection());
    const result = await runToolContract(aviationGetPireps, {
      station_id: 'KISN',
      distance_nm: 60,
      hours: 12,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'station_not_recognized' },
      },
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('KISN');
    expect(text).toContain('aviation_find_stations');
    expect(text).toContain('bbox');
    expect(text).toContain('reason station_not_recognized');
  });

  it('leaves an empty result at a recognized station its own no_pireps_found', async () => {
    // Live KXWA, KISN's replacement, answers HTTP 204 — no reports, not an
    // unknown center.
    mockFetchPireps.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    const input = aviationGetPireps.input.parse({ station_id: 'KXWA', distance_nm: 60 });

    await expect(aviationGetPireps.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_pireps_found' },
    });
  });

  it('lets the same rejection bubble untouched in a bbox search', async () => {
    // The declared reason is about a center station; a bbox search sends none.
    const upstream = upstreamRejection();

    await expect(errorFor(upstream, { bbox })).resolves.toBe(upstream);
  });

  it.each([
    ['a 5xx outage', JsonRpcErrorCode.ServiceUnavailable],
    ['a timeout', JsonRpcErrorCode.Timeout],
    ['an abandoned request', JsonRpcErrorCode.RequestCancelled],
    ['a rate limit', JsonRpcErrorCode.RateLimited],
  ])('lets %s bubble as classified in a station_id search', async (_label, code) => {
    const upstream = new McpError(code, 'upstream');
    const err = await errorFor(upstream);

    expect(err).toBe(upstream);
    expect(err.code).toBe(code);
  });

  it('lets a non-McpError bubble untouched', async () => {
    const boom = new Error('socket hang up');

    await expect(errorFor(boom)).resolves.toBe(boom as unknown as McpError);
  });
});

// ---------------------------------------------------------------------------
// Scope of that reclassification — the PIREP endpoint rejects several things
// with the same envelope and code, and only the text naming the location says
// anything about the search center
// ---------------------------------------------------------------------------

describe('aviationGetPireps upstream rejection scope', () => {
  const bbox = { minLat: 47, minLon: -124, maxLat: 49, maxLon: -121 };

  /** The error the service raises for an AWC HTTP 400 carrying `text`. */
  function rejection(text: string): McpError {
    return new McpError(JsonRpcErrorCode.InvalidParams, `AWC API error: ${text}`, {
      status: 400,
      body: JSON.stringify({ status: 'error', error: text }),
    });
  }

  /** Run the handler against a service that rejects with `error`, and return the throw. */
  async function errorFor(error: unknown, input: Record<string, unknown>) {
    mockFetchPireps.mockRejectedValue(error);
    const ctx = createMockContext({ errors: aviationGetPireps.errors });
    try {
      await aviationGetPireps.handler(aviationGetPireps.input.parse(input), ctx);
    } catch (e) {
      return e as McpError;
    }
    throw new Error('handler resolved where it was expected to throw');
  }

  it('reads the unrecognized-center text as the declared reason', async () => {
    const err = await errorFor(rejection('Invalid location specified'), { station_id: 'KISN' });

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'station_not_recognized' });
  });

  it.each([
    ['a band the endpoint will not search', 'Invalid value for level'],
    ['an intensity it does not accept', 'Invalid value for inten'],
    [
      'a search area it could not read',
      'Must specify station IDs or bounding box, zoom, and density',
    ],
  ])('keeps AWC text for %s on a station_id search', async (_label, text) => {
    const upstream = rejection(text);
    const err = await errorFor(upstream, { station_id: 'KSEA' });

    expect(err).toBe(upstream);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.message).toContain(text);
    expect(err.data).not.toMatchObject({ reason: 'station_not_recognized' });
  });

  it('answers a non-location rejection identically in both search modes', async () => {
    const text = 'Invalid value for level';
    const radial = await errorFor(rejection(text), { station_id: 'KSEA' });
    const area = await errorFor(rejection(text), { bbox });

    expect(radial.code).toBe(area.code);
    expect(radial.message).toBe(area.message);
  });

  it('carries AWC text to both surfaces rather than blaming the station', async () => {
    mockFetchPireps.mockRejectedValue(rejection('Invalid value for level'));
    const result = await runToolContract(aviationGetPireps, { station_id: 'KSEA' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        message: 'AWC API error: Invalid value for level',
      },
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Invalid value for level');
    expect(text).not.toContain('does not recognize');
  });
});
