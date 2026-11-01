/**
 * @fileoverview Independent AWC advisory products, sparse normalization and geographic envelopes.
 * @module services/aviation-weather/advisory-products
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type {
  AdvisoryCoverage,
  AdvisoryPoint,
  AdvisorySource,
  AdvisorySummary,
  NormalizedAdvisory,
} from './types.js';

const PRODUCTS = {
  sigmet: {
    endpoint: 'airsigmet',
    hazards: { TS: 'conv', CONVECTIVE: 'conv', TURBULENCE: 'turb', ICING: 'ice', IFR: 'ifr' },
  },
  isigmet: {
    endpoint: 'isigmet',
    hazards: {
      TS: 'ts',
      CONVECTIVE: 'ts',
      TURBULENCE: 'turb',
      ICING: 'ice',
      MTW: 'mtw',
      DS: 'ds',
      SS: 'ss',
      TC: 'tc',
      VA: 'va',
    },
  },
  cwa: {
    endpoint: 'cwa',
    hazards: {
      TS: 'ts',
      CONVECTIVE: 'ts',
      TURBULENCE: 'turb',
      ICING: 'ice',
      IFR: 'ifr',
      PCPN: 'pcpn',
      UNK: 'unk',
    },
  },
} as const;

/** Hazards supported by at least one advisory product. */
export type AdvisoryHazard =
  | 'CONVECTIVE'
  | 'TURBULENCE'
  | 'ICING'
  | 'IFR'
  | 'TS'
  | 'MTW'
  | 'DS'
  | 'SS'
  | 'TC'
  | 'VA'
  | 'PCPN'
  | 'UNK';

/** Whether a source has a documented upstream hazard token. */
export function supportsAdvisoryHazard(source: AdvisorySource, hazard: string): boolean {
  return Object.hasOwn(PRODUCTS[source].hazards, hazard);
}

