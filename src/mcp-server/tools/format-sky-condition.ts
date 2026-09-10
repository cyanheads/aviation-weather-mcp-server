/**
 * @fileoverview Renders the sky line for `content[]` — cloud layers when the
 * report published heights, the sky-condition group when it published only a
 * group, and an explicit unreported state when it published neither. Shared by
 * `aviation_get_metar` and `aviation_get_taf` so the two state a reported clear
 * sky in the same words.
 * @module mcp-server/tools/format-sky-condition
 */

/**
 * Plain-English readings for the sky-condition groups that carry no layer
 * height. `CLR` reads wider than the AIM's automated-station definition because
 * AWC folds `NCD` and `NSC` into it — 88 of 591 `CLR` values across 22 live
 * regional draws came from one of those two — so naming a 12,000 ft threshold
 * here would state something 15% of the records do not support.
 */
const SKY_CONDITION_READINGS: Record<string, string> = {
  CAVOK: 'ceiling and visibility OK',
  CLR: 'clear or no significant cloud reported',
  NCD: 'no cloud detected',
  NSC: 'no significant cloud',
  OVX: 'sky obscured — no layer height reported',
  SKC: 'sky clear',
};

/** A sky-condition code with its reading, or the bare code when unrecognized. */
export function describeSkyCondition(code: string): string {
  const reading = SKY_CONDITION_READINGS[code.toUpperCase()];
  return reading ? `${code} (${reading})` : code;
}

/**
 * The rendered sky line. Layers and a sky-condition group are mutually
 * exclusive in live data — the group exists precisely because there is no layer
 * height to publish — but both are rendered when both are present rather than
 * one branch shadowing the other. A shadowing branch would leave one of the two
 * fields unrendered whenever a value carries both, which is every value the
 * `format-parity` lint synthesizes.
 *
 * `unreported` is the caller's wording for the remaining case, where the report
 * stated no sky condition at all. It differs between the two tools because the
 * cause does: a METAR carried no sky-condition group, while a TAF amendment
 * group carrying no cloud element leaves the prevailing forecast standing.
 */
export function formatSkyLine(
  layers: string[],
  skyCondition: string | null,
  unreported: string,
): string {
  const parts: string[] = [];
  if (layers.length > 0) parts.push(layers.join(', '));
  if (skyCondition != null) parts.push(describeSkyCondition(skyCondition));
  return parts.length > 0 ? parts.join(' | ') : unreported;
}
