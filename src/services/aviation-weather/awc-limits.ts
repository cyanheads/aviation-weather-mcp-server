/**
 * @fileoverview The AWC Data API's fixed request-shape limits — the per-request
 * result cap and the width of the pirep endpoint's altitude band — with the
 * predicates that read a query against them. Lives apart from the service
 * module so tool handlers and their tests can import them while the service
 * singleton is mocked.
 * @module services/aviation-weather/awc-limits
 */

/**
 * Rows any AWC Data API endpoint returns at most, per the Restrictions section
 * of its documentation. The OpenAPI schema declares no pagination surface — no
 * page, offset, limit, or cursor — and does not mention the cap at all, so a
 * caller learns a page was cut only by counting the rows it received.
 */
export const AWC_MAX_ROWS = 400;

/**
 * Whether an upstream draw hit the cap, read from the row count AWC served
 * before any client-side filter narrowed it.
 *
 * A result that genuinely holds exactly the cap is indistinguishable from one
 * that was cut, and is reported as cut. That over-warns in the safe direction:
 * the caller narrows a query that did not need narrowing, rather than trusting
 * a page that was.
 */
export function isUpstreamCapped(drawnRows: number): boolean {
  return drawnRows >= AWC_MAX_ROWS;
}

/**
 * The altitude band the pirep endpoint's `level` parameter searches, in feet.
 * AWC documents the parameter as "Level +-3000' to search", so it names a
 * centre point of fixed width rather than a range: `level=190` draws FL160–220
 * and `level=100` draws FL070–130, both confirmed against the live endpoint.
 */
export const PIREP_LEVEL_BAND_FT = 6000;

/**
 * The `level` centre, in flight levels, whose upstream band contains the
 * requested altitude range — or undefined when the range cannot be pushed.
 *
 * A range wider than the fixed band has no such centre, and neither does one
 * bounded on a single side; both go unpushed and the client-side filter does
 * all the narrowing, exactly as before. Where a centre does exist the upstream
 * result is a superset of what the caller asked for, which the client-side
 * filter then trims — so the rows the tool can already see are unchanged, and
 * what changes is that rows the cap was hiding become reachable.
 *
 * The value is a flight level, never feet: a range centred on 19,000 ft sends
 * `190`.
 */
export function pushablePirepLevel(
  altitudeMinFt: number | undefined,
  altitudeMaxFt: number | undefined,
): number | undefined {
  if (altitudeMinFt == null || altitudeMaxFt == null) return undefined;

  // Containment is the whole test, and it covers both ways a range fails to
  // fit. A range wider than the fixed band has no centre that holds it. And
  // because the centre is a whole flight level, rounding shifts the band by up
  // to 50 ft, so even a range inside the width can be left with a sliver
  // outside what gets drawn — 17,950–23,950 ft rounds to a centre of FL210,
  // which draws FL180–240 and misses the bottom 50 ft. Reports in a sliver go
  // undrawn rather than trimmed, which is a silent loss rather than a filter,
  // so a centre whose band does not contain both bounds is not sent at all.
  const level = Math.round((altitudeMinFt + altitudeMaxFt) / 2 / 100);
  const centreFt = level * 100;
  const halfBandFt = PIREP_LEVEL_BAND_FT / 2;
  const contained =
    centreFt - halfBandFt <= altitudeMinFt && altitudeMaxFt <= centreFt + halfBandFt;
  return contained ? level : undefined;
}
