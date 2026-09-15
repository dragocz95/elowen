import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { LiveSessionSpawner } from '../../src/brain/service/spawner.js';
import { inMemoryModelRuntime, type BrainRuntimeConfig } from '../../src/brain/providers.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type { Policy } from '../../src/plugins/policy.js';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { BrainStore } from '../../src/store/brainStore.js';
import type { RuntimeConfig } from '../../src/store/configStore.js';
import type { ToolDeferralOverrides } from '../../src/shared/wireContract.js';
import { BUILTIN_TOOL_DEFER_LOADING } from '../../src/brain/tools/index.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';

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

function makeSpawner(
  registry: PluginRegistry,
  runtimeConfig?: () => RuntimeConfig,
  config: BrainRuntimeConfig = {
    providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://relay.example/v1', models: ['gpt-5'], apiKey: 'k' }],
  },
  modelRuntime: ModelRuntime = sharedRuntime,
) {
  const fakeSession = { sessionId: 'sess-1', subscribe: () => () => {} };
  const create = vi.fn(async () => ({
    session: fakeSession as unknown as AgentSession,
    applyCompaction: vi.fn(),
  }));
  const spawner = new LiveSessionSpawner({
    config,
    store: new BrainStore(openDb(':memory:')),
    runtime: modelRuntime,
    users: { ensureAdvisorToken: () => 'token', get: () => ({ name: 'Filip', username: 'filip' }) },
    toolAuthorityFor: () => undefined,
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
      autoCompact: false,
    }),
  };
}

/** A minimal stand-in for one of the two tools the code-mode plugin composes. */
function pairTool(name: string): ToolDefinition {
  return defineTool({
    name, label: name, description: `${name} tool`, parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
  }) as ToolDefinition;
}

/** A ChatGPT-account provider on a code-mode capable model, with the operator switch on or off. */
const codexConfig = (codeModeEnabled: boolean): BrainRuntimeConfig => ({
  providers: [{
    id: 'chatgpt', label: 'ChatGPT', type: 'oauth-openai-codex' as const,
    baseUrl: '', models: ['gpt-5.6-luna'], apiKey: null, codeModeEnabled,
  }],
});

const factoryTools = (create: ReturnType<typeof vi.fn>) => {
  const spec = create.mock.calls.at(-1)?.[0] as { tools: ToolDefinition[] };
  return spec.tools;
};

const factoryToolNames = (create: ReturnType<typeof vi.fn>): string[] =>
  factoryTools(create).map((tool) => tool.name);

