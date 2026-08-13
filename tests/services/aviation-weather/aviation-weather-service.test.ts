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
import type {
  RawMetar,
  RawPirep,
  RawStationInfo,
  RawTaf,
  RawTafForecastPeriod,
} from '@/services/aviation-weather/types.js';

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
  vertVis: null,
  visib: '10+',
  wdir: 180,
  wgst: null,
  wspd: 8,
  wxString: null,
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

/** KSEA raw TAF with one base forecast period. */
const rawTafKSEA: RawTaf = {
  elev: 115,
  fcsts: [
    {
      clouds: [{ base: 2500, cover: 'BKN', type: null }],
      fcstChange: null,
      probability: null,
      timeFrom: 1768500000,
      timeTo: 1768521600,
      visib: '6+',
      wdir: 180,
      wgst: null,
      wspd: 12,
      wxString: null,
    },
  ],
  icaoId: 'KSEA',
  issueTime: '2026-01-15T17:30:00Z',
  lat: 47.4499,
  lon: -122.3117,
  name: 'Seattle-Tacoma Intl',
  rawTAF: 'KSEA 151730Z 1518/1618 18012KT P6SM BKN025',
  validTimeFrom: 1768500000,
  validTimeTo: 1768586400,
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

  it('reports a null station elevation as unknown rather than sea level', async () => {
    // KKQA (Akutan, AK) carries no elevation upstream. 0 ft is a real sea-level
    // field, so it cannot double as "not on file".
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawStationKSEA, elev: null }]),
    );
    const ctx = createMockContext();
    const [station] = await svc.fetchStations({ stationIds: ['KSEA'] }, ctx);

    expect(station!.elevation_ft).toBeNull();
  });

  it('keeps a sea-level station at 0 feet', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([{ ...rawStationKSEA, elev: 0 }]));
    const ctx = createMockContext();
    const [station] = await svc.fetchStations({ stationIds: ['KSEA'] }, ctx);

    expect(station!.elevation_ft).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unknown observations vs. genuine zeros (issue #15) — 0 is a real reading for
// every field here, so it cannot stand in for "upstream reported nothing"
// ---------------------------------------------------------------------------

describe('AviationWeatherService METAR unknown vs. genuine zero', () => {
  /** Normalize one raw METAR through the real service path. */
  async function normalize(overrides: Partial<RawMetar>) {
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawMetarKDEN, ...overrides }]),
    );
    const [obs] = await svc.fetchMetar(['KDEN'], 1, createMockContext());
    return obs!;
  }

  it('reports a null wind speed as unknown', async () => {
    // KSLO: `METAR KSLO 130955Z 10SM 24/23 A2989 ...` — no dddssKT group at all.
    const obs = await normalize({ wspd: null, wdir: null });
    expect(obs.wind.speed_kt).toBeNull();
  });

  it('keeps a calm wind at 0 knots', async () => {
    // Raw `00000KT` — the most common genuine zero in the feed.
    const obs = await normalize({ wspd: 0, wdir: 0 });
    expect(obs.wind.speed_kt).toBe(0);
  });

  it('reports a null temperature as unknown', async () => {
    const obs = await normalize({ temp: null });
    expect(obs.temp_c).toBeNull();
  });

  it('keeps a 0 °C temperature', async () => {
    // Raw `00/M02` — freezing point, not a missing reading.
    const obs = await normalize({ temp: 0 });
    expect(obs.temp_c).toBe(0);
  });

  it('reports a null dewpoint as unknown', async () => {
    const obs = await normalize({ dewp: null });
    expect(obs.dewpoint_c).toBeNull();
  });

  it('keeps a 0 °C dewpoint', async () => {
    const obs = await normalize({ dewp: 0 });
    expect(obs.dewpoint_c).toBe(0);
  });

  it('reports a null altimeter as unknown', async () => {
    // Canadian AUTO stations (e.g. CWMJ) report SLP and omit the A#### group.
    const obs = await normalize({ altim: null });
    expect(obs.altimeter_inhg).toBeNull();
  });

  it('converts a reported altimeter from hPa to inHg', async () => {
    const obs = await normalize({ altim: 1013 });
    expect(obs.altimeter_inhg).toBe(29.91);
  });

  it('leaves an all-missing observation with no fabricated readings', async () => {
    // KACY: `METAR KACY 130954Z A2984 RMK AO2 SLPNO $` — wind, temp, and
    // dewpoint all absent in one record.
    const obs = await normalize({ wspd: null, wdir: null, temp: null, dewp: null });
    expect(obs).toMatchObject({
      temp_c: null,
      dewpoint_c: null,
      wind: { direction_deg: null, speed_kt: null },
    });
  });

  it('keeps METAR elevation a plain number at a sea-level field', async () => {
    // KMSY reports elev 0 and AWC never returned a null METAR elev in any
    // sampled region, so this field stays non-nullable.
    const obs = await normalize({ elev: 0 });
    expect(obs.elevation_ft).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// METAR obscuration and present weather (issue #16) — an obscuration is a
// ceiling, and this endpoint publishes vertVis in hundreds of feet
// ---------------------------------------------------------------------------

describe('AviationWeatherService METAR ceiling', () => {
  /** Normalize one raw METAR through the real service path. */
  async function normalize(overrides: Partial<RawMetar>) {
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawMetarKDEN, ...overrides }]),
    );
    const [obs] = await svc.fetchMetar(['KDEN'], 1, createMockContext());
    return obs!;
  }

  it('reads an obscuration as an indefinite ceiling', async () => {
    // Live KDBQ: `SPECI KDBQ 131018Z AUTO 16004KT 1/4SM FG VV002 21/21 A2990`,
    // reported LIFR with no broken or overcast layer anywhere in the record.
    const obs = await normalize({
      clouds: [{ cover: 'OVX', base: 200 }],
      vertVis: 2,
      fltCat: 'LIFR',
      rawOb: 'SPECI KDBQ 131018Z AUTO 16004KT 1/4SM FG VV002 21/21 A2990 RMK AO2',
    });

    expect(obs.ceiling_ft).toBe(200);
    expect(obs.ceiling_type).toBe('indefinite');
  });

  it('reads vertVis as hundreds of feet, never as feet', async () => {
    // The AWC schema calls vertVis "Vertical visibility in feet" and the METAR
    // endpoint disagrees: every VV002 record pairs vertVis 2 with a 200 ft
    // layer base. Reading it as feet turns a 200 ft ceiling into a 2 ft one.
    const obs = await normalize({
      clouds: [],
      vertVis: 2,
      rawOb: 'SPECI KGCC 131000Z AUTO 00000KT 1/4SM FG VV002 11/11 A3001 RMK AO2',
    });

    expect(obs.ceiling_ft).toBe(200);
    expect(obs.ceiling_type).toBe('indefinite');
  });

  it.each([
    ['OVC', 100],
    ['BKN', 300],
  ])('reads a %s layer as a measured ceiling', async (cover, base) => {
    const obs = await normalize({ clouds: [{ cover, base }], vertVis: null });

    expect(obs.ceiling_ft).toBe(base);
    expect(obs.ceiling_type).toBe('measured');
  });

  it.each(['FEW', 'SCT'])('does not read a %s layer as a ceiling', async (cover) => {
    const obs = await normalize({ clouds: [{ cover, base: 200 }], vertVis: null });

    expect(obs.ceiling_ft).toBeNull();
    expect(obs.ceiling_type).toBeNull();
  });

  it('reports no ceiling for a clear sky', async () => {
    const obs = await normalize({ clouds: [], vertVis: null });

    expect(obs.ceiling_ft).toBeNull();
    expect(obs.ceiling_type).toBeNull();
  });

  it('takes the lowest qualifying layer when an obscuration sits below a broken layer', async () => {
    const obs = await normalize({
      clouds: [
        { cover: 'OVX', base: 200 },
        { cover: 'BKN', base: 3000 },
      ],
      vertVis: 2,
    });

    expect(obs.ceiling_ft).toBe(200);
    expect(obs.ceiling_type).toBe('indefinite');
  });

  it('takes the lowest qualifying layer when a broken layer sits below an obscuration', async () => {
    const obs = await normalize({
      clouds: [
        { cover: 'BKN', base: 100 },
        { cover: 'OVX', base: 800 },
      ],
      vertVis: 8,
    });

    expect(obs.ceiling_ft).toBe(100);
    expect(obs.ceiling_type).toBe('measured');
  });

  it('falls back to vertVis when the obscuration layer carries no base', async () => {
    // normalizeClouds drops a layer with no base, which would otherwise leave
    // the ceiling null and an obscured sky reading as no ceiling at all.
    const obs = await normalize({ clouds: [{ cover: 'OVX', base: null }], vertVis: 3 });

    expect(obs.ceiling_ft).toBe(300);
    expect(obs.ceiling_type).toBe('indefinite');
  });

  it('pairs a null ceiling_type with a null ceiling_ft and never otherwise', async () => {
    for (const raw of [
      { clouds: [], vertVis: null },
      { clouds: [{ cover: 'OVC', base: 900 }], vertVis: null },
      { clouds: [{ cover: 'OVX', base: 200 }], vertVis: 2 },
    ]) {
      const obs = await normalize(raw);
      expect(obs.ceiling_type === null).toBe(obs.ceiling_ft === null);
    }
  });
});

