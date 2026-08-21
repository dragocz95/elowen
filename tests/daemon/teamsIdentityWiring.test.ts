import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { TeamsIdConflictError } from '../../src/store/userSettingStore.js';

interface LinkedUser { id: number; name: string; username?: string; admin: boolean }
type ResolvePlatformUser = (platform: string, platformUserId: string, verifiedEmail?: string) => LinkedUser | null;

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'elowen-teams-identity-'));
  dirs.push(dir);
  const pluginsDir = join(dir, 'plugins');
  mkdirSync(pluginsDir);
  const core = await buildBrainCore({
    dbPath: join(dir, 'elowen.db'),
    project: { id: 1, slug: 'identity', path: dir },
    tmux: new FakeTmuxDriver(),
    bootstrap: { username: 'owner', password: 'pw' },
    pluginDirs: [pluginsDir],
  });
  const owner = core.users.list()[0]!;
  const bob = core.users.create('bob', 'pw');
  const resolve = (core.brain as unknown as { d: { resolvePlatformUser: ResolvePlatformUser } }).d.resolvePlatformUser;
  return { core, owner, bob, resolve };
}

describe('buildBrainCore Microsoft Teams identity resolution', () => {
  it('lets an explicit Teams id link win over a verified e-mail match', async () => {
    const { core, owner, bob, resolve } = await setup();
    try {
      core.users.setProfile(owner.id, { email: 'owner@example.com' });
      core.users.setProfile(bob.id, { email: 'bob@example.com' });
      core.userSettings.setCliSettings(owner.id, { msteamsUserId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      expect(resolve('msteams', 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', 'bob@example.com')).toMatchObject({ id: owner.id });
    } finally { core.db.close(); }
  });

  it('bootstraps a unique normalized verified UPN once, then the explicit link survives e-mail changes', async () => {
    const { core, owner, bob, resolve } = await setup();
    try {
      core.users.setProfile(owner.id, { email: ' Owner@Example.com ' });
      const teamsId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      expect(resolve('msteams', teamsId, ' owner@example.COM ')).toMatchObject({ id: owner.id });
      expect(core.userSettings.cliSettings(owner.id).msteamsUserId).toBe(teamsId);

      core.users.setProfile(owner.id, { email: 'new-owner@example.com' });
      core.users.setProfile(bob.id, { email: 'owner@example.com' });
      expect(resolve('msteams', teamsId, 'owner@example.com')).toMatchObject({ id: owner.id });
    } finally { core.db.close(); }
  });

  it('resolves neither duplicate nor absent/unverified e-mail evidence', async () => {
    const { core, owner, bob, resolve } = await setup();
    try {
      core.db.exec('DROP INDEX idx_users_email_normalized');
      core.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(' duplicate@example.com ', owner.id);
      core.db.prepare('UPDATE users SET email = ? WHERE id = ?').run('DUPLICATE@example.com', bob.id);
      expect(resolve('msteams', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'duplicate@example.com')).toBeNull();
      expect(resolve('msteams', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff')).toBeNull();
      expect(resolve('msteams', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', '   ')).toBeNull();
    } finally { core.db.close(); }
  });

  it('fails closed when the TOFU link loses the unique-id race', async () => {
    const { core, owner, resolve } = await setup();
    try {
      core.users.setProfile(owner.id, { email: 'owner@example.com' });
      const original = core.userSettings.setCliSettings.bind(core.userSettings);
      core.userSettings.setCliSettings = ((userId, patch) => {
        if (patch.msteamsUserId) throw new TeamsIdConflictError(patch.msteamsUserId);
        original(userId, patch);
      }) as typeof core.userSettings.setCliSettings;
      expect(resolve('msteams', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'owner@example.com')).toBeNull();
      expect(core.userSettings.cliSettings(owner.id).msteamsUserId).toBe('');
    } finally { core.db.close(); }
  });
});
