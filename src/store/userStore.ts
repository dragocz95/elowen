import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { tolerateMissingPluginTables } from './db.js';
import type { Db } from './db.js';
import type { User } from '../shared/wireContract.js';
import { execRefSpec, parseExecRef } from '../shared/execs.js';

/** Fallback token TTL (days) when no configured value is passed in — keeps the store usable on its
 *  own (e.g. tests). The live value comes from config.security.tokenTtlDays. */
const DEFAULT_TOKEN_TTL_DAYS = 30;
const ttlDays = (days?: number): number =>
  typeof days === 'number' && Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_TOKEN_TTL_DAYS;

// The user shape is the daemon↔web wire contract (served by /auth/me etc.) — defined once in
// src/shared and re-exported here, so a field added on the daemon can never be missing on the web.
export type { User };

/** THE read of the admin bit. Both `UserStore` and `UserProjectStore` expose an `isAdmin`, and until this
 *  existed each ran its own copy of the same SELECT — two implementations of one fact, reachable from
 *  different API gates (`notAdminUnlessSetup` went through one, `notAdmin` through the other), which is
 *  precisely how two gates protecting comparable routes come to disagree. Reads the explicit
 *  `users.is_admin` column, never a mutable MIN(id) heuristic, so deleting a user cannot transfer it. */
export function readIsAdmin(db: Db, userId: number): boolean {
  const r = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId) as { is_admin: number } | undefined;
  return !!r?.is_admin;
}
/** What a token may do. 'full' = an interactive user session (the user's own rights). 'agent' = a
 *  spawned worker/overseer/pilot, restricted to its task-close / plan-submit / overseer verbs.
 *  'advisor' is stored in the DB for the per-user advisor session; it grants full access (mapped to
 *  'full' at the guard) but is isolated so rotating/stopping the advisor never touches login tokens.
 *  'terminal' is the same isolation for an admin's interactive `elowen chat` terminal (BrainTerminalService):
 *  full access at the guard, its own DB scope so revoking a terminal never disturbs login/advisor/agent tokens. */
export type TokenScope = 'full' | 'agent';
export type StoredScope = TokenScope | 'advisor' | 'terminal';
/** A resolved token: the owning user, the token's scope, and — for an agent token minted for one
 *  specific task — that task's id, so route guards can narrow an agent to its own work. `taskId` is
 *  null for every other token (interactive sessions, and the unbound shared service token). */
export interface Principal { user: User; scope: TokenScope; taskId: string | null }
export interface ExternalIdentityInput {
  provider: string;
  tenantId: string;
  subjectId: string;
  preferredUsername: string;
  name?: string;
  email?: string;
}
export interface ExternalIdentityResult { user: User; created: boolean }
export interface ExternalIdentityBindingInput {
  provider: string;
  tenantId: string;
  subjectId: string;
  userId: number;
  replace?: boolean;
}
export interface ExternalIdentityView {
  provider: string;
  tenantId: string;
  subjectId: string;
  user: User;
  linkedAt: string;
}
export class ExternalIdentityConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ExternalIdentityConflictError'; }
}
/** Raised when a normalized, non-empty profile e-mail is already held by another account. E-mail is a
 *  Teams bootstrap identity, so allowing duplicates would let a self-service profile squat that sender. */
export class EmailConflictError extends Error {
  constructor(public readonly email: string) {
    super(`email ${email} is already used by another user`);
    this.name = 'EmailConflictError';
  }
}
/** Raised when a username is already held by another account. Unlike e-mail this is a LOGIN credential,
 *  so a duplicate would not just confuse attribution — it would make `verify` ambiguous. */
