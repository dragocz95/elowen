import { basename } from 'node:path';
import { shortId } from '../lib/id.js';
import type { AgentsPlanFlow, AgentsPlanJobs } from '../../../../src/plugins/api.js';
import type { ElowenEvent } from '../../../../src/api/sse.js';
import type { Phase, PlanJob } from '../../../../src/shared/agentEvents.js';
import type { Task } from '../../../../src/store/types.js';
import type { TaskStoreContract } from '../../../../src/store/taskStoreContract.js';

/** What plan persistence reaches beyond its own store. Every one is resolved LIVE (the agents plugin
 *  can be disabled or reloaded between two plans, and the workspace exec allow-list is edited in
 *  Settings), so the service holds accessors rather than values. */
export interface PlanServiceDeps {
  tasks(): TaskStoreContract;
  planJobs(): AgentsPlanJobs;
  /** The agents half of the flow (mission labels, engage/tick). Absent while that plugin is disabled. */
  planFlow(): AgentsPlanFlow | undefined;
  /** The workspace exec allow-list — the outer bound on a planner-picked model. */
  allowedExecs(): string[];
  publishEvent(event: ElowenEvent): void;
  /** Kill a settled Pilot's tmux pane (best-effort). */
  killSession(name: string): Promise<void>;
  /** Filesystem path of a project — shared with the routes so a re-homed project resolves identically
   *  here and at spawn/snapshot time. */
  pathFor(projectId: number): string;
}

export interface PlanService {
  /** Persist a plan job's phases as an epic + chained child tasks (single source for plan + replan). */
  persistPlan(job: PlanJob): { epic: Task; phases: Task[] };
  /** Reap a settled plan job's Pilot tmux session (no-op for relay jobs / already-gone sessions). */
  reapPilotSession(job: PlanJob): void;
  /** Finalize an async plan job: persist, optionally engage/tick a mission, announce over SSE. */
  finalizePlanJob(jobId: string, phases: Phase[]): Promise<void>;
}

/** Plan persistence + lifecycle: turning a plan job's phases into the epic+children DAG, engaging or
 *  ticking the mission, and reaping the Pilot session. Extracted from the route layer so the planning
 *  path can be unit-tested without the HTTP surface. `pathFor` is shared with the route context so a
 *  re-homed project resolves identically here and at spawn/snapshot time. */
