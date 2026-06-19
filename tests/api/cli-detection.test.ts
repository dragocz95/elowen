import { describe, it, expect, vi } from 'vitest';
import { detectClis } from '../../src/integrations/cliDetection.js';
import { createServer } from '../../src/api/server.js';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';

function makeAuthedApp() {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db); users.create('admin', 'pass');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
    bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users,
  });
  return { app, users };
}

describe('cli detection unit', () => {
  it('returns correct shape with tools array and summary', () => {
    const result = detectClis();
    expect(result).toHaveProperty('tools');
    expect(result).toHaveProperty('summary');
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools.length).toBe(6);
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

  it('lists all expected CLI tools', () => {
    const result = detectClis();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['claude', 'codex', 'git', 'node', 'opencode', 'tmux']);
  });

  it('detects fresh install when context indicates no config, no api key, no custom setup', () => {
    const result = detectClis({
      configPersisted: false, hasApiKey: false, hasCustomSetup: false,
      userCount: 0, projectCount: 0,
    });
    expect(result.freshInstall.noConfigPersisted).toBe(true);
    expect(result.freshInstall.noApiKey).toBe(true);
    expect(result.freshInstall.noCustomSetup).toBe(true);
  });

  it('detects non-fresh install when config has been persisted', () => {
    const result = detectClis({
      configPersisted: true, hasApiKey: false, hasCustomSetup: false,
      userCount: 1, projectCount: 1,
    });
    expect(result.freshInstall.noConfigPersisted).toBe(false);
  });

  it('detects non-fresh install when api key is set', () => {
    const result = detectClis({
      configPersisted: true, hasApiKey: true, hasCustomSetup: false,
      userCount: 0, projectCount: 0,
    });
    expect(result.freshInstall.noApiKey).toBe(false);
  });
});

describe('cli detection integration via API', () => {
  it('GET /integrations/cli-status returns 200 with tools array', async () => {
    const { app } = makeAuthedApp();
    const login = await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pass' }) })).json() as { token: string };
    const res = await app.request('/integrations/cli-status', { headers: { authorization: `Bearer ${login.token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { tools: unknown[]; summary: { allInstalled: boolean; allFunctional: boolean } };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBe(6);
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
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const config = new ConfigStore(db); // no settings saved yet
    const users = new UserStore(db); users.create('admin', 'pass');
    // Overwrite settings so the row actually exists — force a known state.
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
      bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config, users,
    });
    const login = await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pass' }) })).json() as { token: string };
    const res = await app.request('/integrations/cli-status', { headers: { authorization: `Bearer ${login.token}` } });
    const body = await res.json() as { freshInstall: { noConfigPersisted: boolean; noApiKey: boolean; noCustomSetup: boolean } };
    expect(body.freshInstall.noConfigPersisted).toBe(true);
  });

  it('detects configured install after config is saved', async () => {
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const config = new ConfigStore(db);
    // Persist a config row to simulate configured install.
    config.update({ autopilot: { apiKey: 'sk-set' } });
    const users = new UserStore(db); users.create('admin', 'pass');
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
      bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config, users,
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
