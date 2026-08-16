import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/daemon/bootstrap.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { openDb } from '../../src/store/db.js';
import { dbWithPlugins } from '../helpers/bootstrapDb.js';
import { MarketplaceService } from '../../src/plugins/marketplace.js';
import { BrainService } from '../../src/brain/brainService.js';
import { fixturePlugins, type FixturePluginSpec } from '../helpers/fixturePlugin.js';

const tempDirs = new Set<string>();
beforeEach(() => { vi.spyOn(MarketplaceService.prototype, 'reconcileEnabled').mockResolvedValue([]); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect([...tempDirs].filter(existsSync), 'bootstrap tests recreated temporary directories after cleanup').toEqual([]);
});

/** A domain plugin in the only shape this file cares about: it owns a root mount of its own, declared in
 *  the manifest and registered by the entry. The subject is the DAEMON's composition — that buildApp
 *  puts a plugin's root mount on the real app, and what that mount answers when the plugin is not
 *  enabled — so it is a fixture rather than whichever product plugin happens to sit in plugins/. The
 *  tests used to ride on the agents plugin's /sessions; that plugin has moved to the registry, and
 *  pinning them to another one would only queue up the same breakage.
 *
 *  '/ledger' is deliberately a name core does not serve, so a 404 means "no such route" and nothing else. */
const LEDGER: FixturePluginSpec = {
  name: 'ledger',
  provides: { apiRoutes: ['/ledger'] },
  register: "ctx.registerApiRoute({ rootMount: '/ledger', path: '', access: 'user', handler: async () => ({ body: { entries: [] } }) });",
};

