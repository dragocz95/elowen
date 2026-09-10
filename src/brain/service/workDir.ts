import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { managedGuestRoot, projectExecutionRefSchema, type ProjectExecutionRef } from '../../shared/projectExecution.js';
import type { KnownControls, SandboxWorkspace } from '../../plugins/api.js';
import type { Policy } from '../../plugins/policy.js';
import { realPathWithin } from '../../plugins/pathGuard.js';
import { runWithContributionUser } from '../../plugins/policyContext.js';
import type { BrainStore } from '../../store/brainStore.js';
import type { Project } from '../../store/projectStore.js';
import type { LiveBrain } from '../session/liveBrain.js';
import { recordSessionEvent } from './sessionEvents.js';

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

interface ProjectView { id: number; path: string; slug?: string; executionKind?: 'host' | 'managed'; lifecycle?: 'active' | 'deleting' }

/** The managed project a stored ref resolves to, or undefined when it resolves to none: the project was
 *  deleted, is being deleted, or was never managed. Status, the spawn and the per-turn scope all decide
 *  "does this ref still name a live managed project" HERE, so they cannot answer it differently and
 *  report one directory while the turn runs in another. */
export function liveManagedProject(
  projects: { list(): ProjectView[] } | undefined,
  ref: ProjectExecutionRef | undefined,
): ProjectView | undefined {
  if (ref?.kind !== 'managed') return undefined;
  const project = projects?.list().find((candidate) => candidate.id === ref.projectId);
  return project?.executionKind === 'managed' && project.lifecycle === 'active' ? project : undefined;
}

