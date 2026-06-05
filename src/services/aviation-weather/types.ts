/**
 * @fileoverview Raw API response types and normalized domain types for the AWC Data API.
 * Field names match confirmed live-probe field names from aviationweather.gov/api/data.
 * @module services/aviation-weather/types
 */

// ---------------------------------------------------------------------------
// Raw API response shapes
// ---------------------------------------------------------------------------

/** Raw METAR record from the AWC API (format=json). */
export interface RawMetar {
  altim: number | null;
  clouds: RawCloudLayer[] | null;
  cover: string | null; // sky cover summary
  dewp: number | null;
  elev: number | null;
  fltCat: string | null; // flight category: 'VFR' | 'MVFR' | 'IFR' | 'LIFR'
  icaoId: string;
  lat: number;
  lon: number;
  metarType: string | null; // 'METAR' | 'SPECI'
  name: string | null;
  obsTime: number; // Unix epoch seconds
  qcField: number | null;
  rawOb: string;
  receiptTime: string; // ISO 8601 string
  reportTime: string; // ISO 8601 string
  slp: number | null;
  temp: number | null;
  visib: string | number | null; // '10+', '3', '1/2', or a number from the API
  wdir: number | string | null; // 'VRB' when variable direction
  wgst: number | null;
  wspd: number | null;
}

export interface RawCloudLayer {
  base: number | null; // base altitude in feet
  cover: string; // 'FEW', 'SCT', 'BKN', 'OVC', 'SKC', 'CLR', 'OVX'
}

/** Raw TAF forecast period from the AWC API. */
export interface RawTafForecastPeriod {
  altim?: number | null;
  clouds: RawTafCloudLayer[] | null;
  fcstChange: string | null; // 'FM', 'TEMPO', 'BECMG', or null
  icgTurb?: string | null;
  notDecoded?: string | null;
  probability: number | null;
  temp?: number | null;
  timeBec?: number | null;
  timeFrom: number; // Unix epoch seconds
  timeTo: number; // Unix epoch seconds
  vertVis?: number | null;
  visib: string | number | null;
  wdir: number | string | null;
  wgst: number | null;
  wshearDir?: number | null;
  wshearHgt?: number | null;
  wshearSpd?: number | null;
  wspd: number | null;
  wxString: string | null;
}

export interface RawTafCloudLayer {
  base: number | null;
  cover: string;
  type: string | null; // 'CB', 'TCU', or null
}

/** Raw TAF record from the AWC API. */
export interface RawTaf {
  bulletinTime?: string | null;
  dbPopTime?: string | null;
  elev: number | null;
  fcsts: RawTafForecastPeriod[];
  icaoId: string;
  issueTime: string; // ISO 8601 string
  lat: number;
  lon: number;
  mostRecent?: boolean | null;
  name: string | null;
  prior?: number | null;
  rawTAF: string;
  remarks?: string | null;
  validTimeFrom: number; // Unix epoch seconds
  validTimeTo: number; // Unix epoch seconds
}

/** Raw PIREP record from the AWC API. */
export interface RawPirep {
  acType: string | null;
  brkAction?: string | null;
  clouds: RawPirepCloudLayer[] | null;
  fltLvl: number | null; // flight level (e.g. 270 = FL270 = 27000 ft)
  fltLvlType?: string | null;
  icaoId: string; // Always 'KWBC' — the collection center, not the queried station
  // Icing layers (up to 2)
  icgBas1?: number | null;
  icgBas2?: number | null;
  icgInt1?: string | null;
  icgInt2?: string | null;
  icgTop1?: number | null;
  icgTop2?: number | null;
  icgType1?: string | null;
  icgType2?: string | null;
  lat: number;
  lon: number;
  obsTime: number; // Unix epoch seconds
  pirepType: string | null; // 'PIREP' | 'AIREP'
  qcField?: number | null;
  rawOb: string;
  receiptTime: string;
  // Turbulence layers (up to 2)
  tbBas1?: number | null;
  tbBas2?: number | null;
  tbFreq1?: string | null;
  tbFreq2?: string | null;
  tbInt1?: string | null;
  tbInt2?: string | null;
  tbTop1?: number | null;
  tbTop2?: number | null;
  tbType1?: string | null;
  tbType2?: string | null;
  temp?: number | null;
  vertGust?: number | null;
  visib: number | string | null;
  wdir?: number | null;
  wspd?: number | null;
  wxString: string | null;
}

