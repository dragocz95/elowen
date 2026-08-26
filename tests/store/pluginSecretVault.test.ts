import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import {
  PluginSecretCorruptError,
  PluginSecretVault,
  PluginSecretVaultUnavailableError,
  PluginSecretVersionError,
} from '../../src/store/pluginSecretVault.js';
import { UserStore } from '../../src/store/userStore.js';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'elowen-plugin-vault-'));
  roots.push(root);
  const db = openDb(join(root, 'elowen.db'));
  const keyPath = join(root, 'plugin-secrets.key');
  const vault = new PluginSecretVault(db, { keyPath, allowKeyInitialization: true });
  return { root, db, keyPath, vault };
}

describe('PluginSecretVault', () => {
  it('encrypts instance and user values under separate authenticated scopes', () => {
    const { db, vault } = setup();
    expect(vault.instance('github').set('client-secret', 'instance-value')).toBe(1);
    expect(vault.user(7, 'github').set('oauth', 'user-seven')).toBe(1);
    expect(vault.user(8, 'github').set('oauth', 'user-eight')).toBe(1);

    expect(vault.instance('github').get('client-secret')).toEqual({ value: 'instance-value', version: 1 });
    expect(vault.user(7, 'github').get('oauth')).toEqual({ value: 'user-seven', version: 1 });
    expect(vault.user(8, 'github').get('oauth')).toEqual({ value: 'user-eight', version: 1 });
    const raw = db.prepare('SELECT ciphertext FROM plugin_secrets').all() as { ciphertext: Buffer }[];
    expect(Buffer.concat(raw.map((row) => row.ciphertext)).toString('utf8')).not.toContain('user-seven');
  });

  it('authenticates ownership metadata so moving a row to another account fails closed', () => {
    const { db, vault } = setup();
    vault.user(7, 'github').set('oauth', 'user-seven');
    db.prepare("UPDATE plugin_secrets SET owner_id = 8 WHERE scope = 'user' AND owner_id = 7").run();
    expect(() => vault.user(8, 'github').get('oauth')).toThrow(PluginSecretCorruptError);
  });

  it('keeps the vault globally ready when one row is corrupt and isolates that row', () => {
    const { db, keyPath, vault } = setup();
    vault.user(7, 'github').set('oauth', 'broken-later');
    vault.user(8, 'github').set('oauth', 'still-good');
    const row = db.prepare("SELECT ciphertext FROM plugin_secrets WHERE owner_id = 7").get() as { ciphertext: Buffer };
    const changed = Buffer.from(row.ciphertext);
    changed[0] = (changed[0] ?? 0) ^ 0xff;
    db.prepare("UPDATE plugin_secrets SET ciphertext = ? WHERE owner_id = 7").run(changed);

    const reopened = new PluginSecretVault(db, { keyPath, allowKeyInitialization: false });
    expect(reopened.readiness()).toMatchObject({ ready: true, corrupt: [{ ownerId: 7, plugin: 'github', key: 'oauth' }] });
    expect(reopened.user(8, 'github').get('oauth')?.value).toBe('still-good');
    expect(() => reopened.user(7, 'github').get('oauth')).toThrow(PluginSecretCorruptError);
  });

  it('treats a missing or wrong key with encrypted rows as a global failure and never replaces it', () => {
    const missing = setup();
    missing.vault.instance('github').set('client-secret', 'value');
    unlinkSync(missing.keyPath);
    const withoutKey = new PluginSecretVault(missing.db, { keyPath: missing.keyPath, allowKeyInitialization: true });
    expect(withoutKey.readiness()).toMatchObject({ ready: false });
    expect(() => withoutKey.instance('github').get('client-secret')).toThrow(PluginSecretVaultUnavailableError);
    expect(() => readFileSync(missing.keyPath)).toThrow();

    const wrong = setup();
    wrong.vault.instance('github').set('client-secret', 'value');
    writeFileSync(wrong.keyPath, Buffer.alloc(32, 9));
    const mismatched = new PluginSecretVault(wrong.db, { keyPath: wrong.keyPath, allowKeyInitialization: true });
    expect(mismatched.readiness()).toMatchObject({ ready: false });
    expect(readFileSync(wrong.keyPath)).toEqual(Buffer.alloc(32, 9));
  });

  it('lets a runner use initialized key material but never initialize missing material', () => {
    const root = mkdtempSync(join(tmpdir(), 'elowen-plugin-vault-runner-'));
    roots.push(root);
    const db = openDb(join(root, 'elowen.db'));
    const keyPath = join(root, 'plugin-secrets.key');
    const runnerFirst = new PluginSecretVault(db, { keyPath, allowKeyInitialization: false });
    expect(runnerFirst.readiness().ready).toBe(false);
    expect(() => readFileSync(keyPath)).toThrow();

    const daemon = new PluginSecretVault(db, { keyPath, allowKeyInitialization: true });
    daemon.user(3, 'github').set('oauth', 'token');
    const runner = new PluginSecretVault(db, { keyPath, allowKeyInitialization: false });
    expect(runner.readiness().ready).toBe(true);
    expect(runner.user(3, 'github').get('oauth')?.value).toBe('token');
  });

  it('enforces compare-and-swap and hardens key permissions', () => {
    const { root, db, keyPath, vault } = setup();
    const bag = vault.instance('github');
    expect(bag.set('client-secret', 'one', 0)).toBe(1);
    expect(bag.set('client-secret', 'two', 1)).toBe(2);
    expect(() => bag.set('client-secret', 'stale', 1)).toThrow(PluginSecretVersionError);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    chmodSync(keyPath, 0o644);
    new PluginSecretVault(db, { keyPath, allowKeyInitialization: true });
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('deletes user-scoped rows centrally with the account', () => {
    const { db, vault } = setup();
    const users = new UserStore(db);
    const amy = users.create('amy', 'pw');
    vault.user(amy.id, 'github').set('oauth', 'token');
    vault.instance('github').set('client-secret', 'keep');
    users.delete(amy.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM plugin_secrets WHERE scope = 'user'").get()).toEqual({ count: 0 });
    expect(vault.instance('github').has('client-secret')).toBe(true);
  });
});
