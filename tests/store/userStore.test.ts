import { describe, it, expect, beforeEach } from 'vitest';
import { UserStore } from '../../src/store/userStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

let db: ReturnType<typeof openPluginTablesDb>;
let users: UserStore;
beforeEach(() => { db = openPluginTablesDb(':memory:'); users = new UserStore(db); });

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
  it('matches normalized e-mail only when exactly one account holds it', () => {
    const db = openPluginTablesDb(':memory:');
    const store = new UserStore(db);
    const alice = store.create('alice', 'x');
    const bob = store.create('bob', 'y');
    store.setProfile(alice.id, { email: ' Alice@Example.com ' });
    expect(store.userByUniqueEmail(' alice@example.COM ')).toMatchObject({ id: alice.id });
    db.exec('DROP INDEX idx_users_email_normalized'); // legacy degraded shape permits an existing duplicate
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run('alice@example.com', bob.id);
    expect(store.userByUniqueEmail('ALICE@example.com')).toBeNull();
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
    const db = openPluginTablesDb(':memory:');
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
  it('defaults issued tokens to full user access and rejects retired token scopes', () => {
    const u = users.create('a', 'x');
    const full = users.issueToken(u.id);
    expect(users.principalForToken(full)).toEqual({ user: expect.objectContaining({ id: u.id }), scope: 'full' });

    // Old installs may still contain credentials minted for the removed task-agent runtime. They must not
    // become full user tokens merely because the current principal shape has only one public scope.
    const retired = 'retired-agent-token';
    db.prepare("INSERT INTO auth_tokens (token, user_id, scope) VALUES (?, ?, 'agent')").run(retired, u.id);
    expect(users.principalForToken(retired)).toBeNull();
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
    const db = openPluginTablesDb(':memory:');
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

  it('leaves retired plugin rows untouched when no plugin cleanup handler is loaded', () => {
    const db = openPluginTablesDb(':memory:');
    const store = new UserStore(db);
    const u = store.create('a', 'x');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/var/www/elowen')").run();
    db.prepare("INSERT INTO tasks (id,project_id,title,created_by) VALUES ('t1',1,'Task',?)").run(u.id);
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,created_by) VALUES ('m1','t1','manual',?)").run(u.id);

    store.delete(u.id);

    expect(db.prepare('SELECT created_by FROM tasks WHERE id = ?').get('t1')).toEqual({ created_by: u.id });
    expect(db.prepare('SELECT created_by FROM missions WHERE id = ?').get('m1')).toEqual({ created_by: u.id });
  });

  it('ensureAdvisorToken reuses a valid advisor token and resolves as full scope', () => {
    const u = users.create('amy', 'pw');
    const t1 = users.ensureAdvisorToken(u.id);
    const t2 = users.ensureAdvisorToken(u.id);
    expect(t1).toBe(t2);                                       // reused, not re-minted
    expect(users.principalForToken(t1)?.scope).toBe('full');  // advisor → full access at the guard
    expect(users.principalForToken(t1)?.user.id).toBe(u.id);
  });

  it('every scope the codebase still mints resolves, and a retired one does not', () => {
    const u = users.create('tess', 'pw');
    // The two live scopes, each from the seam that actually mints it: login/SSO issue the default and
    // ensureAdvisorToken mints 'advisor'. principalForToken is an ALLOW-list, so a scope that stops being
    // listed silently stops authenticating its owner, with no failing test to say why.
    expect(users.principalForToken(users.issueToken(u.id, 'full'))?.user.id).toBe(u.id);
    expect(users.principalForToken(users.ensureAdvisorToken(u.id))?.user.id).toBe(u.id);
    // 'terminal' was retired with the browser terminal. It is no longer in the allow-list, so a token
    // left over from before the removal must not authenticate anyone.
    expect(users.principalForToken(users.issueToken(u.id, 'terminal' as never))).toBeNull();
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