describe('LiveSessionSpawner — deferred-tool policy from the runtime config', () => {
  it('flows the bundled-plugin and two core defaults from manifests through the spawned handle', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-deferral-defaults-'));
    const db = openDb(':memory:');
    try {
      const registry = await loadPlugins({
        dirs: [join(process.cwd(), 'plugins')],
        // The chat adapters and cronjob that used to supply most of these defaults now live in the plugin
        // registry, leaving mcp as the only bundled plugin whose manifest still declares `deferLoading`.
        // What this test is about is the PATH — a manifest's `deferLoading` reaching the spawned handle —
        // so one real declaring plugin carries it; naming a plugin that is no longer bundled would not,
        // since the loader just skips it and the assertions would quietly rest on the rest.
        enabled: ['mcp'],
        dataRoot,
        pluginDb: (plugin) => makePluginDb(db, plugin, { canMigrate: true }),
        delegatedTurnsOutOfProcess: () => false,
        logger: { info() {}, warn() {}, error() {} },
      });
      expect(registry.toolDeferLoading.size).toBeGreaterThan(0);
      expect(BUILTIN_TOOL_DEFER_LOADING).toEqual(['GenerateImage', 'EditImage']);

      addTool(registry, 'image-gen', 'GenerateImage');
      addTool(registry, 'image-edit', 'EditImage');
      const { spawn } = makeSpawner(registry, () => runtime(100));
      const deferred = (await spawn()).toolSearch?.deferred;

      expect(deferred).toBeDefined();
      // The manifest-declared set plus the two core defaults, stated as a relation rather than a
      // literal count: what must hold is that nothing is dropped on the way to the handle.
      expect(deferred).toEqual(new Set([
        ...registry.toolDeferLoading,
        'GenerateImage',
        'EditImage',
      ]));
      expect(deferred?.size).toBe(registry.toolDeferLoading.size + 2);
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

  it('composes no tool search at all for a code-mode session, and withholds nothing from the script API', async () => {
    const registry = registryWithMcpTools(6);
    // A stand-in for the code-mode plugin's control: it only has to exist and report what core handed it.
    // Six MCP tools over a threshold of five are exactly what tool search would withhold, which is what
    // makes the two spawns below comparable.
    let composed: { name: string; deferred: boolean }[] = [];
    registry.contextFor('code-mode', {}, { info() {}, warn() {}, error() {} })
      .registerControl('codeMode', {
        compose: (request: { nested: { name: string; deferred: boolean }[] }) => {
          composed = request.nested.map((tool) => ({ name: tool.name, deferred: tool.deferred }));
          return [pairTool('exec'), pairTool('wait')];
        },
        // The registry verifies the WHOLE contract before handing a control out, so the stub carries
        // every method the key promises (KNOWN_CONTROL_METHODS.codeMode).
        shutdownSession: () => {},
        activeCount: () => 0,
      } as never);

    const withCodeMode = makeSpawner(registry, () => runtime(5), codexConfig(true));
    const live = await withCodeMode.spawn();
    expect(live.toolSearch).toBeUndefined();
    const names = factoryToolNames(withCodeMode.create);
    expect(names).toEqual(expect.arrayContaining(['exec', 'wait']));
    expect(names).not.toContain('ToolSearch');
    expect((withCodeMode.create.mock.calls.at(-1)?.[0] as { hostedToolSearch?: unknown }).hostedToolSearch).toBeUndefined();
    // The same predicate also selects Codex's request shape, so the tool surface and the wire arrangement
    // can never disagree.
    expect((withCodeMode.create.mock.calls.at(-1)?.[0] as { codexDeveloperPlacement?: unknown }).codexDeveloperPlacement).toBe(true);
    // The prize: the tools that WOULD have been withheld reach the script API undeferred, so the exec
    // catalogue declares their full signature instead of hiding them behind a search the model cannot use.
    expect(composed.filter((tool) => tool.deferred)).toEqual([]);
    expect(composed.map((tool) => tool.name)).toEqual(expect.arrayContaining(['mcp__github__op_0', 'mcp__github__op_5']));

    // The same account with the switch off keeps the provider's own hosted search, which is what put
    // `{type: 'tool_search'}` on the wire and `defer_loading` on `wait` before this change.
    const withoutCodeMode = makeSpawner(registryWithMcpTools(6), () => runtime(5), codexConfig(false));
    await withoutCodeMode.spawn();
    expect((withoutCodeMode.create.mock.calls.at(-1)?.[0] as { hostedToolSearch?: unknown }).hostedToolSearch).toBe('openai');
    expect((withoutCodeMode.create.mock.calls.at(-1)?.[0] as { codexDeveloperPlacement?: unknown }).codexDeveloperPlacement).toBe(false);
  });

  it('wires the production ToolSearch handle with plugin ownership and wildcard permission semantics', async () => {
    const registry = new PluginRegistry();
    addTool(registry, 'discord', 'DiscordCreateChannel');
    addTool(registry, 'discord', 'DiscordDeleteChannel');
    registry.toolDeferLoading.add('DiscordCreateChannel');
    registry.toolDeferLoading.add('DiscordDeleteChannel');
    const { spawn, create } = makeSpawner(registry, () => runtime(20));

    const live = await spawn();
    const handle = live.toolSearch!;
    expect(handle.pluginNames).toEqual(new Set(['DiscordCreateChannel', 'DiscordDeleteChannel']));
    const tools = factoryTools(create);
    let active = tools.map((tool) => tool.name).filter((name) => !handle.deferred.has(name));
    handle.session = {
      getAllTools: () => tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      getActiveToolNames: () => active,
      setActiveToolsByName: (names) => { active = names.filter((name) => tools.some((tool) => tool.name === name)); },
    };

    const search = tools.find((tool) => tool.name === 'ToolSearch')!;
    expect(search.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['query', 'max_results'],
      properties: { max_results: { default: 5, maximum: 25 } },
    });
    const result = await runWithPolicy(policy, () => search.execute(
      'id', { query: 'discord channel', max_results: 5 }, undefined, undefined, {} as never,
    ), {
      toolPolicy: {
        allow: new Set(['DiscordCreate*', 'ToolSearch']),
        deny: new Set(['DiscordDelete*']),
      },
    });

    expect((result.details as { matched: string[] }).matched).toEqual(['DiscordCreateChannel']);
    expect(active).toContain('DiscordCreateChannel');
    expect(active).not.toContain('DiscordDeleteChannel');
    expect(result.content[0].text).toContain('"name":"DiscordCreateChannel"');
    expect(result.content[0].text).not.toContain('DiscordDeleteChannel');
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

  it('omits local ToolSearch for GPT-5.4+ ChatGPT OAuth while keeping every application tool registered', async () => {
    const registry = registryWithMcpTools(12);
    addTool(registry, 'security-scan', 'ScanCode');
    const config: BrainRuntimeConfig = {
      providers: [{
        id: 'codex', label: 'ChatGPT', type: 'oauth-openai-codex', baseUrl: '',
        models: ['gpt-5.6-luna'], apiKey: null,
      }],
    };
    const isolatedRuntime = await inMemoryModelRuntime();
    const { spawn, create } = makeSpawner(registry, () => runtime(5), config, isolatedRuntime);

    const live = await spawn();
    const names = factoryToolNames(create);
    expect(live.toolSearch).toBeUndefined();
    expect(names).not.toContain('ToolSearch');
    expect(names).toEqual(expect.arrayContaining([
      'ScanCode',
      ...Array.from({ length: 12 }, (_, index) => `mcp__github__op_${index}`),
    ]));
    // No local handle means the factory leaves these tools active/executable; the provider module defers
    // their per-turn sender-visible wire definitions instead of removing them from PI's registry.
    const spec = create.mock.calls.at(-1)?.[0] as { toolSearch?: unknown; hostedToolSearch?: string };
    expect(spec.toolSearch).toBeUndefined();
    expect(spec.hostedToolSearch).toBe('openai');
  });

  it('omits local ToolSearch for supported Anthropic OAuth while preserving the full PI registry', async () => {
    const registry = registryWithMcpTools(12);
    addTool(registry, 'security-scan', 'ScanCode');
    const config: BrainRuntimeConfig = {
      providers: [{
        id: 'anthropic', label: 'Claude', type: 'oauth-anthropic', baseUrl: '',
        models: ['claude-opus-5'], apiKey: null,
      }],
    };
    const isolatedRuntime = await inMemoryModelRuntime();
    const { spawn, create } = makeSpawner(registry, () => runtime(5), config, isolatedRuntime);

    const live = await spawn();
    const names = factoryToolNames(create);
    expect(live.toolSearch).toBeUndefined();
    expect(names).not.toContain('ToolSearch');
    expect(names).toEqual(expect.arrayContaining([
      'ScanCode',
      ...Array.from({ length: 12 }, (_, index) => `mcp__github__op_${index}`),
    ]));
    const spec = create.mock.calls.at(-1)?.[0] as { toolSearch?: unknown; hostedToolSearch?: string };
    expect(spec.toolSearch).toBeUndefined();
    expect(spec.hostedToolSearch).toBe('anthropic');
  });
});
