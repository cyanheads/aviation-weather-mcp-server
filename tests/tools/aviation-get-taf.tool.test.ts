/**
 * @fileoverview Tests for the aviation_get_taf tool.
 * @module tests/tools/aviation-get-taf.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationGetTaf } from '@/mcp-server/tools/definitions/aviation-get-taf.tool.js';
import type { NormalizedTaf, NormalizedTafPeriod } from '@/services/aviation-weather/types.js';

// ---------------------------------------------------------------------------
// Service mock
// ---------------------------------------------------------------------------

vi.mock('@/services/aviation-weather/aviation-weather-service.js', () => ({
  getAviationWeatherService: vi.fn(),
}));

import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

const mockFetchTaf = vi.fn<ReturnType<typeof getAviationWeatherService>['fetchTaf']>();

beforeEach(() => {
  vi.mocked(getAviationWeatherService).mockReturnValue({
    fetchTaf: mockFetchTaf,
  } as unknown as ReturnType<typeof getAviationWeatherService>);
  mockFetchTaf.mockReset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const basePeriod: NormalizedTafPeriod = {
  from: '2026-01-15T18:00:00.000Z',
  to: '2026-01-16T00:00:00.000Z',
  change_type: null,
  probability: null,
  wind: { direction_deg: 180, speed_kt: 12, gust_kt: null },
  wind_shear: null,
  visibility_sm: '6',
  vertical_visibility_ft: null,
  weather: { raw: '-RA', decoded: 'light rain' },
  clouds: [{ cover: 'BKN', base_ft: 2500, type: null }],
};

const tempoPeriod: NormalizedTafPeriod = {
  from: '2026-01-15T21:00:00.000Z',
  to: '2026-01-15T23:00:00.000Z',
  change_type: 'TEMPO',
  probability: 30,
  wind: { direction_deg: 200, speed_kt: 20, gust_kt: 30 },
  wind_shear: null,
  visibility_sm: '1/2',
  vertical_visibility_ft: null,
  weather: { raw: 'TSRA', decoded: 'thunderstorm with rain' },
  clouds: [
    { cover: 'OVC', base_ft: 800, type: null },
    { cover: 'BKN', base_ft: 1500, type: 'CB' },
  ],
};

/** TAF with epoch-seconds timestamps (as issued by the service after normalization). */
const kseaTaf: NormalizedTaf = {
  station_id: 'KSEA',
  name: 'Seattle-Tacoma International Airport',
  issued_at: '2026-01-15T17:30:00.000Z',
  valid_from: '2026-01-15T18:00:00.000Z',
  valid_to: '2026-01-16T18:00:00.000Z',
  forecast_periods: [basePeriod, tempoPeriod],
  raw_taf: 'KSEA 151730Z 1518/1618 18012KT P6SM BKN025',
};

/** Sparse TAF — minimal forecast period with no wx/clouds. */
const sparseTaf: NormalizedTaf = {
  station_id: 'KLAX',
  name: 'Los Angeles International Airport',
  issued_at: '2026-01-15T12:00:00.000Z',
  valid_from: '2026-01-15T12:00:00.000Z',
  valid_to: '2026-01-16T12:00:00.000Z',
  forecast_periods: [
    {
      from: '2026-01-15T12:00:00.000Z',
      to: '2026-01-16T00:00:00.000Z',
      change_type: null,
      probability: null,
      wind: { direction_deg: 270, speed_kt: 8, gust_kt: null },
      wind_shear: null,
      visibility_sm: null,
      vertical_visibility_ft: null,
      weather: null,
      clouds: [],
    },
  ],
  raw_taf: 'KLAX 151200Z 1512/1612 27008KT CAVOK',
};

/**
 * A TEMPO group that amends only visibility and weather — it carries no wind
 * element at all, so `wdir` and `wspd` both arrive null. 215 of 1617 live CONUS
 * forecast periods look like this.
 */
