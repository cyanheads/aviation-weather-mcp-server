/**
 * @fileoverview Historical query syntax and rolling AWC retention.
 */

import { z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

/** UTC seconds with optional milliseconds, including tool-result timestamps. */
export const HistoryAnchorSchema = z
  .string()
  .max(24)
  .pipe(z.union([z.iso.datetime({ precision: 0 }), z.iso.datetime({ precision: 3 })]))
  .describe(
    'Historical UTC reference as YYYY-MM-DDTHH:mm:ssZ or YYYY-MM-DDTHH:mm:ss.sssZ. AWC retains up to the previous 30 days. Omit to use the current time.',
  );

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Validates the rolling time range and returns the encoded AWC query suffix. */
export function historyQuery(asOf: string | undefined): string {
  if (asOf === undefined) return '';

  const requestedMs = Date.parse(asOf);
  const nowMs = Date.now();
  if (requestedMs > nowMs) {
    throw validationError('as_of cannot be in the future.', { reason: 'future_as_of' });
  }
  if (requestedMs < nowMs - RETENTION_MS) {
    throw validationError('AWC retains up to 30 days of historical weather.', {
      reason: 'outside_retention',
    });
  }
  return `&date=${encodeURIComponent(asOf)}`;
}
