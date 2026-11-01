/**
 * @fileoverview Bundle cleaning preserves nested runtime skills modules while removing package-root agent docs.
 * @module tests/scripts/clean-mcpb.test
 */

import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY } from '../../scripts/lint-packaging.js';

describe('MCPB agent-doc selection', () => {
  it('keeps SDK runtime modules and published server skills', () => {
    const entries = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.mts',
      'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.cjs',
      'skills/preflight-weather/SKILL.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([]);
    expect(entries.filter((entry) => AGENT_DOC_ENTRY.test(entry))).toEqual([]);
  });

  it('removes package-root docs from scoped, unscoped and nested dependencies', () => {
    const entries = [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/package/skills/guide/SKILL.md',
      'node_modules/package/.claude/skills/guide/SKILL.md',
      'node_modules/package/.agents/skills/guide/SKILL.md',
      'node_modules/package/SKILL.md',
      'node_modules/parent/node_modules/@scope/package/skills/guide/SKILL.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual(entries);
    expect(entries.filter((entry) => AGENT_DOC_ENTRY.test(entry))).toEqual(entries);
  });
});
