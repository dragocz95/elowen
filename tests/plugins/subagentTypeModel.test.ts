import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import manifest from '../../plugins/subagent/elowen-plugin.json' with { type: 'json' };

/** Per-account model pins for the BUILT-IN sub-agent types (explore/plan/review).
 *
 *  The contract under test: a pinned type spawns on exactly its pinned provider/model, an unpinned one
 *  leaves the parent free to choose, and neither ever falls back to a substitute model in silence. */

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

const typeModel = await import(resolve(repoRoot, 'plugins/subagent/lib/typeModel.mjs')) as {
  typeModelPinKey(type: string): string;
  parseTypeModelPin(raw: unknown): { provider: string; model: string } | null;
  readTypeModelPin(ctx: unknown, agentType: string | undefined): { provider: string; model: string } | null;
  resolveTypeModel(input: {
    agentType: string;
    pin: { provider: string; model: string } | null;
    requestedModel?: unknown;
    models: { provider: string; model: string }[];
  }): { pinned?: boolean; model?: { provider: string; model: string }; error?: string };
};

const MODELS = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-sonnet-5' },
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-4' },
  { provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5' },
];

const TYPES = [
  { name: 'explore', description: 'read-only explore', source: 'builtin' as const },
  { name: 'plan', description: 'planner', source: 'builtin' as const },
  { name: 'review', description: 'reviewer', source: 'builtin' as const },
  { name: 'triage', description: 'user-defined triage', source: 'user' as const },
];

const identity = (userId: number): TurnIdentity =>
  ({ platform: 'elowen', userId: String(userId), elowenUserId: userId, admin: userId === 1, owner: true });

// ── the pure pieces ────────────────────────────────────────────────────────────────────────────────

describe('parseTypeModelPin', () => {
  it('reads a complete provider::model pair', () => {
    expect(typeModel.parseTypeModelPin('anthropic::claude-sonnet-5'))
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });

  it('keeps a model id containing separators intact', () => {
    expect(typeModel.parseTypeModelPin('openrouter::meta-llama/llama-3.1:free'))
      .toEqual({ provider: 'openrouter', model: 'meta-llama/llama-3.1:free' });
  });

  it('reads an empty value as "no pin", not as a pin on nothing', () => {
    expect(typeModel.parseTypeModelPin('')).toBeNull();
    expect(typeModel.parseTypeModelPin(undefined)).toBeNull();
    expect(typeModel.parseTypeModelPin(null)).toBeNull();
  });

  // A bare model id has no provider. Honouring it would route the child through whichever provider
  // happened to list that name — the pin would stop being an atomic route.
  it('refuses a bare model id and a half pair', () => {
    expect(typeModel.parseTypeModelPin('claude-sonnet-5')).toBeNull();
    expect(typeModel.parseTypeModelPin('::claude-sonnet-5')).toBeNull();
    expect(typeModel.parseTypeModelPin('anthropic::')).toBeNull();
  });
});

describe('resolveTypeModel', () => {
  const pin = { provider: 'anthropic', model: 'claude-opus-4' };

  it('leaves an unpinned type to the caller', () => {
    expect(typeModel.resolveTypeModel({ agentType: 'explore', pin: null, models: MODELS }))
      .toEqual({ pinned: false });
  });

  it('uses the pin when the caller omitted a model', () => {
    expect(typeModel.resolveTypeModel({ agentType: 'plan', pin, models: MODELS }))
      .toEqual({ pinned: true, model: pin });
  });

  it('accepts an explicit model that names the pin itself, in either form', () => {
    for (const requestedModel of ['anthropic/claude-opus-4', 'claude-opus-4']) {
      expect(typeModel.resolveTypeModel({ agentType: 'plan', pin, requestedModel, models: MODELS }))
        .toEqual({ pinned: true, model: pin });
    }
  });

  it('refuses a conflicting explicit model with a correctable message instead of ignoring it', () => {
    const res = typeModel.resolveTypeModel({ agentType: 'plan', pin, requestedModel: 'openai/gpt-5', models: MODELS });
    expect(res.model).toBeUndefined();
    expect(res.error).toMatch(/pinned to anthropic\/claude-opus-4/);
    expect(res.error).toMatch(/Omit `model`/);
  });

  it('fails loud when the pinned model is no longer configured — never a substitute', () => {
    const res = typeModel.resolveTypeModel({
      agentType: 'review',
      pin: { provider: 'anthropic', model: 'retired-model' },
      models: MODELS,
    });
    expect(res.model).toBeUndefined();
    expect(res.error).toMatch(/anthropic\/retired-model/);
    expect(res.error).toMatch(/\/p\/subagent/);
  });
});