/** Whether any source can answer this hazard. */
export function isAdvisoryHazard(hazard: string): hazard is AdvisoryHazard {
  return (Object.keys(PRODUCTS) as AdvisorySource[]).some((source) =>
    supportsAdvisoryHazard(source, hazard),
  );
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function number(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value: unknown): string | null {
  const seconds = number(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function part(value: unknown): AdvisoryPoint[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const points: AdvisoryPoint[] = [];
  for (const vertex of value) {
    if (!isRecord(vertex)) return null;
    const lat = number(vertex.lat);
    const lon = number(vertex.lon);
    if (lat === null || lon === null || Math.abs(lat) > 90) return null;
    points.push({ lat, lon: Math.abs(lon) <= 180 ? lon : (((lon % 360) + 540) % 360) - 180 });
  }
  return points;
}

/** A cancellation is the first body action after a CWA validity header, never a mention. */
function cancelledCwa(raw: Record<string, unknown>): boolean {
  const bulletin = text(raw.rawText);
  if (bulletin === null) return false;
  let body = false;
  for (const line of bulletin.split('\n')) {
    const trimmed = line.trim();
    if (body && trimmed) return /^CNL[ \t]+CWA[ \t]+\d+\b/.test(trimmed);
    if (/^[A-Z]{3}[ \t]+CWA[ \t]+\d+[ \t]+VALID[ \t]+UNTIL[ \t]+\d{6}$/.test(trimmed)) body = true;
  }
  return false;
}

/** Recognize an unquoted standalone motion token without matching substrings or quoted text. */
function explicitlyStationary(bulletin: string | null): boolean {
  if (bulletin === null) return false;
  let quote: string | null = null;
  for (let index = 0; index < bulletin.length; index++) {
    const character = bulletin[index];
    if (character === '"' || character === "'") {
      if (quote === character) quote = null;
      else if (quote === null) quote = character;
    }
    if (
      quote === null &&
      bulletin.startsWith('STNR', index) &&
      (index === 0 || /\s/.test(bulletin.charAt(index - 1))) &&
      (index + 4 === bulletin.length || /[\s.=]/.test(bulletin.charAt(index + 4)))
    )
      return true;
  }
  return false;
}

function normalize(source: AdvisorySource, raw: Record<string, unknown>): NormalizedAdvisory {
  const domestic = source === 'sigmet';
  const kind = text(raw.geom);
  let parts: AdvisoryPoint[][] = [];
  if (Array.isArray(raw.coords) && raw.coords.length) {
    const candidates = Array.isArray(raw.coords[0]) ? raw.coords : [raw.coords];
    const decoded = candidates.map(part);
    // Never stitch a broken ring or silently drop one part of a multipart area.
    if (decoded.every((candidate): candidate is AdvisoryPoint[] => candidate !== null))
      parts = decoded;
  }
  const direction = domestic ? number(raw.movementDir) : null;
  const speed = source === 'cwa' ? null : number(domestic ? raw.movementSpd : raw.spd);
  const directionText = source === 'isigmet' ? text(raw.dir) : null;
  const rawText = text(
    domestic ? raw.rawAirSigmet : source === 'cwa' ? raw.rawText : raw.rawSigmet,
  );
  const stationary =
    source !== 'isigmet'
      ? null
      : explicitlyStationary(rawText)
        ? true
        : directionText !== null && directionText !== '-' && speed !== null && speed > 0
          ? false
          : null;
  return {
    advisory_type:
      source === 'cwa' ? 'CWA' : domestic ? (text(raw.airSigmetType) ?? 'SIGMET') : 'ISIGMET',
    source,
    series_id: text(raw.seriesId),
    issued_by: text(source === 'cwa' ? raw.cwsu : raw.icaoId),
    issued_by_name: source === 'cwa' ? text(raw.name) : null,
    tendency: source === 'isigmet' ? text(raw.chng) : null,
    hazard: text(raw.hazard),
    severity: domestic ? number(raw.severity) : null,
    valid_from: timestamp(raw.validTimeFrom),
    valid_to: timestamp(raw.validTimeTo),
    altitude_low_ft: domestic
      ? (number(raw.altitudeLow1) ?? number(raw.altitudeLow2))
      : number(raw.base),
    altitude_high_ft: domestic
      ? (number(raw.altitudeHi1) ?? number(raw.altitudeHi2))
      : number(raw.top),
    fir_id: text(raw.firId),
    fir_name: text(raw.firName),
    qualifier: text(raw.qualifier),
    movement:
      direction !== null || speed !== null || directionText !== null || stationary === true
        ? {
            direction_deg: direction,
            speed_kt: speed,
            ...(source === 'isigmet' ? { direction_text: directionText, stationary } : {}),
          }
        : null,
    geometry: parts.length ? { kind, parts } : null,
    polygon:
      parts.length === 1 && (domestic || kind === null || kind === 'AREA')
        ? (parts[0] ?? null)
        : null,
    raw_text: rawText,
  };
}

/** Bounding-envelope intersection; consecutive vertices cross the date line by their shortest arc. */
function intersects(bbox: NonNullable<AdvisoryParams['bbox']>, points: AdvisoryPoint[]): boolean {
  let minLat = 90;
  let maxLat = -90;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let previousRaw = 0;
  let unwrapped = 0;
  let first = true;
  for (const point of points) {
    let delta = point.lon - previousRaw;
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    unwrapped = first ? point.lon : unwrapped + delta;
    first = false;
    previousRaw = point.lon;
    minLon = Math.min(minLon, unwrapped);
    maxLon = Math.max(maxLon, unwrapped);
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
  }
  if (maxLat < bbox.minLat || minLat > bbox.maxLat) return false;
  const firstShift = Math.ceil((minLon - bbox.maxLon) / 360);
  const lastShift = Math.floor((maxLon - bbox.minLon) / 360);
  return firstShift <= lastShift;
}

/** Advisory source selection and callback disclosures before caller-side output limiting. */
export interface AdvisoryParams {
  advisoryType: AdvisorySource | 'all';
  altitudeFt?: number;
  bbox?: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  hazard?: AdvisoryHazard;
  onPreFilterRows?: (rows: number) => void;
  onSummary?: (summary: AdvisorySummary) => void;
}

/** Read independent products concurrently; unavailable sources cannot erase healthy results. */
export async function fetchAdvisoryProducts(
  params: AdvisoryParams,
  baseUrl: string,
  fetchJson: (url: string, context: Context) => Promise<unknown>,
  ctx: Context,
): Promise<NormalizedAdvisory[]> {
  const level = params.altitudeFt === undefined ? undefined : Math.round(params.altitudeFt / 100);
  const altitudeSelection =
    level === undefined || params.altitudeFt === undefined
      ? undefined
      : {
          requested_ft: params.altitudeFt,
          level,
          band_low_ft: Math.max(0, level * 100 - 3000),
          band_high_ft: level * 100 + 3000,
        };
  const sources: AdvisorySource[] =
    params.advisoryType === 'all' ? ['sigmet', 'isigmet', 'cwa'] : [params.advisoryType];
  const applicable = sources.filter(
    (source) => !params.hazard || supportsAdvisoryHazard(source, params.hazard),
  );
  if (!applicable.length)
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'The selected advisory product cannot answer this hazard.',
      { reason: 'hazard_not_supported' },
    );
  // One deadline covers all concurrent legs, attempts, backoffs and body reads.
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(45_000)]);
  const context = { ...ctx, signal };
  const settled = await Promise.allSettled(
    applicable.map(async (source) => {
      const product = PRODUCTS[source];
      const token = params.hazard
        ? (product.hazards as Partial<Record<AdvisoryHazard, string>>)[params.hazard]
        : undefined;
      const raw = await fetchJson(
        `${baseUrl}/${product.endpoint}?format=json${token ? `&hazard=${token}` : ''}${level !== undefined && source !== 'cwa' ? `&level=${level}` : ''}`,
        context,
      );
      if (!Array.isArray(raw)) throw new Error('unreadable advisory array');
      const records = raw.filter(isRecord);
      const active = source === 'cwa' ? records.filter((row) => !cancelledCwa(row)) : records;
      const cancelled = records.length - active.length;
      const advisories = active
        .map((row) => normalize(source, row))
        .filter((row) =>
          Object.entries(row).some(
            ([key, value]) => key !== 'source' && key !== 'advisory_type' && value !== null,
          ),
        );
      const selected =
        source === 'cwa' && altitudeSelection
          ? advisories.filter(
              (row) =>
                row.altitude_low_ft === null ||
                row.altitude_high_ft === null ||
                (row.altitude_low_ft <= altitudeSelection.band_high_ft &&
                  row.altitude_high_ft >= altitudeSelection.band_low_ft),
            )
          : advisories;
      return {
        source,
        advisories: selected,
        cancelled,
        skipped: raw.length - cancelled - advisories.length,
      };
    }),
  );
  ctx.signal.throwIfAborted();
  const coverage: AdvisoryCoverage[] = [];
  const drawn: NormalizedAdvisory[] = [];
  let partial = false;
  const outcomes = new Map(applicable.map((source, index) => [source, settled[index]]));
  for (const source of sources) {
    const result = outcomes.get(source);
    if (!result) {
      coverage.push({
        source,
        status: 'not_applicable',
        altitude_filter: null,
        altitude_unknown: null,
        drawn: null,
        cancelled: null,
        message: `${source} has no documented counterpart for ${params.hazard}.`,
      });
      continue;
    }
    if (result.status === 'rejected') {
      partial = true;
      coverage.push({
        source,
        status: 'failed',
        altitude_filter: null,
        altitude_unknown: null,
        drawn: null,
        cancelled: null,
        message: `${source} could not be read; coverage is unavailable. Retry this product separately.`,
      });
    } else {
      const { advisories, skipped, cancelled } = result.value;
      drawn.push(...advisories);
      partial ||= skipped > 0;
      coverage.push({
        source,
        status: 'ok',
        altitude_filter: altitudeSelection ? (source === 'cwa' ? 'client' : 'upstream') : null,
        altitude_unknown: altitudeSelection
          ? advisories.filter(
              (row) => row.altitude_low_ft === null || row.altitude_high_ft === null,
            ).length
          : null,
        drawn: advisories.length,
        cancelled,
        ...(skipped
          ? {
              message: `${source} skipped ${skipped} empty or unreadable row(s); coverage is partial.`,
            }
          : {}),
      });
    }
  }
  if (!coverage.some((row) => row.status === 'ok'))
    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      'All applicable advisory sources failed; no advisory coverage was established.',
      { reason: 'advisory_sources_failed' },
    );
  const unlocated = drawn.filter((row) => !row.geometry).length;
  const { bbox } = params;
  const matches = bbox
    ? drawn.filter((row) => row.geometry?.parts.some((points) => intersects(bbox, points)))
    : drawn;
  params.onPreFilterRows?.(drawn.length);
  params.onSummary?.({
    ...(altitudeSelection ? { altitudeSelection } : {}),
    coverage,
    partial,
    drawn: drawn.length,
    matched: matches.length,
    unlocated,
  });
  return matches;
}