export function createPlanService(d: PlanServiceDeps): PlanService {
  const { pathFor } = d;
  const planJobs = (): AgentsPlanJobs => d.planJobs();
  // Persist a plan job's phases as an epic + chained child tasks. Creates the epic when the job has
  // no epicId yet; otherwise appends after the epic's current tail (leaves = phases nothing depends
  // on). For a fresh epic there are no descendants, so the first new phase simply starts the chain.
  // Single source of truth for both initial planning and replan (DRY with the old inline blocks).
  function persistPlan(job: PlanJob): { epic: Task; phases: Task[] } {
    const tasks = d.tasks();
    const path = pathFor(job.projectId);
    const allowedExecs = d.allowedExecs();
    const newId = () => shortId(basename(path));
    const epicId = job.epicId ?? newId();
    // The whole write — the epic (if new), every phase task, every dependency edge — runs as ONE
    // transaction, so an id collision or a disk error partway can never leave a partial plan (some
    // phases created, some deps wired, the rest missing). Bus events are collected here and published
    // only AFTER the transaction below returns (i.e. after it commits), so a subscriber never sees an
    // event for a task a later step in the same plan failed to create.
    const toPublish: { taskId: string; status: Task['status'] }[] = [];
    // Mission labels (the epic PR override, per-phase agent names) are agents vocabulary — the plugin
    // supplies them; without it a plan persists label-less (there is no mission to read them anyway).
    const labels = d.planFlow()?.planLabels();
    const { epic, created } = tasks.transaction(() => {
      let epic = tasks.get(epicId);
      if (!epic) {
        // Title = the short mission name when given (else the goal, so it's never blank); the full goal
        // always lands in the description. This is what lets the tasks UI show a tidy name + the full brief.
        epic = tasks.create({ id: epicId, project_id: job.projectId, title: job.name?.trim() || job.goal, type: 'epic', description: job.goal, labels: labels?.epic(job.prEnabled) ?? [], created_by: job.createdBy ?? null });
        toPublish.push({ taskId: epic.id, status: epic.status });
      }
      const existing = tasks.descendants(epic.id);
      const dependedOn = new Set(tasks.depsAmong(existing.map((t) => t.id)).map((e) => e.depends_on_id));
      const leaves = existing.map((t) => t.id).filter((id) => !dependedOn.has(id));
      const overallGoal = epic.description?.trim() || epic.title;
      const phaseLabels = labels?.phaseLabeler(existing) ?? (() => []);
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
        const child = tasks.create({ id: newId(), project_id: job.projectId, title: ph.title, type: ph.type, parent_id: epic.id, labels: phaseLabels(ph.agent), description: childDesc, created_by: job.createdBy ?? null });
        if (ph.id) idMap.set(ph.id, child.id);
        // exec: auto mode takes the planner's per-phase pick, manual mode the job-level choice. Either
        // way it must be allow-listed — a halucinated/disabled exec is dropped so the child runs with
        // the configured default (resolveExecutor fallback), never a bogus model.
        const pickedExec = job.autoModel ? ph.exec : job.exec;
        if (pickedExec && allowedExecs.includes(pickedExec)) tasks.setExec(child.id, pickedExec);
        toPublish.push({ taskId: child.id, status: child.status });
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
          if (prevId) tasks.addDep(child.id, prevId); // chain within the new batch
          else for (const leaf of leaves) tasks.addDep(child.id, leaf); // first new phase waits on the tail
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
        tasks.setDeps(child.id, withFrontier);
      });
      return { epic, created };
    });
    for (const e of toPublish) d.publishEvent({ type: 'task', taskId: e.taskId, status: e.status });
    return { epic, phases: created };
  }

  // Reap a settled plan job's Pilot tmux session. The Pilot has submitted (or the job failed), so its
  // pane is done; leaving it alive lets a finished planner linger and later collide with a fresh plan
  // job's session name. No-op for relay jobs (no session) and safe if the session is already gone.
  const reapPilotSession = (job: PlanJob): void => {
    if (job.sessionName) void d.killSession(job.sessionName).catch(() => { /* already gone — fine */ });
  };

  // Finalize an async plan job: a dryRun job records phases without persisting; otherwise persist the
  // epic+children, optionally engage a mission, tick an already-active mission so it picks up the new
  // ready phase, and announce the result over SSE. Shared by the relay path and the agent submit path.
  async function finalizePlanJob(jobId: string, phases: Phase[]): Promise<void> {
    const job = planJobs().get(jobId);
    if (!job) return;
    if (job.dryRun) {
      planJobs().setPhases(jobId, phases);
      d.publishEvent({ type: 'plan', jobId, status: 'done', phases });
      reapPilotSession(job);
      return;
    }
    job.phases = phases;
    const { epic, phases: created } = persistPlan(job);
    job.epicId = epic.id;
    planJobs().setPhases(jobId, phases);
    // The plan routes refuse engage without the plugin up front; this covers a plugin disabled (or
    // reloading) in the async window — fail the engage loudly rather than silently skipping it.
    if (job.engage && !d.planFlow()) throw new Error('agents plugin is disabled');
    // Engage a fresh mission (job.engage) or tick a live one so a replan's phases are picked up now.
    await d.planFlow()?.planEngage(job, epic.id);
    d.publishEvent({ type: 'plan', jobId, status: 'done', epicId: epic.id, phases: created.map((t) => ({ title: t.title, type: t.type })) });
    reapPilotSession(job);
  }

  return { persistPlan, reapPilotSession, finalizePlanJob };
}
