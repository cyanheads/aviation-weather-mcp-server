/**
 * @fileoverview Tests for the aviation_get_advisories tool.
 * @module tests/tools/aviation-get-advisories.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

/**
 * A SIGMET that stated no severity, altitude bounds, or movement — the sparse
 * shape the null-rendering cases need. `/airsigmet` pins `airSigmetType` to
 * `SIGMET`, so an AIRMET fixture would encode a row the source cannot emit.
 */
const sparseSigmet: NormalizedAdvisory = {
  advisory_type: 'SIGMET',
  series_id: 'SFOT0',
  hazard: 'IFR',
  severity: null,
  issued_by: 'KKCI',
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
  raw_text: 'KKCI SIGT0 IFR CONDS',
};

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('aviationGetAdvisories', () => {
  it('returns advisories for default "all" type', async () => {
    mockFetchAdvisories.mockResolvedValue([sigmet, sparseSigmet]);
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
    mockFetchAdvisories.mockResolvedValue([sparseSigmet]);
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

  it('handles advisory with null altitude and movement (sparse)', async () => {
    mockFetchAdvisories.mockResolvedValue([sparseSigmet]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const input = aviationGetAdvisories.input.parse({ advisory_type: 'sigmet' });
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
// AIRMET requests are rejected, not answered (issue #12) — the only upstream
// source is `/airsigmet`, whose `airSigmetType` is pinned to `SIGMET`, so an
// AIRMET request was being answered with convective SIGMETs
// ---------------------------------------------------------------------------

describe('aviationGetAdvisories AIRMET rejection', () => {
  /** Run the handler over live-looking rows and return the error it threw. */
  async function errorFor(input: Record<string, unknown>) {
    mockFetchAdvisories.mockResolvedValue([sigmet]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    try {
      await aviationGetAdvisories.handler(aviationGetAdvisories.input.parse(input), ctx);
    } catch (e) {
      return e as {
        code: number;
        message: string;
        data?: { reason?: string; recovery?: { hint?: string } };
      };
    }
    throw new Error('handler resolved where it was expected to throw');
  }

  it('rejects advisory_type "airmet" rather than answering it with SIGMETs', async () => {
    const err = await errorFor({ advisory_type: 'airmet' });

    expect(err.data?.reason).toBe('airmet_not_served');
    expect(mockFetchAdvisories).not.toHaveBeenCalled();
  });

  it.each(['MTN OBSCN', 'SURFACE WIND', 'LLWS'] as const)(
    'rejects the %s hazard rather than returning an empty array',
    async (hazard) => {
      // These three name AIRMET-family phenomena. `/airsigmet` enumerates only
      // conv, turb, ice, and ifr, so no row can ever carry them — an empty
      // result read as "this hazard is not active" rather than "not served".
      const err = await errorFor({ hazard });

      expect(err.data?.reason).toBe('airmet_not_served');
      expect(mockFetchAdvisories).not.toHaveBeenCalled();
    },
  );

  it('carries a typed reason and recovery, not a transport-level -32602', async () => {
    // Rejecting in the handler rather than narrowing the Zod enum is what puts
    // the reason and the recovery hint on the wire.
    expect(aviationGetAdvisories.input.safeParse({ advisory_type: 'airmet' }).success).toBe(true);
    expect(aviationGetAdvisories.input.safeParse({ hazard: 'LLWS' }).success).toBe(true);

    const err = await errorFor({ advisory_type: 'airmet' });

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.code).not.toBe(-32602);
    expect(err.data?.recovery?.hint).toBeTruthy();
  });

  it('points the recovery at what this tool does serve', async () => {
    const hint = String((await errorFor({ advisory_type: 'airmet' })).data?.recovery?.hint);

    expect(hint).toContain('sigmet');
    expect(hint).toContain('all');
    expect(hint).toMatch(/SIGMET/);
  });

  it('names the products that carry AIRMET information today', async () => {
    const hint = String((await errorFor({ hazard: 'MTN OBSCN' })).data?.recovery?.hint);

    expect(hint).toMatch(/G-AIRMET|Graphical AIRMET/);
    expect(hint).toMatch(/textual AIRMET/);
    // The CONUS retirement is what makes G-AIRMET the replacement rather than a
    // parallel product; naming a region set here would overstate what was checked.
    expect(hint).toMatch(/CONUS/);
  });

  it('reports invalid_bbox ahead of the AIRMET rejection', async () => {
    // Guard order: a malformed bbox is the caller's first fixable mistake.
    const err = await errorFor({
      advisory_type: 'airmet',
      bbox: { minLat: 49, minLon: -66, maxLat: 25, maxLon: -125 },
    });

    expect(err.data?.reason).toBe('invalid_bbox');
  });

  it.each(['sigmet', 'all'] as const)('leaves advisory_type %s serving advisories', async (t) => {
    mockFetchAdvisories.mockResolvedValue([sigmet, sparseSigmet]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const result = await aviationGetAdvisories.handler(
      aviationGetAdvisories.input.parse({ advisory_type: t }),
      ctx,
    );

    expect(result.advisories).toHaveLength(2);
    expect(result).toEqual(expect.schemaMatching(aviationGetAdvisories.output));
  });

  it.each(['CONVECTIVE', 'TURBULENCE', 'ICING', 'IFR'] as const)(
    'leaves the %s hazard reaching the service',
    async (hazard) => {
      // The four with upstream counterparts stay in scope; their matching
      // behavior is a separate concern from whether they are served at all.
      mockFetchAdvisories.mockResolvedValue([sigmet]);
      const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
      await aviationGetAdvisories.handler(aviationGetAdvisories.input.parse({ hazard }), ctx);

      expect(mockFetchAdvisories).toHaveBeenCalledWith(expect.objectContaining({ hazard }), ctx);
    },
  );

  it('keeps an empty upstream result a valid state, not an error', async () => {
    mockFetchAdvisories.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const result = await aviationGetAdvisories.handler(
      aviationGetAdvisories.input.parse({ advisory_type: 'all' }),
      ctx,
    );

    expect(result.advisories).toEqual([]);
  });

  it('stops advertising AIRMET retrieval on the input and tool descriptions', async () => {
    const advisoryType = aviationGetAdvisories.input.shape.advisory_type;
    const hazard = aviationGetAdvisories.input.shape.hazard;

    expect(aviationGetAdvisories.description).not.toMatch(/AIRMETs\b(?!.*not)/);
    expect(String(advisoryType.description)).not.toMatch(/"all" returns both/);
    expect(String(hazard.description)).toMatch(/not served|no upstream counterpart|rejected/i);
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
    const blocks = aviationGetAdvisories.format!({ advisories: [sparseSigmet] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain(sparseSigmet.raw_text);
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
    const text = render(sparseSigmet);

    expect(text).not.toContain('SFC');
    expect(text).not.toContain('UNL');
  });

  it('renders a null severity as an explicit unreported state', () => {
    // Severity is populated on convective SIGMETs and null where the advisory
    // stated none, so a dropped line reads as a severity the renderer skipped.
    const text = render(sparseSigmet);

    expect(text).toContain('**Severity:** not reported');
  });

  it('renders a null movement as an explicit unreported state', () => {
    const text = render(sparseSigmet);

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
