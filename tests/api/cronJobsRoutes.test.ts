import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';

let dirs: string[] = [];
const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

const pluginsDir = join(process.cwd(), 'plugins');

function setup(opts: { enabled?: string[]; config?: Record<string, Record<string, unknown>>; noUsers?: boolean } = {}) {
  const dataRoot = tmpDir('cronjobs');
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  // `noUsers` is SETUP MODE: before the first account exists the API is unauthenticated by design.
  const admin = opts.noUsers ? { id: 0 } : users.create('admin', 'pw');
  const amy = opts.noUsers ? { id: 0 } : users.create('amy', 'pw');
  // The '/plugins/cronjob/jobs' surface is served by the REAL cronjob plugin (root mounts) now.
  const provider = new PluginRegistryProvider(() => loadPlugins({
    dirs: [pluginsDir], enabled: opts.enabled ?? ['cronjob'], dataRoot, config: opts.config,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }));
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    pluginDataRoot: dataRoot, pluginDirs: [pluginsDir],
    plugins: provider,
  });
  return {
    app, dataRoot, users, amy,
    adminTok: opts.noUsers ? '' : users.issueToken(admin.id),
    amyTok: opts.noUsers ? '' : users.issueToken(amy.id),
  };
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

  // A write that read the file at the wrong moment (truncated, or not a list) and saw "no jobs" would
  // put ONE job back where twelve were — the very loss this endpoint exists to stop.
  it('lets an unidentified caller (setup mode) neither create nor DELETE a job', async () => {
    const { app, dataRoot } = setup({ noUsers: true });
    seed(dataRoot, [job({ id: 'instance-job' })]);
    // An instance job has no owner, so an owner comparison alone would read `null === null` as "mine"
    // and let onboarding destroy jobs it is not even allowed to create.
    expect((await app.request('/plugins/cronjob/jobs/instance-job', { method: 'DELETE' })).status).toBe(403);
    expect((await app.request('/plugins/cronjob/jobs/j1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job()),
    })).status).toBe(403);
    expect(onDisk(dataRoot).map((j: { id: string }) => j.id)).toEqual(['instance-job']);
  });

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

  // Cronjob is a user-grantable plugin: an account the admin has not granted it reaches nothing, and the
  // refusal happens in the core HTTP gate before the plugin sees the request.
  it('rejects an ungranted non-admin (403) on GET, save and DELETE', async () => {
    const { app, amyTok } = setup();
    expect((await app.request('/plugins/cronjob/jobs', auth(amyTok))).status).toBe(403);
    expect((await save(app, amyTok, job())).status).toBe(403);
    expect((await app.request('/plugins/cronjob/jobs/j1', del(amyTok))).status).toBe(403);
  });

  it('gives a granted non-admin her OWN jobs, and nobody else\'s', async () => {
    const { app, users, amy, amyTok, adminTok } = setup();
    users.setGrantedPlugins(amy.id, ['cronjob']);
    expect((await save(app, adminTok, job({ id: 'shared', name: 'instance job' }))).status).toBe(200);

    // Ownership comes from the SERVER: a body claiming otherwise cannot make it someone else's job.
    expect((await save(app, amyTok, job({ id: 'mine', name: 'my job', ownerUserId: 1 }))).status).toBe(200);
    const mine = (await (await app.request('/plugins/cronjob/jobs', auth(amyTok))).json()) as { id: string; ownerUserId?: number | null }[];
    expect(mine.map((j) => j.id)).toEqual(['mine']);
    expect(mine[0]!.ownerUserId).toBe(amy.id);

    // The admin sees both, and an instance job carries no owner at all.
    const all = (await (await app.request('/plugins/cronjob/jobs', auth(adminTok))).json()) as { id: string; ownerUserId?: number | null }[];
    expect(all.map((j) => j.id).sort()).toEqual(['mine', 'shared']);
    expect(all.find((j) => j.id === 'shared')).not.toHaveProperty('ownerUserId');

    // She may not reach the instance job — neither to edit nor to delete it.
    expect((await save(app, amyTok, job({ id: 'shared', name: 'hijacked' }))).status).toBe(403);
    expect((await app.request('/plugins/cronjob/jobs/shared', del(amyTok))).status).toBe(403);
    const still = (await (await app.request('/plugins/cronjob/jobs', auth(adminTok))).json()) as { id: string; name: string }[];
    expect(still.find((j) => j.id === 'shared')?.name).toBe('instance job');
  });

  // An owned job runs unattended on the operator's machine, so the capabilities that reach past its owner
  // are the admin's alone: a shell guard, a notification channel of someone else's, and schedules fast
  // enough (or expressive enough) to occupy the instance.
  it('refuses a shell check, a notification channel, cron expressions and too-fast schedules from an account', async () => {
    const { app, users, amy, amyTok } = setup();
    users.setGrantedPlugins(amy.id, ['cronjob']);
    const denied = async (fields: Record<string, unknown>) => {
      const res = await save(app, amyTok, job({ id: 'x', ...fields }));
      expect(res.status, JSON.stringify(fields)).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await denied({ check: 'ls /' })).toMatch(/shell check/);
    expect(await denied({ notifyChannelId: '123' })).toMatch(/notification channel/);
    expect(await denied({ schedule: '*/5 * * * *' })).toMatch(/cron expressions/);
    expect(await denied({ schedule: 'every 1m' })).toMatch(/shortest interval/);
    // The plain forms she is meant to use go through.
    expect((await save(app, amyTok, job({ id: 'ok', schedule: 'daily 07:30' }))).status).toBe(200);
  });

  it('caps how many jobs one account may keep', async () => {
    const { app, users, amy, amyTok } = setup({ config: { cronjob: { maxJobsPerUser: 2 } } });
    users.setGrantedPlugins(amy.id, ['cronjob']);
    expect((await save(app, amyTok, job({ id: 'a' }))).status).toBe(200);
    expect((await save(app, amyTok, job({ id: 'b' }))).status).toBe(200);
    const res = await save(app, amyTok, job({ id: 'c' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/already have 2/);
    // Editing one she already owns is not "another job" — the cap must not lock her out of her own list.
    expect((await save(app, amyTok, job({ id: 'b', name: 'renamed' }))).status).toBe(200);
  });

  // A job left behind has no owner to run as and no conversation to report into, yet the scheduler would
  // keep paying for its turns on every slot, forever.
  it('drops an account\'s jobs when the account is deleted', async () => {
    const { app, users, amy, amyTok, adminTok } = setup();
    users.setGrantedPlugins(amy.id, ['cronjob']);
    await save(app, adminTok, job({ id: 'shared' }));
    await save(app, amyTok, job({ id: 'hers' }));

    expect((await app.request(`/users/${amy.id}`, del(adminTok))).status).toBe(200);
    const left = (await (await app.request('/plugins/cronjob/jobs', auth(adminTok))).json()) as { id: string }[];
    expect(left.map((j) => j.id)).toEqual(['shared']);
  });

  it('answers 503 "cronjob plugin is disabled" when the plugin is off', async () => {
    const { app, adminTok } = setup({ enabled: [] });
    const res = await app.request('/plugins/cronjob/jobs', auth(adminTok));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'cronjob plugin is disabled' });
  });
});

// The discord channels route and the msteams app-package route both moved to the plugin registry with
// their plugins. What they proved about the CORE — that a declared root mount of a DISABLED plugin
// answers 503 rather than a bare 404 — is proved above by the cronjob routes, which take the identical
// path through pluginApi.
