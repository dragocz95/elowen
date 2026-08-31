import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import type { PluginElowenCli, PluginHostExternalUsers, PluginHostStores } from '../../src/plugins/api.js';

describe('buildBrainCore plugin-host wiring', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete (globalThis as { __hostStores?: unknown }).__hostStores;
    delete (globalThis as { __hostCli?: unknown }).__hostCli;
    delete (globalThis as { __hostExternalUsers?: unknown }).__hostExternalUsers;
  });

  /** Boot a core against a throwaway bundled-plugin dir holding exactly one plugin. */
  async function bootWith(pluginBody: string, bootstrap: { username: string; password: string } | null = null) {
    dir = mkdtempSync(join(tmpdir(), 'elowen-hostwiring-'));
    const pluginsDir = join(dir, 'plugins');
    const pluginDir = join(pluginsDir, 'probe');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'elowen-plugin.json'), JSON.stringify({
      name: 'probe', version: '0.1.0', apiVersion: '1', description: 'probe', entry: 'index.mjs', userGrantable: true,
      capabilities: { reads: ['stores', 'elowen-cli'], mutates: ['events', 'users'] },
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
    const captured = globalThis as {
      __hostStores?: PluginHostStores;
      __hostCli?: PluginElowenCli;
      __hostExternalUsers?: PluginHostExternalUsers;
    };
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

  it('hands a plugin the display name and avatar, so a plugin page can draw a person', async () => {
    // Asserted against the REAL wiring rather than a stub of it. Every other test of this seam builds its
    // own `usersRead` object, so all of them kept passing while the actual mapping dropped both fields —
    // and a plugin page therefore drew a monogram for someone who had uploaded a photo.
    const { core, captured } = await bootWith(
      `export function register(ctx){ globalThis.__hostStores = ctx.host.stores(); }`,
      { username: 'owner', password: 'pw-for-test-only' },
    );
    const stores = captured.__hostStores;
    if (!stores) throw new Error('the probe plugin never captured the stores seam');
    try {
      const owner = core.users.list()[0]!;
      core.users.setProfile(owner.id, { name: 'Filip Džudža' });
      core.users.setAvatar(owner.id, `${owner.id}.png`);

      expect(stores.usersRead.list().find((u) => u.id === owner.id)).toEqual({
        id: owner.id, username: 'owner', name: 'Filip Džudža', avatar: `${owner.id}.png`, isAdmin: true,
      });
    } finally { core.db.close(); }
  });

  it('applies the Microsoft template when a Teams plugin provisions a new account through the host seam', async () => {
    const { core, captured } = await bootWith(
      `export function register(ctx){ globalThis.__hostExternalUsers = ctx.host.externalUsers(); }`,
      { username: 'owner', password: 'pw-for-test-only' },
    );
    const externalUsers = captured.__hostExternalUsers;
    if (!externalUsers) throw new Error('the probe plugin never captured the external-users seam');
    try {
      core.db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'shared','/shared')").run();
      core.config.update({ plugins: { config: { msteams: {
        ssoDefaultProjects: ['2'],
        ssoDefaultPlugins: ['probe'],
        ssoAllowedTools: ['MemorySearch'],
        ssoDefaultYolo: true,
      } } } });

      const result = await externalUsers.linkOrProvision({
        provider: 'msteams', tenantId: 'tenant', subjectId: 'subject',
        preferredUsername: 'new.person', name: 'New Person', email: 'new@example.test',
      });
      const user = core.users.get(result.user.id)!;

      expect(result.created).toBe(true);
      expect(core.userProjects.forUser(user.id)).toEqual([2]);
      expect(user.granted_plugins).toEqual(['probe']);
      expect(user.allowed_tools).toEqual(['MemorySearch']);
      expect(core.userSettings.permissionSettings(user.id).yolo).toBe(true);
    } finally { core.db.close(); }
  });
});
