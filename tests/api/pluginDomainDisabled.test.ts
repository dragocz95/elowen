import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { RefMissions } from '../helpers/refStores.js';

/** The subject is the daemon's OWN "declared but inactive" gate, so the domain it gates is a FIXTURE
 *  plugin written to disk here, not whichever product plugin happens to be installed beside the daemon.
 *  `ledger` owns a whole path family the way a domain plugin does; `audit` mounts INSIDE that family's
 *  prefix, which is how two plugins come to share a surface. In the "unowned" shape neither is enabled
 *  but both stay DISCOVERABLE — which is exactly what separates "switched off" (503, naming the owner)
 *  from "no such endpoint" (404). */
let pluginRoots: string[] = [];
afterEach(() => { for (const p of pluginRoots) rmSync(p, { recursive: true, force: true }); pluginRoots = []; });

/** Every path `ledger` declares — the hand-written list the first test walks. The fourth test re-derives
 *  the same family from the ROUTER instead, so the two can be compared. */
const LEDGER_ROUTES: { mount: string; method: string }[] = [
  { mount: '/ledger', method: 'GET' }, { mount: '/ledger', method: 'POST' },
  { mount: '/ledger/ready', method: 'GET' }, { mount: '/ledger/summary', method: 'GET' },
  { mount: '/ledger/:id', method: 'GET' }, { mount: '/ledger/:id', method: 'PATCH' },
  { mount: '/ledger/:id', method: 'DELETE' },
  { mount: '/ledger/:id/entries', method: 'GET' }, { mount: '/ledger/:id/entries', method: 'POST' },
  { mount: '/ledger/:id/history', method: 'GET' }, { mount: '/ledger/:id/history/:ref', method: 'GET' },
  { mount: '/ledger/plan', method: 'POST' }, { mount: '/ledger/:id/phases', method: 'POST' },
  { mount: '/postings/:id', method: 'GET' }, { mount: '/postings/:id/submit', method: 'POST' },
];

/** The loader only reads real plugin folders, so the fixture pair is written to disk and swept after. */
function fixturePluginDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'domain-gate-'));
  pluginRoots.push(root);

  const ledger = join(root, 'ledger');
  mkdirSync(ledger, { recursive: true });
  writeFileSync(join(ledger, 'elowen-plugin.json'), JSON.stringify({
    name: 'ledger', version: '1.0.0', apiVersion: '1', description: 'a domain plugin owning a path family',
    entry: 'index.mjs', provides: { apiRoutes: [...new Set(LEDGER_ROUTES.map((r) => r.mount))] },
  }));
  // Registered from the same list the test walks, so the on-disk plugin and the expectation cannot drift.
  writeFileSync(join(ledger, 'index.mjs'), `
    const ROUTES = ${JSON.stringify(LEDGER_ROUTES)};
    export function register(ctx){
      const rows = [];
      for (const { mount, method } of ROUTES) {
        ctx.registerApiRoute({ rootMount: mount, path: '', method, access: 'user', handler: async (req) => {
          if (mount === '/ledger' && method === 'POST') { rows.push(await req.json()); return { status: 201, body: rows[rows.length - 1] }; }
          if (mount === '/ledger' && method === 'GET') return { body: rows };
          return { body: { mount, method } };
        } });
      }
    }
  `);

  const audit = join(root, 'audit');
  mkdirSync(audit, { recursive: true });
  writeFileSync(join(audit, 'elowen-plugin.json'), JSON.stringify({
    name: 'audit', version: '1.0.0', apiVersion: '1', description: 'a second plugin mounting inside the first prefix',
    entry: 'index.mjs', provides: { apiRoutes: ['/ledger/:id/sign', '/ledger/:id/attest', '/ledger/:id/approve-gate'] },
  }));
  writeFileSync(join(audit, 'index.mjs'), `
    export function register(ctx){
      for (const m of ['/ledger/:id/sign', '/ledger/:id/attest', '/ledger/:id/approve-gate']) {
        ctx.registerApiRoute({ rootMount: m, path: '', access: 'user', handler: async () => ({ body: { signed: true } }) });
      }
    }
  `);
  return root;
}

/** A daemon whose `ledger` domain either has an owner (the plugin enabled) or has none (it is switched
 *  off). Which plugins are ENABLED is the ONLY difference — everything else is wired identically, and
 *  the plugin dir is discoverable in both shapes. */
async function makeApp(owned: boolean) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const bus = new EventBus();
  const dirs = [fixturePluginDir()];
  const provider = new PluginRegistryProvider(() => loadPlugins({
    dirs,
    enabled: owned ? ['ledger'] : [],
    delegatedTurnsOutOfProcess: () => false,
    pluginDb: (plugin) => makePluginDb(db, plugin, { canMigrate: true }),
    publishEvent: (e) => bus.publish(e),
    subscribeEvents: (fn) => bus.subscribe(fn),
    logger: { info() {}, warn() {}, error() {} },
  }));
  const registry = await provider.get();
  const app = createServer({
    taskRefs: new TaskRefs(db),
    missions: new RefMissions(db), bus, tmux: new FakeTmuxDriver(),
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, projects,
    plugins: provider, pluginDirs: dirs,
  });
  return { app, db, registry };
}

/** A concrete request path for a mount pattern; the gate is path-shaped only, so any segment does. */
const concrete = (mount: string) => mount.replace(/:[A-Za-z0-9_]+/g, 'x');
const withBody = (method: string) => (method === 'GET' || method === 'DELETE' ? {} : { body: '{}' });

