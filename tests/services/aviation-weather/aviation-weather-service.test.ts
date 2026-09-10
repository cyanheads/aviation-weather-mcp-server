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
  // A `CLR` group carries no layer; AWC states the condition here instead.
  cover: 'CLR',
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

  // -------------------------------------------------------------------------
  // Malformed flight-level groups (issue #25) — the recognized token set was an
  // enumeration of a free-text field, so each draw of the endpoint turns up
  // members it does not hold.
  // -------------------------------------------------------------------------

  it.each([
    ['a call sign', 'FLB78X', 'ORD UA /OV ORD360010/TM 2146/FLB78X/TP VMC/TB NEG'],
    ['an aircraft type', 'FLP28A', 'FPR UA /OV FPR280001/TM 2028/FLP28A/TP P28A/SK OVC025'],
    ['a station identifier', 'FLKGRR', 'GRR UA /OV KGRR/TM 1904/FLKGRR/TP C56X/SK OVC UNKN-TOP040'],
    ['a cloud group', 'FLBKN0', 'BUF UA /OV BUF/TM 1830/FLBKN0/TP C172/SK BKN030'],
    ['a transposed DURD', 'FLDRD', 'SAV UA /OV SAV190005/TM 2010/FLDRD/TP GLF5/SK BKN020'],
  ])('reports %s bled into the group as an unknown altitude (/%s/)', async (_l, _t, rawOb) => {
    const report = await normalize({ fltLvl: 0, rawOb });
    expect(report.altitude_ft).toBeNull();
  });

  it.each([
    ['a time', 'FL2130', 'MCO UA /OV MCO360007/TM 2130/FL2130/TP B737/RM SMOOTH ON FINAL RWY 17L'],
    ['feet where a flight level belongs', 'FL1000', 'FMY UA /OV FMY/TM 2037/FL1000/TP C560'],
    ['a four-digit altitude', 'FL4000', 'MTC UA /OV MTC150015/TM 1802/FL4000/TP AS65/WX 3-4 VIS'],
    ['a zero-padded four-digit altitude', 'FL0303', 'TOL UA /OV FZI/TM 1907/FL0303/TP EC35'],
  ])(
    'reports %s as an unknown altitude even though the group is all digits (/%s/)',
    async (_l, _t, rawOb) => {
      // The case a digits-vs-not-digits shape test misses. AWC could not read
      // these either and left fltLvl 0, which renders as a surface observation
      // exactly as a non-numeric token does.
      const report = await normalize({ fltLvl: 0, rawOb });
      expect(report.altitude_ft).toBeNull();
    },
  );

  it('keeps a flight-level range AWC resolved to its midpoint', async () => {
    // `/FL030-000/` is neither all digits nor SFC, and AWC parsed it anyway:
    // fltLvl 15 is the midpoint of FL030 and FL000. Reading the group's shape
    // alone would discard an altitude upstream successfully decoded.
    const report = await normalize({
      fltLvl: 15,
      fltLvlType: 'DURD',
      rawOb: 'JNU UA /OV JNU /TM 0054 /FL030-000 /TP PC12 /SK OVC030 /TB OCNL LGT',
    });
    expect(report.altitude_ft).toBe(1500);
  });

  it('keeps a /FLSFC/ report at a sea-level field, where the substituted elevation is 0', async () => {
    // The SFC exclusion does not turn on the value: AWC substitutes field
    // elevation there, and a sea-level field's elevation is a genuine 0.
    const report = await normalize({
      fltLvl: 0,
      fltLvlType: 'GRND',
      rawOb: 'ACY UA /OV ACY/TM 1200/FLSFC/TP C172/SK OVC010',
    });
    expect(report.altitude_ft).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PIREP icing layers (issue #26) — AWC emits a default icing layer on reports
// whose raw text never mentioned icing
// ---------------------------------------------------------------------------

describe('AviationWeatherService PIREP icing layers', () => {
  /** Normalize one raw PIREP through the real service path. */
  async function normalize(overrides: Partial<RawPirep>) {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([{ ...rawPirep, ...overrides }]));
    const [report] = await svc.fetchPireps(
      { stationId: 'KSEA', distanceNm: 100, hours: 3 },
      createMockContext(),
    );
    return report!;
  }

  it('drops the fabricated layer on a report whose raw text carries no /IC group', async () => {
    // AWC borrows the report's own cloud layer for the bounds; the pilot said
    // nothing about icing at all.
    const report = await normalize({
      rawOb: 'BNA UA /OV BNA/TM 2134/FL330/TP B763/SK SKC/TB NEG/RM ZME62',
      icgInt2: 'NEGclr',
      icgType2: '',
      icgBas2: 330,
      icgTop2: 600,
    });
    expect(report.icing).toEqual([]);
  });

  it('drops a fabricated second layer whose base is 0, bounds and all', async () => {
    const report = await normalize({
      rawOb: 'PBI UA /OV DJT320012/TM 2100/FLDURD/TP C441/WX FV10SM',
      icgInt2: 'NEGclr',
      icgBas2: 0,
      icgTop2: 600,
    });
    expect(report.icing).toEqual([]);
  });

  it('drops the fabricated second layer while keeping the genuine first one', async () => {
    // The raw text mentions icing exactly once, so the /IC group accounts for
    // icgInt1 alone; the concatenated icgInt2 is a layer AWC added, with bounds
    // borrowed from the report itself. A report-level gate would keep both, and
    // stripping the suffix would leave the invented layer indistinguishable
    // from the real one.
    const report = await normalize({
      rawOb: 'MTJ UA /OV MTJ/TM 1930/FL120/TP GLF5/SK SKC/TB OCNL LGT-MOD BLO 160/IC NEG/RM DURD',
      icgInt1: 'NEG',
      icgType1: '',
      icgBas1: null,
      icgTop1: null,
      icgInt2: 'NEGclr',
      icgType2: '',
      icgBas2: 240,
      icgTop2: 600,
    });
    expect(report.icing).toEqual([{ base_ft: null, top_ft: null, intensity: 'NEG', type: null }]);
  });

  it('publishes no icing at all when the only layer is a concatenated one', async () => {
    // The raw icing group is a stray temperature AWC could not decode, so
    // icgInt1 is empty and the concatenated icgInt2 would be the whole array.
    // Keeping it publishes a negative icing report the pilot never made.
    const report = await normalize({
      rawOb: 'TIX UA /OV INDIA/TM 2026/FL110/TP EPIC/WX CLR/TB SMOOTH/IC +8C',
      icgInt1: '',
      icgInt2: 'NEGclr',
      icgType2: '',
      icgBas2: null,
      icgTop2: null,
    });
    expect(report.icing).toEqual([]);
  });

  it('keeps a genuine second layer, which arrives as a clean code', async () => {
    const report = await normalize({
      rawOb: 'PSM UA /OV PSM/TM 1905/FL200/TP E75L/TA M11/IC TRACE LGT MX 200',
      icgInt1: 'TRC',
      icgType1: '',
      icgBas1: 200,
      icgTop1: null,
      icgInt2: 'LGT',
      icgType2: 'MIXED',
      icgBas2: 200,
      icgTop2: null,
    });
    expect(report.icing).toEqual([
      { base_ft: 20000, top_ft: null, intensity: 'TRC', type: null },
      { base_ft: 20000, top_ft: null, intensity: 'LGT', type: 'MIXED' },
    ]);
  });

  it('never publishes a concatenated intensity', async () => {
    const report = await normalize({
      rawOb: 'SDF UA /OV EWO180020/TM 1919/FL050/TP P32R/SK SKC/TB LGT CHOP/IC NEG',
      icgInt1: 'NEG',
      icgInt2: 'NEGclr',
      icgBas2: 50,
      icgTop2: 600,
    });
    expect(report.icing.map((i) => i.intensity)).not.toContain('NEGclr');
    expect(report.icing.every((i) => !/[a-z]/.test(i.intensity))).toBe(true);
  });

  it('passes a clean single-part report through unchanged', async () => {
    const report = await normalize({
      rawOb: 'LAX UA /OV 3718N 12348W/TM 2201/FL260/TP B38M/IC LGT RIME 220-250',
      icgInt1: 'LGT',
      icgType1: 'RIME',
      icgBas1: 220,
      icgTop1: 250,
    });
    expect(report.icing).toEqual([
      { base_ft: 22000, top_ft: 25000, intensity: 'LGT', type: 'RIME' },
    ]);
  });

  it('preserves a two-part intensity range unsplit', async () => {
    const report = await normalize({
      rawOb: 'DEN UA /OV DEN/TM 1900/FL180/TP C560/IC LGT-MOD RIME 160-200',
      icgInt1: 'LGT-MOD',
      icgType1: 'RIME',
      icgBas1: 160,
      icgTop1: 200,
    });
    expect(report.icing[0]?.intensity).toBe('LGT-MOD');
  });

  it('keeps both layers of a genuine two-layer icing report', async () => {
    const report = await normalize({
      rawOb: 'ABQ UA /OV ABQ270055/TM 0731/FL230/TP PC12/IC MOD RIME/IC LGT MX',
      icgInt1: 'MOD',
      icgType1: 'RIME',
      icgBas1: 200,
      icgTop1: 230,
      icgInt2: 'LGT',
      icgType2: 'MIXED',
      icgBas2: 230,
      icgTop2: 260,
    });
    expect(report.icing).toEqual([
      { base_ft: 20000, top_ft: 23000, intensity: 'MOD', type: 'RIME' },
      { base_ft: 23000, top_ft: 26000, intensity: 'LGT', type: 'MIXED' },
    ]);
  });

  it('keeps a genuine explicit negative report as a NEG layer', async () => {
    const report = await normalize({
      rawOb: 'DSM UA /OV DSM200020/TM 1044/FL150/TP A319/TB NEG/IC NEG/RM DURC',
      icgInt1: 'NEG',
      icgType1: '',
      icgBas1: null,
      icgTop1: null,
    });
    expect(report.icing).toEqual([{ base_ft: null, top_ft: null, intensity: 'NEG', type: null }]);
  });

  it('leaves turbulence untouched, including its compound intensities', async () => {
    const report = await normalize({
      rawOb: 'JFK UA /OV JFK/TM 1200/FL350/TP B772/TB MOD-SEV CAT 330-370',
      tbInt1: 'MOD-SEV',
      tbType1: 'CAT',
      tbBas1: 330,
      tbTop1: 370,
      tbInt2: 'LGT-MOD',
      tbBas2: 300,
      tbTop2: 330,
    });
    expect(report.turbulence.map((t) => t.intensity)).toEqual(['MOD-SEV', 'LGT-MOD']);
  });

  it('keeps a turbulence base of 0 as a surface-based layer, not an unknown', async () => {
    // Raw `030-SFC` — a chop layer from the surface up to 3,000 ft. Mirroring
    // the cloud-layer zero-as-unknown rule here would fabricate an unknown out
    // of a correctly reported ground-level bound.
    const report = await normalize({
      rawOb: 'AGC UUA /OV AGC/TM 2016/FL030/TP P28A/TB LGT CHOP 030-SFC',
      tbInt1: 'LGT',
      tbType1: 'CHOP',
      tbBas1: 0,
      tbTop1: 30,
    });
    expect(report.turbulence[0]).toMatchObject({ base_ft: 0, top_ft: 3000 });
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
// PIREP upstream narrowing (issue #32) — `level` and `inten` run before the
// 400-row cap, where the client-side altitude filter runs after it
// ---------------------------------------------------------------------------

describe('AviationWeatherService PIREP upstream narrowing', () => {
  const bbox = { minLat: 25, minLon: -125, maxLat: 49, maxLon: -66 };

  beforeEach(() => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawPirep]));
  });

  it('sends level in a station-centered search', async () => {
    await svc.fetchPireps(
      { stationId: 'KDEN', distanceNm: 200, hours: 12, level: 190 },
      createMockContext(),
    );
    expect(lastRequestUrl()).toMatch(queryParam('level', 190));
  });

  it('sends level in a bbox search', async () => {
    await svc.fetchPireps({ bbox, hours: 12, level: 100 }, createMockContext());
    expect(lastRequestUrl()).toMatch(queryParam('level', 100));
  });

  it('sends inten in a station-centered search', async () => {
    await svc.fetchPireps(
      { stationId: 'KDEN', distanceNm: 200, hours: 12, minIntensity: 'mod' },
      createMockContext(),
    );
    expect(lastRequestUrl()).toMatch(queryParam('inten', 'mod'));
  });

  it('sends inten in a bbox search', async () => {
    await svc.fetchPireps({ bbox, hours: 12, minIntensity: 'sev' }, createMockContext());
    expect(lastRequestUrl()).toMatch(queryParam('inten', 'sev'));
  });

  it('sends both together', async () => {
    await svc.fetchPireps(
      { bbox, hours: 12, level: 190, minIntensity: 'mod' },
      createMockContext(),
    );
    const url = lastRequestUrl();
    expect(url).toMatch(queryParam('level', 190));
    expect(url).toMatch(queryParam('inten', 'mod'));
  });

  it('sends neither when neither was asked for', async () => {
    await svc.fetchPireps({ bbox, hours: 12 }, createMockContext());
    const url = lastRequestUrl();
    expect(url).not.toContain('level=');
    expect(url).not.toContain('inten=');
  });

  it('sends a level of 0 rather than dropping it as falsy', async () => {
    // FL000 is a real centre — a band of 0–3,000 ft rounds to it.
    await svc.fetchPireps({ bbox, hours: 12, level: 0 }, createMockContext());
    expect(lastRequestUrl()).toMatch(queryParam('level', 0));
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

// ---------------------------------------------------------------------------
// Advisory request construction (issue #12) — `/airsigmet` defines no type
// filter and answers HTTP 200 while dropping query keys it does not recognize,
// so an inert `type=` key reads as a filter that ran
// ---------------------------------------------------------------------------

describe('AviationWeatherService advisory request construction', () => {
  it.each(['sigmet', 'all'] as const)('sends no type filter for %s', async (advisoryType) => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([]));
    await svc.fetchAdvisories({ advisoryType }, createMockContext());

    const url = lastRequestUrl();
    expect(url).toContain('/airsigmet?format=json');
    expect(url).not.toContain('type=');
    expect(url).not.toContain('types=');
  });
});

// ---------------------------------------------------------------------------
// Pre-filter row count (issue #11) — the 400-row cap applies to the draw, and
// the state mode cuts that draw again in here, so the caller cannot recover the
// drawn size from what it gets back
// ---------------------------------------------------------------------------

describe('AviationWeatherService pre-filter row count', () => {
  it('reports the drawn row count ahead of the state filter', async () => {
    // KBWI is outside WA and is filtered away, so the returned length is 1
    // while the draw the cap applied to was 2.
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationKSEA, rawStationKBWI]));
    const onPreFilterRows = vi.fn();
    const stations = await svc.fetchStations({ state: 'WA', onPreFilterRows }, createMockContext());

    expect(onPreFilterRows).toHaveBeenCalledWith(2);
    expect(stations).toHaveLength(1);
  });

  it('reports a drawn count of zero when the filter empties a non-empty draw', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationKBWI]));
    const onPreFilterRows = vi.fn();
    const stations = await svc.fetchStations({ state: 'WA', onPreFilterRows }, createMockContext());

    expect(onPreFilterRows).toHaveBeenCalledWith(1);
    expect(stations).toHaveLength(0);
  });

  it('stays silent in the bbox mode, whose draw is returned unfiltered', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationKSEA, rawStationKBWI]));
    const onPreFilterRows = vi.fn();
    await svc.fetchStations(
      { bbox: { minLat: 25, minLon: -125, maxLat: 49, maxLon: -66 }, onPreFilterRows },
      createMockContext(),
    );

    expect(onPreFilterRows).not.toHaveBeenCalled();
  });

  it('stays silent in the station_ids mode, whose draw is returned unfiltered', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationKSEA]));
    const onPreFilterRows = vi.fn();
    await svc.fetchStations({ stationIds: ['KSEA'], onPreFilterRows }, createMockContext());

    expect(onPreFilterRows).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sky condition (issue #27) — AWC encodes no layer for a group that carries no
// height, so a clear report and a report that stated nothing arrive alike
// ---------------------------------------------------------------------------

describe('AviationWeatherService METAR sky condition', () => {
  /** Normalize one raw METAR through the real service path. */
  async function normalize(overrides: Partial<RawMetar>) {
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawMetarKDEN, ...overrides }]),
    );
    const [obs] = await svc.fetchMetar(['KDEN'], 1, createMockContext());
    return obs!;
  }

  it.each(['CLR', 'SKC', 'CAVOK'])(
    'reads a %s report off the record rather than the raw observation',
    async (cover) => {
      const obs = await normalize({ clouds: [], cover });

      expect(obs.clouds).toEqual([]);
      expect(obs.sky_condition).toBe(cover);
    },
  );

  it('reports an observation carrying no sky-condition group as unreported', async () => {
    // `METAR KJDN 131048Z AUTO 03008KT 14/12 A3002 RMK AO1` — AWC omits the
    // `cover` key entirely rather than sending null, so the read must be on
    // absence, not on a null literal. 97 of 1,849 distinct live records.
    const { cover: _dropped, ...withoutCover } = rawMetarKDEN;
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([
        {
          ...withoutCover,
          clouds: [],
          rawOb: 'METAR KJDN 131048Z AUTO 03008KT 14/12 A3002 RMK AO1 SLP155 P0006 T0139',
        },
      ]),
    );
    const [obs] = await svc.fetchMetar(['KJDN'], 1, createMockContext());

    expect(obs!.clouds).toEqual([]);
    expect(obs!.sky_condition).toBeNull();
  });

  it('reads a degraded sky group as unreported rather than as a condition', async () => {
    // `METAR LFAC 092330Z AUTO 16003KT 9999 ////// 13/12 Q1019` — the sensor
    // could not report, and AWC omits `cover` exactly as it does for a station
    // that sent no group at all. 16 of the 97 unreported records.
    const obs = await normalize({
      clouds: [],
      cover: null,
      rawOb: 'METAR LFAC 092330Z AUTO 16003KT 9999 ////// 13/12 Q1019',
    });

    expect(obs.sky_condition).toBeNull();
  });

  it('reads an indeterminate obscuration as obscured, not as an absent sky', async () => {
    // `METAR WBGG 092300Z 00000KT 2000 HZ VV/// 24/24 Q1009`, reported IFR:
    // `VV///` publishes no layer and no vertVis, so the empty cloud array here
    // means the opposite of a clear sky.
    const obs = await normalize({
      clouds: [],
      cover: 'OVX',
      vertVis: null,
      fltCat: 'IFR',
      rawOb: 'METAR WBGG 092300Z 00000KT 2000 HZ VV/// 24/24 Q1009 NOSIG',
    });

    expect(obs.sky_condition).toBe('OVX');
    expect(obs.ceiling_ft).toBeNull();
  });

  it.each(['FEW', 'SCT', 'BKN', 'OVC'])(
    'states no separate sky condition when a %s layer carries the report',
    async (cover) => {
      const obs = await normalize({ clouds: [{ cover, base: 3000 }], cover });

      expect(obs.clouds).toEqual([{ cover, base_ft: 3000 }]);
      expect(obs.sky_condition).toBeNull();
    },
  );

  it('treats a blank cover as unreported rather than as a condition', async () => {
    const obs = await normalize({ clouds: [], cover: '   ' });

    expect(obs.sky_condition).toBeNull();
  });
});

