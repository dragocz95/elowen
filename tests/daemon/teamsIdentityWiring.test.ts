import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { PlatformLinkConflictError } from '../../src/store/userSettingStore.js';

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

  // Signing in writes an external-identity binding and NOTHING else. If the inbound resolver does not read
  // that binding, the only bridge left is the e-mail match — so a person whose profile mail differs from the
  // roster UPN stays unlinked after a successful sign-in and runs with no account at all.
  it('resolves the OAuth binding a sign-in created, even when no e-mail evidence matches', async () => {
    const { core, bob, resolve } = await setup();
    try {
      core.users.setProfile(bob.id, { email: 'bob@example.com' });
      const subject = '11111111-2222-3333-4444-555555555555';
      const linked = core.users.linkExternalIdentity({
        provider: 'msteams', tenantId: 'tenant-1', subjectId: subject,
        preferredUsername: 'bob.novak', name: 'Bob Novák', email: 'bob.novak@contoso.onmicrosoft.com',
      });
      // The account's stored address then diverges from the UPN the roster reports — a rename, or simply an
      // `…onmicrosoft.com` UPN against a real mail address. From here the e-mail match can never succeed, so
      // the binding is the ONLY thing that can still resolve this person.
      core.users.setProfile(linked.user.id, { email: 'bob.novak@contoso.cz' });
      expect(core.users.userByUniqueEmail('bob.novak@contoso.onmicrosoft.com')).toBeNull();

      expect(resolve('msteams', subject.toUpperCase(), 'bob.novak@contoso.onmicrosoft.com'))
        .toMatchObject({ id: linked.user.id });
      expect(resolve('msteams', subject, undefined)).toMatchObject({ id: linked.user.id });
    } finally { core.db.close(); }
  });

  it('refuses a subject two tenants both claim, rather than picking one', async () => {
    const { core, owner, bob, resolve } = await setup();
    try {
      const subject = '99999999-8888-7777-6666-555555555555';
      core.users.linkExistingExternalIdentity({ provider: 'msteams', tenantId: 'tenant-a', subjectId: subject, userId: owner.id });
      core.users.linkExistingExternalIdentity({ provider: 'msteams', tenantId: 'tenant-b', subjectId: subject, userId: bob.id });
      expect(resolve('msteams', subject, undefined)).toBeNull();
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
      core.userSettings.setPlatformLink = ((_userId: number, platform: string, value: string) => {
        throw new PlatformLinkConflictError(platform, 'msteamsUserId', value, 'conflict');
      }) as typeof core.userSettings.setPlatformLink;
      expect(resolve('msteams', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'owner@example.com')).toBeNull();
      expect(core.userSettings.cliSettings(owner.id).msteamsUserId).toBe('');
    } finally { core.db.close(); }
  });
});

describe('buildBrainCore descriptor-driven platform identity', () => {
  // The bug this phase closes: Telegram was supported end to end in the daemon but had no account-view
  // field, so no Telegram sender could ever be linked and every Telegram turn was dropped unattributed
  // (platforms.ts refuses a human platform sender with no account). A linked sender must RESOLVE.
  it('resolves a linked Telegram sender through the same path as every other platform', async () => {
    const { core, bob, resolve } = await setup();
    try {
      core.userSettings.setCliSettings(bob.id, { telegramUserId: '123456789' });
      expect(resolve('telegram', '123456789')).toMatchObject({ id: bob.id });
      // The adapter may report the id with decoration; the descriptor's normalize is what makes the
      // sender and the stored link the same string.
      expect(resolve('telegram', ' 123456789 ')).toMatchObject({ id: bob.id });
      expect(resolve('telegram', '987654321')).toBeNull();
    } finally { core.db.close(); }
  });

  it('carries a WhatsApp JID onto the stored number', async () => {
    const { core, bob, resolve } = await setup();
    try {
      core.userSettings.setCliSettings(bob.id, { whatsappNumber: '+420 778 433 908' });
      expect(resolve('whatsapp', '420778433908@s.whatsapp.net')).toMatchObject({ id: bob.id });
      expect(resolve('whatsapp', '420778433908:12@s.whatsapp.net')).toMatchObject({ id: bob.id });
    } finally { core.db.close(); }
  });

  // Only a platform whose descriptor EARNS a bootstrap may self-link. Discord/Telegram/WhatsApp report a
  // sender id and no third-party evidence, so verified-looking e-mail must not bind them to an account.
  it('never self-links a platform without a bootstrap, however good the e-mail evidence looks', async () => {
    const { core, owner, resolve } = await setup();
    try {
      core.users.setProfile(owner.id, { email: 'owner@example.com' });
      for (const platform of ['discord', 'telegram', 'whatsapp']) {
        expect(resolve(platform, '123456789012345', 'owner@example.com')).toBeNull();
      }
      expect(core.userSettings.cliSettings(owner.id).discordUserId).toBe('');
      expect(core.userSettings.cliSettings(owner.id).telegramUserId).toBe('');
    } finally { core.db.close(); }
  });

  // A platform with no identity descriptor resolves to NOBODY. Anything else would let an unknown
  // adapter name pick up whichever account happened to hold a matching value under another key.
  it('resolves an unknown platform to nobody', async () => {
    const { core, bob, resolve } = await setup();
    try {
      core.userSettings.setCliSettings(bob.id, { telegramUserId: '123456789' });
      expect(resolve('signal', '123456789')).toBeNull();
      expect(resolve('', '123456789')).toBeNull();
    } finally { core.db.close(); }
  });
});
