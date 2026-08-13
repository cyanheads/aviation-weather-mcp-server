/**
 * @fileoverview Tests for the state→bbox table and the supported-state
 * predicate that gates aviation_find_stations (issue #20).
 * @module tests/services/aviation-weather/state-bboxes.test
 */

import { describe, expect, it } from 'vitest';
import { isBboxOrdered } from '@/services/aviation-weather/bbox.js';
import { isSupportedState, STATE_BBOXES } from '@/services/aviation-weather/state-bboxes.js';

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
   * `country` instead, so a bbox entry would return zero stations rather than
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

describe('STATE_BBOXES', () => {
  it('covers the 50 US states plus DC', () => {
    expect(Object.keys(STATE_BBOXES)).toHaveLength(51);
  });

  it('holds only correctly-ordered boxes', () => {
    for (const [code, bbox] of Object.entries(STATE_BBOXES)) {
      expect(isBboxOrdered(bbox), code).toBe(true);
    }
  });

  it('places the DC box over the National Capital Region', () => {
    const dc = STATE_BBOXES.DC!;
    // The single station AWC reports for DC (WASD2) sits at 38.87, -77.02.
    expect(dc.minLat).toBeLessThanOrEqual(38.87);
    expect(dc.maxLat).toBeGreaterThanOrEqual(38.87);
    expect(dc.minLon).toBeLessThanOrEqual(-77.02);
    expect(dc.maxLon).toBeGreaterThanOrEqual(-77.02);
  });
});
