import { randomUUID } from 'node:crypto';

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
  }]);
  return db;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export function reconcileStaleLeases(db, now = Date.now()) {
  const execution = db.prepare('SELECT id, outer_pid, expires_at FROM p_sandbox_execution_leases').all();
  let executionRemoved = 0;
  for (const row of execution) {
    if (Number(row.expires_at) >= now && processAlive(Number(row.outer_pid))) continue;
    executionRemoved += db.prepare('DELETE FROM p_sandbox_execution_leases WHERE id = ?').run(String(row.id)).changes;
  }
  const repos = db.prepare('SELECT common_dir, outer_pid, expires_at FROM p_sandbox_repo_leases').all();
  let reposRemoved = 0;
  for (const row of repos) {
    if (Number(row.expires_at) >= now && processAlive(Number(row.outer_pid))) continue;
    reposRemoved += db.prepare('DELETE FROM p_sandbox_repo_leases WHERE common_dir = ?').run(String(row.common_dir)).changes;
  }
  return { executionRemoved, reposRemoved };
}

export function createExecutionLease(db, input) {
  reconcileStaleLeases(db);
  const id = `sxl_${randomUUID()}`;
  const now = Date.now();
  const runnerIdentity = `${process.env.ELOWEN_RUNNER_ID || 'process'}:${process.pid}`;
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
  reconcileStaleLeases(db);
  const clauses = [];
  const params = [];
  if (input.accountUserId !== undefined) { clauses.push('user_id IS ?'); params.push(input.accountUserId); }
  if (input.workspaceId !== undefined) { clauses.push('workspace_id IS ?'); params.push(input.workspaceId); }
  if (input.homeGeneration !== undefined) { clauses.push('home_generation IS ?'); params.push(input.homeGeneration); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT id, user_id, workspace_id, home_generation, outer_pid, kind, heartbeat_at, expires_at
    FROM p_sandbox_execution_leases${where} ORDER BY created_at`).all(...params);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRepoLease(db, commonDir, fn, opts = {}) {
  const ownerId = `srl_${randomUUID()}`;
  const runnerIdentity = `${process.env.ELOWEN_RUNNER_ID || 'process'}:${process.pid}`;
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  for (;;) {
    reconcileStaleLeases(db);
    const now = Date.now();
    const claimed = db.prepare(`INSERT INTO p_sandbox_repo_leases
      (common_dir, owner_id, outer_pid, runner_identity, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(common_dir) DO UPDATE SET
        owner_id = excluded.owner_id,
        outer_pid = excluded.outer_pid,
        runner_identity = excluded.runner_identity,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at
      WHERE p_sandbox_repo_leases.expires_at < ?`)
      .run(commonDir, ownerId, process.pid, runnerIdentity, now, now + REPO_LEASE_MS, now);
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
