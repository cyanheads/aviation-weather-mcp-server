/**
 * @fileoverview US state bounding boxes backing the `stationinfo` state
 * workaround, plus the supported-state predicate. Lives apart from the service
 * module so the pure predicate stays importable in handler tests that fully
 * mock the service singleton.
 * @module services/aviation-weather/state-bboxes
 */

/**
 * Approximate bounding boxes for the 50 US states and DC. The AWC
 * `stationinfo` endpoint has no `state` parameter, so a state query is issued
 * as a bbox draw and the results are filtered client-side on each station's
 * `state` field.
 *
 * An overshooting box costs accuracy once the draw reaches the upstream row
 * cap, not merely extra rows: the neighbouring states and territory the box
 * overlaps consume slots the requested state's stations would otherwise have
 * filled, and the filter then runs on what is left. A Texas query returns 279
 * stations where a bbox tiling of the same area reaches 298.
 *
 * US territories (PR, VI, GU, MP, AS) are deliberately absent: AWC leaves
 * `state` empty on their stations and identifies them by `country`, so a bbox
 * entry here would filter down to zero rows rather than working.
 */
export const STATE_BBOXES: Record<
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
  DC: { minLat: 38.7, minLon: -77.2, maxLat: 39.1, maxLon: -76.8 },
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

/**
 * True when `state` (case-insensitive) resolves to a bounding box. Consumed by
 * the tool handler so an unsupported code fails as validation before any
 * upstream request.
 */
export function isSupportedState(state: string): boolean {
  return Object.hasOwn(STATE_BBOXES, state.toUpperCase());
}