export class UsernameConflictError extends Error {
  constructor(public readonly username: string) {
    super(`username ${username} is already taken`);
    this.name = 'UsernameConflictError';
  }
}
type Row = { id: number; username: string; created_at: string; is_admin: number; password_hash: string; allowed_execs: string; disabled_tools: string; allowed_tools: string; granted_plugins: string; name: string; email: string; avatar: string; default_exec: string; advisor_exec: string; advisor_autostart: number };
type ExternalIdentityRow = Row & { external_provider: string; external_tenant_id: string; external_subject_id: string; external_created_at: string };
const canonicalExec = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return '';
  const ref = parseExecRef(value);
  if (!ref) return '';
  return ref.program === 'elowen' ? execRefSpec(ref) : value;
};
const readAllowedExecs = (value: string): string[] => {
  if (!value) return [];
  let raw: unknown[];
  try { raw = JSON.parse(value) as unknown[]; } catch { raw = value.split(','); }
  return Array.isArray(raw) ? raw.map(canonicalExec).filter(Boolean) : [];
};
const mask = (r: Row): User => ({ id: r.id, username: r.username, created_at: r.created_at, is_admin: !!r.is_admin, allowed_execs: readAllowedExecs(r.allowed_execs), disabled_tools: r.disabled_tools ? r.disabled_tools.split(',').filter(Boolean) : [], allowed_tools: r.allowed_tools ? r.allowed_tools.split(',').filter(Boolean) : [], granted_plugins: r.granted_plugins ? r.granted_plugins.split(',').filter(Boolean) : [], name: r.name ?? '', email: r.email ?? '', avatar: r.avatar ?? '', default_exec: canonicalExec(r.default_exec), advisor_exec: canonicalExec(r.advisor_exec), advisor_autostart: r.advisor_autostart === undefined ? true : !!r.advisor_autostart });

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

function externalKey(value: string, label: string, pattern?: RegExp): string {
  const raw = String(value ?? '');
  if (!raw || raw !== raw.trim() || raw.length > 255 || /[\u0000-\u001f\u007f]/.test(raw) || (pattern && !pattern.test(raw))) {
    throw new TypeError(`invalid external identity ${label}`);
  }
  return raw;
}

function externalProfile(value: string | undefined, label: string, maxLength: number): string {
  const normalized = String(value ?? '').trim();
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`invalid external identity ${label}`);
  }
  return normalized;
}

