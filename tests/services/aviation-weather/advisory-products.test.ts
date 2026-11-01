/**
 * @fileoverview Advisory source, normalization and response contract regressions.
 * @module tests/services/aviation-weather/advisory-products.test
 */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationGetAdvisories } from '@/mcp-server/tools/definitions/aviation-get-advisories.tool.js';
import {
  AviationWeatherService,
  initAviationWeatherService,
} from '@/services/aviation-weather/aviation-weather-service.js';

const domestic = {
  airSigmetType: 'SIGMET',
  seriesId: '1W',
  icaoId: 'KKCI',
  hazard: 'CONVECTIVE',
  severity: 5,
  validTimeFrom: 1792371600,
  validTimeTo: 1792386000,
  movementDir: 240,
  movementSpd: 15,
  coords: [
    { lat: 30, lon: -100 },
    { lat: 32, lon: -98 },
  ],
  rawAirSigmet: 'BULLETIN\n\n```embedded```\nEND\n\n',
};
const international = {
  icaoId: 'PHFO',
  firId: 'KZAK',
  firName: 'OAKLAND OCEANIC',
  seriesId: 'XRAY 16',
  hazard: 'TC',
  qualifier: 'CHAMPI',
  base: null,
  top: 57000,
  geom: 'AREA',
  coords: [
    { lat: 10, lon: 179 },
    { lat: 12, lon: -179 },
  ],
  dir: 'WNW',
  spd: '10',
  rawSigmet: 'TC CHAMPI\nMOV WNW 10KT',
};
const cwa = {
  cwsu: 'ZAN',
  seriesId: '102',
  hazard: 'ICE',
  qualifier: 'MOD',
  base: 4000,
  top: 13000,
  geom: null,
  coords: [
    { lat: '61.593', lon: '-148.389' },
    { lat: '59.460', lon: '-135.317' },
  ],
  rawText: 'AREA MOD ICE 040-130.\n\n=',
};
const svc = new AviationWeatherService({} as AppConfig, {} as StorageService);
let feeds: Record<string, unknown>;
let http: ReturnType<typeof vi.fn>;
beforeEach(() => {
  feeds = { airsigmet: [domestic], isigmet: [international], cwa: [cwa] };
  http = vi.fn(async (url: string | URL | Request) => {
    const source = String(url).split('/').at(-1)!.split('?')[0]!;
    return new Response(JSON.stringify(feeds[source]), { status: 200 });
  });
  vi.stubGlobal('fetch', http);
  initAviationWeatherService({} as AppConfig, {} as StorageService);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

describe('advisory product contracts', () => {
  it.each(['TS', 'CONVECTIVE'] as const)(
    'keeps source-native thunderstorm output and independent failure for alias %s',
    async (hazard) => {
      feeds.airsigmet = [];
      feeds.isigmet = [{ ...international, hazard: 'TS' }];
      feeds.cwa = {};
      const result = await runToolContract(aviationGetAdvisories, { hazard });
      expect(result.structuredContent).toMatchObject({
        advisories: [{ hazard: 'TS' }],
        partial: true,
        coverage: [
          { status: 'ok', drawn: 0 },
          { status: 'ok', drawn: 1 },
          { status: 'failed', cancelled: null },
        ],
      });
      expect(textOf(result)).toContain('— TS');
      expect(textOf(result)).toContain('Coverage is partial');
    },
  );
  it('leaves altitude disclosures null when omitted or source/hazard is not applicable', async () => {
    const omitted = await runToolContract(aviationGetAdvisories, {});
    expect(omitted.structuredContent).not.toHaveProperty('altitude_selection');
    expect(omitted.structuredContent).toMatchObject({
      coverage: [
        { altitude_filter: null, altitude_unknown: null },
        { altitude_filter: null, altitude_unknown: null },
        { altitude_filter: null, altitude_unknown: null },
      ],
    });
    const selected = await runToolContract(aviationGetAdvisories, {
      hazard: 'TC',
      altitude_ft: 35000,
    });
    expect(selected.structuredContent).toMatchObject({
      coverage: [
        {
          status: 'not_applicable',
          drawn: null,
          cancelled: null,
          altitude_filter: null,
          altitude_unknown: null,
        },
        { status: 'ok', altitude_filter: 'upstream' },
        {
          status: 'not_applicable',
          drawn: null,
          cancelled: null,
          altitude_filter: null,
          altitude_unknown: null,
        },
      ],
    });
    expect(textOf(selected)).toContain('not_applicable');
  });
  it.each(['INTSF', 'WKN', 'NC', 'FUTURE', null])(
    'preserves international tendency %s and named CWA office',
    async (chng) => {
      feeds.isigmet = [{ ...international, chng }];
      feeds.cwa = [{ ...cwa, name: 'Anchorage' }];
      const result = await runToolContract(aviationGetAdvisories, {});
      expect(result.structuredContent).toMatchObject({
        advisories: [
          { tendency: null, issued_by_name: null },
          { tendency: chng, issued_by_name: null },
          { tendency: null, issued_by_name: 'Anchorage' },
        ],
      });
      expect(textOf(result)).toContain(`**Tendency:** ${chng ?? 'not reported'}`);
      expect(textOf(result)).toContain('Anchorage');
    },
  );
  it.each([
    ['-', '0', 'SEV TURB BTN FL300 AND FL400 STNR NC=', true],
    ['-', null, 'SEV TURB\nSTNR\nNC=', true],
    ['NE', '10', 'MOV NE 10KT NC=', false],
    ['-', '0', 'MOVEMENT UNKNOWN', null],
    ['NE', null, 'MOV NE', null],
    [null, null, 'MOVEMENT UNKNOWN', null],
    ['-', '0', 'NOTSTNR STNRX', null],
    ['-', '0', 'QUOTED "PREVIOUS STNR NC"', null],
    ['-', '0', "QUOTED 'STNR'", null],
  ] as const)(
    'derives stationarity from evidence while preserving source motion (%s,%s,%s)',
    async (dir, spd, rawSigmet, stationary) => {
      feeds.isigmet = [{ ...international, dir, spd, rawSigmet }];
      const result = await runToolContract(aviationGetAdvisories, { advisory_type: 'isigmet' });
      const movement =
        dir === null && spd === null && stationary === null
          ? null
          : {
              direction_deg: null,
              direction_text: dir,
              speed_kt: spd === null ? null : Number(spd),
              stationary,
            };
      expect(result.structuredContent).toMatchObject({
        advisories: [{ movement, raw_text: rawSigmet }],
      });
      const movementLine = textOf(result)
        .split('\n')
        .find((line) => line.startsWith('**Movement:**'))!;
      if (movement) {
        expect(movementLine).toContain(dir ?? 'not reported');
        expect(movementLine).toContain(spd === null ? 'unreported speed' : `${Number(spd)} kt`);
        expect(movementLine).toContain(
          stationary === true
            ? 'stationary'
            : stationary === false
              ? 'stationary: false'
              : 'stationary: not reported',
        );
      } else expect(movementLine).toBe('**Movement:** not reported');
    },
  );
  it.each([
    [0, 0, 0, 3000],
    [49, 0, 0, 3000],
    [50, 1, 0, 3100],
    [35049, 350, 32000, 38000],
    [35050, 351, 32100, 38100],
  ])(
    'rounds requested altitude %s to an integer upstream level',
    async (altitude, level, low, high) => {
      const result = await runToolContract(aviationGetAdvisories, { altitude_ft: altitude });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        altitude_selection: { requested_ft: altitude, level, band_low_ft: low, band_high_ft: high },
        coverage: [
          { source: 'sigmet', altitude_filter: 'upstream' },
          { source: 'isigmet', altitude_filter: 'upstream' },
          { source: 'cwa', altitude_filter: 'client' },
        ],
      });
      for (const [url] of http.mock.calls.slice(0, 2))
        expect(new URL(String(url)).searchParams.get('level')).toBe(String(level));
      expect(new URL(String(http.mock.calls[2]![0])).searchParams.has('level')).toBe(false);
      expect(textOf(result)).toContain(`requested ${altitude} ft MSL`);
      expect(textOf(result)).toContain(`FL${level}`);
      expect(textOf(result)).toContain(`${low}–${high} ft MSL`);
    },
  );
  it('selects inclusive CWA altitude overlaps, retains every unknown-bound shape and counts before bbox/limit', async () => {
    feeds.airsigmet = [];
    feeds.isigmet = {};
    feeds.cwa = [
      { ...cwa, seriesId: 'low-edge', base: 1000, top: 7000 },
      { ...cwa, seriesId: 'high-edge', base: 13000, top: 20000 },
      { ...cwa, seriesId: 'below', base: 0, top: 6999 },
      { ...cwa, seriesId: 'above', base: 13001, top: 20000 },
      { ...cwa, seriesId: 'unknown-low', base: null, top: 1000 },
      { ...cwa, seriesId: 'unknown-high', base: 20000, top: null },
      { ...cwa, seriesId: 'unknown-both', base: null, top: null, coords: [] },
      { ...cwa, seriesId: 'outside', base: 8000, top: 12000, coords: [{ lat: 1, lon: 1 }] },
      { rawText: 'ZAN CWA 203 VALID UNTIL 010345\nCNL CWA 202.\n=' },
    ];
    const result = await runToolContract(aviationGetAdvisories, {
      altitude_ft: 10000,
      bbox: { minLat: 58, maxLat: 63, minLon: -150, maxLon: -134 },
      limit: 2,
    });
    expect(result.structuredContent).toMatchObject({
      partial: true,
      drawn: 6,
      matched: 4,
      unlocated: 1,
      total: 4,
      returned: 2,
      truncated: true,
      coverage: [
        { drawn: 0, altitude_unknown: 0 },
        { status: 'failed', altitude_filter: null, altitude_unknown: null, cancelled: null },
        { drawn: 6, cancelled: 1, altitude_filter: 'client', altitude_unknown: 3 },
      ],
    });
    expect(textOf(result)).toContain('altitude_unknown 3');
    expect(textOf(result)).toContain('cancelled 1');
    const full = await runToolContract(aviationGetAdvisories, {
      advisory_type: 'cwa',
      altitude_ft: 10000,
    });
    expect(full.structuredContent).toMatchObject({
      advisories: [
        { series_id: 'low-edge' },
        { series_id: 'high-edge' },
        { series_id: 'unknown-low' },
        { series_id: 'unknown-high' },
        { series_id: 'unknown-both' },
        { series_id: 'outside' },
      ],
    });
  });
  it('does not second-guess upstream SIGMET altitude selection and discloses unknowns', async () => {
    feeds.isigmet = [
      { ...international, base: 0, top: 1000 },
      { ...international, base: null, top: null },
    ];
    const result = await runToolContract(aviationGetAdvisories, {
      advisory_type: 'isigmet',
      altitude_ft: 35000,
    });
    expect(result.structuredContent).toMatchObject({
      advisories: [{ altitude_high_ft: 1000 }, { altitude_high_ft: null }],
      coverage: [{ drawn: 2, altitude_unknown: 1 }],
    });
  });
  it('names altitude selection before bbox for empty and cancellation-only feeds', async () => {
    feeds.cwa = [
      { ...cwa, base: 0, top: 1000 },
      { rawText: 'ZAN CWA 203 VALID UNTIL 010345\nCNL CWA 202.' },
    ];
    const result = await runToolContract(aviationGetAdvisories, {
      advisory_type: 'cwa',
      altitude_ft: 35000,
      bbox: { minLat: 58, maxLat: 63, minLon: -150, maxLon: -134 },
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      advisories: [],
      partial: false,
      coverage: [{ drawn: 0, cancelled: 1, altitude_unknown: 0 }],
      drawn: 0,
      unlocated: 0,
      total: 0,
      truncated: false,
      notice: expect.stringContaining('altitude selection'),
    });
    expect(textOf(result)).toContain('bbox is not the cause');
  });
  it.each([-1, Infinity, NaN])(
    'rejects invalid altitude %s before any upstream read',
    async (altitude_ft) => {
      const result = await runToolContract(aviationGetAdvisories, { altitude_ft });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('altitude_ft');
      expect(http).not.toHaveBeenCalled();
    },
  );
  it('excludes a body-start CWA cancellation before all active counts without partial coverage', async () => {
    feeds.cwa = [
      {
        cwsu: 'ZAN',
        seriesId: '203',
        rawText: 'FAAK20 KZAN 010335\nZAN CWA 203 VALID UNTIL 010345\nCNL CWA 202.\n=',
      },
    ];
    const result = await runToolContract(aviationGetAdvisories, {
      advisory_type: 'cwa',
      bbox: { minLat: 0, maxLat: 90, minLon: -180, maxLon: 0 },
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      advisories: [],
      coverage: [{ status: 'ok', drawn: 0, cancelled: 1 }],
      partial: false,
      drawn: 0,
      matched: 0,
      unlocated: 0,
      returned: 0,
      total: 0,
      truncated: false,
    });
    expect(textOf(result)).toContain('cancelled 1');
  });
  it.each([
    'AREA MOD ICE. PREVIOUS CNL CWA 202.',
    '"CNL CWA 202" IS A PREVIOUS MESSAGE',
    'CNL CWA WITHOUT A NUMBER',
    'AREA TS\nCNL CWA 202.',
  ])('retains active or sparse CWA body %s', async (body) => {
    feeds.cwa = [{ rawText: `ZAN CWA 204 VALID UNTIL 010445\n${body}\n=` }];
    const result = await runToolContract(aviationGetAdvisories, { advisory_type: 'cwa' });
    expect(result.structuredContent).toMatchObject({
      advisories: [{ raw_text: `ZAN CWA 204 VALID UNTIL 010445\n${body}\n=` }],
      coverage: [{ drawn: 1, cancelled: 0 }],
      partial: false,
    });
  });
  it.each([
    [178, 180, 1],
    [-180, -176, 1],
    [-1, 1, 0],
  ] as const)('wraps extended source longitudes for %s..%s', async (minLon, maxLon, matched) => {
    feeds.isigmet = [
      {
        ...international,
        geom: 'AREAS',
        coords: [
          [
            { lat: 10, lon: 179 },
            { lat: 12, lon: 183 },
          ],
          [
            { lat: 10, lon: -541 },
            { lat: 12, lon: -537 },
          ],
        ],
      },
    ];
    const result = await runToolContract(aviationGetAdvisories, {
      advisory_type: 'isigmet',
      bbox: { minLat: 9, maxLat: 13, minLon, maxLon },
    });
    expect(result.structuredContent).toMatchObject({
      drawn: 1,
      matched,
      returned: matched,
      unlocated: 0,
    });
    if (matched) {
      expect(result.structuredContent).toMatchObject({
        advisories: [
          {
            raw_text: international.rawSigmet,
            geometry: {
              parts: [
                [
                  { lat: 10, lon: 179 },
                  { lat: 12, lon: -177 },
                ],
                [
                  { lat: 10, lon: 179 },
                  { lat: 12, lon: -177 },
                ],
              ],
            },
          },
        ],
      });
      expect(textOf(result)).toContain('12,-177');
    }
  });
  it('preserves canonical coordinates exactly and rejects an entire malformed multipart geometry', async () => {
    const coords = [
      { lat: 10, lon: 180 },
      { lat: 12, lon: -179.123 },
    ];
    feeds.isigmet = [{ ...international, coords }];
    expect(
      (await svc.fetchAdvisories({ advisoryType: 'isigmet' }, createMockContext()))[0]?.polygon,
    ).toEqual(coords);
    for (const invalid of [
      { lat: 91, lon: 181 },
      { lat: 10, lon: 'bad' },
      { lat: null, lon: 181 },
    ]) {
      feeds.isigmet = [{ ...international, coords: [coords, [invalid]] }];
      expect(
        (await svc.fetchAdvisories({ advisoryType: 'isigmet' }, createMockContext()))[0]?.geometry,
      ).toBeNull();
    }
  });
  it.each([
    [null, 21000, null, 29000, 21000, 29000],
    [undefined, 0, undefined, 0, 0, 0],
    [null, null, null, null, null, null],
    ['bad', 4000, Infinity, 12000, 4000, 12000],
  ])(
    'recovers only missing finite domestic altitude bounds (%s/%s)',
    async (low1, low2, high1, high2, low, high) => {
      feeds.airsigmet = [
        {
          ...domestic,
          altitudeLow1: low1,
          altitudeLow2: low2,
          altitudeHi1: high1,
          altitudeHi2: high2,
        },
      ];
      const result = await runToolContract(aviationGetAdvisories, { advisory_type: 'sigmet' });
      expect(result.structuredContent).toMatchObject({
        advisories: [{ altitude_low_ft: low, altitude_high_ft: high }],
      });
      expect(textOf(result)).toContain(
        low === null ? 'not specified' : `${low.toLocaleString()} ft`,
      );
      expect(textOf(result)).toContain(
        high === null ? 'not specified' : `${high.toLocaleString()} ft`,
      );
    },
  );
  it('keeps finite primary altitude bounds and domestic 180/0 movement', async () => {
    feeds.airsigmet = [
      {
        ...domestic,
        altitudeLow1: 0,
        altitudeLow2: 1000,
        altitudeHi1: 29000,
        altitudeHi2: 43000,
        movementDir: 180,
        movementSpd: 0,
      },
    ];
    const result = await runToolContract(aviationGetAdvisories, { advisory_type: 'sigmet' });
    expect(result.structuredContent).toMatchObject({
      advisories: [
        {
          altitude_low_ft: 0,
          altitude_high_ft: 29000,
          movement: { direction_deg: 180, speed_kt: 0 },
        },
      ],
    });
    expect(textOf(result)).toContain('0 ft – 29,000 ft');
    expect(textOf(result)).toContain('180° at 0 kt');
  });
  it('characterizes domestic numeric movement, severity and raw bulletin preservation', async () => {
    const rows = await svc.fetchAdvisories({ advisoryType: 'sigmet' }, createMockContext());
    expect(rows[0]).toMatchObject({
      severity: 5,
      movement: { direction_deg: 240, speed_kt: 15 },
      raw_text: domestic.rawAirSigmet,
    });
    expect(http).toHaveBeenCalledTimes(1);
    expect(String(http.mock.calls[0]![0])).toContain('/airsigmet?format=json');
  });
  it('preserves raw bulletin blank lines and embedded backticks in safe fences', async () => {
    const result = await runToolContract(aviationGetAdvisories, { advisory_type: 'sigmet' });
    expect(result.structuredContent).toMatchObject({
      advisories: [{ raw_text: domestic.rawAirSigmet }],
    });
    expect(textOf(result)).toContain('````text\n' + domestic.rawAirSigmet + '\n````');
  });
  it('draws independent domestic, international and CWA products by default', async () => {
    const result = await runToolContract(aviationGetAdvisories, {});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      advisories: [
        expect.objectContaining({ source: 'sigmet' }),
        expect.objectContaining({
          source: 'isigmet',
          fir_id: 'KZAK',
          movement: { direction_deg: null, direction_text: 'WNW', speed_kt: 10, stationary: false },
        }),
        expect.objectContaining({
          source: 'cwa',
          altitude_low_ft: 4000,
          severity: null,
          movement: null,
        }),
      ],
      partial: false,
      coverage: [
        expect.objectContaining({ source: 'sigmet', drawn: 1 }),
        expect.objectContaining({ source: 'isigmet', drawn: 1 }),
        expect.objectContaining({ source: 'cwa', drawn: 1 }),
      ],
    });
    expect(http).toHaveBeenCalledTimes(3);
    for (const value of ['KZAK', 'OAKLAND OCEANIC', 'CHAMPI', 'WNW', 'cwa', 'isigmet'])
      expect(textOf(result)).toContain(value);
  });
  it('discloses a surviving bbox match and separates missing geometry', async () => {
    feeds.airsigmet = [
      domestic,
      { ...domestic, seriesId: 'outside', coords: [{ lat: 50, lon: 50 }] },
      { rawAirSigmet: 'LOCATION NOT DECODED' },
    ];
    const result = await runToolContract(aviationGetAdvisories, {
      advisory_type: 'sigmet',
      bbox: { minLat: 29, minLon: -101, maxLat: 33, maxLon: -97 },
    });
    expect(result.structuredContent).toMatchObject({
      drawn: 3,
      matched: 1,
      returned: 1,
      unlocated: 1,
      notice: expect.stringContaining('bbox'),
    });
    expect(textOf(result)).toContain('unlocated');
  });
  it('skips unknown-field and receipt-only records while retaining actual sparse bulletins', async () => {
    feeds.airsigmet = [
      {},
      { foo: 'bar' },
      { receiptTime: '2026-10-19' },
      { rawAirSigmet: 'ONLY BULLETIN' },
    ];
    const result = await runToolContract(aviationGetAdvisories, { advisory_type: 'sigmet' });
    expect(result.structuredContent).toMatchObject({
      advisories: [{ raw_text: 'ONLY BULLETIN', series_id: null, hazard: null, geometry: null }],
      coverage: [{ drawn: 1, message: expect.stringContaining('3') }],
      partial: true,
    });
    expect(textOf(result)).toContain('## SIGMET: not reported — not reported');
  });
  it('preserves every multipart ring and matches a later part without inventing connecting edges', async () => {
    feeds.isigmet = [
      {
        ...international,
        geom: 'AREAS',
        coords: [
          [
            { lat: 10, lon: 10 },
            { lat: 11, lon: 11 },
          ],
          [
            { lat: 40, lon: 40 },
            { lat: 41, lon: 41 },
          ],
          [
            { lat: 60, lon: 60 },
            { lat: 61, lon: 61 },
          ],
        ],
      },
    ];
    const result = await runToolContract(aviationGetAdvisories, {
      advisory_type: 'isigmet',
      bbox: { minLat: 59, maxLat: 62, minLon: 59, maxLon: 62 },
    });
    expect(result.structuredContent).toMatchObject({
      matched: 1,
      advisories: [{ polygon: null, geometry: { kind: 'AREAS', parts: expect.any(Array) } }],
    });
    const row = (result.structuredContent as { advisories: { geometry: { parts: unknown[] } }[] })
      .advisories[0]!;
    expect(row.geometry.parts).toHaveLength(3);
    expect(textOf(result)).toContain('Geometry part 3:');
    const gap = await runToolContract(aviationGetAdvisories, {
      advisory_type: 'isigmet',
      bbox: { minLat: 25, maxLat: 26, minLon: 25, maxLon: 26 },
    });
    expect(gap.structuredContent).toMatchObject({ matched: 0, returned: 0 });
  });
  it.each([
    [-1, 1, 0],
    [178, 180, 1],
    [-180, -178, 1],
  ] as const)(
    'handles date-line geometry for ordered longitudes %s..%s',
    async (minLon, maxLon, matched) => {
      const result = await runToolContract(aviationGetAdvisories, {
        advisory_type: 'isigmet',
        bbox: { minLat: 9, maxLat: 13, minLon, maxLon },
      });
      expect(result.structuredContent).toMatchObject({ drawn: 1, matched, returned: matched });
    },
  );
  it('preserves LINE and null source kind; finite numeric strings decode without inferring raw altitudes', async () => {
    feeds.isigmet = [{ ...international, geom: 'LINE' }];
    const line = await runToolContract(aviationGetAdvisories, { advisory_type: 'isigmet' });
    expect(line.structuredContent).toMatchObject({
      advisories: [{ polygon: null, geometry: { kind: 'LINE' }, movement: { speed_kt: 10 } }],
    });
    feeds.cwa = [{ ...cwa, base: null, top: null, rawText: 'TOP FL430; MOV 10010KT' }];
    const result = await runToolContract(aviationGetAdvisories, { advisory_type: 'cwa' });
    expect(result.structuredContent).toMatchObject({
      advisories: [
        {
          altitude_low_ft: null,
          altitude_high_ft: null,
          severity: null,
          movement: null,
          polygon: [
            { lat: 61.593, lon: -148.389 },
            { lat: 59.46, lon: -135.317 },
          ],
          geometry: { kind: null },
        },
      ],
    });
    expect(textOf(result)).toContain('Geometry kind:** not reported');
    feeds.cwa = [{ ...cwa, coords: [{ lat: 'Infinity', lon: '-148' }] }];
    const unreadable = await runToolContract(aviationGetAdvisories, {
      advisory_type: 'cwa',
      bbox: { minLat: 0, maxLat: 90, minLon: -180, maxLon: 0 },
    });
    expect(unreadable.structuredContent).toMatchObject({ drawn: 1, matched: 0, unlocated: 1 });
  });
  it('retains independent healthy sources when one response is unreadable', async () => {
    feeds.isigmet = { broken: true };
    const result = await runToolContract(aviationGetAdvisories, {});
    expect(result.structuredContent).toMatchObject({
      advisories: [
        expect.objectContaining({ source: 'sigmet' }),
        expect.objectContaining({ source: 'cwa' }),
      ],
      coverage: [
        expect.objectContaining({ status: 'ok' }),
        { source: 'isigmet', status: 'failed', drawn: null, message: expect.any(String) },
        expect.objectContaining({ status: 'ok' }),
      ],
      partial: true,
    });
    expect(textOf(result)).toContain('Coverage is partial');
    expect(textOf(result)).not.toContain('fair-weather');
  });
  it.each(['not-json', '', '<html>outage</html>'])(
    'does not interpret unreadable body %j as a successful zero',
    async (body) => {
      http.mockImplementation(async (url: string) =>
        String(url).includes('/isigmet?') ? new Response(body) : new Response('[]'),
      );
      vi.useFakeTimers();
      const pending = runToolContract(aviationGetAdvisories, {});
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.structuredContent).toMatchObject({
        partial: true,
        coverage: [
          expect.objectContaining({ source: 'sigmet', drawn: 0 }),
          expect.objectContaining({ source: 'isigmet', status: 'failed', drawn: null }),
          expect.objectContaining({ source: 'cwa', drawn: 0 }),
        ],
      });
    },
  );
  it('declares all-source failure with recovery on both response surfaces', async () => {
    feeds = { airsigmet: {}, isigmet: null, cwa: 'unreadable' };
    const result = await runToolContract(aviationGetAdvisories, {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'advisory_sources_failed',
          recovery: { hint: expect.stringContaining('Retry') },
        },
      },
    });
    expect(textOf(result)).toContain('no weather absence');
    expect(textOf(result)).toContain('advisory_sources_failed');
  });
  it('maps an upstream HTTP refusal to safe advisory failure without leaking its body', async () => {
    http.mockResolvedValue(
      new Response(JSON.stringify({ status: 'error', error: 'PRIVATE-UPSTREAM-BODY' }), {
        status: 400,
      }),
    );
    const result = await runToolContract(aviationGetAdvisories, { advisory_type: 'sigmet' });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: { reason: 'advisory_sources_failed', recovery: { hint: expect.any(String) } },
      },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-UPSTREAM-BODY');
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('only readable arrays or HTTP 204 establish zero', async () => {
    http.mockResolvedValue(new Response(null, { status: 204 }));
    const result = await runToolContract(aviationGetAdvisories, {});
    expect(result.structuredContent).toMatchObject({
      advisories: [],
      partial: false,
      coverage: [
        { source: 'sigmet', drawn: 0, status: 'ok' },
        { source: 'isigmet', drawn: 0, status: 'ok' },
        { source: 'cwa', drawn: 0, status: 'ok' },
      ],
    });
    expect(result.structuredContent).not.toHaveProperty('drawn');
    expect(result.structuredContent).not.toHaveProperty('matched');
  });
  it.each(['TS', 'CONVECTIVE'] as const)(
    'maps thunderstorm alias %s across independent sources',
    async (hazard) => {
      feeds.isigmet = [];
      feeds.cwa = [];
      const result = await runToolContract(aviationGetAdvisories, { hazard });
      expect(result.structuredContent).toMatchObject({
        coverage: [
          { source: 'sigmet', status: 'ok', drawn: 1 },
          { source: 'isigmet', status: 'ok', drawn: 0 },
          { source: 'cwa', status: 'ok', drawn: 0 },
        ],
      });
      expect(http).toHaveBeenCalledTimes(3);
      expect(String(http.mock.calls[0]![0])).toContain('hazard=conv');
      for (const [url] of http.mock.calls.slice(1)) expect(String(url)).toContain('hazard=ts');
      expect(result.structuredContent).toMatchObject({ advisories: [{ hazard: 'CONVECTIVE' }] });
      expect(textOf(result)).toContain('CONVECTIVE');
    },
  );
  it.each([
    ['sigmet', 'CONVECTIVE', 'conv'],
    ['sigmet', 'TS', 'conv'],
    ['isigmet', 'CONVECTIVE', 'ts'],
    ['cwa', 'CONVECTIVE', 'ts'],
    ['isigmet', 'TURBULENCE', 'turb'],
    ['isigmet', 'ICING', 'ice'],
    ['isigmet', 'MTW', 'mtw'],
    ['isigmet', 'DS', 'ds'],
    ['isigmet', 'SS', 'ss'],
    ['isigmet', 'TC', 'tc'],
    ['isigmet', 'VA', 'va'],
    ['cwa', 'IFR', 'ifr'],
    ['cwa', 'PCPN', 'pcpn'],
    ['cwa', 'UNK', 'unk'],
  ] as const)('maps %s/%s to upstream %s', async (source, hazard, token) => {
    await runToolContract(aviationGetAdvisories, { advisory_type: source, hazard });
    expect(http).toHaveBeenCalledTimes(1);
    expect(String(http.mock.calls[0]![0])).toContain(`hazard=${token}`);
  });
  it.each([
    { advisory_type: 'sigmet', hazard: 'TC' },
    { advisory_type: 'cwa', hazard: 'VA' },
  ] as const)('rejects incompatible selection %j with recovery', async (input) => {
    const result = await runToolContract(aviationGetAdvisories, input);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'hazard_not_supported', recovery: { hint: expect.any(String) } } },
    });
    expect(textOf(result)).toContain('compatible');
    expect(http).not.toHaveBeenCalled();
  });
  it.each([
    { advisory_type: 'airmet' },
    { hazard: 'LLWS' },
    { bbox: { minLat: 0, maxLat: 1, minLon: 180, maxLon: -180 } },
  ] as const)('keeps legacy rejections and recovery %j', async (input) => {
    const result = await runToolContract(aviationGetAdvisories, input);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Recovery:');
    expect(http).not.toHaveBeenCalled();
  });
  it('discloses exact explicit-limit boundaries and allows retrieval of withheld matches', async () => {
    feeds.airsigmet = [
      { ...domestic, seriesId: 'Z' },
      { ...domestic, seriesId: 'A' },
      { ...domestic, seriesId: 'M' },
    ];
    const limited = await runToolContract(aviationGetAdvisories, {
      advisory_type: 'sigmet',
      limit: 2,
    });
    expect(limited.structuredContent).toMatchObject({
      total: 3,
      returned: 2,
      truncated: true,
      advisories: [{ series_id: 'A' }, { series_id: 'M' }],
    });
    expect(limited.structuredContent).not.toHaveProperty('drawn');
    expect(limited.structuredContent).not.toHaveProperty('matched');
    expect(textOf(limited)).toContain('Omit limit or raise it to at least 3');
    const full = await runToolContract(aviationGetAdvisories, {
      advisory_type: 'sigmet',
      limit: 3,
    });
    expect(full.structuredContent).toMatchObject({ total: 3, returned: 3, truncated: false });
    feeds.airsigmet = [];
    expect(
      (await runToolContract(aviationGetAdvisories, { advisory_type: 'sigmet', limit: 1 }))
        .structuredContent,
    ).toMatchObject({ total: 0, returned: 0, truncated: false });
    expect(aviationGetAdvisories.input.parse({}).limit).toBeUndefined();
    for (const limit of [0, -1, 1.5])
      expect(aviationGetAdvisories.input.safeParse({ limit }).success).toBe(false);
    expect(aviationGetAdvisories.input.safeParse({ offset: 100 })).toMatchObject({
      success: false,
    });
  });
  it('counts bbox stages before limiting, including partial coverage', async () => {
    feeds.isigmet = {};
    feeds.airsigmet = [domestic, { ...domestic, seriesId: 'second' }];
    const result = await runToolContract(aviationGetAdvisories, {
      bbox: { minLat: 29, maxLat: 33, minLon: -101, maxLon: -97 },
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      drawn: 3,
      matched: 2,
      returned: 1,
      unlocated: 0,
      total: 2,
      truncated: true,
      partial: true,
    });
  });
  it('propagates caller cancellation and aborts every live independent leg', async () => {
    const controller = new AbortController();
    let aborted = 0;
    http.mockImplementation(
      async (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => {
              aborted++;
              reject(init.signal!.reason);
            },
            { once: true },
          );
        }),
    );
    const pending = svc.fetchAdvisories(
      { advisoryType: 'all' },
      createMockContext({ signal: controller.signal }),
    );
    await Promise.resolve();
    controller.abort(new DOMException('Caller cancelled', 'AbortError'));
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Caller cancelled',
    });
    expect(aborted).toBe(3);
  });
  it('retries transient source failures without re-fetching healthy independent legs', async () => {
    let attempts = 0;
    http.mockImplementation(async (url: string) => {
      if (url.includes('/isigmet?') && ++attempts < 3)
        return new Response('unavailable', { status: 503, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify(url.includes('/isigmet?') ? [international] : []));
    });
    const result = await runToolContract(aviationGetAdvisories, {});
    expect(result.structuredContent).toMatchObject({
      partial: false,
      advisories: [{ source: 'isigmet' }],
    });
    expect(attempts).toBe(3);
    expect(http.mock.calls.filter(([url]) => String(url).includes('/airsigmet?'))).toHaveLength(1);
    expect(http.mock.calls.filter(([url]) => String(url).includes('/cwa?'))).toHaveLength(1);
  });
  it('bounds hanging body reads and retries by one 45-second request deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError')), ms);
      return deadline.signal;
    });
    const start = Date.now();
    const attemptTimes: number[] = [];
    http.mockImplementation(async (url: string, init: RequestInit) => {
      if (!url.includes('/isigmet?')) return new Response('[]');
      attemptTimes.push(Date.now() - start);
      return new Response(
        new ReadableStream({
          start(stream) {
            init.signal!.addEventListener('abort', () => stream.error(init.signal!.reason), {
              once: true,
            });
          },
        }),
      );
    });
    const pending = runToolContract(aviationGetAdvisories, {});
    await vi.advanceTimersByTimeAsync(45_000);
    const result = await pending;
    expect(Date.now() - start).toBe(45_000);
    expect(result.structuredContent).toMatchObject({
      partial: true,
      coverage: [
        expect.objectContaining({ status: 'ok' }),
        expect.objectContaining({ source: 'isigmet', status: 'failed', drawn: null }),
        expect.objectContaining({ status: 'ok' }),
      ],
    });
    expect(attemptTimes.length).toBeGreaterThan(1);
    expect(attemptTimes.every((at) => at < 45_000)).toBe(true);
    expect(http.mock.calls.filter(([url]) => String(url).includes('/airsigmet?'))).toHaveLength(1);
  });
});
