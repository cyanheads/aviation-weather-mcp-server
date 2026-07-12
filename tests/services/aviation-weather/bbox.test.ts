/**
 * @fileoverview Tests for the shared bbox-ordering predicate (issue #6).
 * @module tests/services/aviation-weather/bbox.test
 */

import { describe, expect, it } from 'vitest';
import { isBboxOrdered } from '@/services/aviation-weather/bbox.js';

describe('isBboxOrdered', () => {
  it('accepts a correctly-ordered box', () => {
    expect(isBboxOrdered({ minLat: 25, minLon: -125, maxLat: 49, maxLon: -66 })).toBe(true);
  });

  it('accepts a degenerate (zero-area) box', () => {
    expect(isBboxOrdered({ minLat: 40, minLon: -100, maxLat: 40, maxLon: -100 })).toBe(true);
  });

  it('rejects an inverted-latitude box', () => {
    expect(isBboxOrdered({ minLat: 49, minLon: -125, maxLat: 25, maxLon: -66 })).toBe(false);
  });

  it('rejects an inverted-longitude box', () => {
    expect(isBboxOrdered({ minLat: 25, minLon: -66, maxLat: 49, maxLon: -125 })).toBe(false);
  });
});
