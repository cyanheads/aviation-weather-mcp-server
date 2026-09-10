/**
 * @fileoverview Tests for the shared sky-condition renderer — the one place
 * `aviation_get_metar` and `aviation_get_taf` agree on how a reported clear sky
 * reads, and on what an unrecognized group is allowed to become.
 * @module tests/tools/format-sky-condition.test
 */

import { describe, expect, it } from 'vitest';
import { describeSkyCondition, formatSkyLine } from '@/mcp-server/tools/format-sky-condition.js';

describe('describeSkyCondition', () => {
  it.each([
    ['CLR', 'CLR (clear or no significant cloud reported)'],
    ['SKC', 'SKC (sky clear)'],
    ['CAVOK', 'CAVOK (ceiling and visibility OK)'],
    ['NSC', 'NSC (no significant cloud)'],
    ['NCD', 'NCD (no cloud detected)'],
    ['OVX', 'OVX (sky obscured — no layer height reported)'],
  ])('reads %s as %s', (code, expected) => {
    expect(describeSkyCondition(code)).toBe(expected);
  });

  it('hands back a code it does not recognize rather than half-glossing it', () => {
    // The same rule the weather decoder follows: a reading that looks
    // successful while carrying a code the tables never covered hides the gap.
    expect(describeSkyCondition('ZZZ')).toBe('ZZZ');
  });
});

describe('formatSkyLine', () => {
  it('renders layers when the report published heights', () => {
    expect(formatSkyLine(['BKN @ 2500 ft'], null, 'not reported')).toBe('BKN @ 2500 ft');
  });

  it('renders the sky condition when there are no layers', () => {
    expect(formatSkyLine([], 'CLR', 'not reported')).toBe(
      'CLR (clear or no significant cloud reported)',
    );
  });

  it('falls to the caller wording when the report stated neither', () => {
    expect(formatSkyLine([], null, 'not reported')).toBe('not reported');
  });

  it('renders both rather than letting one branch shadow the other', () => {
    // Live data never pairs them — the group exists because there is no layer
    // height — but the format-parity walk populates every leaf at once, and a
    // branch that skipped one would read as an unrendered output field.
    expect(formatSkyLine(['BKN @ 2500 ft'], 'CLR', 'not reported')).toBe(
      'BKN @ 2500 ft | CLR (clear or no significant cloud reported)',
    );
  });
});
