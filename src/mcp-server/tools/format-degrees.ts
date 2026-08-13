/**
 * @fileoverview Renders a decimal-degree coordinate for `content[]` at the
 * resolution the AWC endpoint published. Shared by every tool that renders a
 * position, so the two response surfaces cannot drift apart per tool.
 * @module mcp-server/tools/format-degrees
 */

/**
 * Renders a latitude or longitude with no fixed decimal count in either
 * direction. `toFixed` fails both ways: it truncated the 5-decimal station
 * coordinates that make up most of the `stationinfo` feed, and padded a
 * 1-decimal one into false precision, so `content[]` named a different location
 * from `structuredContent`.
 *
 * The one adjustment is rounding at 6 decimal places — ~0.11 m, finer than any
 * AWC endpoint publishes — which collapses float representation artifacts:
 * `stationinfo` reports K2S8 at `47.75419998168945` for a true `47.7542`.
 */
export function formatDegrees(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}
