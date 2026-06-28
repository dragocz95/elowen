import { basename } from 'node:path';
import { classifySession } from '../overseer/sessionInfo.js';
import { usagePath } from '../integrations/usage/usagePath.js';
import { shortId } from '../shared/id.js';
import { logger } from '../shared/logger.js';
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

  // Persist a plan job's phases as an epic + chained child tasks. Creates the epic when the job has
  // no epicId yet; otherwise appends after the epic's current tail (leaves = phases nothing depends
  // on). For a fresh epic there are no descendants, so the first new phase simply starts the chain.
  // Single source of truth for both initial planning and replan (DRY with the old inline blocks).
  function persistPlan(job: PlanJob): { epic: Task; phases: Task[] } {
    const path = pathFor(job.projectId);
    const allowedExecs = d.config.get().allowedExecs;
    const newId = () => shortId(basename(path));
    const epicId = job.epicId ?? newId();
    let epic = d.tasks.get(epicId);
    if (!epic) {
      // A per-task PR override rides as a `pr:on`/`pr:off` epic label (missionGit reads it first, before
      // the project/global default). Only stamped on a fresh epic — a replan must never flip the mode.
      const prLabels = job.prEnabled === true ? ['pr:on'] : job.prEnabled === false ? ['pr:off'] : [];
      // Title = the short mission name when given (else the goal, so it's never blank); the full goal
      // always lands in the description. This is what lets the tasks UI show a tidy name + the full brief.
      epic = d.tasks.create({ id: epicId, project_id: job.projectId, title: job.name?.trim() || job.goal, type: 'epic', description: job.goal, labels: prLabels });
      d.bus.publish({ type: 'task', taskId: epic.id, status: epic.status });
    }
    const existing = d.tasks.descendants(epic.id);
    const dependedOn = new Set(d.tasks.depsAmong(existing.map((t) => t.id)).map((e) => e.depends_on_id));
    const leaves = existing.map((t) => t.id).filter((id) => !dependedOn.has(id));
    const overallGoal = epic.description?.trim() || epic.title;
    // Agent names double as tmux session names AND as the janitor/deriver's session↔task key, so the
    // "one agent name ↔ one task" invariant is load-bearing. The pilot (an LLM) can hand the same name
    // to several phases; honour each only while it's still free (across the epic's existing tasks and
    // this batch), else drop it so the engine assigns a fresh unique name via freeAgentName at spawn.
    const usedAgents = new Set(existing.flatMap((t) => t.labels.filter((l) => l.startsWith('agent:')).map((l) => l.slice('agent:'.length))));
    const created: Task[] = [];
    // No phase carries an id → we can't build a real DAG, so reproduce the legacy prev→next chain
    // (back-compat: old relay prompts and manual UI phases never emit ids). Any id present → DAG mode.
    const linear = job.phases.every((p) => !p.id);
    const idMap = new Map<string, string>(); // planner-local phase id → created DB task id
    // Pass 1: create every child task first, so a phase's dependsOn can reference a sibling defined
    // either earlier OR later in the array (a DAG, not just a backward chain). Deps wired in pass 2.
    for (const ph of job.phases) {
      // The web detail pane strips this appended overgoal back off (web/lib/agentUtils phaseDetails),
      // which anchors on the exact `\n\nOverall goal:` separator — keep that wording/join in sync.
      const childDesc = ph.details ? `${ph.details}\n\nOverall goal: ${overallGoal}` : `Overall goal: ${overallGoal}`;
      const agentLabels = ph.agent && !usedAgents.has(ph.agent) ? [`agent:${ph.agent}`] : [];
      if (agentLabels.length) usedAgents.add(ph.agent!);
      const child = d.tasks.create({ id: newId(), project_id: job.projectId, title: ph.title, type: ph.type, parent_id: epic.id, labels: agentLabels, description: childDesc });
      if (ph.id) idMap.set(ph.id, child.id);
      // exec: auto mode takes the planner's per-phase pick, manual mode the job-level choice. Either
      // way it must be allow-listed — a halucinated/disabled exec is dropped so the child runs with
      // the configured default (resolveExecutor fallback), never a bogus model.
      const pickedExec = job.autoModel ? ph.exec : job.exec;
      if (pickedExec && allowedExecs.includes(pickedExec)) d.tasks.setExec(child.id, pickedExec);
      d.bus.publish({ type: 'task', taskId: child.id, status: child.status });
      created.push(child);
    }
    // Pass 2: wire dependencies. Linear mode reproduces the old chain exactly. DAG mode maps each
    // phase's dependsOn (planner-local ids) to DB ids. A phase that declared NO deps inherits the
    // epic's current leaves, so a replan never overtakes unfinished work — a fresh epic has no leaves,
    // so such phases start ready (enabling parallel branches). setDeps' cycle guard quietly drops any
    // hallucinated loop, so the mission can never deadlock.
    let prevId: string | null = null;
    created.forEach((child, i) => {
      const ph = job.phases[i]!; // created is built 1:1 from job.phases above, so this is always defined
      if (linear) {
        if (prevId) d.tasks.addDep(child.id, prevId); // chain within the new batch
        else for (const leaf of leaves) d.tasks.addDep(child.id, leaf); // first new phase waits on the tail
        prevId = child.id;
        return;
      }
      const declared = ph.dependsOn ?? [];
      const deps = declared.map((pid) => idMap.get(pid)).filter((x): x is string => !!x);
      // Planner DECLARED dependencies but none resolved (typo'd / hallucinated ids): don't silently
      // drop the ordering and let the phase start early in parallel — fall back to the previous phase
      // in the batch so it still waits (the first phase has no predecessor → leaves/ready). Only a
      // phase that declared no deps at all gets the leaves (genuine parallel/replan-append).
      const effective = deps.length ? deps
        : declared.length > 0 ? (i > 0 ? [created[i - 1]!.id] : leaves)
          : leaves;
      // On a replan into a LIVE epic (pre-existing leaves), a phase that resolved its deps among the
      // new batch would otherwise ignore the still-running frontier and could start alongside it —
      // even a hallucinated cycle, once the guard drops an edge, leaves a root with no leaf dep. Also
      // wait on the existing leaves so the "a replan never overtakes unfinished work" invariant holds.
      // A fresh epic has no leaves, so independent branches still start in parallel as intended.
      const withFrontier = deps.length && leaves.length ? [...new Set([...effective, ...leaves])] : effective;
      d.tasks.setDeps(child.id, withFrontier);
    });
    return { epic, phases: created };
  }

  // Reap a settled plan job's Pilot tmux session. The Pilot has submitted (or the job failed), so its
  // pane is done; leaving it alive lets a finished planner linger and later collide with a fresh plan
  // job's session name. No-op for relay jobs (no session) and safe if the session is already gone.
  const reapPilotSession = (job: PlanJob): void => {
    if (job.sessionName) void d.tmux.kill(job.sessionName).catch(() => { /* already gone — fine */ });
  };

  // Finalize an async plan job: a dryRun job records phases without persisting; otherwise persist the
  // epic+children, optionally engage a mission, tick an already-active mission so it picks up the new
  // ready phase, and announce the result over SSE. Shared by the relay path and the agent submit path.
  async function finalizePlanJob(jobId: string, phases: Phase[]): Promise<void> {
    const job = planJobs.get(jobId);
    if (!job) return;
    if (job.dryRun) {
      planJobs.setPhases(jobId, phases);
      d.bus.publish({ type: 'plan', jobId, status: 'done', phases });
      reapPilotSession(job);
      return;
    }
    job.phases = phases;
    const { epic, phases: created } = persistPlan(job);
    job.epicId = epic.id;
    planJobs.setPhases(jobId, phases);
    if (job.engage) {
      await d.engine.engage({ epicId: epic.id, autonomy: job.engage.autonomy, maxSessions: job.engage.maxSessions, preserveReviewBudget: job.engage.preserveReviewBudget });
    } else {
      const missionId = `m-${epic.id}`;
      if (d.engine?.isActive(missionId)) await d.engine.tick(missionId); // replan into a live mission
    }
    d.bus.publish({ type: 'plan', jobId, status: 'done', epicId: epic.id, phases: created.map((t) => ({ title: t.title, type: t.type })) });
    reapPilotSession(job);
  }

  /** Release the dependents a phase's review gate was holding: clear this phase's `gatedby:<id>` hold
   *  and re-open each dependent that no OTHER review still gates (a DAG dependent can be held by several
   *  predecessors at once). Re-check 'blocked' so a human's manual change is never overridden. Single
   *  source of truth for both an agent-approved verdict and a human approval, so they behave
   *  identically. Returns the ids actually re-opened. */
  function releaseGatedDependents(phaseId: string): string[] {
    const reopened: string[] = [];
    for (const e of d.tasks.allDeps()) {
      if (e.depends_on_id !== phaseId) continue;
      const dep = d.tasks.get(e.task_id);
      if (!dep || !dep.labels.includes(`gatedby:${phaseId}`)) continue;
      d.tasks.removeLabel(dep.id, `gatedby:${phaseId}`);
      const stillGated = d.tasks.get(dep.id)!.labels.some((l) => l.startsWith('gatedby:'));
      if (!stillGated && dep.status === 'blocked') {
        d.tasks.setStatus(dep.id, 'open');
        d.bus.publish({ type: 'task', taskId: dep.id, status: 'open' });
        reopened.push(dep.id);
      }
    }
    return reopened;
  }

  return {
    d, log, planJobs, decisionQueue, tickets, gitLock,
    agentProjects, canAccessProject, notAdmin, accessibleProjects, missionAccessible,
    taskForSession, eventDeps, sessionAccessible, execAllowedForUser,
    pathFor, usagePathFor, checkoutPathFor, resolveTarget,
    persistPlan, reapPilotSession, finalizePlanJob, releaseGatedDependents,
  };
}
