import { basename } from 'node:path';
import { shapeBrainMessages } from '../../brain/messageView.js';
import { taskSessionId } from '../../brain/sessionId.js';
import { readTaskUsage } from '../../integrations/usage/index.js';
import { projectRangeFileDiff, projectRangeLog, projectCommitFileDiff } from '../../integrations/projectFiles.js';
import { decompose, parsePhases, modelsBlock, parallelismBlock, VALID_TYPES as VALID_PHASE_TYPES, type Phase } from '../services/planner.js';
import { resolvePrEnabled } from '../../shared/prMode.js';
import { RelayClient } from '../../inference/client.js';
import { shortId } from '../../shared/id.js';
import { parseBody, queryInt } from '../validation.js';
import { createTaskSchema, patchTaskSchema, planSchema, insertPhasesSchema } from '../schemas/tasks.js';
import type { ElowenApp, RouteContext } from '../context.js';
import type { TokenUsage, CostSource } from '../../integrations/usage/types.js';

/** Fold a task-worker exec bucket and the same model's brain-chat bucket into one, for /usage/by-model.
 *  Token fields add; cost preserves null (a bucket with NO cost stays "—", never a fake $0) and its
 *  provenance rolls up exactly like TaskUsageStore.aggregateByExec: unavailable when neither side is
 *  costed, provider_reported only when EVERY costed side is provider-reported, else calculated (any
 *  estimate taints the sum). */
function mergeModelUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const costUsd = a.costUsd == null && b.costUsd == null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  const costed = [a, b].filter((u) => u.costUsd != null);
  const costSource: CostSource = costUsd == null
    ? 'unavailable'
    : costed.every((u) => u.costSource === 'provider_reported') ? 'provider_reported' : 'calculated';
  // Speed merges as a duration-weighted average over the sides that MEASURED one (task-worker buckets
  // carry none): a side's generation seconds are its MEASURED output over its rate — weighting by total
  // `output` would credit a side for untimed history it never timed. The merged pair goes back on the
  // wire so the next consumer up (Stats page, CLI Σ row) can weight the same way.
  const measured = (u: TokenUsage): { output: number; seconds: number } => {
    const tps = u.outputTps;
    const output = u.measuredOutput ?? 0;
    return tps != null && tps > 0 && output > 0 ? { output, seconds: output / tps } : { output: 0, seconds: 0 };
  };
  const mA = measured(a); const mB = measured(b);
  const measuredOutput = mA.output + mB.output;
  const measuredSeconds = mA.seconds + mB.seconds;
  return {
    input: a.input + b.input, output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total, reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
    costUsd, currency: a.currency ?? b.currency ?? (costUsd != null ? 'USD' : null), costSource,
    measuredOutput, outputTps: measuredSeconds > 0 ? measuredOutput / measuredSeconds : null,
  };
}

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

/** Tasks, usage, admin cleanup and the plan/replan endpoints. The post-done review workflow that the
 *  close path drives lives in {@link ReviewService}; planning lives in {@link PlanService}. */
