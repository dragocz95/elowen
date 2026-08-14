import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { LiveSessionSpawner } from '../../src/brain/service/spawner.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type { Policy } from '../../src/plugins/policy.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import type { RuntimeConfig } from '../../src/store/configStore.js';
import type { ToolDeferralOverrides } from '../../src/shared/wireContract.js';
import { BUILTIN_TOOL_DEFER_LOADING } from '../../src/brain/tools/index.js';

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

const policy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

function addTool(registry: PluginRegistry, owner: string, name: string): void {
  const ctx = registry.contextFor(owner, {}, { info() {}, warn() {}, error() {} });
  ctx.registerTool(defineTool({
    name, label: name, description: `${name} operation`, parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
  }));
}

/** A registry holding `count` bridged MCP tools. */
function registryWithMcpTools(count: number): PluginRegistry {
  const registry = new PluginRegistry();
  for (let i = 0; i < count; i++) addTool(registry, 'mcp', `mcp__github__op_${i}`);
  return registry;
}

function runtime(
  threshold: number,
  enabled = true,
  toolDeferralOverrides?: ToolDeferralOverrides,
): RuntimeConfig {
  return {
    limits: { localShellTimeoutMs: 30_000, memorySemanticFloorPerMille: 300, toolDeferThreshold: threshold, eventRetentionDays: 30 },
    toolDeferralEnabled: enabled,
    ...(toolDeferralOverrides ? { toolDeferralOverrides } : {}),
  } as RuntimeConfig;
}

function makeSpawner(registry: PluginRegistry, runtimeConfig?: () => RuntimeConfig) {
  const fakeSession = { sessionId: 'sess-1', subscribe: () => () => {} };
  const create = vi.fn(async () => ({
    session: fakeSession as unknown as AgentSession,
    applyCompaction: vi.fn(),
  }));
  const spawner = new LiveSessionSpawner({
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://relay.example/v1', models: ['gpt-5'], apiKey: 'k' }] },
    store: new BrainStore(openDb(':memory:')),
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'token', get: () => ({ name: 'Filip', username: 'filip' }) },
    prompts: { render: () => 'PERSONA' },
    url: 'http://x',
    plugins: async () => registry,
    factory: { create },
    sessionTaps: () => [],
    ...(runtimeConfig ? { runtimeConfig } : {}),
  });
  return {
    create,
    spawn: () => spawner.spawn({
      sessionId: 'sess-1', ownerUserId: 1, selection: {}, policy,
      autoCompact: false, autoCompactAtPct: 80,
    }),
  };
}

const factoryToolNames = (create: ReturnType<typeof vi.fn>): string[] => {
  const spec = create.mock.calls.at(-1)?.[0] as { tools: { name: string }[] };
  return spec.tools.map((tool) => tool.name);
};

