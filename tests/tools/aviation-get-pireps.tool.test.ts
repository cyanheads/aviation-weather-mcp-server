/**
 * @fileoverview Tests for the aviation_get_pireps tool.
 * @module tests/tools/aviation-get-pireps.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
  remarks: null,
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
  remarks: null,
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
  remarks: null,
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
