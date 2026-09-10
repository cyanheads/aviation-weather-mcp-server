/**
 * @fileoverview Tests for the aviation_find_stations tool.
 * @module tests/tools/aviation-find-stations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationFindStations } from '@/mcp-server/tools/definitions/aviation-find-stations.tool.js';
import { AWC_MAX_ROWS } from '@/services/aviation-weather/awc-limits.js';
import type { NormalizedStation } from '@/services/aviation-weather/types.js';

// ---------------------------------------------------------------------------
// Service mock
// ---------------------------------------------------------------------------

vi.mock('@/services/aviation-weather/aviation-weather-service.js', () => ({
  getAviationWeatherService: vi.fn(),
}));

import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const mockFetchStations = vi.fn<ReturnType<typeof getAviationWeatherService>['fetchStations']>();

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
  id: 'KSEA',
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
  id: 'KBFI',
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

/**
 * The only station AWC reports under state DC — a mesonet site with no ICAO,
 * IATA, or FAA identifier and no data products. DC proper has no airport of its
 * own; KDCA/KIAD/KBWI all carry VA or MD.
 */
const wasd2: NormalizedStation = {
  id: 'WASD2',
  icao_id: null,
  iata_id: null,
  faa_id: null,
  name: 'Washington DC',
  lat: 38.87,
  lon: -77.02,
  elevation_ft: 0,
  state: 'DC',
  country: 'US',
  data_types: [],
};

/** KSEA at the coordinates `stationinfo` actually publishes — 5 decimal places. */
const kseaPrecise: NormalizedStation = { ...ksea, lat: 47.44467, lon: -122.31442 };

/**
 * Wilbur, WA — `stationinfo` reports its latitude as `47.75419998168945`, a
 * float representation artifact for a true `47.7542`, and lists no data
 * products at all.
 */
const k2s8: NormalizedStation = {
  ...ksea,
  id: 'K2S8',
  icao_id: 'K2S8',
  iata_id: null,
  faa_id: null,
  name: 'Wilbur',
  lat: 47.75419998168945,
  lon: -118.74299621582031,
  data_types: [],
};

