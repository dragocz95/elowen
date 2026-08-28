import { isAbsolute, join, relative, sep } from 'node:path';
import type { SandboxWorkspaceBinding, SandboxWorkspaceRef } from './workspaceTypes.js';
import { realPathWithin } from './pathUtils.js';

export interface WorkspacePathView {
  kind: 'workspace';
  workspace: SandboxWorkspaceRef;
  root: string;
  /** Resolve a model-facing relative path to a canonical host path. */
  resolve(path: string): string;
  /** Render a canonical host path without exposing the workspace's host prefix. */
  display(path: string): string;
  /** Stable read-before-edit key that cannot collide across worktrees. */
  stateKey(path: string): string;
  /** Remove host-only workspace prefixes from arbitrary diagnostics/tool output. */
  sanitize(text: string): string;
}

function logicalRelative(root: string, path: string): string {
  const rel = relative(root, path);
  if (!rel) return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('path is outside the assigned workspace');
  }
  return rel.split(sep).join('/');
}

export function createWorkspacePathView(binding: SandboxWorkspaceBinding, hiddenPrefixes: readonly string[] = []): WorkspacePathView {
  const root = binding.path;
  const redactions = [...new Set(hiddenPrefixes.filter((prefix) => prefix && prefix !== root))]
    .sort((a, b) => b.length - a.length);
  const workspace = { workspaceId: binding.workspaceId, projectId: binding.projectId };
  const resolveLogical = (raw: string): string => {
    const value = String(raw ?? '');
    if (value.length === 0) throw new Error('a workspace-relative path is required');
    if (isAbsolute(value)) throw new Error(`absolute paths are unavailable in this workspace; use a relative path such as "src/file.ts"`);
    if (value.split(/[\\/]+/).includes('.git')) {
      throw new Error('Git metadata paths are unavailable in this workspace; use GitStatus for repository state');
    }
    const resolved = realPathWithin(join(root, value), [root]);
    if (!resolved) throw new Error(`path not allowed: "${value}" is outside the assigned workspace`);
    return resolved;
  };
  const display = (path: string): string => logicalRelative(root, path);
  return {
    kind: 'workspace',
    workspace,
    root,
    resolve: resolveLogical,
    display,
    stateKey: (path) => `${workspace.workspaceId}\0${display(path)}`,
    sanitize: (text) => redactions.reduce(
      (value, prefix) => value.split(prefix).join('[host-path]'),
      String(text).split(root).join('.'),
    ),
  };
}
