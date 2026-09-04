import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { composeSessionTools } from '../../../src/brain/session/capabilities.js';
import { initialActiveToolNames } from '../../../src/brain/session/factory.js';
import { runWithPolicy } from '../../../src/plugins/policyContext.js';
import type { Policy } from '../../../src/plugins/policy.js';

const tool = (name: string) => ({ name } as ToolDefinition);
const REG = ['Read', 'ToolSearch', 'mcp__gh__a', 'mcp__gh__b'].map(tool);

const definition = (name: string): ToolDefinition => ({
  name,
  label: `${name} label`,
  description: `${name} description`,
  parameters: Type.Object({ value: Type.String() }),
  execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
});

/** Exact provider-facing definition bytes, excluding executable function identity. */
function definitionTranscript(tools: ToolDefinition[]): string {
  return JSON.stringify(tools.map(({ execute: _execute, ...wire }) => wire));
}

function composeFixture(policy: 'legacy' | 'disabled' | 'default' = 'legacy'): ToolDefinition[] {
  const plugin = definition('PluginWrite');
  return composeSessionTools({
    kind: 'owner-chat',
    memoryTools: () => [definition('MemoryBuiltin')],
    shareImage: () => [definition('ShareImage')],
    pluginTools: [plugin],
    ...(policy !== 'legacy' ? {
      toolDeferral: {
        toolOwner: new Map([['PluginWrite', 'example']]),
        toolDeferLoading: new Set(['PluginWrite']),
        planSafeToolNames: new Set(),
        builtinDeferLoading: [],
        ...(policy === 'disabled' ? { options: { enabled: false } } : {}),
      },
      toolSearch: policy === 'disabled'
        ? () => { throw new Error('ToolSearch must not be built when deferral is globally disabled'); }
        : () => [definition('ToolSearch')],
    } : {}),
  });
}

describe('initialActiveToolNames (factory active/registry split)', () => {
  it('drops deferred names from the active slice but the registry (input) is untouched', () => {
    const active = initialActiveToolNames(REG, new Set(['mcp__gh__a', 'mcp__gh__b']));
    expect(active).toEqual(['Read', 'ToolSearch']);
    expect(REG.map((entry) => entry.name)).toEqual(['Read', 'ToolSearch', 'mcp__gh__a', 'mcp__gh__b']);
  });

  it('no deferral (undefined) → every tool starts active, byte-identical order', () => {
    expect(initialActiveToolNames(REG, undefined)).toEqual(['Read', 'ToolSearch', 'mcp__gh__a', 'mcp__gh__b']);
  });

  it('an empty deferred set → every tool active (the common case stays unchanged)', () => {
    expect(initialActiveToolNames(REG, new Set())).toEqual(['Read', 'ToolSearch', 'mcp__gh__a', 'mcp__gh__b']);
  });

  it('global-off policy preserves the legacy provider definition transcript byte for byte', () => {
    const legacy = definitionTranscript(composeFixture());
    const configuredOff = definitionTranscript(composeFixture('disabled'));

    expect(configuredOff).toBe(legacy);
    expect(composeFixture('disabled').map((entry) => entry.name)).toEqual([
      'MemoryBuiltin', 'ShareImage', 'PluginWrite', 'ExitPlanMode',
    ]);
    expect(createHash('sha256').update(configuredOff).digest('hex')).toBe('38691770a11d84f12b0cbd2cdc98456808fbc43bb7774a5d6e0802831f8d69db');
  });

  it.each(['build', 'plan'] as const)('keeps every pre-existing immediate definition byte-identical in %s mode', (mode) => {
    const policy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
    const legacy = runWithPolicy(policy, () => composeFixture(), { mode });
    const configured = runWithPolicy(policy, () => composeFixture('default'), { mode });
    const legacyImmediate = legacy.filter((entry) => entry.name !== 'PluginWrite');
    const configuredActive = configured.filter((entry) => entry.name !== 'PluginWrite');
    const configuredImmediate = configuredActive.filter((entry) => entry.name !== 'ToolSearch');

    expect(configuredActive.map((entry) => entry.name)).toEqual([
      'MemoryBuiltin', 'ToolSearch', 'ShareImage', 'ExitPlanMode',
    ]);
    expect(configuredImmediate.map((entry) => entry.name)).toEqual(legacyImmediate.map((entry) => entry.name));
    expect(definitionTranscript(configuredImmediate)).toBe(definitionTranscript(legacyImmediate));
  });
});
