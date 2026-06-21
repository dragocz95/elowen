import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';

/** Fallback token TTL (days) when no configured value is passed in — keeps the store usable on its
 *  own (e.g. tests). The live value comes from config.security.tokenTtlDays. */
const DEFAULT_TOKEN_TTL_DAYS = 30;
const ttlDays = (days?: number): number =>
  typeof days === 'number' && Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_TOKEN_TTL_DAYS;

export interface User { id: number; username: string; created_at: string; is_admin: boolean; allowed_execs: string[]; name: string; email: string; avatar: string; default_exec: string }
/** What a token may do. 'full' = an interactive user session (the user's own rights). 'agent' = a
 *  spawned worker/overseer/pilot, restricted to its task-close / plan-submit / overseer verbs. */
export type TokenScope = 'full' | 'agent';
/** A resolved token: the owning user plus the token's scope, so route guards can narrow an agent. */
export interface Principal { user: User; scope: TokenScope }
type Row = { id: number; username: string; created_at: string; is_admin: number; password_hash: string; allowed_execs: string; name: string; email: string; avatar: string; default_exec: string };
const mask = (r: Row): User => ({ id: r.id, username: r.username, created_at: r.created_at, is_admin: !!r.is_admin, allowed_execs: r.allowed_execs ? r.allowed_execs.split(',').filter(Boolean) : [], name: r.name ?? '', email: r.email ?? '', avatar: r.avatar ?? '', default_exec: r.default_exec ?? '' });

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class UserStore {
  constructor(private db: Db) {}

  create(username: string, password: string): User {
    const isAdmin = this.count() === 0 ? 1 : 0; // the first user ever created is the admin
    const info = this.db
      .prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), isAdmin);
    return this.get(Number(info.lastInsertRowid))!;
  }

  /** Whether the user is the bootstrap admin (full access + manages project assignments). */
  isAdmin(id: number): boolean {
    const r = this.db.prepare('SELECT is_admin FROM users WHERE id = ?').get(id) as { is_admin: number } | undefined;
    return !!r?.is_admin;
  }
  /** How many admins exist — used to refuse demoting/deleting the last one. */
  adminCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n;
  }
  /** Grant/revoke admin. Returns the updated user, or null if the id is unknown. */
  setAdmin(id: number, isAdmin: boolean): User | null {
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
    return this.get(id);
  }
  /** Set the per-user model allow-list (exec specs). Empty → no per-user restriction. */
  setAllowedExecs(id: number, execs: string[]): User | null {
    this.db.prepare('UPDATE users SET allowed_execs = ? WHERE id = ?').run(execs.join(','), id);
    return this.get(id);
  }
  /** Self-service profile fields (name / email / preferred default executor). Only provided keys
   *  are written, so a partial update leaves the rest untouched. */
  setProfile(id: number, patch: { name?: string; email?: string; default_exec?: string }): User | null {
    const sets: string[] = []; const p: Record<string, unknown> = { id };
    if (typeof patch.name === 'string') { sets.push('name = @name'); p.name = patch.name; }
    if (typeof patch.email === 'string') { sets.push('email = @email'); p.email = patch.email; }
    if (typeof patch.default_exec === 'string') { sets.push('default_exec = @default_exec'); p.default_exec = patch.default_exec; }
    if (sets.length > 0) this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run(p);
    return this.get(id);
  }
  /** Record the stored avatar filename (or '' to clear). */
  setAvatar(id: number, filename: string): User | null {
    this.db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(filename, id);
    return this.get(id);
  }
  get(id: number): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return r ? mask(r) : null;
  }
  verify(username: string, password: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Row | undefined;
    if (!r || !verifyPassword(password, r.password_hash)) return null;
    return mask(r);
  }
  list(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as Row[]).map(mask);
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }
  delete(id: number): void {
    // One transaction so a mid-way failure can't leave orphan tokens/assignments (consistent with
    // ProjectStore.remove and TaskStore.delete). The schema has no FK cascade, so order is explicit.
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM user_projects WHERE user_id = ?').run(id); // no orphan assignments
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();
  }
  issueToken(userId: number, scope: TokenScope = 'full'): string {
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO auth_tokens (token, user_id, scope) VALUES (?, ?, ?)').run(token, userId, scope);
    return token;
  }
  userForToken(token: string, days?: number): User | null {
    return this.principalForToken(token, days)?.user ?? null;
  }
  /** Resolve a token to its owning user AND scope, so route guards can restrict agent tokens.
   *  Tokens expire after the configured TTL — an old token captured from a log / URL stops working
   *  even if it was never explicitly revoked. */
  principalForToken(token: string, days?: number): Principal | null {
    const r = this.db
      .prepare(`SELECT u.*, t.scope AS token_scope FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ? AND t.created_at > datetime('now', '-${ttlDays(days)} days')`)
      .get(token) as (Row & { token_scope: string }) | undefined;
    if (!r) return null;
    return { user: mask(r), scope: r.token_scope === 'agent' ? 'agent' : 'full' };
  }
  /** Re-issue the daemon's agent service token: drop any prior agent-scoped tokens for the user, then
   *  mint a fresh one. An explicit rotation primitive (e.g. a leaked-token reset). */
  refreshAgentToken(userId: number): string {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND scope = 'agent'").run(userId);
      return this.issueToken(userId, 'agent');
    })();
  }
  /** The daemon's agent service token, reused across restarts: return the existing valid agent token
   *  if one is still within TTL, else clear stale ones and mint a fresh token. Called at boot — unlike
   *  a blind rotate, this keeps in-flight agents' credential alive across a daemon restart (they'd
   *  otherwise 401 on `orca close`) while still bounding accumulation (at most one live token). */
  ensureAgentToken(userId: number, days?: number): string {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT token FROM auth_tokens WHERE user_id = ? AND scope = 'agent' AND created_at > datetime('now', '-${ttlDays(days)} days') ORDER BY created_at DESC LIMIT 1`)
        .get(userId) as { token?: string } | undefined;
      if (existing?.token) return existing.token;
      this.db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND scope = 'agent'").run(userId);
      return this.issueToken(userId, 'agent');
    })();
  }
  revokeToken(token: string): void {
    this.db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
  }
  /** Delete tokens past their TTL. Cheap; called periodically so the table doesn't grow unbounded. */
  purgeExpiredTokens(days?: number): void {
    this.db.prepare(`DELETE FROM auth_tokens WHERE created_at <= datetime('now', '-${ttlDays(days)} days')`).run();
  }
}
