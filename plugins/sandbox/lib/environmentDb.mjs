import { randomBytes, randomUUID } from 'node:crypto';

export const environmentMigration = {
  version: 3,
  up(m) {
    m.exec(`
      ALTER TABLE p_sandbox_execution_leases RENAME TO p_sandbox_execution_leases_old;
      CREATE TABLE p_sandbox_execution_leases (
        id TEXT PRIMARY KEY, user_id INTEGER, workspace_id TEXT, home_generation INTEGER,
        outer_pid INTEGER NOT NULL, runner_identity TEXT NOT NULL, kind TEXT NOT NULL,
        heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resource_kind TEXT, resource_id TEXT, runtime_generation INTEGER, execution_id TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO p_sandbox_execution_leases (id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at,created_at)
        SELECT id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at,created_at FROM p_sandbox_execution_leases_old;
      DROP TABLE p_sandbox_execution_leases_old;
      CREATE INDEX p_sandbox_execution_leases_user ON p_sandbox_execution_leases(user_id,home_generation,expires_at);
      CREATE INDEX p_sandbox_execution_leases_workspace ON p_sandbox_execution_leases(workspace_id,expires_at);
      CREATE INDEX p_sandbox_execution_leases_resource ON p_sandbox_execution_leases(resource_kind,resource_id,runtime_generation);
      CREATE TABLE p_sandbox_runtimes (
        kind TEXT NOT NULL CHECK(kind IN ('project','site')), resource_id TEXT NOT NULL, project_id INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'unprovisioned', desired_state TEXT NOT NULL DEFAULT 'running',
        spec_json TEXT NOT NULL, limits_json TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(kind,resource_id)
      );
      CREATE TABLE p_sandbox_runtime_operations (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, resource_id TEXT NOT NULL, user_id INTEGER,
        request_key TEXT NOT NULL, generation INTEGER NOT NULL, action_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', checkpoint_json TEXT NOT NULL DEFAULT '{}',
        owner_pid INTEGER, owner_identity TEXT, error TEXT, snapshot_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(kind,resource_id,user_id,request_key)
      );
      CREATE UNIQUE INDEX p_sandbox_runtime_operation_active ON p_sandbox_runtime_operations(kind,resource_id) WHERE status IN ('pending','running');
      CREATE TABLE p_sandbox_runtime_snapshots (
        id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL, generation INTEGER NOT NULL,
        spec_json TEXT NOT NULL, manifest_json TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(kind,resource_id,id)
      );
      CREATE TABLE p_sandbox_runtime_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
        message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE p_sandbox_managed_worktrees (
        id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, created_by INTEGER NOT NULL,
        label TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base_ref TEXT NOT NULL,
        base_commit TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'creating',
        UNIQUE(project_id,path), UNIQUE(project_id,branch)
      );
    `);
  },
};

/** The declared step list and the position inside it. A lifecycle operation already survived a daemon
 *  restart through `checkpoint_json`; what it could not say was WHERE it was, so every surface watching
 *  one had to poll a status word. These three columns are that missing statement, on the same durable
 *  row and written by the same `saveOperation`, so a reader that sees the operation sees its progress. */
export const environmentProgressMigration = {
  version: 5,
  up(m) {
    m.exec(`
      ALTER TABLE p_sandbox_runtime_operations ADD COLUMN steps_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE p_sandbox_runtime_operations ADD COLUMN step_index INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE p_sandbox_runtime_operations ADD COLUMN percent REAL;
    `);
  },
};

/** The one projection of an operation row onto the wire shape both the project and the Site surfaces
 *  read (`EnvironmentOperation`, `SiteEnvironmentOperation`). It lives beside the row mapper because a
 *  second copy of it is how the declared progress fields went missing from one of them. */
export const operationView = (op) => ({ id: op.id, requestId: op.request_key, [op.kind === 'project' ? 'projectId' : 'siteId']: op.kind === 'project' ? Number(op.resource_id) : op.resource_id,
  accountUserId: op.user_id, generation: op.generation, action: op.action, status: op.status, error: op.error ?? null, ...(op.snapshot_id ? { snapshotId: op.snapshot_id } : {}),
  steps: op.steps ?? [], stepIndex: Number(op.step_index ?? 0), stepTotal: (op.steps ?? []).length,
  stepLabel: (op.steps ?? [])[Number(op.step_index ?? 0)] ?? null,
  percent: op.percent === null || op.percent === undefined ? null : Number(op.percent) });

