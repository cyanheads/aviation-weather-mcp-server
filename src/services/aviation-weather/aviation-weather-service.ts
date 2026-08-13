/**
 * @fileoverview Aviation Weather Center (AWC) Data API service.
 * Wraps aviationweather.gov/api/data with retry, timeout, and response normalization.
 * @module services/aviation-weather/aviation-weather-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { STATE_BBOXES } from './state-bboxes.js';
import type {
  MetarCeilingType,
  NormalizedAdvisory,
  NormalizedCloudLayer,
  NormalizedIcingLayer,
  NormalizedMetar,
  NormalizedPirep,
  NormalizedPresentWeather,
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

/**
 * Present weather as both the raw group and its decoded reading. TAF carries
 * only the decoded form; METAR keeps the raw group too, so a compound group the
 * decoder does not split (`+RA BR`) stays recoverable without re-parsing the
 * raw observation.
 */
function normalizePresentWeather(
  wxString: string | null | undefined,
): NormalizedPresentWeather | null {
  const raw = wxString?.trim();
  const decoded = decodeWxString(raw);
  return raw && decoded ? { raw, decoded } : null;
}

// ---------------------------------------------------------------------------
// Helper: normalize a raw cloud layer array
// ---------------------------------------------------------------------------

/**
 * Aerodrome cloud bases arrive from AWC already in feet AGL (a `BKN030` group
 * decodes to `base: 3000` above the field). Pass them through unchanged — adding
 * station elevation would convert a correct AGL height into a wrong MSL one.
 */
function normalizeClouds(clouds: RawCloudLayer[] | null | undefined): NormalizedCloudLayer[] {
  if (!clouds || clouds.length === 0) return [];
  return clouds
    .filter((c) => c.base != null)
    .map((c) => ({ cover: c.cover, base_ft: c.base as number }));
}

/**
 * The decoded form of a `VVhhh` group — the sky is obscured and the height is
 * how far up a pilot can see into it, not a layer bottom.
 */
const OBSCURATION_COVER = 'OVX';

/**
 * Sky covers that constitute a ceiling. FAA AIM 7-1-13, on METAR sky condition:
 * "A ceiling layer is not designated in the METAR code. For aviation purposes,
 * the ceiling is the lowest broken or overcast layer, or vertical visibility
 * into an obscuration." Few and scattered layers are not ceilings.
 */
const CEILING_COVERS = new Set(['BKN', 'OVC', OBSCURATION_COVER]);

/**
 * Convert METAR `vertVis` to feet. This endpoint publishes the `VVhhh` group's
 * own hundreds-of-feet value — `VV002` arrives as `2` beside a `clouds[].base`
 * of 200 — despite the AWC schema documenting the field as feet. The TAF
 * endpoint publishes it in feet, so this conversion is METAR-only: applying it
 * there, or omitting it here, is wrong by a factor of 100 either way.
 */
function verticalVisibilityFeet(vertVis: number | null | undefined): number | null {
  return vertVis != null ? vertVis * 100 : null;
}

/**
 * Ceiling height and kind from the normalized cloud layers, in feet AGL. The
 * lowest qualifying layer wins regardless of cover. `vertVisFt` backstops an
 * obscuration AWC published with no layer base, which `normalizeClouds` drops
 * and would otherwise leave an obscured sky reading as no ceiling at all.
 */
