/** @fileoverview Complete state snapshot disclosure regression. @module tests/tools/station-completeness */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, it, vi } from 'vitest';
import { aviationFindStations } from '@/mcp-server/tools/definitions/aviation-find-stations.tool.js';

vi.mock('@/services/aviation-weather/aviation-weather-service.js', () => ({
  getAviationWeatherService: () => ({
    fetchStations: async () =>
      Array.from({ length: 401 }, (_, i) => ({
        id: `S${i}`,
        icao_id: null,
        iata_id: null,
        faa_id: null,
        name: `Station ${i}`,
        lat: 0,
        lon: 0,
        elevation_ft: 0,
        state: 'TX',
        country: 'US',
        data_types: [],
      })),
  }),
}));
it('never treats a complete state snapshot as a capped stationinfo page', async () => {
  const result = await runToolContract(aviationFindStations, { state: 'TX', limit: 1 });
  expect(result.structuredContent).toMatchObject({
    truncated: false,
    matched: 401,
    limited: true,
    shown: 1,
  });
  expect(
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
  ).not.toContain('capped draw');
});
