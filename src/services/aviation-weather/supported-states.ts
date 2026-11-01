/**
 * @fileoverview Supported US jurisdictions for complete station registry searches.
 * @module services/aviation-weather/supported-states
 */
const STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(
    ' ',
  ),
);

/** Case-insensitive 50-state/DC predicate; territories require bbox searches. */
export function isSupportedState(state: string): boolean {
  return STATES.has(state.toUpperCase());
}