describe('AviationWeatherService TAF sky condition', () => {
  /** Normalize one raw TAF forecast period through the real service path. */
  async function normalize(overrides: Partial<RawTafForecastPeriod>) {
    const period = { ...rawTafKSEA.fcsts[0]!, ...overrides };
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      jsonResponse([{ ...rawTafKSEA, fcsts: [period] }]),
    );
    const [taf] = await svc.fetchTaf(['KSEA'], createMockContext());
    return taf!.forecast_periods[0]!;
  }

  it.each(['SKC', 'NSC'])(
    'states a baseless %s layer as the period sky condition',
    async (cover) => {
      // 546 of the 723 live periods that normalize to no layers are one of
      // these — a forecast clear sky, published as a cover with no height.
      const period = await normalize({ clouds: [{ base: null, cover, type: null }] });

      expect(period.clouds).toEqual([]);
      expect(period.sky_condition).toBe(cover);
    },
  );

  it.each([null, []])(
    'reports %p upstream clouds as forecasting nothing about cloud',
    async (clouds) => {
      // A TEMPO or PROB group amending only visibility or weather. The
      // prevailing forecast's cloud stands; nothing here says it will be clear.
      const period = await normalize({ clouds, fcstChange: 'TEMPO' });

      expect(period.clouds).toEqual([]);
      expect(period.sky_condition).toBeNull();
    },
  );

  it('states no separate sky condition when the period carries real layers', async () => {
    const period = await normalize({
      clouds: [
        { base: 800, cover: 'OVC', type: null },
        { base: 1500, cover: 'BKN', type: 'CB' },
      ],
    });

    expect(period.sky_condition).toBeNull();
  });

  it('states no separate sky condition on an obscuration that kept its height', async () => {
    // The OVX layer takes its base from vertVis and renders as a layer, so the
    // period has a height to publish and needs no group beside it.
    const period = await normalize({
      clouds: [{ base: null, cover: 'OVX', type: null }],
      vertVis: 200,
    });

    expect(period.clouds).toEqual([{ cover: 'OVX', base_ft: 200, type: null }]);
    expect(period.sky_condition).toBeNull();
  });

  it('keeps a clear-sky forecast distinguishable from a vertVis carried onto it', async () => {
    // Live CYXU: `... 3/8SM FG VV001 BECMG 1312/1314 P6SM NSW SKC`. The BECMG
    // group forecasts a clearing sky while upstream repeats the base period's
    // vertVis onto it — the SKC must read as clear, not as a 100 ft ceiling.
    const period = await normalize({
      clouds: [{ base: null, cover: 'SKC', type: null }],
      vertVis: 100,
      fcstChange: 'BECMG',
    });

    expect(period.clouds).toEqual([]);
    expect(period.vertical_visibility_ft).toBeNull();
    expect(period.sky_condition).toBe('SKC');
  });

  it('carries a standalone probability group as its own change indicator', async () => {
    // A probability group with no temporary group after it — live KLRD, KCMH,
    // KABI, CYSC, CYQB. AWC reports it as PROB in its own right; only a
    // probability qualifying a temporary group folds into TEMPO. Across 2,416
    // live periods from three regional boxes the indicators tally null 648, FM
    // 986, TEMPO 378, BECMG 287, PROB 117 — roughly one period in twenty.
    const period = await normalize({ clouds: null, fcstChange: 'PROB', probability: 30 });

    expect(period).toMatchObject({
      change_type: 'PROB',
      probability: 30,
      clouds: [],
      sky_condition: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Station reconciliation key (issue #31) — the registry's own `id` is the only
// identifier every entry carries, and the only one a lookup resolves against
// ---------------------------------------------------------------------------

describe('AviationWeatherService station identifiers', () => {
  it('carries the registry ID through normalization', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationKSEA]));
    const [station] = await svc.fetchStations({ stationIds: ['KSEA'] }, createMockContext());

    expect(station!.id).toBe('KSEA');
  });

  it('carries the registry ID for an entry with no ICAO, IATA, or FAA identifier', async () => {
    // 375 of 1,600 rows across four live bbox draws look like this, and a
    // lookup by that ID resolves — so `icao_id` cannot be the reconciliation key.
    vi.mocked(fetchWithTimeout).mockResolvedValue(jsonResponse([rawStationWASD2]));
    const [station] = await svc.fetchStations({ stationIds: ['WASD2'] }, createMockContext());

    expect(station!.id).toBe('WASD2');
    expect(station!.icao_id).toBeNull();
  });
});
