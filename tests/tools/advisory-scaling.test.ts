/**
 * @fileoverview Bounded CPU regressions for raw bulletin rendering and winding geometry.
 * @module tests/tools/advisory-scaling.test
 */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { aviationGetAdvisories } from '@/mcp-server/tools/definitions/aviation-get-advisories.tool.js';
import { fetchAdvisoryProducts } from '@/services/aviation-weather/advisory-products.js';
import type { NormalizedAdvisory } from '@/services/aviation-weather/types.js';

const advisory: NormalizedAdvisory = {
  advisory_type: 'SIGMET',
  source: 'sigmet',
  series_id: null,
  issued_by: null,
  hazard: null,
  severity: null,
  valid_from: null,
  valid_to: null,
  altitude_low_ft: null,
  altitude_high_ft: null,
  movement: null,
  polygon: null,
  geometry: null,
  fir_id: null,
  fir_name: null,
  qualifier: null,
  raw_text: null,
};

describe('advisory linear work bounds', () => {
  it.each(['digits', 'ticks', 'lines'] as const)(
    'renders %s at each doubling from 5k through 320k with bounded thread CPU',
    (shape) => {
      const readings: { size: number; cpuUs: number }[] = [];
      for (let size = 5_000; size <= 320_000; size *= 2) {
        const raw =
          shape === 'ticks'
            ? '`'.repeat(size)
            : shape === 'lines'
              ? '  \r\n'.repeat(size / 4)
              : '1'.repeat(size) + '\ny';
        const input = { advisories: [{ ...advisory, raw_text: raw }] };
        aviationGetAdvisories.format!(input);
        const before = process.threadCpuUsage();
        for (let repeat = 0; repeat < 40; repeat++) {
          const output = aviationGetAdvisories.format!(input);
          expect(output[0]).toMatchObject({ type: 'text' });
        }
        const elapsed = process.threadCpuUsage(before);
        const cpuUs = elapsed.user + elapsed.system;
        readings.push({ size, cpuUs });
        expect(cpuUs).toBeLessThan(2_000_000);
        // Check the bound before asking the renderer to double its input again.
        expect(cpuUs / readings[0]!.cpuUs).toBeLessThan(256);
      }
      console.info('advisory-render-scaling', shape, JSON.stringify(readings));
    },
  );
  it('bounds repeatedly winding geometry without accumulating longitude-adjustment loops', async () => {
    const readings: { size: number; cpuUs: number }[] = [];
    for (let size = 5_000; size <= 320_000; size *= 2) {
      const coords = Array.from({ length: size }, (_, index) => ({
        lat: 10,
        lon: [-170, -50, 70][index % 3]!,
      }));
      const raw = [{ rawSigmet: 'WINDING', geom: 'LINE', coords }];
      const before = process.threadCpuUsage();
      const rows = await fetchAdvisoryProducts(
        { advisoryType: 'isigmet', bbox: { minLat: 9, maxLat: 11, minLon: -1, maxLon: 1 } },
        'https://example.test',
        async () => raw,
        createMockContext(),
      );
      const elapsed = process.threadCpuUsage(before);
      const cpuUs = elapsed.user + elapsed.system;
      readings.push({ size, cpuUs });
      expect(rows).toHaveLength(1);
      expect(cpuUs).toBeLessThan(2_000_000);
      expect(cpuUs / readings[0]!.cpuUs).toBeLessThan(256);
    }
    console.info('advisory-geometry-scaling', JSON.stringify(readings));
  });
});