describe('readTypeModelPin', () => {
  const ctxWith = (config: Record<string, unknown> | null) => ({
    subagentTypes: () => TYPES,
    userConfig: () => config,
  });

  it('reads the built-in type\'s own key', () => {
    expect(typeModel.readTypeModelPin(ctxWith({ [typeModel.typeModelPinKey('explore')]: 'openai::gpt-5' }), 'explore'))
      .toEqual({ provider: 'openai', model: 'gpt-5' });
  });

  // Custom types are deliberately untouched by this feature: their model stays the caller's choice.
  it('ignores a pin stored against a user-defined type', () => {
    expect(typeModel.readTypeModelPin(ctxWith({ [typeModel.typeModelPinKey('triage')]: 'openai::gpt-5' }), 'triage'))
      .toBeNull();
  });

  it('has no pin without an account (a system turn reads no per-account config)', () => {
    expect(typeModel.readTypeModelPin(ctxWith(null), 'explore')).toBeNull();
  });

  it('has no pin for an untyped delegation', () => {
    expect(typeModel.readTypeModelPin(ctxWith({}), undefined)).toBeNull();
  });
});

// ── the manifest that stores them ──────────────────────────────────────────────────────────────────

describe('subagent manifest pin fields', () => {
  const builtinTypeNames = readdirSync(join(repoRoot, 'prompts/agents'))
    .filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();

  it('declares one per-account model field for every shipped built-in type, and no others', () => {
    const schema = (manifest as { userConfigSchema?: { key: string; type: string }[] }).userConfigSchema ?? [];
    const pinned = schema.filter((f) => f.key.startsWith('typeModel.')).map((f) => f.key.slice('typeModel.'.length)).sort();
    expect(pinned).toEqual(builtinTypeNames);
    for (const field of schema.filter((f) => f.key.startsWith('typeModel.'))) {
      expect(field.type).toBe('model');
    }
  });
});

// ── Delegate ───────────────────────────────────────────────────────────────────────────────────────

describe('Delegate — per-account built-in type model pins', () => {
  let reg: PluginRegistry;
  let seen: { access?: Record<string, unknown> };
  /** Per-account stored plugin config, the real `user_plugin_config` shape. */
  const stored = new Map<number, Record<string, unknown>>();

  beforeAll(async () => {
    reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], logger: log,
      subagentTypes: () => TYPES,
      listModels: async () => MODELS,
      host: { userPluginConfig: (userId: number, plugin: string) => (plugin === 'subagent' ? stored.get(userId) ?? {} : {}) },
    } as unknown as Parameters<typeof loadPlugins>[0]);
    seen = {};
    reg.platforms.find((p) => p.name === 'subagent')!.listen(async (src: { access?: Record<string, unknown> }) => {
      seen.access = src.access;
      return 'child done';
    });
  });

  const delegate = (params: Record<string, unknown>, userId = 1) => {
    seen.access = undefined;
    const tool = reg.tools.find((t) => t.name === 'Delegate')!;
    return runWithPolicy(
      adminPolicy,
      () => (tool as unknown as { execute(id: string, p: unknown): Promise<{ content: { text: string }[] }> }).execute('call', params),
      { identity: identity(userId), sessionId: 'brain-1', model: { provider: 'openai', model: 'gpt-5' } },
    );
  };

  it('two accounts pin the same type to different models — an admin pin is not global', async () => {
    stored.set(1, { 'typeModel.explore': 'anthropic::claude-opus-4' });
    stored.set(2, { 'typeModel.explore': 'openai::gpt-5' });
    await delegate({ task: 'look', subagent_type: 'explore' }, 1);
    expect(seen.access?.model).toEqual({ provider: 'anthropic', model: 'claude-opus-4' });
    await delegate({ task: 'look', subagent_type: 'explore' }, 2);
    expect(seen.access?.model).toEqual({ provider: 'openai', model: 'gpt-5' });
    // An account that pinned nothing keeps inheriting the parent turn.
    stored.delete(3);
    await delegate({ task: 'look', subagent_type: 'explore' }, 3);
    expect(seen.access?.model).toEqual({ provider: 'openai', model: 'gpt-5' });
    stored.clear();
  });

  describe('with no pin', () => {
    it('inherits the parent model when `model` is omitted', async () => {
      await delegate({ task: 'look', subagent_type: 'explore' });
      expect(seen.access?.model).toEqual({ provider: 'openai', model: 'gpt-5' });
    });

    it('lets the parent pick any configured model for the task', async () => {
      await delegate({ task: 'look', subagent_type: 'explore', model: 'anthropic/claude-sonnet-5' });
      expect(seen.access?.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    });
  });

  describe('with a pin', () => {
    beforeAll(() => { stored.set(1, { 'typeModel.plan': 'anthropic::claude-opus-4' }); });

    it('spawns an omitted-model typed delegation on the pinned model', async () => {
      await delegate({ task: 'design it', subagent_type: 'plan' });
      expect(seen.access?.model).toEqual({ provider: 'anthropic', model: 'claude-opus-4' });
    });

    it('accepts an explicit model that names the pin', async () => {
      await delegate({ task: 'design it', subagent_type: 'plan', model: 'anthropic/claude-opus-4' });
      expect(seen.access?.model).toEqual({ provider: 'anthropic', model: 'claude-opus-4' });
    });

    it('refuses a conflicting explicit model and never spawns the child', async () => {
      const res = await delegate({ task: 'design it', subagent_type: 'plan', model: 'openai/gpt-5' });
      expect(res.content[0]!.text).toMatch(/pinned to anthropic\/claude-opus-4/);
      expect(seen.access).toBeUndefined();
    });

    it('leaves every OTHER type alone', async () => {
      await delegate({ task: 'look', subagent_type: 'explore' });
      expect(seen.access?.model).toEqual({ provider: 'openai', model: 'gpt-5' });
      await delegate({ task: 'triage', subagent_type: 'triage' });
      expect(seen.access?.model).toEqual({ provider: 'openai', model: 'gpt-5' });
      await delegate({ task: 'plain' });
      expect(seen.access?.model).toEqual({ provider: 'openai', model: 'gpt-5' });
    });

    it('fails loud when the pinned model is gone instead of running on a substitute', async () => {
      stored.set(1, { 'typeModel.plan': 'anthropic::retired-model' });
      const res = await delegate({ task: 'design it', subagent_type: 'plan' });
      expect(res.content[0]!.text).toMatch(/\/p\/subagent/);
      expect(seen.access).toBeUndefined();
      stored.set(1, { 'typeModel.plan': 'anthropic::claude-opus-4' });
    });
  });

  // A pin governs where NEW work starts. An existing child keeps the model its session was created on,
  // so changing the pin never rewrites a conversation already in flight.
  it('DelegateContinue does not apply a pin to an existing sub-agent', async () => {
    let continued: Record<string, unknown> | undefined;
    const continueReg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], logger: log,
      subagentTypes: () => TYPES,
      listModels: async () => MODELS,
      host: { userPluginConfig: () => ({ 'typeModel.plan': 'anthropic::claude-opus-4' }) },
      delegatedChildren: {
        runs: () => [], read: () => '',
        continue: async (input: Record<string, unknown>) => { continued = input; return { status: 'reply', reply: 'ok' }; },
        stop: async () => ({ stopped: false }),
      },
    } as unknown as Parameters<typeof loadPlugins>[0]);
    const tool = continueReg.tools.find((t) => t.name === 'DelegateContinue')!;
    await runWithPolicy(
      adminPolicy,
      () => (tool as unknown as { execute(id: string, p: unknown): Promise<unknown> })
        .execute('call', { id: 'dlg-1', message: 'carry on', background: false }),
      { identity: identity(1), sessionId: 'brain-1', model: { provider: 'openai', model: 'gpt-5' } },
    );
    expect(continued).toBeTruthy();
    expect(continued!.model).toBeFalsy(); // no override: the host resumes on the session's own model
  });
});

