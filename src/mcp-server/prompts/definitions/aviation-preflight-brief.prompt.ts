/**
 * @fileoverview Prompt for structured preflight weather briefing.
 * Guides the LLM to call METAR, TAF, and advisories in sequence and synthesize a go/no-go picture.
 * @module mcp-server/prompts/definitions/aviation-preflight-brief
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const aviationPreflightBrief = prompt('aviation_preflight_brief', {
  description:
    'Build a complete preflight weather briefing for a flight. Calls aviation_get_metar, aviation_get_taf, aviation_get_pireps, and aviation_get_advisories in sequence and synthesizes a go/no-go picture with flight categories and active hazards. Provide departure and destination ICAO IDs (e.g., KSEA, KJFK); alternates are optional.',
  args: z.object({
    departure_icao: z.string().describe('Departure airport ICAO identifier (e.g., KSEA).'),
    destination_icao: z.string().describe('Destination airport ICAO identifier (e.g., KJFK).'),
    alternates: z
      .string()
      .optional()
      .describe('Optional comma-separated alternate airport ICAO IDs (e.g., "KBFI,KBOS").'),
  }),
  generate: (args) => {
    const allIcaos = [args.departure_icao, args.destination_icao];
    if (args.alternates) {
      allIcaos.push(
        ...args.alternates
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    const icaoList = allIcaos.join(', ');

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Please provide a complete preflight weather briefing for the following flight:

**Departure:** ${args.departure_icao}
**Destination:** ${args.destination_icao}${args.alternates ? `\n**Alternates:** ${args.alternates}` : ''}

Follow this sequence:

1. **Current conditions (METARs)** — Call \`aviation_get_metar\` for: ${icaoList}
   - Report flight category (VFR/MVFR/IFR/LIFR) for each station
   - Note ceiling, visibility, wind, and altimeter

2. **Forecasts (TAFs)** — Call \`aviation_get_taf\` for: ${args.departure_icao}, ${args.destination_icao}
   - Identify any forecast deterioration or improvement during the planned flight window
   - Flag TEMPO/BECMG/PROB groups that could affect operations

3. **PIREPs** — Call \`aviation_get_pireps\` centered on ${args.departure_icao} and ${args.destination_icao}
   - Report any significant turbulence (MOD or greater) or icing (LGT or greater)
   - Note altitude ranges where hazards were reported
   - Absence of PIREPs does not guarantee smooth conditions

4. **Advisories** — Call \`aviation_get_advisories\` for the entire route area
   - List any active SIGMETs or AIRMETs (turbulence, icing, IFR, convective)
   - Include valid times and affected altitudes

5. **Briefing summary** — Synthesize the above into:
   - **Go/No-Go recommendation** based on the aggregate picture
   - **Primary concerns** listed in order of severity
   - **Alternate considerations** if relevant
   - **Reminder:** This briefing is for informational purposes only. Flight in IMC or controlled airspace requires an official preflight briefing from an authorized source (e.g., 1800wxbrief.com).`,
        },
      },
    ];
  },
});
