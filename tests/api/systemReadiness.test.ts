import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore, type ConfigPatch } from '../../src/store/configStore.js';

interface ReadinessCheck { id: string; label: string; ok: boolean; detail: string; hint?: string }
interface ReadinessResponse { checks: ReadinessCheck[] }

function makeApp(over: { model?: string | null; withUsers?: boolean; patch?: ConfigPatch } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const config = new ConfigStore(db);
  if (over.patch) config.update(over.patch);
  const users = over.withUsers ? new UserStore(db) : undefined;
  const adminTok = users ? users.issueToken(users.create('admin', 'pw').id) : undefined;
  const userTok = users ? users.issueToken(users.create('amy', 'pw').id) : undefined;
  // Only resolvableModel() is exercised by the route — a minimal fake stands in for BrainService.
  const brain = { resolvableModel: () => (over.model === undefined ? null : over.model) };
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
    bus: new EventBus(), engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, projects: new ProjectStore(db), users,
    brain: brain as never,
  });
  return { app, adminTok, userTok };
}

async function getChecks(app: ReturnType<typeof makeApp>['app'], tok?: string): Promise<{ status: number; body: ReadinessResponse }> {
  const res = await app.request('/system/readiness', tok ? { headers: { authorization: `Bearer ${tok}` } } : {});
  return { status: res.status, body: await res.json() as ReadinessResponse };
}

