import { basename } from 'node:path';
import { shapeBrainMessages } from '../../brain/messageView.js';
import { taskSessionId } from '../../brain/sessionId.js';
import { projectRangeFileDiff, projectRangeLog, projectCommitFileDiff } from '../../integrations/projectFiles.js';
import { decompose, parsePhases, modelsBlock, parallelismBlock, VALID_TYPES as VALID_PHASE_TYPES, type Phase } from '../services/planner.js';
import { snapshotTaskChanges } from '../services/taskSnapshot.js';
import { RelayClient } from '../../inference/client.js';
import { shortId } from '../../shared/id.js';
import { parseBody } from '../validation.js';
import { createTaskSchema, patchTaskSchema, planSchema, insertPhasesSchema } from '../schemas/tasks.js';
import type { ElowenApp, RouteContext } from '../context.js';
import type { ReadinessContract, TaskStoreContract } from '../../store/taskStoreContract.js';

/** Exactly the paths THIS family serves, for the availability gate below. Matched in code rather than
 *  registered as per-path middleware for two reasons: a `/tasks/*` wildcard would also swallow
 *  `/tasks/:id/ask|guide|approve-gate`, which are the agents plugin's own root mounts and carry their
 *  own availability answer; and a non-wildcard `app.use(path)` registers a route pattern that the root
 *  plugin dispatcher reads as core OWNING that path for every method, which would drop a plugin mount
 *  on a method core never serves. */
const TASK_DOMAIN_PATHS = [
  /^\/tasks$/,
  /^\/tasks\/[^/]+$/,
  /^\/tasks\/[^/]+\/(usage|conversation|deps|commits|phases)$/,
  /^\/tasks\/[^/]+\/changed\/diff$/,
  /^\/tasks\/[^/]+\/commit\/[^/]+\/diff$/,
  /^\/plan\/[^/]+(\/submit)?$/,
];

/** The task domain, asserted present. Every route below sits behind the availability middleware, so
 *  this can only throw for a route added OUTSIDE that gate — which is exactly when a loud failure beats
 *  silently serving an empty task list. */
const tasksOf = (d: RouteContext['d']): TaskStoreContract => {
  if (!d.tasks) throw new Error('task route reached without the task domain — missing availability gate');
  return d.tasks;
};
const readinessOf = (d: RouteContext['d']): ReadinessContract => {
  if (!d.readiness) throw new Error('task route reached without the task domain — missing availability gate');
  return d.readiness;
};

/** A patch the store refused mid-write (a dangling/cyclic dependency edge, an illegal reparent). It
 *  carries the client-facing reason so the handler can roll the WHOLE patch back and answer 400,
 *  instead of leaving the accepted half of the same request applied. */
class PatchRejected extends Error {}

/** Whether an agent session is STILL live after its kill failed — the only evidence that lets a
 *  destructive route treat that failure as a benign "already gone" rather than a stranded worker. An
 *  unreadable session list counts as live: unverified is not the same as gone. */
async function sessionLive(d: RouteContext['d'], session: string): Promise<boolean> {
  if (d.brainWorkers?.isLive(session)) return true;
  try { return (await d.tmux.list()).includes(session); } catch { return true; }
}

/** Tasks and the plan/replan endpoints. The post-done review workflow that the close path drives lives
 *  in the agents plugin (reached through `d.onTaskClosed`); planning lives in {@link PlanService}. The
 *  usage aggregates and the admin cleanup that used to sit here are core-owned surfaces of their own
 *  (routes/usage.ts, routes/admin.ts) — they outlive the task domain. */
