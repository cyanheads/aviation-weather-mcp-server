/**
 * @fileoverview Station case acceptance through real services and framework envelopes.
 * @module tests/tools/station-case
 */
import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aviationPreflightBrief } from '@/mcp-server/prompts/definitions/aviation-preflight-brief.prompt.js';
import { aviationGetMetar } from '@/mcp-server/tools/definitions/aviation-get-metar.tool.js';
import { aviationGetPireps } from '@/mcp-server/tools/definitions/aviation-get-pireps.tool.js';
import { aviationGetTaf } from '@/mcp-server/tools/definitions/aviation-get-taf.tool.js';
import { initAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: vi.fn() };
});

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';

beforeEach(() => {
  initAviationWeatherService({} as AppConfig, {} as StorageService);
  vi.mocked(fetchWithTimeout).mockReset();
});
afterEach(() => vi.restoreAllMocks());

const weather = [
  {
    tool: aviationGetMetar,
    input: { station_ids: ['kSeA', 'k0s9'] },
    key: 'ids',
    value: 'KSEA,K0S9',
    reason: 'no_stations_found',
  },
  {
    tool: aviationGetTaf,
    input: { station_ids: ['kSeA', 'k36u'] },
    key: 'ids',
    value: 'KSEA,K36U',
    reason: 'no_taf_available',
  },
  {
    tool: aviationGetPireps,
    input: { station_id: 'k0s9' },
    key: 'id',
    value: 'K0S9',
    reason: 'no_pireps_found',
  },
];

describe('station case at the framework boundary', () => {
  for (const { tool, input, key, value, reason } of weather) {
    it(`${tool.name} normalizes before querying and retains empty-result recovery`, async () => {
      vi.mocked(fetchWithTimeout).mockResolvedValue(new Response(null, { status: 204 }));
      const result = await runToolContract(tool, input);
      expect(
        new URL(String(vi.mocked(fetchWithTimeout).mock.calls.at(-1)?.[0])).searchParams.get(key),
      ).toBe(value);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint: expect.any(String) } } },
      });
      expect(JSON.stringify(result.content)).toContain(reason);
    });

    it.each(['SEA', 'kßa', 'ＫSEA', ' KSEA', 'KSEA\n'])(
      `${tool.name} gives actionable wire recovery for %j`,
      async (id) => {
        const result = await runToolContract(
          tool,
          tool === aviationGetPireps ? { station_id: id } : { station_ids: [id] },
        );
        expect(result.structuredContent).toMatchObject({
          error: {
            code: -32602,
            data: {
              reason: 'invalid_arguments',
              recovery: { hint: expect.stringContaining('aviation_find_stations') },
            },
          },
        });
        const text = JSON.stringify(result.content);
        for (const word of ['KSEA', 'K0S9', 'state', 'bbox', 'IATA', 'FAA'])
          expect(text).toContain(word);
        expect(fetchWithTimeout).not.toHaveBeenCalled();
      },
    );
  }

  it.each([aviationGetMetar, aviationGetTaf])(
    'reconciles canonical requested IDs on both result surfaces for $name',
    async (tool) => {
      const record =
        tool === aviationGetMetar
          ? {
              icaoId: 'KSEA',
              name: 'Seattle',
              lat: 47,
              lon: -122,
              elev: 100,
              obsTime: 1768500000,
              rawOb: 'KSEA METAR',
              clouds: [],
            }
          : {
              icaoId: 'KSEA',
              name: 'Seattle',
              issueTime: '2026-01-15T12:00:00Z',
              validTimeFrom: 1768500000,
              validTimeTo: 1768510000,
              rawTAF: 'KSEA TAF',
              fcsts: [],
            };
      vi.mocked(fetchWithTimeout).mockResolvedValue(Response.json([record]));
      const result = await runToolContract(tool, { station_ids: ['kSeA', 'k0s9'] });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        requested: ['KSEA', 'K0S9'],
        returned: ['KSEA'],
        missing: ['K0S9'],
        partial: true,
      });
      const text = JSON.stringify(result.content);
      expect(text).toContain('KSEA');
      expect(text).toContain('K0S9');
      expect(text).not.toContain('kSeA');
    },
  );

  it('normalizes every prompt identifier across later station chunks', async () => {
    const args = aviationPreflightBrief.args!.parse({
      departure_icao: 'ksea',
      destination_icao: 'kJfK',
      alternates: ' kbfi, k0s9, ks52, k36u, klax, ksfo, kord, kbos, kmia ',
    });
    const text = JSON.stringify(await aviationPreflightBrief.generate(args));
    for (const id of [
      'KSEA',
      'KJFK',
      'KBFI',
      'K0S9',
      'KS52',
      'K36U',
      'KLAX',
      'KSFO',
      'KORD',
      'KBOS',
      'KMIA',
    ])
      expect(text).toContain(id);
    expect(text).not.toMatch(/ksea|kJfK|kbfi|kmia/);
    const schema = z.toJSONSchema(aviationPreflightBrief.args!) as {
      properties: Record<string, { pattern?: string }>;
    };
    expect(schema.properties.departure_icao?.pattern).toBe('^[A-Za-z0-9]{4}$');
    expect(schema.properties.destination_icao?.pattern).toBe('^[A-Za-z0-9]{4}$');
  });
});
