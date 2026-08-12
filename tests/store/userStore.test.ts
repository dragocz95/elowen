import { describe, it, expect, beforeEach } from 'vitest';
import { UserStore } from '../../src/store/userStore.js';
import { openAgentsDb } from '../helpers/agentsDb.js';

let users: UserStore;
beforeEach(() => { users = new UserStore(openAgentsDb(':memory:')); });

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
    expect(users.principalForToken(t)?.user.id).toBe(u.id);
    users.revokeToken(t);
    expect(users.principalForToken(t)).toBeNull();
    expect(users.principalForToken('garbage')).toBeNull();
  });
  it('expires tokens past the TTL and purgeExpiredTokens drops them', () => {
    const db = openAgentsDb(':memory:');
    const store = new UserStore(db);
    const u = store.create('a', 'x');
    const t = store.issueToken(u.id);
    // Backdate the token 40 days.
    db.prepare("UPDATE auth_tokens SET created_at = datetime('now','-40 days') WHERE token = ?").run(t);
    expect(store.principalForToken(t)).toBeNull();                 // default 30-day TTL → expired
    expect(store.principalForToken(t, 60)?.user.id).toBe(u.id);    // a longer configured TTL still accepts it
    store.purgeExpiredTokens(30);                             // sweep at the 30-day TTL
    expect(db.prepare('SELECT COUNT(*) c FROM auth_tokens').get()).toEqual({ c: 0 });
  });
  it('carries a token scope and defaults to full (S51)', () => {
    const u = users.create('a', 'x');
    const full = users.issueToken(u.id);                       // default scope
    const agent = users.issueToken(u.id, 'agent');
    expect(users.principalForToken(full)).toEqual({ user: expect.objectContaining({ id: u.id }), scope: 'full', taskId: null });
    expect(users.principalForToken(agent)?.scope).toBe('agent');
  });
  it('binds a per-task agent token to its task and keeps it apart from the shared service token', () => {
    const u = users.create('a', 'x');
    const shared = users.ensureAgentToken(u.id);
    const forA = users.ensureAgentTokenForTask(u.id, 'task-a');
    const forB = users.ensureAgentTokenForTask(u.id, 'task-b');
    expect(new Set([shared, forA, forB]).size).toBe(3);
    expect(users.principalForToken(forA)).toMatchObject({ scope: 'agent', taskId: 'task-a' });
    expect(users.principalForToken(shared)?.taskId).toBeNull();
    // Reused within TTL, so a re-spawn / daemon restart keeps the same worker credential valid.
    expect(users.ensureAgentTokenForTask(u.id, 'task-a')).toBe(forA);
    // A boot-time ensureAgentToken must neither return nor sweep away a live worker's bound token.
    expect(users.ensureAgentToken(u.id)).toBe(shared);
    users.revokeToken(shared);
    expect(users.ensureAgentToken(u.id)).not.toBe(forA);
    expect(users.principalForToken(forA)?.taskId).toBe('task-a');
    expect(users.principalForToken(forB)?.taskId).toBe('task-b');
  });
  it('ensureAgentToken reuses an existing valid agent token across restarts, mints when absent', () => {
    const u = users.create('a', 'x');
    const first = users.ensureAgentToken(u.id);
    const second = users.ensureAgentToken(u.id);
    expect(second).toBe(first);                                 // reused — a restart keeps in-flight agents valid
    expect(users.principalForToken(first)?.scope).toBe('agent');
    // Once the prior token is gone, ensure mints a new (different) one.
    users.revokeToken(first);
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
    const db = openAgentsDb(':memory:');
    const store = new UserStore(db);
    const u = store.create('a', 'x');
    const t = store.issueToken(u.id);
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/var/www/elowen')").run();
    db.prepare('INSERT INTO user_projects (user_id, project_id) VALUES (?, 1)').run(u.id);
    store.delete(u.id);
    expect(store.count()).toBe(0);
    expect(store.principalForToken(t)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM user_projects WHERE user_id = ?').get(u.id)).toEqual({ c: 0 });
  });

  // Regression (review-api-store-sol finding 3): `users.id` is a plain rowid, not AUTOINCREMENT, so a
  // deleted user's id is typically reused by the next-created account. Before this fix a task's or
  // mission's `created_by` kept pointing at that id, so the NEW account silently inherited the old
  // owner's prompt attribution and mission notifications. The rows themselves must survive — only the
  // attribution is cleared, exactly like a task surviving its epic's deletion elsewhere in the store.
  it('nulls created_by on tasks and missions instead of leaving it to be inherited by a reused id', () => {
    const db = openAgentsDb(':memory:');
    const store = new UserStore(db);
    const u = store.create('a', 'x');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/var/www/elowen')").run();
    db.prepare("INSERT INTO tasks (id,project_id,title,created_by) VALUES ('t1',1,'Task',?)").run(u.id);
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,created_by) VALUES ('m1','t1','manual',?)").run(u.id);

    store.delete(u.id);

    expect(db.prepare('SELECT created_by FROM tasks WHERE id = ?').get('t1')).toEqual({ created_by: null });
    expect(db.prepare('SELECT created_by FROM missions WHERE id = ?').get('m1')).toEqual({ created_by: null });
    // The rows themselves are untouched — this clears attribution, it does not cascade-delete work.
    expect(db.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM missions').get()).toEqual({ c: 1 });
  });

  it('ensureAdvisorToken reuses a valid advisor token and resolves as full scope', () => {
    const u = users.create('amy', 'pw');
    const t1 = users.ensureAdvisorToken(u.id);
    const t2 = users.ensureAdvisorToken(u.id);
    expect(t1).toBe(t2);                                       // reused, not re-minted
    expect(users.principalForToken(t1)?.scope).toBe('full');  // advisor → full access at the guard
    expect(users.principalForToken(t1)?.user.id).toBe(u.id);
  });

  it('advisor config: defaults, set exec, toggle autostart', () => {
    const u = users.create('amy', 'pw');
    expect(u.advisor_exec).toBe('');
    expect(u.advisor_autostart).toBe(true);
    expect(users.setAdvisorExec(u.id, 'sonnet')?.advisor_exec).toBe('sonnet');
    expect(users.setAdvisorAutostart(u.id, false)?.advisor_autostart).toBe(false);
    expect(users.get(u.id)?.advisor_exec).toBe('sonnet');
    expect(users.get(u.id)?.advisor_autostart).toBe(false);
  });
});
