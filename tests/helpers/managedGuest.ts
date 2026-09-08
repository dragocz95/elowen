import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { GuestFileOperation, GuestFileResult, GuestFileStat, ManagedProjectRef, SandboxControl } from '../../src/plugins/api.js';

/** An in-memory GUEST filesystem standing in for the Sandbox `projectFiles` provider, enforcing the same
 *  operation contract the runtime enforces in plugins/sandbox/lib/guestFiles.py so the consumers under
 *  test are exercised against the real bounds, not a shapeless stub:
 *  - absolute normalized guest paths only;
 *  - a read carries at most 512 KiB (`maxBytes`/`length`), honouring offset and length;
 *  - a write carries at most 512 KiB and is CAS-gated on `expectedVersion` (null = must not exist);
 *  - a write into a missing parent fails (the helper has no recursive mkdir);
 *  - versions are the SHA-256 of the content, so a mid-read change IS observable. */
export const PROJECT: ManagedProjectRef = { kind: 'managed', projectId: 7 };

const GUEST_CHUNK_LIMIT = 512 * 1024;

export interface ManagedGuestOptions {
  /** Fail every operation with this error (simulates an unavailable/partially loaded provider). */
  fail?: Error;
  /** Reject any call from a DIFFERENT account than this one, like the provider's membership check. */
  account?: number;
  /** After the Nth operation, throw once (version_conflict-shaped), then continue. */
  raceOn?: number;
  /** Refuse every write/mkdir like the runtime's read_only gate (a read-only turn). */
  readOnly?: boolean;
  /** Report this totalBytes on reads instead of the true size (a malformed provider). */
  malformedTotal?: number;
  /** After the Nth operation, append these bytes to the named file (the file grows mid-read). */
  growOn?: { call: number; path: string; append: Buffer };
}

export function managedGuestFs(initial: Record<string, Buffer | string> = {}, options: ManagedGuestOptions = {}) {
  const data = new Map<string, Buffer>();
  for (const [path, bytes] of Object.entries(initial)) data.set(path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const directories = new Set<string>(['/workspace']);
  const version = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const statOf = (path: string): GuestFileStat | null => {
    const bytes = data.get(path);
    if (bytes) return { path, kind: 'file', size: bytes.length, modifiedAt: '2026-01-01T00:00:00Z', version: version(bytes) };
    if (directories.has(path) || [...data.keys()].some((name) => name.startsWith(`${path}/`))) {
      return { path, kind: 'directory', size: 0, modifiedAt: '2026-01-01T00:00:00Z', version: version(Buffer.from(`dir:${path}`)) };
    }
    return null;
  };
  let calls = 0;
  const projectFiles = async (input: { accountUserId?: number; operation: GuestFileOperation }): Promise<GuestFileResult> => {
    if (options.fail) throw options.fail;
    if (input.accountUserId !== (options.account ?? 1)) throw Object.assign(new Error('project_forbidden: Project access is required'), { code: 'project_forbidden' });
    const op: GuestFileOperation = input.operation;
    if (!op.path || typeof op.path !== 'string' || !posix.isAbsolute(op.path)) throw new Error('invalid_path: An absolute guest path is required');
    const path = posix.resolve(op.path);
    calls += 1;
    if (options.growOn && calls === options.growOn.call) {
      data.set(options.growOn.path, Buffer.concat([data.get(options.growOn.path) ?? Buffer.alloc(0), options.growOn.append]));
    }
    if (options.raceOn !== undefined && calls === options.raceOn) throw new Error('version_conflict: Content version no longer matches');
    if (op.kind === 'stat') return { kind: 'stat', entry: statOf(path) };
    if (op.kind === 'read') {
      const bytes = data.get(path);
      if (!bytes) throw new Error('not_found: No such guest file');
      const maxBytes = typeof op.maxBytes === 'number' ? op.maxBytes : NaN;
      if (!(maxBytes >= 1 && maxBytes <= GUEST_CHUNK_LIMIT)) throw new Error('invalid_limit: Invalid guest operation bound');
      const length = typeof op.length === 'number' ? op.length : maxBytes;
      if (!(length >= 0 && length <= maxBytes)) throw new Error('invalid_limit: Invalid guest operation bound');
      const offset = typeof op.offset === 'number' ? op.offset : 0;
      if (!(offset >= 0 && offset <= 268435456)) throw new Error('invalid_limit: Invalid guest operation bound');
      const part = bytes.subarray(offset, offset + length);
      const total = options.malformedTotal ?? bytes.length;
      return { kind: 'read', base64: part.toString('base64'), totalBytes: total, version: version(bytes) };
    }
    if (op.kind === 'write') {
      if (options.readOnly) throw new Error('read_only: A read-only turn cannot modify an environment');
      const raw = typeof op.base64 === 'string' ? op.base64 : '';
      const bytes = Buffer.from(raw, 'base64');
      if (raw.length > Math.ceil(GUEST_CHUNK_LIMIT * 4 / 3) + 4 || bytes.length > GUEST_CHUNK_LIMIT) {
        throw new Error('file_too_large: Write exceeds the guest transport limit');
      }
      const current = statOf(path);
      if (op.expectedVersion === null ? current !== null : (current === null || current.version !== op.expectedVersion)) {
        throw new Error('version_conflict: Content version no longer matches');
      }
      data.set(path, bytes);
      return { kind: 'write', entry: statOf(path)! };
    }
    if (op.kind === 'mkdir') {
      if (options.readOnly) throw new Error('read_only: A read-only turn cannot modify an environment');
      if (statOf(path)) throw new Error('already_exists: Destination already exists');
      const parent = posix.dirname(path);
      if (!directories.has(parent) && !data.has(parent)) throw new Error('not_found: No such guest directory');
      directories.add(path);
      return { kind: 'mkdir', entry: statOf(path)! };
    }
    throw new Error(`unexpected ${op.kind}`);
  };
  const sandbox = { projectFiles } as unknown as SandboxControl;
  return {
    sandbox,
    projectFiles: projectFiles as unknown as SandboxControl['projectFiles'],
    /** The bytes as the guest holds them now. */
    file: (path: string) => data.get(path) ?? null,
    exists: (path: string) => statOf(path) !== null,
    calls: () => calls,
  };
}