// ── shipped guidance ───────────────────────────────────────────────────────────────────────────────

describe('shipped delegation guidance', () => {
  let reg: PluginRegistry;
  beforeAll(async () => {
    reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], logger: log,
      subagentTypes: () => TYPES, listModels: async () => MODELS,
    } as unknown as Parameters<typeof loadPlugins>[0]);
  });

  const describeOf = (name: string) => reg.tools.find((t) => t.name === name)!.description ?? '';
  const paramOf = (name: string, key: string) => {
    const tool = reg.tools.find((t) => t.name === name) as unknown as { parameters?: { properties?: Record<string, { description?: string }> } };
    return tool.parameters?.properties?.[key]?.description ?? '';
  };

  it('lets Delegate choose a model for a typed sub-agent on its own, and says a pin overrides that', () => {
    const model = paramOf('Delegate', 'model');
    expect(model).toMatch(/built-in/i);
    expect(model).toMatch(/pin/i);
    // The old rule — look a model up only when the USER asked — no longer describes an unpinned type.
    expect(model).not.toMatch(/ONLY when the user explicitly asked/);
  });

  it('the type catalog marks which types can carry a pin', () => {
    const text = describeOf('Delegate');
    expect(text).toMatch(/"explore" \[built-in\]/);
    expect(text).toMatch(/"triage" \(/);          // a user type is listed without the marker
    expect(text).not.toMatch(/"triage" \[built-in\]/);
  });

  it('DelegateModels no longer restricts the lookup to an explicit user request', () => {
    const text = describeOf('DelegateModels');
    expect(text).not.toMatch(/Consult it ONLY when the user explicitly asked/);
    expect(text).toMatch(/PINNED/);
  });

  it('a workflow node\'s model parameter carries the same rule', () => {
    // WorkflowAddNodes declares the node objects inline; WorkflowStart describes them in its file prose.
    const addNodes = reg.tools.find((t) => t.name === 'WorkflowAddNodes') as unknown as { parameters?: unknown };
    expect(JSON.stringify(addNodes.parameters ?? {})).toMatch(/pin/i);
    expect(JSON.stringify(addNodes.parameters ?? {})).toMatch(/built-in/i);
    expect(describeOf('WorkflowStart')).toMatch(/pin/i);
  });
});