function usernameStem(value: string): string {
  return externalProfile(value, 'preferred username', 255).toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 48);
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

  /** Describe one external subject binding without exposing password hashes, tokens, or provider secrets. */
  describeExternalIdentity(provider: string, tenantId: string, subjectId: string): ExternalIdentityView | null {
    const key = {
      provider: externalKey(provider, 'provider', /^[a-z][a-z0-9._-]{0,63}$/),
      tenantId: externalKey(tenantId, 'tenant'),
      subjectId: externalKey(subjectId, 'subject'),
    };
    const row = this.db.prepare(`SELECT
        e.provider AS external_provider,
        e.tenant_id AS external_tenant_id,
        e.subject_id AS external_subject_id,
        e.created_at AS external_created_at,
        u.*
      FROM user_external_identities e
      JOIN users u ON u.id = e.user_id
      WHERE e.provider = @provider AND e.tenant_id = @tenantId AND e.subject_id = @subjectId`)
      .get(key) as ExternalIdentityRow | undefined;
    return row ? {
      provider: row.external_provider,
      tenantId: row.external_tenant_id,
      subjectId: row.external_subject_id,
      user: mask(row),
      linkedAt: row.external_created_at,
    } : null;
  }

  /** Resolve one immutable external subject to its local account. External tokens never enter this store. */
  externalIdentity(provider: string, tenantId: string, subjectId: string): User | null {
    return this.describeExternalIdentity(provider, tenantId, subjectId)?.user ?? null;
  }

  /** The same binding WITHOUT a tenant, for the inbound path: a platform reports the sender's immutable
   *  subject id but not which tenant issued it. Entra object ids are globally unique, so a subject held by
   *  more than one row means two tenants collided on it — identity is an auth boundary, so that resolves to
   *  nothing rather than picking one. `LIMIT 2` is what makes "exactly one" provable in a single read. */
  externalIdentityBySubject(provider: string, subjectId: string): User | null {
    const rows = this.db.prepare(`SELECT u.*
      FROM user_external_identities e
      JOIN users u ON u.id = e.user_id
      WHERE e.provider = @provider AND e.subject_id = @subjectId
      LIMIT 2`)
      .all({ provider: externalKey(provider, 'provider'), subjectId: externalKey(subjectId, 'subject') }) as Row[];
    return rows.length === 1 ? mask(rows[0]!) : null;
  }

  /** Atomically bind an external subject to an existing account, or explicitly reassign it with replace. */
  linkExistingExternalIdentity(input: ExternalIdentityBindingInput): ExternalIdentityView {
    const provider = externalKey(input.provider, 'provider', /^[a-z][a-z0-9._-]{0,63}$/);
    const tenantId = externalKey(input.tenantId, 'tenant');
    const subjectId = externalKey(input.subjectId, 'subject');
    if (!Number.isSafeInteger(input.userId) || input.userId < 1) throw new TypeError('invalid external identity user id');

    return this.db.transaction(() => {
      if (!this.get(input.userId)) throw new ExternalIdentityConflictError('external identity target user does not exist');

      const existing = this.describeExternalIdentity(provider, tenantId, subjectId);
      if (existing?.user.id === input.userId) return existing;
      if (existing && input.replace !== true) {
        throw new ExternalIdentityConflictError('external identity is already linked to another user');
      }

      const userCollision = this.db.prepare(`SELECT subject_id FROM user_external_identities
        WHERE provider = ? AND tenant_id = ? AND user_id = ?`)
        .get(provider, tenantId, input.userId) as { subject_id: string } | undefined;
      if (userCollision && userCollision.subject_id !== subjectId) {
        throw new ExternalIdentityConflictError('target user already has an external identity for this provider tenant');
      }

      try {
        if (existing) {
          this.db.prepare(`UPDATE user_external_identities
            SET user_id = ?, created_at = datetime('now')
            WHERE provider = ? AND tenant_id = ? AND subject_id = ?`)
            .run(input.userId, provider, tenantId, subjectId);
        } else {
          this.db.prepare(`INSERT INTO user_external_identities
            (provider, tenant_id, subject_id, user_id) VALUES (?, ?, ?, ?)`)
            .run(provider, tenantId, subjectId, input.userId);
        }
      } catch (error) {
        if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
          throw new ExternalIdentityConflictError('external identity binding conflicts with an existing link');
        }
        throw error;
      }
      return this.describeExternalIdentity(provider, tenantId, subjectId)!;
    }).immediate();
  }

  /**
   * Resolve a proven external subject or atomically provision a passwordless, non-admin account. Binding
   * an existing account is intentionally outside this provisioning method and requires the explicit
   * administrative linkExisting path.
   * A random 256-bit password is hashed and discarded:
   * the account can be reached only through the external identity until an authenticated reset flow is
   * deliberately added. The first-ever account is never provisioned here, so an external login cannot
   * become the bootstrap operator.
   */
  linkExternalIdentity(input: ExternalIdentityInput): ExternalIdentityResult {
    const provider = externalKey(input.provider, 'provider', /^[a-z][a-z0-9._-]{0,63}$/);
    const tenantId = externalKey(input.tenantId, 'tenant');
    const subjectId = externalKey(input.subjectId, 'subject');
    return this.db.transaction(() => {
      const linked = this.externalIdentity(provider, tenantId, subjectId);
      if (linked) return { user: linked, created: false };

      if (this.adminCount() === 0) throw new ExternalIdentityConflictError('external provisioning requires an existing administrator');
      const base = usernameStem(input.preferredUsername) || `${provider}-${usernameStem(subjectId).slice(0, 16) || 'user'}`;
      let username = base;
      for (let suffix = 2; this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username); suffix++) {
        username = `${base.slice(0, Math.max(1, 63 - String(suffix).length))}-${suffix}`;
      }
      try {
        const info = this.db.prepare(`INSERT INTO users
          (username, password_hash, is_admin, name, email)
          VALUES (?, ?, 0, ?, ?)`)
          .run(
            username,
            hashPassword(randomBytes(32).toString('base64url')),
            externalProfile(input.name, 'name', 200),
            externalProfile(input.email, 'email', 320),
          );
        const user = this.get(Number(info.lastInsertRowid))!;
        this.db.prepare(`INSERT INTO user_external_identities
          (provider, tenant_id, subject_id, user_id) VALUES (?, ?, ?, ?)`)
          .run(provider, tenantId, subjectId, user.id);
        return { user, created: true };
      } catch (error) {
        if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
          throw new ExternalIdentityConflictError('external identity provisioning conflicts with an existing account or link');
        }
        throw error;
      }
    }).immediate();
  }

  /** Whether the user is an admin (full access + manages project assignments). */
  isAdmin(id: number): boolean {
    return readIsAdmin(this.db, id);
  }
  /** The instance OPERATOR: the first admin by creation order. One definition shared by the brain's
   *  `platformOwner` (which anchors channel sessions) and the API's identity minting, so "owner" cannot
   *  come to mean two different accounts on the two surfaces. Undefined when no admin exists yet. */
  ownerId(): number | undefined {
    const r = this.db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at, id LIMIT 1').get() as { id: number } | undefined;
    return r?.id;
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
    this.db.prepare('UPDATE users SET allowed_execs = ? WHERE id = ?').run(execs.map(canonicalExec).filter(Boolean).join(','), id);
    return this.get(id);
  }
  /** Set the per-user tool DENY-list. Retained unread for one release as a rollback path behind
   *  `allowed_tools`; nothing in the turn path consults it any more (see turnCapabilities). */
  setDisabledTools(id: number, tools: string[]): User | null {
    this.db.prepare('UPDATE users SET disabled_tools = ? WHERE id = ?').run([...new Set(tools)].join(','), id);
    return this.get(id);
  }
  /** Set the per-user tool ALLOW-list — the plugin tools this account may use at all. Empty means NO
   *  plugin tool for a non-admin, which is the deny-by-default the list exists for: anything newly
   *  installed stays invisible until an admin grants it. Admins are exempt (see turnCapabilities), so an
   *  empty list never locks the operator out. Tool names are comma-free, so a CSV is safe. */
  setAllowedTools(id: number, tools: string[]): User | null {
    this.db.prepare('UPDATE users SET allowed_tools = ? WHERE id = ?').run([...new Set(tools)].join(','), id);
    return this.get(id);
  }
  /** Set the per-user plugin GRANT-list (names of `userGrantable` plugins this user may use). Empty →
   *  the user reaches no grant-gated plugin, which is the deny-by-default this list exists for. Plugin
   *  names are comma-free (NAME_RE), so a CSV is safe. */
  setGrantedPlugins(id: number, plugins: string[]): User | null {
    this.db.prepare('UPDATE users SET granted_plugins = ? WHERE id = ?').run([...new Set(plugins)].join(','), id);
    return this.get(id);
  }
  /** Resolve a normalized e-mail only when exactly one account holds it. Legacy databases may contain
   *  duplicates and deliberately run without the unique index, so callers must never take the first row. */
  userByUniqueEmail(email: string): User | null {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    const rows = this.db.prepare('SELECT * FROM users WHERE lower(trim(email)) = ? LIMIT 2').all(normalized) as Row[];
    return rows.length === 1 ? mask(rows[0]!) : null;
  }

  /** Whether a normalized e-mail matches multiple legacy accounts. SSO must distinguish this from no
   * match so provisioning cannot turn an ambiguous identity into yet another account. */
  hasAmbiguousEmail(email: string): boolean {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return false;
    const rows = this.db.prepare('SELECT 1 FROM users WHERE lower(trim(email)) = ? LIMIT 2').all(normalized);
    return rows.length > 1;
  }

  /** Self-service profile fields (name / email / preferred default executor). Only provided keys
   *  are written, so a partial update leaves the rest untouched. A normalized non-empty e-mail may belong
   *  to only one account because Teams uses it solely as a guarded first-contact identity bootstrap. */
  /** Rename an account's login name. Deliberately separate from `setProfile`, which is self-service:
   *  a username is what `verify` matches on, so only an admin route may reach this. Nothing else in the
   *  schema references a username — sessions, SSO bindings and every other row key on `users.id` — so a
   *  rename changes what the person types at the login form and nothing more. */
  setUsername(id: number, username: string): User | null {
    const next = username.trim();
    if (!next) throw new Error('username required');
    return this.db.transaction(() => {
      if (!this.get(id)) return null;
      try { this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(next, id); }
      catch (error) {
        if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new UsernameConflictError(next);
        throw error;
      }
      return this.get(id);
    }).immediate();
  }

  setProfile(id: number, patch: { name?: string; email?: string; default_exec?: string }): User | null {
    return this.db.transaction(() => {
      const sets: string[] = []; const p: Record<string, unknown> = { id };
      if (typeof patch.name === 'string') { sets.push('name = @name'); p.name = patch.name; }
      if (typeof patch.email === 'string') {
        const email = patch.email.trim();
        const normalized = email.toLowerCase();
        if (normalized) {
          const claimed = this.db.prepare('SELECT id FROM users WHERE lower(trim(email)) = ? AND id <> ? LIMIT 1')
            .get(normalized, id) as { id: number } | undefined;
          if (claimed) throw new EmailConflictError(email);
        }
        sets.push('email = @email'); p.email = email;
      }
      if (typeof patch.default_exec === 'string') { sets.push('default_exec = @default_exec'); p.default_exec = canonicalExec(patch.default_exec); }
      if (sets.length > 0) {
        try { this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run(p); }
        catch (error) {
          if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' && typeof p.email === 'string') {
            throw new EmailConflictError(p.email);
          }
          throw error;
        }
      }
      return this.get(id);
    }).immediate();
  }
  /** Remember which agent exec the user's advisor runs (chosen at first open). Empty = not set up. */
  setAdvisorExec(id: number, exec: string): User | null {
    this.db.prepare('UPDATE users SET advisor_exec = ? WHERE id = ?').run(canonicalExec(exec), id);
    return this.get(id);
  }
  /** Toggle whether the advisor auto-starts on login. */
  setAdvisorAutostart(id: number, on: boolean): User | null {
    this.db.prepare('UPDATE users SET advisor_autostart = ? WHERE id = ?').run(on ? 1 : 0, id);
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
  /** Self-service password change: rewrite the hash only when `current` matches the stored one.
   *  Returns false on an unknown user or a wrong current password (so the caller can 4xx). */
  changePassword(id: number, current: string, next: string): boolean {
    const r = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash: string } | undefined;
    if (!r || !verifyPassword(current, r.password_hash)) return false;
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), id);
    return true;
  }
  verify(username: string, password: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Row | undefined;
    if (!r || !verifyPassword(password, r.password_hash)) return null;
    return mask(r);
  }
  list(): User[] {
    // created_at, id: id breaks ties deterministically so "first user" (the admin / service-principal
    // fallback in resolveOwnerId) is stable even when two users share a created_at second.
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at, id').all() as Row[]).map(mask);
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }
  delete(id: number): void {
    // One transaction so a mid-way failure can't leave orphan tokens/assignments (consistent with
    // ProjectStore.remove and TaskStore.delete). The schema has no FK cascade, so order is explicit.
    //
    // `created_by` is nulled rather than left behind because a reference to a user row that no longer
    // exists is a dangling one: prompt attribution (prompts/owner.ts) and mission replan/notification
    // ownership both resolve it, and both would then answer "nobody" in some places and throw in others.
    // Ids themselves are never handed out twice — `seedUserSequenceAboveEveryReference` (store/db.ts)
    // keeps the counter above every reference — so this is about dangling references, not impersonation.
    this.db.transaction(() => {
      // `tasks` is a WORK-PLUGIN table (as `missions` is an agents one) — null the attribution when
      // present, tolerate a fresh install where the plugin never created it.
      tolerateMissingPluginTables(() => { this.db.prepare('UPDATE tasks SET created_by = NULL WHERE created_by = ?').run(id); }, undefined);
      // `missions` is an AGENTS-PLUGIN table (created_by arrives with its migration v2) — null the
      // attribution when present, tolerate a fresh/ancient install without the table or column.
      tolerateMissingPluginTables(() => { this.db.prepare('UPDATE missions SET created_by = NULL WHERE created_by = ?').run(id); }, undefined);
      this.db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_terminals WHERE user_id = ?').run(id); // no orphan terminal bindings (their tokens went with auth_tokens above)
      this.db.prepare('DELETE FROM user_projects WHERE user_id = ?').run(id); // no orphan assignments
      this.db.prepare('DELETE FROM user_prompts WHERE user_id = ?').run(id); // no orphan prompt overrides
      this.db.prepare('DELETE FROM user_plugin_config WHERE user_id = ?').run(id); // no orphan per-plugin values (incl. their secrets)
      // Origin accounting holds IP addresses — personal data. Deleting the account must take them with
      // it in the SAME transaction, not on the next retention sweep.
      this.db.prepare('DELETE FROM usage_by_origin WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_session_origins WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM user_external_identities WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();
  }
  issueToken(userId: number, scope: StoredScope = 'full', taskId: string | null = null): string {
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO auth_tokens (token, user_id, scope, task_id) VALUES (?, ?, ?, ?)').run(token, userId, scope, taskId);
    return token;
  }
  /** Resolve a token to its owning user AND scope, so route guards can restrict agent tokens.
   *  Tokens expire after the configured TTL — an old token captured from a log / URL stops working
   *  even if it was never explicitly revoked. */
  principalForToken(token: string, days?: number): Principal | null {
    const r = this.db
      .prepare(`SELECT u.*, t.scope AS token_scope, t.task_id AS token_task FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ? AND t.created_at > datetime('now', '-${ttlDays(days)} days')`)
      .get(token) as (Row & { token_scope: string; token_task: string | null }) | undefined;
    if (!r) return null;
    const scope: TokenScope = r.token_scope === 'agent' ? 'agent' : 'full';
    // Only an agent token carries a task binding; anything else is unbound by definition.
    return { user: mask(r), scope, taskId: scope === 'agent' ? r.token_task : null };
  }
  /** The daemon's UNBOUND agent service token, reused across restarts: return the existing valid agent
   *  token if one is still within TTL, else clear stale ones and mint a fresh token. Called at boot —
   *  unlike a blind rotate, this keeps in-flight agents' credential alive across a daemon restart (they'd
   *  otherwise 401 on `elowen close`) while still bounding accumulation (at most one live token).
   *  Scoped to `task_id IS NULL` throughout, so it neither returns nor sweeps away the per-task tokens
   *  minted by {@link ensureAgentTokenForTask} for live workers. */
  ensureAgentToken(userId: number, days?: number): string {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT token FROM auth_tokens WHERE user_id = ? AND scope = 'agent' AND task_id IS NULL AND created_at > datetime('now', '-${ttlDays(days)} days') ORDER BY created_at DESC LIMIT 1`)
        .get(userId) as { token?: string } | undefined;
      if (existing?.token) return existing.token;
      this.db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND scope = 'agent' AND task_id IS NULL").run(userId);
      return this.issueToken(userId, 'agent');
    })();
  }
  /** The agent token for ONE task, reused within TTL. A worker is spawned with this instead of the
   *  shared service token, so the API can refuse it on any task but its own (and its parent epic) —
   *  the shared token alone cannot distinguish two workers in the same project. Reuse keeps a resumed
   *  or re-spawned worker on the same credential, exactly like {@link ensureAgentToken} does at boot. */
  ensureAgentTokenForTask(userId: number, taskId: string, days?: number): string {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT token FROM auth_tokens WHERE user_id = ? AND scope = 'agent' AND task_id = ? AND created_at > datetime('now', '-${ttlDays(days)} days') ORDER BY created_at DESC LIMIT 1`)
        .get(userId, taskId) as { token?: string } | undefined;
      if (existing?.token) return existing.token;
      this.db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND scope = 'agent' AND task_id = ?").run(userId, taskId);
      return this.issueToken(userId, 'agent', taskId);
    })();
  }
  /** The user's advisor token, reused across restarts. Stored under DB scope 'advisor' so it is
   *  isolated from login ('full') and worker ('agent') tokens — stopping/rotating the advisor never
   *  disturbs the user's web session. principalForToken maps any non-'agent' scope to full access, so
   *  the advisor acts with the user's own rights (mirrors ensureAgentToken's reuse-within-TTL shape). */
  ensureAdvisorToken(userId: number, days?: number): string {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT token FROM auth_tokens WHERE user_id = ? AND scope = 'advisor' AND created_at > datetime('now', '-${ttlDays(days)} days') ORDER BY created_at DESC LIMIT 1`)
        .get(userId) as { token?: string } | undefined;
      if (existing?.token) return existing.token;
      this.db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND scope = 'advisor'").run(userId);
      return this.issueToken(userId, 'advisor');
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