describe('AviationWeatherService METAR present weather', () => {
  /** Normalize one raw METAR through the real service path. */
  async function normalize(overrides: Partial<RawMetar>) {
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawMetarKDEN, ...overrides }]),
    );
    const [obs] = await svc.fetchMetar(['KDEN'], 1, createMockContext());
    return obs!;
  }

  it('carries the raw group alongside its decoded reading', async () => {
    const obs = await normalize({ wxString: 'FG' });

    expect(obs.present_weather).toEqual({ raw: 'FG', decoded: 'fog' });
  });

  it('carries the raw group beside a multi-group reading', async () => {
    // `+RA BR` is live on the CONUS feed. Both groups decode; the raw form
    // stays alongside so a consumer can re-read a group the decoder hands
    // back verbatim.
    const obs = await normalize({ wxString: '+RA BR' });

    expect(obs.present_weather).toEqual({ raw: '+RA BR', decoded: 'heavy rain; mist' });
  });

  it.each([null, '', '   '])('reports %p present weather as null', async (wxString) => {
    const obs = await normalize({ wxString });

    expect(obs.present_weather).toBeNull();
  });

  // Single-group readings the live feed publishes constantly. They are the
  // baseline a decoder rewrite must reproduce exactly.
  it.each([
    ['-RA', 'light rain'],
    ['+RA', 'heavy rain'],
    ['RA', 'rain'],
    ['BR', 'mist'],
    ['FG', 'fog'],
    ['HZ', 'haze'],
    ['FU', 'smoke'],
    ['SHRA', 'rain showers'],
    ['-SHRA', 'light rain showers'],
    ['-FZRA', 'light freezing rain'],
    ['FZFG', 'freezing fog'],
    ['BCFG', 'patchy fog'],
    ['MIFG', 'shallow fog'],
    ['PRFG', 'partial fog'],
    ['TSRA', 'thunderstorm with rain'],
    ['TSGR', 'thunderstorm with hail'],
    ['RASN', 'rain and snow'],
    ['BLSN', 'blowing snow'],
    ['DRSN', 'drifting snow'],
    ['SHSN', 'snow showers'],
  ])('decodes %s as %s', async (wxString, decoded) => {
    const obs = await normalize({ wxString });

    expect(obs.present_weather).toEqual({ raw: wxString, decoded });
  });
});

