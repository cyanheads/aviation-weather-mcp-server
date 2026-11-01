/** @fileoverview Station snapshot and airport enrichment boundary tests. @module tests/services/aviation-weather/station-additions */
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { aviationFindStations } from '@/mcp-server/tools/definitions/aviation-find-stations.tool.js';
import {
  AviationWeatherService,
  initAviationWeatherService,
} from '@/services/aviation-weather/aviation-weather-service.js';

vi.mock('@cyanheads/mcp-ts-core/utils', async (original) => ({
  ...(await original<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';

const raw = {
  id: 'KSEA',
  icaoId: 'KSEA',
  iataId: 'SEA',
  faaId: 'SEA',
  site: 'Seattle',
  lat: 47.44467,
  lon: -122.31442,
  elev: 132,
  state: 'WA',
  country: 'US',
  siteType: ['METAR'],
};
const service = () => new AviationWeatherService({} as AppConfig, {} as StorageService);
afterEach(() => {
  vi.mocked(fetchWithTimeout).mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('characterizes base station coordinates and elevation independently of airport records', async () => {
  vi.mocked(fetchWithTimeout).mockImplementation(
    async (url) => new Response(JSON.stringify(String(url).includes('/airport?') ? [] : [raw])),
  );
  expect(
    await service().fetchStations({ stationIds: ['KSEA'] }, createMockContext()),
  ).toMatchObject([{ lat: 47.44467, lon: -122.31442, elevation_ft: 433 }]);
});
it('joins published signed variation without replacing station coordinates', async () => {
  vi.mocked(fetchWithTimeout).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes('/airport?') ? [{ icaoId: 'KSEA', magdec: '16E', lat: 0 }] : [raw],
        ),
      ),
  );
  expect(
    await service().fetchStations({ stationIds: ['KSEA'] }, createMockContext()),
  ).toMatchObject([{ lat: 47.44467, magnetic_declination: { degrees: 16, source: '16E' } }]);
});
it('joins captured airport records in one resolved-ICAO batch and preserves nonairport stations', async () => {
  const airports = await readFile(new URL('../../fixtures/airports.json', import.meta.url), 'utf8');
  const records = ['KSEA', 'KJFK', 'EGLL'].map((id) => ({ ...raw, id, icaoId: id }));
  records.push({ ...raw, id: 'WASD2', icaoId: '' });
  vi.mocked(fetchWithTimeout).mockImplementation(
    async (url) =>
      new Response(String(url).includes('/airport?') ? airports : JSON.stringify(records)),
  );
  const stations = await service().fetchStations(
    { stationIds: ['KSEA', 'KJFK', 'EGLL', 'WASD2'] },
    createMockContext(),
  );
  expect(stations.map((row) => row.magnetic_declination)).toEqual([
    { source: '16E', degrees: 16 },
    { source: '13W', degrees: -13 },
    { source: '0', degrees: 0 },
    null,
  ]);
  expect(stations.every((row) => row.lat === 47.44467)).toBe(true);
  expect(vi.mocked(fetchWithTimeout).mock.calls).toHaveLength(2);
  expect(String(vi.mocked(fetchWithTimeout).mock.calls[1]?.[0])).toContain(
    'ids=KSEA%2CKJFK%2CEGLL',
  );
});
it('bounds stationinfo retries by the total base deadline before enrichment', async () => {
  vi.useFakeTimers();
  vi.mocked(fetchWithTimeout).mockImplementation(
    async (_url, _ms, _ctx, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        }),
      ),
  );
  const settled = service()
    .fetchStations({ stationIds: ['KSEA'] }, createMockContext())
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(45_000);
  expect(await settled).toMatchObject({ code: JsonRpcErrorCode.Timeout });
  expect(fetchWithTimeout).toHaveBeenCalledOnce();
});
it('matches all US registry members of every supported state, including invalid source coordinates', async () => {
  const bytes = await readFile(new URL('../../fixtures/stations.cache.json.gz', import.meta.url));
  const { gunzipSync } = await import('node:zlib');
  const rows: (typeof raw)[] = JSON.parse(gunzipSync(bytes).toString());
  vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response(bytes));
  const svc = service();
  const states =
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(
      ' ',
    );
  for (const state of states) {
    const found = await svc.fetchStations({ state }, createMockContext());
    expect(found.map((row) => row.id).sort()).toEqual(
      rows
        .filter((row) => row.country === 'US' && row.state === state)
        .map((row) => row.id)
        .sort(),
    );
    if (state === 'AK') expect(found.find((row) => row.id === 'ICYA2')?.lat).toBe(-99.99);
  }
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
});
it('keeps cached station data types isolated from returned records', async () => {
  vi.mocked(fetchWithTimeout).mockImplementation(
    async () => new Response(gzipSync(JSON.stringify([raw]))),
  );
  const svc = service();
  const first = await svc.fetchStations({ state: 'WA' }, createMockContext());
  expect(first).toHaveLength(1);
  first[0]?.data_types.push('POISON');
  const next = await svc.fetchStations({ state: 'WA' }, createMockContext());
  expect(next).toMatchObject([{ data_types: ['METAR'] }]);
  expect(fetchWithTimeout).toHaveBeenCalledOnce();
});
it('refreshes after 24h and refuses malformed replacement instead of serving expired data', async () => {
  vi.useFakeTimers();
  vi.mocked(fetchWithTimeout)
    .mockResolvedValueOnce(new Response(gzipSync(JSON.stringify([raw]))))
    .mockResolvedValueOnce(new Response(gzipSync('[{}]')))
    .mockResolvedValueOnce(new Response(gzipSync(JSON.stringify([{ ...raw, id: 'KBFI' }]))));
  const svc = service();
  expect(await svc.fetchStations({ state: 'wa' }, createMockContext())).toHaveLength(1);
  vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
  await expect(svc.fetchStations({ state: 'WA' }, createMockContext())).rejects.toThrow(
    /validation/,
  );
  expect(await svc.fetchStations({ state: 'WA' }, createMockContext())).toMatchObject([
    { id: 'KBFI' },
  ]);
});
it.each([
  ['16E', 16],
  ['13W', -13],
  ['03W', -3],
  ['0', 0],
  ['mystery', null],
  ['', null],
] as const)('preserves variation %s on both surfaces', async (source, degrees) => {
  vi.mocked(fetchWithTimeout).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes('/airport?') ? [{ icaoId: 'KSEA', magdec: source }] : [raw],
        ),
      ),
  );
  initAviationWeatherService({} as AppConfig, {} as StorageService);
  const result = await runToolContract(aviationFindStations, { station_ids: [' ksea, KSEA '] });
  expect(result.structuredContent).toMatchObject({
    stations: [{ magnetic_declination: { source, degrees } }],
    requested: ['ksea', 'KSEA'],
    returned: ['ksea'],
    partial: false,
  });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  expect(text).toContain(`source: ${source}`);
  expect(text).toContain(degrees == null ? 'unknown degrees' : `${degrees}°`);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
});
it('makes no airport request for state or bbox modes or nonairport identifiers', async () => {
  vi.mocked(fetchWithTimeout).mockImplementation(async (url) =>
    String(url).includes('/data/cache/')
      ? new Response(gzipSync(JSON.stringify([raw])))
      : new Response(JSON.stringify([{ ...raw, id: 'WASD2', icaoId: null }])),
  );
  const svc = service();
  await svc.fetchStations({ state: 'WA' }, createMockContext());
  await svc.fetchStations(
    { bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 } },
    createMockContext(),
  );
  await svc.fetchStations({ stationIds: ['WASD2'] }, createMockContext());
  expect(
    vi.mocked(fetchWithTimeout).mock.calls.every(([url]) => !String(url).includes('/airport?')),
  ).toBe(true);
});
it.each([204, 200])(
  'keeps missing airport data unknown without a failure notice (HTTP %i)',
  async (status) => {
    vi.mocked(fetchWithTimeout).mockImplementation(async (url) =>
      String(url).includes('/airport?')
        ? new Response(status === 204 ? null : '[]', { status })
        : new Response(JSON.stringify([raw])),
    );
    const onMagneticDeclinationUnavailable = vi.fn();
    const stations = await service().fetchStations(
      { stationIds: ['KSEA'], onMagneticDeclinationUnavailable },
      createMockContext(),
    );
    expect(stations).toMatchObject([{ magnetic_declination: null }]);
    expect(onMagneticDeclinationUnavailable).not.toHaveBeenCalled();
  },
);
it('discloses failed supplementary lookup on both surfaces alongside missing identifiers', async () => {
  vi.mocked(fetchWithTimeout).mockImplementation(async (url) => {
    if (String(url).includes('/airport?')) throw serviceUnavailable('offline');
    return new Response(JSON.stringify([raw]));
  });
  initAviationWeatherService({} as AppConfig, {} as StorageService);
  const result = await runToolContract(aviationFindStations, { station_ids: ['KSEA', 'ZZZZ'] });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    stations: [{ magnetic_declination: null }],
    missing: ['ZZZZ'],
    partial: true,
    notice: expect.stringContaining('supplementary'),
  });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  expect(text).toContain('supplementary');
  expect(text).toContain('ZZZZ');
});
it.each(['rate-limit', 'node-body', 'bun-body'] as const)(
  'preserves station results and both-surface guidance after %s transport failure',
  async (failure) => {
    const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
      '@cyanheads/mcp-ts-core/utils',
    );
    vi.mocked(fetchWithTimeout).mockImplementation(actual.fetchWithTimeout);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/data/stationinfo') return new Response(JSON.stringify([raw]));
      if (url.pathname !== '/api/data/airport') throw new Error('Unexpected upstream request');
      if (failure === 'rate-limit') return new Response('rate limited', { status: 429 });
      const error =
        failure === 'node-body'
          ? new TypeError('terminated', {
              cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }),
            })
          : Object.assign(new TypeError('socket closed'), { code: 'ECONNRESET' });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(error);
          },
        }),
      );
    });
    initAviationWeatherService({} as AppConfig, {} as StorageService);
    const result = await runToolContract(aviationFindStations, { station_ids: ['KSEA'] });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      stations: [{ name: 'Seattle', magnetic_declination: null }],
      notice: expect.stringContaining('supplementary'),
    });
    expect(
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    ).toContain('supplementary');
  },
);
it('propagates programmer errors from airport enrichment', async () => {
  const bug = new TypeError('programmer error');
  vi.mocked(fetchWithTimeout).mockImplementation(async (url) => {
    if (String(url).includes('/airport?')) throw bug;
    return new Response(JSON.stringify([raw]));
  });
  await expect(service().fetchStations({ stationIds: ['KSEA'] }, createMockContext())).rejects.toBe(
    bug,
  );
});
it('bounds a hanging supplementary request to a three-second signal', async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const started = Promise.withResolvers<void>();
  vi.mocked(fetchWithTimeout).mockImplementation(async (url, _ms, _ctx, options) => {
    if (!String(url).includes('/airport?')) return new Response(JSON.stringify([raw]));
    started.resolve();
    return new Promise((_resolve, reject) =>
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
        once: true,
      }),
    );
  });
  const unavailable = vi.fn();
  const pending = service().fetchStations(
    { stationIds: ['KSEA'], onMagneticDeclinationUnavailable: unavailable },
    createMockContext(),
  );
  await started.promise;
  expect(AbortSignal.timeout).toHaveBeenCalledWith(3000);
  deadline.abort(new DOMException('deadline', 'TimeoutError'));
  expect(await pending).toMatchObject([{ id: 'KSEA', magnetic_declination: null }]);
  expect(unavailable).toHaveBeenCalledOnce();
});
it('propagates caller cancellation during supplementary fetch through both surfaces', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  vi.mocked(fetchWithTimeout).mockImplementation(async (url, _ms, _ctx, options) => {
    if (!String(url).includes('/airport?')) return new Response(JSON.stringify([raw]));
    started.resolve();
    return new Promise((_resolve, reject) =>
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
        once: true,
      }),
    );
  });
  initAviationWeatherService({} as AppConfig, {} as StorageService);
  const pending = runToolContract(
    aviationFindStations,
    { station_ids: ['KSEA'] },
    { context: { signal: controller.signal } },
  );
  await started.promise;
  controller.abort();
  const result = await pending;
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RequestCancelled },
  });
  expect(
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
  ).toMatch(/cancel|abort/i);
});
it('shares a refresh while cancellation of one waiter leaves the other alive', async () => {
  const response = Promise.withResolvers<Response>();
  let refreshSignal: AbortSignal | undefined;
  vi.mocked(fetchWithTimeout).mockImplementation(async (_url, _ms, _ctx, options) => {
    refreshSignal = options?.signal;
    return response.promise;
  });
  const svc = service();
  const controller = new AbortController();
  const first = svc.fetchStations(
    { state: 'WA' },
    createMockContext({ signal: controller.signal }),
  );
  const second = svc.fetchStations({ state: 'WA' }, createMockContext());
  controller.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(refreshSignal?.aborted).toBe(false);
  response.resolve(new Response(gzipSync(JSON.stringify([raw]))));
  expect(await second).toHaveLength(1);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
});
it('cancels an abandoned refresh and prevents its late completion replacing the next refresh', async () => {
  const old = Promise.withResolvers<Response>();
  vi.mocked(fetchWithTimeout)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(new Response(gzipSync(JSON.stringify([{ ...raw, id: 'KBFI' }]))));
  const svc = service();
  const controller = new AbortController();
  const first = svc.fetchStations(
    { state: 'WA' },
    createMockContext({ signal: controller.signal }),
  );
  controller.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(vi.mocked(fetchWithTimeout).mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
  expect(await svc.fetchStations({ state: 'WA' }, createMockContext())).toMatchObject([
    { id: 'KBFI' },
  ]);
  old.resolve(new Response(gzipSync(JSON.stringify([raw]))));
  expect(await svc.fetchStations({ state: 'WA' }, createMockContext())).toMatchObject([
    { id: 'KBFI' },
  ]);
});
it('reports a rejected snapshot as unavailable on both surfaces, never invalid_state or station_not_found', async () => {
  vi.mocked(fetchWithTimeout).mockRejectedValue(
    new McpError(JsonRpcErrorCode.InvalidParams, 'upstream refused'),
  );
  initAviationWeatherService({} as AppConfig, {} as StorageService);
  const result = await runToolContract(aviationFindStations, { state: 'WA' });
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.ServiceUnavailable },
  });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  expect(text).toContain('bbox or station_ids');
});
it('bounds a hanging snapshot fetch and shares the failed refresh among waiters', async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  vi.mocked(fetchWithTimeout).mockImplementation(
    async (_url, _ms, _ctx, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        }),
      ),
  );
  const svc = service();
  const first = svc.fetchStations({ state: 'WA' }, createMockContext());
  const second = svc.fetchStations({ state: 'AK' }, createMockContext());
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000);
  deadline.abort(new DOMException('deadline', 'TimeoutError'));
  for (const pending of [first, second])
    await expect(pending).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
});
it.each(['node', 'bun'] as const)(
  'classifies a %s snapshot body interruption as unavailable',
  async (runtime) => {
    const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
      '@cyanheads/mcp-ts-core/utils',
    );
    vi.mocked(fetchWithTimeout).mockImplementation(actual.fetchWithTimeout);
    const error =
      runtime === 'node'
        ? new TypeError('terminated', {
            cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }),
          })
        : Object.assign(new TypeError('socket closed'), { code: 'ECONNRESET' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error);
            },
          }),
        ),
    );
    initAviationWeatherService({} as AppConfig, {} as StorageService);
    const result = await runToolContract(aviationFindStations, { state: 'WA' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable },
    });
  },
);
it('does not accept a corrupt gzip or duplicate registry identities as a snapshot', async () => {
  vi.mocked(fetchWithTimeout)
    .mockResolvedValueOnce(new Response('invalid gzip'))
    .mockResolvedValueOnce(new Response(gzipSync(JSON.stringify([raw, raw]))));
  const svc = service();
  await expect(svc.fetchStations({ state: 'WA' }, createMockContext())).rejects.toMatchObject({
    code: JsonRpcErrorCode.ServiceUnavailable,
  });
  await expect(svc.fetchStations({ state: 'WA' }, createMockContext())).rejects.toMatchObject({
    code: JsonRpcErrorCode.ServiceUnavailable,
  });
});
