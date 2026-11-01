/**
 * @fileoverview Tests for the supported-state
 * predicate that gates aviation_find_stations (issue #20).
 * @module tests/services/aviation-weather/supported-states.test
 */

import { describe, expect, it } from 'vitest';
import { isSupportedState } from '@/services/aviation-weather/supported-states.js';

describe('isSupportedState', () => {
  it('accepts a US state code', () => {
    expect(isSupportedState('WA')).toBe(true);
  });

  it('accepts DC', () => {
    expect(isSupportedState('DC')).toBe(true);
  });

  it('accepts a lowercase code', () => {
    expect(isSupportedState('wa')).toBe(true);
  });

  it('rejects an unknown code', () => {
    expect(isSupportedState('ZZ')).toBe(false);
  });

  /**
   * AWC leaves `state` empty on territory stations and identifies them by
   * `country` instead, so a state filter would return zero stations rather than
   * working. They stay unsupported until a country-based filter path exists.
   */
  it.each(['PR', 'VI', 'GU', 'MP', 'AS'])('rejects the %s territory', (code) => {
    expect(isSupportedState(code)).toBe(false);
  });

  it('does not treat inherited Object properties as states', () => {
    expect(isSupportedState('constructor')).toBe(false);
    expect(isSupportedState('toString')).toBe(false);
  });
});

describe('supported jurisdictions', () => {
  it('covers the 50 US states plus DC', () => {
    const states =
      'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(
        ' ',
      );
    expect(states).toHaveLength(51);
    for (const state of states) expect(isSupportedState(state)).toBe(true);
  });
});
