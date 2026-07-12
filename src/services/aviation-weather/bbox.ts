/**
 * @fileoverview Shared bounding-box validation helper for the AWC tools.
 * Lives apart from the service module so the pure predicate stays importable in
 * handler tests that fully mock the service singleton.
 * @module services/aviation-weather/bbox
 */

/**
 * True when a bounding box has correctly-ordered bounds — `minLat <= maxLat`
 * and `minLon <= maxLon`. A degenerate (zero-area) box is ordered; an inverted
 * box is not. Shared by every tool that accepts a bbox so inverted input is
 * rejected before it reaches the upstream API or client-side filters.
 */
export function isBboxOrdered(bbox: {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}): boolean {
  return bbox.minLat <= bbox.maxLat && bbox.minLon <= bbox.maxLon;
}
