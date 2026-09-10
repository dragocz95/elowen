import { posix } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const CHUNK_BYTES = 128 * 1024;
/** A shell reports a program it could not find as 127, and `systemd-run --pipe --wait` passes the unit's
 *  status straight through, so this is the guest's answer to "that command is not installed here". */
const COMMAND_NOT_FOUND = 127;
const GUEST_STDERR_BOUND = 2000;

/** Turn a failed guest command into an error that describes the GUEST.
 *
 *  The launcher is a host `podman` invocation carrying its store flags, the container id and the whole
 *  wrapped argv, and Node puts that entire command line into the message of a non-zero exit. Reporting it
 *  told whoever asked to read a PDF that `/usr/bin/podman --root … exec <64 hex chars> …` had failed,
 *  which names none of their concern, cannot be acted on, and writes the container's identity into a
 *  transcript. What the caller needs is which program failed, in which environment, and why.
 *
 *  `code` is stable and is the contract other plugins match on; the guest's own stderr is sanitised and
 *  bounded, and the host command line never appears in either. */
function guestCommandFailure(file, error, sanitize) {
  const clean = (text) => sanitize(String(text ?? '')).replace(/\s+$/, '').slice(0, GUEST_STDERR_BOUND);
  // Not a completed process: an aborted run, a lease that could not be renewed, a validation refusal.
  // These already carry their own meaning and never hold a host command line.
  if (!error || typeof error !== 'object' || !('code' in error || 'stderr' in error)) {
    if (error instanceof Error) error.message = clean(error.message);
    return error;
  }
  if (error.code === 'ENOENT' || error.code === 'EACCES') {
    // The HOST launcher itself is missing or unusable. That is a transport fault, not a missing guest
    // program, and it must not be reported as one — nor may it disclose where the launcher lives.
    return Object.assign(new Error('The managed execution transport is unavailable'), { code: 'guest_transport_unavailable' });
  }
  const status = Number.isInteger(error.code) ? error.code : null;
  const stderr = clean(error.stderr);
  if (status === COMMAND_NOT_FOUND) {
    return Object.assign(new Error(`${file} is not available in this project environment`),
      { code: 'guest_command_missing', command: file, guestStatus: status });
  }
  if (status !== null) {
    return Object.assign(new Error(`${file} failed in this project environment with status ${status}${stderr ? `: ${stderr}` : ''}`),
      { code: 'guest_command_failed', command: file, guestStatus: status, stderr });
  }
  if (error.killed || error.signal) {
    return Object.assign(new Error(`${file} was terminated in this project environment${error.signal ? ` by ${error.signal}` : ''}`),
      { code: 'guest_command_terminated', command: file, signal: error.signal ?? null });
  }
  return Object.assign(new Error(`${file} could not be run in this project environment`),
    { code: 'guest_command_failed', command: file, guestStatus: null, stderr });
}

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
  /** The FIRST read of a file, which is also its existence check, its type check, its classification probe
   *  and — for anything that fits in one transport chunk — its entire content.
   *
   *  Every one of those used to be a separate `projectFiles` call, and each of those is a container round
   *  trip costing hundreds of milliseconds, so a 67-byte file was paying four of them to answer a question
   *  one could answer. It is not a shortcut past a check: the guest read operation takes the content
   *  version, reads, and re-verifies that version inside a single guest process, which is a stronger
   *  guarantee than a host stat taken on either side of the transport. A missing path and a directory are
   *  reported by that same operation, so they are translated here rather than pre-empted by a stat. */
  const open = async (path) => {
    try {
      const first = await chunk(path, 0, CHUNK_BYTES);
      return { bytes: first.bytes, totalBytes: first.totalBytes, version: first.version, complete: first.bytes.length >= first.totalBytes };
    } catch (error) {
      // The guest's code is carried onto the readable message, because a caller that must distinguish
      // "not there, so create it" from "there but unreadable" cannot be asked to match on prose.
      if (error?.code === 'not_found') throw Object.assign(new Error(`File does not exist: ${path}`), { code: 'not_found' });
      if (error?.code === 'not_regular_file') throw Object.assign(new Error('path is not a regular file'), { code: 'not_regular_file' });
      throw error;
    }
  };
  // `initialVersion` pins the first chunk to a version the caller already established (the read wrapper's
  // opening chunk), so a mutation between that read and the rest of the transport cannot slip past;
  // without it, chunk-to-chunk consistency and the final stat below still bound the whole iteration.
  // `opened` hands back the chunk the caller already paid for instead of fetching offset 0 twice.
  async function* chunks(path, initialVersion, opened = null) {
    let offset = 0;
    let version;
    let total;
    let pending = opened;
    let transfers = 0;
    do {
      const result = pending ?? await chunk(path, offset, CHUNK_BYTES);
      pending = null;
      transfers += 1;
      if (version !== undefined && (version !== result.version || total !== result.totalBytes)) {
        throw new Error('file changed while it was being read; retry the Read');
      }
      if (version === undefined && initialVersion !== undefined && initialVersion !== result.version) {
        throw new Error('file changed while it was being read; retry the Read');
      }
      version = result.version;
      total = result.totalBytes;
      if (result.bytes.length === 0 && offset < total) throw new Error('managed file read ended before EOF');
      offset += result.bytes.length;
      yield result.bytes;
    } while (offset < total);
    // Only a file that took SEVERAL transfers needs the closing stat, because only then is there a gap
    // between reads for a writer to land in. One transfer was already version-checked around itself
    // inside the guest, and a second host round trip cannot make that stronger.
    if (transfers > 1) {
      const final = await stat(path);
      if (!final || final.version !== version) throw new Error('file changed while it was being read; retry the Read');
    }
  }
  const read = async (path, maxBytes, opened = null) => {
    const first = opened ?? await open(path);
    if (first.totalBytes > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte read limit`);
    if (first.complete) return { bytes: first.bytes.subarray(0, first.totalBytes), version: first.version };
    const parts = [];
    let length = 0;
    for await (const bytes of chunks(path, first.version, first)) {
      length += bytes.length;
      if (length > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte read limit`);
      parts.push(bytes);
    }
    return { bytes: Buffer.concat(parts), version: first.version };
  };
  /** Write the file, and build its ancestry only if the guest says that is what is in the way.
   *
   *  Every write used to walk up from the parent statting each directory before it began, which is a
   *  container round trip spent confirming something that is true for essentially every write an agent
   *  makes: the directory it is writing into already exists. The guest now answers `parent_missing` for
   *  exactly that condition and for nothing else, so the tree is built on evidence rather than on
   *  suspicion. `already_exists` on a directory we are creating is a concurrent writer having got there
   *  first, which is success, not conflict. */
  const write = async (path, bytes, expectedVersion) => {
    const attempt = () => operation({ kind: 'write', path, base64: bytes.toString('base64'), expectedVersion });
    try { return await attempt(); }
    catch (error) {
      if (error?.code !== 'parent_missing') throw error;
    }
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
    return await attempt();
  };
  const list = (path, limit, metadata = false) => operation({ kind: 'list', path, limit: Math.min(limit, 1000), ...(metadata ? { metadata: true } : {}) });
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
      failure = guestCommandFailure(file, leaseError ?? error, (text) => prepared.sanitizeOutput(text));
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
  /** ONE guest operation for an entire traversal.
   *
   *  Driving the recursion from the host meant a listing per directory, and every listing is a container
   *  execution: a tree of four directories crossed the boundary five times before a single name had been
   *  matched. The guest now walks it in a single pass under its own entry, time and output bounds, and
   *  says whether it stopped early — so a truncated answer is a fact established by the traversal rather
   *  than the host running out of budget partway through. The answer also reports what the requested path
   *  was, which is where the caller's separate existence stat went.
   *
   *  Nothing here is ever written against: a caller that goes on to mutate a match reads it first and
   *  gets a version then. So no content is read and no hash is computed for anything walked past. */
  const walk = async (root, limit, skip) => {
    const result = await operation({ kind: 'walk', path: root, limit: Math.min(limit, 10001), skip: [...skip] });
    // The traversal reports directories too, because a consumer showing a tree needs to see an empty one.
    // A pattern match is about files, so that is what this hands back.
    const files = result.entries.filter((item) => item.kind === 'file');
    return {
      root: result.root,
      rootKind: result.rootKind,
      entries: result.entries,
      files: files.map((item) => item.path),
      mtimes: new Map(files.map((item) => [item.path, item.mtime])),
      truncated: result.truncated,
    };
  };
  // Resolving the control does no I/O, so a caller that must tell "this managed project has no filesystem
  // behind it" apart from "the filesystem failed to answer" can establish the first before it starts.
  const assertProvider = () => { provider(); };
  return { project, resolve, assertProvider, stat, chunk, chunks, open, read, write, list, exec, walk };
}
