/**
 * @fileoverview Tests for the aviation_preflight_brief prompt.
 * @module tests/prompts/aviation-preflight-brief.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { aviationPreflightBrief } from '@/mcp-server/prompts/definitions/aviation-preflight-brief.prompt.js';

describe('aviationPreflightBrief', () => {
  it('generates a single user message for a simple departure/destination pair', () => {
    const args = aviationPreflightBrief.args!.parse({
      departure_icao: 'KSEA',
      destination_icao: 'KJFK',
    });
    const messages = aviationPreflightBrief.generate(args);

    expect(messages).toBeInstanceOf(Array);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content.type).toBe('text');
  });

  it('includes departure and destination ICAOs in the generated text', () => {
    const args = aviationPreflightBrief.args!.parse({
      departure_icao: 'KSEA',
      destination_icao: 'KJFK',
    });
    const messages = aviationPreflightBrief.generate(args);
    const text = (messages[0].content as { type: string; text: string }).text;

    expect(text).toContain('KSEA');
    expect(text).toContain('KJFK');
  });

  it('includes all alternates in the generated tool call list', () => {
    const args = aviationPreflightBrief.args!.parse({
      departure_icao: 'KBOS',
      destination_icao: 'KLGA',
      alternates: 'KEWR,KPHL',
    });
    const messages = aviationPreflightBrief.generate(args);
    const text = (messages[0].content as { type: string; text: string }).text;

    expect(text).toContain('KBOS');
    expect(text).toContain('KLGA');
    expect(text).toContain('KEWR');
    expect(text).toContain('KPHL');
  });

  it('references all four aviation tools in the instructions', () => {
    const args = aviationPreflightBrief.args!.parse({
      departure_icao: 'KSFO',
      destination_icao: 'KLAX',
    });
    const messages = aviationPreflightBrief.generate(args);
    const text = (messages[0].content as { type: string; text: string }).text;

    expect(text).toContain('aviation_get_metar');
    expect(text).toContain('aviation_get_taf');
    expect(text).toContain('aviation_get_pireps');
    expect(text).toContain('aviation_get_advisories');
  });

  it('omits alternates section when alternates is not provided', () => {
    const args = aviationPreflightBrief.args!.parse({
      departure_icao: 'KSEA',
      destination_icao: 'KORD',
    });
    const messages = aviationPreflightBrief.generate(args);
    const text = (messages[0].content as { type: string; text: string }).text;

    expect(text).not.toContain('**Alternates:**');
  });

  it('includes go/no-go briefing summary instructions', () => {
    const args = aviationPreflightBrief.args!.parse({
      departure_icao: 'KDEN',
      destination_icao: 'KDFW',
    });
    const messages = aviationPreflightBrief.generate(args);
    const text = (messages[0].content as { type: string; text: string }).text;

    expect(text).toContain('Go/No-Go');
  });

  it('includes disclaimer about official briefing sources', () => {
    const args = aviationPreflightBrief.args!.parse({
      departure_icao: 'KMIA',
      destination_icao: 'KATL',
    });
    const messages = aviationPreflightBrief.generate(args);
    const text = (messages[0].content as { type: string; text: string }).text;

    expect(text).toContain('informational purposes only');
  });

  it('trims whitespace from alternate IDs', () => {
    const args = aviationPreflightBrief.args!.parse({
      departure_icao: 'KSEA',
      destination_icao: 'KSFO',
      alternates: ' KBFI , KRNT ',
    });
    const messages = aviationPreflightBrief.generate(args);
    const text = (messages[0].content as { type: string; text: string }).text;

    // Trimmed IDs should appear in the text
    expect(text).toContain('KBFI');
    expect(text).toContain('KRNT');
  });
});
