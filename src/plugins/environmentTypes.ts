import type { ManagedProjectRef } from '../shared/projectExecution.js';
import type { EnvironmentAction, EnvironmentLimits, EnvironmentNetwork, EnvironmentOperation } from '../shared/wireContract.js';

// Declared in the wire contract because the web reads them off the wire, and re-exported here so the
// daemon keeps importing them from the module that owns this domain.
export type { EnvironmentAction, EnvironmentLimits, EnvironmentNetwork, EnvironmentOperation };

export interface ProjectEnvironment {
  projectId: number;
  generation: number;
  state: 'unprovisioned' | 'starting' | 'running' | 'stopped' | 'failed' | 'deleting' | 'deleted';
  desiredState: 'running' | 'stopped' | 'deleted';
  lastError: string | null;
  limits: EnvironmentLimits;
  network: EnvironmentNetwork;
}
export interface EnvironmentSnapshot {
  id: string;
  generation: number;
  createdAt: string;
  consistency: 'crash-consistent';
  completeProject: boolean;
  note: string;
}
export interface GuestFileStat {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
  /** A conflict token, never authorization. Absent on a metadata-only listing, which does not hash
   *  contents; a caller that intends to write must obtain a version from a read or a plain stat. */
  version?: string;
}
export type GuestExportManifestEntry =
  | { path: string; kind: 'file'; mode: number; size: number; version: string }
  | { path: string; kind: 'directory'; mode: number }
  | { path: string; kind: 'symlink'; mode: number; target: string };
/** Decoded bytes per upload chunk; every chunk except the last has exactly this size. */
export const GUEST_FILE_CHUNK_BYTES = 524288;
export type GuestFileOperation =
  | { kind: 'stat'; path: string; followSymlinks?: boolean }
  /** `metadata` asks for names, kinds, sizes and modification times without the content hash a version
   *  costs. Entries answered that way carry NO `version` and so cannot be written against. */
  | { kind: 'list'; path: string; limit: number; cursor?: string; metadata?: boolean }
  | { kind: 'read'; path: string; maxBytes: number; offset?: number; length?: number }
  | { kind: 'write'; path: string; base64: string; expectedVersion: string | null }
  /** Upload handles are bound to the original account, Project, generation, target and version. */
  | { kind: 'write-begin'; path: string; expectedVersion: string | null; size: number }
  | { kind: 'write-chunk'; path: string; uploadId: string; offset: number; base64: string }
  | { kind: 'write-commit' | 'write-abort'; path: string; uploadId: string }
  | { kind: 'remove'; path: string; expectedVersion: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'rename'; path: string; destination: string; expectedVersion: string }
  /** One bounded recursive traversal, performed inside the guest.
   *
   *  `limit` bounds every entry the traversal LOOKS AT, directories and symlinks included, not the subset
   *  it returns — examining an entry costs the same whatever it turns out to be. `maxDepth` counts levels
   *  of descent below the root, so 0 lists the root's own children and goes no deeper. `skip` names
   *  directories not to descend into. Nothing returned is written against, so no content is read and no
   *  version is computed. */
  | { kind: 'walk'; path: string; limit: number; skip?: string[]; maxDepth?: number }
  /** A bounded immutable-publication inventory. It hashes regular files and records permission bits and
   *  safe relative symlinks so a consumer can copy a Project tree without resolving a host path. */
  | { kind: 'export-manifest'; path: string }
  | { kind: 'search'; path: string; pattern: string; glob?: string; caseSensitive?: boolean; limit: number };
