import { posix } from 'node:path';
import type { GuestFileOperation, GuestFileResult, GuestFileStat } from '../../src/plugins/environmentTypes.js';

/** An in-memory stand-in for the Sandbox `projectFiles` guest transport, faithful to the parts the chat
 *  upload depends on: `write-begin` is CREATE-ONLY and refuses an existing target with `already_exists`,
 *  chunks must arrive at the offset the handle expects, and only a commit publishes a file. The chunk
 *  size is deliberately tiny so an ordinary test payload crosses several boundaries. */
export interface FakeGuestFiles {
  control: { projectFiles(input: { project: { kind: 'managed'; projectId: number }; accountUserId: number; operation: GuestFileOperation }): Promise<GuestFileResult> };
  /** Committed files only — an aborted or unfinished upload must never appear here. */
  files: Map<string, string>;
  /** Every operation the route asked for, in order, with the identity it was asked under. */
  calls: { kind: string; accountUserId: number; projectId: number; path: string }[];
  /** Upload handles still open. A clean failure path leaves none behind. */
  openUploads(): number;
}

export function fakeGuestFiles(opts: { members?: number[]; chunkSize?: number; failChunkAt?: number } = {}): FakeGuestFiles {
  const members = new Set(opts.members ?? [1]);
  const chunkSize = opts.chunkSize ?? 8;
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);
  const handles = new Map<string, { path: string; received: number; buffer: string }>();
  const calls: FakeGuestFiles['calls'] = [];
  let nextHandle = 1;

  const stat = (path: string): GuestFileStat | null => {
    if (dirs.has(path)) return { path, kind: 'directory', size: 0, modifiedAt: '2026-09-15T00:00:00Z', version: 'd' };
    const content = files.get(path);
    if (content === undefined) return null;
    return { path, kind: 'file', size: Buffer.byteLength(content), modifiedAt: '2026-09-15T00:00:00Z', version: `v${content.length}` };
  };

  const fail = (message: string, code?: string): never => {
    const error = new Error(message) as Error & { code?: string };
    if (code) error.code = code;
    throw error;
  };

  return {
    files,
    calls,
    openUploads: () => handles.size,
    control: {
      async projectFiles({ project, accountUserId, operation }) {
        const path = 'path' in operation ? operation.path : '';
        calls.push({ kind: operation.kind, accountUserId, projectId: project.projectId, path });
        // The real control authorizes the account against the project on EVERY operation, not once at the
        // start of a session; the fake keeps that property so a test can prove the route relies on it.
        if (!members.has(accountUserId)) fail('account is not a member of this project', 'forbidden');

        switch (operation.kind) {
          case 'stat':
            return { kind: 'stat', entry: stat(operation.path) };
          case 'mkdir':
            if (dirs.has(operation.path) || files.has(operation.path)) fail('exists', 'already_exists');
            dirs.add(operation.path);
            return { kind: 'mkdir', entry: stat(operation.path)! };
          case 'write-begin': {
            if (files.has(operation.path)) fail('exists', 'already_exists');
            if (!dirs.has(posix.dirname(operation.path))) fail('no such directory');
            const uploadId = `u${nextHandle++}`;
            handles.set(uploadId, { path: operation.path, received: 0, buffer: '' });
            return { kind: 'write-begin', uploadId, chunkSize, received: 0, resolvedPath: operation.path };
          }
          case 'write-chunk': {
            const handle = handles.get(operation.uploadId) ?? fail('unknown upload handle');
            if (operation.offset !== handle.received) fail('chunk offset does not follow the handle');
            const bytes = Buffer.from(operation.base64, 'base64');
            if (bytes.length > chunkSize) fail('chunk over the transport limit');
            if (opts.failChunkAt !== undefined && handle.received >= opts.failChunkAt) fail('guest disk went away');
            handle.buffer += bytes.toString('utf8');
            handle.received += bytes.length;
            return { kind: 'write-chunk', received: handle.received };
          }
          case 'write-commit': {
            const handle = handles.get(operation.uploadId) ?? fail('unknown upload handle');
            handles.delete(operation.uploadId);
            files.set(handle.path, handle.buffer);
            return { kind: 'write-commit', entry: stat(handle.path)! };
          }
          case 'write-abort':
            handles.delete(operation.uploadId);
            return { kind: 'write-abort', aborted: true };
          default:
            return fail(`unsupported operation ${operation.kind}`);
        }
      },
    },
  };
}

/** The `d.plugins` provider shape, serving one live `sandbox` control (or none, for the 503 path). */
export function fakePluginsProvider(sandbox: unknown | undefined) {
  return { get: async () => ({ control: (name: string) => (name === 'sandbox' ? sandbox : undefined) }) };
}
