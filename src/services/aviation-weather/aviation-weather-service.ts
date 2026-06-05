/**
 * @fileoverview Aviation Weather Center (AWC) Data API service.
 * Wraps aviationweather.gov/api/data with retry, timeout, and response normalization.
 * @module services/aviation-weather/aviation-weather-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  NormalizedAdvisory,
  NormalizedIcingLayer,
  NormalizedMetar,
  NormalizedPirep,
  NormalizedStation,
  NormalizedTaf,
  NormalizedTafPeriod,
  NormalizedTurbulenceLayer,
  RawAirSigmet,
  RawCloudLayer,
  RawMetar,
  RawPirep,
  RawStationInfo,
  RawTaf,
  RawTafForecastPeriod,
} from './types.js';

// ---------------------------------------------------------------------------
// Weather code decoder
// ---------------------------------------------------------------------------

/** Map of common wx codes to plain English descriptions. */
const WX_CODE_MAP: Record<string, string> = {
  RA: 'rain',
  SN: 'snow',
  DZ: 'drizzle',
  GR: 'hail',
  GS: 'small hail',
  SG: 'snow grains',
  IC: 'ice crystals',
  PL: 'ice pellets',
  FZRA: 'freezing rain',
  FZDZ: 'freezing drizzle',
  RASN: 'rain and snow',
  TS: 'thunderstorm',
  TSRA: 'thunderstorm with rain',
  TSSN: 'thunderstorm with snow',
  TSPL: 'thunderstorm with ice pellets',
  TSGR: 'thunderstorm with hail',
  SH: 'showers',
  SHRA: 'rain showers',
  SHSN: 'snow showers',
  SHPL: 'ice pellet showers',
  SHGR: 'hail showers',
  FG: 'fog',
  FZFG: 'freezing fog',
  MIFG: 'shallow fog',
  BCFG: 'patchy fog',
  PRFG: 'partial fog',
  BR: 'mist',
  HZ: 'haze',
  FU: 'smoke',
  DU: 'dust',
  SA: 'sand',
  VA: 'volcanic ash',
  PO: 'dust/sand whirls',
  SQ: 'squalls',
  FC: 'funnel cloud',
  SS: 'sandstorm',
  DS: 'duststorm',
  BLSN: 'blowing snow',
  DRSN: 'drifting snow',
  BLDU: 'blowing dust',
  BLSA: 'blowing sand',
};

/**
 * Decodes a wx group string (e.g., '-SHRA') to plain English.
 * Returns null if input is null/empty.
 */
function decodeWxString(wxString: string | null | undefined): string | null {
  if (!wxString) return null;
  let decoded = wxString;
  // Strip intensity prefix
  let intensity = '';
  if (decoded.startsWith('-')) {
    intensity = 'light ';
    decoded = decoded.slice(1);
  } else if (decoded.startsWith('+')) {
    intensity = 'heavy ';
    decoded = decoded.slice(1);
  } else if (decoded.startsWith('VC')) {
    intensity = 'in vicinity: ';
    decoded = decoded.slice(2);
  }

  // Look up the code
  const description = WX_CODE_MAP[decoded] ?? decoded;
  return `${intensity}${description}`.trim();
}

// ---------------------------------------------------------------------------
// State bounding boxes for the state→bbox workaround
// ---------------------------------------------------------------------------

/** Approximate bounding boxes per US state for the stationinfo state query workaround. */
const STATE_BBOXES: Record<
  string,
  { minLat: number; minLon: number; maxLat: number; maxLon: number }
