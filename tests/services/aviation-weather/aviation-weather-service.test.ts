/**
 * @fileoverview Tests for AviationWeatherService normalization — exercises the
 * meters→feet elevation conversion end to end (the tool tests mock the service
 * at the normalized level, so the conversion only runs here) plus the shared
 * bbox-ordering predicate.
 * @module tests/services/aviation-weather/aviation-weather-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
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
import type { RawMetar, RawStationInfo } from '@/services/aviation-weather/types.js';

/** Build a Response-like stub carrying a JSON body for fetchJson to parse. */
function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
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
    expect(obs.elevation_ft).toBe(5433);
  });

  it('falls back to 0 feet when METAR elevation is null', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([{ ...rawMetarKDEN, elev: null }]));
    const ctx = createMockContext();
    const [obs] = await svc.fetchMetar(['KDEN'], 1, ctx);

    expect(obs.elevation_ft).toBe(0);
  });

  it('converts station elevation from meters to feet', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationKSEA]));
    const ctx = createMockContext();
    const [station] = await svc.fetchStations({ stationIds: ['KSEA'] }, ctx);

    // Math.round(115 m * 3.28084) === 377 ft.
    expect(station.elevation_ft).toBe(377);
  });

  it('falls back to 0 feet when station elevation is null', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawStationKSEA, elev: null }]),
    );
    const ctx = createMockContext();
    const [station] = await svc.fetchStations({ stationIds: ['KSEA'] }, ctx);

    expect(station.elevation_ft).toBe(0);
  });
});
