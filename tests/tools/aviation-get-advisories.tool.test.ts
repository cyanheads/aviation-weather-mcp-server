/**
 * @fileoverview Tests for the aviation_get_advisories tool.
 * @module tests/tools/aviation-get-advisories.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationGetAdvisories } from '@/mcp-server/tools/definitions/aviation-get-advisories.tool.js';
import type { NormalizedAdvisory } from '@/services/aviation-weather/types.js';

// ---------------------------------------------------------------------------
// Service mock
// ---------------------------------------------------------------------------

// Only the service accessor is stubbed. `isSigmetHazard` is the real hazard
// vocabulary the handler rejects against, and stubbing it would leave the
// AIRMET-rejection tests asserting against a fake list.
vi.mock('@/services/aviation-weather/aviation-weather-service.js', async (importActual) => {
  const actual =
    await importActual<typeof import('@/services/aviation-weather/aviation-weather-service.js')>();
  return { ...actual, getAviationWeatherService: vi.fn() };
});

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
    // The tool's own spelling reaches the service, which owns the mapping to
    // the token `/airsigmet` accepts — the handler never builds the URL, so
    // this is the value the service needs to build the mapped one.
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
// Zero-draw disclosure (issue #33) — an empty result rendered identically
// whether nothing was active, the hazard matched nothing, or the bbox excluded
// everything, and nothing machine-readable separated them
// ---------------------------------------------------------------------------

describe('aviationGetAdvisories zero-draw disclosure', () => {
  const quietBbox = { minLat: 46.5, minLon: -125.5, maxLat: 47.5, maxLon: -124.5 };

  /**
   * Resolve the service mock with `advisories`, reporting `drawnRows` through
   * the pre-filter channel. Defaults to the returned length — the shape of a
   * call whose bbox filter removed nothing.
   */
  function mockDraw(advisories: NormalizedAdvisory[], drawnRows = advisories.length) {
    mockFetchAdvisories.mockImplementation(async (params) => {
      params.onPreFilterRows?.(drawnRows);
      return advisories;
    });
  }

  /** Run the handler and return the enrichment it accumulated. */
  async function enrichmentFor(input: Record<string, unknown>) {
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    await aviationGetAdvisories.handler(aviationGetAdvisories.input.parse(input), ctx);
    return getEnrichment(ctx);
  }

  it('states an unfiltered empty draw as the fair-weather result', async () => {
    mockDraw([], 0);
    const notice = String((await enrichmentFor({})).notice);

    expect(notice).toMatch(/no domestic sigmets are active/i);
    expect(notice).toMatch(/fair.weather/i);
  });

  it('names the hazard filter when the draw it scoped came back empty', async () => {
    // The live shape this was written against — every active advisory
    // convective, `hazard=turb` answering HTTP 204 throughout — is recorded
    // with its draw counts in decision 23. The measurement lives there rather
    // than here so the two cannot drift apart.
    mockDraw([], 0);
    const notice = String((await enrichmentFor({ hazard: 'TURBULENCE' })).notice);

    expect(notice).toContain('TURBULENCE');
    expect(notice).toMatch(/drop the hazard filter/i);
  });

  it('does not claim other advisories are active behind a hazard filter', async () => {
    // AWC answers the same HTTP 204 for a hazard with nothing active and for a
    // feed with nothing active at all, so the counts in hand cannot separate
    // them once the hazard is applied upstream. The notice must not assert one.
    mockDraw([], 0);
    const notice = String((await enrichmentFor({ hazard: 'ICING' })).notice);

    expect(notice).not.toMatch(/advisories are active/i);
    expect(notice).not.toMatch(/active elsewhere/i);
  });

  it('names the bbox when a non-empty draw returned nothing', async () => {
    // Confirmed live: the 16 active advisories overlap none of this box.
    mockDraw([], 16);
    const notice = String((await enrichmentFor({ bbox: quietBbox })).notice);

    expect(notice).toContain('16');
    expect(notice).toMatch(/bbox/i);
    expect(notice).toMatch(/widen|drop it/i);
  });

  it('attributes a hazard+bbox call to the hazard when the draw was already empty', async () => {
    // The bbox never ran — AWC applied the hazard first, so blaming the box
    // would point the caller at a filter that saw nothing.
    mockDraw([], 0);
    const notice = String((await enrichmentFor({ hazard: 'IFR', bbox: quietBbox })).notice);

    expect(notice).toContain('IFR');
    expect(notice).toMatch(/never applied|already empty/i);
  });

  it('says the bbox is not the cause when the unfiltered feed itself is empty', async () => {
    mockDraw([], 0);
    const notice = String((await enrichmentFor({ bbox: quietBbox })).notice);

    expect(notice).toMatch(/bbox is not the cause/i);
  });

  it('asserts nothing when no draw was reported at all', async () => {
    // `fetchAdvisories` returns before the pre-filter channel fires when AWC
    // serves a body that is not an array, so no count arrives. Defaulting that
    // to zero would claim fair weather off a draw the tool never read — the one
    // notice in the set that could state something it did not observe.
    mockFetchAdvisories.mockResolvedValue([]);
    const enrichment = await enrichmentFor({});

    expect(enrichment.notice).toBeUndefined();
  });

  it('reads the drawn count, not the returned one, when naming the bbox', async () => {
    // The same rule cap detection follows (decision 18): the count that
    // describes the draw is the one taken before the client-side filter.
    mockDraw([], 9);
    const notice = String((await enrichmentFor({ bbox: quietBbox })).notice);

    expect(notice).toContain('9');
    expect(notice).not.toMatch(/\b0 active/);
  });

  it('carries no notice on a non-empty result', async () => {
    mockDraw([sigmet, sparseSigmet]);
    const enrichment = await enrichmentFor({});

    expect(enrichment).not.toHaveProperty('notice');
  });

  it('carries no notice on a bbox that kept something', async () => {
    mockDraw([sparseSigmet], 2);
    const enrichment = await enrichmentFor({ bbox: quietBbox });

    expect(enrichment).not.toHaveProperty('notice');
  });

  it('leaves the empty result a valid state rather than an error', async () => {
    mockDraw([], 0);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });
    const result = await aviationGetAdvisories.handler(
      aviationGetAdvisories.input.parse({ hazard: 'ICING' }),
      ctx,
    );

    expect(result.advisories).toEqual([]);
  });

  it('reaches structuredContent and content[] through the real tool pipeline', async () => {
    mockDraw([], 16);
    const result = await runToolContract(aviationGetAdvisories, { bbox: quietBbox });

    expect(result.structuredContent).toMatchObject({
      advisories: [],
      notice: expect.stringContaining('16'),
    });

    // A client reading only content[] must learn the same two facts: the box is
    // what emptied the result, and widening it is what recovers the advisories.
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('16');
    expect(text).toMatch(/bbox/i);
  });

  it('leaves the advisories payload and its rendering untouched', async () => {
    mockDraw([sigmet]);
    const result = await runToolContract(aviationGetAdvisories, {});

    expect(result.structuredContent).toMatchObject({
      advisories: [expect.objectContaining({ series_id: 'BOSW0' })],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('1 active advisory');
    expect(text).toContain('## SIGMET: BOSW0 — CONVECTIVE');
  });

  it('discloses nothing on the rejected-product paths, which never draw', async () => {
    // `airmet_not_served` fires before any request goes out, so there is no
    // draw to attribute — the error carries the recovery instead.
    mockDraw([], 0);
    const ctx = createMockContext({ errors: aviationGetAdvisories.errors });

    await expect(
      aviationGetAdvisories.handler(aviationGetAdvisories.input.parse({ hazard: 'LLWS' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'airmet_not_served' } });
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
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
