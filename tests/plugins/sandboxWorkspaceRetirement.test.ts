import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';

/** The contract of the Sandbox plugin AFTER the account-owned Git workspaces were retired.
 *
 *  Two halves, because the change has two durable faces. The MANIFEST is what the daemon advertises to
 *  models and to the web (a name left there is a tool the model is told it has), and the PLUGIN DATABASE
 *  is what an instance that already ran the removed subsystem carries. A migration nobody proves is a
 *  migration that drops live lease rows on someone's box. */

const MANIFEST = JSON.parse(readFileSync(new URL('../../plugins/sandbox/elowen-plugin.json', import.meta.url), 'utf8')) as {
  provides: { tools: string[]; apiRoutes: string[] };
  web: { project: { id: string; label: string }[] };
};

const RETIRED_TOOLS = [
  'SandboxListWorkspaces', 'SandboxCreateWorkspace', 'SandboxUseWorkspace',
  'SandboxReleaseWorkspace', 'SandboxCommit', 'SandboxRemoveWorkspace',
];

describe('the Sandbox manifest after the workspace retirement', () => {
  it('advertises no retired workspace tool and no workspace route', () => {
    for (const tool of RETIRED_TOOLS) expect(MANIFEST.provides.tools).not.toContain(tool);
    expect(MANIFEST.provides.apiRoutes).not.toContain('overview');
    expect(MANIFEST.provides.apiRoutes.filter((route) => route.startsWith('workspaces/'))).toEqual([]);
  });

  it('still advertises every managed Project environment tool and the account-environment routes', () => {
    for (const tool of [
      'EnvironmentStatus', 'EnvironmentStart', 'EnvironmentStop', 'EnvironmentSnapshot',
      'EnvironmentRestore', 'EnvironmentLogs', 'EnvironmentOperation', 'EnvironmentWorktrees',
    ]) expect(MANIFEST.provides.tools).toContain(tool);
    for (const route of ['environment', 'environment/author', 'environment/reset-preview', 'environment/reset',
      'environments/status', 'environments/usage', 'environments/operation', 'runtime/host']) {
      expect(MANIFEST.provides.apiRoutes).toContain(route);
    }
  });

  it('keeps the Project drawer, now keyed by the environment it manages', () => {
    expect(MANIFEST.web.project).toEqual([{ id: 'environment', label: 'Environments', icon: 'GitBranch' }]);
  });
});

/** The v1 shape a live instance below this release actually carries, copied from the shipped migration. */
const LEGACY_V1 = `
  CREATE TABLE p_sandbox_workspaces (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, label TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, base_ref TEXT NOT NULL,
    lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'orphaned')),
    orphan_reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE p_sandbox_session_bindings (
    session_id TEXT NOT NULL, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
    workspace_id TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, user_id, project_id)
  );
  CREATE TABLE p_sandbox_execution_leases (
    id TEXT PRIMARY KEY, user_id INTEGER, workspace_id TEXT, home_generation INTEGER,
    outer_pid INTEGER NOT NULL, runner_identity TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('terminal', 'github')),
    heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

const context = (db: ReturnType<typeof openDb>) => ({ db: () => makePluginDb(db, 'sandbox', { canMigrate: true }) });

describe('the Sandbox plugin migration that retires the workspace tables', () => {
  it('drops them, removes the lease workspace column and migrates the live lease rows across', () => {
    const db = openDb(':memory:');
    db.exec(LEGACY_V1);
    db.prepare('INSERT INTO p_sandbox_workspaces (id, user_id, project_id, label, path, branch, base_ref) VALUES (?,?,?,?,?,?,?)')
      .run('ws_1', 1, 7, 'feature', '/data/users/1/workspaces/feature', 'elowen/u1/feature', 'main');
    db.prepare('INSERT INTO p_sandbox_session_bindings (session_id, user_id, project_id, workspace_id) VALUES (?,?,?,?)')
      .run('brain-1', 1, 7, 'ws_1');
    db.prepare('INSERT INTO p_sandbox_execution_leases (id, user_id, workspace_id, home_generation, outer_pid, runner_identity, kind, heartbeat_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('sxl_1', 1, 'ws_1', 3, 4242, 'linux:boot:1', 'terminal', 1, 2);

    initSandboxDb(context(db));

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'p_sandbox%'").all()
      .map((row) => (row as { name: string }).name);
    expect(tables).not.toContain('p_sandbox_workspaces');
    expect(tables).not.toContain('p_sandbox_session_bindings');
    // The managed side is untouched: its own tables still exist.
    for (const table of ['p_sandbox_runtimes', 'p_sandbox_runtime_operations', 'p_sandbox_runtime_snapshots',
      'p_sandbox_runtime_logs', 'p_sandbox_managed_worktrees', 'p_sandbox_repo_leases']) {
      expect(tables).toContain(table);
    }

    const columns = db.prepare('PRAGMA table_info(p_sandbox_execution_leases)').all()
      .map((row) => (row as { name: string }).name);
    expect(columns).not.toContain('workspace_id');
    expect(columns).toContain('resource_kind');
    expect(columns).toContain('cancel_requested');
    expect(columns).toContain('execution_id');

    // The rows are live leases of processes that may still be running: copied, never discarded.
    expect(db.prepare('SELECT user_id, home_generation, outer_pid, runner_identity FROM p_sandbox_execution_leases').get())
      .toEqual({ user_id: 1, home_generation: 3, outer_pid: 4242, runner_identity: 'linux:boot:1' });

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'p_sandbox%'").all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).not.toContain('p_sandbox_execution_leases_workspace');
    expect(indexes).toContain('p_sandbox_execution_leases_user');
    expect(indexes).toContain('p_sandbox_execution_leases_resource');

    // A later boot re-runs nothing and changes nothing.
    initSandboxDb(context(db));
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 1 });
  });
});