> = {
  AL: { minLat: 30.1, minLon: -88.5, maxLat: 35.0, maxLon: -84.9 },
  AK: { minLat: 51.0, minLon: -180.0, maxLat: 71.5, maxLon: -129.0 },
  AZ: { minLat: 31.3, minLon: -114.8, maxLat: 37.0, maxLon: -109.0 },
  AR: { minLat: 33.0, minLon: -94.6, maxLat: 36.5, maxLon: -89.6 },
  CA: { minLat: 32.5, minLon: -124.5, maxLat: 42.0, maxLon: -114.1 },
  CO: { minLat: 36.9, minLon: -109.1, maxLat: 41.0, maxLon: -102.0 },
  CT: { minLat: 40.9, minLon: -73.7, maxLat: 42.1, maxLon: -71.8 },
  DE: { minLat: 38.4, minLon: -75.8, maxLat: 39.8, maxLon: -75.0 },
  FL: { minLat: 24.4, minLon: -87.6, maxLat: 31.0, maxLon: -80.0 },
  GA: { minLat: 30.3, minLon: -85.6, maxLat: 35.0, maxLon: -80.8 },
  HI: { minLat: 18.9, minLon: -160.2, maxLat: 22.2, maxLon: -154.8 },
  ID: { minLat: 41.9, minLon: -117.2, maxLat: 49.0, maxLon: -111.0 },
  IL: { minLat: 36.9, minLon: -91.5, maxLat: 42.5, maxLon: -87.5 },
  IN: { minLat: 37.7, minLon: -88.1, maxLat: 41.8, maxLon: -84.8 },
  IA: { minLat: 40.3, minLon: -96.6, maxLat: 43.5, maxLon: -90.1 },
  KS: { minLat: 36.9, minLon: -102.1, maxLat: 40.0, maxLon: -94.6 },
  KY: { minLat: 36.5, minLon: -89.6, maxLat: 39.1, maxLon: -81.9 },
  LA: { minLat: 28.9, minLon: -94.0, maxLat: 33.0, maxLon: -88.8 },
  ME: { minLat: 43.0, minLon: -71.1, maxLat: 47.5, maxLon: -66.9 },
  MD: { minLat: 37.9, minLon: -79.5, maxLat: 39.7, maxLon: -75.0 },
  MA: { minLat: 41.2, minLon: -73.5, maxLat: 42.9, maxLon: -69.9 },
  MI: { minLat: 41.7, minLon: -90.4, maxLat: 48.2, maxLon: -82.1 },
  MN: { minLat: 43.5, minLon: -97.2, maxLat: 49.4, maxLon: -89.5 },
  MS: { minLat: 30.1, minLon: -91.7, maxLat: 35.0, maxLon: -88.1 },
  MO: { minLat: 35.9, minLon: -95.8, maxLat: 40.6, maxLon: -89.1 },
  MT: { minLat: 44.4, minLon: -116.1, maxLat: 49.0, maxLon: -104.0 },
  NE: { minLat: 39.9, minLon: -104.1, maxLat: 43.0, maxLon: -95.3 },
  NV: { minLat: 35.0, minLon: -120.0, maxLat: 42.0, maxLon: -114.0 },
  NH: { minLat: 42.7, minLon: -72.6, maxLat: 45.3, maxLon: -70.6 },
  NJ: { minLat: 38.9, minLon: -75.6, maxLat: 41.4, maxLon: -73.9 },
  NM: { minLat: 31.3, minLon: -109.1, maxLat: 37.0, maxLon: -103.0 },
  NY: { minLat: 40.5, minLon: -79.8, maxLat: 45.0, maxLon: -71.9 },
  NC: { minLat: 33.8, minLon: -84.3, maxLat: 36.6, maxLon: -75.5 },
  ND: { minLat: 45.9, minLon: -104.1, maxLat: 49.0, maxLon: -96.6 },
  OH: { minLat: 38.4, minLon: -84.8, maxLat: 42.3, maxLon: -80.5 },
  OK: { minLat: 33.6, minLon: -103.0, maxLat: 37.0, maxLon: -94.4 },
  OR: { minLat: 41.9, minLon: -124.6, maxLat: 46.3, maxLon: -116.5 },
  PA: { minLat: 39.7, minLon: -80.5, maxLat: 42.3, maxLon: -74.7 },
  RI: { minLat: 41.1, minLon: -71.9, maxLat: 42.0, maxLon: -71.1 },
  SC: { minLat: 32.0, minLon: -83.4, maxLat: 35.2, maxLon: -78.5 },
  SD: { minLat: 42.4, minLon: -104.1, maxLat: 45.9, maxLon: -96.4 },
  TN: { minLat: 34.9, minLon: -90.3, maxLat: 36.7, maxLon: -81.6 },
  TX: { minLat: 25.8, minLon: -106.7, maxLat: 36.5, maxLon: -93.5 },
  UT: { minLat: 36.9, minLon: -114.1, maxLat: 42.0, maxLon: -109.0 },
  VT: { minLat: 42.7, minLon: -73.4, maxLat: 45.0, maxLon: -71.5 },
  VA: { minLat: 36.5, minLon: -83.7, maxLat: 39.5, maxLon: -75.2 },
  WA: { minLat: 45.5, minLon: -124.8, maxLat: 49.0, maxLon: -116.9 },
  WV: { minLat: 37.2, minLon: -82.7, maxLat: 40.6, maxLon: -77.7 },
  WI: { minLat: 42.5, minLon: -92.9, maxLat: 47.1, maxLon: -86.2 },
  WY: { minLat: 40.9, minLon: -111.1, maxLat: 45.1, maxLon: -104.0 },
};

