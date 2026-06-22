import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';

let users: UserStore;
beforeEach(() => { users = new UserStore(openDb(':memory:')); });

describe('UserStore', () => {
  it('create + verify round-trips and never exposes the hash', () => {
    const u = users.create('alice', 'secret');
    expect(u.username).toBe('alice');
    expect((u as Record<string, unknown>).password_hash).toBeUndefined();
    expect(users.verify('alice', 'secret')?.username).toBe('alice');
    expect(users.verify('alice', 'wrong')).toBeNull();
    expect(users.verify('nobody', 'secret')).toBeNull();
  });
  it('list masks the hash and count reflects inserts', () => {
    users.create('a', 'x'); users.create('b', 'y');
    expect(users.count()).toBe(2);
    expect(users.list().map((u) => u.username).sort()).toEqual(['a', 'b']);
    expect(users.list().every((u) => !('password_hash' in u))).toBe(true);
  });
  it('rejects duplicate usernames', () => {
    users.create('a', 'x');
    expect(() => users.create('a', 'y')).toThrow();
  });
  it('issues, resolves and revokes tokens', () => {
    const u = users.create('a', 'x');
    const t = users.issueToken(u.id);
    expect(users.userForToken(t)?.id).toBe(u.id);
    users.revokeToken(t);
    expect(users.userForToken(t)).toBeNull();
    expect(users.userForToken('garbage')).toBeNull();
  });
  it('expires tokens past the TTL and purgeExpiredTokens drops them', () => {
    const db = openDb(':memory:');
    const store = new UserStore(db);
    const u = store.create('a', 'x');
    const t = store.issueToken(u.id);
    // Backdate the token 40 days.
    db.prepare("UPDATE auth_tokens SET created_at = datetime('now','-40 days') WHERE token = ?").run(t);
    expect(store.userForToken(t)).toBeNull();                 // default 30-day TTL → expired
    expect(store.userForToken(t, 60)?.id).toBe(u.id);         // a longer configured TTL still accepts it
    store.purgeExpiredTokens(30);                             // sweep at the 30-day TTL
    expect(db.prepare('SELECT COUNT(*) c FROM auth_tokens').get()).toEqual({ c: 0 });
  });
  it('carries a token scope and defaults to full (S51)', () => {
    const u = users.create('a', 'x');
    const full = users.issueToken(u.id);                       // default scope
    const agent = users.issueToken(u.id, 'agent');
    expect(users.principalForToken(full)).toEqual({ user: expect.objectContaining({ id: u.id }), scope: 'full' });
    expect(users.principalForToken(agent)?.scope).toBe('agent');
  });
  it('refreshAgentToken rotates the agent token and drops the prior one (S51)', () => {
    const u = users.create('a', 'x');
    const first = users.refreshAgentToken(u.id);
    const second = users.refreshAgentToken(u.id);
    expect(second).not.toBe(first);
    expect(users.principalForToken(first)).toBeNull();         // old agent token revoked on refresh
    expect(users.principalForToken(second)?.scope).toBe('agent');
    // A full token for the same user is untouched by an agent refresh.
    const full = users.issueToken(u.id);
    users.refreshAgentToken(u.id);
    expect(users.userForToken(full)?.id).toBe(u.id);
  });
  it('ensureAgentToken reuses an existing valid agent token across restarts, mints when absent', () => {
    const u = users.create('a', 'x');
    const first = users.ensureAgentToken(u.id);
    const second = users.ensureAgentToken(u.id);
    expect(second).toBe(first);                                 // reused — a restart keeps in-flight agents valid
    expect(users.principalForToken(first)?.scope).toBe('agent');
    // After an explicit rotation the prior token is gone, so ensure mints a new (different) one.
    users.refreshAgentToken(u.id);
    const third = users.ensureAgentToken(u.id);
    expect(third).not.toBe(first);
    expect(users.principalForToken(third)?.scope).toBe('agent');
  });
  it('changePassword swaps the hash when the current password matches, rejects a wrong one', () => {
    const u = users.create('alice', 'oldpass');
    expect(users.changePassword(u.id, 'wrong', 'newpass')).toBe(false); // wrong current → no change
    expect(users.verify('alice', 'oldpass')?.id).toBe(u.id);            // still the old password
    expect(users.changePassword(u.id, 'oldpass', 'newpass')).toBe(true);
    expect(users.verify('alice', 'oldpass')).toBeNull();               // old no longer works
    expect(users.verify('alice', 'newpass')?.id).toBe(u.id);          // new one does
  });
  it('changePassword returns false for an unknown user id', () => {
    expect(users.changePassword(999, 'whatever', 'newpass')).toBe(false);
  });
  it('delete removes the user, their tokens and project assignments in one go', () => {
    const db = openDb(':memory:');
    const store = new UserStore(db);
    const u = store.create('a', 'x');
    const t = store.issueToken(u.id);
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/var/www/orca')").run();
    db.prepare('INSERT INTO user_projects (user_id, project_id) VALUES (?, 1)').run(u.id);
    store.delete(u.id);
    expect(store.count()).toBe(0);
    expect(store.userForToken(t)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM user_projects WHERE user_id = ?').get(u.id)).toEqual({ c: 0 });
  });
});