// ---------------------------------------------------------------------------
// Present-weather group decoding (issue #21) — a value is space-delimited and
// carries one or more groups, and each group is read by its AIM categories
// ---------------------------------------------------------------------------

describe('AviationWeatherService present-weather group decoding', () => {
  /** Decode one wxString through the real METAR normalization path. */
  async function decode(wxString: string) {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([{ ...rawMetarKDEN, wxString }]));
    const [obs] = await svc.fetchMetar(['KDEN'], 1, createMockContext());
    return obs!.present_weather;
  }

  // Every multi-group value below was live on the AWC METAR or TAF feed. The
  // whole-string lookup decoded at most the first group and passed the rest
  // through as raw code.
  it.each([
    ['-SHRA BR', 'light rain showers; mist'],
    ['-RA BR', 'light rain; mist'],
    ['TSRA BR', 'thunderstorm with rain; mist'],
    ['RA BR', 'rain; mist'],
    ['BR BCFG', 'mist; patchy fog'],
    ['HZ FU', 'haze; smoke'],
    ['-SHRA PRFG', 'light rain showers; partial fog'],
    ['SHRA BR VCTS', 'rain showers; mist; thunderstorm in the vicinity'],
    ['-SHRA BR VCTS', 'light rain showers; mist; thunderstorm in the vicinity'],
    ['FU VCSH', 'smoke; showers in the vicinity'],
    ['-RA VCTS', 'light rain; thunderstorm in the vicinity'],
  ])('decodes every group of %s', async (wxString, decoded) => {
    expect(await decode(wxString)).toEqual({ raw: wxString, decoded });
  });

  // The AIM gives the group format as Intensity/Proximity, Descriptor,
  // Precipitation, Obstruction, Other, and states that intensity "applies only
  // to the first type of precipitation reported" — so `-TSRA` is a
  // thunderstorm with light rain, never a light thunderstorm.
  it.each([
    ['-TSRA', 'thunderstorm with light rain'],
    ['+TSRA', 'thunderstorm with heavy rain'],
    ['-TSRA BR', 'thunderstorm with light rain; mist'],
    ['+TSRA BR', 'thunderstorm with heavy rain; mist'],
    ['-TSSN', 'thunderstorm with light snow'],
  ])('binds the intensity of %s to the precipitation, not the descriptor', async (wx, decoded) => {
    expect((await decode(wx))?.decoded).toBe(decoded);
  });

  it.each(['-TSRA', '+TSRA', '-TSRA BR', '+TSRA BR', 'VCTS -RA', '-TSSN'])(
    'never reads %s as a light or heavy thunderstorm',
    async (wxString) => {
      const decoded = (await decode(wxString))?.decoded ?? '';

      expect(decoded).not.toContain('light thunderstorm');
      expect(decoded).not.toContain('heavy thunderstorm');
    },
  );

  // VC scopes the group it prefixes — 5 to 10 SM from the point of observation,
  // per the AIM. As a leading phrase on a joined reading it would claim every
  // later group is in the vicinity too.
  it.each([
    ['VCTS', 'thunderstorm in the vicinity'],
    ['VCSH', 'showers in the vicinity'],
    ['VCFG', 'fog in the vicinity'],
    ['VCTS -RA', 'thunderstorm in the vicinity; light rain'],
    ['VCTS -RA BR', 'thunderstorm in the vicinity; light rain; mist'],
  ])('scopes the proximity of %s to its own group', async (wxString, decoded) => {
    expect((await decode(wxString))?.decoded).toBe(decoded);
  });

  it('resolves VCTSRA as one group rather than splitting on a code boundary', async () => {
    // Splitting is on spaces only — a run of codes is one group however long.
    expect((await decode('VCTSRA'))?.decoded).toBe('thunderstorm with rain in the vicinity');
  });

  it('decodes NSW, which the map had no entry for, to plain English', async () => {
    expect((await decode('NSW'))?.decoded).toBe('no significant weather');
  });

  it('reads +FC as a tornado or waterspout, not a heavy funnel cloud', async () => {
    // The AIM lists tornado/waterspout as its own phenomenon; the `+` is not an
    // intensity, and stripping it understates a tornado.
    const decoded = (await decode('+FC'))?.decoded;

    expect(decoded).toBe('tornado or waterspout');
    expect(decoded).not.toContain('funnel cloud');
  });

  it('still reads a bare FC as a funnel cloud', async () => {
    expect((await decode('FC'))?.decoded).toBe('funnel cloud');
  });

  it.each([
    ['XX', 'XX'],
    ['-XX', '-XX'],
    ['+ZZ', '+ZZ'],
    ['VCXX', 'VCXX'],
    ['RAX', 'RAX'],
    ['-SHRA XX', 'light rain showers; XX'],
    ['XX BR', 'XX; mist'],
  ])('hands back the unresolved group of %s verbatim', async (wxString, decoded) => {
    expect((await decode(wxString))?.decoded).toBe(decoded);
  });

  it.each(['constructor', '__proto__', 'toString', 'valueOf'])(
    'hands back %s verbatim rather than resolving it off a prototype',
    async (wxString) => {
      expect((await decode(wxString))?.decoded).toBe(wxString);
    },
  );

  it('never renders a qualifier in English while its phenomenon stays coded', async () => {
    // `light XX BR` is the silent-failure shape: the reading looks decoded, so
    // nothing marks the group that did not resolve.
    const decoded = (await decode('-XX BR'))?.decoded ?? '';

    expect(decoded).toBe('-XX; mist');
    expect(decoded).not.toContain('light XX');
  });

  it.each(['-SHRA BR', 'VCTS -RA BR', '+TSRA BR', '-SHRA  BR'])(
    'round-trips the raw group of %s byte for byte',
    async (wxString) => {
      expect((await decode(wxString))?.raw).toBe(wxString);
    },
  );
});

