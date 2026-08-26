import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { KnownControls, SandboxWorkspace } from '../../plugins/api.js';
import type { Policy } from '../../plugins/policy.js';
import { realPathWithin } from '../../plugins/pathGuard.js';
import { runWithContributionUser } from '../../plugins/policyContext.js';

/** The client-reported directory, validated: a real directory the caller may access (all-access:
 *  anywhere; scoped: inside an allowed repo root), realpath-resolved. Undefined otherwise. */
export function clientDir(policy: Policy, clientCwd?: string): string | undefined {
  if (!clientCwd) return undefined;
  try {
    const real = realpathSync(clientCwd);
    if (!statSync(real).isDirectory()) return undefined;
    if (policy.allowedProjectIds === 'all') return real;
    return realPathWithin(real, policy.allowedPaths()) ?? undefined;
  } catch { return undefined; /* vanished or unreadable directory — the caller falls back */ }
}

/** The canonical root of the Git worktree containing a validated client directory. This is solely a
 * preference scope — conversation addressing continues to use the exact validated cwd. Scoped users
 * may only use a root that itself belongs to one of their allowed project paths. */
export function gitProjectRoot(policy: Policy, clientCwd?: string): string | undefined {
  const dir = clientDir(policy, clientCwd);
  if (!dir) return undefined;
  let current = dir;
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return policy.allowedProjectIds === 'all' || realPathWithin(current, policy.allowedPaths())
        ? current
        : undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The default tool cwd for one owner-chat turn: the client-reported directory when it is a real
 *  directory the caller may access (all-access: anywhere; scoped: inside an allowed repo root), else
 *  their first allowed root, else the daemon's primary project. Never the daemon process cwd —
 *  systemd runs that at `/`. Returns undefined only when no fallback exists (tools then keep their
 *  own `defaultCwd()` chain). */
export function turnWorkDir(policy: Policy, clientCwd: string | undefined, projectPath?: () => string | undefined): string | undefined {
  return clientDir(policy, clientCwd) ?? policy.allowedPaths()[0] ?? projectPath?.();
}

interface ProjectView { id: number; path: string }

export interface EffectiveTurnWorkDir {
  /** Registered Project/default directory before Sandbox selection. */
  baseWorkDir?: string;
  /** Directory installed into the turn scope and inherited by delegation. */
  workDir?: string;
  workspace: SandboxWorkspace | null;
}

/** Resolve one turn's active Sandbox workspace without mutating the live PI session. The static session cwd
 * remains the cache-friendly spawn value; tools and delegation read this per-turn result from ALS, while the
 * prompt gets a volatile reminder when the two differ. Every returned workspace path is re-validated through
 * the canonical Policy, so a stale plugin row or revoked Project can only fall back to the registered path. */
export function effectiveTurnWorkDir(input: {
  policy: Policy;
  baseWorkDir?: string;
  accountUserId: number | null;
  sessionId: string;
  projects?: { list(): ProjectView[] };
  sandbox?: KnownControls['sandbox'];
}): EffectiveTurnWorkDir {
  const fallback: EffectiveTurnWorkDir = { baseWorkDir: input.baseWorkDir, workDir: input.baseWorkDir, workspace: null };
  if (!input.baseWorkDir || input.accountUserId === null || !input.projects || !input.sandbox) return fallback;

  const projectIds = input.policy.allowedProjectIds === 'all'
    ? input.projects.list().map((project) => project.id)
    : [...input.policy.allowedProjectIds];
  if (projectIds.length === 0) return fallback;

  let roots: ReturnType<KnownControls['sandbox']['workspaceRoots']> = [];
  try {
    roots = runWithContributionUser(input.accountUserId, () => input.sandbox!.workspaceRoots({ projectIds }));
  } catch { return fallback; }

  const projects = input.projects.list().filter((project) => projectIds.includes(project.id));
  const registered = projects.find((project) => realPathWithin(input.baseWorkDir!, [project.path]) !== null);
  const supplemental = roots.find((root) => realPathWithin(input.baseWorkDir!, [root.path]) !== null);
  const projectId = registered?.id ?? supplemental?.projectId ?? (projectIds.length === 1 ? projectIds[0] : undefined);
  if (projectId === undefined) return fallback;

  let workspace: SandboxWorkspace | null;
  try {
    workspace = runWithContributionUser(input.accountUserId, () => input.sandbox!.activeWorkspace({
      sessionId: input.sessionId,
      projectId,
    }));
  } catch { return fallback; }
  if (!workspace || workspace.projectId !== projectId) return fallback;
  const allowed = clientDir(input.policy, workspace.path);
  return allowed ? { baseWorkDir: input.baseWorkDir, workDir: allowed, workspace } : fallback;
}
