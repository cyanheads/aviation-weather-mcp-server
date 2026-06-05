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
  tools: [
    aviationFindStations,
    aviationGetMetar,
    aviationGetTaf,
    aviationGetPireps,
    aviationGetAdvisories,
  ],
  resources: [],
  prompts: [aviationPreflightBrief],
  instructions:
    'Aviation weather from the NWS Aviation Weather Center (aviationweather.gov). ' +
    'Keyless, no API key required. Covers METARs, TAFs, PIREPs, and SIGMETs/AIRMETs.\n' +
    'IMPORTANT: This data is for informational purposes only. ' +
    'Flight operations in IMC or controlled airspace require an official preflight briefing from an authorized source (e.g., 1800wxbrief.com).\n' +
    'Station IDs are ICAO format (4 letters, e.g. KSEA, KJFK). ' +
    'Use aviation_find_stations to resolve unknown IDs or discover stations in a region.',
  setup(core) {
    initAviationWeatherService(core.config, core.storage);
  },
});
