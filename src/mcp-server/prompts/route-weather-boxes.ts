/**
 * @fileoverview Ordered coordinate envelopes for weather briefing requests.
 * @module mcp-server/prompts/route-weather-boxes
 */

type Coordinate = readonly [latitude: number, longitude: number];
type WeatherBox = { minLat: number; minLon: number; maxLat: number; maxLon: number };
type RouteBoxes = { kind: 'bounded'; boxes: WeatherBox[] } | { kind: 'ambiguous' };

/**
 * Envelops validated waypoints with a one-degree margin, following shortest
 * consecutive longitude arcs. This is a coordinate envelope, not a track
 * intersection or a great-circle corridor. A half-world leg is ambiguous.
 */
export function routeWeatherBoxes(first: Coordinate, rest: readonly Coordinate[]): RouteBoxes {
  let south = first[0];
  let north = first[0];
  let west = first[1];
  let east = first[1];
  let previous = first[1];
  let unwrapped = previous;
  for (const [latitude, longitude] of rest) {
    const delta = ((longitude - previous + 540) % 360) - 180;
    if (Math.abs(delta) === 180) return { kind: 'ambiguous' };
    unwrapped += delta;
    previous = longitude;
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
    west = Math.min(west, unwrapped);
    east = Math.max(east, unwrapped);
  }

  // AWC accepts four decimal places; rounding outward keeps boundary points.
  const minLat = Math.max(-90, Math.floor((south - 1) * 10000) / 10000);
  const maxLat = Math.min(90, Math.ceil((north + 1) * 10000) / 10000);
  const width = east - west + 2;
  if (minLat === -90 || maxLat === 90 || width >= 360) {
    return { kind: 'bounded', boxes: [{ minLat, minLon: -180, maxLat, maxLon: 180 }] };
  }
  const left = ((((west - 1 + 180) % 360) + 360) % 360) - 180;
  const right = left + width;
  const minLon = Math.floor(left * 10000) / 10000;
  if (right <= 180) {
    return {
      kind: 'bounded',
      boxes: [{ minLat, minLon, maxLat, maxLon: Math.ceil(right * 10000) / 10000 }],
    };
  }
  return {
    kind: 'bounded',
    boxes: [
      { minLat, minLon, maxLat, maxLon: 180 },
      { minLat, minLon: -180, maxLat, maxLon: Math.ceil((right - 360) * 10000) / 10000 },
    ],
  };
}
