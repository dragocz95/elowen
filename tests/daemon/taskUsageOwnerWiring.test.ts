import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { applyWorkMigrations } from '../helpers/workDb.js';
import type { BrainStore } from '../../src/store/brainStore.js';

/** The usage views hide a `brain-task-*` worker's spend when the same task is already snapshotted in
 *  `task_usage` — otherwise /usage/* would count that money twice, once from each half. The exclusion
 *  therefore has to be keyed on whether the SNAPSHOT HALF ACTUALLY CONTRIBUTES, i.e. whether the task
 *  domain has an owner. Keying it on the mere existence of the table meant that disabling the work
 *  plugin (which drops no table) removed the spend from BOTH halves at once: the route contributes no
 *  snapshots and the brain half filtered its rows away, so real money silently left the stats. */
describe('the usage views on a daemon whose task domain has no owner', () => {
  let dir: string;
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const usageMsg = (store: BrainStore, session: string, id: string, total: number) =>
    store.appendMessage({
      id, sessionId: session, parentId: null, role: 'assistant',
      content: {
        role: 'assistant', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: total },
      },
    });

  it('keeps task-worker spend visible while the snapshot half contributes nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-usageowner-'));
    const core = await buildBrainCore({
      dbPath: join(dir, 'elowen.db'),
      project: { id: 1, slug: 'usage', path: dir },
      tmux: new FakeTmuxDriver(),
      bootstrap: null,
      pluginDirs: [join(dir, 'plugins')],
    });
    try {
      // The work plugin is NOT loaded, but its tables are here — exactly what disabling it leaves
      // behind on an instance that had been using it.
      applyWorkMigrations(core.db);
      expect(core.tasksDomain()).toBeUndefined();
      core.db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'p','/p')").run();
      core.db.prepare("INSERT INTO task_usage (task_id, project_id, exec, total) VALUES ('9', 2, 'elowen:claude-opus-4-8', 500)").run();

      const store = core.brainStore;
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg(store, 'brain-a', 'm1', 100);
      store.createSession({ id: 'brain-task-9', userId: 1, model: 'claude-opus-4-8' });
      usageMsg(store, 'brain-task-9', 't1', 40);

      // 140, not 100: nobody else reports the worker's 40 while the domain is unowned, so hiding it
      // here would make it disappear from the instance's spend altogether.
      expect(store.usageByModel(1).map((r) => r.usage.total)).toEqual([140]);
      expect(store.usageByDay(1).reduce((n, d) => n + d.tokens, 0)).toBe(140);
    } finally { core.db.close(); }
  });

  it('still excludes the snapshotted worker once a plugin owns the domain', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-usageowner-on-'));
    const pluginsDir = join(dir, 'plugins');
    const pluginDir = join(pluginsDir, 'probe');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'elowen-plugin.json'), JSON.stringify({
      name: 'probe', version: '0.1.0', apiVersion: '1', description: 'probe', entry: 'index.mjs',
      capabilities: { reads: ['stores'], mutates: [] },
    }));
    // A minimal owner of the `tasks` domain: the exclusion only asks whether the snapshot half is there.
    writeFileSync(join(pluginDir, 'index.mjs'), `export function register(ctx){
      ctx.registerControl('tasks', { store: () => ({}), usage: () => ({}), readiness: () => ({}) });
    }`);
    const core = await buildBrainCore({
      dbPath: join(dir, 'elowen.db'),
      project: { id: 1, slug: 'usage', path: dir },
      tmux: new FakeTmuxDriver(),
      bootstrap: null,
      pluginDirs: [pluginsDir, join(dir, 'user-plugins')],
    });
    try {
      applyWorkMigrations(core.db);
      core.config.update({ plugins: { enabled: ['probe'] } });
      await core.pluginProvider.get();
      expect(core.tasksDomain()).toBeDefined();
      core.db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'p','/p')").run();
      core.db.prepare("INSERT INTO task_usage (task_id, project_id, exec, total) VALUES ('9', 2, 'elowen:claude-opus-4-8', 500)").run();

      const store = core.brainStore;
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg(store, 'brain-a', 'm1', 100);
      store.createSession({ id: 'brain-task-9', userId: 1, model: 'claude-opus-4-8' });
      usageMsg(store, 'brain-task-9', 't1', 40);

      // 100: the owner's own aggregate reports the worker's spend, so counting it here too would double it.
      expect(store.usageByModel(1).map((r) => r.usage.total)).toEqual([100]);
    } finally { core.db.close(); }
  });
});
