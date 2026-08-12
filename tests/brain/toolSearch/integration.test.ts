import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { composeSessionTools, applyToolVisibility, type ToolVisibilityTarget } from '../../../src/brain/session/capabilities.js';
import { createToolSearchHandle, toolSearchTool, type ToolSearchHandle } from '../../../src/brain/toolSearch/toolSearchTool.js';
import { runWithPolicy } from '../../../src/plugins/policyContext.js';
import type { Policy } from '../../../src/plugins/policy.js';

/** A minimal but real ToolDefinition (execute is a fn, so both composition gates wrap it). */
const stub = (name: string, description = name): ToolDefinition => ({
  name,
  label: name,
  description,
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
});

/** A fake PI session backed by the composed tool list — mirrors what the factory wires onto the handle. */
function sessionFrom(composed: ToolDefinition[], activeNames: string[]): ToolVisibilityTarget & { calls: string[][] } {
  const state = { active: [...activeNames], calls: [] as string[][] };
  return {
    calls: state.calls,
    getAllTools: () => composed.map((t) => ({ name: t.name, description: t.description })),
    getActiveToolNames: () => state.active,
    setActiveToolsByName: (names: string[]) => { state.active = [...names]; state.calls.push(names); },
  };
}

const accessPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

function composeWithPolicy(
  pluginTools: ToolDefinition[],
  options: {
    defaults?: string[];
    overrides?: { sources: Record<string, 'immediate' | 'deferred'>; tools: Record<string, Record<string, 'immediate' | 'deferred'>> };
    threshold?: number;
    enabled?: boolean;
  } = {},
): { composed: ToolDefinition[]; handle?: ToolSearchHandle } {
  const owners = new Map(pluginTools.map((tool) => [
    tool.name,
    tool.name.startsWith('Discord') ? 'discord' : tool.name === 'ScanCode' ? 'security-scan' : 'mcp',
  ]));
  let handle: ToolSearchHandle | undefined;
  const composed = composeSessionTools({
    kind: 'owner-chat',
    pluginTools,
    toolDeferral: {
      toolOwner: owners,
      toolDeferLoading: new Set(options.defaults ?? []),
      planSafeToolNames: new Set(),
      builtinDeferLoading: [],
      overrides: options.overrides,
      options: { enabled: options.enabled, threshold: options.threshold },
    },
    toolSearch: (deferred) => {
      handle = createToolSearchHandle(deferred);
      return [toolSearchTool(handle)];
    },
  });
  return { composed, handle };
}

/** End-to-end through the REAL composition path: compose metadata → policy → factory active-split →
 *  ToolSearch execute → per-turn visibility. This is the payload check, not a mocked policy call. */
