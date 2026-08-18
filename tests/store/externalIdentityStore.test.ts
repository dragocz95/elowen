import { describe, expect, it } from 'vitest';
import { ExternalIdentityConflictError, UserStore } from '../../src/store/userStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

const identity = (over: Partial<Parameters<UserStore['linkExternalIdentity']>[0]> = {}) => ({
  provider: 'msteams',
  tenantId: 'tenant-1',
  subjectId: 'subject-1',
  preferredUsername: 'alex',
  name: 'Alex Rivera',
  email: 'alex@example.com',
  ...over,
});

describe('external user identities', () => {
  it('refuses to bootstrap an administrator through external provisioning', () => {
    const users = new UserStore(openPluginTablesDb(':memory:'));
    expect(() => users.linkExternalIdentity(identity())).toThrow(ExternalIdentityConflictError);
    expect(users.count()).toBe(0);
  });

  it('atomically provisions a non-admin external-only account and resolves it idempotently', () => {
    const users = new UserStore(openPluginTablesDb(':memory:'));
    users.create('operator', 'secret');

    const first = users.linkExternalIdentity(identity());
    const second = users.linkExternalIdentity(identity({ preferredUsername: 'ignored' }));

    expect(first.created).toBe(true);
    expect(first.user).toMatchObject({ username: 'alex', is_admin: false, name: 'Alex Rivera', email: 'alex@example.com' });
    expect(second).toEqual({ user: first.user, created: false });
    expect(users.externalIdentity('msteams', 'tenant-1', 'subject-1')?.id).toBe(first.user.id);
    expect(users.verify('alex', 'anything')).toBeNull();
  });

  it('resolves an existing binding without letting the plugin choose an account target', () => {
    const db = openPluginTablesDb(':memory:');
    const users = new UserStore(db);
    const operator = users.create('operator', 'secret');
    users.setProfile(operator.id, { name: 'Local name', email: 'local@example.com' });
    db.prepare(`INSERT INTO user_external_identities
      (provider, tenant_id, subject_id, user_id) VALUES (?, ?, ?, ?)`)
      .run('msteams', 'tenant-1', 'subject-1', operator.id);

    const result = users.linkExternalIdentity(identity());

    expect(result).toEqual({ user: expect.objectContaining({ id: operator.id, is_admin: true, name: 'Local name', email: 'local@example.com' }), created: false });
    expect(identity()).not.toHaveProperty('existingUserId');
  });

  it('keeps one administratively seeded account binding per provider tenant', () => {
    const db = openPluginTablesDb(':memory:');
    const users = new UserStore(db);
    const operator = users.create('operator', 'secret');
    db.prepare(`INSERT INTO user_external_identities
      (provider, tenant_id, subject_id, user_id) VALUES (?, ?, ?, ?)`)
      .run('msteams', 'tenant-1', 'subject-1', operator.id);

    expect(() => db.prepare(`INSERT INTO user_external_identities
      (provider, tenant_id, subject_id, user_id) VALUES (?, ?, ?, ?)`)
      .run('msteams', 'tenant-1', 'subject-2', operator.id)).toThrow();
    expect(users.externalIdentity('msteams', 'tenant-1', 'subject-1')?.id).toBe(operator.id);
  });

  it('uses deterministic collision suffixes and removes links with the account', () => {
    const users = new UserStore(openPluginTablesDb(':memory:'));
    users.create('operator', 'secret');
    users.create('alex', 'secret');
    const linked = users.linkExternalIdentity(identity());

    expect(linked.user.username).toBe('alex-2');
    users.delete(linked.user.id);
    expect(users.externalIdentity('msteams', 'tenant-1', 'subject-1')).toBeNull();
  });

  it('validates provider and identity keys before touching storage', () => {
    const users = new UserStore(openPluginTablesDb(':memory:'));
    users.create('operator', 'secret');
    expect(() => users.linkExternalIdentity(identity({ provider: '../msteams' }))).toThrow(TypeError);
    expect(() => users.linkExternalIdentity(identity({ subjectId: 'bad\nsubject' }))).toThrow(TypeError);
    expect(() => users.linkExternalIdentity(identity({ subjectId: ' subject-1' }))).toThrow(TypeError);
    expect(() => users.linkExternalIdentity(identity({ name: 'x'.repeat(201) }))).toThrow(TypeError);
    expect(() => users.linkExternalIdentity(identity({ email: 'bad\n@example.com' }))).toThrow(TypeError);
  });
});