export type GuestFileResult =
  | { kind: 'stat'; entry: GuestFileStat | null }
  | { kind: 'list'; entries: GuestFileStat[]; truncated: boolean; nextCursor: string | null }
  | { kind: 'read'; base64: string; version: string; totalBytes: number }
  | { kind: 'write' | 'mkdir' | 'rename' | 'write-commit'; entry: GuestFileStat }
  | { kind: 'write-begin'; uploadId: string; chunkSize: number; received: number; resolvedPath: string }
  | { kind: 'write-chunk'; received: number }
  | { kind: 'write-abort'; aborted: true }
  | { kind: 'remove'; removed: boolean }
  /** `rootKind` describes the path that was ASKED for — null when it is not there at all, which saves the
   *  caller a stat of its own. `root` is the directory actually traversed, which is the requested path
   *  when it is a directory and its parent otherwise.
   *
   *  Entries are files, directories and symlinks, in a stable sorted order, so a truncated answer is a
   *  prefix rather than an arbitrary subset. An empty directory appears as an entry of its own. A symlink
   *  is REPORTED but never followed and never descended into, and its `size` and `mtime` are the link's
   *  own, never its target's — a consumer that needs the target resolves it deliberately, one path at a
   *  time, and a broken link still describes itself. `truncated` is the single honest signal that the
   *  traversal stopped early, whichever bound it hit; a directory that could not be read at all fails the
   *  operation instead. */
  | { kind: 'walk'; root: string; rootKind: 'file' | 'directory' | 'symlink' | 'other' | null;
      entries: { path: string; kind: 'file' | 'directory' | 'symlink'; size: number; mtime: number }[]; truncated: boolean }
  | { kind: 'export-manifest'; root: string; mode: number; entries: GuestExportManifestEntry[] }
  | { kind: 'search'; matches: { path: string; line: number; text: string }[]; truncated: boolean };
export interface ManagedWorktree { id: string; projectId: number; createdBy: number; path: string; branch: string; baseRef: string; label: string }
export type ManagedWorktreeAction = { kind: 'list' } | { kind: 'create'; label: string; baseRef: string } | { kind: 'remove'; workspaceId: string };

export interface ProjectPreviewBinding {
  projectId: number;
  generation: number;
  port: number;
  /** Trusted gateway transport only. This is not a public URL and never bypasses account authorization. */
  socketPath: string;
  release(): Promise<void>;
}

/** A published transport, as opposed to {@link ProjectPreviewBinding}: it is durable and account
 *  independent, so it has no `release()` — `projectPublicationRelease` is the one thing that ends it. */
export interface ProjectPublicationBinding {
  generation: number;
  /** Trusted gateway transport only. This is not a public URL and never bypasses account authorization. */
  socketPath: string;
}

export const ENVIRONMENT_CONTROL_METHODS = [
  'environmentFor', 'requestEnvironment', 'environmentOperation', 'projectFiles', 'revokeProjectAccess',
  'environmentSnapshots', 'environmentLogs', 'managedWorktrees', 'projectPreviewBinding',
  'projectPublicationBinding', 'projectPublicationRelease', 'releaseAdoptedWorkspace',
] as const;
export interface ProjectEnvironmentControl {
  environmentFor(input: { project: ManagedProjectRef; accountUserId: number }): Promise<ProjectEnvironment>;
  /** Reuse requestId when retrying the same intent after a lost response. */
  requestEnvironment(input: { project: ManagedProjectRef; accountUserId: number; action: EnvironmentAction; expectedGeneration?: number; requestId?: string }): Promise<EnvironmentOperation>;
  environmentOperation(input: { operationId: string; accountUserId: number }): Promise<EnvironmentOperation | null>;
  projectFiles(input: { project: ManagedProjectRef; accountUserId: number; operation: GuestFileOperation; expectedGeneration?: number }): Promise<GuestFileResult>;
  revokeProjectAccess(input: { projectId: number; accountUserId: number }): Promise<void>;
  environmentSnapshots(input: { project: ManagedProjectRef; accountUserId: number }): Promise<EnvironmentSnapshot[]>;
  environmentLogs(input: { project: ManagedProjectRef; accountUserId: number; lines?: number }): Promise<{ lifecycle: string; journal: string }>;
  managedWorktrees(input: { project: ManagedProjectRef; accountUserId: number; action: ManagedWorktreeAction }): Promise<ManagedWorktree[]>;
  projectPreviewBinding(input: { project: ManagedProjectRef; accountUserId: number; port: number }): Promise<ProjectPreviewBinding>;
  /** Durable by design: the binding survives the caller, the account and a container restart, and is
   *  re-established by the runtime's own reconciliation rather than by anything holding a lease. */
  projectPublicationBinding(input: { project: ManagedProjectRef; accountUserId?: number; publicationId: string; port: number }): Promise<ProjectPublicationBinding>;
  projectPublicationRelease(input: { project: ManagedProjectRef; publicationId: string }): Promise<void>;
  releaseAdoptedWorkspace(input: { project: ManagedProjectRef; accountUserId: number }): Promise<void>;
}
