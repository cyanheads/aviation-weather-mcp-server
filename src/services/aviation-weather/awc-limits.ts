/**
 * @fileoverview The AWC Data API's per-request result cap and the predicate
 * that reads a row count against it. Lives apart from the service module so
 * tool handlers and their tests can import it while the service singleton is
 * mocked.
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
