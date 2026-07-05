import { basename } from 'node:path';
import { shapeBrainMessages } from '../../brain/messageView.js';
import { readTaskUsage } from '../../integrations/usage/index.js';
import { projectRangeFileDiff, projectRangeLog, projectCommitFileDiff } from '../../integrations/projectFiles.js';
import { decompose, parsePhases, modelsBlock, parallelismBlock, VALID_TYPES as VALID_PHASE_TYPES, type Phase } from '../../overseer/planner.js';
import { resolvePrEnabled } from '../../overseer/prMode.js';
import { RelayClient } from '../../inference/client.js';
import { shortId } from '../../shared/id.js';
import { parseBody } from '../validation.js';
import { createTaskSchema, patchTaskSchema, planSchema, insertPhasesSchema, askSchema } from '../schemas/tasks.js';
import type { OrcaApp, RouteContext } from '../context.js';

/** Tasks, usage, admin cleanup and the plan/replan endpoints. The post-done review workflow that the
 *  close path drives lives in {@link ReviewService}; planning lives in {@link PlanService}. */
export function registerTaskRoutes(app: OrcaApp, ctx: RouteContext): void {
  const {
    d, log, planJobs,
    canAccessProject, notAdmin, accessibleProjects, execAllowedForUser,
    pathFor, usagePathFor, checkoutPathFor, resolveTarget,
    persistPlan, reapPilotSession, finalizePlanJob, releaseGatedDependents, reviewService, askService, guideService,
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
    const created = d.tasks.create({ id, project_id: target.project.id, title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart, created_by: c.get('user')?.id ?? null });
    if (Array.isArray(b.deps)) d.tasks.setDeps(created.id, b.deps);
    d.bus.publish({ type: 'task', taskId: created.id, status: created.status });
    return c.json(created, 201);
  });
  app.get('/tasks/ready', c => c.json(d.readiness.ready(d.project.id)));
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
    // Embedded-brain (orca:) runs have no on-disk CLI transcript for the live reader — fall back to the
    // snapshot the BrainWorkerService recorded at close (this is where provider-reported cost lives).
    return c.json(live ?? d.taskUsage?.get(task.id) ?? null);
  });
  // Total token/cost usage aggregated per model (exec spec). Read straight from the `task_usage`
  // snapshots (the UsageRecorder writes one per task as it settles), so this never re-scans the CLIs'
  // session stores. Scoped to the caller's accessible projects; optional `?project_id=N` narrows it.
  app.get('/usage/by-model', c => {
    const allowed = accessibleProjects(c); // Set of project ids, or null for an admin (all projects)
    let projectIds: number[] | undefined = allowed ? [...allowed] : undefined;
    const pidRaw = c.req.query('project_id');
    if (pidRaw !== undefined && pidRaw !== '') {
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
    return c.json(d.taskUsage?.aggregateByExec(projectIds, window) ?? []);
  });
  // Daily spend/token totals over the last N days (default 7) for the dashboard's spend sparkline.
  // Same project scoping as /usage/by-model; only days with settled tasks come back, so the client
  // pads the missing days with zero. `?days=` is clamped to a sane 1..90 window.
  app.get('/usage/by-day', c => {
    const allowed = accessibleProjects(c);
    let projectIds: number[] | undefined = allowed ? [...allowed] : undefined;
    const pidRaw = c.req.query('project_id');
    if (pidRaw !== undefined && pidRaw !== '') {
      const pid = Number(pidRaw);
      if (Number.isFinite(pid)) projectIds = projectIds ? projectIds.filter((p) => p === pid) : [pid];
    }
    const daysRaw = Number(c.req.query('days'));
    const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, Math.floor(daysRaw))) : 7;
    return c.json(d.taskUsage?.aggregateByDay(projectIds, days) ?? []);
  });
  // Reset the usage stats: wipe the `task_usage` snapshots. Admin-only and irreversible, but it only
  // clears Orca's own DB rows — the agents' CLI session transcripts are left untouched.
  app.post('/usage/reset', c => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json({ ok: true, cleared: d.taskUsage?.deleteAll() ?? 0 });
  });
  // The transcript of an embedded-brain (orca:) worker run — the task detail's conversation tab.
  // CLI-run tasks have no brain session, so this returns an empty list for them.
  app.get('/tasks/:id/conversation', (c) => {
    const id = c.req.param('id');
    const task = d.tasks.get(id);
    if (!task) return c.json({ error: 'not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brainStore) return c.json([]);
    return c.json(shapeBrainMessages(d.brainStore.getMessages(`brain-task-${id}`)));
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
    if (b.status) {
      if (b.status === 'closed') d.tasks.close(id, { summary: b.result_summary, outcome: b.outcome });
      else d.tasks.setStatus(id, b.status);
      d.bus.publish({ type: 'task', taskId: id, status: b.status });
      // Drive the post-done overseer review gate (mission phases) or snapshot a standalone task's
      // change list. Only on close; the status flip + SSE publish already happened above.
      if (b.status === 'closed') await reviewService.onTaskClosed(id, existing, { outcome: b.outcome, summary: b.result_summary });
    }
    if (typeof b.exec === 'string') {
      // Gate the executor exactly like the plan/session routes: an unvalidated exec is stored as an
      // `exec:<spec>` label and later interpolated into the agent launch command, so without this check
      // a project member could set an arbitrary executor (escaping the allow-list) or smuggle shell
      // metacharacters through the model field. Empty string clears the override (revert to fallback).
      if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);
      if (b.exec && !execAllowedForUser(c, b.exec)) return c.json({ error: 'exec not allowed for user' }, 403);
      d.tasks.setExec(id, b.exec);
    }
    if (typeof b.title === 'string' || typeof b.type === 'string' || typeof b.priority === 'string' || typeof b.description === 'string' || b.scheduled_at !== undefined || b.autostart !== undefined) {
      d.tasks.update(id, { title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart });
    }
    if (Array.isArray(b.deps)) d.tasks.setDeps(id, b.deps);
    // Single-edge add (the drag-onto-card "add dependency" gesture): atomic, unlike a client-side
    // fetch-current-deps-then-PATCH-the-whole-array round trip, which races against a concurrent
    // editor of the same task's deps. setDeps stays the bulk-replace path (the deps modal).
    if (typeof b.addDep === 'string') d.tasks.addDep(id, b.addDep);
    if (typeof b.parent_id === 'string') {
      // Drag-a-card-onto-another-card "make subtask" gesture. reparent() promotes the target to an
      // epic if needed; if its mission is already live, tick it so the new phase is picked up now
      // instead of waiting for the next scheduled tick — same pattern as insert-phases below.
      const result = d.tasks.reparent(id, b.parent_id);
      if ('error' in result) return c.json({ error: result.error }, 400);
      const missionId = `m-${b.parent_id}`;
      if (d.engine?.isActive(missionId)) await d.engine.tick(missionId);
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
    if (existing.parent_id) void d.engine.resumeStalled(`m-${existing.parent_id}`).catch((e) => log.error('approve-gate resume failed', e));
    return c.json({ released });
  });

  // `orca ask`: a running worker posts a free-text question for the autopilot and blocks on the reply.
  // Authenticated by the spawn-time token; gated by the task's project. The reply is produced async
  // (overseer → human window → sentinel) so this returns an ask id the worker then long-polls below.
  app.post('/tasks/:id/ask', async c => {
    const id = c.req.param('id');
    const task = d.tasks.get(id);
    if (!task) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    // Bound the per-task conversation so a prompt-injected worker in a loop can't inflate the events
    // table — the same guard the notes route applies (both sides of the thread count). Size is capped
    // by askSchema.text.max(); this caps the turn count.
    const MAX_ASK_TURNS = 200;
    if ((d.events?.list({ target: id, type: 'message' }) ?? []).length >= MAX_ASK_TURNS) return c.json({ error: 'too many questions on this task' }, 429);
    const b = await parseBody(c, askSchema);
    return c.json(askService.start(id, b.text));
  });
  // Long-poll an ask's reply: returns `{ text }` once the autopilot/human answers (or the sentinel
  // fires), else `{}` every ~25s so the worker's CLI re-polls. The ask id must belong to this task.
  app.get('/tasks/:id/ask/:askId', async c => {
    const id = c.req.param('id');
    const task = d.tasks.get(id);
    if (!task) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    if (askService.taskFor(c.req.param('askId')) !== id) return c.json({ error: 'no such ask' }, 404);
    const raw = Number(c.req.query('timeoutMs'));
    const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30_000) : undefined;
    const text = await askService.poll(c.req.param('askId'), timeoutMs);
    return c.json(text === null ? {} : { text });
  });
  // Human reply to an agent's open question (the fast-follow UI box / a curl). Resolves the same
  // pending exchange the worker is polling; only valid while the human window is open.
  app.post('/tasks/:id/ask/:askId/reply', async c => {
    const id = c.req.param('id');
    const task = d.tasks.get(id);
    if (!task) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    if (askService.taskFor(c.req.param('askId')) !== id) return c.json({ error: 'no such ask' }, 404);
    const b = await parseBody(c, askSchema);
    return askService.reply(c.req.param('askId'), b.text) ? c.json({ ok: true }) : c.json({ error: 'ask already answered' }, 409);
  });
  // Every `orca ask` currently parked on a human (overseer escalated / no overseer), for the Escalations
  // inbox — enriched with the task title + epic, scoped to the projects the caller may see. Not in the
  // agent allow-list: this is a human surface, so a worker token never reaches it.
  app.get('/asks/pending', c => {
    const items = askService.pending()
      .map((a) => { const task = d.tasks.get(a.taskId); return task ? { ...a, title: task.title, epicId: task.parent_id, projectId: task.project_id } : null; })
      .filter((a): a is NonNullable<typeof a> => a !== null && canAccessProject(c, a.projectId));
    return c.json(items);
  });

  // `orca help` (with ORCA_TASK set): a running agent fetches its context-aware control guide — how to
  // work, ask the autopilot, leave handoff notes and close out (plus the epic, for a mission phase). The
  // guide is rendered from the task's live state, so the spawn preamble stays short. In the agent
  // allow-list (a worker token may reach it); still gated by the task's project.
  app.get('/tasks/:id/guide', c => {
    const id = c.req.param('id');
    const task = d.tasks.get(id);
    if (!task) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    const text = guideService.render(id);
    if (text === null) return c.json({ error: 'task not found' }, 404);
    // Lightweight observability: surfaces whether agents actually pull the guide (vs skipping it), so a
    // "the agent never ran `orca help`" reliability gap is visible in the daemon log.
    log.info(`guide fetched for ${id}${c.get('tokenScope') === 'agent' ? ' (agent)' : ''}`);
    return c.json({ text });
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
    // `?subtree=1` removes a whole mission: disengage it (stops its agents), then delete the epic,
    // every child task, their dependency edges and the mission row — not just the single task.
    if (c.req.query('subtree')) {
      // Mission id is `m-<epicId>` by construction. Stop a still-running mission (kills its agents),
      // then free its worktree UNCONDITIONALLY: a naturally-completed ('disengaged') or paused mission
      // keeps its worktree for the PR/feedback path, so disengage() alone would skip it and leak the
      // on-disk worktree when the epic is deleted (the mission_pr row is also pruned by the cascade).
      const missionId = `m-${id}`;
      const mission = d.missions.get(missionId);
      if (mission && mission.state !== 'disengaged') await d.engine.disengage(missionId).catch(() => { /* best-effort */ });
      await d.missionGit?.cleanup(missionId).catch(() => { /* best-effort */ });
      const removed = d.tasks.deleteEpic(id);
      d.bus.publish({ type: 'task', taskId: id, status: 'cancelled' });
      d.events?.deleteForTarget(id);
      d.notes?.deleteAllForTarget(id); // a removed mission leaves no orphan handoff notes under any scope
      return c.json({ ok: true, tasks: removed.tasks });
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
    // orca- sessions (manual launches / zombies) so no agent keeps running against deleted tasks.
    for (const m of d.missions.live()) await d.engine.disengage(m.id).catch(() => { /* best-effort */ });
    for (const s of (await d.tmux.list()).filter((s) => s.startsWith('orca-'))) {
      await d.tmux.kill(s).catch(() => { /* already gone */ });
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
    if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);
    if (b.exec && !execAllowedForUser(c, b.exec)) return c.json({ error: 'exec not allowed for user' }, 403);
    const target = resolveTarget(c, b.project_id);
    if ('error' in target) return c.json({ error: target.error }, target.status);

    // Manual mode: explicit phases → synchronous create (no LLM, no key). Keeps the 201 contract.
    if (Array.isArray(b.phases) && b.phases.length > 0) {
      const phases: Phase[] = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task' })).filter((p) => p.title);
      if (phases.length === 0) return c.json({ error: 'phases required' }, 400);
      if (b.dryRun === true) return c.json({ phases }); // playground preview, nothing persisted
      const job = planJobs.create({ goal, name, projectId: target.project.id, epicId: null, dryRun: false, exec: b.exec, prEnabled, createdBy: c.get('user')?.id ?? null });
      job.phases = phases;
      const { epic, phases: created } = persistPlan(job);
      job.epicId = epic.id;
      planJobs.setPhases(job.id, phases);
      let mission;
      if (b.engage === true) mission = await d.engine.engage({ epicId: epic.id, autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1, createdBy: c.get('user')?.id ?? null });
      return c.json({ epic, phases: created.map((t) => d.tasks.get(t.id)), mission }, 201);
    }

    // Autopilot mode: always async via a plan job — one path for the relay and the agent backends.
    const cfg = d.config.get();
    const job = planJobs.create({
      goal, name, projectId: target.project.id, epicId: null, dryRun: b.dryRun === true,
      // Auto mode lets the planner pick a model per phase, so no uniform exec rides along.
      exec: b.autoModel ? undefined : b.exec, autoModel: b.autoModel === true,
      engage: b.engage === true ? { autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1 } : undefined,
      prEnabled, maxSessions: b.maxSessions ?? 1, createdBy: c.get('user')?.id ?? null,
    });
    d.bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
    if (cfg.autopilot.pilotExec && d.pilot) {
      // Agent backend: spawn the Pilot in the repo; it submits via `orca plan submit`.
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
      if (d.engine?.isActive(missionId)) await d.engine.tick(missionId); // pick up the new ready phase
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
    const job = planJobs.create({ goal: b.goal!.trim(), projectId: epic.project_id, epicId, dryRun: false, exec: b.exec, prEnabled: replanOverride, maxSessions: replanMaxSessions, createdBy: epic.created_by ?? c.get('user')?.id ?? null });
    d.bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
    if (cfg.autopilot.pilotExec && d.pilot) {
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