/** Akutan, AK — AWC carries no elevation for it, so the height is unknown. */
const kkqa: NormalizedStation = {
  id: 'KKQA',
  icao_id: 'KKQA',
  iata_id: null,
  faa_id: 'KQA',
  name: 'Akutan',
  lat: 54.1338,
  lon: -165.7789,
  elevation_ft: null,
  state: 'AK',
  country: 'US',
  data_types: [],
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
    const station = result.stations[0]!;
    expect(station.icao_id).toBe('KSEA');
    expect(station.data_types).toContain('METAR');
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

  it('throws invalid_bbox when the bounding box is inverted', async () => {
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({
      bbox: { minLat: 49, minLon: -66, maxLat: 25, maxLon: -125 },
    });

    await expect(aviationFindStations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_bbox' },
    });
    expect(mockFetchStations).not.toHaveBeenCalled();
  });

  it('throws conflicting_location when station_ids is combined with bbox', async () => {
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    // Ordered (valid) bbox — the conflict guard must fire ahead of the bbox check
    const input = aviationFindStations.input.parse({
      station_ids: ['KSEA'],
      bbox: { minLat: 25, minLon: -125, maxLat: 49, maxLon: -66 },
    });

    await expect(aviationFindStations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_location' },
    });
    // station_ids must not silently override bbox — reject the combination instead
    expect(mockFetchStations).not.toHaveBeenCalled();
  });

  it('throws conflicting_location when station_ids is combined with state', async () => {
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ station_ids: ['KSEA'], state: 'TX' });

    await expect(aviationFindStations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_location' },
    });
    // station_ids must not silently override the state filter — reject instead
    expect(mockFetchStations).not.toHaveBeenCalled();
  });

  it('throws conflicting_location when bbox is combined with state', async () => {
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    // Ordered (valid) bbox plus a state — more than one location mode must be rejected
    const input = aviationFindStations.input.parse({
      bbox: { minLat: 32, minLon: -124, maxLat: 42, maxLon: -114 },
      state: 'FL',
    });

    await expect(aviationFindStations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_location' },
    });
    // bbox must not silently override state — reject the combination instead
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

    const station = result.stations[0]!;
    expect(station.iata_id).toBeNull();
    expect(station.faa_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unknown elevation vs. sea level (issue #15) — 0 ft is a real coastal site, so
// it cannot double as "no elevation on file"
// ---------------------------------------------------------------------------

describe('aviationFindStations elevation', () => {
  it('carries a missing elevation through as null', async () => {
    mockFetchStations.mockResolvedValue([kkqa]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ station_ids: ['KKQA'] });
    const result = await aviationFindStations.handler(input, ctx);

    expect(result.stations[0]!.elevation_ft).toBeNull();
  });

  it('keeps a sea-level station at 0 ft', async () => {
    mockFetchStations.mockResolvedValue([wasd2]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ state: 'DC' });
    const result = await aviationFindStations.handler(input, ctx);

    expect(result.stations[0]!.elevation_ft).toBe(0);
  });

  it('accepts both shapes against the declared output schema', async () => {
    mockFetchStations.mockResolvedValue([kkqa, wasd2, ksea]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({
      bbox: { minLat: 25, minLon: -180, maxLat: 72, maxLon: -66 },
    });
    const result = await aviationFindStations.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(aviationFindStations.output));
  });

  it('keeps the elevation description in feet MSL', () => {
    const description =
      aviationFindStations.output.shape.stations.element.shape.elevation_ft.description;
    expect(description).toContain('MSL');
    expect(description).not.toContain('AGL');
  });
});

// ---------------------------------------------------------------------------
// State validation (issue #20)
// ---------------------------------------------------------------------------

describe('aviationFindStations state validation', () => {
  it('throws invalid_state for a code with no bounding box', async () => {
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ state: 'ZZ' });

    await expect(aviationFindStations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_state' },
    });
    expect(mockFetchStations).not.toHaveBeenCalled();
  });

  it('names the rejected code and points at the supported set', async () => {
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ state: 'ZZ' });

    let thrown: unknown;
    try {
      await aviationFindStations.handler(input, ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const err = thrown as { message: string; data?: { recovery?: { hint?: string } } };
    expect(err.message).toContain('ZZ');
    expect(err.data?.recovery?.hint).toContain('DC');
    expect(err.data?.recovery?.hint).toMatch(/territor/i);
  });

  /**
   * AWC leaves `state` empty on territory stations, so a bbox entry would
   * return zero stations rather than working. Typed guidance beats a silent
   * empty result until a country-based filter path exists.
   */
  it.each(['PR', 'VI', 'GU', 'MP', 'AS'])(
    'throws invalid_state for the %s territory',
    async (code) => {
      const ctx = createMockContext({ errors: aviationFindStations.errors });
      const input = aviationFindStations.input.parse({ state: code });

      await expect(aviationFindStations.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_state' },
      });
      expect(mockFetchStations).not.toHaveBeenCalled();
    },
  );

  it('returns stations for a DC query', async () => {
    mockFetchStations.mockResolvedValue([wasd2]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ state: 'DC' });
    const result = await aviationFindStations.handler(input, ctx);

    expect(mockFetchStations).toHaveBeenCalledWith(expect.objectContaining({ state: 'DC' }), ctx);
    expect(result.stations.every((s) => s.state === 'DC')).toBe(true);
  });

  it('accepts a lowercase state code', async () => {
    mockFetchStations.mockResolvedValue([ksea, kbfi]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ state: 'wa' });
    const result = await aviationFindStations.handler(input, ctx);

    expect(result.stations).toHaveLength(2);
    expect(mockFetchStations).toHaveBeenCalledWith(expect.objectContaining({ state: 'wa' }), ctx);
  });

  it('throws conflicting_location ahead of invalid_state', async () => {
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ station_ids: ['KSEA'], state: 'ZZ' });

    await expect(aviationFindStations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_location' },
    });
    expect(mockFetchStations).not.toHaveBeenCalled();
  });

  it('leaves the station_ids and bbox modes untouched', async () => {
    mockFetchStations.mockResolvedValue([ksea]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });

    await aviationFindStations.handler(
      aviationFindStations.input.parse({ station_ids: ['KSEA'] }),
      ctx,
    );
    await aviationFindStations.handler(
      aviationFindStations.input.parse({
        bbox: { minLat: 47.0, minLon: -123.0, maxLat: 48.0, maxLon: -122.0 },
      }),
      ctx,
    );

    expect(mockFetchStations).toHaveBeenCalledTimes(2);
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

  it('renders an identifier-less station without a dangling ID label', () => {
    const blocks = aviationFindStations.format!({ stations: [wasd2] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('Washington DC');
    expect(text).toContain('38.87, -77.02');
    expect(text).toContain('DC, US');
    // No identifier of any kind exists — the IDs label must not render empty.
    expect(text).not.toMatch(/^\*\*IDs:\*\*\s*$/m);
  });

  // Issue #14 — content[] must state the same location structuredContent does.
  it('renders a coordinate at the resolution upstream published', () => {
    const blocks = aviationFindStations.format!({ stations: [kseaPrecise] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**Location:** 47.44467, -122.31442');
  });

  it('collapses a float representation artifact rather than printing it', () => {
    const blocks = aviationFindStations.format!({ stations: [k2s8] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('47.7542, -118.742996');
    expect(text).not.toContain('47.75419998168945');
  });

  it('does not pad a low-precision coordinate', () => {
    const blocks = aviationFindStations.format!({ stations: [wasd2] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).not.toContain('38.8700');
    expect(text).not.toContain('-77.0200');
  });

  it('renders an empty data_types as an explicit no-products state', () => {
    // 55 of 139 stations in one live bbox carry no products. Dropping the line
    // made that indistinguishable from a renderer that skipped it.
    const blocks = aviationFindStations.format!({ stations: [wasd2] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**Data types:** none listed');
  });

  it('renders a missing elevation as unknown, not 0 ft', () => {
    const blocks = aviationFindStations.format!({ stations: [kkqa] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**Elevation:** unknown');
    expect(text).not.toContain('0 ft');
  });

  it('renders a sea-level station as 0 ft', () => {
    const blocks = aviationFindStations.format!({ stations: [wasd2] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**Elevation:** 0 ft');
    expect(text).not.toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// Upstream result-cap disclosure (issue #11) — `stationinfo` serves at most 400
// rows, and the state mode filters that page again inside the service, so a
// count far below the cap can still be a cut draw
// ---------------------------------------------------------------------------

describe('aviationFindStations truncation disclosure', () => {
  /** A page of distinct stations, so a draw can be filled to the cap. */
  function page(count: number, state = 'TX'): NormalizedStation[] {
    return Array.from({ length: count }, (_, i) => ({
      ...ksea,
      id: `K${String(i).padStart(3, '0')}`,
      icao_id: `K${String(i).padStart(3, '0')}`,
      name: `Station ${i}`,
      state,
    }));
  }

  /**
   * Resolve the service mock with `stations`, reporting `preFilterRows` through
   * the pre-filter channel the way the state mode does. Omit it to model the
   * modes that run no client-side filter and therefore report nothing.
   */
  function mockDraw(stations: NormalizedStation[], preFilterRows?: number) {
    mockFetchStations.mockImplementation(async (params) => {
      if (preFilterRows != null) params.onPreFilterRows?.(preFilterRows);
      return stations;
    });
  }

  /** Run the handler and return the enrichment it accumulated. */
  async function enrichmentFor(input: Record<string, unknown>) {
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    await aviationFindStations.handler(aviationFindStations.input.parse(input), ctx);
    return getEnrichment(ctx);
  }

  it('discloses a bbox draw cut at the upstream maximum', async () => {
    mockDraw(page(AWC_MAX_ROWS));

    expect(
      await enrichmentFor({ bbox: { minLat: 25, minLon: -107, maxLat: 37, maxLon: -93 } }),
    ).toMatchObject({ truncated: true, shown: AWC_MAX_ROWS, cap: AWC_MAX_ROWS });
  });

  it('discloses a capped state query whose post-filter count sits below the cap', async () => {
    // The Texas case from the issue: 400 rows drawn, 279 of them in-state. The
    // count alone reads as headroom, so the pre-filter draw has to be stated.
    mockDraw(page(279), AWC_MAX_ROWS);

    expect(await enrichmentFor({ state: 'TX' })).toMatchObject({
      truncated: true,
      shown: 279,
      cap: AWC_MAX_ROWS,
      upstreamRows: AWC_MAX_ROWS,
    });
  });

  it('names a smaller bbox as the lever on a capped state query', async () => {
    mockDraw(page(279), AWC_MAX_ROWS);
    const notice = String((await enrichmentFor({ state: 'TX' })).notice);

    expect(notice).toContain('bbox');
    expect(notice).toContain('TX');
  });

  it('states completeness affirmatively on an uncapped draw', async () => {
    mockDraw([ksea, kbfi], 2);
    const enrichment = await enrichmentFor({ state: 'WA' });

    expect(enrichment).toMatchObject({ truncated: false, shown: 2 });
    expect(enrichment).not.toHaveProperty('cap');
    expect(enrichment).not.toHaveProperty('upstreamRows');
    expect(enrichment).not.toHaveProperty('notice');
  });

  it('omits the pre-filter count when no client-side filter ran', async () => {
    // A bbox draw is served as-is, so a second count would only restate `shown`.
    mockDraw(page(AWC_MAX_ROWS));
    const enrichment = await enrichmentFor({
      bbox: { minLat: 25, minLon: -107, maxLat: 37, maxLon: -93 },
    });

    expect(enrichment).toMatchObject({ truncated: true });
    expect(enrichment).not.toHaveProperty('upstreamRows');
  });

  it('omits the pre-filter count when the state filter dropped nothing', async () => {
    // A capped draw entirely inside the requested state: the truncation still
    // stands, but the drawn count equals `shown` and restates it.
    mockDraw(page(AWC_MAX_ROWS), AWC_MAX_ROWS);
    const enrichment = await enrichmentFor({ state: 'TX' });

    expect(enrichment).toMatchObject({ truncated: true, shown: AWC_MAX_ROWS });
    expect(enrichment).not.toHaveProperty('upstreamRows');
  });

  it('leaves an empty result an error rather than a truncation disclosure', async () => {
    mockDraw([], AWC_MAX_ROWS);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ state: 'TX' });

    await expect(aviationFindStations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'station_not_found' },
    });
    expect(getEnrichment(ctx)).not.toHaveProperty('truncated');
  });

  it('reaches structuredContent and content[] through the real tool pipeline', async () => {
    mockDraw(page(279), AWC_MAX_ROWS);
    const result = await runToolContract(aviationFindStations, { state: 'TX' });

    expect(result.structuredContent).toMatchObject({
      truncated: true,
      shown: 279,
      cap: AWC_MAX_ROWS,
      upstreamRows: AWC_MAX_ROWS,
    });

    // A client reading only content[] must learn the same two facts: the result
    // was cut, and a smaller bbox is what recovers the rest.
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(String(AWC_MAX_ROWS));
    expect(text).toContain('bbox');
  });

  it('leaves the stations payload and its rendering untouched', async () => {
    mockDraw([ksea], AWC_MAX_ROWS);
    const result = await runToolContract(aviationFindStations, { state: 'WA' });

    expect(result.structuredContent).toMatchObject({
      stations: [expect.objectContaining({ icao_id: 'KSEA' })],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('## Seattle-Tacoma International Airport');
    expect(text).toContain('**Data types:** METAR, TAF, SYNOP');
  });
});

// ---------------------------------------------------------------------------
// Partial-batch disclosure (issue #31) — `stationinfo` omits an identifier that
// resolved to nothing with no marker at all, so a short list read as a full one
// ---------------------------------------------------------------------------

describe('aviationFindStations partial-batch disclosure', () => {
  /** A second airport, so a batch can come back short. */
  const kjfk: NormalizedStation = {
    ...ksea,
    id: 'KJFK',
    icao_id: 'KJFK',
    iata_id: 'JFK',
    faa_id: 'JFK',
    name: 'New York/JF Kennedy Intl',
    state: 'NY',
  };

  /**
   * A registry entry with no ICAO, IATA, or FAA identifier — 375 of 1,600 rows
   * across four live bbox draws. It resolves by the registry's own `id`, so
   * reconciling on `icao_id` would report a station that came back as missing.
   */
  const nuet2: NormalizedStation = {
    ...wasd2,
    id: 'NUET2',
    name: 'Nueces Bay',
    lat: 27.833,
    lon: -97.486,
    state: 'TX',
  };

  /** Run the handler over a station_ids lookup and return its enrichment. */
  async function enrichmentFor(station_ids: string[], stations: NormalizedStation[]) {
    mockFetchStations.mockResolvedValue(stations);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    await aviationFindStations.handler(aviationFindStations.input.parse({ station_ids }), ctx);
    return getEnrichment(ctx);
  }

  it('names the identifier that resolved to nothing', async () => {
    expect(await enrichmentFor(['KSEA', 'KZZZ'], [ksea])).toMatchObject({
      requested: ['KSEA', 'KZZZ'],
      returned: ['KSEA'],
      partial: true,
      missing: ['KZZZ'],
    });
  });

  it('states completeness affirmatively on a full batch', async () => {
    const enrichment = await enrichmentFor(['KSEA', 'KJFK'], [ksea, kjfk]);

    expect(enrichment).toMatchObject({
      requested: ['KSEA', 'KJFK'],
      returned: ['KSEA', 'KJFK'],
      partial: false,
    });
    expect(enrichment).not.toHaveProperty('missing');
    expect(enrichment).not.toHaveProperty('notice');
  });

  it('treats a case difference as resolved, not as an omission', async () => {
    // Upstream case-folds `ksea` into the KSEA row, so exact-string matching
    // would report a station that did resolve.
    expect(await enrichmentFor(['KSEA', 'ksea'], [ksea])).toMatchObject({
      requested: ['KSEA', 'ksea'],
      returned: ['KSEA'],
      partial: false,
    });
  });

  it('treats a duplicate as resolved, not as an omission', async () => {
    // Upstream collapses `KSEA,KSEA` to one row, so comparing counts reports a
    // missing station that was never missing.
    expect(await enrichmentFor(['KSEA', 'KSEA'], [ksea])).toMatchObject({
      returned: ['KSEA'],
      partial: false,
    });
  });

  it('names a repeated unresolved identifier once, the way a resolved one is', async () => {
    // `missing` deduplicates on the same key `returned` does, so a request
    // naming one unknown identifier twice does not report it twice or repeat it
    // in the notice.
    const enrichment = await enrichmentFor(['KSEA', 'KZZZ', 'kzzz'], [ksea]);

    expect(enrichment).toMatchObject({
      requested: ['KSEA', 'KZZZ', 'kzzz'],
      returned: ['KSEA'],
      missing: ['KZZZ'],
      partial: true,
    });
    expect(String(enrichment.notice).match(/KZZZ/gi)).toHaveLength(1);
  });

  it('reports an identifier-less station as returned when asked for by registry ID', async () => {
    expect(await enrichmentFor(['NUET2'], [nuet2])).toMatchObject({
      returned: ['NUET2'],
      partial: false,
    });
  });

  it('reconciles against the identifiers upstream returned, not the request order', async () => {
    // A four-ID request comes back alphabetically ordered, so matching by array
    // position reports the wrong identifiers as missing.
    expect(await enrichmentFor(['KSEA', 'KJFK', 'KZZZ'], [kjfk, ksea])).toMatchObject({
      returned: ['KSEA', 'KJFK'],
      missing: ['KZZZ'],
      partial: true,
    });
  });

  it('states the registry as the cause, scoped to the registry', async () => {
    // `EGTF` and `LFOX` are real ICAO-identified aerodromes that AWC does not
    // carry, so the notice must not claim the airport does not exist.
    const notice = String((await enrichmentFor(['KSEA', 'EGTF'], [ksea])).notice);

    expect(notice).toContain('EGTF');
    expect(notice).toMatch(/AWC station registry/);
    expect(notice).not.toMatch(/no such airport|does not exist|is not an airport/i);
  });

  it('separates an identifier that is not in ICAO format', async () => {
    // `SEA` is Seattle-Tacoma's IATA code. The fix is a different one from an
    // ICAO-shaped ID the registry does not carry, so the guidance splits.
    const enrichment = await enrichmentFor(['KSEA', 'SEA', 'KZZZ'], [ksea]);
    const notice = String(enrichment.notice);

    expect(enrichment).toMatchObject({ missing: ['SEA', 'KZZZ'] });
    expect(notice).toMatch(/Not in ICAO format: SEA/);
    expect(notice).toMatch(/Not present in the AWC station registry: KZZZ/);
  });

  it('still throws rather than disclosing an empty result as a partial one', async () => {
    mockFetchStations.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    const input = aviationFindStations.input.parse({ station_ids: ['KZZZ', 'KZZY'] });

    await expect(aviationFindStations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'station_not_found' },
    });
    expect(getEnrichment(ctx)).not.toHaveProperty('partial');
  });

  it('leaves the bbox and state modes without a partial disclosure', async () => {
    mockFetchStations.mockResolvedValue([ksea, kbfi]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    await aviationFindStations.handler(
      aviationFindStations.input.parse({
        bbox: { minLat: 47, minLon: -123, maxLat: 48, maxLon: -122 },
      }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);

    expect(enrichment).toMatchObject({ truncated: false, shown: 2 });
    expect(enrichment).not.toHaveProperty('partial');
    expect(enrichment).not.toHaveProperty('requested');
    expect(enrichment).not.toHaveProperty('missing');
  });

  it('reaches structuredContent and content[] through the real tool pipeline', async () => {
    mockFetchStations.mockResolvedValue([ksea]);
    const result = await runToolContract(aviationFindStations, {
      station_ids: ['KSEA', 'SEA', 'KZZZ'],
    });

    expect(result.structuredContent).toMatchObject({
      requested: ['KSEA', 'SEA', 'KZZZ'],
      returned: ['KSEA'],
      partial: true,
      missing: ['SEA', 'KZZZ'],
    });

    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('SEA');
    expect(text).toContain('KZZZ');
    expect(text).toMatch(/AWC station registry/);
  });

  it('leaves the stations payload and its rendering untouched', async () => {
    mockFetchStations.mockResolvedValue([ksea]);
    const result = await runToolContract(aviationFindStations, {
      station_ids: ['KSEA', 'KZZZ'],
    });

    expect(result.structuredContent).toMatchObject({
      stations: [expect.objectContaining({ icao_id: 'KSEA' })],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('## Seattle-Tacoma International Airport');
    expect(text).toContain('**Data types:** METAR, TAF, SYNOP');
  });

  it('does not publish the registry ID it reconciles against', async () => {
    // Carried on the normalized record for reconciliation only — adding it to
    // the output schema would change the stations payload.
    mockFetchStations.mockResolvedValue([ksea]);
    const result = await runToolContract(aviationFindStations, { station_ids: ['KSEA'] });
    const [station] = (result.structuredContent as { stations: Record<string, unknown>[] })
      .stations;

    expect(station).not.toHaveProperty('id');
  });

  it('reports the cap and the reconciliation together without conflating them', async () => {
    // A station_ids lookup is bounded at 20 by the schema and can never reach
    // the 400-row cap, so its truncated:false stands beside a partial batch
    // rather than competing with it for the shared notice.
    const enrichment = await enrichmentFor(['KSEA', 'KZZZ'], [ksea]);

    expect(enrichment).toMatchObject({ truncated: false, shown: 1, partial: true });
    expect(enrichment).not.toHaveProperty('cap');
    expect(String(enrichment.notice)).not.toMatch(/row cap|per-request maximum/);
  });

  it.each([
    [{}, 'missing_search_criteria'],
    [{ station_ids: ['KSEA'], state: 'WA' }, 'conflicting_location'],
    [{ bbox: { minLat: 49, minLon: -66, maxLat: 25, maxLon: -125 } }, 'invalid_bbox'],
    [{ state: 'ZZ' }, 'invalid_state'],
  ])('runs the %o guard ahead of any reconciliation work', async (input, reason) => {
    mockFetchStations.mockResolvedValue([ksea]);
    const ctx = createMockContext({ errors: aviationFindStations.errors });

    await expect(
      aviationFindStations.handler(aviationFindStations.input.parse(input), ctx),
    ).rejects.toMatchObject({ data: { reason } });
    expect(getEnrichment(ctx)).not.toHaveProperty('partial');
  });
});
