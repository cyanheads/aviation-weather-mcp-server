/**
 * @fileoverview On-demand complete AWC station registry snapshot, shared by state searches.
 * @module services/aviation-weather/station-snapshot
 */
import { gunzip } from 'node:zlib';
import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import type { RawStationInfo } from './types.js';

const StationSchema = z.object({
  id: z.string().min(1),
  site: z.string(),
  lat: z.number(),
  lon: z.number(),
  elev: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  icaoId: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  iataId: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  faaId: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  state: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  country: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  siteType: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
});
const SnapshotSchema = z.array(StationSchema.extend({ site: z.string().nullable() })).min(1);
const FRESH_MS = 24 * 60 * 60 * 1000;

interface Refresh {
  controller: AbortController;
  promise: Promise<RawStationInfo[]>;
  waiters: number;
}

/** One bounded snapshot and at most one active refresh; expired data is never served. */
export class StationSnapshot {
  private snapshot?: { rows: RawStationInfo[]; expiresAt: number };
  private refresh: Refresh | undefined;

  async get(url: string, timeoutMs: number, ctx: Context): Promise<RawStationInfo[]> {
    ctx.signal.throwIfAborted();
    if (this.snapshot && Date.now() < this.snapshot.expiresAt) return this.snapshot.rows;
    if (!this.refresh || this.refresh.controller.signal.aborted) {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
      const refresh: Refresh = { controller, waiters: 0, promise: Promise.resolve([]) };
      refresh.promise = this.load(url, Math.min(timeoutMs, 15_000), { ...ctx, signal })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) throw cause;
          if (
            (signal.aborted &&
              (cause === signal.reason ||
                (cause instanceof Error && ['AbortError', 'TimeoutError'].includes(cause.name)))) ||
            (cause instanceof McpError &&
              [
                JsonRpcErrorCode.InvalidParams,
                JsonRpcErrorCode.Timeout,
                JsonRpcErrorCode.NotFound,
                JsonRpcErrorCode.Unauthorized,
                JsonRpcErrorCode.Forbidden,
              ].includes(cause.code))
          )
            throw serviceUnavailable(
              'The complete AWC station registry is unavailable; retry the state search or use bbox or station_ids.',
              undefined,
              { cause },
            );
          throw cause;
        })
        .then((rows) => {
          signal.throwIfAborted();
          this.snapshot = { rows, expiresAt: Date.now() + FRESH_MS };
          return rows;
        })
        .finally(() => {
          if (this.refresh === refresh) this.refresh = undefined;
        });
      this.refresh = refresh;
    }
    const refresh = this.refresh;
    refresh.waiters++;
    try {
      return await new Promise<RawStationInfo[]>((resolve, reject) => {
        const abort = () => reject(ctx.signal.reason);
        ctx.signal.addEventListener('abort', abort, { once: true });
        refresh.promise.then(
          (rows) => {
            ctx.signal.removeEventListener('abort', abort);
            resolve(rows);
          },
          (error) => {
            ctx.signal.removeEventListener('abort', abort);
            reject(error);
          },
        );
        if (ctx.signal.aborted) abort();
      });
    } finally {
      refresh.waiters--;
      if (refresh.waiters === 0 && this.refresh === refresh) refresh.controller.abort();
    }
  }

  private async load(url: string, timeoutMs: number, ctx: Context): Promise<RawStationInfo[]> {
    const response = await fetchWithTimeout(url, timeoutMs, ctx, { signal: ctx.signal });
    if (!response.body)
      throw serviceUnavailable(
        'The complete AWC station registry is unavailable; retry the state search or use bbox or station_ids.',
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        ctx.signal.throwIfAborted();
        const { value, done } = await reader.read();
        ctx.signal.throwIfAborted();
        if (done) break;
        chunks.push(value);
      }
    } catch (cause) {
      ctx.signal.throwIfAborted();
      throw serviceUnavailable(
        'The complete AWC station registry could not be read; retry or use bbox or station_ids.',
        undefined,
        { cause },
      );
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    let decoded: Buffer;
    try {
      decoded = await new Promise<Buffer>((resolve, reject) =>
        gunzip(bytes, (error, result) => (error ? reject(error) : resolve(result))),
      );
    } catch (cause) {
      throw serviceUnavailable(
        'The complete AWC station registry could not be decompressed; retry or use bbox or station_ids.',
        undefined,
        { cause },
      );
    }
    ctx.signal.throwIfAborted();
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded.toString('utf8'));
    } catch (cause) {
      throw serviceUnavailable(
        'The complete AWC station registry was not valid JSON; retry or use bbox or station_ids.',
        undefined,
        { cause },
      );
    }
    const result = SnapshotSchema.safeParse(parsed);
    if (
      !result.success ||
      new Set(result.data.map((row) => row.id.toUpperCase())).size !== result.data.length
    ) {
      throw serviceUnavailable(
        'The complete AWC station registry failed validation; retry or use bbox or station_ids.',
      );
    }
    const usRows = z
      .array(StationSchema)
      .safeParse(result.data.filter((row) => row.country?.toUpperCase() === 'US'));
    if (!usRows.success)
      throw serviceUnavailable(
        'The US station registry failed validation; retry or use bbox or station_ids.',
      );
    return usRows.data;
  }
}
