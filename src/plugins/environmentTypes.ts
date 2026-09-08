import type { ManagedProjectRef } from '../shared/projectExecution.js';

export type EnvironmentAction =
  | { kind: 'start' | 'stop' | 'restart' | 'delete' }
  | { kind: 'snapshot'; note?: string }
  | { kind: 'restore'; snapshotId: string };

export interface ProjectEnvironment {
  projectId: number;
  generation: number;
  state: 'unprovisioned' | 'starting' | 'running' | 'stopped' | 'failed' | 'deleting';
  desiredState: 'running' | 'stopped' | 'deleted';
  lastError: string | null;
  limits: { cpus: number; memoryMb: number; pidsLimit: number; diskSoftMb: number };
}

export interface EnvironmentOperation {
  id: string;
  projectId: number;
  accountUserId: number;
  generation: number;
  action: EnvironmentAction;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  error: string | null;
  snapshotId?: string;
}

export interface GuestFileStat {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
  /** Content version used for read-before-write/conflict checking, not authorization. */
  version: string;
}

export type GuestFileOperation =
  | { kind: 'stat'; path: string }
  | { kind: 'list'; path: string; limit: number }
  | { kind: 'read'; path: string; maxBytes: number; offset?: number; length?: number }
  | { kind: 'write'; path: string; base64: string; expectedVersion: string | null }
  | { kind: 'remove'; path: string; expectedVersion: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'rename'; path: string; destination: string; expectedVersion: string }
  | { kind: 'search'; path: string; pattern: string; glob?: string; caseSensitive?: boolean; limit: number };

export type GuestFileResult =
  | { kind: 'stat'; entry: GuestFileStat | null }
  | { kind: 'list'; entries: GuestFileStat[]; truncated: boolean }
  | { kind: 'read'; base64: string; version: string; totalBytes: number }
  | { kind: 'write' | 'mkdir' | 'rename'; entry: GuestFileStat }
  | { kind: 'remove'; removed: boolean }
  | { kind: 'search'; matches: { path: string; line: number; text: string }[]; truncated: boolean };

/** Actor is explicit for non-turn callers; implementations validate it against current core membership.
 * No host path, arbitrary executable or mount specification crosses this public control. */
export const ENVIRONMENT_CONTROL_METHODS = ['environmentFor', 'requestEnvironment', 'environmentOperation', 'projectFiles', 'revokeProjectAccess'] as const;

export interface ProjectEnvironmentControl {
  environmentFor(input: { project: ManagedProjectRef; accountUserId: number }): Promise<ProjectEnvironment>;
  requestEnvironment(input: { project: ManagedProjectRef; accountUserId: number; action: EnvironmentAction; expectedGeneration?: number }): Promise<EnvironmentOperation>;
  environmentOperation(input: { operationId: string; accountUserId: number }): Promise<EnvironmentOperation | null>;
  projectFiles(input: { project: ManagedProjectRef; accountUserId: number; operation: GuestFileOperation; expectedGeneration?: number }): Promise<GuestFileResult>;
  revokeProjectAccess(input: { projectId: number; accountUserId: number }): Promise<void>;
}
