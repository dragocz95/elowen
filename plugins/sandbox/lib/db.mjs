import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const EXECUTION_LEASE_MS = 20_000;
const REPO_LEASE_MS = 30_000;

export function initSandboxDb(ctx) {
  const db = ctx.db();
  db.migrate([{
    version: 1,
    up(m) {
      m.exec(`
        CREATE TABLE IF NOT EXISTS p_sandbox_workspaces (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          project_id INTEGER NOT NULL,
          label TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          branch TEXT NOT NULL,
          base_ref TEXT NOT NULL,
          lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'orphaned')),
          orphan_reason TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS p_sandbox_workspaces_user_project
          ON p_sandbox_workspaces(user_id, project_id, lifecycle, last_used_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS p_sandbox_workspaces_user_branch
          ON p_sandbox_workspaces(user_id, project_id, branch);

        CREATE TABLE IF NOT EXISTS p_sandbox_session_bindings (
          session_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          project_id INTEGER NOT NULL,
          workspace_id TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (session_id, user_id, project_id)
        );
        CREATE INDEX IF NOT EXISTS p_sandbox_bindings_workspace
          ON p_sandbox_session_bindings(workspace_id);

        CREATE TABLE IF NOT EXISTS p_sandbox_execution_leases (
          id TEXT PRIMARY KEY,
          user_id INTEGER,
          workspace_id TEXT,
          home_generation INTEGER,
          outer_pid INTEGER NOT NULL,
          runner_identity TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('terminal', 'github')),
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS p_sandbox_execution_leases_user
          ON p_sandbox_execution_leases(user_id, home_generation, expires_at);
        CREATE INDEX IF NOT EXISTS p_sandbox_execution_leases_workspace
          ON p_sandbox_execution_leases(workspace_id, expires_at);

        CREATE TABLE IF NOT EXISTS p_sandbox_repo_leases (
          common_dir TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          outer_pid INTEGER NOT NULL,
          runner_identity TEXT NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
    },
  }, {
    version: 2,
    // A supervised background runtime is a third kind of held execution, and the original CHECK named
    // only the two that existed. SQLite cannot widen a CHECK in place, so the table is rebuilt: the
    // rows are live leases of processes that may still be running, which is exactly why they are copied
    // across rather than dropped and left to expire.
    up(m) {
      m.exec(`
        CREATE TABLE p_sandbox_execution_leases_v2 (
          id TEXT PRIMARY KEY,
          user_id INTEGER,
          workspace_id TEXT,
          home_generation INTEGER,
          outer_pid INTEGER NOT NULL,
          runner_identity TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('terminal', 'github', 'sites')),
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO p_sandbox_execution_leases_v2
          SELECT id, user_id, workspace_id, home_generation, outer_pid, runner_identity, kind,
                 heartbeat_at, expires_at, created_at
          FROM p_sandbox_execution_leases;
        DROP TABLE p_sandbox_execution_leases;
        ALTER TABLE p_sandbox_execution_leases_v2 RENAME TO p_sandbox_execution_leases;
        CREATE INDEX IF NOT EXISTS p_sandbox_execution_leases_user
          ON p_sandbox_execution_leases(user_id, home_generation, expires_at);
        CREATE INDEX IF NOT EXISTS p_sandbox_execution_leases_workspace
          ON p_sandbox_execution_leases(workspace_id, expires_at);
      `);
    },
  }]);
  return db;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    return null;
  }
}

export function processIdentity(pid = process.pid) {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (!bootId || end < 0) return null;
    const fields = stat.slice(end + 1).trim().split(/\s+/);
    const startTicks = fields[19];
    return startTicks && /^\d+$/.test(startTicks) ? `linux:${bootId}:${startTicks}` : null;
  } catch {
    return null;
  }
}

function ownerProvablyDead(row) {
  const pid = Number(row.outer_pid);
  const exists = processExists(pid);
  if (exists === false) return true;
  if (exists !== true) return false;
  const stored = String(row.runner_identity ?? '');
  if (!stored.startsWith('linux:')) return false;
  const current = processIdentity(pid);
  return current !== null && current !== stored;
}

// A lease is stale on either of two grounds. Its owner process is provably gone — the crash-of-the-whole-
// runner case. Or nobody has heartbeated it past `expires_at` — the case a live owner cannot express any
// other way: the daemon pid outlives every aborted command and every runner that died inside it, so an
// unrefreshed window is the only signal that the holder stopped caring.
export function reconcileStaleLeases(db, now = Date.now()) {
  let executionRemoved = db.prepare('DELETE FROM p_sandbox_execution_leases WHERE expires_at <= ?').run(now).changes;
  const execution = db.prepare('SELECT id, outer_pid, runner_identity FROM p_sandbox_execution_leases').all();
  for (const row of execution) {
    if (!ownerProvablyDead(row)) continue;
    executionRemoved += db.prepare('DELETE FROM p_sandbox_execution_leases WHERE id = ?').run(String(row.id)).changes;
  }
  let reposRemoved = db.prepare('DELETE FROM p_sandbox_repo_leases WHERE expires_at <= ?').run(now).changes;
  const repos = db.prepare('SELECT common_dir, outer_pid, runner_identity FROM p_sandbox_repo_leases').all();
  for (const row of repos) {
    if (!ownerProvablyDead(row)) continue;
    reposRemoved += db.prepare('DELETE FROM p_sandbox_repo_leases WHERE common_dir = ?').run(String(row.common_dir)).changes;
  }
  return { executionRemoved, reposRemoved };
}

export function createExecutionLease(db, input) {
  reconcileStaleLeases(db);
  const id = `sxl_${randomUUID()}`;
  const now = Date.now();
  const runnerIdentity = processIdentity() ?? `unverifiable:${randomUUID()}`;
  db.prepare(`INSERT INTO p_sandbox_execution_leases
    (id, user_id, workspace_id, home_generation, outer_pid, runner_identity, kind, heartbeat_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.accountUserId, input.workspaceId, input.homeGeneration, process.pid, runnerIdentity, input.kind, now, now + EXECUTION_LEASE_MS);
  let released = false;
  return {
    id,
    accountUserId: input.accountUserId,
    workspaceId: input.workspaceId,
    homeGeneration: input.homeGeneration,
    heartbeat() {
      if (released) return;
      const at = Date.now();
      db.prepare('UPDATE p_sandbox_execution_leases SET heartbeat_at = ?, expires_at = ? WHERE id = ?')
        .run(at, at + EXECUTION_LEASE_MS, id);
    },
    release() {
      if (released) return;
      released = true;
      db.prepare('DELETE FROM p_sandbox_execution_leases WHERE id = ?').run(id);
    },
  };
}

export function activeExecutionLeases(db, input = {}) {
  const now = Date.now();
  reconcileStaleLeases(db, now);
  const clauses = ['expires_at > ?'];
  const params = [now];
  if (input.accountUserId !== undefined) { clauses.push('user_id IS ?'); params.push(input.accountUserId); }
  if (input.workspaceId !== undefined) { clauses.push('workspace_id IS ?'); params.push(input.workspaceId); }
  if (input.homeGeneration !== undefined) { clauses.push('home_generation IS ?'); params.push(input.homeGeneration); }
  return db.prepare(`SELECT id, user_id, workspace_id, home_generation, outer_pid, kind, heartbeat_at, expires_at
    FROM p_sandbox_execution_leases WHERE ${clauses.join(' AND ')} ORDER BY created_at`).all(...params);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForExecutionLeases(db, input = {}, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const active = activeExecutionLeases(db, input);
    if (active.length === 0) return [];
    if (Date.now() >= deadline) return active;
    await sleep(50);
  }
}

export async function withRepoLease(db, commonDir, fn, opts = {}) {
  const ownerId = `srl_${randomUUID()}`;
  const runnerIdentity = processIdentity() ?? `unverifiable:${randomUUID()}`;
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  for (;;) {
    reconcileStaleLeases(db);
    const now = Date.now();
    const claimed = db.prepare(`INSERT OR IGNORE INTO p_sandbox_repo_leases
      (common_dir, owner_id, outer_pid, runner_identity, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(commonDir, ownerId, process.pid, runnerIdentity, now, now + REPO_LEASE_MS);
    const held = db.prepare('SELECT owner_id FROM p_sandbox_repo_leases WHERE common_dir = ?').get(commonDir);
    if (claimed.changes > 0 && held?.owner_id === ownerId) break;
    if (Date.now() >= deadline) throw new Error('repository worktree metadata is busy in another process');
    await sleep(100);
  }

  const heartbeat = setInterval(() => {
    const now = Date.now();
    db.prepare(`UPDATE p_sandbox_repo_leases SET heartbeat_at = ?, expires_at = ?
      WHERE common_dir = ? AND owner_id = ?`).run(now, now + REPO_LEASE_MS, commonDir, ownerId);
  }, 5_000);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    db.prepare('DELETE FROM p_sandbox_repo_leases WHERE common_dir = ? AND owner_id = ?').run(commonDir, ownerId);
  }
}