export function registerTaskRoutes(app: ElowenApp, ctx: RouteContext): void {
  const {
    d, log, planJobs,
    canAccessProject, notAdmin, accessibleProjects, execAllowedForUser,
    pathFor, usagePathFor, checkoutPathFor, resolveTarget,
    persistPlan, reapPilotSession, finalizePlanJob, releaseGatedDependents, reviewService,
  } = ctx;
  app.get('/tasks', c => {
    const allowed = accessibleProjects(c);
    const all = d.tasks.list();
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
    const created = d.tasks.transaction(() => {
      const task = d.tasks.create({ id, project_id: target.project.id, title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart, created_by: c.get('user')?.id ?? null });
      if (Array.isArray(b.deps)) d.tasks.setDeps(task.id, b.deps);
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
    return c.json(d.readiness.ready(pid));
  });
  app.get('/tasks/deps', c => {
    const allowed = accessibleProjects(c);
    const deps = d.tasks.allDeps();
    if (!allowed) return c.json(deps); // admin / open mode → unrestricted
    // Non-admin: keep only edges whose task belongs to a project the caller can access.
    const visible = new Set(d.tasks.list().filter(t => allowed.has(t.project_id)).map(t => t.id));
    return c.json(deps.filter(e => visible.has(e.task_id)));
  });
  // Token/cost usage for a task's agent run, read from the executor CLI's local session storage
  // (opencode / claude / codex) — portable, no relay. Null usage → no matching session found.
  app.get('/tasks/:id/usage', c => {
    const task = d.tasks.get(c.req.param('id'));
    if (!task) return c.json({ error: 'not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    // Pass the task's own project siblings so usage can disambiguate concurrent agents by start-order
    // rank, and read sessions from that project's path (not the daemon home, under multi-project).
    const live = readTaskUsage(task, d.tasks.list({ project_id: task.project_id }), usagePathFor(task), d.fallback);
    // Embedded-brain (elowen:) runs have no on-disk CLI transcript for the live reader — fall back to the
    // snapshot the BrainWorkerService recorded at close (this is where provider-reported cost lives).
    return c.json(live ?? d.taskUsage?.get(task.id) ?? null);
  });
  // Total token/cost usage aggregated per model (exec spec). Read straight from the `task_usage`
  // snapshots (the UsageRecorder writes one per task as it settles), so this never re-scans the CLIs'
  // session stores. Scoped to the caller's accessible projects; optional `?project_id=N` narrows it.
  // Task-worker usage is merged with the caller's OWN brain CHAT-session usage (CLI/web chat) per model —
  // exactly like /usage/by-day merges the daily totals — so paid chat spend is no longer invisible on the
  // Stats page. Brain usage is per-user with no project, so it only joins the unscoped view (a
  // `project_id` filter keeps the old tasks-only semantics).
  app.get('/usage/by-model', c => {
    const allowed = accessibleProjects(c); // Set of project ids, or null for an admin (all projects)
    let projectIds: number[] | undefined = allowed ? [...allowed] : undefined;
    const pidRaw = c.req.query('project_id');
    const projectScoped = pidRaw !== undefined && pidRaw !== '';
    if (projectScoped) {
      const pid = Number(pidRaw);
      if (Number.isFinite(pid)) projectIds = projectIds ? projectIds.filter((p) => p === pid) : [pid];
    }
    // Optional ?from=&to= ISO-8601 window narrowing task_usage.captured_at (the dashboard's fixed
    // "this month" widget and the Stats page's date filter both go through this same param). Malformed
    // values are silently ignored — same benevolent posture as project_id above (no 400s).
    const fromRaw = c.req.query('from');
    const toRaw = c.req.query('to');
    const fromIso = fromRaw && !Number.isNaN(Date.parse(fromRaw)) ? fromRaw : undefined;
    const toIso = toRaw && !Number.isNaN(Date.parse(toRaw)) ? toRaw : undefined;
    const window = fromIso || toIso ? { fromIso, toIso } : undefined;
    const rows = d.taskUsage?.aggregateByExec(projectIds, window) ?? [];
    const userId = c.get('user')?.id;
    const brain = !projectScoped && userId != null ? d.brainStore?.usageByModel(userId, window) ?? [] : [];
    if (brain.length === 0) return c.json(rows);
    const byExec = new Map(rows.map((r) => [r.exec, { exec: r.exec, usage: r.usage }]));
    for (const r of brain) {
      const cur = byExec.get(r.exec);
      if (!cur) byExec.set(r.exec, { exec: r.exec, usage: r.usage });
      else cur.usage = mergeModelUsage(cur.usage, r.usage);
    }
    return c.json([...byExec.values()]);
  });
  // Daily spend/token totals over the last N days (default 7) for the dashboard's spend sparkline.
  // Same project scoping as /usage/by-model; only days with settled tasks come back, so the client
  // pads the missing days with zero. `?days=` is clamped to a sane 1..90 window. Task-worker usage is
  // merged with the caller's OWN brain-session usage (CLI/web chat) — chat on a paid model is real
  // spend and used to be invisible here. Brain usage is per-user, so it only joins the unscoped view
  // (a `project_id` filter keeps the old tasks-only semantics: chat spend has no project).
  app.get('/usage/by-day', c => {
    const allowed = accessibleProjects(c);
    let projectIds: number[] | undefined = allowed ? [...allowed] : undefined;
    const pidRaw = c.req.query('project_id');
    const projectScoped = pidRaw !== undefined && pidRaw !== '';
    if (projectScoped) {
      const pid = Number(pidRaw);
      if (Number.isFinite(pid)) projectIds = projectIds ? projectIds.filter((p) => p === pid) : [pid];
    }
    const days = queryInt(c.req.query('days'), { min: 1, max: 90, fallback: 7 });
    const tasks = d.taskUsage?.aggregateByDay(projectIds, days) ?? [];
    const userId = c.get('user')?.id;
    const brain = !projectScoped && userId != null ? d.brainStore?.usageByDay(userId, days) ?? [] : [];
    if (brain.length === 0) return c.json(tasks);
    const byDay = new Map(tasks.map((r) => [r.day, { ...r }]));
    for (const r of brain) {
      const cur = byDay.get(r.day);
      if (!cur) { byDay.set(r.day, { ...r }); continue; }
      cur.tokens += r.tokens;
      cur.cost = cur.cost == null && r.cost == null ? null : (cur.cost ?? 0) + (r.cost ?? 0);
    }
    return c.json([...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)));
  });
  // Reset the usage stats the page actually charts: the `task_usage` snapshots AND the caller's own chat
  // spend. Admin-only and irreversible. Clearing only the snapshots used to leave every chart standing,
  // because chat spend is read back out of the conversation rows rather than from a snapshot — so on an
  // instance whose spend is mostly chat the button appeared to do nothing at all. Chat spend is cleared
  // by stripping the accounting from those rows; the messages themselves are kept, so conversations stay
  // readable. The agents' CLI session transcripts are still left untouched.
  app.post('/usage/reset', c => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const userId = c.get('user')?.id;
    const cleared = d.taskUsage?.deleteAll() ?? 0;
    const chat = userId != null ? d.brainStore?.clearUsage(userId) ?? 0 : 0;
    return c.json({ ok: true, cleared, chatCleared: chat });
  });
  // The transcript of an embedded-brain (elowen:) worker run — the task detail's conversation tab.
  // CLI-run tasks have no brain session, so this returns an empty list for them.
  app.get('/tasks/:id/conversation', (c) => {
    const id = c.req.param('id');
    const task = d.tasks.get(id);
    if (!task) return c.json({ error: 'not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brainStore) return c.json([]);
    const sessionId = taskSessionId(id);
    return c.json(shapeBrainMessages(d.brainStore.getMessages(sessionId), d.brainStore.getSubagentRuns(sessionId)));
  });

  app.patch('/tasks/:id', async c => {
    const b = await parseBody(c, patchTaskSchema);
    const id = c.req.param('id');
    const existing = d.tasks.get(id);
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
      d.tasks.transaction(() => {
        if (b.status) {
          if (b.status === 'closed') d.tasks.close(id, { summary: b.result_summary, outcome: b.outcome });
          else d.tasks.setStatus(id, b.status);
        }
        if (typeof b.exec === 'string') d.tasks.setExec(id, b.exec);
        if (typeof b.title === 'string' || typeof b.type === 'string' || typeof b.priority === 'string' || typeof b.description === 'string' || b.scheduled_at !== undefined || b.autostart !== undefined) {
          d.tasks.update(id, { title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart });
        }
        if (Array.isArray(b.deps)) d.tasks.setDeps(id, b.deps);
        // Single-edge add (the drag-onto-card "add dependency" gesture): atomic, unlike a client-side
        // fetch-current-deps-then-PATCH-the-whole-array round trip, which races against a concurrent
        // editor of the same task's deps. setDeps stays the bulk-replace path (the deps modal). Unlike
        // that bulk path, this is one deliberate action, so a rejected edge (missing endpoint, cross-
        // project) surfaces as a 400 instead of silently vanishing.
        if (typeof b.addDep === 'string' && !d.tasks.addDep(id, b.addDep)) throw new PatchRejected('invalid dependency');
        // Drag-a-card-onto-another-card "make subtask" gesture. reparent() promotes the target to an
        // epic if needed.
        if (typeof b.parent_id === 'string') {
          const result = d.tasks.reparent(id, b.parent_id);
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
      // Drive the post-done overseer review gate (mission phases) or snapshot a standalone task's
      // change list. Only on close.
      if (b.status === 'closed') await reviewService.onTaskClosed(id, existing, { outcome: b.outcome, summary: b.result_summary });
    }
    // If the new parent's mission is already live, tick it so the new phase is picked up now instead
    // of waiting for the next scheduled tick — same pattern as insert-phases below.
    if (typeof b.parent_id === 'string') {
      const missionId = `m-${b.parent_id}`;
      const engine = d.engine;
      if (engine?.isActive(missionId)) await engine.tick(missionId);
    }
    return c.json(d.tasks.get(id));
  });
  // Diff of one file from a task's FROZEN change list (the commits it landed between base..head). Read
  // from the mission worktree while it's live, else the project checkout (where the commits merged to).
  // Empty when the task has no snapshot, the file isn't in it, or the refs were GC'd by a later squash.
  app.get('/tasks/:id/changed/diff', async c => {
    const id = c.req.param('id');
    const task = d.tasks.get(id);
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
    const task = d.tasks.get(id);
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
    const task = d.tasks.get(id);
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
  // Human approval of an escalated phase: accept its result and release the review gate it holds,
  // re-opening only the dependents no OTHER predecessor still gates (mirrors the agent-approved
  // verdict). The escalations inbox calls this instead of blindly opening every blocked dependent.
  app.post('/tasks/:id/approve-gate', c => {
    const id = c.req.param('id');
    const existing = d.tasks.get(id);
    if (!existing) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, existing.project_id)) return c.json({ error: 'forbidden' }, 403);
    const released = releaseGatedDependents(id);
    // The escalation froze the whole mission (state 'stalled'); approving here is the human action that
    // un-freezes it. Resume so the released dependents spawn now instead of the mission sitting idle —
    // a stalled mission no longer ticks itself, so without this the approval would release the gate but
    // nothing would ever pick the work up. The phase's parent IS the epic; mission id is `m-<epicId>`.
    if (existing.parent_id) void d.engine?.resumeStalled(`m-${existing.parent_id}`).catch((e) => log.error('approve-gate resume failed', e));
    return c.json({ released });
  });

  app.get('/tasks/:id/deps', c => {
    const task = d.tasks.get(c.req.param('id'));
    if (!task) return c.json({ error: 'not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    return c.json(d.tasks.depsFor(c.req.param('id')));
  });
  app.delete('/tasks/:id', async c => {
    const id = c.req.param('id');
    const existing = d.tasks.get(id);
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
      const removed = d.tasks.deleteEpic(id);
      d.bus.publish({ type: 'task', taskId: id, status: 'cancelled' });
      d.events?.deleteForTarget(id);
      d.notes?.deleteAllForTarget(id); // a removed mission leaves no orphan handoff notes under any scope
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
    d.tasks.delete(id);
    d.bus.publish({ type: 'task', taskId: id, status: 'cancelled' }); // live SSE so open UIs drop the row
    d.events?.deleteForTarget(id); // purge its history — a removed task leaves no dead feed
    return c.json({ ok: true });
  });
  // Admin maintenance: wipe ALL operational data — tasks (+deps), missions, the activity feed — and
  // stop every live agent session. Projects, users and config are kept. Irreversible; admin-only.
  app.post('/admin/cleanup', async c => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    // Stop missions cleanly first (kills their agents + drains overseers), then sweep any remaining
    // elowen- sessions (manual launches / zombies) so no agent keeps running against deleted tasks.
    // A teardown that FAILS aborts the wipe: erasing every task and mission row while an agent is
    // still live leaves it editing checkouts with nothing left in the DB to find or stop it by.
    const liveMissions = d.missions.live();
    // Same teardown-first invariant as the epic delete: a live mission with no engine (agents plugin
    // disabled) cannot be stopped, so the wipe must refuse instead of erasing rows under live agents.
    if (liveMissions.length > 0 && !d.engine) return c.json({ error: 'agents plugin is disabled' }, 503);
    try {
      for (const m of liveMissions) await d.engine?.disengage(m.id);
    } catch (e) {
      log.error('cleanup aborted — mission disengage failed', e);
      return c.json({ error: 'mission teardown failed' }, 500);
    }
    const sessions = (await d.tmux.list()).filter((s) => s.startsWith('elowen-'));
    for (const s of sessions) await d.tmux.kill(s).catch(() => { /* verified below */ });
    // A kill fails routinely for a session that exited on its own, so the kill itself proves nothing —
    // re-read the live list and judge by what actually survived. Sessions spawned after the sweep
    // started are not ours to account for, so only the ones we tried to kill are checked.
    const surviving = (await d.tmux.list()).filter((s) => sessions.includes(s));
    if (surviving.length > 0) {
      log.error(`cleanup aborted — agent sessions survived teardown: ${surviving.join(', ')}`);
      return c.json({ error: 'agent teardown failed' }, 500);
    }
    // Free every mission's on-disk worktree (and its mission_pr row) before deleteAll() wipes the DB —
    // the disengage sweep above only reaches 'active'/'stalled' missions, but a paused or naturally-
    // completed one still holds a worktree for the pause/PR-feedback path. cleanup() is a no-op for a
    // mission with no PR record, so calling it for every mission id here is safe.
    try {
      for (const missionId of d.tasks.listMissionIds()) await d.missionGit?.cleanup(missionId);
    } catch (e) {
      log.error('cleanup aborted — worktree cleanup failed', e);
      return c.json({ error: 'mission teardown failed' }, 500);
    }
    const removed = d.tasks.deleteAll();
    const events = d.events?.deleteAll() ?? 0;
    return c.json({ ok: true, tasks: removed.tasks, missions: removed.missions, events });
  });
  app.post('/tasks/plan', async c => {
    const b = await parseBody(c, planSchema);
    const goal = (b.goal ?? '').trim();
    const name = (b.name ?? '').trim(); // optional short mission name → epic title (goal stays the description)
    // Tri-state PR override: true (force on) / false (force off) / null|undefined (inherit project+global).
    let prEnabled = b.prEnabled === true ? true : b.prEnabled === false ? false : null;
    // Parallel sessions only materialise in isolated worktrees — a shared checkout is single-writer, so
    // a >1 max_sessions mission would silently serialize to one agent. Opting into parallelism therefore
    // auto-enables PR-native mode, unless the user explicitly turned it off (then we honour their choice).
    if ((b.maxSessions ?? 1) > 1 && prEnabled === null) prEnabled = true;
    if (!goal) return c.json({ error: 'goal required' }, 400);
    // Engaging needs the mission engine (agents plugin); a pure plan (epic + phases) does not.
    if (b.engage === true && !d.engine) return c.json({ error: 'agents plugin is disabled' }, 503);
    if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);
    if (b.exec && !execAllowedForUser(c, b.exec)) return c.json({ error: 'exec not allowed for user' }, 403);
    for (const override of [b.pilotExec, b.overseerExec]) {
      if (override && !d.config.get().allowedExecs.includes(override)) return c.json({ error: 'exec not allowed' }, 400);
      if (override && !execAllowedForUser(c, override)) return c.json({ error: 'exec not allowed for user' }, 403);
    }
    const target = resolveTarget(c, b.project_id);
    if ('error' in target) return c.json({ error: target.error }, target.status);

    // Manual mode: explicit phases → synchronous create (no LLM, no key). Keeps the 201 contract.
    if (Array.isArray(b.phases) && b.phases.length > 0) {
      const phases: Phase[] = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task' })).filter((p) => p.title);
      if (phases.length === 0) return c.json({ error: 'phases required' }, 400);
      if (b.dryRun === true) return c.json({ phases }); // playground preview, nothing persisted
      const job = planJobs.create({ goal, name, projectId: target.project.id, epicId: null, dryRun: false, exec: b.exec, pilotExec: b.pilotExec, overseerExec: b.overseerExec, prEnabled, createdBy: c.get('user')?.id ?? null });
      job.phases = phases;
      const { epic, phases: created } = persistPlan(job);
      job.epicId = epic.id;
      planJobs.setPhases(job.id, phases);
      let mission;
      const engine = d.engine;
      if (b.engage === true && engine) mission = await engine.engage({ epicId: epic.id, autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1, createdBy: c.get('user')?.id ?? null, pilotExec: b.pilotExec, overseerExec: b.overseerExec });
      return c.json({ epic, phases: created.map((t) => d.tasks.get(t.id)), mission }, 201);
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
    if ((b.pilotExec || cfg.autopilot.pilotExec) && d.pilot) {
      // Agent backend: spawn the Pilot in the repo; it submits via `elowen plan submit`.
      void d.pilot(job, target.project.path).catch((e) => { planJobs.fail(job.id, String(e)); d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); reapPilotSession(job); });
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
      // AND the mission will run PR-native (isolated worktrees), resolved exactly as runtime does.
      const isolated = resolvePrEnabled(prEnabled, d.projects?.get(target.project.id)?.pr_enabled ?? null, cfg.autopilot.prEnabled);
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
    const epic = d.tasks.get(epicId);
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
      const missionId = `m-${epicId}`;
      const engine = d.engine;
      if (engine?.isActive(missionId)) await engine.tick(missionId); // pick up the new ready phase
      return c.json({ epic, phases: created.map((t) => d.tasks.get(t.id)) }, 201);
    }
    if (!(b.goal ?? '').trim()) return c.json({ error: 'phases or goal required' }, 400);

    // Replan: decompose the residual goal — async via a plan job scoped to this epic (so an agent
    // Pilot can do it; finalizePlanJob appends + ticks an active mission). One path, relay or agent.
    const cfg = d.config.get();
    // Carry the mission's intended concurrency into the replan so it keeps planning a wide DAG instead
    // of collapsing back to a linear chain. Resolve isolation from the epic's PR label exactly as the
    // runtime does, so the parallelism guidance matches how the replanned phases will actually run.
    const replanOverride = epic.labels.includes('pr:on') ? true : epic.labels.includes('pr:off') ? false : null;
    const replanIsolated = resolvePrEnabled(replanOverride, d.projects?.get(epic.project_id)?.pr_enabled ?? null, cfg.autopilot.prEnabled);
    const replanMaxSessions = d.missions.get(`m-${epicId}`)?.max_sessions ?? 1;
    const replanParallelism = parallelismBlock(replanMaxSessions, replanIsolated);
    const existingMission = d.missions.get(`m-${epicId}`);
    const job = planJobs.create({ goal: b.goal!.trim(), projectId: epic.project_id, epicId, dryRun: false, exec: b.exec, pilotExec: existingMission?.pilot_exec || undefined, overseerExec: existingMission?.overseer_exec || undefined, prEnabled: replanOverride, maxSessions: replanMaxSessions, createdBy: epic.created_by ?? c.get('user')?.id ?? null });
    d.bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
    if ((job.pilotExec || cfg.autopilot.pilotExec) && d.pilot) {
      void d.pilot(job, pathFor(epic.project_id)).catch((e) => { planJobs.fail(job.id, String(e)); d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); });
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