export interface RawPirepCloudLayer {
  base: number | null;
  cover: string;
  top: number | null;
}

/** Raw AIRSIGMET record from the AWC API. */
export interface RawAirSigmet {
  airSigmetType: string | null; // 'SIGMET' | 'AIRMET'
  alphaChar?: string | null;
  altitudeHi1: number | null;
  altitudeHi2?: number | null;
  altitudeLow1: number | null;
  altitudeLow2?: number | null;
  coords: { lat: number; lon: number }[];
  creationTime?: string | null;
  hazard: string | null;
  icaoId: string; // issuing center ICAO ID
  movementDir: number | null;
  movementSpd: number | null;
  postProcessFlag?: string | null;
  rawAirSigmet: string;
  receiptTime?: string | null;
  seriesId: string;
  severity: number | null;
  validTimeFrom: number; // Unix epoch seconds
  validTimeTo: number; // Unix epoch seconds
}

/** Raw station info record from the AWC API. */
export interface RawStationInfo {
  country: string | null;
  elev: number | null;
  faaId: string | null;
  iataId: string | null;
  icaoId: string | null;
  id: string;
  lat: number;
  lon: number;
  priority?: number | null;
  site: string;
  siteType: string[];
  state: string | null;
  wmoId?: string | null;
}

// ---------------------------------------------------------------------------
// Normalized domain types (output from service methods)
// ---------------------------------------------------------------------------

export interface NormalizedCloudLayer {
  base_ft: number;
  cover: string;
}

export interface NormalizedMetar {
  altimeter_inhg: number;
  ceiling_ft: number | null;
  clouds: NormalizedCloudLayer[];
  dewpoint_c: number;
  elevation_ft: number;
  flight_category: string; // 'VFR' | 'MVFR' | 'IFR' | 'LIFR'
  lat: number;
  lon: number;
  metar_type: string; // 'METAR' | 'SPECI'
  name: string;
  observed_at: string; // ISO 8601
  raw_metar: string;
  station_id: string;
  temp_c: number;
  visibility_sm: string;
  wind: {
    direction_deg: number | null;
    speed_kt: number;
    gust_kt: number | null;
  };
}

export interface NormalizedTafPeriod {
  change_type: string | null;
  clouds: { cover: string; base_ft: number; type: string | null }[];
  from: string; // ISO 8601
  probability: number | null;
  to: string; // ISO 8601
  visibility_sm: string | null;
  weather: string | null; // decoded wx string
  wind: {
    direction_deg: number | null;
    speed_kt: number;
    gust_kt: number | null;
  };
}

export interface NormalizedTaf {
  forecast_periods: NormalizedTafPeriod[];
  issued_at: string; // ISO 8601
  name: string;
  raw_taf: string;
  station_id: string;
  valid_from: string; // ISO 8601
  valid_to: string; // ISO 8601
}

export interface NormalizedTurbulenceLayer {
  base_ft: number | null;
  frequency: string | null;
  intensity: string;
  top_ft: number | null;
  type: string | null;
}

export interface NormalizedIcingLayer {
  base_ft: number | null;
  intensity: string;
  top_ft: number | null;
  type: string | null;
}

export interface NormalizedPirepCloudLayer {
  base_ft: number;
  cover: string;
  top_ft: number;
}

export interface NormalizedPirep {
  aircraft_type: string | null;
  altitude_ft: number;
  clouds: NormalizedPirepCloudLayer[] | null;
  icing: NormalizedIcingLayer[];
  lat: number;
  lon: number;
  observed_at: string; // ISO 8601
  pirep_type: string; // 'PIREP' | 'AIREP'
  raw_pirep: string;
  remarks: string | null;
  turbulence: NormalizedTurbulenceLayer[];
  visibility_sm: number | null;
}

export interface NormalizedAdvisory {
  advisory_type: string; // 'SIGMET' | 'AIRMET'
  altitude_high_ft: number | null;
  altitude_low_ft: number | null;
  hazard: string;
  issued_by: string;
  movement: { direction_deg: number | null; speed_kt: number | null } | null;
  polygon: { lat: number; lon: number }[];
  raw_text: string;
  series_id: string;
  severity: number | null;
  valid_from: string; // ISO 8601
  valid_to: string; // ISO 8601
}

export interface NormalizedStation {
  country: string;
  data_types: string[];
  elevation_ft: number;
  faa_id: string | null;
  iata_id: string | null;
  icao_id: string | null;
  lat: number;
  lon: number;
  name: string;
  state: string;
}