// ---------------------------------------------------------------------------
// Helper: normalize a raw cloud layer array
// ---------------------------------------------------------------------------

function normalizeClouds(
  clouds: RawCloudLayer[] | null | undefined,
): { cover: string; base_ft: number }[] {
  if (!clouds || clouds.length === 0) return [];
  return clouds
    .filter((c) => c.base != null)
    .map((c) => ({ cover: c.cover, base_ft: c.base as number }));
}

/** Compute ceiling (lowest BKN or OVC layer) from normalized cloud layers. */
function computeCeiling(clouds: { cover: string; base_ft: number }[]): number | null {
  const ceilingLayers = clouds.filter((c) => c.cover === 'BKN' || c.cover === 'OVC');
  if (ceilingLayers.length === 0) return null;
  return Math.min(...ceilingLayers.map((c) => c.base_ft));
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeMetar(raw: RawMetar): NormalizedMetar {
  const clouds = normalizeClouds(raw.clouds);
  const visib =
    raw.visib == null ? 'unknown' : typeof raw.visib === 'string' ? raw.visib : String(raw.visib);

  return {
    station_id: raw.icaoId,
    name: raw.name ?? raw.icaoId,
    lat: raw.lat,
    lon: raw.lon,
    elevation_ft: raw.elev ?? 0,
    flight_category: raw.fltCat ?? 'unknown',
    metar_type: raw.metarType ?? 'METAR',
    observed_at: new Date(raw.obsTime * 1000).toISOString(),
    wind: {
      direction_deg: typeof raw.wdir === 'number' ? raw.wdir : null,
      speed_kt: raw.wspd ?? 0,
      gust_kt: raw.wgst ?? null,
    },
    visibility_sm: visib,
    ceiling_ft: computeCeiling(clouds),
    clouds,
    temp_c: raw.temp ?? 0,
    dewpoint_c: raw.dewp ?? 0,
    altimeter_inhg: raw.altim ?? 0,
    raw_metar: raw.rawOb,
  };
}

function normalizeTafPeriod(p: RawTafForecastPeriod): NormalizedTafPeriod {
  const clouds =
    p.clouds
      ?.filter((c) => c.base != null)
      .map((c) => ({ cover: c.cover, base_ft: c.base as number, type: c.type ?? null })) ?? [];
  const visib = p.visib == null ? null : typeof p.visib === 'string' ? p.visib : String(p.visib);

  return {
    from: new Date(p.timeFrom * 1000).toISOString(),
    to: new Date(p.timeTo * 1000).toISOString(),
    change_type: p.fcstChange ?? null,
    probability: p.probability ?? null,
    wind: {
      direction_deg: typeof p.wdir === 'number' ? p.wdir : null,
      speed_kt: p.wspd ?? 0,
      gust_kt: p.wgst ?? null,
    },
    visibility_sm: visib,
    weather: decodeWxString(p.wxString),
    clouds,
  };
}

function normalizeTaf(raw: RawTaf): NormalizedTaf {
  return {
    station_id: raw.icaoId,
    name: raw.name ?? raw.icaoId,
    issued_at: raw.issueTime,
    valid_from: new Date(raw.validTimeFrom * 1000).toISOString(),
    valid_to: new Date(raw.validTimeTo * 1000).toISOString(),
    forecast_periods: (raw.fcsts ?? []).map(normalizeTafPeriod),
    raw_taf: raw.rawTAF,
  };
}

function normalizePirep(raw: RawPirep): NormalizedPirep {
  // Build turbulence layers — omit entries with empty intensity
  const turbulence: NormalizedTurbulenceLayer[] = [];
  if (raw.tbInt1 && raw.tbInt1.trim()) {
    turbulence.push({
      base_ft: typeof raw.tbBas1 === 'number' ? raw.tbBas1 * 100 : null,
      top_ft: typeof raw.tbTop1 === 'number' ? raw.tbTop1 * 100 : null,
      intensity: raw.tbInt1,
      type: raw.tbType1 ?? null,
      frequency: raw.tbFreq1 ?? null,
    });
  }
  if (raw.tbInt2 && raw.tbInt2.trim()) {
    turbulence.push({
      base_ft: typeof raw.tbBas2 === 'number' ? raw.tbBas2 * 100 : null,
      top_ft: typeof raw.tbTop2 === 'number' ? raw.tbTop2 * 100 : null,
      intensity: raw.tbInt2,
      type: raw.tbType2 ?? null,
      frequency: raw.tbFreq2 ?? null,
    });
  }

  // Build icing layers — omit entries with empty intensity
  const icing: NormalizedIcingLayer[] = [];
  if (raw.icgInt1 && raw.icgInt1.trim()) {
    icing.push({
      base_ft: typeof raw.icgBas1 === 'number' ? raw.icgBas1 * 100 : null,
      top_ft: typeof raw.icgTop1 === 'number' ? raw.icgTop1 * 100 : null,
      intensity: raw.icgInt1,
      type: raw.icgType1 ?? null,
    });
  }
  if (raw.icgInt2 && raw.icgInt2.trim()) {
    icing.push({
      base_ft: typeof raw.icgBas2 === 'number' ? raw.icgBas2 * 100 : null,
      top_ft: typeof raw.icgTop2 === 'number' ? raw.icgTop2 * 100 : null,
      intensity: raw.icgInt2,
      type: raw.icgType2 ?? null,
    });
  }

  // Clouds
  const clouds =
    raw.clouds && raw.clouds.length > 0
      ? raw.clouds
          .filter((c) => c.base != null && c.top != null)
          .map((c) => ({ cover: c.cover, base_ft: c.base as number, top_ft: c.top as number }))
      : null;

  const altitudeFt =
    raw.fltLvl != null
      ? raw.fltLvl < 1000
        ? raw.fltLvl * 100 // flight level (e.g., 270 → 27000)
        : raw.fltLvl // already in feet for low-altitude reports
      : 0;

  const visib =
    raw.visib == null
      ? null
      : typeof raw.visib === 'number'
        ? raw.visib
        : Number(raw.visib) || null;

  return {
    observed_at: new Date(raw.obsTime * 1000).toISOString(),
    lat: raw.lat,
    lon: raw.lon,
    altitude_ft: altitudeFt,
    aircraft_type: raw.acType ?? null,
    pirep_type: raw.pirepType ?? 'PIREP',
    turbulence,
    icing,
    clouds: clouds && clouds.length > 0 ? clouds : null,
    visibility_sm: visib,
    remarks: raw.wxString ?? null,
    raw_pirep: raw.rawOb,
  };
}

function normalizeAdvisory(raw: RawAirSigmet): NormalizedAdvisory {
  const movement =
    raw.movementDir != null || raw.movementSpd != null
      ? { direction_deg: raw.movementDir ?? null, speed_kt: raw.movementSpd ?? null }
      : null;

  return {
    advisory_type: raw.airSigmetType ?? 'SIGMET',
    series_id: raw.seriesId,
    hazard: raw.hazard ?? 'UNKNOWN',
    severity: raw.severity ?? null,
    issued_by: raw.icaoId,
    valid_from: new Date(raw.validTimeFrom * 1000).toISOString(),
    valid_to: new Date(raw.validTimeTo * 1000).toISOString(),
    altitude_low_ft: raw.altitudeLow1 ?? null,
    altitude_high_ft: raw.altitudeHi1 ?? null,
    movement,
    polygon: raw.coords ?? [],
    raw_text: raw.rawAirSigmet,
  };
}

function normalizeStation(raw: RawStationInfo): NormalizedStation {
  return {
    icao_id: raw.icaoId || null,
    iata_id: raw.iataId || null,
    faa_id: raw.faaId || null,
    name: raw.site,
    lat: raw.lat,
    lon: raw.lon,
    elevation_ft: raw.elev ?? 0,
    state: raw.state ?? '',
    country: raw.country ?? '',
    data_types: raw.siteType ?? [],
  };
}

// ---------------------------------------------------------------------------
// bbox overlap check for advisory filtering
// ---------------------------------------------------------------------------

function bboxOverlapsPolygon(
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  polygon: { lat: number; lon: number }[],
): boolean {
  if (!polygon || polygon.length === 0) return false;
  // Simple bounding-box overlap: check if any polygon point is in the bbox,
  // or if the polygon bounding box overlaps the query bbox.
  const polyMinLat = Math.min(...polygon.map((p) => p.lat));
  const polyMaxLat = Math.max(...polygon.map((p) => p.lat));
  const polyMinLon = Math.min(...polygon.map((p) => p.lon));
  const polyMaxLon = Math.max(...polygon.map((p) => p.lon));

  return !(
    polyMaxLat < bbox.minLat ||
    polyMinLat > bbox.maxLat ||
    polyMaxLon < bbox.minLon ||
    polyMinLon > bbox.maxLon
  );
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/** Aviation Weather Center (AWC) Data API service. */
export class AviationWeatherService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverConfig = getServerConfig();
    this.baseUrl = serverConfig.awcBaseUrl;
    this.timeoutMs = serverConfig.awcTimeoutMs;
  }

  /** Fetch and parse JSON from the AWC API with retry and timeout. */
  private async fetchJson<T>(url: string, ctx: Context): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(
          url,
          this.timeoutMs,
          { requestId: ctx.requestId, timestamp: ctx.timestamp },
          { signal: ctx.signal },
        );
        const text = await response.text();
        // Detect HTML error pages from upstream
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'AWC API returned HTML instead of JSON — service may be degraded.',
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw serviceUnavailable(`AWC API returned invalid JSON: ${text.slice(0, 200)}`);
        }
        // Check for AWC error shape: { "status": "error", "error": "..." }
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'status' in parsed &&
          (parsed as Record<string, unknown>)['status'] === 'error'
        ) {
          const errMsg = (parsed as Record<string, unknown>)['error'];
          throw serviceUnavailable(
            `AWC API error: ${typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)}`,
          );
        }
        return parsed as T;
      },
      {
        operation: 'AviationWeatherService.fetchJson',
        context: { requestId: ctx.requestId, timestamp: ctx.timestamp },
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch METARs for one or more ICAO station IDs. */
  async fetchMetar(stationIds: string[], hours: number, ctx: Context): Promise<NormalizedMetar[]> {
    const ids = stationIds.join(',');
    const url = `${this.baseUrl}/metar?ids=${encodeURIComponent(ids)}&format=json&hours=${hours}`;
    ctx.log.debug('Fetching METARs', { ids, hours });
    const raw = await this.fetchJson<RawMetar[]>(url, ctx);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeMetar);
  }

  /** Fetch TAFs for one or more ICAO station IDs. */
  async fetchTaf(stationIds: string[], ctx: Context): Promise<NormalizedTaf[]> {
    const ids = stationIds.join(',');
    const url = `${this.baseUrl}/taf?ids=${encodeURIComponent(ids)}&format=json`;
    ctx.log.debug('Fetching TAFs', { ids });
    const raw = await this.fetchJson<RawTaf[]>(url, ctx);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeTaf);
  }

  /** Fetch PIREPs for a station + distance, or bbox. */
  async fetchPireps(
    params: {
      stationId?: string;
      bbox?: { minLat: number; minLon: number; maxLat: number; maxLon: number };
      distanceNm: number;
      hours: number;
    },
    ctx: Context,
  ): Promise<NormalizedPirep[]> {
    let url: string;
    if (params.stationId) {
      url = `${this.baseUrl}/pirep?id=${encodeURIComponent(params.stationId)}&format=json&distance=${params.distanceNm}&hours=${params.hours}`;
    } else if (params.bbox) {
      const { minLat, minLon, maxLat, maxLon } = params.bbox;
      url = `${this.baseUrl}/pirep?bbox=${minLat},${minLon},${maxLat},${maxLon}&format=json&hours=${params.hours}`;
    } else {
      throw serviceUnavailable('Either stationId or bbox is required for PIREPs');
    }
    ctx.log.debug('Fetching PIREPs', { url });
    const raw = await this.fetchJson<RawPirep[]>(url, ctx);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizePirep);
  }

  /** Fetch active SIGMETs/AIRMETs, optionally filtered by type and/or bbox. */
  async fetchAdvisories(
    params: {
      advisoryType: 'sigmet' | 'airmet' | 'all';
      hazard?: string;
      bbox?: { minLat: number; minLon: number; maxLat: number; maxLon: number };
    },
    ctx: Context,
  ): Promise<NormalizedAdvisory[]> {
    let url = `${this.baseUrl}/airsigmet?format=json`;
    if (params.advisoryType !== 'all') {
      url += `&type=${params.advisoryType}`;
    }
    ctx.log.debug('Fetching advisories', { advisoryType: params.advisoryType });
    const raw = await this.fetchJson<RawAirSigmet[]>(url, ctx);
    if (!Array.isArray(raw)) return [];

    let advisories = raw.map(normalizeAdvisory);

    // Client-side hazard filter
    if (params.hazard) {
      const hazardUpper = params.hazard.toUpperCase();
      advisories = advisories.filter((a) => a.hazard.toUpperCase().includes(hazardUpper));
    }

    // Client-side bbox overlap filter
    if (params.bbox) {
      advisories = advisories.filter((a) => bboxOverlapsPolygon(params.bbox!, a.polygon));
    }

    return advisories;
  }

  /** Fetch station info by ICAO IDs, bbox, or US state. */
  async fetchStations(
    params: {
      stationIds?: string[];
      bbox?: { minLat: number; minLon: number; maxLat: number; maxLon: number };
      state?: string;
    },
    ctx: Context,
  ): Promise<NormalizedStation[]> {
    let url: string;
    let stateFilter: string | undefined;

    if (params.stationIds && params.stationIds.length > 0) {
      const ids = params.stationIds.join(',');
      url = `${this.baseUrl}/stationinfo?ids=${encodeURIComponent(ids)}&format=json`;
    } else if (params.bbox) {
      const { minLat, minLon, maxLat, maxLon } = params.bbox;
      url = `${this.baseUrl}/stationinfo?bbox=${minLat},${minLon},${maxLat},${maxLon}&format=json`;
    } else if (params.state) {
      // State→bbox workaround: API does not support state parameter directly
      const stateUpper = params.state.toUpperCase();
      const bbox = STATE_BBOXES[stateUpper];
      if (!bbox) {
        throw serviceUnavailable(`No bounding box available for state: ${params.state}`);
      }
      url = `${this.baseUrl}/stationinfo?bbox=${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}&format=json`;
      stateFilter = stateUpper;
    } else {
      throw serviceUnavailable('Either stationIds, bbox, or state is required for station lookup');
    }

    ctx.log.debug('Fetching station info', { url });
    const raw = await this.fetchJson<RawStationInfo[]>(url, ctx);
    if (!Array.isArray(raw)) return [];

    let stations = raw.map(normalizeStation);

    // Client-side state filter when using the bbox workaround
    if (stateFilter) {
      stations = stations.filter((s) => s.state && s.state.toUpperCase() === stateFilter);
    }

    return stations;
  }
}

// ---------------------------------------------------------------------------
// Init / accessor pattern
// ---------------------------------------------------------------------------

let _service: AviationWeatherService | undefined;

/** Initialize the AviationWeatherService. Call once in createApp setup(). */
export function initAviationWeatherService(config: AppConfig, storage: StorageService): void {
  _service = new AviationWeatherService(config, storage);
}

/** Returns the singleton AviationWeatherService. Throws if not initialized. */
export function getAviationWeatherService(): AviationWeatherService {
  if (!_service) {
    throw new Error(
      'AviationWeatherService not initialized — call initAviationWeatherService() in setup()',
    );
  }
  return _service;
}
