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
 * prompt gets a volatile reminder when the two differ. Selection is the conversation's own binding across
 * every accessible Project first, and only then the project this cwd happens to sit in. Every returned
 * workspace path is re-validated through the canonical Policy, so a stale plugin row or revoked Project can
 * only fall back to the registered path. */
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

  // The conversation's OWN selection comes first, across every accessible project. A chooser offers all of
  // them, so the workspace a switch bound is frequently in a project this cwd says nothing about — and when
  // the cwd sits outside every project, the inference below cannot name one at all. Only when the session
  // has no binding does the cwd-inferred project get to answer.
  let workspace: SandboxWorkspace | null;
  try {
    workspace = runWithContributionUser(input.accountUserId, () => input.sandbox!.activeSessionWorkspace?.({
      sessionId: input.sessionId,
      projectIds,
    }) ?? null);
  } catch { return fallback; }
  // Fail closed on a workspace outside the ceiling the caller just named: the plugin owns that filter, and
  // core does not widen from an answer that disagrees with it.
  if (workspace && !projectIds.includes(workspace.projectId)) return fallback;

  if (!workspace) {
    let roots: ReturnType<KnownControls['sandbox']['workspaceRoots']> = [];
    try {
      roots = runWithContributionUser(input.accountUserId, () => input.sandbox!.workspaceRoots({ projectIds }));
    } catch { return fallback; }

    const projects = input.projects.list().filter((project) => projectIds.includes(project.id));
    const registered = projects.find((project) => realPathWithin(input.baseWorkDir!, [project.path]) !== null);
    const supplemental = roots.find((root) => realPathWithin(input.baseWorkDir!, [root.path]) !== null);
    const projectId = registered?.id ?? supplemental?.projectId ?? (projectIds.length === 1 ? projectIds[0] : undefined);
    if (projectId === undefined) return fallback;

    try {
      workspace = runWithContributionUser(input.accountUserId, () => input.sandbox!.activeWorkspace({
        sessionId: input.sessionId,
        projectId,
      }));
    } catch { return fallback; }
    if (!workspace || workspace.projectId !== projectId) return fallback;
  }
  const allowed = clientDir(input.policy, workspace.path);
  return allowed ? { baseWorkDir: input.baseWorkDir, workDir: allowed, workspace } : fallback;
}

/** Apply an EXPLICIT move of one conversation to a directory, on the Sandbox side.
 *
 * Selection above prefers the conversation's own binding over the cwd, which is right for a switch and
 * wrong for a move: choosing Project B in the picker would leave the next turn running in Project A's
 * workspace while the picker's own label read B. Two explicit user intents, silently disagreeing.
 *
 * So the latest one wins. Moving into a directory releases every binding that does NOT belong to the
 * project that directory sits in, and keeps the one that does — moving into the project a workspace was
 * cut from therefore keeps working in that workspace. The project is inferred exactly as above: a
 * registered project path first, then a workspace root, so a move into a worktree is a move into its own
 * project rather than out of it.
 *
 * Refusals PROPAGATE, and `workspace_in_use` is the one that matters: a process is running in the bound
 * worktree right now, and leaving the conversation trapped in a workspace whose label says otherwise is
 * worse than refusing the move and saying why. The control is optional, so a build without it releases
 * nothing and the move proceeds unchanged. */
export function releaseWorkspacesForMove(input: {
  policy: Policy;
  accountUserId: number | null;
  sessionId: string;
  /** The already validated destination directory. */
  workDir: string;
  projects?: { list(): ProjectView[] };
  sandbox?: KnownControls['sandbox'];
}): { released: number } {
  if (input.accountUserId === null || !input.projects || !input.sandbox?.releaseSessionWorkspaces) return { released: 0 };
  const projectIds = input.policy.allowedProjectIds === 'all'
    ? input.projects.list().map((project) => project.id)
    : [...input.policy.allowedProjectIds];
  if (projectIds.length === 0) return { released: 0 };

  const projects = input.projects.list().filter((project) => projectIds.includes(project.id));
  let keepProjectId = projects.find((project) => realPathWithin(input.workDir, [project.path]) !== null)?.id;
  if (keepProjectId === undefined) {
    let roots: ReturnType<KnownControls['sandbox']['workspaceRoots']> = [];
    try {
      roots = runWithContributionUser(input.accountUserId, () => input.sandbox!.workspaceRoots({ projectIds }));
    } catch { roots = []; /* no workspace roots to infer from — the move simply keeps no project */ }
    keepProjectId = roots.find((root) => realPathWithin(input.workDir, [root.path]) !== null)?.projectId;
  }

  return runWithContributionUser(input.accountUserId, () => input.sandbox!.releaseSessionWorkspaces!({
    sessionId: input.sessionId,
    projectIds,
    ...(keepProjectId === undefined ? {} : { keepProjectId }),
  }));
}
