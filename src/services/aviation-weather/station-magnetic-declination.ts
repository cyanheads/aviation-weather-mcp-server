/**
 * @fileoverview Supplementary source-published airport magnetic variation.
 * @module services/aviation-weather/station-magnetic-declination
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import type { NormalizedStation } from './types.js';

const AirportsSchema = z.array(z.object({ icaoId: z.string(), magdec: z.string().nullish() }));

/** Enrich only resolved airport IDs in one request bounded to three seconds including body reading. */
export async function enrichStationMagneticDeclination(
  stations: NormalizedStation[],
  baseUrl: string,
  timeoutMs: number,
  ctx: Context,
  onUnavailable?: () => void,
): Promise<NormalizedStation[]> {
  const ids = [
    ...new Set(
      stations.flatMap((station) => (station.icao_id ? [station.icao_id.toUpperCase()] : [])),
    ),
  ];
  if (ids.length === 0) return stations;
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(3_000)]);
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/airport?ids=${encodeURIComponent(ids.join(','))}&format=json`,
      Math.min(timeoutMs, 3_000),
      ctx,
      { signal },
    );
    let text: string;
    try {
      text = response.status === 204 ? '[]' : await response.text();
    } catch (cause) {
      // Body transport failures are native errors on both supported runtimes.
      const transportError =
        cause instanceof Error && 'code' in cause
          ? cause
          : cause instanceof Error
            ? cause.cause
            : undefined;
      const transportCode =
        transportError instanceof Error && 'code' in transportError
          ? transportError.code
          : undefined;
      if (
        typeof transportCode !== 'string' ||
        !['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT'].includes(
          transportCode,
        )
      )
        throw cause;
      throw serviceUnavailable('AWC airport variation response could not be read.', undefined, {
        cause,
      });
    }
    signal.throwIfAborted();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw serviceUnavailable('AWC airport variation response was not JSON.', undefined, {
        cause,
      });
    }
    const airports = AirportsSchema.safeParse(parsed);
    if (!airports.success)
      throw serviceUnavailable('AWC airport variation response failed validation.');
    const variations = new Map(
      airports.data.map((airport) => {
        const source = airport.magdec;
        if (source == null) return [airport.icaoId.toUpperCase(), null] as const;
        const match = /^(\d+(?:\.\d+)?)([EW])$/.exec(source);
        const parsedDegrees =
          source === '0' ? 0 : match ? Number(match[1]) * (match[2] === 'W' ? -1 : 1) : null;
        const degrees =
          parsedDegrees !== null && Number.isFinite(parsedDegrees) ? parsedDegrees : null;
        return [airport.icaoId.toUpperCase(), { degrees, source }] as const;
      }),
    );
    return stations.map((station) => ({
      ...station,
      magnetic_declination: station.icao_id
        ? (variations.get(station.icao_id.toUpperCase()) ?? null)
        : null,
    }));
  } catch (error) {
    ctx.signal.throwIfAborted();
    const operational =
      (signal.aborted &&
        (error === signal.reason ||
          (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)))) ||
      (error instanceof McpError &&
        [
          JsonRpcErrorCode.InvalidParams,
          JsonRpcErrorCode.NotFound,
          JsonRpcErrorCode.ServiceUnavailable,
          JsonRpcErrorCode.RateLimited,
          JsonRpcErrorCode.Timeout,
          JsonRpcErrorCode.Unauthorized,
          JsonRpcErrorCode.Forbidden,
        ].includes(error.code));
    if (!operational) throw error;
    onUnavailable?.();
    return stations;
  }
}
