/**
 * @fileoverview Tests for the aviation_get_pireps tool.
 * @module tests/tools/aviation-get-pireps.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
