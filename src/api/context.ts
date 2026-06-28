import { classifySession } from '../overseer/sessionInfo.js';
import { usagePath } from '../integrations/usage/usagePath.js';
import { logger } from '../shared/logger.js';
import { createPlanService } from './services/planService.js';
import { createReviewService, type ReviewService } from './services/reviewService.js';
import { KeyedMutex } from '../shared/keyedMutex.js';
import { PlanJobStore, type PlanJob } from '../overseer/planJob.js';
import { DecisionQueue } from '../overseer/decisionQueue.js';
import { createTicketStore, type TicketStore } from '../terminal/ticketStore.js';
import type { Phase } from '../overseer/planner.js';
import type { EventProjectDeps } from './eventProject.js';
import type { Task } from '../store/types.js';
import type { Hono } from 'hono';
import type { User, TokenScope } from '../store/userStore.js';
import type { ServerDeps } from './deps.js';

/** The daemon's Hono app, typed with the per-request variables the auth middleware sets. Shared by
 *  `createServer` and every route-family registrar so they all agree on `c.get('user')` etc. */
export type OrcaApp = Hono<{ Variables: { user: User; token: string; tokenScope: TokenScope } }>;

/** Minimal structural view of the request context the access predicates read (the real Hono context
 *  satisfies it). Overloaded `get` so a caller can read both the user and the token scope. */
export type AccessCtx = { get: { (k: 'user'): User | undefined; (k: 'tokenScope'): TokenScope | undefined } };

/** Narrower context shape for the admin/user-only predicates that read just the user. */
type UserCtx = { get: (k: 'user') => User | undefined };

/** Shared per-server state and helper predicates, built once from {@link ServerDeps} and threaded into
 *  every route module. This bundles the defaulted singletons (plan jobs, decision queue, tickets, git
 *  lock) and the access/path helpers that used to be closures inside `createServer`, so the route
 *  families can live in their own files while still sharing one source of truth for tenancy gating. */
export interface RouteContext {
  d: ServerDeps;
  log: ReturnType<typeof logger>;
  planJobs: PlanJobStore;
  decisionQueue: DecisionQueue;
  tickets: TicketStore;
  gitLock: KeyedMutex;

  /** Projects an AGENT-scoped token may currently touch (its live working set). */
  agentProjects(): Set<number>;
  /** True when the caller may see/operate the given project (admin/open mode always pass). */
  canAccessProject(c: AccessCtx, id: number): boolean;
  /** True when the caller is NOT the admin on a gated daemon (open/single-user mode → false). */
  notAdmin(c: UserCtx): boolean;
  /** Set of project ids the caller may see, or null for unrestricted (open mode / admin). */
  accessibleProjects(c: AccessCtx): Set<number> | null;
  /** A mission belongs to its epic's project — gate by that project's access. */
  missionAccessible(c: AccessCtx, epicId: string): boolean;
  /** Resolve a live session name to the task it runs (most-recent match wins). */
  taskForSession(session: string): Task | null;
  /** Resolve any live event's owning project — the same logic the activity log stamps rows with. */
  eventDeps: EventProjectDeps;
  /** Ownership guard for the session-control routes (kill / keys / resize / pane / stream). */
  sessionAccessible(c: AccessCtx, name: string): boolean;
  /** Per-user model allow-list check (global config.allowedExecs is the outer bound, checked separately). */
  execAllowedForUser(c: UserCtx, exec: string): boolean;
  /** Filesystem path of a project (store-first, falls back to the home path). */
  pathFor(projectId: number): string;
  /** Where a task's agent actually ran — the worktree for a PR-native mission, else the project path. */
  usagePathFor(task: { project_id: number; parent_id: string | null }): string;
  /** The checkout a mission's work lands in: the isolated PR worktree while live, else the project checkout. */
  checkoutPathFor(missionId: string | null, projectId: number): string;
  /** Resolve the target project for a create/plan request (defaults to the daemon's home project). */
  resolveTarget(c: AccessCtx, projectId?: number):
    | { project: { id: number; path: string } }
    | { error: string; status: 403 | 404 };

  /** Persist a plan job's phases as an epic + chained child tasks (single source for plan + replan). */
  persistPlan(job: PlanJob): { epic: Task; phases: Task[] };
  /** Reap a settled plan job's Pilot tmux session (no-op for relay jobs / already-gone sessions). */
  reapPilotSession(job: PlanJob): void;
  /** Finalize an async plan job: persist, optionally engage/tick a mission, announce over SSE. */
  finalizePlanJob(jobId: string, phases: Phase[]): Promise<void>;
  /** Release the dependents a phase's review gate was holding; returns the ids actually re-opened. */
  releaseGatedDependents(phaseId: string): string[];
  /** The post-done review workflow (gate, verdict apply, commit/self-heal/escalate) for task close. */
  reviewService: ReviewService;
}

