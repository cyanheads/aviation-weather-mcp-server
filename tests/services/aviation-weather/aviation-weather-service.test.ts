/**
 * @fileoverview Tests for AviationWeatherService normalization — exercises the
 * meters→feet elevation conversion end to end (the tool tests mock the service
 * at the normalized level, so the conversion only runs here) plus the outgoing
 * query strings each AWC endpoint receives.
 * @module tests/services/aviation-weather/aviation-weather-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep withRetry (and everything else) real; stub only the network call so raw
// AWC payloads flow through the real normalizeMetar / normalizeStation path.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: vi.fn() };
});

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { AviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';
import type { RawMetar, RawPirep, RawStationInfo } from '@/services/aviation-weather/types.js';

/** Build a Response-like stub carrying a JSON body for fetchJson to parse. */
function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** The URL handed to the most recent fetchWithTimeout call. */
function lastRequestUrl(): string {
  return String(vi.mocked(fetchWithTimeout).mock.calls.at(-1)?.[0]);
}

/** Match a query parameter with an exact value, not a prefix of a longer one. */
function queryParam(key: string, value: number | string): RegExp {
  return new RegExp(`[?&]${key}=${value}(?:&|$)`);
}

const svc = new AviationWeatherService({} as AppConfig, {} as StorageService);

beforeEach(() => {
  vi.mocked(fetchWithTimeout).mockReset();
});

// ---------------------------------------------------------------------------
// Fixtures — raw upstream shapes (elev is METERS)
// ---------------------------------------------------------------------------

/** KDEN raw METAR — elev 1656 m (charted field elevation 5434 ft). */
const rawMetarKDEN: RawMetar = {
  altim: 1013,
  clouds: [],
  cover: null,
  dewp: -2,
  elev: 1656,
  fltCat: 'VFR',
  icaoId: 'KDEN',
  lat: 39.8466,
  lon: -104.6562,
  metarType: 'METAR',
  name: 'Denver Intl',
  obsTime: 1768500000,
  qcField: null,
  rawOb: 'KDEN 151853Z 18008KT 10SM CLR 05/M02 A2992',
  receiptTime: '2026-01-15T18:53:00Z',
  reportTime: '2026-01-15T18:53:00Z',
  slp: null,
  temp: 5,
  visib: '10+',
  wdir: 180,
  wgst: null,
  wspd: 8,
};

/** KSEA raw station info — elev 115 m. */
const rawStationKSEA: RawStationInfo = {
  country: 'US',
  elev: 115,
  faaId: 'SEA',
  iataId: 'SEA',
  icaoId: 'KSEA',
  id: 'KSEA',
  lat: 47.4499,
  lon: -122.3117,
  priority: null,
  site: 'Seattle-Tacoma Intl',
  siteType: ['METAR', 'TAF'],
  state: 'WA',
  wmoId: null,
};

/**
 * The only station AWC reports under state DC — a mesonet site with every
 * identifier null. DC proper has no airport of its own; KDCA/KIAD/KBWI all
 * carry VA or MD.
 */
const rawStationWASD2: RawStationInfo = {
  country: 'US',
  elev: 0,
  faaId: null,
  iataId: null,
  icaoId: null,
  id: 'WASD2',
  lat: 38.87,
  lon: -77.02,
  priority: 8,
  site: 'Washington DC',
  siteType: [],
  state: 'DC',
  wmoId: null,
};

/** A neighbouring Maryland station — the state filter must drop it from a DC query. */
const rawStationKBWI: RawStationInfo = {
  country: 'US',
  elev: 44,
  faaId: 'BWI',
  iataId: 'BWI',
  icaoId: 'KBWI',
  id: 'KBWI',
  lat: 39.1754,
  lon: -76.6683,
  priority: null,
  site: 'Baltimore/Washington Intl',
  siteType: ['METAR', 'TAF'],
  state: 'MD',
  wmoId: null,
};

/** Raw PIREP record — enough to normalize; the URL is what these tests read. */
const rawPirep: RawPirep = {
  acType: 'B737',
  clouds: null,
  fltLvl: 270,
  icaoId: 'KWBC',
  lat: 47.5,
  lon: -122.3,
  obsTime: 1768500000,
  pirepType: 'PIREP',
  rawOb: 'KSEA UA /OV KSEA /TM 1830 /FL270 /TP B737',
  receiptTime: '2026-01-15T18:30:00Z',
  visib: null,
  wxString: null,
};

// ---------------------------------------------------------------------------
// Elevation unit conversion (issue #4)
// ---------------------------------------------------------------------------