describe('LiveSessionSpawner — deferred-tool policy from the runtime config', () => {
  it('flows all 31 bundled-plugin and two core defaults from manifests through the spawned handle', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-deferral-defaults-'));
    try {
      const registry = await loadPlugins({
        dirs: [join(process.cwd(), 'plugins')],
        enabled: ['cronjob', 'discord', 'mcp'],
        config: { discord: { botToken: 'test-token' } },
        dataRoot,
        delegatedTurnsOutOfProcess: () => false,
        logger: { info() {}, warn() {}, error() {} },
      });
      expect(registry.toolDeferLoading.size).toBe(31);
      expect(BUILTIN_TOOL_DEFER_LOADING).toEqual(['GenerateImage', 'EditImage']);

      addTool(registry, 'image-gen', 'GenerateImage');
      addTool(registry, 'image-edit', 'EditImage');
      const { spawn } = makeSpawner(registry, () => runtime(100));
      const deferred = (await spawn()).toolSearch?.deferred;

      expect(deferred).toBeDefined();
      expect(deferred?.size).toBe(33);
      expect(deferred).toEqual(new Set([
        ...registry.toolDeferLoading,
        'GenerateImage',
        'EditImage',
      ]));
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('defers once the MCP tool count exceeds the configured threshold', async () => {
    const { spawn } = makeSpawner(registryWithMcpTools(6), () => runtime(5));
    expect((await spawn()).toolSearch?.deferred.size).toBe(6);
  });

  it('withholds nothing while the count is at or under the configured threshold', async () => {
    const { spawn } = makeSpawner(registryWithMcpTools(12), () => runtime(20));
    expect((await spawn()).toolSearch).toBeUndefined();
  });

  it('flows a plugin manifest default through composition into the factory handle without MCP tools', async () => {
    const registry = new PluginRegistry();
    addTool(registry, 'security-scan', 'ScanCode');
    registry.toolDeferLoading.add('ScanCode');
    const { spawn, create } = makeSpawner(registry, () => runtime(20));

    const live = await spawn();
    expect(live.toolSearch?.deferred).toEqual(new Set(['ScanCode']));
    expect(factoryToolNames(create)).toContain('ToolSearch');
    expect((create.mock.calls.at(-1)?.[0] as { toolSearch?: unknown }).toolSearch).toBe(live.toolSearch);
  });

  it('registers marketplace image tools and applies Elowen defaults in their plugin override namespaces', async () => {
    const registry = new PluginRegistry();
    addTool(registry, 'image-gen', 'GenerateImage');
    addTool(registry, 'image-edit', 'EditImage');

    const defaults = makeSpawner(registry, () => runtime(20));
    expect((await defaults.spawn()).toolSearch?.deferred).toEqual(new Set(['GenerateImage', 'EditImage']));
    expect(factoryToolNames(defaults.create)).toEqual(expect.arrayContaining(['GenerateImage', 'EditImage', 'ToolSearch']));

    const overrides: ToolDeferralOverrides = {
      sources: { 'plugin:image-gen': 'immediate' },
      tools: {},
    };
    const overridden = makeSpawner(registry, () => runtime(20, true, overrides));
    expect((await overridden.spawn()).toolSearch?.deferred).toEqual(new Set(['EditImage']));
  });

  it('keeps a plugin plan-safe tool immediate even when its manifest default requests deferral', async () => {
    const registry = new PluginRegistry();
    addTool(registry, 'security-scan', 'ScanCode');
    registry.toolDeferLoading.add('ScanCode');
    registry.toolPlanSafe.add('ScanCode');
    const { spawn } = makeSpawner(registry, () => runtime(5));

    expect((await spawn()).toolSearch).toBeUndefined();
  });

  it('applies owner-qualified overrides to non-MCP tools outside the old candidate set', async () => {
    const registry = new PluginRegistry();
    addTool(registry, 'security-scan', 'ScanCode');
    addTool(registry, 'discord', 'DiscordCreateChannel');
    const overrides: ToolDeferralOverrides = {
      sources: { 'plugin:security-scan': 'deferred' },
      tools: { 'plugin:discord': { DiscordCreateChannel: 'deferred' } },
    };
    const { spawn } = makeSpawner(registry, () => runtime(20, true, overrides));

    expect((await spawn()).toolSearch?.deferred).toEqual(new Set(['ScanCode', 'DiscordCreateChannel']));
  });

  it('the global switch suppresses ToolSearch even when source defaults request deferral', async () => {
    const registry = new PluginRegistry();
    addTool(registry, 'security-scan', 'ScanCode');
    registry.toolDeferLoading.add('ScanCode');
    const { spawn, create } = makeSpawner(registry, () => runtime(5, false));

    expect((await spawn()).toolSearch).toBeUndefined();
    expect(factoryToolNames(create)).not.toContain('ToolSearch');
  });

  it('falls back to the policy defaults when no runtime config is wired', async () => {
    expect((await makeSpawner(registryWithMcpTools(12)).spawn()).toolSearch?.deferred.size).toBe(12);
    expect((await makeSpawner(registryWithMcpTools(4)).spawn()).toolSearch).toBeUndefined();
  });

  it('reads overrides on every spawn, so a settings change applies without a restart', async () => {
    const registry = new PluginRegistry();
    addTool(registry, 'security-scan', 'ScanCode');
    let overrides: ToolDeferralOverrides = { sources: {}, tools: {} };
    const { spawn } = makeSpawner(registry, () => runtime(20, true, overrides));

    expect((await spawn()).toolSearch).toBeUndefined();
    overrides = { sources: {}, tools: { 'plugin:security-scan': { ScanCode: 'deferred' } } };
    expect((await spawn()).toolSearch?.deferred).toEqual(new Set(['ScanCode']));
  });
});
