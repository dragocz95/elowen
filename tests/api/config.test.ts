import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { makeTestApp } from '../helpers/testApp.js';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { brainLimitsPatchSchema, runtimeLimitsPatchSchema, memoryRetentionPatchSchema } from '../../src/api/schemas/config.js';
import { buildToolDeferralCatalog, type ToolDeferralGroup } from '../../src/api/routes/config.js';
import { resolveToolDeferralDecisions } from '../../src/brain/toolSearch/deferralPolicy.js';
import { PluginRegistry } from '../../src/plugins/registry.js';

const put = (token: string, body: unknown) => ({
  method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// review-api-store-sol, finding 7: the old `await c.req.json() as ConfigPatch` cast let a malformed
// value through unvalidated. A Zod schema at the boundary now rejects the hostile shapes with a 400
// instead of persisting them (where e.g. a non-string modelNotes value later crashed modelsBlock()).
describe('PUT /config validates the patch at the trust boundary', () => {
  it('rejects a non-string modelNotes value with a 400', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { modelNotes: { sonnet: 7 } }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('modelNotes');
  });

  // A key the schema does not declare is STRIPPED by Zod, not rejected — the request answers 200 and
  // the value silently never reaches the config. That is how the web-push contact stayed empty after a
  // successful-looking save, so this asserts the round trip, not the status code.
  it('persists webPushContact through the patch', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { webPushContact: 'https://build.example.com' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { webPushContact?: string };
    expect(body.webPushContact).toBe('https://build.example.com');
  });

  // The LSP extraction moved this flag into the lsp plugin's own slice. Dropping it from the schema
  // would have made a legacy write answer 200 and change NOTHING (unknown keys are stripped, as the
  // webPushContact case above documents) — the caller would believe diagnostics were off.
  it('rejects the retired lspEnabled instead of silently dropping it, and names its new home', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { lspEnabled: false }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('/plugins/lsp/config');
  });

  it('rejects a non-string allowedExecs element with a 400', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { allowedExecs: ['sonnet', 42] }));
    expect(res.status).toBe(400);
  });

  it('rejects a malformed customModels entry with a 400', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { customModels: [{ label: 'ok', exec: 7 }] }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-string plugins.enabled element with a 400', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { plugins: { enabled: ['files', null] } }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-string autopilot field with a 400', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { autopilot: { model: 123 } }));
    expect(res.status).toBe(400);
  });

  it('still accepts a well-formed patch (no regression)', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, {
      allowedExecs: ['sonnet'], modelNotes: { sonnet: 'good at code' },
      customModels: [{ label: 'Mine', exec: 'my/model' }], plugins: { enabled: ['files'] },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { allowedExecs: string[]; modelNotes: Record<string, string> };
    expect(body.allowedExecs).toEqual(['sonnet']);
    expect(body.modelNotes.sonnet).toBe('good at code');
  });
});

// A field present in a store's default shape but missing from its patch schema is stripped by Zod
// before ConfigStore.update ever sees it: the route answers 200, clampBrainLimits falls through to the
// old stored value, and the save silently does nothing (this is exactly how memoryLiveRecallPasses/
// Count/Chars went missing from brainLimitsPatchSchema). ConfigStore's own default shape — not a
// hand-maintained list — is the source of truth, so adding a knob to the store without adding it here
// fails this test instead of shipping a silently no-op setting.
describe('patch schemas accept exactly the store defaults\u2019 keys', () => {
  it('brainLimitsPatchSchema matches ConfigStore\u2019s brain.limits shape', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(Object.keys(brainLimitsPatchSchema.shape).filter((key) => key !== 'memoryLiveRecallChars').sort())
      .toEqual(Object.keys(cs.get().brain.limits).sort());
  });

  it('migrates a legacy live-recall patch from an already-open client', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, {
      brain: { limits: { memoryLiveRecallPasses: 10, memoryLiveRecallCount: 10, memoryLiveRecallChars: 20_000 } },
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as { brain: { limits: Record<string, number> } };
    expect(body.brain.limits.memoryLiveRecallCount).toBe(2);
    expect(body.brain.limits.memoryLiveRecallBytes).toBe(20_000);
    expect(body.brain.limits).not.toHaveProperty('memoryLiveRecallChars');
  });

  it('runtimeLimitsPatchSchema matches ConfigStore\u2019s runtime.limits shape', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(Object.keys(runtimeLimitsPatchSchema.shape).sort()).toEqual(Object.keys(cs.get().runtime.limits).sort());
  });

  it('memoryRetentionPatchSchema matches ConfigStore\u2019s memoryRetention shape', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(Object.keys(memoryRetentionPatchSchema.shape).sort()).toEqual(Object.keys(cs.get().runtime.memoryRetention).sort());
  });
});