describe('a plugin-owned path family whose owner is not loaded', () => {
  // The dishonest failure this guards against is an EMPTY 200: with no owner behind it, a list route
  // that answers `[]` tells the CLI, the web UI and a spawned agent "this instance has no records",
  // which is a different statement from "that subsystem is off here".
  it('answers 503 — never an empty list — on every path of the family', async () => {
    const { app } = await makeApp(false);
    for (const { mount, method } of LEDGER_ROUTES) {
      const path = concrete(mount);
      const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...withBody(method) });
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 503`);
      expect(await res.json()).toEqual({ error: 'ledger plugin is disabled' });
    }
  });

  // The answer must be scoped to paths a plugin actually DECLARES, and must name the RIGHT owner. A
  // neighbouring surface that merely starts with the same word is nobody's, and still says "no such
  // endpoint".
  it('leaves the surfaces around it alone', async () => {
    const { app } = await makeApp(false);
    // Mounts nested inside the first plugin's prefix but declared by the OTHER plugin get that plugin's
    // name in the 503 — the gate resolves an owner per declared mount, not per path prefix.
    for (const path of ['/ledger/x/sign', '/ledger/x/attest', '/ledger/x/approve-gate']) {
      const res = await app.request(path);
      expect(`${path} → ${res.status}`).toBe(`${path} → 503`);
      expect(await res.json()).toEqual({ error: 'audit plugin is disabled' });
    }
    // …while a path NO plugin declares stays a plain 404: '/ledgerfoo' must not ride the '/ledger' mount.
    expect((await app.request('/ledgerfoo')).status).toBe(404);
    // Core surfaces that outlive any plugin keep serving: instance spend folds in chat usage, and
    // the maintenance wipe still clears the activity feed.
    expect((await app.request('/usage/by-model')).status).toBe(200);
    expect(await (await app.request('/usage/by-day')).json()).toEqual([]);
    const cleanup = await app.request('/admin/cleanup', { method: 'POST' });
    expect(cleanup.status).toBe(200);
    // …and it reports zero task rows rather than claiming it removed any.
    expect(await cleanup.json()).toMatchObject({ ok: true, tasks: 0, missions: 0 });
  });

  // The maintenance wipe is CORE-owned and irreversible, and the operator reads its answer as fact.
  // With the owner gone the rows are still THERE (disabling a plugin drops no table), so reporting
  // `{ok:true, tasks:0}` over a populated register is the dishonest-success shape the whole extraction
  // forbids: the operator sees "wiped", and re-enabling the plugin brings the entire register back.
  // Core's own doctrine (store/db.ts tolerateMissingPluginTables, store/cascade.ts) is that a
  // destructive CORE path purges plugin rows whether or not the plugin is loaded.
  it('still wipes the plugin rows a disabled owner left behind — and counts them', async () => {
    const { app, db } = await makeApp(false);
    try {
      db.prepare("INSERT INTO tasks (id,project_id,title,type) VALUES ('e-1',1,'Epic','epic')").run();
      db.prepare("INSERT INTO tasks (id,project_id,title,parent_id) VALUES ('t-1',1,'Child','e-1')").run();
      db.prepare("INSERT INTO task_deps (task_id,depends_on_id) VALUES ('t-1','e-1')").run();
      // A settled mission: 'disengaged' so the live-mission teardown gate (which would 503 with no
      // engine) is not what this test measures.
      db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-e-1','e-1','low','disengaged')").run();
      db.prepare("INSERT INTO mission_pr (mission_id,branch,worktree) VALUES ('m-e-1','b','/w')").run();
      db.prepare("INSERT INTO notes (scope,target,body) VALUES ('handoff','e-1','n')").run();
      db.prepare("INSERT INTO task_usage (task_id,project_id,exec) VALUES ('t-1',1,'x')").run();

      const res = await app.request('/admin/cleanup', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, tasks: 2, missions: 1 });
      const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
      for (const t of ['tasks', 'task_deps', 'missions', 'mission_pr', 'notes']) {
        expect(`${t} rows left → ${count(t)}`).toBe(`${t} rows left → 0`);
      }
    } finally { db.close(); }
  });

  // The list above is written by hand, so it can only prove the gate covers what somebody remembered
  // to put in it. This derives the family from the ROUTER — every path the owner actually registers —
  // so a route added tomorrow outside the gate's patterns turns this red instead of quietly falling
  // through to a bare 404, i.e. "no such endpoint" where "the plugin is off" belongs.
  it('covers every path the owner registers — not just the ones somebody listed', async () => {
    const owned = await makeApp(true);
    const registered = [...owned.registry.rootApiRoutes]
      .filter(([, entry]) => entry.plugin === 'ledger')
      .flatMap(([mount, entry]) => entry.routes.map((r) => ({ method: r.method ?? 'GET', path: mount })));
    owned.db.close();
    expect(registered.length).toBeGreaterThan(10); // the plugin really did register the family

    const { app, db } = await makeApp(false);
    try {
      for (const { method, path } of registered) {
        const res = await app.request(concrete(path), { method, headers: { 'content-type': 'application/json' }, ...withBody(method) });
        expect(`${method} ${concrete(path)} → ${res.status}`).toBe(`${method} ${concrete(path)} → 503`);
      }
    } finally { db.close(); }
  });

  it('serves the same paths normally as soon as the domain has an owner', async () => {
    const { app } = await makeApp(true);
    const list = await app.request('/ledger');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    const created = await app.request('/ledger', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Real record' }),
    });
    expect(created.status).toBe(201);
    expect((await (await app.request('/ledger')).json() as unknown[])).toHaveLength(1);
  });
});