describe('AviationWeatherService elevation conversion', () => {
  it('converts METAR elevation from meters to feet', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawMetarKDEN]));
    const ctx = createMockContext();
    const [obs] = await svc.fetchMetar(['KDEN'], 1, ctx);

    // Math.round(1656 m * 3.28084) === 5433 ft. (KDEN's charted field elevation
    // is 5434 ft; the 1 ft delta is AWC rounding elev to whole meters upstream.)
    expect(obs!.elevation_ft).toBe(5433);
  });

  it('falls back to 0 feet when METAR elevation is null', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([{ ...rawMetarKDEN, elev: null }]));
    const ctx = createMockContext();
    const [obs] = await svc.fetchMetar(['KDEN'], 1, ctx);

    expect(obs!.elevation_ft).toBe(0);
  });

  it('converts station elevation from meters to feet', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationKSEA]));
    const ctx = createMockContext();
    const [station] = await svc.fetchStations({ stationIds: ['KSEA'] }, ctx);

    // Math.round(115 m * 3.28084) === 377 ft.
    expect(station!.elevation_ft).toBe(377);
  });

  it('falls back to 0 feet when station elevation is null', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawStationKSEA, elev: null }]),
    );
    const ctx = createMockContext();
    const [station] = await svc.fetchStations({ stationIds: ['KSEA'] }, ctx);

    expect(station!.elevation_ft).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Outgoing query strings — each AWC endpoint names its parameters differently
// ---------------------------------------------------------------------------

describe('AviationWeatherService request construction', () => {
  it('sends hours= for METARs — the metar endpoint has its own hours parameter', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawMetarKDEN]));
    await svc.fetchMetar(['KDEN', 'KSEA'], 6, createMockContext());

    const url = lastRequestUrl();
    expect(url).toContain('/metar?ids=KDEN%2CKSEA');
    expect(url).toMatch(queryParam('hours', 6));
  });

  it('sends no lookback parameter for TAFs', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([]));
    await svc.fetchTaf(['KSEA'], createMockContext());

    const url = lastRequestUrl();
    expect(url).toContain('/taf?ids=KSEA&format=json');
    expect(url).not.toContain('hours=');
    expect(url).not.toContain('age=');
  });

  it('sends id and distance for a station-centered PIREP search', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawPirep]));
    await svc.fetchPireps({ stationId: 'KSEA', distanceNm: 250, hours: 2 }, createMockContext());

    const url = lastRequestUrl();
    expect(url).toMatch(queryParam('id', 'KSEA'));
    expect(url).toMatch(queryParam('distance', 250));
  });

  it('sends the bbox corners and no distance for an area PIREP search', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawPirep]));
    await svc.fetchPireps(
      { bbox: { minLat: 25, minLon: -125, maxLat: 49, maxLon: -66 }, hours: 6 },
      createMockContext(),
    );

    const url = lastRequestUrl();
    expect(url).toContain('bbox=25,-125,49,-66');
    expect(url).not.toContain('distance=');
  });
});

// ---------------------------------------------------------------------------
// PIREP lookback parameter (issue #17) — the pirep endpoint calls it `age`,
// and silently ignores any key it does not recognize
// ---------------------------------------------------------------------------

describe('AviationWeatherService PIREP lookback parameter', () => {
  it.each([1, 12])('sends age=%i in a station-centered search', async (hours) => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawPirep]));
    await svc.fetchPireps({ stationId: 'KORD', distanceNm: 250, hours }, createMockContext());

    const url = lastRequestUrl();
    expect(url).toMatch(queryParam('age', hours));
    expect(url).not.toContain('hours=');
  });

  it.each([1, 12])('sends age=%i in a bbox search', async (hours) => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawPirep]));
    await svc.fetchPireps(
      { bbox: { minLat: 25, minLon: -125, maxLat: 49, maxLon: -66 }, hours },
      createMockContext(),
    );

    const url = lastRequestUrl();
    expect(url).toMatch(queryParam('age', hours));
    expect(url).not.toContain('hours=');
  });
});

// ---------------------------------------------------------------------------
// State station lookup (issue #20) — bbox workaround plus client-side filter
// ---------------------------------------------------------------------------

describe('AviationWeatherService state station lookup', () => {
  it('filters a state query down to that state', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationKSEA, rawStationKBWI]));
    const stations = await svc.fetchStations({ state: 'WA' }, createMockContext());

    expect(stations.map((s) => s.state)).toEqual(['WA']);
  });

  it('accepts a lowercase state code', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationKSEA, rawStationKBWI]));
    const stations = await svc.fetchStations({ state: 'wa' }, createMockContext());

    expect(stations.map((s) => s.state)).toEqual(['WA']);
  });

  it('resolves DC to a bounding box and filters to DC stations', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationWASD2, rawStationKBWI]));
    const stations = await svc.fetchStations({ state: 'DC' }, createMockContext());

    expect(lastRequestUrl()).toContain('/stationinfo?bbox=');
    expect(stations.map((s) => s.state)).toEqual(['DC']);
  });

  it('preserves the null identifiers on the identifier-less DC station', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationWASD2]));
    const [station] = await svc.fetchStations({ state: 'DC' }, createMockContext());

    expect(station).toMatchObject({
      icao_id: null,
      iata_id: null,
      faa_id: null,
      name: 'Washington DC',
      data_types: [],
    });
  });

  it('rejects an unsupported state as a validation error, not a service outage', async () => {
    await expect(svc.fetchStations({ state: 'ZZ' }, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});
