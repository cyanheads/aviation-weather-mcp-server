/** @fileoverview Station identifier expansion regressions. @module tests/tools/station-expansion */
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, it, vi } from 'vitest';
import { aviationFindStations } from '@/mcp-server/tools/definitions/aviation-find-stations.tool.js';

const { fetchStations } = vi.hoisted(() => ({ fetchStations: vi.fn() }));
vi.mock('@/services/aviation-weather/aviation-weather-service.js', () => ({
  getAviationWeatherService: () => ({ fetchStations }),
}));
const station = {
  id: 'KSEA',
  icao_id: 'KSEA',
  iata_id: 'SEA',
  faa_id: 'SEA',
  name: 'Seattle',
  lat: 47,
  lon: -122,
  elevation_ft: 0,
  state: 'WA',
  country: 'US',
  data_types: [],
};
it('characterizes first-spelling reconciliation with duplicate identifiers', async () => {
  fetchStations.mockResolvedValue([station]);
  const ctx = createMockContext({ errors: aviationFindStations.errors });
  await aviationFindStations.handler(
    aviationFindStations.input.parse({ station_ids: ['ksea', 'KSEA'] }),
    ctx,
  );
  expect(getEnrichment(ctx)).toMatchObject({
    requested: ['ksea', 'KSEA'],
    returned: ['ksea'],
    partial: false,
  });
  expect(fetchStations).toHaveBeenLastCalledWith(
    expect.objectContaining({ stationIds: ['ksea', 'KSEA'] }),
    ctx,
  );
});
it('expands and trims comma tokens before querying and reconciliation', async () => {
  fetchStations.mockResolvedValue([station]);
  const ctx = createMockContext({ errors: aviationFindStations.errors });
  await aviationFindStations.handler(
    aviationFindStations.input.parse({ station_ids: [' ksea, KSEA '] }),
    ctx,
  );
  expect(getEnrichment(ctx)).toMatchObject({
    requested: ['ksea', 'KSEA'],
    returned: ['ksea'],
    partial: false,
  });
  expect(fetchStations).toHaveBeenLastCalledWith(
    expect.objectContaining({ stationIds: ['ksea', 'KSEA'] }),
    ctx,
  );
});
it.each(['KSEA,,KJFK', ',KSEA', 'KSEA,', 'KSEA,  '])(
  'rejects empty tokens in %s before I/O',
  async (id) => {
    fetchStations.mockClear();
    const ctx = createMockContext({ errors: aviationFindStations.errors });
    await expect(
      aviationFindStations.handler(aviationFindStations.input.parse({ station_ids: [id] }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'invalid_station_ids' } });
    expect(fetchStations).not.toHaveBeenCalled();
  },
);
it('rejects more than twenty expanded identifiers', async () => {
  const ctx = createMockContext({ errors: aviationFindStations.errors });
  await expect(
    aviationFindStations.handler(
      aviationFindStations.input.parse({ station_ids: [Array(21).fill('KSEA').join(',')] }),
      ctx,
    ),
  ).rejects.toMatchObject({ data: { reason: 'invalid_station_ids' } });
});
it('accepts exactly twenty expanded tokens without silently dropping duplicates', async () => {
  fetchStations.mockResolvedValue([station]);
  const result = await runToolContract(aviationFindStations, {
    station_ids: [Array(20).fill('ksea').join(',')],
  });
  expect(result.structuredContent).toMatchObject({
    requested: Array(20).fill('ksea'),
    returned: ['ksea'],
    partial: false,
  });
});
it('renders invalid-token recovery on both response surfaces', async () => {
  const result = await runToolContract(aviationFindStations, { station_ids: ['KSEA,'] });
  expect(result.structuredContent).toMatchObject({
    error: {
      data: { reason: 'invalid_station_ids', recovery: { hint: expect.stringContaining('1–20') } },
    },
  });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  expect(text).toContain('station_ids');
  expect(text).toContain('1–20');
  expect(text).toContain('empty tokens');
});