export interface EffectiveTurnWorkDir {
  /** Registered Project/default directory before Sandbox selection. */
  baseWorkDir?: string;
  /** Directory installed into the turn scope and inherited by delegation. */
  workDir?: string;
  workspace: SandboxWorkspace | null;
  projectRef?: ProjectExecutionRef;
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
  projectRef?: ProjectExecutionRef;
  hostAuthorized?: boolean;
}): EffectiveTurnWorkDir {
  if (input.projectRef) {
    const ref = projectExecutionRefSchema.parse(input.projectRef);
    const project = ref.projectId === undefined ? undefined : input.projects?.list().find((p) => p.id === ref.projectId);
    // A managed ref whose project no longer resolves is not a state to fail closed on. The project was
    // deleted (or was never managed) while the conversation kept pointing at it, and refusing here shut
    // BOTH doors: host paths refused because the ref reads managed, the guest refused because the
    // environment is gone. The host is where such a conversation actually lives, so it resolves there.
    const managed = liveManagedProject(input.projects, ref);
    if (ref.kind === 'managed' && managed) {
      // `control('sandbox')` is either absent or complete — the registry refuses to resolve a control
      // missing any method its key promises — so presence is the whole check.
      if (!input.sandbox) throw new Error('project environment provider unavailable');
      if (input.accountUserId === null || !input.policy.canAccessProject?.(ref.projectId)) throw new Error('managed project access denied');
      // The project is mounted inside its own container under its own name, so this is both the guest
      // root and the only directory the turn ever sees.
      const root = managedGuestRoot(managed.slug, ref.projectId);
      return { baseWorkDir: root, workDir: root, workspace: null, projectRef: ref };
    }
    if (ref.kind !== 'managed') {
      // A host project the caller is assigned to is theirs to work in: `allowedPaths()` already carries
      // its root, so the file tools confine them exactly as they always did. Only the NAMELESS host
      // target — the machine itself, no project behind it — stays an administrator decision.
      const named = ref.projectId !== undefined && !!project && project.executionKind !== 'managed' && project.lifecycle !== 'deleting'
        && (input.policy.allowedProjectIds === 'all' || input.policy.canAccessProject?.(ref.projectId) === true);
      if (ref.projectId !== undefined && !named) throw new Error('host project unavailable');
      if (!named && (!input.hostAuthorized || !input.policy.canExecuteHost?.())) throw new Error('explicit host execution requires administrator permission');
      return { baseWorkDir: project?.path ?? input.baseWorkDir, workDir: project?.path ?? input.baseWorkDir, workspace: null, projectRef: ref };
    }
  }
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
  // The workspace wins only when its path is where the turn will actually run: `workDir` is that path,
  // re-validated, and nothing else. Consumers may rely on `workspace !== null` implying that `workDir`
  // lies inside `workspace.path` — the "confined" indicator is exactly that implication, made explicit.
  const allowed = clientDir(input.policy, workspace.path);
  if (!allowed || realPathWithin(allowed, [workspace.path]) === null) return fallback;
  return { baseWorkDir: input.baseWorkDir, workDir: allowed, workspace };
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

/** A Project a conversation may be moved into, as the /project picker offers it. */
export interface SwitchableProject { id: number; slug: string; path: string }

/** Resolve ONE registered Project as a move destination — the /project switch's project resolver.
 *
 *  The caller must be ASSIGNED to the project: path containment alone is not the gate, because a project
 *  registered inside another allowed project's root (or inside a supplemental Sandbox root) clears that
 *  check by accident. Assignment first, then the same `clientDir` gate a client-reported cwd clears —
 *  the registered path must still be a real directory the caller's policy reaches TODAY, so a switch can
 *  never name a directory the caller's turns could not run in. The validated realpath is the move target
 *  — never the raw registered string, which may be a symlink. Undefined when the project is unknown,
 *  unassigned, its path has vanished, or the caller does not reach it. */
export function projectMoveTarget(
  policy: Policy,
  projects: { list(): Project[] } | undefined,
  projectId: number,
): { workDir: string; slug: string } | undefined {
  if (!projects) return undefined;
  const project = projects.list().find((candidate) => candidate.id === projectId);
  if (!project) return undefined;
  if (policy.allowedProjectIds !== 'all' && !policy.allowedProjectIds.has(project.id)) return undefined;
  const workDir = clientDir(policy, project.path);
  return workDir ? { workDir, slug: project.slug } : undefined;
}

/** The Projects one account may move a conversation into — the picker's data side of the same gate.
 *  A project whose path has vanished, or one the caller is not assigned to or whose path their policy
 *  does not reach, is simply not offered. */
export function switchableProjects(policy: Policy, projects?: { list(): Project[] }): SwitchableProject[] {
  if (!projects) return [];
  return projects.list()
    .filter((project) => policy.allowedProjectIds === 'all' || policy.allowedProjectIds.has(project.id))
    .map((project) => ({ project, validated: clientDir(policy, project.path) }))
    .filter((entry): entry is { project: Project; validated: string } => entry.validated !== undefined)
    .map(({ project }) => ({ id: project.id, slug: project.slug, path: project.path }));
}

export interface MoveSessionWorkDirInput {
  store: Pick<BrainStore, 'getSession' | 'setWorkDir' | 'lastMessageAt' | 'appendSessionEvent'>;
  policy: Policy;
  /** The account whose Sandbox bindings the move may release. Owner chat's /cd passes the contribution
   *  owner; the channel project switch passes the calling room writer — whoever the caller is, only
   *  THEIR OWN bindings are ever released, never another account's. */
  accountUserId: number | null;
  sessionId: string;
  /** The live record when the conversation is running; absent (cold) → only the durable home moves. */
  live?: LiveBrain;
  /** The requested directory, client-reported or a registered project path — validated here. */
  workDir: string;
  /** What the cwd marker and its one-shot notice say instead of the validated path. Absent (owner
   *  chat's /cd) keeps the absolute path, which only the owner's own turns drain. The channel project
   *  switch passes the project slug: the notice is handed to the next turn WHATEVER writer sends in
   *  the room, so a shared channel must not be given the absolute path of a project only the switching
   *  account is assigned to. Label only — the persisted home and the live cwd keep the real path. */
  noticeDetail?: string;
  projects?: { list(): ProjectView[] };
  sandbox?: KnownControls['sandbox'];
}

export interface MoveSessionWorkDirResult {
  /** The validated, realpath-resolved directory. */
  workDir: string;
  /** Whether anything actually moved: a repeat reports false and stays silent. */
  moved: boolean;
  released: number;
}

/** Apply ONE explicit move of a conversation to a directory — the single implementation every surface
 *  shares (owner chat's /cd, the channel project switch). In order:
 *
 *  1. VALIDATE the destination through the caller's policy (`clientDir` — an unreachable directory is
 *     the caller's mistake and the agent must not be told the work moved somewhere it cannot go);
 *  2. RELEASE the Sandbox bindings that do not belong to the destination's project, through the
 *     plugin's own operation (`releaseWorkspacesForMove`, which owns the rule and the inference) —
 *     BEFORE anything moves, so a `workspace_in_use` refusal leaves the conversation exactly where it
 *     was, instead of reporting a move whose next turn would run somewhere else;
 *  3. PERSIST the durable home — `brain_sessions.work_dir` — which is what a cold respawn (daemon
 *     restart, plugin reload, last client detach) restores; a move that only updated the live record
 *     silently reverted on the next boot;
 *  4. MOVE the live record and queue the one-shot cwd notice, only when the live cwd actually changed
 *     — assigning it is what makes the reminder comparison mean "has it moved since we last said so".
 *
 *  A repeat of the current directory re-runs the release (the latest explicit statement still wins)
 *  but moves nothing and says nothing. */
export function moveSessionWorkDir(input: MoveSessionWorkDirInput): MoveSessionWorkDirResult {
  const resolved = clientDir(input.policy, input.workDir);
  if (!resolved) throw new Error('directory is not readable or not allowed');
  const released = releaseWorkspacesForMove({
    policy: input.policy,
    accountUserId: input.accountUserId,
    sessionId: input.sessionId,
    workDir: resolved,
    ...(input.projects ? { projects: input.projects } : {}),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
  }).released;
  const persisted = (input.store.getSession(input.sessionId)?.work_dir ?? '') !== resolved;
  if (persisted) input.store.setWorkDir(input.sessionId, resolved);
  const liveMoved = !!input.live && input.live.workDir !== resolved;
  // The visible marker lands whenever the conversation actually moved — with the live record when it
  // moved live (the marker rides the stream and the notice), and marker-only for a cold move, exactly
  // like a rename from the picker. A silent heal (row stale, live already there) says nothing.
  if (liveMoved || (!input.live && persisted)) {
    recordSessionEvent(input.store, input.sessionId, input.live, 'cwd', input.noticeDetail ?? resolved);
  }
  if (liveMoved) input.live!.workDir = resolved;
  return { workDir: resolved, moved: persisted || liveMoved, released };
}
