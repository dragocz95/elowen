import { randomBytes } from 'node:crypto';

const CHUNK = 524288;
const TTL = 24 * 60 * 60 * 1000;
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

/** Every guest upload failure a caller is allowed to be told about, with the wording and status it gets.
 *
 *  The guest's own message is NOT forwarded. Its failures are raised from inside the transfer and their
 *  text carries whatever the operating system put there: the staging directory, the candidate file name,
 *  an errno. None of that is the caller's, none of it is actionable, and a message assembled by the guest
 *  is not a contract anything can be written against. The code is the contract, and it is answered here
 *  from a fixed table. */
const GUEST_UPLOAD_FAILURES = {
  upload_forbidden: { status: 403, message: 'This upload does not belong to this destination or scope' },
  upload_unknown: { status: 409, message: 'Upload handle is unavailable' },
  upload_invalid: { status: 409, message: 'Upload state is not valid for this step' },
  upload_completed: { status: 409, message: 'Upload is already committed' },
  upload_incomplete: { status: 409, message: 'Upload is missing chunks and cannot be committed' },
  upload_cleanup_unverified: { status: 409, message: 'Upload staging could not be verified and was left in place' },
  chunk_conflict: { status: 409, message: 'A different chunk already occupies this offset' },
  resolution_drift: { status: 409, message: 'Upload destination was retargeted while the upload was open' },
  version_conflict: { status: 409, message: 'The destination changed since the version this upload was opened against' },
  not_directory: { status: 409, message: 'Upload destination is inside something that is not a directory' },
  invalid_path: { status: 400, message: 'An absolute guest path is required' },
  invalid_operation: { status: 400, message: 'Invalid upload operation' },
  file_too_large: { status: 413, message: 'Upload exceeds the size the guest accepts' },
};

/** A guest reply that failed, rendered for the caller. An unrecognised code becomes one internal error:
 *  a code nobody has agreed on cannot be acted on either, and passing it through would be the same leak
 *  by another route. */
const guestUploadFailure = (reply) => {
  const known = GUEST_UPLOAD_FAILURES[reply?.error?.code];
  return known
    ? failure(reply.error.code, known.message, known.status)
    : failure('guest_upload_error', 'The guest could not complete this upload', 409);
};
export const UPLOAD_KINDS = ['write-begin', 'write-chunk', 'write-commit', 'write-abort'];
export const guestFileMigration = { version: 4, up(m) {
  m.exec(`CREATE TABLE p_sandbox_file_uploads (
    id TEXT PRIMARY KEY, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, project_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL, generation INTEGER NOT NULL, path TEXT NOT NULL, expected_version TEXT, size INTEGER NOT NULL,
    resolved_path TEXT, state TEXT NOT NULL DEFAULT 'pending', result_json TEXT, expires_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX p_sandbox_file_upload_active ON p_sandbox_file_uploads(resource_kind,resource_id,path) WHERE state!='committed';`);
} };
export function validateUploadOperation(op) {
  const fields = { 'write-begin': ['expectedVersion', 'size'], 'write-chunk': ['uploadId', 'offset', 'base64'], 'write-commit': ['uploadId'], 'write-abort': ['uploadId'] };
  if (!op || !Object.hasOwn(fields, op.kind) || Object.keys(op).some((key) => !['kind', 'path', ...fields[op.kind]].includes(key))) throw failure('invalid_operation', 'Invalid upload operation', 400);
  if (typeof op.path !== 'string' || !op.path.startsWith('/') || op.path.includes('\0') || op.path.length > 4096) throw failure('invalid_path', 'An absolute guest path is required', 400);
  if (op.kind === 'write-begin') {
    if (!Object.hasOwn(op, 'expectedVersion') || !(op.expectedVersion === null || (typeof op.expectedVersion === 'string' && op.expectedVersion.length <= 256))) throw failure('version_required', 'A content version is required', 400);
    if (!Number.isSafeInteger(op.size) || op.size < 0) throw failure('invalid_size', 'Invalid upload size', 400);
  } else if (typeof op.uploadId !== 'string' || !/^[a-f0-9]{32}$/.test(op.uploadId)) throw failure('invalid_upload', 'Invalid upload handle', 400);
  if (op.kind === 'write-chunk') {
    if (!Number.isSafeInteger(op.offset) || op.offset < 0 || op.offset % CHUNK) throw failure('invalid_chunk', 'Invalid chunk offset', 400);
    if (typeof op.base64 !== 'string' || op.base64.length > Math.ceil(CHUNK / 3) * 4) throw failure('invalid_chunk', 'Chunk exceeds its bound', 400);
    const bytes = Buffer.from(op.base64, 'base64');
    if (!bytes.length || bytes.length > CHUNK || bytes.toString('base64') !== op.base64) throw failure('invalid_chunk', 'Invalid chunk encoding', 400);
  }
  return op;
}

