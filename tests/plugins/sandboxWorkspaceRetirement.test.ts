import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb, SANDBOX_MIGRATIONS } from '../../plugins/sandbox/lib/db.mjs';

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

  /** Everything the retirement is ALLOWED to touch: the two obsolete tables, the indexes that belong to
   *  them, the rebuilt lease table with its indexes, and the bookkeeping row the step writes itself. Any
   *  other object appearing, disappearing or changing shape/content below is a bug this must catch. */
  const RETIREMENT_SCOPE = new Set([
    'p_sandbox_workspaces', 'p_sandbox_session_bindings',
    'p_sandbox_workspaces_user_project', 'p_sandbox_workspaces_user_branch', 'p_sandbox_bindings_workspace',
    'p_sandbox_execution_leases', 'p_sandbox_execution_leases_user',
    'p_sandbox_execution_leases_workspace', 'p_sandbox_execution_leases_resource',
    'plugin_migrations',
  ]);

  /** The whole database outside that scope: every object's definition, and every table's rows. */
  function fingerprint(db: ReturnType<typeof openDb>): Record<string, string> {
    const out: Record<string, string> = {};
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
      .filter((row) => !RETIREMENT_SCOPE.has(String((row as { name: string }).name)));
    for (const object of objects) {
      const { type, name, sql } = object as { type: string; name: string; sql: string | null };
      out[`${type} ${name}`] = sql === null ? '' : sql;
      if (type === 'table') out[`rows ${name}`] = JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
    }
    return out;
  }

  /** A live instance that ran the removed subsystem plus the managed environment it also owns. */
  function liveInstance(db: ReturnType<typeof openDb>): void {
    db.exec(LEGACY_V1);
    makePluginDb(db, 'sandbox', { canMigrate: true })
      .migrate(SANDBOX_MIGRATIONS.filter((step: { version: number }) => step.version !== 7));
    db.prepare('INSERT INTO p_sandbox_workspaces (id, user_id, project_id, label, path, branch, base_ref) VALUES (?,?,?,?,?,?,?)')
      .run('ws_1', 1, 7, 'feature', '/data/users/1/workspaces/feature', 'elowen/u1/feature', 'main');
    db.prepare('INSERT INTO p_sandbox_session_bindings (session_id, user_id, project_id, workspace_id) VALUES (?,?,?,?)')
      .run('brain-1', 1, 7, 'ws_1');
    db.prepare(`INSERT INTO p_sandbox_execution_leases
      (id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at,
       resource_kind,resource_id,runtime_generation,execution_id,cancel_requested) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('sxl_1', 1, 'ws_1', 3, 4242, 'linux:boot:1', 'terminal', 1, 2, 'project', '7', 4, 'exec-1', 1);
    // The managed environment this plugin actually owns, in every table that describes it.
    db.prepare(`INSERT INTO p_sandbox_runtimes
      (kind,resource_id,project_id,generation,state,desired_state,spec_json,limits_json) VALUES (?,?,?,?,?,?,?,?)`)
      .run('project', '7', 7, 4, 'running', 'running', '{"resource":{"kind":"project","id":7}}', '{"cpus":2}');
    db.prepare(`INSERT INTO p_sandbox_runtime_operations
      (id,kind,resource_id,user_id,request_key,generation,action_json,status,checkpoint_json,steps_json,step_index,percent)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('env_1', 'project', '7', 1, 'req-1', 4, '{"kind":"start"}', 'running', '{"phase":"boot"}', '["boot","ready"]', 1, 50);
    db.prepare(`INSERT INTO p_sandbox_runtime_snapshots (id,kind,resource_id,generation,spec_json,manifest_json,note)
      VALUES (?,?,?,?,?,?,?)`)
      .run('snap_1', 'project', '7', 3, '{"image":"rootfs"}', '{"files":[]}', 'before upgrade');
    db.prepare('INSERT INTO p_sandbox_runtime_logs (kind,resource_id,message) VALUES (?,?,?)').run('project', '7', 'started');
    db.prepare(`INSERT INTO p_sandbox_managed_worktrees
      (id,project_id,created_by,label,path,branch,base_ref,base_commit,state) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('mw_1', 7, 1, 'kolin', '/srv/worktrees/kolin', 'elowen/kolin-1', 'main', 'abc123', 'ready');
    db.prepare(`INSERT INTO p_sandbox_repo_leases
      (common_dir,owner_id,outer_pid,runner_identity,heartbeat_at,expires_at) VALUES (?,?,?,?,?,?)`)
      .run('/repo/.git', 'srl_1', 4242, 'linux:boot:1', 1, 2);
    // Runtime data this plugin does not own at all: a core table and another plugin's table.
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (7,'kolin','/srv/kolin')").run();
    db.exec('CREATE TABLE p_other_state (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    db.prepare('INSERT INTO p_other_state (id,payload) VALUES (?,?)').run('row-1', 'untouched');
  }

  it('drops exactly the two tables and leaves every other object byte-identical', () => {
    const db = openDb(':memory:');
    liveInstance(db);
    const before = fingerprint(db);
    const leaseRowBefore = db.prepare('SELECT * FROM p_sandbox_execution_leases').get();
    const retirement = SANDBOX_MIGRATIONS.filter((step: { version: number }) => step.version === 7);
    expect(retirement).toHaveLength(1);

    makePluginDb(db, 'sandbox', { canMigrate: true }).migrate(retirement);

    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String((row as { name: string }).name));
    expect(names).not.toContain('p_sandbox_workspaces');
    expect(names).not.toContain('p_sandbox_session_bindings');
    // …and no OTHER table in the whole database changed definition or content.
    expect(fingerprint(db)).toEqual(before);
    // A workspace id is now meaningless everywhere: the leases that carried one kept the column's data
    // nowhere, and the table that was built around it is gone.
    const carriers = names.filter((name) => (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[])
      .some((column) => column.name === 'workspace_id'));
    expect(carriers).toEqual([]);

    // The lease table is rebuilt: the same rows, without only the column that named a workspace.
    expect((db.prepare('PRAGMA table_info(p_sandbox_execution_leases)').all() as { name: string }[]).map((column) => column.name))
      .toEqual(['id', 'user_id', 'home_generation', 'outer_pid', 'runner_identity', 'kind', 'heartbeat_at',
        'expires_at', 'created_at', 'resource_kind', 'resource_id', 'runtime_generation', 'execution_id', 'cancel_requested']);
    const leaseRowAfter = db.prepare('SELECT * FROM p_sandbox_execution_leases').get() as Record<string, unknown>;
    const leaseRowExpected = Object.fromEntries(Object.entries(leaseRowBefore as Record<string, unknown>).filter(([key]) => key !== 'workspace_id'));
    expect(leaseRowAfter).toMatchObject(leaseRowExpected);
    expect('workspace_id' in leaseRowAfter).toBe(false);

    // The managed environment this plugin owns survives whole, rows included.
    expect(db.prepare('SELECT * FROM p_sandbox_runtimes').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM p_sandbox_runtime_operations').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM p_sandbox_runtime_snapshots').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM p_sandbox_runtime_logs').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM p_sandbox_managed_worktrees').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM p_sandbox_repo_leases').all()).toHaveLength(1);
    expect(db.prepare('SELECT payload FROM p_other_state').get()).toEqual({ payload: 'untouched' });

    // Only one migration was applied, and only this one.
    expect(db.prepare("SELECT version FROM plugin_migrations WHERE plugin='sandbox' ORDER BY version").all())
      .toEqual([1, 2, 3, 4, 5, 6, 7].map((version) => ({ version })));
  });

  it('is idempotent: a later boot re-runs no step and mutates nothing', () => {
    const db = openDb(':memory:');
    liveInstance(db);
    initSandboxDb(context(db));
    const settled = fingerprint(db);
    const migrations = db.prepare('SELECT COUNT(*) AS n FROM plugin_migrations').get();

    initSandboxDb(context(db));

    expect(fingerprint(db)).toEqual(settled);
    expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_migrations').get()).toEqual(migrations);
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_runtime_operations').get()).toEqual({ n: 1 });
  });
});
