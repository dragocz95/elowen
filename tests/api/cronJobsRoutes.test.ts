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
  const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-cronjobs-'));
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
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
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });

const job = (extra: Record<string, unknown> = {}) => ({
  id: 'j1', name: 'digest', schedule: 'daily 06:00', prompt: 'Summarize the day.', createdAt: '2026-07-01T00:00:00.000Z', ...extra,
});
/** Save one job through the route that owns it. */
const save = (app: { request: (path: string, init: unknown) => Promise<Response> }, tok: string, j: Record<string, unknown>) =>
  app.request(`/plugins/cronjob/jobs/${j.id}`, put(tok, j));
const seed = (dataRoot: string, jobs: unknown[]): string => {
  const file = join(dataRoot, 'cronjob', 'jobs.json');
  mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
  writeFileSync(file, JSON.stringify(jobs));
  return file;
};
const onDisk = (dataRoot: string) => JSON.parse(readFileSync(join(dataRoot, 'cronjob', 'jobs.json'), 'utf-8'));

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

  // jobs.json is shared with the scheduler and the brain's CronAdd tool. A client that could hand over
  // the whole list would delete whatever it had not seen — the way an open browser tab silently dropped
  // jobs added behind its back. So a write names ONE job, and every other job on disk survives it.
  it('a save leaves every other job on disk alone — including one the client never saw', async () => {
    const { app, dataRoot, adminTok } = setup();
    seed(dataRoot, [job({ id: 'known' }), job({ id: 'added-behind-your-back', name: 'Nightly report' })]);
    expect((await save(app, adminTok, job({ id: 'known', prompt: 'Edited.' }))).status).toBe(200);
    expect(onDisk(dataRoot).map((j: { id: string }) => j.id)).toEqual(['known', 'added-behind-your-back']);
    expect(onDisk(dataRoot)[0].prompt).toBe('Edited.');
  });

  it('a save creates the job when it is new, and GET round-trips it (recurring + one-shot)', async () => {
    const { app, dataRoot, adminTok } = setup();
    // lastRun/lastResult are scheduler-owned: the save strips them from the client payload (nothing was
    // on disk to merge back), so the round-trip returns the jobs WITHOUT those fields.
    const jobs = [
      job({ hours: '5-21', notifyChannelId: '123', enabled: false, lastRun: '2026-07-01T06:00:10.000Z', lastResult: 'ok' }),
      job({ id: 'j2', name: 'wakeup', schedule: 'in 20m', runAt: '2026-07-02T18:00:00.000Z' }),
    ];
    for (const j of jobs) expect((await save(app, adminTok, j)).status).toBe(200);
    const stripped = jobs.map(({ lastRun: _lr, lastResult: _lres, ...j }: Record<string, unknown>) => j);
    const back = await app.request('/plugins/cronjob/jobs', auth(adminTok));
    expect(await back.json()).toEqual(stripped);
    // The plugin's scheduler reads this exact file every tick — verify it landed on disk.
    expect(existsSync(join(dataRoot, 'cronjob', 'jobs.json'))).toBe(true);
    expect(onDisk(dataRoot)).toEqual(stripped);
  });

  it('a save keeps the scheduler-owned run state (lastRun, lastSlot, lastResult) over a stale client copy', async () => {
    const { app, dataRoot, adminTok } = setup();
    // The scheduler stamped a fresh run on disk while the UI held an older snapshot.
    seed(dataRoot, [job({ enabled: true, lastRun: '2026-07-02T15:00:00.000Z', lastSlot: '2026-07-02T15:00', lastResult: 'fresh' })]);
    await save(app, adminTok, job({ enabled: true, lastRun: '2026-07-01T00:00:00.000Z', lastResult: 'stale', prompt: 'Edited prompt.' }));
    const saved = onDisk(dataRoot)[0];
    expect(saved.prompt).toBe('Edited prompt.');            // the edit itself lands
    expect(saved.lastRun).toBe('2026-07-02T15:00:00.000Z'); // the scheduler's stamps survive
    expect(saved.lastSlot).toBe('2026-07-02T15:00');        // dropping this re-fires a slot already run
    expect(saved.lastResult).toBe('fresh');
  });

  it('a save arms a job from NOW when it flips to enabled (and for a new enabled job)', async () => {
    const { app, dataRoot, adminTok } = setup();
    seed(dataRoot, [job({ enabled: false, lastRun: '2026-07-01T06:00:10.000Z' })]);
    const before = Date.now();
    await save(app, adminTok, job({ enabled: true }));                            // paused → enabled: re-arm from now
    await save(app, adminTok, job({ id: 'new1', name: 'fresh', enabled: true })); // brand-new enabled job: armed too
    await save(app, adminTok, job({ id: 'new2', name: 'parked', enabled: false })); // brand-new paused job: no stamp
    const saved = onDisk(dataRoot);
    expect(Date.parse(saved[0].lastRun)).toBeGreaterThanOrEqual(before); // not the old 06:00 stamp
    expect(Date.parse(saved[1].lastRun)).toBeGreaterThanOrEqual(before);
    expect(saved[2].lastRun).toBeUndefined();
  });

  it('a save keeps lastRun untouched for a job that stays enabled', async () => {
    const { app, dataRoot, adminTok } = setup();
    seed(dataRoot, [job({ enabled: true, lastRun: '2026-07-02T15:00:00.000Z' })]);
    await save(app, adminTok, job({ enabled: true, name: 'renamed' }));
    const saved = onDisk(dataRoot)[0];
    expect(saved.name).toBe('renamed');
    expect(saved.lastRun).toBe('2026-07-02T15:00:00.000Z');
  });

  it('the URL names the job a save writes — a body id cannot redirect it', async () => {
    const { app, dataRoot, adminTok } = setup();
    seed(dataRoot, [job({ id: 'victim', name: 'keep me' })]);
    await app.request('/plugins/cronjob/jobs/mine', put(adminTok, job({ id: 'victim', name: 'overwritten' })));
    expect(onDisk(dataRoot).map((j: { id: string; name: string }) => [j.id, j.name]))
      .toEqual([['victim', 'keep me'], ['mine', 'overwritten']]);
  });

  it('DELETE removes just that job, and deleting one that is already gone still succeeds', async () => {
    const { app, dataRoot, adminTok } = setup();
    seed(dataRoot, [job({ id: 'j1' }), job({ id: 'j2' })]);
    expect((await app.request('/plugins/cronjob/jobs/j1', del(adminTok))).status).toBe(200);
    expect(onDisk(dataRoot).map((j: { id: string }) => j.id)).toEqual(['j2']);
    // Idempotent: a client that says "this job should not exist" must not have to know whether it still
    // does — that is what lets it delete a job whose own creating save is still on the wire.
    expect((await app.request('/plugins/cronjob/jobs/j1', del(adminTok))).status).toBe(200);
    expect(onDisk(dataRoot).map((j: { id: string }) => j.id)).toEqual(['j2']);
  });

  // The plugin rewrites jobs.json with a plain, non-atomic writeFileSync. A write that read the file at
  // the wrong moment and saw "no jobs" would put ONE job back where twelve were — the very loss this
  // endpoint exists to stop.
  it('refuses to write over a jobs file it could not read, and leaves it untouched', async () => {
    const { app, dataRoot, adminTok } = setup();
    const file = join(dataRoot, 'cronjob', 'jobs.json');
    for (const corrupt of ['{not json', '{"jobs": []}']) { // truncated mid-write, or simply not a list
      mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
      writeFileSync(file, corrupt);
      expect((await save(app, adminTok, job())).status, corrupt).toBe(500);
      expect((await app.request('/plugins/cronjob/jobs/j1', del(adminTok))).status, corrupt).toBe(500);
      expect(readFileSync(file, 'utf-8')).toBe(corrupt);
    }
  });

  // Arming is about the scheduler's whole run state: dueSlot decides a daily/weekly job on lastSlot alone,
  // so a stale slot left behind on a re-enabled job fires it on the spot.
  it('a job re-enabled after its slot has passed does not fire again for that slot', async () => {
    const { app, dataRoot, adminTok } = setup();
    seed(dataRoot, [job({ schedule: 'daily 07:30', enabled: false, lastRun: '2026-07-06T07:30:05.000Z', lastSlot: '2026-07-06T07:30' })]);
    await save(app, adminTok, job({ schedule: 'daily 07:30', enabled: true }));
    const saved = onDisk(dataRoot)[0];
    expect(saved.lastSlot).toBeUndefined();                          // Monday's slot no longer speaks for today
    expect(Date.parse(saved.lastRun)).toBeGreaterThan(Date.parse('2026-07-06T07:30:05.000Z'));
  });

  // The brain's CronAdd accepts 5-field cron expressions; a validator that rejects them makes the jobs it
  // creates uneditable from the UI.
  it('accepts the cron expressions the plugin accepts, and rejects malformed ones', async () => {
    const { app, adminTok } = setup();
    for (const schedule of ['0 9 * * 1-5', '*/5 * * * *', '0 0 1 * *', '30 6 * jan-mar mon,fri']) {
      expect((await save(app, adminTok, job({ schedule }))).status, schedule).toBe(200);
    }
    for (const schedule of ['70 * * * *', '0 9 * *', '0 9 * * 1-5 7', '5-1 * * * *', '* * * * xyz']) {
      expect((await save(app, adminTok, job({ schedule }))).status, schedule).toBe(400);
    }
  });

  it('a save accepts every valid schedule shape', async () => {
    const { app, adminTok } = setup();
    for (const schedule of ['every 15m', 'every 2h', 'daily 07:30', 'weekly sun 20:00']) {
      expect((await save(app, adminTok, job({ schedule }))).status, schedule).toBe(200);
    }
  });

  it('a save rejects an invalid schedule (400)', async () => {
    const { app, adminTok } = setup();
    for (const schedule of ['every 0m', 'hourly', 'daily 25:00', 'weekly xyz 10:00', '']) {
      expect((await save(app, adminTok, job({ schedule }))).status, schedule).toBe(400);
    }
    // A one-shot job with an unparseable runAt is invalid too.
    expect((await save(app, adminTok, job({ runAt: 'not-a-date' }))).status).toBe(400);
  });

  it('a save round-trips a valid per-job model and rejects a malformed one (400)', async () => {
    const { app, dataRoot, adminTok } = setup();
    expect((await save(app, adminTok, job({ model: { provider: 'anthropic', model: 'claude-sonnet-5' } }))).status).toBe(200);
    expect(onDisk(dataRoot)[0].model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    // Malformed model objects are rejected; an absent model is fine (default model runs).
    for (const model of [{ provider: 'anthropic' }, { model: 'x' }, { provider: '', model: 'x' }, 'anthropic/x']) {
      expect((await save(app, adminTok, job({ model }))).status, JSON.stringify(model)).toBe(400);
    }
    expect((await save(app, adminTok, job())).status).toBe(200); // no model → ok
  });

  it('a save rejects a body that is not a job object, or one missing required fields (400)', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/plugins/cronjob/jobs/x', put(adminTok, [job()]))).status).toBe(400);
    expect((await app.request('/plugins/cronjob/jobs/x', put(adminTok, { name: '', schedule: 'every 1h', prompt: 'p' }))).status).toBe(400);
    expect((await app.request('/plugins/cronjob/jobs/x', put(adminTok, { name: 'n', schedule: 'every 1h' }))).status).toBe(400);
  });

  it('rejects a non-admin (403) on GET, save and DELETE', async () => {
    const { app, amyTok } = setup();
    expect((await app.request('/plugins/cronjob/jobs', auth(amyTok))).status).toBe(403);
    expect((await save(app, amyTok, job())).status).toBe(403);
    expect((await app.request('/plugins/cronjob/jobs/j1', del(amyTok))).status).toBe(403);
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