describe('GET /system/readiness', () => {
  it('returns the six checks in order', async () => {
    const { app } = makeApp({ model: 'kimi' });
    const { status, body } = await getChecks(app);
    expect(status).toBe(200);
    expect(body.checks.map((c) => c.id)).toEqual(['chat', 'tasks', 'missions', 'memory', 'platforms', 'plugins']);
  });

  it('chat: ok with the resolved model id as detail', async () => {
    const { app } = makeApp({ model: 'kimi-k2.7' });
    const { body } = await getChecks(app);
    expect(body.checks[0]).toEqual({ id: 'chat', label: 'Chat', ok: true, detail: 'kimi-k2.7' });
  });

  it('chat: not ok with no hint when no provider resolves', async () => {
    const { app } = makeApp({ model: null });
    const { body } = await getChecks(app);
    expect(body.checks[0]).toEqual({
      id: 'chat', label: 'Chat', ok: false, detail: 'no provider',
      hint: 'Run `elowen setup` to connect an AI provider.',
    });
  });

  it('tasks: ok when the embedded engine (elowen:) points at a configured provider, independent of PATH', async () => {
    const { app } = makeApp({ model: 'm', patch: {
      defaults: { exec: 'elowen:relay/kimi', autonomy: 'L3', maxSessions: 1 },
      brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['kimi'], apiKey: 'k' }] },
    } });
    const { body } = await getChecks(app);
    expect(body.checks[1]).toEqual({ id: 'tasks', label: 'Tasks', ok: true, detail: 'elowen:relay/kimi' });
  });

  it('tasks: not ok when the elowen: exec points at a provider that no longer exists', async () => {
    const { app } = makeApp({ model: 'm', patch: { defaults: { exec: 'elowen:gone/kimi', autonomy: 'L3', maxSessions: 1 } } });
    const { body } = await getChecks(app);
    expect(body.checks[1]).toEqual({
      id: 'tasks', label: 'Tasks', ok: false, detail: 'elowen:gone/kimi',
      hint: 'The provider its executor points at is gone — re-run `elowen setup`.',
    });
  });

  describe('tasks: an external agent-CLI exec depends on the resolved binary being on PATH', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    it('ok when the resolved program binary is present on PATH', async () => {
      const binDir = mkdtempSync(join(tmpdir(), 'elowen-readiness-bin-'));
      writeFileSync(join(binDir, 'pi'), '#!/bin/sh\n');
      chmodSync(join(binDir, 'pi'), 0o755);
      vi.stubEnv('PATH', binDir);
      const { app } = makeApp({ model: 'm', patch: { defaults: { exec: 'pi:some-model', autonomy: 'L3', maxSessions: 1 } } });
      const { body } = await getChecks(app);
      expect(body.checks[1]).toEqual({ id: 'tasks', label: 'Tasks', ok: true, detail: 'pi:some-model' });
    });

    it('not ok when the resolved program binary is missing from PATH', async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'elowen-readiness-empty-'));
      vi.stubEnv('PATH', emptyDir);
      const { app } = makeApp({ model: 'm', patch: { defaults: { exec: 'pi:some-model', autonomy: 'L3', maxSessions: 1 } } });
      const { body } = await getChecks(app);
      expect(body.checks[1]).toEqual({
        id: 'tasks', label: 'Tasks', ok: false, detail: 'pi:some-model',
        hint: 'The setup wizard points this at the built-in engine — re-run `elowen setup`.',
      });
    });
  });

  it('missions: ok via the autopilot relay (legacy top-level key)', async () => {
    const { app } = makeApp({ model: 'm', patch: { autopilot: { apiKey: 'sk-test' } } });
    const { body } = await getChecks(app);
    expect(body.checks[2]).toEqual({ id: 'missions', label: 'Missions', ok: true, detail: 'relay configured' });
  });

  it('missions: ok via a configured pilot CLI exec when no relay is set', async () => {
    const { app } = makeApp({ model: 'm', patch: { autopilot: { pilotExec: 'claude:sonnet' } } });
    const { body } = await getChecks(app);
    expect(body.checks[2]).toEqual({ id: 'missions', label: 'Missions', ok: true, detail: 'claude:sonnet' });
  });

  it('missions: not ok when neither the relay nor a pilot exec is configured', async () => {
    const { app } = makeApp({ model: 'm' });
    const { body } = await getChecks(app);
    expect(body.checks[2]).toEqual({
      id: 'missions', label: 'Missions', ok: false, detail: 'not set',
      hint: 'Missions need an OpenAI-compatible key or an installed agent CLI.',
    });
  });

  it('memory: ok with the configured model as detail when an embedding provider is set', async () => {
    const { app } = makeApp({ model: 'm', patch: { embedding: { providerId: 'relay', model: 'text-embed-1', baseUrl: '', dimensions: null } } });
    const { body } = await getChecks(app);
    expect(body.checks[3]).toEqual({ id: 'memory', label: 'Memory', ok: true, detail: 'text-embed-1' });
  });

  it('memory: ok but "enabled" as detail when a provider is set without a model', async () => {
    const { app } = makeApp({ model: 'm', patch: { embedding: { providerId: 'relay', model: '', baseUrl: '', dimensions: null } } });
    const { body } = await getChecks(app);
    expect(body.checks[3]).toEqual({ id: 'memory', label: 'Memory', ok: true, detail: 'enabled' });
  });

  it('memory: always ok (optional feature) but flagged "disabled (optional)" with a hint when unset — the fresh-install default', async () => {
    const { app } = makeApp({ model: 'm' });
    const { body } = await getChecks(app);
    expect(body.checks[3]).toEqual({
      id: 'memory', label: 'Memory', ok: true, detail: 'disabled (optional)',
      hint: 'Optional — enable memory in `elowen setup` or Settings → Brain.',
    });
  });

  it('platforms: always ok; lists enabled messaging plugins, else "none"', async () => {
    let { app } = makeApp({ model: 'm' });
    let { body } = await getChecks(app);
    expect(body.checks[4]).toEqual({
      id: 'platforms', label: 'Platforms', ok: true, detail: 'none',
      hint: 'Connect Discord, WhatsApp or Telegram in Settings → Plugins.',
    });

    ({ app } = makeApp({ model: 'm', patch: { plugins: { enabled: ['files', 'discord', 'whatsapp'], removed: [] } } }));
    ({ body } = await getChecks(app));
    expect(body.checks[4]).toEqual({
      id: 'platforms', label: 'Platforms', ok: true, detail: 'discord, whatsapp',
      hint: 'Connect Discord, WhatsApp or Telegram in Settings → Plugins.',
    });
  });

  it('plugins: always ok; lists the enabled tool plugins as a comma list, else "none"', async () => {
    const { app } = makeApp({ model: 'm', patch: { plugins: { enabled: ['files', 'terminal'], removed: [] } } });
    const { body } = await getChecks(app);
    expect(body.checks[5]).toEqual({ id: 'plugins', label: 'Plugins', ok: true, detail: 'files, terminal' });
  });

  it('plugins: "none" when nothing is enabled', async () => {
    const { app } = makeApp({ model: 'm', patch: { plugins: { enabled: [], removed: [] } } });
    const { body } = await getChecks(app);
    expect(body.checks[5]).toEqual({ id: 'plugins', label: 'Plugins', ok: true, detail: 'none' });
  });

  describe('admin gating (mirrors the other /system/* routes)', () => {
    it('is open (no gating) on an ungated daemon (no users store)', async () => {
      const { app } = makeApp({ model: 'm' });
      expect((await getChecks(app)).status).toBe(200);
    });

    it('requires auth once users exist (401 with no token)', async () => {
      const { app } = makeApp({ model: 'm', withUsers: true });
      expect((await getChecks(app)).status).toBe(401);
    });

    it('forbids a non-admin token (403)', async () => {
      const { app, userTok } = makeApp({ model: 'm', withUsers: true });
      expect((await getChecks(app, userTok)).status).toBe(403);
    });

    it('allows the admin token (200)', async () => {
      const { app, adminTok } = makeApp({ model: 'm', withUsers: true });
      expect((await getChecks(app, adminTok)).status).toBe(200);
    });
  });
});
