import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import type { PluginElowenCli, PluginHostStores } from '../../src/plugins/api.js';

// The WIRING is the protection here. `ctx.host.stores().tasks` is what an extracted subsystem (agents)
// reads on every tick, and it must resolve THE CURRENT OWNER of the task domain — the plugin that
// registered the `tasks` control — rather than an instance captured when the plugin was loaded. Pinning
// the daemon's own store back into that slot would keep every unit test of the seam green while a plugin
// that owns the domain silently served nobody, and a reload that swapped owners would go unnoticed.
describe('buildBrainCore plugin-host wiring', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete (globalThis as { __hostStores?: unknown }).__hostStores;
    delete (globalThis as { __hostCli?: unknown }).__hostCli;
  });

  /** Boot a core against a throwaway bundled-plugin dir holding exactly one plugin. */
  async function bootWith(pluginBody: string, bootstrap: { username: string; password: string } | null = null) {
    dir = mkdtempSync(join(tmpdir(), 'elowen-hostwiring-'));
    const pluginsDir = join(dir, 'plugins');
    const pluginDir = join(pluginsDir, 'probe');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'elowen-plugin.json'), JSON.stringify({
      name: 'probe', version: '0.1.0', apiVersion: '1', description: 'probe', entry: 'index.mjs',
      capabilities: { reads: ['stores', 'elowen-cli'], mutates: ['events'] },
    }));
    writeFileSync(join(pluginDir, 'index.mjs'), pluginBody);
    const core = await buildBrainCore({
      dbPath: join(dir, 'elowen.db'),
      project: { id: 1, slug: 'wiring', path: dir },
      tmux: new FakeTmuxDriver(),
      bootstrap,
      pluginDirs: [pluginsDir, join(dir, 'user-plugins')],
    });
    core.config.update({ plugins: { enabled: ['probe'] } });
    await core.pluginProvider.get();
    const captured = globalThis as { __hostStores?: PluginHostStores; __hostCli?: PluginElowenCli };
    return { core, captured };
  }

  /** The store seam the probe captured (it always captures one — a missing capture is the test's own bug). */
  const storesOf = (captured: { __hostStores?: PluginHostStores }): PluginHostStores => {
    if (!captured.__hostStores) throw new Error('the probe plugin never captured the store seam');
    return captured.__hostStores;
  };

  it('serves the task domain from the plugin that OWNS it, not from the daemon store', async () => {
    const { core, captured } = await bootWith(`export function register(ctx){
      ctx.registerControl('tasks', {
        store: () => ({ get: () => 'from-the-owner' }),
        readiness: () => ({ ready: () => ['ready-from-the-owner'] }),
        usage: () => ({ deleteAll: () => 42 }),
      });
      globalThis.__hostStores = ctx.host.stores();
    }`);
    const stores = storesOf(captured);
    try {
      // A real row exists in the daemon's own table — so reading the owner's answer instead of this one
      // is what proves the seam resolves through the control rather than through the database.
      core.db.prepare("INSERT INTO tasks (id, project_id, title) VALUES ('elowen-1', 1, 'core row')").run();
      expect(stores.tasksAvailable()).toBe(true);
      expect(stores.tasks.get('elowen-1') as unknown).toBe('from-the-owner');
      expect(stores.readiness.ready(1) as unknown).toEqual(['ready-from-the-owner']);
      expect(stores.taskUsage.deleteAll()).toBe(42);
    } finally { core.db.close(); }
  });

  it('refuses to answer the task domain at all while no plugin owns it', async () => {
    // The daemon has NO task store of its own any more. With the domain unowned the seam must say so —
    // loudly. Answering "no such task" from a table the daemon can still see would let a consumer that
    // never asked `tasksAvailable()` report an empty working set as fact and, worse, act on it.
    const { core, captured } = await bootWith(`export function register(ctx){
      globalThis.__hostStores = ctx.host.stores();
    }`);
    const stores = storesOf(captured);
    try {
      core.db.prepare("INSERT INTO tasks (id, project_id, title) VALUES ('elowen-2', 1, 'core row')").run();
      expect(stores.tasksAvailable()).toBe(false);
      expect(() => stores.tasks.get('elowen-2')).toThrow(/tasks domain is unavailable/);
      expect(() => stores.readiness.ready(1)).toThrow(/tasks domain is unavailable/);
      expect(() => stores.taskUsage.deleteAll()).toThrow(/tasks domain is unavailable/);
    } finally { core.db.close(); }
  });

  it('shapes a task conversation host-side, from the session name the daemon owns', async () => {
    // The transcript of an embedded worker run is addressed by the daemon's OWN session convention
    // (`brain-task-<id>`) and rendered by the message view chat shares. A plugin serving that route asks
    // for a TASK's conversation; if it had to spell the session id itself, a rename of the convention
    // would silently start answering an empty transcript for every task.
    const { core, captured } = await bootWith(`export function register(ctx){
      globalThis.__hostStores = ctx.host.stores();
    }`);
    const stores = storesOf(captured);
    try {
      core.brainStore.appendMessage({ id: 'm1', sessionId: 'brain-task-t9', parentId: null, role: 'user', content: { content: 'do the thing' } });
      const shaped = stores.taskConversation?.('t9') ?? [];
      expect(shaped).toHaveLength(1);
      expect(JSON.stringify(shaped)).toContain('do the thing');
      // A task with no embedded run has no transcript — an empty list, exactly what a CLI-run task gives.
      expect(stores.taskConversation?.('t-never-ran')).toEqual([]);
    } finally { core.db.close(); }
  });

  it('purges the activity rows of one target, and only that target', async () => {
    // The delete twin of publishing: a plugin removing the row an activity history describes must be
    // able to take the history with it, or the feed keeps pointing at something that no longer exists.
    const { core } = await bootWith(`export function register(ctx){
      globalThis.__hostCtx = ctx;
    }`);
    const ctx = (globalThis as { __hostCtx?: { deleteEventsForTarget(target: string): void } }).__hostCtx;
    if (!ctx) throw new Error('the probe plugin never captured its context');
    try {
      core.events.record({ type: 'task', taskId: 't9', status: 'closed' });
      core.events.record({ type: 'task', taskId: 't10', status: 'closed' });
      ctx.deleteEventsForTarget('t9');
      expect(core.events.list({ target: 't9' })).toEqual([]);
      expect(core.events.list({ target: 't10' })).toHaveLength(1);
    } finally {
      delete (globalThis as { __hostCtx?: unknown }).__hostCtx;
      core.db.close();
    }
  });

  // A plugin that takes over a surface which always ran with the USER'S OWN rights (the Elowen* control
  // tools) needs the user's own credential. Handing it the shared agent token instead would look like it
  // works — the calls succeed — while silently running under a different scope and tenancy.
  it('mints a plugin a token that IS the user, distinct from the shared agent token', async () => {
    const { core, captured } = await bootWith(
      `export function register(ctx){ globalThis.__hostCli = ctx.host.elowenCli(); }`,
      { username: 'owner', password: 'pw-for-test-only' },
    );
    const cli = captured.__hostCli;
    if (!cli) throw new Error('the probe plugin never captured the CLI seam');
    try {
      const owner = core.users.list()[0]!;
      const token = cli.tokenForUser(owner.id);
      expect(token).toBeTruthy();
      // It resolves to that user at FULL scope — an agent-scoped token would be a different principal,
      // restricted to its own task and unable to act for the user at all.
      const principal = core.users.principalForToken(token!);
      expect(principal?.user.id).toBe(owner.id);
      expect(principal?.scope).toBe('full');
      expect(token).not.toBe(cli.token);
      expect(core.users.principalForToken(cli.token)?.scope).toBe('agent');
      // Reused within its TTL rather than re-minted per call (a token row per tool call would grow the
      // table without bound and defeat the restart-survival the core path relies on).
      expect(cli.tokenForUser(owner.id)).toBe(token);
      // An id with no user row gets nothing — never a token attributed to a ghost.
      expect(cli.tokenForUser(9999)).toBeUndefined();
    } finally { core.db.close(); }
  });
});
