/**
 * @fileoverview Tests for the aviation_get_advisories tool.
 * @module tests/tools/aviation-get-advisories.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationGetAdvisories } from '@/mcp-server/tools/definitions/aviation-get-advisories.tool.js';
import type { NormalizedAdvisory } from '@/services/aviation-weather/types.js';

// ---------------------------------------------------------------------------
// Service mock
// ---------------------------------------------------------------------------

vi.mock('@/services/aviation-weather/aviation-weather-service.js', () => ({
  getAviationWeatherService: vi.fn(),
}));

import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const mockFetchAdvisories =
  vi.fn<ReturnType<typeof getAviationWeatherService>['fetchAdvisories']>();

beforeEach(() => {
  vi.mocked(getAviationWeatherService).mockReturnValue({
    fetchAdvisories: mockFetchAdvisories,
  } as unknown as ReturnType<typeof getAviationWeatherService>);
  mockFetchAdvisories.mockReset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sigmet: NormalizedAdvisory = {
  advisory_type: 'SIGMET',
  series_id: 'BOSW0',
  hazard: 'CONVECTIVE',
  severity: 3,
  issued_by: 'KKCI',
  valid_from: '2026-01-15T18:00:00.000Z',
  valid_to: '2026-01-15T22:00:00.000Z',
  altitude_low_ft: 5000,
  altitude_high_ft: 25000,
  movement: { direction_deg: 270, speed_kt: 20 },
  polygon: [
    { lat: 42.0, lon: -90.0 },
    { lat: 44.0, lon: -90.0 },
    { lat: 44.0, lon: -87.0 },
    { lat: 42.0, lon: -87.0 },
  ],
  raw_text: 'KKCI SIGW 151800 CONVECTIVE SIGMET BOSW0',
};

const airmet: NormalizedAdvisory = {
  advisory_type: 'AIRMET',
  series_id: 'SFOsierra0',
  hazard: 'IFR',
  severity: null,
  issued_by: 'KSFO',
  valid_from: '2026-01-15T16:00:00.000Z',
  valid_to: '2026-01-15T22:00:00.000Z',
  altitude_low_ft: null,
  altitude_high_ft: null,
  movement: null,
  polygon: [
    { lat: 37.0, lon: -122.0 },
    { lat: 38.0, lon: -122.0 },
    { lat: 38.0, lon: -120.0 },
  ],
  raw_text: 'KSFO SIERRA0 IFR CONDS',
};

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('aviationGetAdvisories', () => {
  it('returns advisories for default "all" type', async () => {
    mockFetchAdvisories.mockResolvedValue([sigmet, airmet]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const input = aviationGetAdvisories.input.parse({});
    const result = await aviationGetAdvisories.handler(input, ctx);

    expect(result.advisories).toHaveLength(2);
    expect(mockFetchAdvisories).toHaveBeenCalledWith(
      expect.objectContaining({ advisoryType: 'all' }),
      ctx,
    );
  });

  it('passes advisory_type filter to the service', async () => {
    mockFetchAdvisories.mockResolvedValue([sigmet]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const input = aviationGetAdvisories.input.parse({ advisory_type: 'sigmet' });
    const result = await aviationGetAdvisories.handler(input, ctx);

    expect(result.advisories).toHaveLength(1);
    expect(mockFetchAdvisories).toHaveBeenCalledWith(
      expect.objectContaining({ advisoryType: 'sigmet' }),
      ctx,
    );
  });

  it('passes hazard filter to the service', async () => {
    mockFetchAdvisories.mockResolvedValue([sigmet]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const input = aviationGetAdvisories.input.parse({ hazard: 'CONVECTIVE' });
    await aviationGetAdvisories.handler(input, ctx);

    expect(mockFetchAdvisories).toHaveBeenCalledWith(
      expect.objectContaining({ hazard: 'CONVECTIVE' }),
      ctx,
    );
  });

  it('passes bbox filter to the service', async () => {
    mockFetchAdvisories.mockResolvedValue([airmet]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const input = aviationGetAdvisories.input.parse({
      bbox: { minLat: 36.0, minLon: -123.0, maxLat: 39.0, maxLon: -119.0 },
    });
    await aviationGetAdvisories.handler(input, ctx);

    expect(mockFetchAdvisories).toHaveBeenCalledWith(
      expect.objectContaining({
        bbox: { minLat: 36.0, minLon: -123.0, maxLat: 39.0, maxLon: -119.0 },
      }),
      ctx,
    );
  });

  it('returns empty advisories array when no advisories are active', async () => {
    mockFetchAdvisories.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const input = aviationGetAdvisories.input.parse({});
    const result = await aviationGetAdvisories.handler(input, ctx);

    expect(result.advisories).toHaveLength(0);
  });

  it('accepts SURFACE WIND hazard filter', async () => {
    mockFetchAdvisories.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    // Validates that the enum still accepts SURFACE WIND after the description fix
    const input = aviationGetAdvisories.input.parse({ hazard: 'SURFACE WIND' });
    expect(input.hazard).toBe('SURFACE WIND');
    await aviationGetAdvisories.handler(input, ctx);
    expect(mockFetchAdvisories).toHaveBeenCalledWith(
      expect.objectContaining({ hazard: 'SURFACE WIND' }),
      ctx,
    );
  });

  it('accepts LLWS hazard filter', async () => {
    mockFetchAdvisories.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const input = aviationGetAdvisories.input.parse({ hazard: 'LLWS' });
    expect(input.hazard).toBe('LLWS');
    await aviationGetAdvisories.handler(input, ctx);
    expect(mockFetchAdvisories).toHaveBeenCalledWith(
      expect.objectContaining({ hazard: 'LLWS' }),
      ctx,
    );
  });

  it('handles advisory with null altitude and movement (sparse)', async () => {
    mockFetchAdvisories.mockResolvedValue([airmet]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const input = aviationGetAdvisories.input.parse({ advisory_type: 'airmet' });
    const result = await aviationGetAdvisories.handler(input, ctx);

    const advisory = result.advisories[0]!;
    expect(advisory.altitude_low_ft).toBeNull();
    expect(advisory.altitude_high_ft).toBeNull();
    expect(advisory.movement).toBeNull();
    expect(advisory.severity).toBeNull();
  });

  it('throws invalid_bbox when the bounding box is inverted', async () => {
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const input = aviationGetAdvisories.input.parse({
      bbox: { minLat: 49, minLon: -66, maxLat: 25, maxLon: -125 },
    });

    await expect(aviationGetAdvisories.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_bbox' },
    });
    expect(mockFetchAdvisories).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Output-schema datum (issue #13) — SIGMET/AIRMET vertical extents are
// flight-level references and stay MSL, unlike aerodrome cloud heights
// ---------------------------------------------------------------------------

describe('aviationGetAdvisories output datum', () => {
  const advisory = aviationGetAdvisories.output.shape.advisories.element.shape;

  it.each(['altitude_low_ft', 'altitude_high_ft'] as const)(
    'keeps the %s description in feet MSL',
    (field) => {
      expect(advisory[field].description).toContain('MSL');
      expect(advisory[field].description).not.toContain('AGL');
    },
  );
});

// ---------------------------------------------------------------------------
// Format tests
// ---------------------------------------------------------------------------

describe('aviationGetAdvisories.format', () => {
  it('renders advisory count, type, and series_id', () => {
    const blocks = aviationGetAdvisories.format!({ advisories: [sigmet] });
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('1 active advisory');
    expect(text).toContain('SIGMET');
    expect(text).toContain('BOSW0');
  });

  it('renders hazard type', () => {
    const blocks = aviationGetAdvisories.format!({ advisories: [sigmet] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('CONVECTIVE');
  });

  it('renders severity when present', () => {
    const blocks = aviationGetAdvisories.format!({ advisories: [sigmet] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('3');
  });

  it('renders raw text', () => {
    const blocks = aviationGetAdvisories.format!({ advisories: [airmet] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain(airmet.raw_text);
  });

  it('renders valid period', () => {
    const blocks = aviationGetAdvisories.format!({ advisories: [sigmet] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain(sigmet.valid_from);
    expect(text).toContain(sigmet.valid_to);
  });

  it('renders both altitude bounds when the advisory stated them', () => {
    const blocks = aviationGetAdvisories.format!({ advisories: [sigmet] });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('5,000 ft');
    expect(text).toContain('25,000 ft');
  });
});

// ---------------------------------------------------------------------------
// Null states (issue #14) — a bound the advisory never stated must not render
// as a named condition asserting where the hazard begins or ends
// ---------------------------------------------------------------------------

describe('aviationGetAdvisories.format null states', () => {
  /** Render one advisory and return its text block. */
  function render(advisory: NormalizedAdvisory): string {
    const blocks = aviationGetAdvisories.format!({ advisories: [advisory] });
    return (blocks[0] as { type: string; text: string }).text;
  }

  it('does not claim SFC for an unstated altitude floor', () => {
    // All 20 advisories in one live sweep carried altitude_low_ft: null while
    // stating a top. SFC asserts the hazard reaches the ground.
    const text = render({ ...sigmet, altitude_low_ft: null });

    expect(text).not.toContain('SFC');
    expect(text).toContain('25,000 ft');
  });

  it('does not claim UNL for an unstated altitude ceiling', () => {
    const text = render({ ...sigmet, altitude_high_ft: null });

    expect(text).not.toContain('UNL');
    expect(text).toContain('5,000 ft');
  });

  it('renders both unstated bounds without inventing either', () => {
    const text = render(airmet);

    expect(text).not.toContain('SFC');
    expect(text).not.toContain('UNL');
  });

  it('renders a null severity as an explicit unreported state', () => {
    // Severity is populated on convective SIGMETs and null on AIRMETs, so a
    // dropped line reads as an AIRMET whose severity was simply not rendered.
    const text = render(airmet);

    expect(text).toContain('**Severity:** not reported');
  });

  it('renders a null movement as an explicit unreported state', () => {
    const text = render(airmet);

    expect(text).toContain('**Movement:** not reported');
  });

  it('does not call an unreported movement direction stationary', () => {
    const text = render({ ...sigmet, movement: { direction_deg: null, speed_kt: 20 } });

    expect(text).not.toContain('stationary');
    expect(text).toContain('20 kt');
  });

  it('renders a movement whose speed was not reported without inventing one', () => {
    const text = render({ ...sigmet, movement: { direction_deg: 270, speed_kt: null } });

    expect(text).toContain('270°');
    expect(text).not.toMatch(/at \d+ kt/);
  });

  it('renders polygon vertices at the resolution upstream published', () => {
    // airsigmet publishes 3 decimals on 201 of 224 live values; toFixed(2)
    // moved such a vertex by up to ~1 km.
    const text = render({
      ...sigmet,
      polygon: [
        { lat: 30.536, lon: -88.9 },
        { lat: 30.495, lon: -88.087 },
      ],
    });

    expect(text).toContain('30.536,-88.9');
    expect(text).toContain('30.495,-88.087');
    expect(text).not.toContain('30.54');
  });
});
