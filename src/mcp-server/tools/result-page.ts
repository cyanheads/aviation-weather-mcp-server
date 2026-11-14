/**
 * @fileoverview Result limits and continuation for selected AWC draws.
 * @module mcp-server/tools/result-page
 */

import { type ContextLogger, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { AWC_MAX_ROWS } from '@/services/aviation-weather/awc-limits.js';

const clampedLimits = createCounter(
  'aviation_weather.result_limit.clamped',
  'Oversized result limits clamped to the served maximum',
);

/** Advertises and enforces the configured policy without reading env at import time. */
export function cappedLimitSchema() {
  // Zod's integer format adds an implicit safe-integer maximum to the wire schema.
  // A count above the serving cap can be clamped without exact integer arithmetic.
  return z
    .number()
    .min(1)
    .check((ctx) => {
      if (!Number.isInteger(ctx.value)) {
        ctx.issues.push({ code: 'invalid_type', expected: 'int', input: ctx.value });
      } else if (ctx.value > AWC_MAX_ROWS && !getServerConfig().awcClampLimits) {
        ctx.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: AWC_MAX_ROWS,
          inclusive: true,
          input: ctx.value,
        });
      }
    })
    .optional()
    .meta({
      type: 'integer',
      get maximum() {
        return getServerConfig().awcClampLimits ? undefined : AWC_MAX_ROWS;
      },
    });
}

/** Resolve the served count and record any successful clamp. */
export function clampResultLimit(
  limit: number | undefined,
  toolName: string,
  log: Pick<ContextLogger, 'notice'>,
): { limit: number | undefined; notice?: string } {
  if (limit === undefined || limit <= AWC_MAX_ROWS) return { limit };
  const notice = `Requested limit ${limit} was clamped to ${AWC_MAX_ROWS}.`;
  log.notice(notice, { tool: toolName, requestedLimit: limit, servedLimit: AWC_MAX_ROWS });
  clampedLimits.add(1, { tool: toolName });
  return { limit: AWC_MAX_ROWS, notice };
}

/** Slice an already ordered, selected draw. */
export function pageResults<T>(
  rows: T[],
  offset?: number,
  limit?: number,
): { rows: T[]; nextOffset?: number } {
  if (offset === undefined && limit === undefined) return { rows };
  const start = offset ?? 0;
  const page = rows.slice(start, limit === undefined ? undefined : start + limit);
  const end = start + page.length;
  return end < rows.length ? { rows: page, nextOffset: end } : { rows: page };
}

/** Explain how to request the next page and what the new draw can cover. */
export function continuationNotice(nextOffset: number): string {
  return `Repeat the same search with offset: ${nextOffset} to continue. Each call reads the currently available draw, which may have changed. Paging cannot recover rows withheld by AWC.`;
}