describe('buildApp', () => {
  it('wires a healthy app with an injected tmux fake', async () => {
    // A root mount only exists on an install whose owner enabled the plugin that declares it, so the
    // database is seeded that way and the loader is pointed at the fixture. /health is core.
    const plugin = fixturePlugins([LEDGER]);
    const { dbPath, dir, cleanup } = dbWithPlugins(['ledger']);
    tempDirs.add(dir);
    try {
      const { app } = await buildApp({ dbPath, tmux: new FakeTmuxDriver(), project: { id: 1, slug: 'elowen', path: '/o' }, relay: null, allowOpen: true, pluginDirs: [plugin.dir] });
      expect((await app.request('/health')).status).toBe(200);
      const ledger = await app.request('/ledger');
      expect(ledger.status).toBe(200);
      // Served by the PLUGIN, not by an empty core stub that happens to answer 200.
      expect(await ledger.json()).toEqual({ entries: [] });
    } finally { cleanup(); plugin.cleanup(); }
  });

  it('does not start plugin platforms until the boot marketplace reconcile settles', async () => {
    const { dbPath, dir, cleanup } = dbWithPlugins([]);
    tempDirs.add(dir);
    let settleReconcile!: (restored: string[]) => void;
    const reconcilePending = new Promise<string[]>((resolve) => { settleReconcile = resolve; });
    const reconcile = vi.spyOn(MarketplaceService.prototype, 'reconcileEnabled').mockReturnValue(reconcilePending);
    const startPlatforms = vi.spyOn(BrainService.prototype, 'startPlatforms').mockResolvedValue();
    let stopLoops: (() => void) | undefined;
    try {
      const built = await buildApp({
        dbPath,
        tmux: new FakeTmuxDriver(),
        project: { id: 1, slug: 'elowen', path: '/o' },
        relay: null,
        allowOpen: true,
        pluginDirs: [join(process.cwd(), 'plugins')],
      });
      expect(reconcile).toHaveBeenCalledOnce();

      stopLoops = built.startLoops();
      expect(startPlatforms).not.toHaveBeenCalled();

      settleReconcile([]);
      await vi.waitFor(() => expect(startPlatforms).toHaveBeenCalledOnce());
    } finally {
      settleReconcile([]);
      stopLoops?.();
      cleanup();
    }
  });

  it('reports a deferred plugin apply as deferred, and hangs the marketplace settle off the real one', async () => {
    // A reload the daemon parked while work was running used to be turned into a throw here, which the
    // marketplace could only read as "the daemon cannot run this version" — so it rolled the install back.
    // Every install triggered from a conversation hit exactly that, because the work being waited on was
    // the turn asking for the install. The outcome is reported as itself now, and the deferred half is
    // finished by the brain's post-apply hook.
    const { dbPath, dir, cleanup } = dbWithPlugins(['files']);
    tempDirs.add(dir);
    type ReloadFn = () => Promise<'applied' | 'deferred'>;
    let marketplaceReload!: ReloadFn;
    let loadedNames!: () => Promise<ReadonlySet<string>>;
    vi.spyOn(MarketplaceService.prototype, 'reconcileEnabled').mockImplementation(function () {
      const opts = (this as unknown as { opts: { reload: ReloadFn; loadedNames: typeof loadedNames } }).opts;
      marketplaceReload = opts.reload;
      loadedNames = opts.loadedNames;
      return Promise.resolve([]);
    });
    let brain: BrainService | undefined;
    let swapped = true;
    const reloadPlugins = vi.spyOn(BrainService.prototype, 'reloadPlugins')
      .mockImplementation(async function (this: BrainService) { brain = this; return swapped; });
    const settle = vi.spyOn(MarketplaceService.prototype, 'settleDeferredApplies').mockResolvedValue();
    try {
      await buildApp({
        dbPath,
        tmux: new FakeTmuxDriver(),
        project: { id: 1, slug: 'elowen', path: '/o' },
        relay: null,
        allowOpen: true,
        pluginDirs: [join(process.cwd(), 'plugins')],
      });

      swapped = false;
      await expect(marketplaceReload()).resolves.toBe('deferred');
      swapped = true;
      await expect(marketplaceReload()).resolves.toBe('applied');
      expect(reloadPlugins).toHaveBeenCalledTimes(2);

      // The proof the marketplace drops a rollback copy on comes from the LIVE registry, not from a
      // value the caller passed in — the plugin this install enables is in it.
      expect([...await loadedNames()]).toContain('files');

      // …and the post-apply hook the brain fires is the marketplace's settle, so a parked install is
      // judged the moment a reload really lands.
      expect(settle).not.toHaveBeenCalled();
      await brain?.afterPluginsApplied?.();
      expect(settle).toHaveBeenCalledOnce();
    } finally {
      cleanup();
    }
  });

  it('a fresh install serves core but answers 503 on a domain plugin\'s root mount (nothing 404s)', async () => {
    // The bare-assistant default enables no domain plugin, but a DISCOVERABLE one's mount still exists:
    // the daemon knows the route belongs to a plugin and reports that plugin as inactive, rather than
    // letting it look like a missing endpoint. 404 here would tell the CLI, the web UI and a spawned
    // agent that this build has no such feature at all.
    const plugin = fixturePlugins([LEDGER], []); // present on disk, enabled by nobody
    // A database file that does not exist yet — buildApp creates it, so there is no settings row and the
    // fresh-install defaults are what actually decide. On disk rather than ':memory:' because the
    // marketplace cache is placed next to the database (bootstrap.ts → dirname(dbPath)), and ':memory:'
    // has no directory: its cache, and the clone temp dir beside it, land in the process CWD instead.
    const dir = mkdtempSync(join(tmpdir(), 'elowen-fresh-install-'));
    tempDirs.add(dir);
    try {
      const { app } = await buildApp({ dbPath: join(dir, 'elowen.db'), tmux: new FakeTmuxDriver(), project: { id: 1, slug: 'elowen', path: '/o' }, relay: null, allowOpen: true, pluginDirs: [plugin.dir] });
      expect((await app.request('/health')).status).toBe(200);
      const off = await app.request('/ledger');
      expect(off.status).toBe(503);
      expect(await off.json()).toEqual({ error: 'ledger plugin is disabled' });
      // The gate is scoped to DECLARED mounts: a neighbouring path nobody declares stays a plain 404.
      expect((await app.request('/ledgerfoo')).status).toBe(404);
    } finally { plugin.cleanup(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('resolves the daemon home project by path instead of locking id 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-home-project-'));
    tempDirs.add(dir);
    const dbPath = join(dir, 'elowen.db');
    try {
      const db = openDb(dbPath);
      db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/var/www/orca')").run();
      db.prepare("INSERT INTO projects (id,slug,path) VALUES (9,'Elowen','/var/www/elowen')").run();
      db.close();

      const { app } = await buildApp({
        dbPath,
        tmux: new FakeTmuxDriver(),
        project: { id: 1, slug: 'elowen', path: '/var/www/elowen' },
        relay: null,
        bootstrap: { username: 'admin', password: 'pass' },
        allowOpen: true,
      });
      const login = await (await app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'pass' }),
      })).json() as { token: string };
      const auth = { headers: { authorization: `Bearer ${login.token}` } };

      expect((await app.request('/projects/1', { method: 'DELETE', ...auth })).status).toBe(200);
      expect((await app.request('/projects/9', { method: 'DELETE', ...auth })).status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
