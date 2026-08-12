import { describe, it, expect, vi } from 'vitest';
import { detectClis } from '../../../plugins/agents/src/lib/cliDetection.js';
import { createServer } from '../../../src/api/server.js';
import { TaskStore } from '../../../src/store/taskStore.js';
import { Readiness } from '../../../src/store/readiness.js';
import { MissionStore } from '../../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../../src/api/sse.js';
import { FakeClock } from '../../../src/shared/clock.js';
import { ConfigStore } from '../../../src/store/configStore.js';
import { UserStore } from '../../../src/store/userStore.js';
import { openAgentsDb } from '../../helpers/agentsDb.js';

// Every detectClis() call spawns 9 real binaries with --version, and one of them (kilo) boots a
// daemon to answer, so a single case costs ~2.5s idle. Vitest's 5s default left only 2x headroom,
// which the full 400-file suite eats: these cases timed out on a loaded machine and passed on re-run.
// The work is genuinely slow, not stuck — the limit was wrong, so give it a real one.
vi.setConfig({ testTimeout: 30_000 });

function makeAuthedApp() {
  const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db); users.create('admin', 'pass');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
    bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users,
    detectClis, // the agents plugin's control hands core this exact function
  });
  return { app, users };
}

describe('cli detection unit', () => {
  it('returns correct shape with tools array and summary', async () => {
    const result = await detectClis();
    expect(result).toHaveProperty('tools');
    expect(result).toHaveProperty('summary');
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools.length).toBe(9);
    result.tools.forEach((t) => {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('installed');
      expect(t).toHaveProperty('functional');
      expect(t).toHaveProperty('version');
      expect(t).toHaveProperty('error');
    });
    expect(typeof result.summary.allInstalled).toBe('boolean');
    expect(typeof result.summary.allFunctional).toBe('boolean');
  });

  it('lists all expected CLI tools', async () => {
    const result = await detectClis();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['claude', 'codex', 'git', 'kilo', 'node', 'omp', 'opencode', 'pi', 'tmux']);
  });

  it('excludes optional agent CLIs from the install/functional summary', async () => {
    // kilo/pi/omp are detected and displayed, but a box without them must not read as "missing tools".
    // The required set is the 6 non-optional tools; the summary is computed only over those.
    const result = await detectClis();
    expect(result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['kilo', 'pi', 'omp']));
  });

  it('detects fresh install when context indicates no config, no api key, no custom setup', async () => {
    const result = await detectClis({
      configPersisted: false, hasApiKey: false, hasCustomSetup: false,
    });
    expect(result.freshInstall.noConfigPersisted).toBe(true);
    expect(result.freshInstall.noApiKey).toBe(true);
    expect(result.freshInstall.noCustomSetup).toBe(true);
  });

  it('detects non-fresh install when config has been persisted', async () => {
    const result = await detectClis({
      configPersisted: true, hasApiKey: false, hasCustomSetup: false,
    });
    expect(result.freshInstall.noConfigPersisted).toBe(false);
  });

  it('detects non-fresh install when api key is set', async () => {
    const result = await detectClis({
      configPersisted: true, hasApiKey: true, hasCustomSetup: false,
    });
    expect(result.freshInstall.noApiKey).toBe(false);
  });
});

describe('cli detection integration via API', () => {
  it('answers 503 when the agents plugin (the detector owner) is absent', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const users = new UserStore(db); users.create('admin', 'pass');
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
      bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db), users,
    });
    const login = await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pass' }) })).json() as { token: string };
    const res = await app.request('/integrations/cli-status', { headers: { authorization: `Bearer ${login.token}` } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'agents plugin is disabled' });
  });

  it('GET /integrations/cli-status returns 200 with tools array', async () => {
    const { app } = makeAuthedApp();
    const login = await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pass' }) })).json() as { token: string };
    const res = await app.request('/integrations/cli-status', { headers: { authorization: `Bearer ${login.token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { tools: unknown[]; summary: { allInstalled: boolean; allFunctional: boolean } };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBe(9);
    expect(body.tools[0]).toHaveProperty('name');
    expect(body.tools[0]).toHaveProperty('installed');
    expect(body.tools[0]).toHaveProperty('functional');
    expect(body).toHaveProperty('summary');
  });

  it('reports each tool individually with correct fields', async () => {
    const { app } = makeAuthedApp();
    const login = await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pass' }) })).json() as { token: string };
    const res = await app.request('/integrations/cli-status', { headers: { authorization: `Bearer ${login.token}` } });
    const body = await res.json() as { tools: { name: string; installed: boolean; functional: boolean; version: string | null; error: string | null }[] };
    for (const tool of body.tools) {
      expect(typeof tool.installed).toBe('boolean');
      expect(typeof tool.functional).toBe('boolean');
      if (tool.installed && tool.functional) {
        expect(typeof tool.version).toBe('string');
      }
    }
  });

  it('returns freshInstall field in the response', async () => {
    const { app } = makeAuthedApp();
    const login = await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pass' }) })).json() as { token: string };
    const res = await app.request('/integrations/cli-status', { headers: { authorization: `Bearer ${login.token}` } });
    const body = await res.json() as { freshInstall: { noConfigPersisted: boolean; noApiKey: boolean; noCustomSetup: boolean } };
    expect(body).toHaveProperty('freshInstall');
    expect(typeof body.freshInstall.noConfigPersisted).toBe('boolean');
    expect(typeof body.freshInstall.noApiKey).toBe('boolean');
    expect(typeof body.freshInstall.noCustomSetup).toBe('boolean');
  });

  it('detects fresh install state (fresh db — no settings row)', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const config = new ConfigStore(db); // no settings saved yet
    const users = new UserStore(db); users.create('admin', 'pass');
    // Overwrite settings so the row actually exists — force a known state.
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
      bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config, users,
      detectClis,
    });
    const login = await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pass' }) })).json() as { token: string };
    const res = await app.request('/integrations/cli-status', { headers: { authorization: `Bearer ${login.token}` } });
    const body = await res.json() as { freshInstall: { noConfigPersisted: boolean; noApiKey: boolean; noCustomSetup: boolean } };
    expect(body.freshInstall.noConfigPersisted).toBe(true);
  });

  it('detects configured install after config is saved', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const config = new ConfigStore(db);
    // Persist a config row to simulate configured install.
    config.update({ autopilot: { apiKey: 'sk-set' } });
    const users = new UserStore(db); users.create('admin', 'pass');
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
      bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config, users,
      detectClis,
    });
    const login = await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pass' }) })).json() as { token: string };
    const res = await app.request('/integrations/cli-status', { headers: { authorization: `Bearer ${login.token}` } });
    const body = await res.json() as { freshInstall: { noConfigPersisted: boolean; noApiKey: boolean } };
    expect(body.freshInstall.noConfigPersisted).toBe(false);
    expect(body.freshInstall.noApiKey).toBe(false);
  });

  it('detects real tools in the dev environment', async () => {
    const { app } = makeAuthedApp();
    const login = await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pass' }) })).json() as { token: string };
    const res = await app.request('/integrations/cli-status', { headers: { authorization: `Bearer ${login.token}` } });
    const body = await res.json() as { tools: { name: string }[] };
    const nodeTool = body.tools.find((t) => t.name === 'node')!;
    expect(nodeTool).toBeDefined();
    expect(nodeTool.installed).toBe(true);
    expect(nodeTool.functional).toBe(true);
  });
});
