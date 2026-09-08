import { posix } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const CHUNK_BYTES = 128 * 1024;

/** This adapter only speaks the existing Sandbox project contract. Guest names never enter host fs. */
export function managedFiles(ctx, signal) {
  const project = ctx.currentAccess().projectRef;
  if (project?.kind !== 'managed') return null;
  if (ctx.currentAccess().workspaceRef) throw new Error('a legacy exact workspace cannot widen into a managed project');
  const accountUserId = ctx.currentAccountUserId();
  if (!Number.isSafeInteger(accountUserId) || accountUserId < 1) throw new Error('managed files require an acting account');
  const provider = () => {
    const sandbox = ctx.control('sandbox');
    if (!sandbox) throw new Error('managed project filesystem is unavailable because it requires the Sandbox plugin');
    return sandbox;
  };
  const resolve = (path = ctx.defaultCwd()) => {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('invalid guest path');
    return posix.resolve(ctx.defaultCwd(), path);
  };
  const operation = async (op) => {
    signal?.throwIfAborted();
    const result = await provider().projectFiles({ project, accountUserId, operation: op });
    if (result.kind !== op.kind) throw new Error(`managed filesystem returned ${result.kind} for ${op.kind}`);
    return result;
  };
  const stat = async (path) => (await operation({ kind: 'stat', path })).entry;
  const chunk = async (path, offset, length) => {
    const result = await operation({ kind: 'read', path, offset, length, maxBytes: length });
    if (typeof result.base64 !== 'string' || result.base64.length > Math.ceil(length / 3) * 4) {
      throw new Error('managed filesystem exceeded the byte transport limit');
    }
    const bytes = Buffer.from(result.base64, 'base64');
    if (bytes.length > length || !Number.isSafeInteger(result.totalBytes) || result.totalBytes < 0 || !result.version) {
      throw new Error('managed filesystem returned an invalid or oversized read');
    }
    return { ...result, bytes };
  };
  async function* chunks(path) {
    let offset = 0;
    let version;
    let total;
    do {
      const result = await chunk(path, offset, CHUNK_BYTES);
      if (version !== undefined && (version !== result.version || total !== result.totalBytes)) {
        throw new Error('file changed while it was being read; retry the Read');
      }
      version = result.version;
      total = result.totalBytes;
      if (result.bytes.length === 0 && offset < total) throw new Error('managed file read ended before EOF');
      offset += result.bytes.length;
      yield result.bytes;
    } while (offset < total);
    const final = await stat(path);
    if (!final || final.version !== version) throw new Error('file changed while it was being read; retry the Read');
  }
  const read = async (path, maxBytes) => {
    const before = await stat(path);
    if (!before) throw new Error(`File does not exist: ${path}`);
    if (before.kind !== 'file') throw new Error('path is not a regular file');
    if (before.size > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte read limit`);
    const parts = [];
    let length = 0;
    for await (const bytes of chunks(path)) {
      length += bytes.length;
      if (length > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte read limit`);
      parts.push(bytes);
    }
    const after = await stat(path);
    if (!after || before.version !== after.version) throw new Error('file changed while it was being read; retry the Read');
    return { bytes: Buffer.concat(parts), version: before.version };
  };
  const write = async (path, bytes, expectedVersion) => {
    const missing = [];
    let parent = posix.dirname(path);
    while (!(await stat(parent))) {
      missing.push(parent);
      const next = posix.dirname(parent);
      if (next === parent) throw new Error('guest filesystem root is unavailable');
      parent = next;
    }
    for (const directory of missing.reverse()) {
      try { await operation({ kind: 'mkdir', path: directory }); }
      catch (error) {
        if (error.code !== 'already_exists' || (await stat(directory))?.kind !== 'directory') throw error;
      }
    }
    return operation({ kind: 'write', path, base64: bytes.toString('base64'), expectedVersion });
  };
  const list = (path, limit) => operation({ kind: 'list', path, limit: Math.min(limit, 1000) });
  const exec = async (file, args, options = {}) => {
    const prepared = await provider().prepareExecution({
      command: { type: 'argv', file, args }, cwd: options.cwd ?? ctx.defaultCwd(), leaseKind: 'files', projectRef: project,
    });
    const cancel = prepared.cancel ? () => prepared.cancel() : prepared.lease.cancel ? () => prepared.lease.cancel() : null;
    const controller = new AbortController();
    let heartbeat;
    let leaseError;
    let failure;
    try {
      if (prepared.mode !== 'managed' || prepared.projectRef?.kind !== 'managed' || prepared.projectRef.projectId !== project.projectId) {
        throw new Error('managed project provider returned a different execution target');
      }
      if (!cancel) throw new Error('managed execution requires verified guest cancellation');
      if (prepared.stdin !== undefined && ((typeof prepared.stdin !== 'string' && !Buffer.isBuffer(prepared.stdin))
        || Buffer.byteLength(prepared.stdin) > 1024 * 1024)) throw new Error('invalid or oversized prepared stdin');
      heartbeat = setInterval(() => {
        Promise.resolve().then(() => prepared.lease.heartbeat()).catch((error) => { leaseError = error; controller.abort(); });
      }, 5000);
      heartbeat.unref?.();
      const launch = prepared.launch;
      const runOptions = { ...options, cwd: prepared.cwd, env: launch.env,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal };
      const pending = launch.type === 'argv'
        ? execFileP(launch.file, launch.args, runOptions)
        : execFileP('/bin/sh', ['-c', launch.command], runOptions);
      pending.child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') { leaseError = error; controller.abort(); } });
      pending.child.stdin.end(prepared.stdin);
      const result = await pending;
      if (typeof result.stdout === 'string') result.stdout = prepared.sanitizeOutput(result.stdout);
      if (typeof result.stderr === 'string') result.stderr = prepared.sanitizeOutput(result.stderr);
      return result;
    } catch (error) {
      failure = leaseError ?? error;
      if (failure instanceof Error) failure.message = prepared.sanitizeOutput(failure.message);
      if (cancel) {
        try { await cancel(); }
        catch (cleanup) { failure = new AggregateError([failure, cleanup], `Guest cancellation failed: ${prepared.sanitizeOutput(cleanup.message)}`); }
      }
      throw failure;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      try { await prepared.lease.release(); }
      catch (cleanup) { throw new AggregateError([...(failure ? [failure] : []), cleanup], 'Guest command cleanup failed'); }
    }
  };
  const walk = async (root, limit, skip) => {
    const files = [];
    let truncated = false;
    let visited = 0;
    const visit = async (path) => {
      if (visited >= limit) { truncated = true; return; }
      const listing = await list(path, limit - visited);
      truncated ||= listing.truncated;
      for (const entry of listing.entries) {
        if (++visited > limit) { truncated = true; break; }
        if (entry.kind === 'file') files.push(entry.path);
        else if (entry.kind === 'directory' && !skip.has(posix.basename(entry.path))) await visit(entry.path);
      }
    };
    await visit(root);
    return { files, truncated };
  };
  return { project, resolve, stat, chunk, chunks, read, write, list, exec, walk };
}
