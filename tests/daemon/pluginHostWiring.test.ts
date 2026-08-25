import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import type { PluginElowenCli, PluginHostStores } from '../../src/plugins/api.js';

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

  it('purges the activity rows of one target, and only that target', async () => {
    // The delete twin of publishing: a plugin removing the row an activity history describes must be
    // able to take the history with it, or the feed keeps pointing at something that no longer exists.
    const { core } = await bootWith(`export function register(ctx){
      globalThis.__hostCtx = ctx;
    }`);
    const ctx = (globalThis as { __hostCtx?: { deleteEventsForTarget(target: string): void } }).__hostCtx;
    if (!ctx) throw new Error('the probe plugin never captured its context');
    try {
      core.events.record({ type: 'plugin', plugin: 'probe', kind: 't9' });
      core.events.record({ type: 'plugin', plugin: 'probe', kind: 't10' });
      ctx.deleteEventsForTarget('t9');
      expect(core.events.list({ target: 't9' })).toEqual([]);
      expect(core.events.list({ target: 't10' })).toHaveLength(1);
    } finally {
      delete (globalThis as { __hostCtx?: unknown }).__hostCtx;
      core.db.close();
    }
  });

  it('mints a plugin a token that acts as exactly one real user', async () => {
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
      // It resolves to that user at full scope; no shared or synthetic principal is substituted.
      const principal = core.users.principalForToken(token!);
      expect(principal?.user.id).toBe(owner.id);
      expect(principal?.scope).toBe('full');
      // Reused within its TTL rather than re-minted per call (a token row per tool call would grow the
      // table without bound and defeat the restart-survival the core path relies on).
      expect(cli.tokenForUser(owner.id)).toBe(token);
      // An id with no user row gets nothing — never a token attributed to a ghost.
      expect(cli.tokenForUser(9999)).toBeUndefined();
    } finally { core.db.close(); }
  });
});
