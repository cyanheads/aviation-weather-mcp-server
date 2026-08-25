/**
 * @fileoverview Contract tests for the advertised input surface of every tool.
 *
 * Tool inputs are strict at the root: an argument key no schema declares is
 * rejected by name instead of silently stripped, and `inputSchema` advertises
 * `additionalProperties: false`. A parameter named in the README, in
 * `docs/design.md`, or in a tool description but absent from the Zod schema
 * therefore hard-fails for any caller who follows the docs. These tests pin the
 * declared root-key set per tool so that drift shows up here rather than in a
 * client, and they pin the root-strict / nested-strip split the strictness only
 * applies at the root.
 *
 * @module tests/tools/tool-input-contract.test
 */

import { describe, expect, it } from 'vitest';
import { aviationFindStations } from '@/mcp-server/tools/definitions/aviation-find-stations.tool.js';
import { aviationGetAdvisories } from '@/mcp-server/tools/definitions/aviation-get-advisories.tool.js';
import { aviationGetMetar } from '@/mcp-server/tools/definitions/aviation-get-metar.tool.js';
import { aviationGetPireps } from '@/mcp-server/tools/definitions/aviation-get-pireps.tool.js';
import { aviationGetTaf } from '@/mcp-server/tools/definitions/aviation-get-taf.tool.js';

const bbox = { minLat: 40, minLon: -90, maxLat: 45, maxLon: -85 };

/**
 * One row per tool: the exact root parameter names the docs may name, and a
 * payload exercising every one of them. Adding a parameter to a schema without
 * adding it here fails the key-set assertion.
 */
const tools = [
  {
    name: 'aviation_find_stations',
    def: aviationFindStations,
    keys: ['bbox', 'state', 'station_ids'],
    full: { station_ids: ['KSEA'], bbox, state: 'WA' },
  },
  {
    name: 'aviation_get_metar',
    def: aviationGetMetar,
    keys: ['hours', 'station_ids'],
    full: { station_ids: ['KSEA'], hours: 3 },
  },
  {
    name: 'aviation_get_taf',
    def: aviationGetTaf,
    keys: ['station_ids'],
    full: { station_ids: ['KSEA'] },
  },
  {
    name: 'aviation_get_pireps',
    def: aviationGetPireps,
    keys: ['altitude_max_ft', 'altitude_min_ft', 'bbox', 'distance_nm', 'hours', 'station_id'],
    full: {
      station_id: 'KSEA',
      bbox,
      distance_nm: 150,
      hours: 6,
      altitude_min_ft: 18000,
      altitude_max_ft: 35000,
    },
  },
  {
    name: 'aviation_get_advisories',
    def: aviationGetAdvisories,
    keys: ['advisory_type', 'bbox', 'hazard'],
    full: { advisory_type: 'sigmet', hazard: 'ICING', bbox },
  },
] as const;

describe('tool input contract', () => {
  for (const { name, def, keys, full } of tools) {
    describe(name, () => {
      it('declares exactly the documented root parameters', () => {
        expect(Object.keys(def.input.shape).sort()).toEqual([...keys]);
      });

      it('accepts a payload naming every declared parameter', () => {
        expect(def.input.safeParse(full).success).toBe(true);
      });

      it('rejects an undeclared root key by name rather than stripping it', () => {
        const result = def.input.safeParse({ ...full, not_a_parameter: 'x' });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error.issues).toEqual([
          expect.objectContaining({
            code: 'unrecognized_keys',
            keys: ['not_a_parameter'],
            path: [],
          }),
        ]);
        expect(result.error.issues[0]?.message).toContain('not_a_parameter');
      });

      it('rejects a camelCase spelling of a declared snake_case parameter', () => {
        // The realistic drift: a doc or a client writes `stationIds`. Before
        // strict inputs this was dropped and the call ran with the parameter
        // missing; it now fails loudly and names the offending key.
        const camel = keys.find((k) => k.includes('_'));
        if (!camel) return;
        const camelCase = camel.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
        const result = def.input.safeParse({ ...full, [camelCase]: 'x' });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error.issues[0]).toMatchObject({
          code: 'unrecognized_keys',
          keys: [camelCase],
        });
      });
    });
  }

  it('rejects every undeclared root key in one pass, naming all of them', () => {
    const result = aviationGetPireps.input.safeParse({
      station_id: 'KSEA',
      radius: 100,
      max_results: 5,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['radius', 'max_results'],
    });
  });

  describe('strictness is root-level only', () => {
    it('strips an undeclared key inside the nested bbox object', () => {
      for (const def of [aviationFindStations, aviationGetPireps, aviationGetAdvisories]) {
        const result = def.input.safeParse({ bbox: { ...bbox, altitude: 5000 } });
        expect(result.success).toBe(true);
        if (!result.success) continue;
        expect(result.data.bbox).toEqual(bbox);
      }
    });

    it('still enforces the nested bbox field constraints', () => {
      const result = aviationFindStations.input.safeParse({
        bbox: { ...bbox, minLat: 200 },
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0]?.path).toEqual(['bbox', 'minLat']);
    });
  });

  describe('declared defaults survive strict parsing', () => {
    it('applies hours and advisory_type defaults on a minimal payload', () => {
      expect(aviationGetMetar.input.parse({ station_ids: ['KSEA'] }).hours).toBe(1);
      expect(aviationGetPireps.input.parse({ station_id: 'KSEA' }).hours).toBe(3);
      expect(aviationGetAdvisories.input.parse({}).advisory_type).toBe('all');
    });

    it('leaves distance_nm undefined when omitted, so the handler can tell it apart', () => {
      // The 100 nm fallback lives in the handler, not the schema — the bbox +
      // distance_nm rejection depends on an omitted value staying undefined.
      expect(aviationGetPireps.input.parse({ station_id: 'KSEA' }).distance_nm).toBeUndefined();
    });
  });
});
