import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'orca-cronjobs-'));
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    pluginDataRoot: dataRoot,
  });
  return { app, dataRoot, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const put = (t: string, body: unknown) => ({ method: 'PUT', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const job = (extra: Record<string, unknown> = {}) => ({
  id: 'j1', name: 'digest', schedule: 'daily 06:00', prompt: 'Summarize the day.', createdAt: '2026-07-01T00:00:00.000Z', ...extra,
});

describe('cron jobs routes', () => {
  it('GET returns [] when the jobs file does not exist yet', async () => {
    const { app, adminTok } = setup();
    const res = await app.request('/plugins/cronjob/jobs', auth(adminTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET returns [] for a corrupted jobs file', async () => {
    const { app, dataRoot, adminTok } = setup();
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    writeFileSync(join(dataRoot, 'cronjob', 'jobs.json'), '{not json');
    const res = await app.request('/plugins/cronjob/jobs', auth(adminTok));
    expect(await res.json()).toEqual([]);
  });

  it('PUT persists the array and GET round-trips it (recurring + one-shot)', async () => {
    const { app, dataRoot, adminTok } = setup();
    // lastRun/lastResult are scheduler-owned: the PUT strips them from the client payload (nothing
    // was on disk to merge back), so the round-trip returns the jobs WITHOUT those fields.
    const jobs = [
      job({ hours: '5-21', notifyChannelId: '123', enabled: false, lastRun: '2026-07-01T06:00:10.000Z', lastResult: 'ok' }),
      job({ id: 'j2', name: 'wakeup', schedule: 'in 20m', runAt: '2026-07-02T18:00:00.000Z' }),
    ];
    const res = await app.request('/plugins/cronjob/jobs', put(adminTok, jobs));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const stripped = jobs.map(({ lastRun: _lr, lastResult: _lres, ...j }: Record<string, unknown>) => j);
    const back = await app.request('/plugins/cronjob/jobs', auth(adminTok));
    expect(await back.json()).toEqual(stripped);
    // The plugin's scheduler reads this exact file every tick — verify it landed on disk.
    const file = join(dataRoot, 'cronjob', 'jobs.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual(stripped);
  });

  it('PUT preserves the scheduler-owned lastRun/lastResult from disk over a stale client copy', async () => {
    const { app, dataRoot, adminTok } = setup();
    const file = join(dataRoot, 'cronjob', 'jobs.json');
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    // The scheduler stamped a fresh run on disk while the UI held an older snapshot.
    writeFileSync(file, JSON.stringify([job({ enabled: true, lastRun: '2026-07-02T15:00:00.000Z', lastResult: 'fresh' })]));
    await app.request('/plugins/cronjob/jobs', put(adminTok, [job({ enabled: true, lastRun: '2026-07-01T00:00:00.000Z', lastResult: 'stale', prompt: 'Edited prompt.' })]));
    const saved = JSON.parse(readFileSync(file, 'utf-8'))[0];
    expect(saved.prompt).toBe('Edited prompt.');        // the edit itself lands
    expect(saved.lastRun).toBe('2026-07-02T15:00:00.000Z'); // scheduler's stamp survives
    expect(saved.lastResult).toBe('fresh');
  });

  it('PUT arms a job from NOW when it flips to enabled (and for a new enabled job)', async () => {
    const { app, dataRoot, adminTok } = setup();
    const file = join(dataRoot, 'cronjob', 'jobs.json');
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    writeFileSync(file, JSON.stringify([job({ enabled: false, lastRun: '2026-07-01T06:00:10.000Z' })]));
    const before = Date.now();
    await app.request('/plugins/cronjob/jobs', put(adminTok, [
      job({ enabled: true }),                                  // paused → enabled: re-arm from now
      job({ id: 'new1', name: 'fresh', enabled: true }),       // brand-new enabled job: armed too
      job({ id: 'new2', name: 'parked', enabled: false }),     // brand-new paused job: no stamp
    ]));
    const saved = JSON.parse(readFileSync(file, 'utf-8'));
    expect(Date.parse(saved[0].lastRun)).toBeGreaterThanOrEqual(before); // not the old 06:00 stamp
    expect(Date.parse(saved[1].lastRun)).toBeGreaterThanOrEqual(before);
    expect(saved[2].lastRun).toBeUndefined();
  });

  it('PUT keeps lastRun untouched for a job that stays enabled', async () => {
    const { app, dataRoot, adminTok } = setup();
    const file = join(dataRoot, 'cronjob', 'jobs.json');
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    writeFileSync(file, JSON.stringify([job({ enabled: true, lastRun: '2026-07-02T15:00:00.000Z' })]));
    await app.request('/plugins/cronjob/jobs', put(adminTok, [job({ enabled: true, name: 'renamed' })]));
    const saved = JSON.parse(readFileSync(file, 'utf-8'))[0];
    expect(saved.name).toBe('renamed');
    expect(saved.lastRun).toBe('2026-07-02T15:00:00.000Z');
  });

  it('PUT accepts every valid schedule shape', async () => {
    const { app, adminTok } = setup();
    for (const schedule of ['every 15m', 'every 2h', 'daily 07:30', 'weekly sun 20:00']) {
      const res = await app.request('/plugins/cronjob/jobs', put(adminTok, [job({ schedule })]));
      expect(res.status, schedule).toBe(200);
    }
  });

  it('PUT rejects an invalid schedule (400)', async () => {
    const { app, adminTok } = setup();
    for (const schedule of ['every 0m', 'hourly', 'daily 25:00', 'weekly xyz 10:00', '']) {
      const res = await app.request('/plugins/cronjob/jobs', put(adminTok, [job({ schedule })]));
      expect(res.status, schedule).toBe(400);
    }
    // A one-shot job with an unparseable runAt is invalid too.
    expect((await app.request('/plugins/cronjob/jobs', put(adminTok, [job({ runAt: 'not-a-date' })]))).status).toBe(400);
  });

  it('PUT round-trips a valid per-job model and rejects a malformed one (400)', async () => {
    const { app, dataRoot, adminTok } = setup();
    const ok = await app.request('/plugins/cronjob/jobs', put(adminTok, [job({ model: { provider: 'anthropic', model: 'claude-sonnet-5' } })]));
    expect(ok.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(dataRoot, 'cronjob', 'jobs.json'), 'utf-8'))[0];
    expect(saved.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    // Malformed model objects are rejected; an absent model is fine (default model runs).
    for (const model of [{ provider: 'anthropic' }, { model: 'x' }, { provider: '', model: 'x' }, 'anthropic/x']) {
      expect((await app.request('/plugins/cronjob/jobs', put(adminTok, [job({ model })]))).status, JSON.stringify(model)).toBe(400);
    }
    expect((await app.request('/plugins/cronjob/jobs', put(adminTok, [job()]))).status).toBe(200); // no model → ok
  });

  it('PUT rejects a non-array body and a job missing required fields (400)', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/plugins/cronjob/jobs', put(adminTok, { jobs: [] }))).status).toBe(400);
    expect((await app.request('/plugins/cronjob/jobs', put(adminTok, [{ id: 'x', name: '', schedule: 'every 1h', prompt: 'p' }]))).status).toBe(400);
    expect((await app.request('/plugins/cronjob/jobs', put(adminTok, [{ id: 'x', name: 'n', schedule: 'every 1h' }]))).status).toBe(400);
  });

  it('rejects a non-admin (403) on both GET and PUT', async () => {
    const { app, amyTok } = setup();
    expect((await app.request('/plugins/cronjob/jobs', auth(amyTok))).status).toBe(403);
    expect((await app.request('/plugins/cronjob/jobs', put(amyTok, [job()]))).status).toBe(403);
  });
});

describe('discord channels route', () => {
  it('returns [] when the discord plugin has no token/guild configured', async () => {
    const { app, adminTok } = setup();
    const res = await app.request('/plugins/discord/channels', auth(adminTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('rejects a non-admin (403)', async () => {
    const { app, amyTok } = setup();
    expect((await app.request('/plugins/discord/channels', auth(amyTok))).status).toBe(403);
  });
});