export function registerTaskRoutes(app: ElowenApp, ctx: RouteContext): void {
  const {
    d, log, planJobs, gitLock,
    canAccessProject, accessibleProjects, execAllowedForUser,
    pathFor, checkoutPathFor, resolveTarget,
    persistPlan, reapPilotSession, finalizePlanJob,
  } = ctx;
  // The domain's owner is a plugin, so it can be absent (disabled, or reloading). Answer that once, for
  // the whole family, with the same honest 503 the plugin-owned surfaces use: an empty list here would
  // read as "this instance has no tasks", which is a different — and false — statement.
  app.use('*', async (c, next) => {
    if (!TASK_DOMAIN_PATHS.some((p) => p.test(c.req.path))) return next();
    if (!d.tasks || !d.readiness) return c.json({ error: 'task tracking is unavailable (its plugin is disabled)' }, 503);
    return next();
  });
  app.get('/tasks', c => {
    const allowed = accessibleProjects(c);
    const all = tasksOf(d).list();
    const scoped = allowed ? all.filter((t) => allowed.has(t.project_id)) : all;
    // Optional `?project_id=N` narrows the list to one project. Applied AFTER the access gate so a
    // non-admin can't cross tenancy. An unknown/foreign id simply yields [] (no 404 — benevolent).
    const pidRaw = c.req.query('project_id');
    if (pidRaw !== undefined && pidRaw !== '') {
      const pid = Number(pidRaw);
      if (Number.isFinite(pid)) return c.json(scoped.filter((t) => t.project_id === pid));
    }
    return c.json(scoped);
  });
  app.post('/tasks', async c => {
    const b = await parseBody(c, createTaskSchema);
    const target = resolveTarget(c, b.project_id);
    if ('error' in target) return c.json({ error: target.error }, target.status);
    const id = b.id ?? shortId(basename(target.project.path));
    // The row and its dependency edges are ONE unit of work: a task that survived a failed setDeps
    // would be created with no predecessors at all and go straight into the ready queue, running
    // ahead of the work it was declared to wait for.
    const created = tasksOf(d).transaction(() => {
      const task = tasksOf(d).create({ id, project_id: target.project.id, title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart, created_by: c.get('user')?.id ?? null });
      if (Array.isArray(b.deps)) tasksOf(d).setDeps(task.id, b.deps);
      return task;
    });
    d.bus.publish({ type: 'task', taskId: created.id, status: created.status });
    return c.json(created, 201);
  });
  app.get('/tasks/ready', c => {
    // Scope like GET /tasks: previously this always returned the daemon home project's ready queue,
    // unscoped — leaking its task titles/descriptions to any user (or agent token) assigned only to a
    // different project, while that project's own ready tasks were unreachable. Resolve an accessible
    // project (optional ?project_id, else home) and yield [] when the caller can't access it.
    const allowed = accessibleProjects(c); // undefined ⇒ admin / open mode (unrestricted)
    const pidRaw = c.req.query('project_id');
    const pid = pidRaw !== undefined && pidRaw !== '' && Number.isFinite(Number(pidRaw)) ? Number(pidRaw) : d.project.id;
    if (allowed && !allowed.has(pid)) return c.json([]);
    return c.json(readinessOf(d).ready(pid));
  });
  app.get('/tasks/deps', c => {
    const allowed = accessibleProjects(c);
    const deps = tasksOf(d).allDeps();
    if (!allowed) return c.json(deps); // admin / open mode → unrestricted
    // Non-admin: keep only edges whose task belongs to a project the caller can access.
    const visible = new Set(tasksOf(d).list().filter(t => allowed.has(t.project_id)).map(t => t.id));
    return c.json(deps.filter(e => visible.has(e.task_id)));
  });
  // Token/cost usage for a task's agent run, read from the executor CLI's local session storage
  // (opencode / claude / codex) — portable, no relay. Null usage → no matching session found.
  app.get('/tasks/:id/usage', c => {
    const task = tasksOf(d).get(c.req.param('id'));
    if (!task) return c.json({ error: 'not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    // The live reader lives in the agents plugin (it owns the CLI session-store parsers). Absent
    // plugin, embedded-brain (elowen:) runs, or an empty read → the snapshot the recorder / the
    // BrainWorkerService persisted at close (this is where provider-reported cost lives).
    const live = d.liveTaskUsage?.(task.id) ?? null;
    return c.json(live ?? d.taskUsage?.get(task.id) ?? null);
  });
  // The transcript of an embedded-brain (elowen:) worker run — the task detail's conversation tab.
  // CLI-run tasks have no brain session, so this returns an empty list for them.
  app.get('/tasks/:id/conversation', (c) => {
    const id = c.req.param('id');
    const task = tasksOf(d).get(id);
    if (!task) return c.json({ error: 'not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brainStore) return c.json([]);
    const sessionId = taskSessionId(id);
    return c.json(shapeBrainMessages(d.brainStore.getMessages(sessionId), d.brainStore.getSubagentRuns(sessionId)));
  });

  app.patch('/tasks/:id', async c => {
    const b = await parseBody(c, patchTaskSchema);
    const id = c.req.param('id');
    const existing = tasksOf(d).get(id);
    if (!existing) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, existing.project_id)) return c.json({ error: 'forbidden' }, 403);
    // An agent-scoped token (a spawned worker) may only CLOSE its task — set status + the closing
    // summary/outcome. Block the rest of the patch surface (exec/title/priority/description/deps/…) so a
    // prompt-injected worker running --dangerously-skip-permissions can't rewrite sibling tasks' fields
    // within its project (intra-tenant integrity, finding S51). Humans/full tokens keep the full surface.
    if (c.get('tokenScope') === 'agent') {
      const allowed = new Set(['status', 'result_summary', 'outcome']);
      if (Object.keys(b).some((k) => !allowed.has(k))) return c.json({ error: 'forbidden' }, 403);
    }
    // Validate the WHOLE command before writing ANY of it. The exec gate used to run after the status
    // branch, so `{status:'closed', exec:'<not allowed>'}` closed the task, published its SSE and drove
    // the review workflow — and only then answered 400, leaving the rejected command half-applied.
    if (typeof b.exec === 'string') {
      // Gate the executor exactly like the plan/session routes: an unvalidated exec is stored as an
      // `exec:<spec>` label and later interpolated into the agent launch command, so without this check
      // a project member could set an arbitrary executor (escaping the allow-list) or smuggle shell
      // metacharacters through the model field. Empty string clears the override (revert to fallback).
      if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);
      if (b.exec && !execAllowedForUser(c, b.exec)) return c.json({ error: 'exec not allowed for user' }, 403);
    }
    // Reverting a RUNNING task to open/cancelled must stop its live agent FIRST. Otherwise the
    // orphaned session keeps editing the shared checkout while the scheduler — which counts only
    // in_progress tasks as busy (checkoutBusy) — treats the checkout as free and can spawn a SECOND
    // concurrent agent into it. Mirror the sessions DELETE kill path: embedded brain worker → abort,
    // tmux pane → kill. Best-effort; a missing session is already gone.
    if (b.status && existing.status === 'in_progress' && (b.status === 'open' || b.status === 'cancelled')) {
      const agent = existing.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
      if (agent) {
        const session = `elowen-${agent}`;
        if (d.brainWorkers?.isLive(session)) await d.brainWorkers.abort(session).catch(() => { /* already gone */ });
        else await d.tmux.kill(session).catch(() => { /* already gone */ });
      }
    }
    // Every write of the patch in ONE transaction, so a field the store refuses (a dangling/cyclic
    // dependency edge, an illegal reparent) rolls back the fields that were accepted alongside it
    // instead of persisting a partial patch behind the 400.
    try {
      tasksOf(d).transaction(() => {
        if (b.status) {
          if (b.status === 'closed') tasksOf(d).close(id, { summary: b.result_summary, outcome: b.outcome });
          else tasksOf(d).setStatus(id, b.status);
        }
        if (typeof b.exec === 'string') tasksOf(d).setExec(id, b.exec);
        if (typeof b.title === 'string' || typeof b.type === 'string' || typeof b.priority === 'string' || typeof b.description === 'string' || b.scheduled_at !== undefined || b.autostart !== undefined) {
          tasksOf(d).update(id, { title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart });
        }
        if (Array.isArray(b.deps)) tasksOf(d).setDeps(id, b.deps);
        // Single-edge add (the drag-onto-card "add dependency" gesture): atomic, unlike a client-side
        // fetch-current-deps-then-PATCH-the-whole-array round trip, which races against a concurrent
        // editor of the same task's deps. setDeps stays the bulk-replace path (the deps modal). Unlike
        // that bulk path, this is one deliberate action, so a rejected edge (missing endpoint, cross-
        // project) surfaces as a 400 instead of silently vanishing.
        if (typeof b.addDep === 'string' && !tasksOf(d).addDep(id, b.addDep)) throw new PatchRejected('invalid dependency');
        // Drag-a-card-onto-another-card "make subtask" gesture. reparent() promotes the target to an
        // epic if needed.
        if (typeof b.parent_id === 'string') {
          const result = tasksOf(d).reparent(id, b.parent_id);
          if ('error' in result) throw new PatchRejected(result.error);
        }
      });
    } catch (e) {
      if (e instanceof PatchRejected) return c.json({ error: e.message }, 400);
      throw e;
    }
    // Side effects only once the whole patch is committed — an observer (SSE client, review workflow,
    // mission tick) must never see a state the transaction could still roll back.
    if (b.status) {
      d.bus.publish({ type: 'task', taskId: id, status: b.status });
      if (b.status === 'closed') {
        // ORDER MATTERS: freeze a standalone task's change list FIRST — the snapshot is core-owned
        // (it must exist even with the agents plugin disabled) — and only THEN hand the close to the
        // plugin's review gate. A mission phase is the opposite: its commit + snapshot happen INSIDE
        // the gate (after the verdict), so core must not snapshot it here — snapshotting before the
        // phase commit would freeze a change list that misses the phase's own work. Under the shared
        // checkout lock so the range can't straddle a concurrent agent's commit on the same path.
        if (!existing.parent_id) {
          const snapPath = pathFor(existing.project_id);
          await gitLock.run(snapPath, () => snapshotTaskChanges(tasksOf(d), id, snapPath));
        }
        // The post-done overseer review gate (agents plugin). AWAITED: the gate blocks the phase's
        // direct dependents synchronously, and the engine tick must never observe them un-gated.
        // Absent plugin → no gate, the close is final.
        await d.onTaskClosed?.(id, existing, { outcome: b.outcome, summary: b.result_summary });
      }
    }
    // If the new parent's mission is already live, tick it so the new phase is picked up now instead
    // of waiting for the next scheduled tick — same pattern as insert-phases below.
    if (typeof b.parent_id === 'string') {
      const missionId = `m-${b.parent_id}`;
      const engine = d.engine;
      if (engine?.isActive(missionId)) await engine.tick(missionId);
    }
    return c.json(tasksOf(d).get(id));
  });
  // Diff of one file from a task's FROZEN change list (the commits it landed between base..head). Read
  // from the mission worktree while it's live, else the project checkout (where the commits merged to).
  // Empty when the task has no snapshot, the file isn't in it, or the refs were GC'd by a later squash.
  app.get('/tasks/:id/changed/diff', async c => {
    const id = c.req.param('id');
    const task = tasksOf(d).get(id);
    if (!task) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path') ?? '';
    if (!task.base_sha || !task.head_sha || !path) return c.json({ diff: '' });
    const root = checkoutPathFor(task.parent_id ? `m-${task.parent_id}` : null, task.project_id);
    try {
      return c.json({ diff: await projectRangeFileDiff(root, task.base_sha, task.head_sha, path) });
    } catch {
      return c.json({ diff: '' }); // path-traversal reject / bad ref — degrade to empty, never 500
    }
  });
  // The commits a task landed (`git log base..head` in its checkout) — the per-commit history shown
  // live in the detail pane's "conversation & history" feed, refreshed via the `change` SSE ping.
  // Empty until the first snapshot stamps base/head, or when the refs were GC'd by a later squash.
  app.get('/tasks/:id/commits', async c => {
    const id = c.req.param('id');
    const task = tasksOf(d).get(id);
    if (!task) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    if (!task.base_sha || !task.head_sha) return c.json({ commits: [] });
    const root = checkoutPathFor(task.parent_id ? `m-${task.parent_id}` : null, task.project_id);
    return c.json({ commits: await projectRangeLog(root, task.base_sha, task.head_sha) });
  });
  // Diff of one file as introduced by ONE of a task's commits (`git show <hash> -- <path>` in the task's
  // checkout) — the per-commit click-through in the conversation feed. Distinct from changed/diff, which
  // is the cumulative base..head diff. Empty on a bad hash/path or a GC'd ref — degrades, never 500s.
  app.get('/tasks/:id/commit/:hash/diff', async c => {
    const id = c.req.param('id');
    const task = tasksOf(d).get(id);
    if (!task) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path') ?? '';
    if (!path) return c.json({ diff: '' });
    const root = checkoutPathFor(task.parent_id ? `m-${task.parent_id}` : null, task.project_id);
    try {
      return c.json({ diff: await projectCommitFileDiff(root, c.req.param('hash'), path) });
    } catch {
      return c.json({ diff: '' });
    }
  });
  app.get('/tasks/:id/deps', c => {
    const task = tasksOf(d).get(c.req.param('id'));
    if (!task) return c.json({ error: 'not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    return c.json(tasksOf(d).depsFor(c.req.param('id')));
  });
  app.delete('/tasks/:id', async c => {
    const id = c.req.param('id');
    const existing = tasksOf(d).get(id);
    if (!existing) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, existing.project_id)) return c.json({ error: 'forbidden' }, 403);
    // An epic always removes its whole mission — decided from the task's REAL type, not a caller-
    // supplied `?subtree=1` flag: deleteEpic() below deletes the whole subtree either way (a plain
    // DELETE with the flag omitted used to skip straight to it, removing the mission row before it
    // could be disengaged and leaving its agents/worktree running against a mission that no longer
    // exists in the DB).
    if (existing.type === 'epic') {
      // Mission id is `m-<epicId>` by construction. Stop a still-running mission (kills its agents),
      // then free its worktree UNCONDITIONALLY: a naturally-completed ('disengaged') or paused mission
      // keeps its worktree for the PR/feedback path, so disengage() alone would skip it and leak the
      // on-disk worktree when the epic is deleted (the mission_pr row is also pruned by the cascade).
      const missionId = `m-${id}`;
      const mission = d.missions.get(missionId);
      // Teardown must SUCCEED before the rows go. Both calls already return quietly for the "nothing
      // to tear down" state — disengage() is skipped for an already-disengaged mission and cleanup()
      // returns early when there is no worktree record — so anything thrown here is a teardown that
      // genuinely failed. Deleting the epic then would strand live agents and an on-disk worktree
      // against a mission that no longer exists in the DB, with nothing left to find them by.
      try {
        if (mission && mission.state !== 'disengaged') {
          // Teardown must SUCCEED before the rows go — with the agents plugin disabled there is
          // nothing that could stop the mission's agents, so refuse rather than strand them.
          if (!d.engine) return c.json({ error: 'agents plugin is disabled' }, 503);
          await d.engine.disengage(missionId);
        }
        await d.missionGit?.cleanup(missionId);
      } catch (e) {
        log.error(`epic ${id} not deleted — mission teardown failed`, e);
        return c.json({ error: 'mission teardown failed' }, 500);
      }
      // deleteEpic cascades the mission rows, PR records AND handoff notes (cascade.ts), so a removed
      // mission leaves no orphan note under any scope.
      const removed = tasksOf(d).deleteEpic(id);
      d.bus.publish({ type: 'task', taskId: id, status: 'cancelled' });
      d.events?.deleteForTarget(id);
      return c.json({ ok: true, tasks: removed.tasks });
    }
    // A standalone task or a single mission phase: stop its own live agent FIRST — mirrors the
    // status-revert kill path above (PATCH .../status → open|cancelled) — otherwise the orphaned tmux
    // session / embedded worker keeps editing the shared checkout after the row (and the UI's view of
    // it) is already gone.
    if (existing.status === 'in_progress') {
      const agent = existing.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
      if (agent) {
        const session = `elowen-${agent}`;
        try {
          if (d.brainWorkers?.isLive(session)) await d.brainWorkers.abort(session);
          else await d.tmux.kill(session);
        } catch (e) {
          // Only a session VERIFIED to be gone may be ignored (killing one that already exited is the
          // normal failure here). One that is still live outlived its kill, so keep the row: deleting
          // it would leave the worker editing the checkout with nothing left to find or stop it by.
          if (await sessionLive(d, session)) {
            log.error(`task ${id} not deleted — agent teardown failed`, e);
            return c.json({ error: 'agent teardown failed' }, 500);
          }
        }
      }
    }
    tasksOf(d).delete(id);
    d.bus.publish({ type: 'task', taskId: id, status: 'cancelled' }); // live SSE so open UIs drop the row
    d.events?.deleteForTarget(id); // purge its history — a removed task leaves no dead feed
    return c.json({ ok: true });
  });
  app.post('/tasks/plan', async c => {
    const b = await parseBody(c, planSchema);
    const goal = (b.goal ?? '').trim();
    const name = (b.name ?? '').trim(); // optional short mission name → epic title (goal stays the description)
    if (!goal) return c.json({ error: 'goal required' }, 400);
    // Engaging needs a mission (agents plugin); a pure plan (epic + phases) does not.
    const planFlow = d.planFlow;
    if (b.engage === true && !planFlow) return c.json({ error: 'agents plugin is disabled' }, 503);
    if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);
    if (b.exec && !execAllowedForUser(c, b.exec)) return c.json({ error: 'exec not allowed for user' }, 403);
    // Pilot/overseer overrides are agents vocabulary — the plugin validates them (global + per-user
    // allow-lists). Without the plugin they are inert: no pilot or overseer will ever run them.
    const overrideErr = planFlow?.execOverrideError([b.pilotExec, b.overseerExec], c.get('user')?.id ?? null);
    if (overrideErr) return c.json({ error: overrideErr.error }, overrideErr.status);
    const target = resolveTarget(c, b.project_id);
    if ('error' in target) return c.json({ error: target.error }, target.status);
    // PR mode (incl. the >1-sessions auto-opt-in) and worktree isolation are the plugin's call; a
    // plugin-less plan is a plain epic with no PR override and no isolation guidance.
    const { prEnabled, isolated } = planFlow?.planPrMode(b.prEnabled ?? null, b.maxSessions ?? 1, target.project.id) ?? { prEnabled: null, isolated: false };

    // Manual mode: explicit phases → synchronous create (no LLM, no key). Keeps the 201 contract.
    if (Array.isArray(b.phases) && b.phases.length > 0) {
      const phases: Phase[] = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task' })).filter((p) => p.title);
      if (phases.length === 0) return c.json({ error: 'phases required' }, 400);
      if (b.dryRun === true) return c.json({ phases }); // playground preview, nothing persisted
      const job = planJobs.create({ goal, name, projectId: target.project.id, epicId: null, dryRun: false, exec: b.exec, pilotExec: b.pilotExec, overseerExec: b.overseerExec, prEnabled, engage: b.engage === true ? { autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1 } : undefined, createdBy: c.get('user')?.id ?? null });
      job.phases = phases;
      const { epic, phases: created } = persistPlan(job);
      job.epicId = epic.id;
      planJobs.setPhases(job.id, phases);
      const mission = await planFlow?.planEngage(job, epic.id);
      return c.json({ epic, phases: created.map((t) => tasksOf(d).get(t.id)), mission }, 201);
    }

    // Autopilot mode: always async via a plan job — one path for the relay and the agent backends.
    const cfg = d.config.get();
    const job = planJobs.create({
      goal, name, projectId: target.project.id, epicId: null, dryRun: b.dryRun === true,
      // Auto mode lets the planner pick a model per phase, so no uniform exec rides along.
      exec: b.autoModel ? undefined : b.exec, autoModel: b.autoModel === true,
      pilotExec: b.pilotExec, overseerExec: b.overseerExec,
      engage: b.engage === true ? { autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1 } : undefined,
      prEnabled, maxSessions: b.maxSessions ?? 1, createdBy: c.get('user')?.id ?? null,
    });
    d.bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
    const pilot = planFlow?.pilotBackend(b.pilotExec) ?? null;
    if (pilot) {
      // Agent backend: spawn the Pilot in the repo; it submits via `elowen plan submit`.
      void pilot(job, target.project.path).catch((e) => { planJobs.fail(job.id, String(e)); d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); reapPilotSession(job); });
      return c.json({ jobId: job.id }, 202);
    }
    // Relay backend: decompose inline and resolve the job before responding.
    const relay = d.config.autopilotRelay();
    if (!relay) return c.json({ error: 'autopilot_key_missing' }, 400);
    const inf = (d.makeInference ?? ((rc) => new RelayClient(rc)))({ baseUrl: relay.baseUrl, apiKey: relay.apiKey, model: cfg.autopilot.model });
    let phases: Phase[];
    try {
      const notes = d.projects?.get(target.project.id)?.notes;
      const models = job.autoModel ? modelsBlock(cfg.allowedExecs, cfg.modelNotes) : undefined;
      // Same parallelism guidance the agent-mode Pilot gets: parallel branches only when >1 session
      // AND the mission will run PR-native (isolated worktrees) — `isolated` resolved by the plugin above.
      const parallelism = parallelismBlock(b.maxSessions ?? 1, isolated);
      // The triggering user's own `planner` override wins over the global admin template (an explicit
      // request-body prompt still takes precedence over both — playground/manual overrides).
      const userPlanner = c.get('user')?.id != null ? d.userPrompts?.get(c.get('user')!.id, 'planner') ?? null : null;
      phases = await decompose(inf, goal, b.prompt ?? userPlanner ?? cfg.autopilot.prompt, { notes }, models, parallelism);
    } catch {
      planJobs.fail(job.id, 'plan_parse_failed');
      d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: 'plan_parse_failed' });
      return c.json({ jobId: job.id, error: 'plan_parse_failed' }, 502);
    }
    await finalizePlanJob(job.id, phases);
    return c.json({ jobId: job.id, epicId: planJobs.get(job.id)?.epicId ?? null }, 202);
  });

  app.get('/plan/:jobId', (c) => {
    const job = planJobs.get(c.req.param('jobId'));
    if (!job) return c.json({ error: 'not found' }, 404);
    // The Pilot (agent scope) is handed exactly this job's unguessable id and may have no in_progress
    // task yet (it runs during initial planning), so the working-set check doesn't apply — the job id
    // is the capability. Interactive users still go through the project access gate.
    if (c.get('tokenScope') !== 'agent' && !canAccessProject(c, job.projectId)) return c.json({ error: 'forbidden' }, 403);
    return c.json(job);
  });

  app.post('/plan/:jobId/submit', async (c) => {
    const job = planJobs.get(c.req.param('jobId'));
    if (!job) return c.json({ error: 'not found' }, 404);
    if (c.get('tokenScope') !== 'agent' && !canAccessProject(c, job.projectId)) return c.json({ error: 'forbidden' }, 403);
    // Idempotency guard: a terminal job lingers ~10 min (TERMINAL_TTL_MS). Without this, a retried submit
    // (pilot re-send / curl retry on timeout) re-runs persistPlan on the already-planned epic — appending
    // the whole phase set a second time and re-engaging the mission — and a submit on a `failed` job would
    // silently resurrect it. Only a job still `planning` may be submitted.
    if (job.status !== 'planning') return c.json({ error: `plan job already ${job.status}` }, 409);
    const body = await c.req.json().catch(() => ({})) as { phases?: unknown };
    let phases: Phase[];
    try { phases = parsePhases(JSON.stringify(body.phases ?? [])); } // reuse the relay validator (DRY)
    catch { return c.json({ error: 'invalid phases' }, 400); }
    await finalizePlanJob(job.id, phases);
    return c.json(planJobs.get(job.id));
  });


  // Insert phases into an existing epic — a manual list of phases, or `goal` to replan
  // (decompose a residual goal). New phases run AFTER the epic's current chain; an active
  // mission picks up the freshly-ready phase on the next tick (triggered immediately here).
  app.post('/tasks/:epicId/phases', async c => {
    const epicId = c.req.param('epicId');
    const epic = tasksOf(d).get(epicId);
    if (!epic || epic.type !== 'epic') return c.json({ error: 'epic not found' }, 404);
    if (!canAccessProject(c, epic.project_id)) return c.json({ error: 'forbidden' }, 403);
    const b = await parseBody(c, insertPhasesSchema);
    if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);
    if (b.exec && !execAllowedForUser(c, b.exec)) return c.json({ error: 'exec not allowed for user' }, 403);

    // Manual insert: explicit phases, no LLM, no key. persistPlan appends after the epic's tail.
    if (Array.isArray(b.phases) && b.phases.length > 0) {
      const phases: Phase[] = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task', details: (p.details ?? '').trim() || undefined })).filter((p) => p.title);
      if (phases.length === 0) return c.json({ error: 'phases required' }, 400);
      const job = planJobs.create({ goal: epic.description?.trim() || epic.title, projectId: epic.project_id, epicId, dryRun: false, exec: b.exec, createdBy: epic.created_by ?? c.get('user')?.id ?? null });
      job.phases = phases;
      const { phases: created } = persistPlan(job);
      await d.planFlow?.planEngage(job, epicId); // tick an active mission so it picks up the new ready phase
      return c.json({ epic, phases: created.map((t) => tasksOf(d).get(t.id)) }, 201);
    }
    if (!(b.goal ?? '').trim()) return c.json({ error: 'phases or goal required' }, 400);

    // Replan: decompose the residual goal — async via a plan job scoped to this epic (so an agent
    // Pilot can do it; finalizePlanJob appends + ticks an active mission). One path, relay or agent.
    const cfg = d.config.get();
    // The agents context a replan inherits (the epic's frozen PR override, isolation, the mission's
    // session width and per-mission execs) is the plugin's call — carried into the job so the
    // parallelism guidance matches how the replanned phases will actually run. Plugin-less default:
    // a linear, non-isolated replan.
    const rc = d.planFlow?.replanContext(epicId) ?? { prEnabled: null, isolated: false, maxSessions: 1 };
    const replanParallelism = parallelismBlock(rc.maxSessions, rc.isolated);
    const job = planJobs.create({ goal: b.goal!.trim(), projectId: epic.project_id, epicId, dryRun: false, exec: b.exec, pilotExec: rc.pilotExec, overseerExec: rc.overseerExec, prEnabled: rc.prEnabled, maxSessions: rc.maxSessions, createdBy: epic.created_by ?? c.get('user')?.id ?? null });
    d.bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
    const replanPilot = d.planFlow?.pilotBackend(job.pilotExec) ?? null;
    if (replanPilot) {
      void replanPilot(job, pathFor(epic.project_id)).catch((e) => { planJobs.fail(job.id, String(e)); d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); });
      return c.json({ jobId: job.id, epicId }, 202);
    }
    const relay = d.config.autopilotRelay();
    if (!relay) return c.json({ error: 'autopilot_key_missing' }, 400);
    const inf = (d.makeInference ?? ((rc) => new RelayClient(rc)))({ baseUrl: relay.baseUrl, apiKey: relay.apiKey, model: cfg.autopilot.model });
    let phases: Phase[];
    // Preserve the epic owner's planner override across a replan; the current user is the fallback.
    const replanUserId = epic.created_by ?? c.get('user')?.id ?? null;
    const replanUserPlanner = replanUserId != null ? d.userPrompts?.get(replanUserId, 'planner') ?? null : null;
    try { phases = await decompose(inf, b.goal!.trim(), b.prompt ?? replanUserPlanner ?? cfg.autopilot.prompt, { notes: d.projects?.get(epic.project_id)?.notes }, undefined, replanParallelism); }
    catch {
      planJobs.fail(job.id, 'plan_parse_failed');
      d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: 'plan_parse_failed' });
      return c.json({ jobId: job.id, error: 'plan_parse_failed' }, 502);
    }
    await finalizePlanJob(job.id, phases);
    return c.json({ jobId: job.id, epicId }, 202);
  });
}
