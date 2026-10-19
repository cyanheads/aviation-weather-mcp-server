#!/usr/bin/env node
/**
 * @fileoverview aviation-weather-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { aviationPreflightBrief } from './mcp-server/prompts/definitions/aviation-preflight-brief.prompt.js';
import { aviationFindStations } from './mcp-server/tools/definitions/aviation-find-stations.tool.js';
import { aviationGetAdvisories } from './mcp-server/tools/definitions/aviation-get-advisories.tool.js';
import { aviationGetMetar } from './mcp-server/tools/definitions/aviation-get-metar.tool.js';
import { aviationGetPireps } from './mcp-server/tools/definitions/aviation-get-pireps.tool.js';
import { aviationGetTaf } from './mcp-server/tools/definitions/aviation-get-taf.tool.js';
import { initAviationWeatherService } from './services/aviation-weather/aviation-weather-service.js';

await createApp({
  name: 'aviation-weather-mcp-server',
  title: 'aviation-weather-mcp-server',
  tools: [
    aviationFindStations,
    aviationGetMetar,
    aviationGetTaf,
    aviationGetPireps,
    aviationGetAdvisories,
  ],
  resources: [],
  prompts: [aviationPreflightBrief],
  instructions: `Aviation weather from the NWS Aviation Weather Center (aviationweather.gov). Keyless, no API key required. Covers METARs, TAFs, PIREPs, domestic/international SIGMETs and Center Weather Advisories. aviation_get_advisories defaults to all three independent products; inspect coverage and partial before interpreting an empty result. AIRMETs are not served — requests for them are rejected. Optional limit has no default; omit it to retrieve every available match.
IMPORTANT: This data is for informational purposes only. Flight operations in IMC or controlled airspace require an official preflight briefing from an authorized source (e.g., 1800wxbrief.com).
Weather tool and preflight station IDs are 4 ASCII letters or digits, case-insensitive and normalized to uppercase (e.g. KSEA, KJFK, K0S9). For an IATA/FAA code, use aviation_find_stations with state or bbox to find the ICAO ID; do not infer a mapping. Station finder also accepts other registry ID shapes.`,
  /**
   * Tools answer from per-request reads (advisories fan out to three independent products) and none gates on
   * `ctx.requestInput`, so nothing here needs a session to carry state between
   * calls. Declared in code rather than only in the environment;
   * `MCP_SESSION_MODE` still wins when it is set.
   */
  sessionMode: 'stateless',
  setup(core) {
    initAviationWeatherService(core.config, core.storage);
  },
});