describe('GET /config/tool-deferral', () => {
  const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  it('returns effective modes from the shared policy and preserves security locks', async () => {
    const { app, token, deps } = await makeTestApp({});
    deps.config.update({
      runtime: {
        toolDeferralOverrides: {
          sources: { builtin: 'deferred' },
          tools: { builtin: { EditImage: 'immediate' } },
        },
      },
    });

    const res = await app.request('/config/tool-deferral', auth(token));
    expect(res.status).toBe(200);
    const groups = await res.json() as ToolDeferralGroup[];
    expect(groups.at(-1)?.sourceId).toBe('builtin');

    const candidates = groups.flatMap((group) => group.tools.map((tool) => ({
      name: tool.name,
      sourceId: group.sourceId,
      planSafe: tool.lockedReason === 'plan-safe',
      defaultDeferred: tool.defaultMode === 'deferred',
    })));
    const expected = new Map(resolveToolDeferralDecisions(candidates, deps.config.get().runtime.toolDeferralOverrides, {
      enabled: deps.config.get().runtime.toolDeferralEnabled,
      threshold: deps.config.get().runtime.limits.toolDeferThreshold,
    }).map((decision) => [decision.name, decision]));
    for (const group of groups) {
      for (const tool of group.tools) {
        expect({ name: tool.name, effective: tool.effective, reason: tool.reason }).toEqual(expected.get(tool.name));
      }
    }

    const builtin = groups.find((group) => group.sourceId === 'builtin')!;
    const pinned = builtin.tools.find((tool) => tool.name === 'ElowenCreateTask')!;
    expect(pinned).toMatchObject({ eligible: false, lockedReason: 'never-defer', effective: 'immediate', reason: 'never-defer' });
    expect(builtin.tools.find((tool) => tool.name === 'EditImage')).toMatchObject({ override: 'immediate', effective: 'immediate', reason: 'tool-override' });
    expect(builtin.tools.find((tool) => tool.name === 'GenerateImage')).toMatchObject({ defaultMode: 'deferred', effective: 'deferred', reason: 'source-override' });
  });

  it('marks plugin plan-safe tools locked even when every configurable layer requests deferral', () => {
    const registry = new PluginRegistry();
    const ctx = registry.contextFor('discord', {}, { info() {}, warn() {}, error() {} });
    for (const name of ['DiscordCreateChannel', 'DiscordApi', 'DiscordReadOnly']) {
      ctx.registerTool(defineTool({
        name,
        label: name,
        description: `${name} operation`,
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
      }));
    }
    registry.toolDeferLoading.add('DiscordCreateChannel');
    registry.toolPlanSafe.add('DiscordReadOnly');
    const config = new ConfigStore(openDb(':memory:'));
    config.update({
      runtime: {
        toolDeferralOverrides: {
          sources: { 'plugin:discord': 'deferred' },
          tools: {
            'plugin:discord': { DiscordApi: 'immediate', DiscordReadOnly: 'deferred' },
          },
        },
      },
    });

    const group = buildToolDeferralCatalog(registry, config.get().runtime).find((item) => item.sourceId === 'plugin:discord')!;
    expect(group).toMatchObject({ kind: 'plugin', override: 'deferred' });
    expect(group.tools.find((tool) => tool.name === 'DiscordCreateChannel')).toMatchObject({ defaultMode: 'deferred', effective: 'deferred', reason: 'source-override' });
    expect(group.tools.find((tool) => tool.name === 'DiscordApi')).toMatchObject({ override: 'immediate', effective: 'immediate', reason: 'tool-override' });
    expect(group.tools.find((tool) => tool.name === 'DiscordReadOnly')).toMatchObject({ eligible: false, lockedReason: 'plan-safe', effective: 'immediate', reason: 'plan-safe' });
  });

  // image-gen/image-edit are marketplace plugins, not PI built-ins: when installed, their tool must stay
  // under plugin:<owner> with the core deferred default (BUILTIN_TOOL_DEFER_LOADING), matching the runtime —
  // never duplicated into the builtin fallback group. Test registries in makeTestApp don't carry image-gen,
  // so this only reproduces with the plugin actually registered.
  it('keeps an installed image tool under its plugin source with the core deferred default, not duplicated as builtin', () => {
    const registry = new PluginRegistry();
    const ctx = registry.contextFor('image-gen', {}, { info() {}, warn() {}, error() {} });
    ctx.registerTool(defineTool({
      name: 'GenerateImage',
      label: 'Generate image',
      description: 'Generate an image',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
    }));
    const config = new ConfigStore(openDb(':memory:'));

    const groups = buildToolDeferralCatalog(registry, config.get().runtime);
    const imageGroup = groups.find((group) => group.sourceId === 'plugin:image-gen');
    expect(imageGroup).toMatchObject({ kind: 'plugin' });
    expect(imageGroup!.tools.find((tool) => tool.name === 'GenerateImage'))
      .toMatchObject({ defaultMode: 'deferred', effective: 'deferred' });
    // Not duplicated into the builtin fallback group.
    const builtin = groups.find((group) => group.sourceId === 'builtin');
    expect(builtin?.tools.some((tool) => tool.name === 'GenerateImage')).toBe(false);
  });

  it('rejects a non-admin token', async () => {
    const { app, token } = await makeTestApp({});
    const created = await app.request('/users', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'reader', password: 'reader-pass' }),
    });
    expect(created.status).toBe(201);
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'reader', password: 'reader-pass' }),
    });
    const body = await login.json() as { token: string };

    expect((await app.request('/config/tool-deferral', auth(body.token))).status).toBe(403);
  });
});