/** How many operations one resource keeps. The project overview reads the newest of them, so a row that
 *  settles beyond this bound is history nothing reads and is deleted as it settles rather than kept for
 *  the life of the environment. A row still carrying a container or volume recipe in its checkpoint is
 *  never counted out: the delete path collects those specs to remove what a past restore left behind, and
 *  the generation one of them reserved must not be handed out a second time. */
export const OPERATION_HISTORY = 20;

const runtime = (row) => row ? { ...row, generation: Number(row.generation), spec: JSON.parse(row.spec_json), limits: JSON.parse(row.limits_json) } : null;
const operation = (row) => row ? { ...row, action: JSON.parse(row.action_json), checkpoint: JSON.parse(row.checkpoint_json),
  steps: JSON.parse(row.steps_json ?? '[]'), step_index: Number(row.step_index ?? 0),
  percent: row.percent === null || row.percent === undefined ? null : Number(row.percent) } : null;
export function createEnvironmentStore(db, identity) {
  const get = (kind, id) => runtime(db.prepare('SELECT * FROM p_sandbox_runtimes WHERE kind=? AND resource_id=?').get(kind, String(id)));
  const getOperation = (id) => operation(db.prepare('SELECT * FROM p_sandbox_runtime_operations WHERE id=?').get(id));
  return {
    db, get, getOperation,
    transaction: (fn) => db.transaction(fn),
    all: () => db.prepare('SELECT * FROM p_sandbox_runtimes').all().map(runtime),
    insert(kind, id, projectId, spec, limits) {
      db.prepare('INSERT OR IGNORE INTO p_sandbox_runtimes(kind,resource_id,project_id,spec_json,limits_json) VALUES (?,?,?,?,?)')
        .run(kind, String(id), projectId, JSON.stringify(spec), JSON.stringify(limits));
      return get(kind, id);
    },
    save(row) {
      db.prepare('UPDATE p_sandbox_runtimes SET generation=?,state=?,desired_state=?,spec_json=?,limits_json=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE kind=? AND resource_id=?')
        .run(row.generation, row.state, row.desired_state, JSON.stringify(row.spec), JSON.stringify(row.limits), row.error ?? null, row.kind, row.resource_id);
    },
    active(kind, id) { return operation(db.prepare("SELECT * FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=? AND status IN ('pending','running')").get(kind, String(id))); },
    prior(kind, id, userId, key) { return operation(db.prepare('SELECT * FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=? AND user_id IS ? AND request_key=?').get(kind, String(id), userId, key)); },
    enqueue(row, userId, action, key = randomUUID()) {
      const id = `env_${randomUUID()}`;
      db.prepare('INSERT INTO p_sandbox_runtime_operations(id,kind,resource_id,user_id,request_key,generation,action_json) VALUES(?,?,?,?,?,?,?)')
        .run(id, row.kind, row.resource_id, userId, key, row.generation, JSON.stringify(action));
      return getOperation(id);
    },
    operations: () => db.prepare("SELECT * FROM p_sandbox_runtime_operations WHERE status IN ('pending','running') ORDER BY created_at,id").all().map(operation),
    /** The newest operations of one resource, newest first. Bounded because the row set only grows and
     *  no surface reading it has a use for the whole history. */
    recentOperations(kind, id, limit) {
      return db.prepare('SELECT * FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=? ORDER BY rowid DESC LIMIT ?')
        .all(kind, String(id), limit).map(operation);
    },
    /** The last write of an operation's life, and therefore the one place that knows a row stopped
     *  moving: a settled operation counts against the resource's bounded history, and the rows it pushes
     *  out are deleted here. */
    saveOperation(op) {
      db.prepare('UPDATE p_sandbox_runtime_operations SET status=?,checkpoint_json=?,owner_pid=?,owner_identity=?,error=?,snapshot_id=?,steps_json=?,step_index=?,percent=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(op.status, JSON.stringify(op.checkpoint), op.owner_pid ?? null, op.owner_identity ?? null, op.error ?? null, op.snapshot_id ?? null,
          JSON.stringify(op.steps ?? []), Number(op.step_index ?? 0), op.percent === null || op.percent === undefined ? null : Number(op.percent), op.id);
      if (op.status !== 'succeeded' && op.status !== 'failed') return;
      db.prepare(`DELETE FROM p_sandbox_runtime_operations
        WHERE kind=? AND resource_id=? AND status IN ('succeeded','failed')
          AND json_extract(checkpoint_json,'$.oldSpec') IS NULL AND json_extract(checkpoint_json,'$.newSpec') IS NULL
          AND id NOT IN (SELECT id FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=? ORDER BY rowid DESC LIMIT ?)`)
        .run(op.kind, op.resource_id, op.kind, op.resource_id, OPERATION_HISTORY);
    },
    log(kind, id, message) {
      db.prepare('INSERT INTO p_sandbox_runtime_logs(kind,resource_id,message) VALUES(?,?,?)').run(kind, String(id), String(message).slice(0, 2000));
      db.prepare('DELETE FROM p_sandbox_runtime_logs WHERE kind=? AND resource_id=? AND id NOT IN (SELECT id FROM p_sandbox_runtime_logs WHERE kind=? AND resource_id=? ORDER BY id DESC LIMIT 200)')
        .run(kind, String(id), kind, String(id));
    },
    /** The tail of the same ring buffer, newest last, as discrete lines. The progress dialog shows this
     *  while an operation runs; `logs` keeps returning the whole buffer as one blob for the log view. */
    logTail(kind, id, limit = 40) {
      return db.prepare('SELECT message FROM p_sandbox_runtime_logs WHERE kind=? AND resource_id=? ORDER BY id DESC LIMIT ?')
        .all(kind, String(id), Math.max(1, Math.min(200, limit))).map((entry) => entry.message).reverse();
    },
    logs(kind, id) { return db.prepare('SELECT created_at,message FROM p_sandbox_runtime_logs WHERE kind=? AND resource_id=? ORDER BY id').all(kind, String(id)).map((entry) => `${entry.created_at} ${entry.message}`).join('\n'); },
    snapshots(kind, id) { return db.prepare('SELECT * FROM p_sandbox_runtime_snapshots WHERE kind=? AND resource_id=? ORDER BY julianday(created_at) DESC,id').all(kind, String(id)); },
    snapshot(kind, id, snapshotId) { return db.prepare('SELECT * FROM p_sandbox_runtime_snapshots WHERE kind=? AND resource_id=? AND id=?').get(kind, String(id), snapshotId); },
    saveSnapshot(row, id, manifest, note) {
      db.prepare('INSERT OR IGNORE INTO p_sandbox_runtime_snapshots(id,kind,resource_id,generation,spec_json,manifest_json,note) VALUES(?,?,?,?,?,?,?)')
        .run(id, row.kind, row.resource_id, row.generation, JSON.stringify(row.spec), JSON.stringify(manifest), note ?? '');
    },
    leases(kind, id, userId) {
      return db.prepare(`SELECT * FROM p_sandbox_execution_leases WHERE resource_kind=? AND resource_id=?${userId === undefined ? '' : ' AND user_id=?'}`)
        .all(kind, String(id), ...(userId === undefined ? [] : [userId]));
    },
    mintLease(row, userId, kind) {
      const id = `sxl_${randomUUID()}`;
      const executionId = randomBytes(16).toString('hex');
      const now = Date.now();
      db.prepare('INSERT INTO p_sandbox_execution_leases(id,user_id,outer_pid,runner_identity,kind,heartbeat_at,expires_at,resource_kind,resource_id,runtime_generation,execution_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, userId, process.pid, identity() ?? 'unverifiable', kind, now, now + 20000, row.kind, row.resource_id, row.generation, executionId);
      return db.prepare('SELECT * FROM p_sandbox_execution_leases WHERE id=?').get(id);
    },
  };
}