const windlessPeriod: NormalizedTafPeriod = {
  from: '2026-01-15T22:00:00.000Z',
  to: '2026-01-16T02:00:00.000Z',
  change_type: 'TEMPO',
  probability: null,
  wind: { direction_deg: null, speed_kt: null, gust_kt: null },
  wind_shear: null,
  visibility_sm: '1',
  vertical_visibility_ft: null,
  weather: { raw: 'BR', decoded: 'mist' },
  clouds: [],
};

/**
 * A TEMPO group forecasting showers and mist together. The value is two
 * space-delimited groups, which is what the decoder used to leave half coded.
 */
const multiGroupPeriod: NormalizedTafPeriod = {
  ...basePeriod,
  change_type: 'TEMPO',
  weather: { raw: '-SHRA BR', decoded: 'light rain showers; mist' },
};

/** A forecast group the decoder does not recognize, carried through verbatim. */
const unresolvedPeriod: NormalizedTafPeriod = {
  ...basePeriod,
  weather: { raw: '-SHRA XX', decoded: 'light rain showers; XX' },
};

/** A period genuinely forecasting calm — raw `00000KT`. */
const calmPeriod: NormalizedTafPeriod = {
  ...basePeriod,
  wind: { direction_deg: 0, speed_kt: 0, gust_kt: null },
};

/**
 * A quarter-mile fog forecast beneath a 200 ft indefinite ceiling — raw
 * `1/4SM FG VV002`. The obscuration reaches the tool as an OVX layer whose base
 * is the vertical visibility, the shape `aviation_get_metar` already returns.
 */
const obscuredPeriod: NormalizedTafPeriod = {
  ...basePeriod,
  visibility_sm: '0.25',
  weather: { raw: 'FG', decoded: 'fog' },
  vertical_visibility_ft: 200,
  clouds: [{ cover: 'OVX', base_ft: 200, type: null }],
};

/** A surface-level indefinite ceiling — raw `VV000`, the most hazardous value. */
const surfaceObscuredPeriod: NormalizedTafPeriod = {
  ...obscuredPeriod,
  vertical_visibility_ft: 0,
  clouds: [{ cover: 'OVX', base_ft: 0, type: null }],
};

/** An obscuration carrying a cloud-type qualifier — raw `VV008CB`. */
const obscuredCbPeriod: NormalizedTafPeriod = {
  ...obscuredPeriod,
  vertical_visibility_ft: 800,
  clouds: [{ cover: 'OVX', base_ft: 800, type: 'CB' }],
};

/** A period forecasting non-convective LLWS — raw `WS020/20040KT`. */
const shearPeriod: NormalizedTafPeriod = {
  ...basePeriod,
  wind_shear: { height_ft: 2000, direction_deg: 200, speed_kt: 40 },
};

/** Render one forecast period and return its text block. */
function render(period: NormalizedTafPeriod): string {
  const blocks = aviationGetTaf.format!({
    forecasts: [{ ...kseaTaf, forecast_periods: [period] }],
  });
  return (blocks[0] as { type: string; text: string }).text;
}

