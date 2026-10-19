/**
 * @fileoverview Active domestic/international SIGMETs and Center Weather Advisories.
 * @module mcp-server/tools/definitions/aviation-get-advisories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatDegrees } from '@/mcp-server/tools/format-degrees.js';
import {
  isAdvisoryHazard,
  supportsAdvisoryHazard,
} from '@/services/aviation-weather/advisory-products.js';
import { getAviationWeatherService } from '@/services/aviation-weather/aviation-weather-service.js';
import { isBboxOrdered } from '@/services/aviation-weather/bbox.js';
import type { AdvisorySummary } from '@/services/aviation-weather/types.js';

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
  .describe(
    'Ordered geographic bounding box. Matches each geometry part by its bounding envelope, not exact polygon intersection; date-line-crossing source geometry is unwrapped.',
  );

const PolygonPointSchema = z
  .object({
    lat: z.number().describe('Latitude in decimal degrees.'),
    lon: z.number().describe('Longitude in decimal degrees.'),
  })
  .describe('A polygon vertex as a lat/lon coordinate pair.');

/** Fence scanning is a single pass even for a bulletin made entirely of backticks. */
function bulletinBlock(raw: string): string {
  let longest = 0;
  let run = 0;
  for (const character of raw) {
    run = character === '`' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${raw}\n${fence}`;
}

export const aviationGetAdvisories = tool('aviation_get_advisories', {
  title: 'Get Active Aviation Advisories',
  description:
    'Get active domestic SIGMETs, international SIGMETs (including oceanic products), and Center Weather Advisories from the NWS Aviation Weather Center. Filter by advisory_type, hazard, or ordered bbox. Returns source coverage, decoded hazards/altitudes/movement, multipart geometry, and original bulletins; missing facts stay null. Independent source failures retain healthy results with partial coverage. AIRMET requests are rejected; this tool does not retrieve AIRMETs. Omit limit to return every available match; an explicit limit sorts results and discloses withheld matches.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    advisory_type: z
      .enum(['sigmet', 'isigmet', 'cwa', 'airmet', 'all'])
      .default('all')
      .describe(
        'Product selection: sigmet is domestic SIGMETs, isigmet is international SIGMETs, cwa is Center Weather Advisories, and all reads all three independently. airmet is rejected with guidance to separate AIRMET products.',
      ),
    hazard: z
      .enum([
        'CONVECTIVE',
        'TURBULENCE',
        'ICING',
        'IFR',
        'TS',
        'MTW',
        'DS',
        'SS',
        'TC',
        'VA',
        'PCPN',
        'UNK',
        'MTN OBSCN',
        'SURFACE WIND',
        'LLWS',
      ])
      .optional()
      .describe(
        'Upstream hazard filter. Domestic: CONVECTIVE, TURBULENCE, ICING, IFR. International: TS, TURBULENCE, ICING, MTW (mountain wave), DS (duststorm), SS (sandstorm), TC (tropical cyclone), VA (volcanic ash). CWA: TS, TURBULENCE, ICING, IFR, PCPN (precipitation), UNK (unknown). Incompatible sources are not_applicable; wholly incompatible selections are rejected. MTN OBSCN, SURFACE WIND and LLWS are not served and are rejected. A hazard-scoped zero says nothing about other hazards.',
      ),
    bbox: BboxSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Optional maximum matches to return, without a default or automatic cap. Sorts by source, issuer, series and validity; omit or raise it to retrieve withheld matches.',
      ),
  }),
  output: z.object({
    advisories: z
      .array(
        z
          .object({
            advisory_type: z.string().describe('Product type: SIGMET, ISIGMET or CWA.'),
            source: z.enum(['sigmet', 'isigmet', 'cwa']).describe('Independent source product.'),
            series_id: z
              .string()
              .nullable()
              .describe('Advisory series identifier, or null when omitted.'),
            hazard: z
              .string()
              .nullable()
              .describe('Source-native hazard type, or null when omitted.'),
            severity: z
              .number()
              .nullable()
              .describe(
                'Severity integer for convective SIGMETs (higher = more intense). Null when the advisory stated none.',
              ),
            issued_by: z
              .string()
              .nullable()
              .describe('Issuing office ICAO ID or CWSU code; null when omitted.'),
            fir_id: z
              .string()
              .nullable()
              .describe('Flight information region identifier, or null when omitted.'),
            fir_name: z
              .string()
              .nullable()
              .describe('Flight information region name, or null when omitted.'),
            qualifier: z
              .string()
              .nullable()
              .describe('Source-native hazard qualifier, or null when omitted.'),
            valid_from: z
              .string()
              .nullable()
              .describe(
                'Advisory validity start time in ISO 8601 format (UTC), or null when omitted.',
              ),
            valid_to: z
              .string()
              .nullable()
              .describe(
                'Advisory validity end time in ISO 8601 format (UTC), or null when omitted.',
              ),
            altitude_low_ft: z
              .number()
              .nullable()
              .describe('Lower altitude bound in feet MSL, or null if not specified.'),
            altitude_high_ft: z
              .number()
              .nullable()
              .describe('Upper altitude bound in feet MSL, or null if not specified.'),
            movement: z
              .object({
                direction_deg: z
                  .number()
                  .nullable()
                  .describe(
                    'Domestic source movement direction in degrees true (FROM semantics); null when omitted or international.',
                  ),
                direction_text: z
                  .string()
                  .nullable()
                  .optional()
                  .describe(
                    'International source-native direction text, without converting to domestic FROM-angle semantics; null when omitted.',
                  ),
                speed_kt: z
                  .number()
                  .nullable()
                  .describe('Decoded movement speed in knots, or null when omitted.'),
              })
              .nullable()
              .describe('System movement vector, or null if not available.'),
            polygon: z
              .array(PolygonPointSchema)
              .nullable()
              .describe(
                'Single-area compatibility boundary; null for multipart, line or missing geometry.',
              ),
            geometry: z
              .object({
                kind: z
                  .string()
                  .nullable()
                  .describe(
                    'Source-native geometry kind (AREA, AREAS, LINE), or null when omitted.',
                  ),
                parts: z
                  .array(z.array(PolygonPointSchema).describe('One intact source ring or line.'))
                  .describe('Separate rings or lines, never flattened into connecting edges.'),
              })
              .nullable()
              .describe(
                'Decoded source geometry, or null when no complete coordinates can be decoded.',
              ),
            raw_text: z
              .string()
              .nullable()
              .describe(
                'Original bulletin text, preserving line breaks and blank lines; null when omitted.',
              ),
          })
          .describe('An active advisory, with source omissions preserved as null.'),
      )
      .describe(
        'Active advisories matching the filter criteria. May be empty during fair weather periods.',
      ),
  }),
  enrichment: {
    coverage: z
      .array(
        z
          .object({
            source: z.enum(['sigmet', 'isigmet', 'cwa']).describe('Selected source product.'),
            status: z
              .enum(['ok', 'failed', 'not_applicable'])
              .describe(
                'Readable response, unavailable response or unsupported source/hazard pair.',
              ),
            drawn: z
              .number()
              .nullable()
              .describe(
                'Decoded rows after product/hazard selection, before bbox; null for failed or not_applicable sources.',
              ),
            message: z
              .string()
              .optional()
              .describe('Source failure, skipped-row or applicability explanation.'),
          })
          .describe('One selected source coverage result.'),
      )
      .describe('Coverage of selected sources, independent of bbox and limit.'),
    partial: z
      .boolean()
      .describe(
        'True when a source failed or unreadable rows were skipped; no complete-coverage claim is possible.',
      ),
    drawn: z
      .number()
      .optional()
      .describe(
        'With bbox: decoded rows after product/hazard, before geographic filtering; successful sources only.',
      ),
    matched: z
      .number()
      .optional()
      .describe('With bbox: rows intersecting any geometry part, before limit.'),
    returned: z
      .number()
      .optional()
      .describe('With bbox or explicit limit: rows returned after limit.'),
    unlocated: z
      .number()
      .optional()
      .describe('With bbox: drawn rows lacking decoded geometry; not known to be outside the box.'),
    total: z
      .number()
      .optional()
      .describe('With explicit limit: all available matches before limiting.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'With explicit limit: whether matches were withheld. Omit or raise limit to retrieve them.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Coverage-scoped empty, bbox-removal or explicit-limit explanation and recovery. Failed sources never establish zero coverage.',
      ),
  },

  enrichmentTrailer: {
    coverage: {
      render: (rows) =>
        rows
          .map(
            (row) =>
              `${row.source}: ${row.status}; drawn ${row.drawn ?? 'not established'}${row.message ? ` — ${row.message}` : ''}`,
          )
          .join('\n'),
    },
  },

  errors: [
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The bounding box is inverted — minLat > maxLat or minLon > maxLon.',
      recovery:
        'Ensure minLat <= maxLat and minLon <= maxLon. Swap the inverted min/max coordinates and retry.',
    },
    {
      reason: 'airmet_not_served',
      code: JsonRpcErrorCode.ValidationError,
      when: 'advisory_type "airmet" was requested, or an unsupported AIRMET-family hazard (MTN OBSCN, SURFACE WIND, LLWS).',
      recovery:
        'Use advisory_type "sigmet", "isigmet", "cwa" or "all" for SIGMET/CWA coverage. AIRMET information lives on separate products this tool does not read: the Graphical AIRMET (G-AIRMET), which replaced the textual AIRMET over the CONUS in January 2025, and the textual AIRMET feed outside it.',
    },
    {
      reason: 'hazard_not_supported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No selected source supports the hazard.',
      recovery:
        'Choose a compatible advisory_type/hazard pair from the input descriptions, or omit the hazard filter.',
    },
    {
      reason: 'advisory_sources_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      retryable: true,
      when: 'Every applicable source failed or was unreadable.',
      recovery:
        'Retry later or request one advisory product separately; no weather absence was established.',
    },
  ],
  async handler(input, ctx) {
    if (input.bbox && !isBboxOrdered(input.bbox)) {
      throw ctx.fail(
        'invalid_bbox',
        'Bounding box is inverted: minLat must be <= maxLat and minLon <= maxLon.',
      );
    }

    // Rejected here rather than by narrowing the Zod enum, so the caller
    // receives the typed reason and its recovery instead of a bare -32602.
    if (input.advisory_type === 'airmet') {
      throw ctx.fail(
        'airmet_not_served',
        'advisory_type "airmet" is not served: this tool reads domestic/international SIGMETs and CWAs, not AIRMET products.',
      );
    }

    // Keep unsupported hazards distinct from a successfully observed zero draw.
    if (input.hazard && !isAdvisoryHazard(input.hazard)) {
      throw ctx.fail(
        'airmet_not_served',
        `Hazard "${input.hazard}" is not served: it is an AIRMET-family phenomenon with no counterpart in the selected advisory products.`,
      );
    }

    if (
      input.hazard &&
      input.advisory_type !== 'all' &&
      !supportsAdvisoryHazard(input.advisory_type, input.hazard)
    ) {
      throw ctx.fail(
        'hazard_not_supported',
        `${input.advisory_type} does not support hazard ${input.hazard}.`,
      );
    }

    ctx.log.info('Fetching advisories', {
      advisoryType: input.advisory_type,
      hazard: input.hazard,
      hasBbox: !!input.bbox,
    });

    const svc = getAviationWeatherService();
    let summary: AdvisorySummary | undefined;
    let advisories = await svc.fetchAdvisories(
      {
        advisoryType: input.advisory_type,
        ...(input.hazard ? { hazard: input.hazard } : {}),
        ...(input.bbox ? { bbox: input.bbox } : {}),
        onSummary: (value) => {
          summary = value;
        },
      },
      ctx,
    );

    // The count arrives only when AWC served a readable array, so an undefined
    // one is no draw at all rather than a draw of zero. With nothing observed
    // there is no stage to name, and defaulting it to zero would assert a
    // fair-weather sky the tool never saw.
    if (summary) {
      ctx.enrich({ coverage: summary.coverage, partial: summary.partial });
      const notices: string[] = [];
      const scope = summary.coverage
        .filter((row) => row.status === 'ok')
        .map((row) => row.source)
        .join(', ');
      if (summary.partial)
        notices.push(
          'Coverage is partial; counts describe readable sources only. See coverage for unavailable products or skipped rows.',
        );
      if (!summary.drawn) {
        notices.push(
          `No decoded active advisories in readable sources (${scope})${input.hazard ? ` with hazard ${input.hazard}; this says nothing about other hazards. Drop the hazard filter to broaden the draw.` : '.'}${input.bbox ? ' The bbox is not the cause: the draw was already empty and the bbox never applied.' : ''}`,
        );
      }
      if (input.bbox) {
        ctx.enrich({
          drawn: summary.drawn,
          matched: summary.matched,
          returned: advisories.length,
          unlocated: summary.unlocated,
        });
        const outside = summary.drawn - summary.matched - summary.unlocated;
        if (outside || summary.unlocated)
          notices.push(
            `Readable sources (${scope}) drew ${summary.drawn} after product/hazard selection; bbox matched ${summary.matched}, excluded ${outside} located advisory(ies), and left ${summary.unlocated} unlocated (unknown intersection). Widen the bbox or drop it to see the full draw.`,
          );
      }
      if (input.limit !== undefined) {
        const total = advisories.length;
        advisories.sort((a, b) => {
          for (const key of [
            'source',
            'issued_by',
            'series_id',
            'valid_from',
            'valid_to',
            'raw_text',
          ] as const) {
            const left = a[key] ?? '';
            const right = b[key] ?? '';
            if (left !== right) return left < right ? -1 : 1;
          }
          return 0;
        });
        advisories = advisories.slice(0, input.limit);
        ctx.enrich({ total, returned: advisories.length, truncated: total > advisories.length });
        if (total > advisories.length)
          notices.push(
            `Returned ${advisories.length} of ${total} available matches; ${total - advisories.length} withheld by limit. Omit limit or raise it to at least ${total} to retrieve all available matches.`,
          );
      }
      if (notices.length) ctx.enrich.notice(notices.join(' '));
    }

    ctx.log.info('Advisories retrieved', { count: advisories.length, drawnRows: summary?.drawn });
    return { advisories };
  },

  format: (result) => {
    const lines: string[] = [`**${result.advisories.length} active advisory(ies)**\n`];
    for (const a of result.advisories) {
      lines.push(
        `## ${a.advisory_type}: ${a.series_id ?? 'not reported'} — ${a.hazard ?? 'not reported'}`,
      );
      lines.push(
        `**Source:** ${a.source} | **FIR:** ${a.fir_id ?? 'not reported'} — ${a.fir_name ?? 'not reported'} | **Qualifier:** ${a.qualifier ?? 'not reported'}`,
      );
      // Severity is populated on convective SIGMETs and null where the advisory
      // stated none, so a dropped line reads as a severity the renderer skipped.
      lines.push(`**Severity:** ${a.severity != null ? a.severity : 'not reported'}`);
      lines.push(
        `**Issued by:** ${a.issued_by ?? 'not reported'} | **Valid:** ${a.valid_from ?? 'not reported'} → ${a.valid_to ?? 'not reported'}`,
      );

      // A bound the advisory never stated is not SFC or UNL. Those name real
      // conditions — the hazard reaching the ground, or having no top — and
      // asserting either from a null claims what the issuing office did not.
      const altLow =
        a.altitude_low_ft != null ? `${a.altitude_low_ft.toLocaleString()} ft` : 'not specified';
      const altHigh =
        a.altitude_high_ft != null ? `${a.altitude_high_ft.toLocaleString()} ft` : 'not specified';
      lines.push(`**Altitude:** ${altLow} – ${altHigh}`);

      const movDir =
        a.movement?.direction_deg != null ? `${a.movement.direction_deg}°` : 'unreported direction';
      const movSpd =
        a.movement?.speed_kt != null ? `${a.movement.speed_kt} kt` : 'unreported speed';
      lines.push(`**Movement:** ${a.movement ? `${movDir} at ${movSpd}` : 'not reported'}`);
      if (a.movement?.direction_text !== undefined)
        lines.push(`**Source direction text:** ${a.movement.direction_text ?? 'not reported'}`);

      if (a.polygon && a.polygon.length > 0) {
        const pts = a.polygon
          .map((p) => `${formatDegrees(p.lat)},${formatDegrees(p.lon)}`)
          .join(' → ');
        lines.push(`**Polygon (${a.polygon.length} pts):** ${pts}`);
      } else {
        lines.push('**Polygon:** not available as a single area');
      }
      if (a.geometry) {
        lines.push(`**Geometry kind:** ${a.geometry.kind ?? 'not reported'}`);
        if (
          a.geometry.parts.length === 1 &&
          a.polygon &&
          a.geometry.parts[0]?.length === a.polygon.length &&
          a.geometry.parts[0].every(
            (point, index) =>
              point.lat === a.polygon?.[index]?.lat && point.lon === a.polygon?.[index]?.lon,
          )
        )
          lines.push('**Geometry parts:** one part, identical to Polygon above.');
        else
          for (const [index, points] of a.geometry.parts.entries())
            lines.push(
              `**Geometry part ${index + 1}:** ${points.map((p) => `${formatDegrees(p.lat)},${formatDegrees(p.lon)}`).join(' → ')}`,
            );
      } else lines.push('**Geometry:** not reported');

      lines.push(
        `**Raw text:**\n${a.raw_text === null ? 'not reported' : bulletinBlock(a.raw_text)}`,
      );
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
