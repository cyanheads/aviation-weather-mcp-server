/**
 * @fileoverview Tool to resolve airport/weather stations by ICAO ID, bounding box, or US state.
 * @module mcp-server/tools/definitions/aviation-find-stations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

/** Bounding box schema shared across tools. */
const BboxSchema = z
  .object({
    minLat: z.number().min(-90).max(90).describe('Southern boundary latitude in decimal degrees.'),
    minLon: z
      .number()
      .min(-180)
      .max(180)
      .describe('Western boundary longitude in decimal degrees.'),
    maxLat: z.number().min(-90).max(90).describe('Northern boundary latitude in decimal degrees.'),
    maxLon: z
      .number()
      .min(-180)
      .max(180)
      .describe('Eastern boundary longitude in decimal degrees.'),
  })
  .describe('Geographic bounding box for spatial queries.');

export const aviationFindStations = tool('aviation_find_stations', {
  title: 'Find Aviation Weather Stations',
  description:
    'Resolve an airport or weather reporting station by ICAO identifier, or discover stations within a bounding box or US state. Returns all identifier variants (ICAO/IATA/FAA), coordinates, elevation, and available data types (METAR, TAF, SYNOP, etc.). Station IDs must be 4-letter ICAO format (e.g., KSEA, KJFK). At least one of station_ids, bbox, or state is required.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    station_ids: z
      .array(z.string().describe('A 4-letter ICAO station identifier (e.g., KSEA).'))
      .min(1)
      .max(20)
      .optional()
      .describe(
        'One or more 4-letter ICAO station IDs (e.g., KSEA, KJFK). The upstream API only accepts ICAO format — 3-letter IATA codes (e.g., SEA) will return no results. Use bbox or state to discover ICAO IDs by location.',
      ),
    bbox: BboxSchema.optional(),
    state: z
      .string()
      .length(2)
      .optional()
      .describe(
        'Two-letter US state abbreviation (e.g., "WA") to list all stations in that state.',
      ),
  }),
  output: z.object({
    stations: z
      .array(
        z
          .object({
            icao_id: z
              .string()
              .nullable()
              .describe('ICAO 4-letter station ID, or null if not assigned.'),
            iata_id: z.string().nullable().describe('IATA 3-letter code, or null if not assigned.'),
            faa_id: z.string().nullable().describe('FAA identifier, or null if not assigned.'),
            name: z.string().describe('Human-readable site name.'),
            lat: z.number().describe('Latitude in decimal degrees.'),
            lon: z.number().describe('Longitude in decimal degrees.'),
            elevation_ft: z.number().describe('Station elevation in feet MSL.'),
            state: z
              .string()
              .describe('US state abbreviation, or empty string for non-US stations.'),
            country: z.string().describe('Country code or name.'),
            data_types: z
              .array(z.string().describe('An available data type (e.g., "METAR", "TAF", "SYNOP").'))
              .describe('List of data products available at this station.'),
          })
          .describe('An aviation weather reporting station.'),
      )
      .describe('Matching stations.'),
  }),
  errors: [
    {
      reason: 'station_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'None of the requested IDs match any known station.',
      recovery:
        'Station IDs must be 4-letter ICAO format (e.g., KSEA, not SEA). Use bbox or state to discover ICAO IDs by location.',
    },
    {
      reason: 'missing_search_criteria',
      code: JsonRpcErrorCode.ValidationError,
      when: 'None of station_ids, bbox, or state was provided.',
      recovery:
        'Provide at least one of: station_ids (array of IDs), bbox (lat/lon bounds), or state (2-letter US state abbreviation).',
    },
  ],

  async handler(input, ctx) {
    if (!input.station_ids?.length && !input.bbox && !input.state) {
      throw ctx.fail(
        'missing_search_criteria',
        'At least one of station_ids, bbox, or state is required.',
        {
          ...ctx.recoveryFor('missing_search_criteria'),
        },
      );
    }

    ctx.log.info('Finding aviation stations', {
      stationIds: input.station_ids,
      hasBbox: !!input.bbox,
      state: input.state,
    });

    const svc = getAviationWeatherService();
    const stations = await svc.fetchStations(
      {
        ...(input.station_ids?.length ? { stationIds: input.station_ids } : {}),
        ...(input.bbox ? { bbox: input.bbox } : {}),
        ...(input.state ? { state: input.state } : {}),
      },
      ctx,
    );

    if (stations.length === 0) {
      throw ctx.fail('station_not_found', 'No stations found matching the search criteria.', {
        ...ctx.recoveryFor('station_not_found'),
      });
    }

    ctx.log.info('Stations found', { count: stations.length });
    return { stations };
  },

  format: (result) => {
    const lines: string[] = [`**${result.stations.length} station(s) found**\n`];
    for (const s of result.stations) {
      lines.push(`## ${s.name}`);
      const ids = [
        s.icao_id ? `ICAO: ${s.icao_id}` : null,
        s.iata_id ? `IATA: ${s.iata_id}` : null,
        s.faa_id ? `FAA: ${s.faa_id}` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      lines.push(`**IDs:** ${ids}`);
      lines.push(
        `**Location:** ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)} | **Elevation:** ${s.elevation_ft} ft`,
      );
      if (s.state || s.country) {
        lines.push(`**Region:** ${[s.state, s.country].filter(Boolean).join(', ')}`);
      }
      if (s.data_types.length > 0) {
        lines.push(`**Data types:** ${s.data_types.join(', ')}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