export function createGuestFileTransport({ db, runGuest, runCleanup, helperSource }) {
  const get = (id) => db.prepare('SELECT * FROM p_sandbox_file_uploads WHERE id=?').get(id);
  const scope = (item) => ({ resourceKind: item.resource_kind, resourceId: item.resource_id, projectId: item.project_id, accountUserId: item.user_id, generation: item.generation });
  async function invoke(row, item, op, cleanup = false) {
    const request = { ...op, uploadId: item.id, scope: scope(item), expectedVersion: item.expected_version, size: item.size,
      ...(item.resolved_path ? { resolvedPath: item.resolved_path } : {}) };
    const result = await (cleanup ? runCleanup : runGuest)(row, item.user_id, ['/usr/bin/python3', '-c', helperSource], { input: JSON.stringify(request), timeoutMs: 120000, kind: 'files' });
    if (result.truncated) throw failure('guest_protocol', 'Upload response exceeded its bound');
    let reply;
    try { reply = JSON.parse(result.stdout); } catch { throw failure('guest_protocol', 'Invalid upload response'); }
    if (!reply?.ok || result.code !== 0) throw guestUploadFailure(reply);
    if (reply.result?.kind !== op.kind) throw failure('guest_protocol', 'Upload response kind changed');
    return reply.result;
  }
  async function discard(row, item, cleanup = false) {
    await invoke(row, item, { kind: 'write-abort', path: item.path }, cleanup);
    db.prepare('DELETE FROM p_sandbox_file_uploads WHERE id=?').run(item.id);
  }
  return {
    async perform({ row, accountUserId, operation }) {
      const op = validateUploadOperation(operation);
      let item;
      if (op.kind === 'write-begin') {
        item = db.transaction(() => {
          const current = db.prepare('SELECT generation,state FROM p_sandbox_runtimes WHERE kind=? AND resource_id=?').get(row.kind, String(row.resource_id));
          const active = db.prepare("SELECT id FROM p_sandbox_runtime_operations WHERE kind=? AND resource_id=? AND status IN ('pending','running')").get(row.kind, String(row.resource_id));
          if (!current || current.generation !== row.generation || current.state !== 'running' || active) throw failure('environment_busy', 'Environment changed before upload registration');
          if (db.prepare("SELECT id FROM p_sandbox_file_uploads WHERE resource_kind=? AND resource_id=? AND path=? AND state!='committed'").get(row.kind, row.resource_id, op.path)) throw failure('upload_conflict', 'An upload already owns this destination');
          const id = randomBytes(16).toString('hex');
          db.prepare('INSERT INTO p_sandbox_file_uploads(id,resource_kind,resource_id,project_id,user_id,generation,path,expected_version,size,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(id, row.kind, String(row.resource_id), row.project_id, accountUserId, row.generation, op.path, op.expectedVersion, op.size, Date.now() + TTL);
          return get(id);
        });
        try {
          const result = await invoke(row, item, op);
          if (result.uploadId !== item.id || result.chunkSize !== CHUNK || typeof result.resolvedPath !== 'string' || !result.resolvedPath.startsWith('/') || result.resolvedPath.includes('\0') || result.resolvedPath.length > 4096) throw failure('guest_protocol', 'Invalid upload binding response');
          db.prepare("UPDATE p_sandbox_file_uploads SET resolved_path=?,state='receiving' WHERE id=?").run(result.resolvedPath, item.id);
          return result;
        } catch (cause) {
          try { await discard(row, item); } catch (cleanup) { throw new AggregateError([cause, cleanup], `Upload cleanup remains pending: ${cleanup.message}`); }
          throw cause;
        }
      }
      item = get(op.uploadId);
      if (!item) {
        if (op.kind === 'write-abort') return { kind: op.kind, aborted: true };
        throw failure('upload_unknown', 'Upload handle is unavailable');
      }
      if (item.resource_kind !== row.kind || item.resource_id !== String(row.resource_id) || item.project_id !== row.project_id || item.user_id !== accountUserId || item.generation !== row.generation || item.path !== op.path) throw failure('upload_forbidden', 'Upload belongs to another account, Project, generation or path', 403);
      if (op.kind === 'write-abort') { await discard(row, item); return { kind: op.kind, aborted: true }; }
      if (item.state === 'committed' && op.kind === 'write-commit') {
        await invoke(row, item, { kind: 'write-abort', path: item.path });
        return JSON.parse(item.result_json);
      }
      if (item.expires_at <= Date.now()) throw failure('upload_expired', 'Upload expired; abort it before beginning again');
      if (item.state !== 'receiving') throw failure('upload_pending', 'Upload is not ready for chunks');
      if (op.kind === 'write-chunk' && Buffer.from(op.base64, 'base64').length !== Math.min(CHUNK, item.size - op.offset)) throw failure('invalid_chunk', 'Chunk length does not match its declared range', 400);
      const result = await invoke(row, item, op);
      if (op.kind === 'write-chunk' && (!Number.isSafeInteger(result.received) || result.received < 0 || result.received > item.size)) throw failure('guest_protocol', 'Invalid upload progress');
      if (op.kind === 'write-commit') {
        if (result.entry?.kind !== 'file' || result.entry.path !== item.resolved_path || result.entry.size !== item.size || typeof result.entry.version !== 'string') throw failure('guest_protocol', 'Invalid committed file metadata');
        db.prepare("UPDATE p_sandbox_file_uploads SET state='committed',result_json=?,expires_at=? WHERE id=?").run(JSON.stringify(result), Date.now() + TTL, item.id);
        // The durable host receipt now survives a lost response; remove only guest staging.
        await invoke(row, item, { kind: 'write-abort', path: item.path });
      } else db.prepare('UPDATE p_sandbox_file_uploads SET expires_at=? WHERE id=?').run(Date.now() + TTL, item.id);
      return result;
    },
    async quiesce({ row, accountUserId, expiredOnly = false }) {
      const rows = db.prepare(`SELECT * FROM p_sandbox_file_uploads WHERE resource_kind=? AND resource_id=? AND generation=?${accountUserId === undefined ? '' : ' AND user_id=?'}${expiredOnly ? ' AND expires_at<=?' : ''}`)
        .all(row.kind, String(row.resource_id), row.generation, ...(accountUserId === undefined ? [] : [accountUserId]), ...(expiredOnly ? [Date.now()] : []));
      for (const item of rows) await discard(row, item, true);
    },
  };
}
