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
          movement: { direction_deg: null, direction_text: 'WNW', speed_kt: 10 },
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
  it('maps source-supported hazards and does not fetch incompatible sources', async () => {
    feeds.isigmet = [];
    feeds.cwa = [];
    const result = await runToolContract(aviationGetAdvisories, { hazard: 'TS' });
    expect(result.structuredContent).toMatchObject({
      coverage: [
        { source: 'sigmet', status: 'not_applicable', drawn: null },
        { source: 'isigmet', status: 'ok', drawn: 0 },
        { source: 'cwa', status: 'ok', drawn: 0 },
      ],
    });
    expect(http).toHaveBeenCalledTimes(2);
    for (const [url] of http.mock.calls) expect(String(url)).toContain('hazard=ts');
    expect(textOf(result)).toContain('says nothing about other hazards');
  });
  it.each([
    ['sigmet', 'CONVECTIVE', 'conv'],
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