describe('AviationWeatherService TAF present weather', () => {
  /** Normalize one raw TAF forecast period through the real service path. */
  async function normalize(overrides: Partial<RawTafForecastPeriod>) {
    const period = { ...rawTafKSEA.fcsts[0]!, ...overrides };
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawTafKSEA, fcsts: [period] }]),
    );
    const [taf] = await svc.fetchTaf(['KSEA'], createMockContext());
    return taf!.forecast_periods[0]!;
  }

  it('carries the raw group beside the decoded reading, as METAR does', async () => {
    const period = await normalize({ wxString: '-SHRA BR' });

    expect(period.weather).toEqual({ raw: '-SHRA BR', decoded: 'light rain showers; mist' });
  });

  it('decodes every group of a multi-group forecast', async () => {
    const period = await normalize({ wxString: 'SHRA BR VCTS' });

    expect(period.weather?.decoded).toBe('rain showers; mist; thunderstorm in the vicinity');
  });

  it('keeps an unresolved forecast group recoverable from the raw field', async () => {
    const period = await normalize({ wxString: '-SHRA XX' });

    expect(period.weather).toEqual({ raw: '-SHRA XX', decoded: 'light rain showers; XX' });
  });

  it.each([null, '', '   '])('reports %p forecast weather as null', async (wxString) => {
    const period = await normalize({ wxString });

    expect(period.weather).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TAF cloud layers — the ordinary layers an obscuration fix must leave alone
// ---------------------------------------------------------------------------

describe('AviationWeatherService TAF cloud layers', () => {
  /** Normalize one raw TAF forecast period through the real service path. */
  async function normalize(overrides: Partial<RawTafForecastPeriod>) {
    const period = { ...rawTafKSEA.fcsts[0]!, ...overrides };
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawTafKSEA, fcsts: [period] }]),
    );
    const [taf] = await svc.fetchTaf(['KSEA'], createMockContext());
    return taf!.forecast_periods[0]!;
  }

  it('passes a reported layer through with its cover, base, and type', async () => {
    const period = await normalize({
      clouds: [
        { base: 800, cover: 'OVC', type: null },
        { base: 1500, cover: 'BKN', type: 'CB' },
      ],
    });

    expect(period.clouds).toEqual([
      { cover: 'OVC', base_ft: 800, type: null },
      { cover: 'BKN', base_ft: 1500, type: 'CB' },
    ]);
  });

  it('keeps the upstream layer order', async () => {
    const period = await normalize({
      clouds: [
        { base: 20000, cover: 'BKN', type: null },
        { base: 3000, cover: 'SCT', type: null },
      ],
    });

    expect(period.clouds.map((c) => c.base_ft)).toEqual([20000, 3000]);
  });

  it.each(['SKC', 'CLR', 'CAVOK'])(
    'drops a baseless %s layer, which has no height',
    async (cover) => {
      // `SKC` arrives with a null base on a BECMG group forecasting a clearing
      // sky — there is no altitude to publish, so the layer carries no data.
      const period = await normalize({ clouds: [{ base: null, cover, type: null }] });

      expect(period.clouds).toEqual([]);
    },
  );

  it.each([null, []])('reports %p upstream clouds as an empty array', async (clouds) => {
    const period = await normalize({ clouds });

    expect(period.clouds).toEqual([]);
  });

  it('keeps a surface-level layer at 0 feet rather than dropping it', async () => {
    const period = await normalize({ clouds: [{ base: 0, cover: 'OVC', type: null }] });

    expect(period.clouds).toEqual([{ cover: 'OVC', base_ft: 0, type: null }]);
  });
});

