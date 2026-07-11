import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';

function makeApp(over: { latestVersion?: () => Promise<string | null>; startUpdate?: () => void; startRestart?: (target: 'daemon' | 'web') => void; autoUpdate?: boolean; skillService?: any; withUsers?: boolean } = {}) {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const config = new ConfigStore(db);
  if (over.autoUpdate) config.update({ autoUpdate: true });
  const missions = new MissionStore(db);
  // Gated mode on demand: the first user is the admin, the second is a plain user.
  const users = over.withUsers ? new UserStore(db) : undefined;
  const adminTok = users ? users.issueToken(users.create('admin', 'pw').id) : undefined;
  const userTok = users ? users.issueToken(users.create('amy', 'pw').id) : undefined;
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions,
    bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, projects: new ProjectStore(db), git: null as any, users,
    latestVersion: over.latestVersion, startUpdate: over.startUpdate, startRestart: over.startRestart, skillService: over.skillService,
  });
  return { app, missions, adminTok, userTok };
}

describe('GET /system', () => {
  it('reports an available update when npm has a newer version', async () => {
    const { app } = makeApp({ latestVersion: async () => '99.0.0' });
    const body = await (await app.request('/system')).json();
    expect(body.latest).toBe('99.0.0');
    expect(body.updateAvailable).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.autoUpdate).toBe(false);
  });
  it('reports no update when the latest is not newer than the running version', async () => {
    const { app } = makeApp({ latestVersion: async () => '0.0.1' });
    const body = await (await app.request('/system')).json();
    expect(body.updateAvailable).toBe(false);
  });
  it('degrades to no-update when the registry is unreachable (latest null)', async () => {
    const { app } = makeApp({ latestVersion: async () => null });
    const body = await (await app.request('/system')).json();
    expect(body.latest).toBeNull();
    expect(body.updateAvailable).toBe(false);
  });
  it('surfaces the auto-update opt-in', async () => {
    const { app } = makeApp({ latestVersion: async () => null, autoUpdate: true });
    expect((await (await app.request('/system')).json()).autoUpdate).toBe(true);
  });
  it('reports when the build was last installed', async () => {
    const { app } = makeApp({ latestVersion: async () => null });
    const body = await (await app.request('/system')).json();
    expect('lastUpdatedAt' in body).toBe(true); // ISO string from package.json mtime (or null if unreadable)
  });
  it('includes finite host diagnostics for the control deck', async () => {
    const { app } = makeApp({ latestVersion: async () => null });
    const body = await (await app.request('/system')).json();
    expect(body.diagnostics).toEqual({
      cpuPercent: expect.any(Number),
      memoryUsedBytes: expect.any(Number),
      memoryTotalBytes: expect.any(Number),
      uptimeSeconds: expect.any(Number),
    });
    expect(body.diagnostics.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(body.diagnostics.cpuPercent).toBeLessThanOrEqual(100);
  });
});

describe('/system/skills', () => {
  const fake = {
    status: () => [{ provider: 'claude-code', present: true, installed: true, version: 1, upToDate: true }],
    installAll: () => [{ provider: 'claude-code', installed: true, skipped: false }],
  };
  it('returns per-provider status', async () => {
    const { app } = makeApp({ skillService: fake });
    const body = await (await app.request('/system/skills')).json();
    expect(body.skills[0]).toMatchObject({ provider: 'claude-code', upToDate: true });
  });
  it('installs on demand and returns the results', async () => {
    let installed = false;
    const { app } = makeApp({ skillService: { ...fake, installAll: () => { installed = true; return fake.installAll(); } } });
    const res = await app.request('/system/skills/install', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).results[0]).toMatchObject({ provider: 'claude-code', installed: true });
    expect(installed).toBe(true);
  });
});

describe('POST /system/update', () => {
  it('starts the update when idle', async () => {
    let started = false;
    const { app } = makeApp({ startUpdate: () => { started = true; } });
    const res = await app.request('/system/update', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true });
    expect(started).toBe(true);
  });
  it('refuses with 409 while a mission is live, without starting an update', async () => {
    let started = false;
    const { app, missions } = makeApp({ startUpdate: () => { started = true; } });
    missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    const res = await app.request('/system/update', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'mission_running' });
    expect(started).toBe(false);
  });
});

describe('POST /system/restart', () => {
  const post = (body: unknown, tok?: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });

  it('responds first, then fires the injected restart for the requested unit (deferred spawn)', async () => {
    vi.useFakeTimers();
    try {
      const restarted: string[] = [];
      const { app } = makeApp({ startRestart: (t) => restarted.push(t) });
      const res = await app.request('/system/restart', post({ target: 'daemon' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // The spawn is deferred so the HTTP response wins the race against the daemon's own death.
      expect(restarted).toEqual([]);
      vi.advanceTimersByTime(100);
      expect(restarted).toEqual(['daemon']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the web unit too', async () => {
    vi.useFakeTimers();
    try {
      const restarted: string[] = [];
      const { app } = makeApp({ startRestart: (t) => restarted.push(t) });
      expect((await app.request('/system/restart', post({ target: 'web' }))).status).toBe(200);
      vi.advanceTimersByTime(100);
      expect(restarted).toEqual(['web']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an unknown target with 400, without restarting anything', async () => {
    vi.useFakeTimers();
    try {
      let restarted = false;
      const { app } = makeApp({ startRestart: () => { restarted = true; } });
      expect((await app.request('/system/restart', post({ target: 'nginx' }))).status).toBe(400);
      expect((await app.request('/system/restart', post({}))).status).toBe(400);
      vi.advanceTimersByTime(1000);
      expect(restarted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is admin-only on a gated daemon', async () => {
    vi.useFakeTimers();
    try {
      let restarted = false;
      const { app, adminTok, userTok } = makeApp({ withUsers: true, startRestart: () => { restarted = true; } });
      expect((await app.request('/system/restart', post({ target: 'daemon' }))).status).toBe(401);
      expect((await app.request('/system/restart', post({ target: 'daemon' }, userTok))).status).toBe(403);
      vi.advanceTimersByTime(1000);
      expect(restarted).toBe(false);
      expect((await app.request('/system/restart', post({ target: 'daemon' }, adminTok))).status).toBe(200);
      vi.advanceTimersByTime(100);
      expect(restarted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
