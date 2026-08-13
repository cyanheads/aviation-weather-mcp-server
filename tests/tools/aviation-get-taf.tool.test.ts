/**
 * @fileoverview Tests for the aviation_get_taf tool.
 * @module tests/tools/aviation-get-taf.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
  visibility_sm: '6',
  weather: 'light rain',
  clouds: [{ cover: 'BKN', base_ft: 2500, type: null }],
};

const tempoPeriod: NormalizedTafPeriod = {
  from: '2026-01-15T21:00:00.000Z',
  to: '2026-01-15T23:00:00.000Z',
  change_type: 'TEMPO',
  probability: 30,
  wind: { direction_deg: 200, speed_kt: 20, gust_kt: 30 },
  visibility_sm: '1/2',
  weather: 'thunderstorm with rain',
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
      visibility_sm: null,
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
  visibility_sm: '1',
  weather: 'mist',
  clouds: [],
};

/** A period genuinely forecasting calm — raw `00000KT`. */
const calmPeriod: NormalizedTafPeriod = {
  ...basePeriod,
  wind: { direction_deg: 0, speed_kt: 0, gust_kt: null },
};

/** Render one forecast period and return its text block. */
function render(period: NormalizedTafPeriod): string {
  const blocks = aviationGetTaf.format!({
    forecasts: [{ ...kseaTaf, forecast_periods: [period] }],
  });
  return (blocks[0] as { type: string; text: string }).text;
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