describe('tool-search end to end (real composition path)', () => {
  const mcp = Array.from({ length: 12 }, (_, i) => stub(`mcp__github__op_${i}`, `GitHub operation ${i}`));
  const nativeCore = [stub('Read'), stub('Edit'), stub('Bash'), stub('DiscordApi')];
  const pluginTools = [...nativeCore, ...mcp];

  it('withholds threshold-selected tools from the initial active set but keeps them in the registry', async () => {
    const { composed, handle } = composeWithPolicy(pluginTools);
    expect(handle?.deferred.size).toBe(12);

    const registry = composed.map((t) => t.name);
    expect(registry).toContain('ToolSearch');
    for (const tool of mcp) expect(registry).toContain(tool.name);

    const initialActive = registry.filter((name) => !handle!.deferred.has(name));
    expect(initialActive).toContain('ToolSearch');
    expect(initialActive).toContain('Read');
    for (const tool of mcp) expect(initialActive).not.toContain(tool.name);

    handle!.session = sessionFrom(composed, initialActive);
    const search = composed.find((tool) => tool.name === 'ToolSearch')!;
    await search.execute('id', { query: 'select:mcp__github__op_3,mcp__github__op_7' }, undefined, undefined, {} as never);

    expect(handle!.activated.has('mcp__github__op_3')).toBe(true);
    expect(handle!.activated.has('mcp__github__op_7')).toBe(true);
    applyToolVisibility(handle!.session as ToolVisibilityTarget, new Set(pluginTools.map((tool) => tool.name)), undefined, handle);
    const finalActive = handle!.session!.getActiveToolNames();
    expect(finalActive).toContain('mcp__github__op_3');
    expect(finalActive).toContain('mcp__github__op_7');
    expect(finalActive).not.toContain('mcp__github__op_0');
    expect(finalActive).toContain('Read');
    expect(finalActive).toContain('ToolSearch');
  });

  it('composes ToolSearch for a manifest-default plugin tool even with no MCP tools', () => {
    const discord = stub('DiscordCreateChannel', 'Create a Discord channel');
    const { composed, handle } = composeWithPolicy([discord], { defaults: ['DiscordCreateChannel'] });
    expect(handle?.deferred).toEqual(new Set(['DiscordCreateChannel']));
    expect(composed.map((tool) => tool.name)).toEqual(['ToolSearch', 'DiscordCreateChannel', 'ExitPlanMode']);
  });

  it('applies owner-qualified overrides to non-MCP tools in the full composed set', () => {
    const scan = stub('ScanCode');
    const discord = stub('DiscordCreateChannel');
    const { handle } = composeWithPolicy([scan, discord], {
      overrides: {
        sources: { 'plugin:security-scan': 'deferred' },
        tools: { 'plugin:discord': { DiscordCreateChannel: 'deferred' } },
      },
    });
    expect(handle?.deferred).toEqual(new Set(['ScanCode', 'DiscordCreateChannel']));
  });

  it('evaluates built-in groups too, not only pluginTools', () => {
    let handle: ToolSearchHandle | undefined;
    const composed = composeSessionTools({
      kind: 'owner-chat',
      shareImage: () => [stub('GenerateImage')],
      pluginTools: [],
      toolDeferral: {
        toolOwner: new Map(),
        toolDeferLoading: new Set(),
        planSafeToolNames: new Set(),
        builtinDeferLoading: ['GenerateImage'],
      },
      toolSearch: (deferred) => {
        handle = createToolSearchHandle(deferred);
        return [toolSearchTool(handle)];
      },
    });

    expect(handle?.deferred).toEqual(new Set(['GenerateImage']));
    expect(composed.map((tool) => tool.name)).toEqual(['ToolSearch', 'GenerateImage', 'ExitPlanMode']);
  });

  it('builds each definition group once while resolving deferral', () => {
    const calls = { memory: 0, search: 0, image: 0 };
    const composed = composeSessionTools({
      kind: 'owner-chat',
      memoryTools: () => { calls.memory++; return [stub('MemoryBuiltin')]; },
      shareImage: () => { calls.image++; return [stub('ShareImage')]; },
      pluginTools: [stub('ScanCode')],
      toolDeferral: {
        toolOwner: new Map([['ScanCode', 'security-scan']]),
        toolDeferLoading: new Set(['ScanCode']),
        planSafeToolNames: new Set(),
        builtinDeferLoading: [],
      },
      toolSearch: (deferred) => { calls.search++; return [toolSearchTool(createToolSearchHandle(deferred))]; },
    });

    expect(calls).toEqual({ memory: 1, search: 1, image: 1 });
    expect(composed.map((tool) => tool.name)).toEqual([
      'MemoryBuiltin', 'ToolSearch', 'ShareImage', 'ScanCode', 'ExitPlanMode',
    ]);
  });

  it('does not activate a deferred plugin tool forbidden to the acting sender', async () => {
    const discord = stub('DiscordCreateChannel');
    const { composed, handle } = composeWithPolicy([discord], { defaults: ['DiscordCreateChannel'] });
    handle!.session = sessionFrom(composed, composed.map((tool) => tool.name).filter((name) => !handle!.deferred.has(name)));
    const search = composed.find((tool) => tool.name === 'ToolSearch')!;

    await runWithPolicy(accessPolicy, () => search.execute(
      'id', { query: 'select:DiscordCreateChannel' }, undefined, undefined, {} as never,
    ), { toolPolicy: { deny: new Set(['DiscordCreateChannel']) } });

    expect(handle!.activated.has('DiscordCreateChannel')).toBe(false);
    expect(handle!.session.getActiveToolNames()).not.toContain('DiscordCreateChannel');
  });

  it('below the threshold nothing is deferred and no ToolSearch tool is composed', () => {
    const few = [...nativeCore, ...Array.from({ length: 4 }, (_, i) => stub(`mcp__x__op_${i}`))];
    const { composed, handle } = composeWithPolicy(few);
    expect(handle).toBeUndefined();
    expect(composed.map((tool) => tool.name)).not.toContain('ToolSearch');
  });
});
