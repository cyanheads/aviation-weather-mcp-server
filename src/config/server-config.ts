/**
 * @fileoverview Server-specific configuration for aviation-weather-mcp-server.
 * Reads AWC_BASE_URL and AWC_TIMEOUT_MS from the environment.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  awcBaseUrl: z
    .string()
    .url()
    .default('https://aviationweather.gov/api/data')
    .describe('Base URL for the AWC Data API'),
  awcTimeoutMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(10000)
    .describe('Request timeout in milliseconds'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Returns validated server config, parsing from env on first call. */
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    awcBaseUrl: 'AWC_BASE_URL',
    awcTimeoutMs: 'AWC_TIMEOUT_MS',
  });
  return _config;
}