/** Build the shared {@link RouteContext} from the daemon's injected {@link ServerDeps}. Core reasoning
 *  stores are optional in deps for back-compat with existing call sites/tests; defaulted here so every
 *  route has a working store. The helper bodies are lifted verbatim from the old `createServer`
 *  closure, so tenancy/path semantics are unchanged. */
export function createRouteContext(d: ServerDeps): RouteContext {
  const log = logger('api');
  const planJobs = d.planJobs ?? new PlanJobStore();
  const decisionQueue = d.decisionQueue ?? new DecisionQueue();
  const tickets = d.tickets ?? createTicketStore();
  const gitLock = d.gitLock ?? new KeyedMutex();

  // The projects an AGENT-scoped token may touch. The shared service token is owned by the admin user,
  // so without this it would inherit admin's cross-project bypass and a prompt-injected agent could
  // read/close tasks in tenants it isn't working in (finding S51). Bind it to the daemon's live work:
  //   • workers   → projects with an in_progress `agent:`-labelled task
  //   • overseers → projects of every active mission's epic (the overseer polls even between phases)
  // A pilot only ever submits to the plan job it was handed (project checked on that job's route), so
  // it needs no extra entry here.
  const agentProjects = (): Set<number> => {
    const ids = new Set<number>();
    for (const t of d.tasks.list({ status: 'in_progress' })) {
      if (t.labels.some((l) => l.startsWith('agent:'))) ids.add(t.project_id);
    }
    for (const m of d.missions.active()) {
      const epic = d.tasks.get(m.epic_id);
      if (epic) ids.add(epic.project_id);
    }
    // The final-phase agent closes the epic itself right after closing its own leaf — by then its task
    // is no longer in_progress and the mission has disengaged, so neither set above covers it and the
    // epic-close would 403. A still-open epic that hosted agent work keeps its project reachable to that
    // agent until the epic is actually closed (then it drops out again). No permanent widening.
    for (const t of d.tasks.list()) {
      if (!t.parent_id || !t.labels.some((l) => l.startsWith('agent:'))) continue;
      const epic = d.tasks.get(t.parent_id);
      if (epic && epic.status !== 'closed' && epic.status !== 'cancelled') ids.add(epic.project_id);
    }
    return ids;
  };

  // A non-admin user may only see/operate projects assigned to them; the admin (and open mode)
  // sees everything. An agent-scoped token is confined to its live working set, never admin-bypass.
  const canAccessProject = (c: AccessCtx, id: number): boolean => {
    if (!d.userProjects || !d.users) return true; // open mode / single-user → no gating
    if (c.get('tokenScope') === 'agent') return agentProjects().has(id);
    const u = c.get('user');
    return !!u && d.userProjects.canAccess(u.id, id);
  };

  // Admin gate for daemon-wide, project-agnostic routes (integrations, etc.). Open/single-user mode
  // (no userProjects store) passes; otherwise only the admin clears it.
  const notAdmin = (c: UserCtx): boolean => {
    if (!d.userProjects || !d.users) return false;
    const u = c.get('user');
    return !u || !d.userProjects.isAdmin(u.id);
  };

  // The set of project ids the caller may see, or null for unrestricted (open mode / admin).
  // Computed once for list endpoints so they don't run a per-row access query. An agent-scoped token
  // is confined to its live working set (never the admin-bypass null).
  const accessibleProjects = (c: AccessCtx): Set<number> | null => {
    if (!d.userProjects || !d.users) return null;
    if (c.get('tokenScope') === 'agent') return agentProjects();
    const u = c.get('user');
    if (!u || d.userProjects.isAdmin(u.id)) return null;
    return new Set(d.userProjects.forUser(u.id));
  };

  // A mission belongs to its epic's project — gate by that project's access. Open/single-user mode
  // has no tenancy boundary, so it always passes (even if the epic row is absent).
  const missionAccessible = (c: AccessCtx, epicId: string): boolean => {
    if (!d.userProjects || !d.users) return true;
    const epic = d.tasks.get(epicId);
    return !!epic && canAccessProject(c, epic.project_id);
  };

  // Resolve a live session name (`orca-<agentName>` / `orca-overseer-<missionId>` / `orca-pilot-…`)
  // to the task it runs, mirroring the daemon's agent:<name> label convention (bootstrap.taskForSession).
  // Agent names recur across missions, so the MOST RECENT match wins (list is created_at ASC).
  const taskForSession = (session: string): Task | null => {
    const info = classifySession(session);
    if (info.role === 'overseer') {
      const mission = d.missions.get(info.missionId ?? '');
      return mission ? d.tasks.get(mission.epic_id) : null;
    }
    const matches = d.tasks.list().filter((t) => t.labels.includes(`agent:${info.agent}`));
    return matches[matches.length - 1] ?? null;
  };

  // Resolve any live event's owning project — the same single-source logic the activity log stamps
  // rows with — so the SSE stream can gate each event per subscriber instead of broadcasting globally.
  const eventDeps: EventProjectDeps = {
    taskProject: (id) => d.tasks.get(id)?.project_id ?? null,
    sessionProject: (s) => taskForSession(s)?.project_id ?? null,
    jobProject: (id) => planJobs.get(id)?.projectId ?? null,
  };

  // Ownership guard for the session-control routes (kill / keys / resize / pane / stream). The caller
  // must be able to access the project the session's task belongs to; admin / open-mode pass via
  // canAccessProject. An unresolvable session (no matching task) is refused — a caller can't operate
  // a session it can't be shown to own.
  const sessionAccessible = (c: AccessCtx, name: string): boolean => {
    if (!d.userProjects || !d.users) return true; // open / single-user mode — no tenancy boundary
    const u = c.get('user');
    // An advisor session belongs to exactly one user: only its owner (or an admin) may reach it, and
    // never via an agent-scoped token. It has no task row, so the project check below can't apply.
    const info = classifySession(name);
    if (info.role === 'advisor') {
      if (c.get('tokenScope') === 'agent') return false;
      return !!u && (u.id === info.userId || d.userProjects.isAdmin(u.id));
    }
    // Admin sees every session — but NOT via an agent-scoped token (it's owned by the admin user yet
    // must stay confined to its working set; fall through to the project check below).
    if (c.get('tokenScope') !== 'agent' && u && d.userProjects.isAdmin(u.id)) return true;
    const task = taskForSession(name);
    return !!task && canAccessProject(c, task.project_id);
  };

  // Per-user model allow-list: a non-admin whose allowed_execs is non-empty may only use those
  // execs. Open mode (no auth), admins, or an empty list → unrestricted. The global
  // config.allowedExecs check still applies independently and is the outer bound.
  const execAllowedForUser = (c: UserCtx, exec: string): boolean => {
    if (!d.users) return true;
    const u = c.get('user');
    if (!u || u.is_admin) return true;
    return u.allowed_execs.length === 0 || u.allowed_execs.includes(exec);
  };

  // Filesystem path of a project. Store-first for EVERY id (the home project included), so this agrees
  // with the scheduler's baseline resolver and a re-homed project path resolves consistently across the
  // spawn baseline and the close-time snapshot. Falls back to the home path when the store is absent
  // (legacy single-project) or the id is unknown.
  const pathFor = (projectId: number): string =>
    d.projects?.get(projectId)?.path ?? d.project.path;

  // Where a task's agent actually ran — the cwd its CLI logged token usage under. For a PR-native
  // mission that's the isolated worktree, not the project checkout; otherwise the project path.
  const usagePathFor = (task: { project_id: number; parent_id: string | null }): string =>
    usagePath(task, pathFor, (id) => d.missionGit?.worktreeFor(id));

  // The checkout a mission's work lands in: the isolated PR worktree while it's live, else the shared
  // project checkout. `missionId` null (or worktree gone) ⇒ the project path.
  const checkoutPathFor = (missionId: string | null, projectId: number): string =>
    (missionId ? d.missionGit?.worktreeFor(missionId) : undefined) ?? pathFor(projectId);

  // Resolve the target project for a create/plan request. Defaults to the daemon's home project;
  // any other project_id must exist and be accessible to the caller.
  const resolveTarget = (c: AccessCtx, projectId?: number):
    | { project: { id: number; path: string } }
    | { error: string; status: 403 | 404 } => {
    const pid = projectId ?? d.project.id;
    if (pid === d.project.id) return { project: d.project };
    const p = d.projects?.get(pid);
    if (!p) return { error: 'project not found', status: 404 };
    if (!canAccessProject(c, p.id)) return { error: 'forbidden', status: 403 };
    return { project: { id: p.id, path: p.path } };
  };

  // Plan persistence + lifecycle (epic/phase creation, engage/tick, Pilot reap) lives in its own
  // service so the planning path is unit-testable without the HTTP surface.
  const planService = createPlanService(d, planJobs, pathFor);
  const { persistPlan, reapPilotSession, finalizePlanJob } = planService;

  // The post-done review workflow (gate → verdict → commit/self-heal/escalate) lives in its own
  // service; releaseGatedDependents is re-exported for the human approve-gate route.
  const reviewService = createReviewService({ d, log, gitLock, decisionQueue, checkoutPathFor, pathFor });
  const { releaseGatedDependents } = reviewService;

  return {
    d, log, planJobs, decisionQueue, tickets, gitLock,
    agentProjects, canAccessProject, notAdmin, accessibleProjects, missionAccessible,
    taskForSession, eventDeps, sessionAccessible, execAllowedForUser,
    pathFor, usagePathFor, checkoutPathFor, resolveTarget,
    persistPlan, reapPilotSession, finalizePlanJob, releaseGatedDependents, reviewService,
  };
}
