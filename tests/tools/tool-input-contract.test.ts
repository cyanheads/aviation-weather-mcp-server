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
 * These assert against the schema directly, which is the surface `inputSchema`
 * advertises. The framework runs a pre-validation step above it that rewrites a
 * case-style variant of a declared key before the schema sees it, so a key the
 * schema rejects here is not necessarily a key a caller cannot send — see the
 * camelCase case below.
 *
 * @module tests/tools/tool-input-contract.test
 */

import { z } from '@cyanheads/mcp-ts-core';
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
    keys: ['bbox', 'limit', 'state', 'station_ids'],
    full: { station_ids: ['KSEA'], bbox, state: 'WA', limit: 25 },
  },
  {
    name: 'aviation_get_metar',
    def: aviationGetMetar,
    keys: ['bbox', 'hours', 'limit', 'station_ids'],
    full: { station_ids: ['KSEA'], bbox, hours: 3, limit: 25 },
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
    keys: [
      'altitude_max_ft',
      'altitude_min_ft',
      'bbox',
      'distance_nm',
      'hours',
      'limit',
      'min_intensity',
      'station_id',
    ],
    full: {
      station_id: 'KSEA',
      bbox,
      distance_nm: 150,
      hours: 6,
      altitude_min_ft: 18000,
      altitude_max_ft: 35000,
      min_intensity: 'mod',
      limit: 25,
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

      it('rejects a camelCase spelling of a declared snake_case parameter at the schema', () => {
        // The realistic drift: a doc or a client writes `stationIds`. The schema
        // rejects it by name rather than dropping it, which is what keeps
        // `additionalProperties: false` honest. A caller does not see that
        // rejection: the framework's case-style pre-validation folds `-`/`_` and
        // case, matches the single declared key, and rewrites the argument
        // before the schema runs — so the call succeeds. What is pinned here is
        // the schema, not the caller-facing outcome.
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

  describe('station identifier shape on the weather tools', () => {
    /**
     * The three fields that take an ICAO identifier and send it to a weather
     * endpoint. They share one shape, so a caller who learns it on one tool can
     * rely on it at the others — `aviation_find_stations` deliberately imposes
     * none (decision 27) and is not in this set.
     */
    const stationFields = [
      [
        'aviation_get_metar station_ids[]',
        (id: string) => aviationGetMetar.input.safeParse({ station_ids: [id] }).success,
      ],
      [
        'aviation_get_taf station_ids[]',
        (id: string) => aviationGetTaf.input.safeParse({ station_ids: [id] }).success,
      ],
      [
        'aviation_get_pireps station_id',
        (id: string) => aviationGetPireps.input.safeParse({ station_id: id }).success,
      ],
    ] as const;

    describe.each(stationFields)('%s', (_field, accepts) => {
      it('accepts a four-letter identifier', () => {
        expect(accepts('KSEA')).toBe(true);
      });

      it.each([
        ['K0S9', 'Port Townsend — K plus a digit-bearing FAA identifier'],
        ['KS52', 'Methow Valley'],
        ['K36U', 'a TAF-issuing digit-bearing station'],
      ])('accepts the digit-bearing identifier %s (%s)', (id) => {
        expect(accepts(id)).toBe(true);
      });

      it.each([
        ['a lowercase identifier', 'k0s9'],
        ['a three-character identifier', 'K0S'],
        ['a five-character identifier', 'K0S9X'],
        ['a three-letter IATA code', 'SEA'],
        ['an identifier carrying a separator', 'K-S9'],
        ['a padded identifier', 'KSEA '],
        ['an empty identifier', ''],
      ])('rejects %s', (_label, id) => {
        expect(accepts(id)).toBe(false);
      });
    });

    it('advertises the same alphanumeric pattern on all three fields', () => {
      /** The `pattern` the advertised JSON Schema carries at `path`. */
      function advertisedPattern(schema: z.ZodType, ...path: string[]): unknown {
        let node: unknown = z.toJSONSchema(schema);
        for (const key of path) node = (node as Record<string, unknown> | undefined)?.[key];
        return (node as { pattern?: unknown } | undefined)?.pattern;
      }

      expect(advertisedPattern(aviationGetMetar.input, 'properties', 'station_ids', 'items')).toBe(
        '^[A-Z0-9]{4}$',
      );
      expect(advertisedPattern(aviationGetTaf.input, 'properties', 'station_ids', 'items')).toBe(
        '^[A-Z0-9]{4}$',
      );
      expect(advertisedPattern(aviationGetPireps.input, 'properties', 'station_id')).toBe(
        '^[A-Z0-9]{4}$',
      );
    });

    it('describes no station identifier as letters only on any tool', () => {
      // A digit-bearing identifier is valid on every weather tool, so a
      // description calling the shape "4-letter" would steer a caller away
      // from the identifiers aviation_find_stations hands back.
      for (const { def } of tools) {
        const surface = JSON.stringify([
          def.description,
          z.toJSONSchema(def.input),
          z.toJSONSchema(def.output),
          def.errors,
        ]);
        expect(surface).not.toMatch(/\b(4|four)[- ]letter\b|\b4 letters\b/i);
      }
    });
  });

  describe('declared defaults survive strict parsing', () => {
    it('applies hours and advisory_type defaults on a minimal payload', () => {
      expect(aviationGetMetar.input.parse({ station_ids: ['KSEA'] }).hours).toBe(1);
      expect(aviationGetPireps.input.parse({ station_id: 'KSEA' }).hours).toBe(3);
      expect(aviationGetAdvisories.input.parse({}).advisory_type).toBe('all');
    });

    it('advertises the sea-level floor and the FL600 ceiling on both PIREP altitude bounds', () => {
      // The bounds are feet MSL and AWC searches neither a band below sea level
      // nor the centre one far above FL600 derives, so both ends belong on the
      // advertised schema where a caller sees them before the call rather than
      // in an upstream rejection after it.
      const advertised = z.toJSONSchema(aviationGetPireps.input) as {
        properties?: Record<string, { minimum?: unknown; maximum?: unknown }>;
      };

      expect(advertised.properties?.altitude_min_ft).toMatchObject({ minimum: 0, maximum: 60000 });
      expect(advertised.properties?.altitude_max_ft).toMatchObject({ minimum: 0, maximum: 60000 });
    });

    it('leaves distance_nm undefined when omitted, so the handler can tell it apart', () => {
      // The 100 nm fallback lives in the handler, not the schema — the bbox +
      // distance_nm rejection depends on an omitted value staying undefined.
      expect(aviationGetPireps.input.parse({ station_id: 'KSEA' }).distance_nm).toBeUndefined();
    });
  });
});
