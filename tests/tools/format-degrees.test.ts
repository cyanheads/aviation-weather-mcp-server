/**
 * @fileoverview Tests for the shared coordinate renderer used by every tool's
 * format() — the one numeric contract content[] and structuredContent share.
 * @module tests/tools/format-degrees.test
 */

import { describe, expect, it } from 'vitest';
import { formatDegrees } from '@/mcp-server/tools/format-degrees.js';

describe('formatDegrees', () => {
  it('keeps every decimal place upstream published', () => {
    // stationinfo publishes latitudes at 1–14 decimal places; 57 of 139
    // stations in one live bbox exceeded the 4 that toFixed(4) allowed.
    expect(formatDegrees(47.44467)).toBe('47.44467');
    expect(formatDegrees(-122.31442)).toBe('-122.31442');
  });

  it('does not pad a low-precision coordinate', () => {
    expect(formatDegrees(38.87)).toBe('38.87');
    expect(formatDegrees(-88.9)).toBe('-88.9');
  });

  it('keeps a 3-decimal polygon vertex intact', () => {
    // airsigmet publishes 3 decimals on 201 of 224 live values; toFixed(2)
    // moved such a vertex by up to ~1 km.
    expect(formatDegrees(30.536)).toBe('30.536');
    expect(formatDegrees(30.495)).toBe('30.495');
  });

  it('collapses a float representation artifact', () => {
    // K2S8's latitude arrives as 47.75419998168945 for a true 47.7542.
    expect(formatDegrees(47.75419998168945)).toBe('47.7542');
    expect(formatDegrees(46.87694358825684)).toBe('46.876944');
  });

  it('renders a whole degree without a decimal point', () => {
    expect(formatDegrees(41)).toBe('41');
  });

  it('renders zero and negative zero identically', () => {
    expect(formatDegrees(0)).toBe('0');
    expect(formatDegrees(-0)).toBe('0');
    expect(formatDegrees(-0.0000001)).toBe('0');
  });

  it('keeps the poles and the antimeridian intact', () => {
    expect(formatDegrees(90)).toBe('90');
    expect(formatDegrees(-180)).toBe('-180');
  });
});