function computeCeiling(
  clouds: NormalizedCloudLayer[],
  vertVisFt: number | null,
): { ceiling_ft: number | null; ceiling_type: MetarCeilingType | null } {
  const layers = clouds.filter((c) => CEILING_COVERS.has(c.cover));
  if (layers.length === 0) {
    return vertVisFt != null
      ? { ceiling_ft: vertVisFt, ceiling_type: 'indefinite' }
      : { ceiling_ft: null, ceiling_type: null };
  }
  const lowest = layers.reduce((a, b) => (b.base_ft < a.base_ft ? b : a));
  return {
    ceiling_ft: lowest.base_ft,
    ceiling_type: lowest.cover === OBSCURATION_COVER ? 'indefinite' : 'measured',
  };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * Convert meters to whole feet. The AWC API reports station/observation
 * elevation in meters (the `elev` field); every output surface renders feet.
 */
function metersToFeet(meters: number): number {
  return Math.round(meters * 3.28084);
}

function normalizeMetar(raw: RawMetar): NormalizedMetar {
  const clouds = normalizeClouds(raw.clouds);
  const visib =
    raw.visib == null ? 'unknown' : typeof raw.visib === 'string' ? raw.visib : String(raw.visib);

  return {
    station_id: raw.icaoId,
    name: raw.name ?? raw.icaoId,
    lat: raw.lat,
    lon: raw.lon,
    elevation_ft: raw.elev != null ? metersToFeet(raw.elev) : 0,
    flight_category: raw.fltCat ?? 'unknown',
    metar_type: raw.metarType ?? 'METAR',
    observed_at: new Date(raw.obsTime * 1000).toISOString(),
    wind: {
      direction_deg: typeof raw.wdir === 'number' ? raw.wdir : null,
      speed_kt: raw.wspd ?? null,
      gust_kt: raw.wgst ?? null,
    },
    visibility_sm: visib,
    // ceiling_ft and ceiling_type are one measurement — a height is meaningless
    // without knowing whether it was measured or seen up into an obscuration.
    ...computeCeiling(clouds, verticalVisibilityFeet(raw.vertVis)),
    clouds,
    present_weather: normalizePresentWeather(raw.wxString),
    temp_c: raw.temp ?? null,
    dewpoint_c: raw.dewp ?? null,
    // AWC API returns altim in hPa — convert to inHg (1 hPa = 0.02953 inHg)
    altimeter_inhg: raw.altim != null ? Math.round(raw.altim * 0.02953 * 100) / 100 : null,
    raw_metar: raw.rawOb,
  };
}

function normalizeTafPeriod(p: RawTafForecastPeriod): NormalizedTafPeriod {
  const clouds =
    p.clouds
      ?.filter((c) => c.base != null)
      .map((c) => ({ cover: c.cover, base_ft: c.base as number, type: c.type ?? null })) ?? [];
  // A period carrying no visibility element arrives as an empty string, not
  // null, so a bare null check leaves it to render as a bare " sm".
  const rawVisib = p.visib == null ? null : typeof p.visib === 'string' ? p.visib : String(p.visib);
  const visib = rawVisib?.trim() ? rawVisib : null;

  return {
    from: new Date(p.timeFrom * 1000).toISOString(),
    to: new Date(p.timeTo * 1000).toISOString(),
    change_type: p.fcstChange ?? null,
    probability: p.probability ?? null,
    wind: {
      direction_deg: typeof p.wdir === 'number' ? p.wdir : null,
      // A TEMPO or PROB group amending only visibility, weather, or cloud
      // carries no wind element — 13% of live CONUS periods. `?? 0` turned
      // every one of them into a forecast calm.
      speed_kt: p.wspd ?? null,
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

/** Coerce an empty string or nullish value to null. */
function strOrNull(v: string | null | undefined): string | null {
  return v?.trim() ? v.trim() : null;
}

/**
 * The `/FL` groups that carry no altitude — `/FLUNKN/` (unknown), `/FLDURC/`
 * (during climb), `/FLDURD/` (during descent). AWC resolves all three to
 * `fltLvl: 0`, which is indistinguishable from a reported `/FL000/`, so the raw
 * token is the only discriminator. `fltLvlType` is phase of flight, not an
 * altitude-validity flag: it reads DURC/DURD on plenty of reports that do carry
 * a numeric flight level. `/FLSFC/` is excluded too — AWC substitutes the field
 * elevation in hundreds of feet for it, which is a real altitude.
 */
const PIREP_FLIGHT_LEVEL_UNKNOWN = /\/FL\s*(?:UNKN|DURC|DURD)\b/;

/** Upstream encodes an unreported PIREP cloud base or top as 0, not null. */
function pirepCloudAltitude(value: number | null): number | null {
  return value == null || value === 0 ? null : value;
}

function normalizePirep(raw: RawPirep): NormalizedPirep {
  // Build turbulence layers — omit entries with empty intensity
  const turbulence: NormalizedTurbulenceLayer[] = [];

  if (raw.tbInt1?.trim()) {
    turbulence.push({
      base_ft: typeof raw.tbBas1 === 'number' ? raw.tbBas1 * 100 : null,
      top_ft: typeof raw.tbTop1 === 'number' ? raw.tbTop1 * 100 : null,
      intensity: raw.tbInt1,
      type: strOrNull(raw.tbType1),
      frequency: strOrNull(raw.tbFreq1),
    });
  }
  if (raw.tbInt2?.trim()) {
    turbulence.push({
      base_ft: typeof raw.tbBas2 === 'number' ? raw.tbBas2 * 100 : null,
      top_ft: typeof raw.tbTop2 === 'number' ? raw.tbTop2 * 100 : null,
      intensity: raw.tbInt2,
      type: strOrNull(raw.tbType2),
      frequency: strOrNull(raw.tbFreq2),
    });
  }

  // Build icing layers — omit entries with empty intensity
  const icing: NormalizedIcingLayer[] = [];
  if (raw.icgInt1?.trim()) {
    icing.push({
      base_ft: typeof raw.icgBas1 === 'number' ? raw.icgBas1 * 100 : null,
      top_ft: typeof raw.icgTop1 === 'number' ? raw.icgTop1 * 100 : null,
      intensity: raw.icgInt1,
      type: strOrNull(raw.icgType1),
    });
  }
  if (raw.icgInt2?.trim()) {
    icing.push({
      base_ft: typeof raw.icgBas2 === 'number' ? raw.icgBas2 * 100 : null,
      top_ft: typeof raw.icgTop2 === 'number' ? raw.icgTop2 * 100 : null,
      intensity: raw.icgInt2,
      type: strOrNull(raw.icgType2),
    });
  }

  // Clouds — a layer with neither base nor top (CLR, SKC, VMC, IMC) still
  // carries its cover, so keep it rather than filtering it away.
  const clouds =
    raw.clouds && raw.clouds.length > 0
      ? raw.clouds.map((c) => ({
          cover: c.cover,
          base_ft: pirepCloudAltitude(c.base),
          top_ft: pirepCloudAltitude(c.top),
        }))
      : null;

  const altitudeFt =
    PIREP_FLIGHT_LEVEL_UNKNOWN.test(raw.rawOb) || raw.fltLvl == null
      ? null
      : raw.fltLvl < 1000
        ? raw.fltLvl * 100 // flight level (e.g., 270 → 27000)
        : raw.fltLvl; // already in feet for low-altitude reports

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
    clouds,
    visibility_sm: visib,
    remarks: strOrNull(raw.wxString),
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
    elevation_ft: raw.elev != null ? metersToFeet(raw.elev) : null,
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
  private fetchJson<T>(url: string, ctx: Context): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, this.timeoutMs, ctx, { signal: ctx.signal });
        // AWC returns HTTP 204 with empty body when no data matches the query.
        // Treat this as an empty result — callers guard with `if (!Array.isArray(raw)) return []`.
        if (response.status === 204) return [] as T;
        const text = await response.text();
        // Detect HTML error pages from upstream
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'AWC API returned HTML instead of JSON — service may be degraded.',
          );
        }
        // Empty body on non-204 responses — also treat as empty result
        if (!text.trim()) return [] as T;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Log the raw body at debug level for diagnostics; don't surface it to the caller
          ctx.log.debug('AWC API returned invalid JSON', { preview: text.slice(0, 200) });
          throw serviceUnavailable('AWC API returned invalid JSON — service may be degraded.');
        }
        // Check for AWC error shape: { "status": "error", "error": "..." }
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'status' in parsed &&
          (parsed as Record<string, unknown>).status === 'error'
        ) {
          const errMsg = (parsed as Record<string, unknown>).error;
          throw serviceUnavailable(
            `AWC API error: ${typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)}`,
          );
        }
        return parsed as T;
      },
      {
        operation: 'AviationWeatherService.fetchJson',
        context: ctx,
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

  /**
   * Fetch PIREPs for a station + distance, or bbox. `distanceNm` is a radius
   * around `stationId` and is not sent in bbox mode — the upstream `distance`
   * parameter is only meaningful relative to the `id` center point.
   *
   * The pirep endpoint names its lookback `age` ("Hours Back"), unlike the
   * metar/taf endpoints' `hours`, and silently drops query keys it does not
   * recognize rather than rejecting them.
   */
  async fetchPireps(
    params: {
      stationId?: string;
      bbox?: { minLat: number; minLon: number; maxLat: number; maxLon: number };
      distanceNm?: number;
      hours: number;
    },
    ctx: Context,
  ): Promise<NormalizedPirep[]> {
    let url: string;
    if (params.stationId) {
      url = `${this.baseUrl}/pirep?id=${encodeURIComponent(params.stationId)}&format=json&distance=${params.distanceNm}&age=${params.hours}`;
    } else if (params.bbox) {
      const { minLat, minLon, maxLat, maxLon } = params.bbox;
      url = `${this.baseUrl}/pirep?bbox=${minLat},${minLon},${maxLat},${maxLon}&format=json&age=${params.hours}`;
    } else {
      throw serviceUnavailable('Either stationId or bbox is required for PIREPs');
    }
    ctx.log.debug('Fetching PIREPs', {
      stationId: params.stationId,
      hasBbox: !!params.bbox,
      distanceNm: params.distanceNm,
      hours: params.hours,
    });
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
    const { bbox } = params;
    if (bbox) {
      advisories = advisories.filter((a) => bboxOverlapsPolygon(bbox, a.polygon));
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
        // Bad client input, not an upstream outage — callers should reach the
        // tool's invalid_state guard first, which carries the recovery hint.
        throw validationError(`No bounding box available for state: ${params.state}`, {
          state: params.state,
        });
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