/** Run the handler over one forecast period and return it — `render`'s structuredContent twin. */
async function handle(period: NormalizedTafPeriod) {
  mockFetchTaf.mockResolvedValue([{ ...kseaTaf, forecast_periods: [period] }]);
  const ctx = createMockContext({ errors: aviationGetTaf.errors });
  const input = aviationGetTaf.input.parse({ station_ids: ['KSEA'] });
  const result = await aviationGetTaf.handler(input, ctx);
  return result.forecasts[0]!.forecast_periods[0]!;
}

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('aviationGetTaf', () => {
  it('returns forecasts for valid station IDs', async () => {
    mockFetchTaf.mockResolvedValue([kseaTaf]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetTaf.handler(input, ctx);

    expect(result.forecasts).toHaveLength(1);
    const forecast = result.forecasts[0]!;
    expect(forecast.station_id).toBe('KSEA');
    expect(forecast.forecast_periods).toHaveLength(2);
    expect(mockFetchTaf).toHaveBeenCalledWith(['KSEA'], ctx);
  });

  it('returns multiple forecasts for multiple station IDs', async () => {
    mockFetchTaf.mockResolvedValue([kseaTaf, sparseTaf]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KSEA', 'KLAX'] });
    const result = await aviationGetTaf.handler(input, ctx);

    expect(result.forecasts).toHaveLength(2);
  });

  it('epoch-seconds timestamps are ISO-8601 strings in output', async () => {
    mockFetchTaf.mockResolvedValue([kseaTaf]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetTaf.handler(input, ctx);

    // All time fields should be ISO strings, not numbers
    const taf = result.forecasts[0]!;
    expect(taf.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(taf.valid_to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(taf.forecast_periods[0]!.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('throws no_taf_available when service returns empty array', async () => {
    mockFetchTaf.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KSMX'] });

    await expect(aviationGetTaf.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_taf_available' },
    });
  });

  it('handles sparse TAF period with null visibility and no clouds', async () => {
    mockFetchTaf.mockResolvedValue([sparseTaf]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KLAX'] });
    const result = await aviationGetTaf.handler(input, ctx);

    const period = result.forecasts[0]!.forecast_periods[0]!;
    expect(period.visibility_sm).toBeNull();
    expect(period.weather).toBeNull();
    expect(period.clouds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Output-schema datum (issue #13) — TAF cloud bases are aerodrome heights, AGL
// ---------------------------------------------------------------------------

describe('aviationGetTaf output datum', () => {
  it('describes forecast cloud bases in feet AGL', () => {
    const description =
      aviationGetTaf.output.shape.forecasts.element.shape.forecast_periods.element.shape.clouds
        .element.shape.base_ft.description;

    expect(description).toContain('AGL');
    expect(description).not.toContain('MSL');
  });
});

// ---------------------------------------------------------------------------
// Format tests
// ---------------------------------------------------------------------------

describe('aviationGetTaf.format', () => {
  it('renders station ID, name, and issue time', () => {
    const blocks = aviationGetTaf.format!({ forecasts: [kseaTaf] });
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('KSEA');
    expect(text).toContain('Seattle-Tacoma');
    expect(text).toContain(kseaTaf.issued_at);
  });

  it('renders change type (TEMPO) and probability in period header', () => {
    const blocks = aviationGetTaf.format!({ forecasts: [kseaTaf] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('TEMPO');
    expect(text).toContain('30%');
  });

  it('renders wind gust in TEMPO period', () => {
    const blocks = aviationGetTaf.format!({ forecasts: [kseaTaf] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('30');
  });

  it('renders weather condition', () => {
    const blocks = aviationGetTaf.format!({ forecasts: [kseaTaf] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('light rain');
  });

  it('renders CB cloud type', () => {
    const blocks = aviationGetTaf.format!({ forecasts: [kseaTaf] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('CB');
  });

  it('renders raw TAF string', () => {
    const blocks = aviationGetTaf.format!({ forecasts: [kseaTaf] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain(kseaTaf.raw_taf);
  });

  it('renders variable wind direction as "variable"', () => {
    const varWindTaf: NormalizedTaf = {
      ...kseaTaf,
      forecast_periods: [
        { ...basePeriod, wind: { direction_deg: null, speed_kt: 3, gust_kt: null } },
      ],
    };
    const blocks = aviationGetTaf.format!({ forecasts: [varWindTaf] });
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('variable');
  });
});

// ---------------------------------------------------------------------------
// Unforecast wind vs. forecast calm (issue #15) — 13% of live forecast periods
// amend only visibility, weather, or cloud and carry no wind element
// ---------------------------------------------------------------------------

describe('aviationGetTaf wind', () => {
  it('carries a period with no wind element through as null', async () => {
    mockFetchTaf.mockResolvedValue([{ ...kseaTaf, forecast_periods: [windlessPeriod] }]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetTaf.handler(input, ctx);

    expect(result.forecasts[0]!.forecast_periods[0]!.wind).toMatchObject({
      speed_kt: null,
      direction_deg: null,
    });
  });

  it('keeps a forecast calm at 0 knots', async () => {
    mockFetchTaf.mockResolvedValue([{ ...kseaTaf, forecast_periods: [calmPeriod] }]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetTaf.handler(input, ctx);

    expect(result.forecasts[0]!.forecast_periods[0]!.wind.speed_kt).toBe(0);
  });

  it('accepts both shapes against the declared output schema', async () => {
    mockFetchTaf.mockResolvedValue([
      { ...kseaTaf, forecast_periods: [windlessPeriod, calmPeriod, basePeriod] },
    ]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetTaf.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(aviationGetTaf.output));
  });

  it('renders an unforecast wind explicitly rather than as a calm', () => {
    const text = render(windlessPeriod);

    expect(text).toContain('**Wind:** not specified');
    expect(text).not.toContain('at 0 kt');
    expect(text).not.toContain('variable at');
  });

  it('renders a forecast calm as 0 kt', () => {
    const text = render(calmPeriod);

    expect(text).toContain('at 0 kt');
    expect(text).not.toContain('not specified');
  });

  it('names the unknown state in the wind speed description', () => {
    const description =
      aviationGetTaf.output.shape.forecasts.element.shape.forecast_periods.element.shape.wind.shape
        .speed_kt.description ?? '';

    expect(description).toMatch(/null/);
    expect(description).toMatch(/calm|0/);
  });

  it('admits null on the wind speed and direction fields', () => {
    const wind =
      aviationGetTaf.output.shape.forecasts.element.shape.forecast_periods.element.shape.wind.shape;

    expect(wind.speed_kt.safeParse(null).success).toBe(true);
    expect(wind.speed_kt.safeParse(0).success).toBe(true);
    expect(wind.direction_deg.safeParse(null).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unreported states (issue #14) — a dropped line is indistinguishable from a
// renderer that skipped the value
// ---------------------------------------------------------------------------

describe('aviationGetTaf.format unreported states', () => {
  it('renders an unspecified visibility rather than dropping the line', () => {
    const text = render({ ...basePeriod, visibility_sm: null });

    expect(text).toContain('**Visibility:** not specified');
  });

  it('renders unspecified weather rather than dropping the line', () => {
    const text = render({ ...basePeriod, weather: null });

    expect(text).toContain('**Weather:** not specified');
  });

  it('renders an empty cloud array the way aviation_get_metar does', () => {
    const text = render({ ...basePeriod, clouds: [] });

    expect(text).toContain('**Clouds:** Clear');
  });

  it('renders a probability of 0 rather than treating it as absent', () => {
    // The old `period.probability ?` guard was falsy on 0 and dropped it.
    const text = render({ ...tempoPeriod, probability: 0 });

    expect(text).toContain('(0%)');
  });

  it('still omits the probability label when none was forecast', () => {
    const text = render({ ...basePeriod, probability: null });

    expect(text).not.toContain('%)');
  });
});

// ---------------------------------------------------------------------------
// Forecast weather shape (issue #21) — a period carries the raw group beside
// its decoded reading, so an unresolved group stays recoverable
// ---------------------------------------------------------------------------

describe('aviationGetTaf forecast weather', () => {
  const weather =
    aviationGetTaf.output.shape.forecasts.element.shape.forecast_periods.element.shape.weather;

  it('carries both forms to structuredContent', async () => {
    expect((await handle(multiGroupPeriod)).weather).toEqual({
      raw: '-SHRA BR',
      decoded: 'light rain showers; mist',
    });
  });

  it('renders both forms to content[]', () => {
    const text = render(multiGroupPeriod);

    expect(text).toContain('**Weather:** -SHRA BR (light rain showers; mist)');
  });

  it('keeps an unresolved group recoverable on both surfaces', async () => {
    expect((await handle(unresolvedPeriod)).weather?.raw).toBe('-SHRA XX');
    expect(render(unresolvedPeriod)).toContain('-SHRA XX (light rain showers; XX)');
  });

  it('accepts the object shape against the declared output schema', async () => {
    mockFetchTaf.mockResolvedValue([
      {
        ...kseaTaf,
        forecast_periods: [multiGroupPeriod, unresolvedPeriod, sparseTaf.forecast_periods[0]!],
      },
    ]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetTaf.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(aviationGetTaf.output));
  });

  it('admits the pair and null, and rejects a bare decoded string', () => {
    expect(weather.safeParse({ raw: 'BR', decoded: 'mist' }).success).toBe(true);
    expect(weather.safeParse(null).success).toBe(true);
    expect(weather.safeParse('mist').success).toBe(false);
  });

  it('names the verbatim passthrough in the decoded description', () => {
    // A consumer that does not know an unrecognized group comes back coded
    // will paraphrase the raw token as a decoded reading.
    expect(weather.unwrap().shape.decoded.description ?? '').toMatch(/raw token/);
  });
});

// ---------------------------------------------------------------------------
// Forecast obscuration (issue #28) — an OVX layer was filtered out before its
// height was ever consulted, so an obscured forecast rendered as a clear sky
// ---------------------------------------------------------------------------

describe('aviationGetTaf obscuration', () => {
  const periodShape =
    aviationGetTaf.output.shape.forecasts.element.shape.forecast_periods.element.shape;

  it('carries the obscuration layer and its height to structuredContent', async () => {
    const period = await handle(obscuredPeriod);

    expect(period.clouds).toEqual([{ cover: 'OVX', base_ft: 200, type: null }]);
    expect(period.vertical_visibility_ft).toBe(200);
  });

  it('never renders an obscured period as a clear sky', async () => {
    const text = render(obscuredPeriod);

    expect(text).not.toContain('**Clouds:** Clear');
    expect(text).toContain('OVX');
  });

  it('names the vertical visibility in content[]', () => {
    const text = render(obscuredPeriod);

    expect(text).toContain('200');
    expect(text.toLowerCase()).toContain('vertical visibility');
  });

  it('renders a surface-level indefinite ceiling rather than dropping it', () => {
    const text = render(surfaceObscuredPeriod);

    expect(text).not.toContain('**Clouds:** Clear');
    expect(text).toContain('OVX @ 0 ft');
    expect(text.toLowerCase()).toMatch(/vertical visibility:\*\* 0 ft/);
  });

  it('keeps a surface-level height on structuredContent as 0, not absent', async () => {
    expect((await handle(surfaceObscuredPeriod)).vertical_visibility_ft).toBe(0);
  });

  it('keeps the cloud-type qualifier on an obscuration across both surfaces', async () => {
    expect((await handle(obscuredCbPeriod)).clouds).toEqual([
      { cover: 'OVX', base_ft: 800, type: 'CB' },
    ]);
    expect(render(obscuredCbPeriod)).toContain('OVX @ 800 ft (CB)');
  });

  it('omits the vertical-visibility line on a period forecasting no obscuration', () => {
    const text = render(basePeriod);

    expect(text.toLowerCase()).not.toContain('vertical visibility');
  });

  it('reports no obscuration as null rather than 0', async () => {
    expect((await handle(basePeriod)).vertical_visibility_ft).toBeNull();
  });

  it('accepts an obscured period against the declared output schema', async () => {
    mockFetchTaf.mockResolvedValue([
      {
        ...kseaTaf,
        forecast_periods: [obscuredPeriod, surfaceObscuredPeriod, obscuredCbPeriod, basePeriod],
      },
    ]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetTaf.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(aviationGetTaf.output));
  });

  it('admits a height of 0 and null on the vertical-visibility field', () => {
    expect(periodShape.vertical_visibility_ft.safeParse(0).success).toBe(true);
    expect(periodShape.vertical_visibility_ft.safeParse(null).success).toBe(true);
  });

  it('names OVX in the cover description and drops CLR, which TAFs do not use', () => {
    const description = periodShape.clouds.element.shape.cover.description ?? '';

    expect(description).toContain('OVX');
    expect(description).not.toContain('CLR');
  });

  it('explains that an OVX base is the vertical visibility, not a cloud bottom', () => {
    const cover = periodShape.clouds.element.shape.cover.description ?? '';
    const base = periodShape.clouds.element.shape.base_ft.description ?? '';

    expect(`${cover} ${base}`.toLowerCase()).toContain('vertical visibility');
    expect(base).toContain('AGL');
  });

  it('states that the vertical visibility is an indefinite ceiling in feet', () => {
    const description = periodShape.vertical_visibility_ft.description ?? '';

    expect(description).toContain('feet');
    expect(description).toMatch(/indefinite ceiling/i);
    expect(description).toMatch(/null/);
  });
});

// ---------------------------------------------------------------------------
// Forecast low-level wind shear (issue #23) — the WS group is a takeoff and
// landing hazard and was recoverable only by re-parsing raw_taf
// ---------------------------------------------------------------------------

describe('aviationGetTaf wind shear', () => {
  const periodShape =
    aviationGetTaf.output.shape.forecasts.element.shape.forecast_periods.element.shape;

  it('carries the shear layer to structuredContent', async () => {
    expect((await handle(shearPeriod)).wind_shear).toEqual({
      height_ft: 2000,
      direction_deg: 200,
      speed_kt: 40,
    });
  });

  it('renders the height, direction, and speed to content[]', () => {
    const text = render(shearPeriod);

    expect(text).toContain('2000 ft');
    expect(text).toContain('200°');
    expect(text).toContain('40 kt');
  });

  it('renders the shear on its own line, not folded into the surface wind', () => {
    const text = render(shearPeriod);

    expect(text).toContain('**Wind:** 180° at 12 kt');
    expect(text.toLowerCase()).toContain('wind shear');
  });

  it('omits the shear line on a period forecasting none', () => {
    const text = render(basePeriod);

    expect(text.toLowerCase()).not.toContain('shear');
  });

  it('reports a period with no shear group as null', async () => {
    expect((await handle(basePeriod)).wind_shear).toBeNull();
  });

  it('leaves the surface wind fields untouched', async () => {
    const period = await handle(shearPeriod);

    expect(period.wind).toEqual({ direction_deg: 180, speed_kt: 12, gust_kt: null });
  });

  it('accepts a shear period against the declared output schema', async () => {
    mockFetchTaf.mockResolvedValue([{ ...kseaTaf, forecast_periods: [shearPeriod, basePeriod] }]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KSEA'] });
    const result = await aviationGetTaf.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(aviationGetTaf.output));
  });

  it('admits the object and null, and rejects a bare number', () => {
    expect(
      periodShape.wind_shear.safeParse({ height_ft: 2000, direction_deg: 200, speed_kt: 40 })
        .success,
    ).toBe(true);
    expect(periodShape.wind_shear.safeParse(null).success).toBe(true);
    expect(periodShape.wind_shear.safeParse(2000).success).toBe(false);
  });

  it('describes the height as the top of the layer in feet AGL', () => {
    const description = periodShape.wind_shear.unwrap().shape.height_ft.description ?? '';

    expect(description).toContain('AGL');
    expect(description).not.toContain('MSL');
    expect(description).toMatch(/top/i);
  });

  it('describes the speed as the wind at that height, not a shear magnitude', () => {
    // A reader who takes `speed_kt: 40` as "40 kt of shear" has read a wind
    // velocity as a vector difference.
    const description = periodShape.wind_shear.unwrap().shape.speed_kt.description ?? '';

    expect(description).toMatch(/not.*(magnitude|difference)|never.*(magnitude|difference)/i);
    expect(description).toMatch(/at (that|the) height|shear layer/i);
  });

  it('describes the direction as the wind direction, not a direction of shear', () => {
    const description = periodShape.wind_shear.unwrap().shape.direction_deg.description ?? '';

    expect(description).toMatch(/true/i);
    expect(description).toMatch(/not a (direction of shear|shear direction)/i);
  });

  it('states that a null is not a forecast of smooth air', () => {
    const description = periodShape.wind_shear.description ?? '';

    expect(description).toMatch(/TEMPO/);
    expect(description).toMatch(/PROB/);
    expect(description).toMatch(/convective/i);
    expect(description).toMatch(/not.*no shear|never.*no shear|rather than.*no shear/i);
  });
});

// ---------------------------------------------------------------------------
// Partial-batch disclosure (issue #18) — a station that issues no TAF was
// dropped without a trace, so a partial result read as full route coverage
// ---------------------------------------------------------------------------

describe('aviationGetTaf partial-batch disclosure', () => {
  /** Run the handler over a batch and return the enrichment it accumulated. */
  async function enrichmentFor(station_ids: string[], forecasts: NormalizedTaf[]) {
    mockFetchTaf.mockResolvedValue(forecasts);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids });
    await aviationGetTaf.handler(input, ctx);
    return getEnrichment(ctx);
  }

  it('names the station that returned no forecast', async () => {
    // KAWO is a registered station that transmits METARs but issues no TAF.
    expect(await enrichmentFor(['KSEA', 'KAWO'], [kseaTaf])).toMatchObject({
      requested: ['KSEA', 'KAWO'],
      returned: ['KSEA'],
      partial: true,
      missing: ['KAWO'],
    });
  });

  it('carries recovery guidance on a partial result', async () => {
    const notice = String((await enrichmentFor(['KSEA', 'KAWO'], [kseaTaf])).notice);

    expect(notice).toContain('KAWO');
    expect(notice).toMatch(/aviation_find_stations/);
    expect(notice).toMatch(/data_types/);
  });

  it('states completeness affirmatively on a full batch', async () => {
    const enrichment = await enrichmentFor(['KSEA', 'KLAX'], [kseaTaf, sparseTaf]);

    expect(enrichment).toMatchObject({
      requested: ['KSEA', 'KLAX'],
      returned: ['KSEA', 'KLAX'],
      partial: false,
    });
    expect(enrichment).not.toHaveProperty('missing');
    expect(enrichment).not.toHaveProperty('notice');
  });

  it('states no cause for an omission', async () => {
    const notice = String((await enrichmentFor(['KSEA', 'KAWO'], [kseaTaf])).notice);

    expect(notice).toMatch(/\bmay\b/);
    expect(notice).not.toMatch(/\b(is not a known station|issues no TAFs|does not issue)\b/);
  });

  it('still throws rather than disclosing an empty result as a partial one', async () => {
    mockFetchTaf.mockResolvedValue([]);
    const ctx = createMockContext({ errors: aviationGetTaf.errors });
    const input = aviationGetTaf.input.parse({ station_ids: ['KAWO', 'KZZZ'] });

    await expect(aviationGetTaf.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_taf_available' },
    });
    expect(getEnrichment(ctx)).not.toHaveProperty('partial');
  });

  it('reaches structuredContent and content[] through the real tool pipeline', async () => {
    mockFetchTaf.mockResolvedValue([kseaTaf]);
    const result = await runToolContract(aviationGetTaf, { station_ids: ['KSEA', 'KAWO'] });

    expect(result.structuredContent).toMatchObject({
      partial: true,
      missing: ['KAWO'],
      requested: ['KSEA', 'KAWO'],
      returned: ['KSEA'],
    });

    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('KAWO');
    expect(text).toContain('aviation_find_stations');
  });

  it('leaves the forecasts payload and its rendering untouched', async () => {
    mockFetchTaf.mockResolvedValue([kseaTaf]);
    const result = await runToolContract(aviationGetTaf, { station_ids: ['KSEA', 'KAWO'] });

    expect(result.structuredContent).toMatchObject({
      forecasts: [expect.objectContaining({ station_id: 'KSEA' })],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('## KSEA — Seattle-Tacoma International Airport');
  });

  it.each([['ksea'], ['SEA'], ['KSEATTLE'], ['']])(
    'rejects %p before reconciliation can run',
    (id) => {
      // Comparing the requested IDs against upstream `icaoId` is only a sound
      // set operation because the input contract fixes them at four uppercase
      // letters — a relaxed input would surface a casing mismatch as a missing
      // station rather than as the input error it is.
      expect(aviationGetTaf.input.safeParse({ station_ids: [id] }).success).toBe(false);
    },
  );

  it('rejects an empty batch rather than reconciling nothing', () => {
    expect(aviationGetTaf.input.safeParse({ station_ids: [] }).success).toBe(false);
  });

  it('rejects a batch past the 4-station cap', () => {
    expect(
      aviationGetTaf.input.safeParse({ station_ids: ['KSEA', 'KPDX', 'KLAX', 'KJFK', 'KBOS'] })
        .success,
    ).toBe(false);
  });

  it('renders a deep period on a second station, not just the first of each', async () => {
    // forecasts[1].forecast_periods[2] — the obscuration and the shear both sit
    // past the first index at both levels of the nesting.
    mockFetchTaf.mockResolvedValue([
      { ...kseaTaf, forecast_periods: [basePeriod, calmPeriod] },
      {
        ...sparseTaf,
        forecast_periods: [basePeriod, shearPeriod, obscuredCbPeriod],
      },
    ]);
    const result = await runToolContract(aviationGetTaf, { station_ids: ['KSEA', 'KLAX'] });

    const periods = (
      result.structuredContent as { forecasts: { forecast_periods: NormalizedTafPeriod[] }[] }
    ).forecasts[1]!.forecast_periods;
    expect(periods[1]!.wind_shear).toEqual({ height_ft: 2000, direction_deg: 200, speed_kt: 40 });
    expect(periods[2]!.vertical_visibility_ft).toBe(800);

    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('**Vertical visibility:** 800 ft AGL (indefinite ceiling)');
    expect(text).toContain('OVX @ 800 ft (CB)');
    expect(text).toContain('layer top 2000 ft AGL, forecast wind 200° at 40 kt');
  });

  it('renders the obscuration and shear through the real pipeline too', async () => {
    // Both surfaces at once: the enrichment trailer must not displace the
    // forecast-period rendering the other two issues added.
    mockFetchTaf.mockResolvedValue([
      { ...kseaTaf, forecast_periods: [obscuredPeriod, shearPeriod] },
    ]);
    const result = await runToolContract(aviationGetTaf, { station_ids: ['KSEA'] });

    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('**Vertical visibility:** 200 ft AGL (indefinite ceiling)');
    expect(text).toContain('OVX @ 200 ft');
    expect(text).toContain('layer top 2000 ft AGL, forecast wind 200° at 40 kt');

    const periods = (
      result.structuredContent as {
        forecasts: { forecast_periods: NormalizedTafPeriod[] }[];
      }
    ).forecasts[0]!.forecast_periods;
    expect(periods[0]!.vertical_visibility_ft).toBe(200);
    expect(periods[1]!.wind_shear).toEqual({ height_ft: 2000, direction_deg: 200, speed_kt: 40 });
  });
});