// ---------------------------------------------------------------------------
// TAF obscuration (issue #28) — this endpoint publishes an obscuration as an
// OVX layer with no base, carrying the height in the period's vertVis, in FEET
// ---------------------------------------------------------------------------

describe('AviationWeatherService TAF obscuration', () => {
  /** Normalize one raw TAF forecast period through the real service path. */
  async function normalize(overrides: Partial<RawTafForecastPeriod>) {
    const period = { ...rawTafKSEA.fcsts[0]!, ...overrides };
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawTafKSEA, fcsts: [period] }]),
    );
    const [taf] = await svc.fetchTaf(['KSEA'], createMockContext());
    return taf!.forecast_periods[0]!;
  }

  it('keeps the obscuration layer and fills its base from vertVis', async () => {
    // Live KDIK: `TAF KDIK 131126Z 1312/1412 15005KT 1/4SM FG VV002 ...`, which
    // arrives with the height on the period and no base on the layer.
    const period = await normalize({
      clouds: [{ base: null, cover: 'OVX', type: null }],
      vertVis: 200,
      visib: 0.25,
      wxString: 'FG',
    });

    expect(period.clouds).toEqual([{ cover: 'OVX', base_ft: 200, type: null }]);
    expect(period.vertical_visibility_ft).toBe(200);
  });

  it.each([
    [100, 'VV001'],
    [200, 'VV002'],
    [300, 'VV003'],
  ])('reads a TAF vertVis of %i (%s) as feet, never as hundreds of feet', async (vertVis) => {
    // The METAR endpoint publishes this field in hundreds of feet and needs a
    // ×100 conversion; this one publishes feet. Applying the METAR conversion
    // here turns a 200 ft indefinite ceiling into a 20,000 ft one.
    const period = await normalize({ clouds: [{ base: null, cover: 'OVX', type: null }], vertVis });

    expect(period.vertical_visibility_ft).toBe(vertVis);
    expect(period.clouds[0]!.base_ft).toBe(vertVis);
  });

  it('keeps a surface-level indefinite ceiling rather than dropping it', async () => {
    // `VV000` is a real group and the most hazardous value the field can hold.
    // Any truthiness guard on the height drops exactly that case.
    const period = await normalize({
      clouds: [{ base: null, cover: 'OVX', type: null }],
      vertVis: 0,
    });

    expect(period.vertical_visibility_ft).toBe(0);
    expect(period.clouds).toEqual([{ cover: 'OVX', base_ft: 0, type: null }]);
  });

  it('keeps the cloud-type qualifier on an obscuration', async () => {
    // `VV008CB` — NWSI 10-813 §B2.7.3 sanctions CB following an obscuration
    // height, so the qualifier is not an anomaly to normalize away.
    const period = await normalize({
      clouds: [{ base: null, cover: 'OVX', type: 'CB' }],
      vertVis: 800,
    });

    expect(period.clouds).toEqual([{ cover: 'OVX', base_ft: 800, type: 'CB' }]);
    expect(period.vertical_visibility_ft).toBe(800);
  });

  it('reports no vertical visibility on a period forecasting no obscuration', async () => {
    const period = await normalize({ clouds: [{ base: 2500, cover: 'BKN', type: null }] });

    expect(period.vertical_visibility_ft).toBeNull();
    expect(period.clouds).toEqual([{ cover: 'BKN', base_ft: 2500, type: null }]);
  });

  it('ignores a vertVis upstream carried forward onto a sky-clear period', async () => {
    // Live CYXU: `... 3/8SM FG VV001 BECMG 1312/1314 P6SM NSW SKC ...`. The
    // BECMG group forecasts a clearing sky and carries no VV group of its own,
    // yet upstream repeats the base period's vertVis on it. Reading the field
    // alone would publish a 100 ft indefinite ceiling under a P6SM NSW SKC
    // forecast — the obscuration is what the OVX layer marks, not the field.
    const period = await normalize({
      clouds: [{ base: null, cover: 'SKC', type: null }],
      vertVis: 100,
      fcstChange: 'BECMG',
      visib: '6+',
      wxString: 'NSW',
    });

    expect(period.vertical_visibility_ft).toBeNull();
    expect(period.clouds).toEqual([]);
  });

  it('fills only the obscuration when other layers sit beside it', async () => {
    const period = await normalize({
      clouds: [
        { base: null, cover: 'OVX', type: null },
        { base: 3000, cover: 'BKN', type: null },
      ],
      vertVis: 200,
    });

    expect(period.clouds).toEqual([
      { cover: 'OVX', base_ft: 200, type: null },
      { cover: 'BKN', base_ft: 3000, type: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// TAF low-level wind shear (issue #23) — the WShwshwshws/dddffKT group arrives
// already converted, and the three fields are populated together or not at all
// ---------------------------------------------------------------------------

describe('AviationWeatherService TAF wind shear', () => {
  /** Normalize one raw TAF forecast period through the real service path. */
  async function normalize(overrides: Partial<RawTafForecastPeriod>) {
    const period = { ...rawTafKSEA.fcsts[0]!, ...overrides };
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawTafKSEA, fcsts: [period] }]),
    );
    const [taf] = await svc.fetchTaf(['KSEA'], createMockContext());
    return taf!.forecast_periods[0]!;
  }

  it('maps the three upstream fields to one object', async () => {
    // Live KTUL: `... WS020/20040KT ...` — the group's own values, unscaled.
    const period = await normalize({ wshearHgt: 2000, wshearDir: 200, wshearSpd: 40 });

    expect(period.wind_shear).toEqual({ height_ft: 2000, direction_deg: 200, speed_kt: 40 });
  });

  it('passes the shear height through in feet rather than scaling it', async () => {
    // `WS020` reaches the endpoint as 2000, already in feet AGL. Multiplying by
    // 100 as the PIREP and METAR hundreds-of-feet fields require would publish
    // a 200,000 ft shear layer; treating it as hundreds would publish 20 ft.
    const period = await normalize({ wshearHgt: 2000, wshearDir: 220, wshearSpd: 45 });

    expect(period.wind_shear?.height_ft).toBe(2000);
  });

  it('adds no station elevation to the shear height', async () => {
    // The sampled shear stations sit at 643–1,270 ft MSL and every one reports
    // exactly 2000, so the datum is AGL and no offset belongs here.
    const period = await normalize({ wshearHgt: 2000, wshearDir: 210, wshearSpd: 35 });

    expect(period.wind_shear?.height_ft).toBe(2000);
  });

  it('reports a period carrying no shear group as null', async () => {
    const period = await normalize({ wshearHgt: null, wshearDir: null, wshearSpd: null });

    expect(period.wind_shear).toBeNull();
  });

  it('reports a period whose upstream shear keys are absent as null', async () => {
    // The three keys ride every sampled period, but the raw type marks them
    // optional — an absent key is the same "no group issued" state as a null.
    const period = await normalize({});

    expect(period.wind_shear).toBeNull();
  });

  it('leaves the surface wind untouched when shear is forecast', async () => {
    const period = await normalize({
      wdir: 180,
      wspd: 12,
      wgst: 22,
      wshearHgt: 2000,
      wshearDir: 200,
      wshearSpd: 40,
    });

    expect(period.wind).toEqual({ direction_deg: 180, speed_kt: 12, gust_kt: 22 });
    expect(period.wind_shear).toEqual({ height_ft: 2000, direction_deg: 200, speed_kt: 40 });
  });

  it('synthesizes nothing from a partially populated shear group', async () => {
    // Never observed upstream: the three fields ride together in every sampled
    // record. Publishing a wind velocity with a fabricated height would be worse
    // than omitting a group that upstream did not actually complete.
    const period = await normalize({ wshearHgt: 2000, wshearDir: null, wshearSpd: 40 });

    expect(period.wind_shear).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TAF forecast wind (issue #15) — a period amending only visibility, weather,
// or cloud carries no wind element, and `?? 0` turned that into a forecast calm
// ---------------------------------------------------------------------------

describe('AviationWeatherService TAF forecast wind', () => {
  /** Normalize one raw TAF forecast period through the real service path. */
  async function normalize(overrides: Partial<RawTafForecastPeriod>) {
    const period = { ...rawTafKSEA.fcsts[0]!, ...overrides };
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawTafKSEA, fcsts: [period] }]),
    );
    const [taf] = await svc.fetchTaf(['KSEA'], createMockContext());
    return taf!.forecast_periods[0]!;
  }

  it('reports a period with no wind element as unknown, not calm', async () => {
    // `TAF KCMH ... TEMPO 1310/1313 1/4SM FG` — the group amends visibility
    // and weather only, so AWC returns wdir and wspd both null.
    const period = await normalize({ fcstChange: 'TEMPO', wdir: null, wspd: null });

    expect(period.wind.speed_kt).toBeNull();
    expect(period.wind.direction_deg).toBeNull();
  });

  it('keeps a forecast calm at 0 knots', async () => {
    // Raw `00000KT` — 44 of 1617 live CONUS periods forecast exactly this.
    const period = await normalize({ wdir: 0, wspd: 0 });

    expect(period.wind.speed_kt).toBe(0);
  });

  it('keeps a variable-direction forecast that carries a real speed', async () => {
    // Raw `VRB04KT` — wdir arrives as the string 'VRB' beside a real speed.
    const period = await normalize({ wdir: 'VRB', wspd: 4 });

    expect(period.wind.direction_deg).toBeNull();
    expect(period.wind.speed_kt).toBe(4);
  });

  it('passes an ordinary forecast wind through unchanged', async () => {
    const period = await normalize({ wdir: 180, wspd: 12, wgst: 22 });

    expect(period.wind).toEqual({ direction_deg: 180, speed_kt: 12, gust_kt: 22 });
  });

  it('reports a period with no visibility element as unknown', async () => {
    // AWC sends an empty string, not null, for a period carrying no
    // visibility — 63 of 1622 live CONUS periods. Left as `""` it renders
    // as a bare " sm" with no value in front of it.
    const period = await normalize({ visib: '' });

    expect(period.visibility_sm).toBeNull();
  });

  it('keeps a forecast visibility that upstream actually reported', async () => {
    const period = await normalize({ visib: '6+' });

    expect(period.visibility_sm).toBe('6+');
  });
});

describe('AviationWeatherService PIREP altitude unknown vs. genuine zero', () => {
  /** Normalize one raw PIREP through the real service path. */
  async function normalize(overrides: Partial<RawPirep>) {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([{ ...rawPirep, ...overrides }]));
    const [report] = await svc.fetchPireps(
      { stationId: 'KSEA', distanceNm: 100, hours: 3 },
      createMockContext(),
    );
    return report!;
  }

  it.each([
    ['FLUNKN', 'DAG UA /OV TRM150015/TM 0106/FLUNKN/TP B737/WX DS/RM ZLAWC AWC-WEB'],
    ['FLDURC', 'CMH UA /OV CMH/TM 0941/FLDURC/TP E75S/SK T012'],
    ['FLDURD', 'CAK UA /OV CAK/TM 0745/FLDURD/TP C208/SK OVC024'],
  ])('reports /%s/ as an unknown altitude', async (_token, rawOb) => {
    // AWC resolves all three to fltLvl 0; only the raw token separates them
    // from a reported flight level of zero.
    const report = await normalize({ fltLvl: 0, rawOb });
    expect(report.altitude_ft).toBeNull();
  });

  it('keeps a reported /FL000/ at 0 feet', async () => {
    const report = await normalize({
      fltLvl: 0,
      fltLvlType: 'DURD',
      rawOb: 'EVV UA /OV EVV/TM 0125/FL000/TP E145/TB NEG/RM DURD RY22 EVV',
    });
    expect(report.altitude_ft).toBe(0);
  });

  it('converts /FLSFC/ using the field elevation AWC substitutes', async () => {
    // KMKE (666 ft) resolves to fltLvl 7 — hundreds of feet, not a sentinel.
    const report = await normalize({
      fltLvl: 7,
      fltLvlType: 'GRND',
      rawOb: 'MKE UA /OV MKE/TM 1200/FLSFC/TP B738/SK OVC010',
    });
    expect(report.altitude_ft).toBe(700);
  });

  it('keeps the altitude of a DURC report that carries a numeric flight level', async () => {
    // fltLvlType is phase of flight, not an altitude-validity flag. Note the
    // space in `/FL 290/` — the raw token is not always tight against FL.
    const report = await normalize({
      fltLvl: 290,
      fltLvlType: 'DURC',
      rawOb: 'RNO UA /OV SWR/TM 0549/FL 290/TP A380/TB MOD OCNL 280-320/RM DURC ENTERED BY ZOA',
    });
    expect(report.altitude_ft).toBe(29000);
  });

  it('keeps the altitude of a DURD report that carries a numeric flight level', async () => {
    const report = await normalize({
      fltLvl: 70,
      fltLvlType: 'DURD',
      rawOb: 'ORD UA /OV ORD160030/TM 0702/FL070/TP PC12/TB SMOOTH',
    });
    expect(report.altitude_ft).toBe(7000);
  });

  it('keeps the altitude of an AIREP that carries no /FL token', async () => {
    // AIREPs encode the level as `F370` with no /FL group anywhere in the text.
    const report = await normalize({
      fltLvl: 370,
      fltLvlType: 'OTHER',
      pirepType: 'AIREP',
      rawOb: 'ARP UAL604 3823N 11419W 0859 F370 189/043KT TB OCNL LGT CHOP IC',
    });
    expect(report.altitude_ft).toBe(37000);
  });

  it('reports a null flight level as an unknown altitude', async () => {
    const report = await normalize({ fltLvl: null });
    expect(report.altitude_ft).toBeNull();
  });

  it('passes a low-altitude report through in feet', async () => {
    const report = await normalize({
      fltLvl: 1200,
      rawOb: 'SEA UA /OV KSEA/TM 1530/FL120/TP B737/TB LGT',
    });
    expect(report.altitude_ft).toBe(1200);
  });
});

describe('AviationWeatherService PIREP cloud layers', () => {
  /** Normalize one raw PIREP's cloud array through the real service path. */
  async function normalizeClouds(clouds: RawPirep['clouds']) {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([{ ...rawPirep, clouds }]));
    const [report] = await svc.fetchPireps(
      { stationId: 'KSEA', distanceNm: 100, hours: 3 },
      createMockContext(),
    );
    return report!.clouds;
  }

  it('reports a zero base and top as unknown', async () => {
    // Raw `SK CLR` arrives as base 0 / top 0 — the pilot gave neither.
    const clouds = await normalizeClouds([{ cover: 'CLR', base: 0, top: 0 }]);
    expect(clouds).toEqual([{ cover: 'CLR', base_ft: null, top_ft: null }]);
  });

  it('keeps a reported base when the top is unknown', async () => {
    // Raw `SK OVC024` — a base with no top.
    const clouds = await normalizeClouds([{ cover: 'OVC', base: 2400, top: 0 }]);
    expect(clouds).toEqual([{ cover: 'OVC', base_ft: 2400, top_ft: null }]);
  });

  it('keeps a reported top when the base is unknown', async () => {
    const clouds = await normalizeClouds([{ cover: 'BKN', base: 0, top: 6500 }]);
    expect(clouds).toEqual([{ cover: 'BKN', base_ft: null, top_ft: 6500 }]);
  });

  it('passes a fully reported layer through unchanged', async () => {
    // Raw `SK OVC020-TOP027`.
    const clouds = await normalizeClouds([{ cover: 'OVC', base: 2000, top: 2700 }]);
    expect(clouds).toEqual([{ cover: 'OVC', base_ft: 2000, top_ft: 2700 }]);
  });

  it.each(['CLR', 'SKC', 'VMC', 'IMC'])(
    'retains a %s marker rather than dropping it for having no altitudes',
    async (cover) => {
      const clouds = await normalizeClouds([{ cover, base: 0, top: 0 }]);
      expect(clouds).toEqual([{ cover, base_ft: null, top_ft: null }]);
    },
  );

  it('keeps a null base and top as unknown', async () => {
    const clouds = await normalizeClouds([{ cover: 'BKN', base: null, top: null }]);
    expect(clouds).toEqual([{ cover: 'BKN', base_ft: null, top_ft: null }]);
  });

  it('returns null when the report carried no sky-condition group', async () => {
    expect(await normalizeClouds(null)).toBeNull();
    expect(await normalizeClouds([])).toBeNull();
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
