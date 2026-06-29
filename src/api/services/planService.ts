import { basename } from 'node:path';
import { shortId } from '../../shared/id.js';
import type { PlanJobStore, PlanJob } from '../../overseer/planJob.js';
import type { Phase } from '../../overseer/planner.js';
import type { Task } from '../../store/types.js';
import type { ServerDeps } from '../deps.js';

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
export function createPlanService(d: ServerDeps, planJobs: PlanJobStore, pathFor: (projectId: number) => string): PlanService {
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
      epic = d.tasks.create({ id: epicId, project_id: job.projectId, title: job.name?.trim() || job.goal, type: 'epic', description: job.goal, labels: prLabels, created_by: job.createdBy ?? null });
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
      const child = d.tasks.create({ id: newId(), project_id: job.projectId, title: ph.title, type: ph.type, parent_id: epic.id, labels: agentLabels, description: childDesc, created_by: job.createdBy ?? null });
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

  return { persistPlan, reapPilotSession, finalizePlanJob };
}
