import { basename } from 'node:path';
import { shortId } from '../lib/id.js';
import { KeyedMutex } from '../lib/keyedMutex.js';
import { PlanJobStore } from './planJobStore.js';
import { createPlanService } from './planService.js';
import { snapshotTaskChanges } from './taskSnapshot.js';
import { decompose, parsePhases, modelsBlock, parallelismBlock, VALID_TYPES as VALID_PHASE_TYPES, type Phase } from './planner.js';
import { createTaskSchema, patchTaskSchema, planSchema, insertPhasesSchema } from './schemas.js';
import { json, canProject, unknownSubPath, type ApiAuth } from './http.js';
import type { MissionsDomainControl, PluginBrainWorker, PluginContext, TasksDomainControl } from '../../../../src/plugins/api.js';
import type { Project } from '../../../../src/store/projectStore.js';

/** A patch the store refused mid-write (a dangling/cyclic dependency edge, an illegal reparent). It
 *  carries the client-facing reason so the handler can roll the WHOLE patch back and answer 400,
 *  instead of leaving the accepted half of the same request applied. */
class PatchRejected extends Error {}

/** Tasks and the plan/replan endpoints — the HTTP surface of the domain this plugin owns, ROOT-mounted
 *  at the grandfathered paths so every client (web, CLI, spawned agents, the installed service worker)
 *  keeps its URLs. The mission side of a close (the post-done review gate), mission teardown on delete
 *  and the engage half of planning belong to the AGENTS plugin and are resolved through its control:
 *  absent, each answers exactly what it answered with that plugin disabled before the extraction.
 *
 *  The usage aggregates and the admin cleanup that used to sit beside these are core-owned surfaces of
 *  their own (src/api/routes/usage.ts, admin.ts) — they outlive the task domain. */
export function registerTaskApi(ctx: PluginContext, domain: TasksDomainControl, missionState: (missionId: string) => string | null): void {
  const log = ctx.logger;
  const tasks = () => domain.store();
  const readiness = () => domain.readiness();
  // Everything below resolves LIVE on every request: a plugin reload swaps the agents control (and can
  // take it away), and the workspace config is edited in Settings. A captured value would strand a
  // request on a dead generation — the exact failure the core route context was written to avoid.
  const agents = (): MissionsDomainControl | undefined => ctx.control('missions');
  const stores = () => ctx.host.stores();
  const config = () => ctx.host.config();
  const home = (): Project => stores().homeProject();
  // The embedded worker executor is wired by bootstrap AFTER plugins load and never exists in a
  // sub-agent runner — resolve per use and treat "not yet wired" as absent, exactly like the agents
  // plugin does. Absent, the kill paths below fall through to tmux.
  const brainWorkers = (): PluginBrainWorker | undefined => {
    try { return ctx.host.brainWorker(); } catch { return undefined; }
  };

  // Plan jobs and the per-checkout git lock live in the agents runtime when that plugin is loaded — the
  // SAME instances its scheduler and mission engine use, so a phase's commit+snapshot at close cannot
  // interleave with the baseline read at another agent's spawn on the same checkout. Without that plugin
  // the task domain still plans (an epic with phases, no mission), so it keeps its own local pair —
  // exactly what the core route context did.
  const localPlanJobs = new PlanJobStore();
  const planJobs = () => agents()?.planJobs() ?? localPlanJobs;
  const localGitLock = new KeyedMutex();
  const gitLock = () => agents()?.gitLock() ?? localGitLock;

  // Filesystem path of a project. Store-first for EVERY id (the home project included), so this agrees
  // with the scheduler's baseline resolver and a re-homed project path resolves consistently across the
  // spawn baseline and the close-time snapshot.
  const pathFor = (projectId: number): string => stores().projects.get(projectId)?.path ?? home().path;

  // The checkout a mission's work lands in: the isolated PR worktree while it's live, else the shared
  // project checkout. `missionId` null (or worktree gone) ⇒ the project path.
  const checkoutPathFor = (missionId: string | null, projectId: number): string =>
    (missionId ? agents()?.missionGit().worktreeFor(missionId) : undefined) ?? pathFor(projectId);

  // Per-user model allow-list: a non-admin whose allowed_execs is non-empty may only use those execs.
  // Open mode (no authenticated user), admins, or an empty list → unrestricted. The global
  // config.allowedExecs check still applies independently and is the outer bound.
  const execAllowedForUser = (auth: ApiAuth, exec: string): boolean => {
    if (auth.userId === null || auth.admin) return true;
    const allowed = stores().usersRead.allowedExecs(auth.userId);
    return allowed === null || allowed.length === 0 || allowed.includes(exec);
  };

  // Resolve the target project for a create/plan request. Defaults to the daemon's home project; every
  // id — the home project included — must be accessible to the caller, so a user or agent confined
  // elsewhere can never create tasks and plans in it.
  const resolveTarget = (auth: ApiAuth, projectId?: number):
    | { project: { id: number; path: string } }
    | { error: string; status: 403 | 404 } => {
    const homeProject = home();
    const pid = projectId ?? homeProject.id;
    // The home project is a source of project DATA (a legacy single-project daemon may have no row for
    // it), never an authorisation shortcut — it passes the same access gate as any other id.
    if (pid === homeProject.id) {
      if (!canProject(auth, pid)) return { error: 'forbidden', status: 403 };
      return { project: { id: homeProject.id, path: homeProject.path } };
    }
    const p = stores().projects.get(pid);
    if (!p) return { error: 'project not found', status: 404 };
    if (!canProject(auth, p.id)) return { error: 'forbidden', status: 403 };
    return { project: { id: p.id, path: p.path } };
  };

  // Plan persistence + lifecycle (epic/phase creation, engage/tick, Pilot reap) lives in its own
  // service so the planning path is unit-testable without the HTTP surface.
  const { persistPlan, reapPilotSession, finalizePlanJob } = createPlanService({
    tasks, planJobs, planFlow: () => agents()?.planFlow(),
    allowedExecs: () => config().get().allowedExecs,
    publishEvent: (e) => ctx.publishEvent(e),
    killSession: (name) => ctx.host.tmux().kill(name),
    pathFor,
  });

  /** Whether an agent session is STILL live after its kill failed — the only evidence that lets a
   *  destructive route treat that failure as a benign "already gone" rather than a stranded worker. An
   *  unreadable session list counts as live: unverified is not the same as gone. */
  async function sessionLive(session: string): Promise<boolean> {
    if (brainWorkers()?.isLive(session)) return true;
    try { return (await ctx.host.tmux().list()).includes(session); } catch { return true; }
  }

  ctx.registerApiRoute({
    rootMount: '/tasks', path: '', method: 'GET', access: 'agent',
    handler: async (req) => {
      // A mount is a PREFIX: anything under /tasks that no deeper mount claims lands here too.
      if (req.path !== '') return unknownSubPath(req.auth);
      const allowed = req.auth.accessibleProjects;
      const all = tasks().list();
      const scoped = allowed ? all.filter((t) => allowed.includes(t.project_id)) : all;
      // Optional `?project_id=N` narrows the list to one project. Applied AFTER the access gate so a
      // non-admin can't cross tenancy. An unknown/foreign id simply yields [] (no 404 — benevolent).
      const pidRaw = req.query['project_id'];
      if (pidRaw !== undefined && pidRaw !== '') {
        const pid = Number(pidRaw);
        if (Number.isFinite(pid)) return json(scoped.filter((t) => t.project_id === pid));
      }
      return json(scoped);
    },
  });

  ctx.registerApiRoute({
    rootMount: '/tasks', path: '', method: 'POST', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const b = createTaskSchema.parse(await req.json());
      const target = resolveTarget(req.auth, b.project_id);
      if ('error' in target) return json({ error: target.error }, target.status);
      const id = b.id ?? shortId(basename(target.project.path));
      // The row and its dependency edges are ONE unit of work: a task that survived a failed setDeps
      // would be created with no predecessors at all and go straight into the ready queue, running
      // ahead of the work it was declared to wait for.
      const created = tasks().transaction(() => {
        const task = tasks().create({ id, project_id: target.project.id, title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart, created_by: req.auth.userId });
        if (Array.isArray(b.deps)) tasks().setDeps(task.id, b.deps);
        return task;
      });
      ctx.publishEvent({ type: 'task', taskId: created.id, status: created.status });
      return json(created, 201);
    },
  });

  ctx.registerApiRoute({
    rootMount: '/tasks/ready', path: '', method: 'GET', access: 'agent',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      // Scope like GET /tasks: this used to return the daemon home project's ready queue unscoped —
      // leaking its task titles/descriptions to any user (or agent token) assigned only to a different
      // project, while that project's own ready tasks were unreachable. Resolve an accessible project
      // (optional ?project_id, else home) and yield [] when the caller can't access it.
      const allowed = req.auth.accessibleProjects; // null ⇒ admin / open mode (unrestricted)
      const pidRaw = req.query['project_id'];
      const pid = pidRaw !== undefined && pidRaw !== '' && Number.isFinite(Number(pidRaw)) ? Number(pidRaw) : home().id;
      if (allowed && !allowed.includes(pid)) return json([]);
      return json(readiness().ready(pid));
    },
  });

  ctx.registerApiRoute({
    rootMount: '/tasks/deps', path: '', method: 'GET', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const allowed = req.auth.accessibleProjects;
      const deps = tasks().allDeps();
      if (!allowed) return json(deps); // admin / open mode → unrestricted
      // Non-admin: keep only edges whose task belongs to a project the caller can access.
      const visible = new Set(tasks().list().filter((t) => allowed.includes(t.project_id)).map((t) => t.id));
      return json(deps.filter((e) => visible.has(e.task_id)));
    },
  });

  // Token/cost usage for a task's agent run, read from the executor CLI's local session storage
  // (opencode / claude / codex) — portable, no relay. Null usage → no matching session found.
  ctx.registerApiRoute({
    rootMount: '/tasks/:id/usage', path: '', method: 'GET', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const task = tasks().get(req.params['id']!);
      if (!task) return json({ error: 'not found' }, 404);
      if (!canProject(req.auth, task.project_id)) return json({ error: 'forbidden' }, 403);
      // The live reader lives in the agents plugin (it owns the CLI session-store parsers). Absent
      // plugin, embedded-brain (elowen:) runs, or an empty read → the snapshot the recorder / the
      // BrainWorkerService persisted at close (this is where provider-reported cost lives).
      const live = agents()?.liveTaskUsage()(task.id) ?? null;
      return json((live ?? domain.usage().get(task.id) ?? null) as object);
    },
  });

  // The transcript of an embedded-brain (elowen:) worker run — the task detail's conversation tab.
  // CLI-run tasks have no brain session, so this returns an empty list for them.
  ctx.registerApiRoute({
    rootMount: '/tasks/:id/conversation', path: '', method: 'GET', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const id = req.params['id']!;
      const task = tasks().get(id);
      if (!task) return json({ error: 'not found' }, 404);
      if (!canProject(req.auth, task.project_id)) return json({ error: 'forbidden' }, 403);
      // Both the session naming and the message shaping are the daemon's (chat shares them), so a
      // process without a brain store simply has no transcript — the same empty answer a CLI run gives.
      return json(stores().taskConversation?.(id) ?? []);
    },
  });

  ctx.registerApiRoute({
    rootMount: '/tasks/:id', path: '', method: 'PATCH', access: 'agent',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const b = patchTaskSchema.parse(await req.json());
      const id = req.params['id']!;
      const existing = tasks().get(id);
      if (!existing) return json({ error: 'task not found' }, 404);
      if (!canProject(req.auth, existing.project_id)) return json({ error: 'forbidden' }, 403);
      // An agent-scoped token (a spawned worker) may only CLOSE its task — set status + the closing
      // summary/outcome. Block the rest of the patch surface (exec/title/priority/description/deps/…) so a
      // prompt-injected worker running --dangerously-skip-permissions can't rewrite sibling tasks' fields
      // within its project (intra-tenant integrity, finding S51). Humans/full tokens keep the full surface.
      if (req.auth.tokenScope === 'agent') {
        const allowed = new Set(['status', 'result_summary', 'outcome']);
        if (Object.keys(b).some((k) => !allowed.has(k))) return json({ error: 'forbidden' }, 403);
      }
      // Validate the WHOLE command before writing ANY of it. The exec gate used to run after the status
      // branch, so `{status:'closed', exec:'<not allowed>'}` closed the task, published its SSE and drove
      // the review workflow — and only then answered 400, leaving the rejected command half-applied.
      if (typeof b.exec === 'string') {
        // Gate the executor exactly like the plan/session routes: an unvalidated exec is stored as an
        // `exec:<spec>` label and later interpolated into the agent launch command, so without this check
        // a project member could set an arbitrary executor (escaping the allow-list) or smuggle shell
        // metacharacters through the model field. Empty string clears the override (revert to fallback).
        if (b.exec && !config().get().allowedExecs.includes(b.exec)) return json({ error: 'exec not allowed' }, 400);
        if (b.exec && !execAllowedForUser(req.auth, b.exec)) return json({ error: 'exec not allowed for user' }, 403);
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
          const workers = brainWorkers();
          if (workers?.isLive(session)) await workers.abort(session).catch(() => { /* already gone */ });
          else await ctx.host.tmux().kill(session).catch(() => { /* already gone */ });
        }
      }
      // Every write of the patch in ONE transaction, so a field the store refuses (a dangling/cyclic
      // dependency edge, an illegal reparent) rolls back the fields that were accepted alongside it
      // instead of persisting a partial patch behind the 400.
      try {
        tasks().transaction(() => {
          if (b.status) {
            if (b.status === 'closed') tasks().close(id, { summary: b.result_summary, outcome: b.outcome });
            else tasks().setStatus(id, b.status);
          }
          if (typeof b.exec === 'string') tasks().setExec(id, b.exec);
          if (typeof b.title === 'string' || typeof b.type === 'string' || typeof b.priority === 'string' || typeof b.description === 'string' || b.scheduled_at !== undefined || b.autostart !== undefined) {
            tasks().update(id, { title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart });
          }
          if (Array.isArray(b.deps)) tasks().setDeps(id, b.deps);
          // Single-edge add (the drag-onto-card "add dependency" gesture): atomic, unlike a client-side
          // fetch-current-deps-then-PATCH-the-whole-array round trip, which races against a concurrent
          // editor of the same task's deps. setDeps stays the bulk-replace path (the deps modal). Unlike
          // that bulk path, this is one deliberate action, so a rejected edge (missing endpoint, cross-
          // project) surfaces as a 400 instead of silently vanishing.
          if (typeof b.addDep === 'string' && !tasks().addDep(id, b.addDep)) throw new PatchRejected('invalid dependency');
          // Drag-a-card-onto-another-card "make subtask" gesture. reparent() promotes the target to an
          // epic if needed.
          if (typeof b.parent_id === 'string') {
            const result = tasks().reparent(id, b.parent_id);
            if ('error' in result) throw new PatchRejected(result.error);
          }
        });
      } catch (e) {
        if (e instanceof PatchRejected) return json({ error: e.message }, 400);
        throw e;
      }
      // Side effects only once the whole patch is committed — an observer (SSE client, review workflow,
      // mission tick) must never see a state the transaction could still roll back.
      if (b.status) {
        ctx.publishEvent({ type: 'task', taskId: id, status: b.status });
        if (b.status === 'closed') {
          // ORDER MATTERS: freeze a standalone task's change list FIRST — the snapshot belongs to the
          // task domain (it must exist even with the agents plugin disabled) — and only THEN hand the
          // close to that plugin's review gate. A mission phase is the opposite: its commit + snapshot
          // happen INSIDE the gate (after the verdict), so this must not snapshot it here — snapshotting
          // before the phase commit would freeze a change list that misses the phase's own work. Under
          // the shared checkout lock so the range can't straddle a concurrent agent's commit on the
          // same path.
          if (!existing.parent_id) {
            const snapPath = pathFor(existing.project_id);
            await gitLock().run(snapPath, () => snapshotTaskChanges({ git: ctx.host.git(), log }, tasks(), id, snapPath));
          }
          // The post-done overseer review gate (agents plugin). AWAITED: the gate blocks the phase's
          // direct dependents synchronously, and the engine tick must never observe them un-gated.
          // Absent plugin → no gate, the close is final.
          await agents()?.onTaskClosed(id, existing, { outcome: b.outcome, summary: b.result_summary });
        }
      }
      // If the new parent's mission is already live, tick it so the new phase is picked up now instead
      // of waiting for the next scheduled tick — same pattern as insert-phases below.
      if (typeof b.parent_id === 'string') {
        const missionId = `m-${b.parent_id}`;
        const engine = agents()?.engine();
        if (engine?.isActive(missionId)) await engine.tick(missionId);
      }
      return json(tasks().get(id) as object);
    },
  });

  // Diff of one file from a task's FROZEN change list (the commits it landed between base..head). Read
  // from the mission worktree while it's live, else the project checkout (where the commits merged to).
  // Empty when the task has no snapshot, the file isn't in it, or the refs were GC'd by a later squash.
  ctx.registerApiRoute({
    rootMount: '/tasks/:id/changed/diff', path: '', method: 'GET', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const task = tasks().get(req.params['id']!);
      if (!task) return json({ error: 'task not found' }, 404);
      if (!canProject(req.auth, task.project_id)) return json({ error: 'forbidden' }, 403);
      const path = req.query['path'] ?? '';
      if (!task.base_sha || !task.head_sha || !path) return json({ diff: '' });
      const root = checkoutPathFor(task.parent_id ? `m-${task.parent_id}` : null, task.project_id);
      try {
        return json({ diff: await ctx.host.git().projectRangeFileDiff(root, task.base_sha, task.head_sha, path) });
      } catch {
        return json({ diff: '' }); // path-traversal reject / bad ref — degrade to empty, never 500
      }
    },
  });

  // The commits a task landed (`git log base..head` in its checkout) — the per-commit history shown
  // live in the detail pane's "conversation & history" feed, refreshed via the `change` SSE ping.
  // Empty until the first snapshot stamps base/head, or when the refs were GC'd by a later squash.
  ctx.registerApiRoute({
    rootMount: '/tasks/:id/commits', path: '', method: 'GET', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const task = tasks().get(req.params['id']!);
      if (!task) return json({ error: 'task not found' }, 404);
      if (!canProject(req.auth, task.project_id)) return json({ error: 'forbidden' }, 403);
      if (!task.base_sha || !task.head_sha) return json({ commits: [] });
      const root = checkoutPathFor(task.parent_id ? `m-${task.parent_id}` : null, task.project_id);
      return json({ commits: await ctx.host.git().projectRangeLog(root, task.base_sha, task.head_sha) });
    },
  });

  // Diff of one file as introduced by ONE of a task's commits (`git show <hash> -- <path>` in the task's
  // checkout) — the per-commit click-through in the conversation feed. Distinct from changed/diff, which
  // is the cumulative base..head diff. Empty on a bad hash/path or a GC'd ref — degrades, never 500s.
  ctx.registerApiRoute({
    rootMount: '/tasks/:id/commit/:hash/diff', path: '', method: 'GET', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const task = tasks().get(req.params['id']!);
      if (!task) return json({ error: 'task not found' }, 404);
      if (!canProject(req.auth, task.project_id)) return json({ error: 'forbidden' }, 403);
      const path = req.query['path'] ?? '';
      if (!path) return json({ diff: '' });
      const root = checkoutPathFor(task.parent_id ? `m-${task.parent_id}` : null, task.project_id);
      try {
        return json({ diff: await ctx.host.git().projectCommitFileDiff(root, req.params['hash'] ?? '', path) });
      } catch {
        return json({ diff: '' });
      }
    },
  });

  ctx.registerApiRoute({
    rootMount: '/tasks/:id/deps', path: '', method: 'GET', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const id = req.params['id']!;
      const task = tasks().get(id);
      if (!task) return json({ error: 'not found' }, 404);
      if (!canProject(req.auth, task.project_id)) return json({ error: 'forbidden' }, 403);
      return json(tasks().depsFor(id));
    },
  });

  ctx.registerApiRoute({
    rootMount: '/tasks/:id', path: '', method: 'DELETE', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const id = req.params['id']!;
      const existing = tasks().get(id);
      if (!existing) return json({ error: 'task not found' }, 404);
      if (!canProject(req.auth, existing.project_id)) return json({ error: 'forbidden' }, 403);
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
        // Read the mission's STATE from the row, not through the agents control: the guard below has to
        // hold precisely when that plugin is disabled — its rows (and the agents its mission spawned)
        // outlive it, and the epic delete would cascade those rows away with nothing left to find them by.
        const state = missionState(missionId);
        // Teardown must SUCCEED before the rows go. Both calls already return quietly for the "nothing
        // to tear down" state — disengage() is skipped for an already-disengaged mission and cleanup()
        // returns early when there is no worktree record — so anything thrown here is a teardown that
        // genuinely failed. Deleting the epic then would strand live agents and an on-disk worktree
        // against a mission that no longer exists in the DB, with nothing left to find them by.
        try {
          if (state && state !== 'disengaged') {
            // Teardown must SUCCEED before the rows go — with the agents plugin disabled there is
            // nothing that could stop the mission's agents, so refuse rather than strand them.
            const engine = agents()?.engine();
            if (!engine) return json({ error: 'agents plugin is disabled' }, 503);
            await engine.disengage(missionId);
          }
          await agents()?.missionGit().cleanup(missionId);
        } catch (e) {
          log.error(`epic ${id} not deleted — mission teardown failed — ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
          return json({ error: 'mission teardown failed' }, 500);
        }
        // deleteEpic cascades the mission rows, PR records AND handoff notes, so a removed mission
        // leaves no orphan note under any scope.
        const removed = tasks().deleteEpic(id);
        ctx.publishEvent({ type: 'task', taskId: id, status: 'cancelled' });
        ctx.deleteEventsForTarget(id);
        return json({ ok: true, tasks: removed.tasks });
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
            const workers = brainWorkers();
            if (workers?.isLive(session)) await workers.abort(session);
            else await ctx.host.tmux().kill(session);
          } catch (e) {
            // Only a session VERIFIED to be gone may be ignored (killing one that already exited is the
            // normal failure here). One that is still live outlived its kill, so keep the row: deleting
            // it would leave the worker editing the checkout with nothing left to find or stop it by.
            if (await sessionLive(session)) {
              log.error(`task ${id} not deleted — agent teardown failed — ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
              return json({ error: 'agent teardown failed' }, 500);
            }
          }
        }
      }
      tasks().delete(id);
      ctx.publishEvent({ type: 'task', taskId: id, status: 'cancelled' }); // live SSE so open UIs drop the row
      ctx.deleteEventsForTarget(id); // purge its history — a removed task leaves no dead feed
      return json({ ok: true });
    },
  });

  ctx.registerApiRoute({
    rootMount: '/tasks/plan', path: '', method: 'POST', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const b = planSchema.parse(await req.json());
      const goal = (b.goal ?? '').trim();
      const name = (b.name ?? '').trim(); // optional short mission name → epic title (goal stays the description)
      if (!goal) return json({ error: 'goal required' }, 400);
      // Engaging needs a mission (agents plugin); a pure plan (epic + phases) does not.
      const planFlow = agents()?.planFlow();
      if (b.engage === true && !planFlow) return json({ error: 'agents plugin is disabled' }, 503);
      if (b.exec && !config().get().allowedExecs.includes(b.exec)) return json({ error: 'exec not allowed' }, 400);
      if (b.exec && !execAllowedForUser(req.auth, b.exec)) return json({ error: 'exec not allowed for user' }, 403);
      // Pilot/overseer overrides are agents vocabulary — the plugin validates them (global + per-user
      // allow-lists). Without the plugin they are inert: no pilot or overseer will ever run them.
      const overrideErr = planFlow?.execOverrideError([b.pilotExec, b.overseerExec], req.auth.userId);
      if (overrideErr) return json({ error: overrideErr.error }, overrideErr.status);
      const target = resolveTarget(req.auth, b.project_id);
      if ('error' in target) return json({ error: target.error }, target.status);
      // PR mode (incl. the >1-sessions auto-opt-in) and worktree isolation are the plugin's call; a
      // plugin-less plan is a plain epic with no PR override and no isolation guidance.
      const { prEnabled, isolated } = planFlow?.planPrMode(b.prEnabled ?? null, b.maxSessions ?? 1, target.project.id) ?? { prEnabled: null, isolated: false };

      // Manual mode: explicit phases → synchronous create (no LLM, no key). Keeps the 201 contract.
      if (Array.isArray(b.phases) && b.phases.length > 0) {
        const phases: Phase[] = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task' })).filter((p) => p.title);
        if (phases.length === 0) return json({ error: 'phases required' }, 400);
        if (b.dryRun === true) return json({ phases }); // playground preview, nothing persisted
        const job = planJobs().create({ goal, name, projectId: target.project.id, epicId: null, dryRun: false, exec: b.exec, pilotExec: b.pilotExec, overseerExec: b.overseerExec, prEnabled, engage: b.engage === true ? { autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1 } : undefined, createdBy: req.auth.userId });
        job.phases = phases;
        const { epic, phases: created } = persistPlan(job);
        job.epicId = epic.id;
        planJobs().setPhases(job.id, phases);
        const mission = await planFlow?.planEngage(job, epic.id);
        return json({ epic, phases: created.map((t) => tasks().get(t.id)), mission }, 201);
      }

      // Autopilot mode: always async via a plan job — one path for the relay and the agent backends.
      const cfg = config().get();
      const job = planJobs().create({
        goal, name, projectId: target.project.id, epicId: null, dryRun: b.dryRun === true,
        // Auto mode lets the planner pick a model per phase, so no uniform exec rides along.
        exec: b.autoModel ? undefined : b.exec, autoModel: b.autoModel === true,
        pilotExec: b.pilotExec, overseerExec: b.overseerExec,
        engage: b.engage === true ? { autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1 } : undefined,
        prEnabled, maxSessions: b.maxSessions ?? 1, createdBy: req.auth.userId,
      });
      ctx.publishEvent({ type: 'plan', jobId: job.id, status: 'planning' });
      const pilot = planFlow?.pilotBackend(b.pilotExec) ?? null;
      if (pilot) {
        // Agent backend: spawn the Pilot in the repo; it submits via `elowen plan submit`.
        void pilot(job, target.project.path).catch((e) => { planJobs().fail(job.id, String(e)); ctx.publishEvent({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); reapPilotSession(job); });
        return json({ jobId: job.id }, 202);
      }
      // Relay backend: decompose inline and resolve the job before responding.
      const relay = config().autopilotRelay();
      if (!relay) return json({ error: 'autopilot_key_missing' }, 400);
      const inf = ctx.host.relayClient({ baseUrl: relay.baseUrl, apiKey: relay.apiKey, model: cfg.autopilot.model });
      let phases: Phase[];
      try {
        const notes = stores().projects.get(target.project.id)?.notes;
        const models = job.autoModel ? modelsBlock(cfg.allowedExecs, cfg.modelNotes) : undefined;
        // Same parallelism guidance the agent-mode Pilot gets: parallel branches only when >1 session
        // AND the mission will run PR-native (isolated worktrees) — `isolated` resolved by the plugin above.
        const parallelism = parallelismBlock(b.maxSessions ?? 1, isolated);
        // The triggering user's own `planner` override wins over the global admin template (an explicit
        // request-body prompt still takes precedence over both — playground/manual overrides).
        const userPlanner = req.auth.userId !== null ? ctx.host.prompts().userOverride(req.auth.userId, 'planner') : null;
        phases = await decompose(inf, goal, b.prompt ?? userPlanner ?? cfg.autopilot.prompt, { notes }, models, parallelism);
      } catch {
        planJobs().fail(job.id, 'plan_parse_failed');
        ctx.publishEvent({ type: 'plan', jobId: job.id, status: 'failed', error: 'plan_parse_failed' });
        return json({ jobId: job.id, error: 'plan_parse_failed' }, 502);
      }
      await finalizePlanJob(job.id, phases);
      return json({ jobId: job.id, epicId: planJobs().get(job.id)?.epicId ?? null }, 202);
    },
  });

  ctx.registerApiRoute({
    rootMount: '/plan/:jobId', path: '', method: 'GET', access: 'agent',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const job = planJobs().get(req.params['jobId']!);
      if (!job) return json({ error: 'not found' }, 404);
      // The Pilot (agent scope) is handed exactly this job's unguessable id and may have no in_progress
      // task yet (it runs during initial planning), so the working-set check doesn't apply — the job id
      // is the capability. Interactive users still go through the project access gate.
      if (req.auth.tokenScope !== 'agent' && !canProject(req.auth, job.projectId)) return json({ error: 'forbidden' }, 403);
      return json(job);
    },
  });

  ctx.registerApiRoute({
    rootMount: '/plan/:jobId/submit', path: '', method: 'POST', access: 'agent',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const job = planJobs().get(req.params['jobId']!);
      if (!job) return json({ error: 'not found' }, 404);
      if (req.auth.tokenScope !== 'agent' && !canProject(req.auth, job.projectId)) return json({ error: 'forbidden' }, 403);
      // Idempotency guard: a terminal job lingers ~10 min (TERMINAL_TTL_MS). Without this, a retried submit
      // (pilot re-send / curl retry on timeout) re-runs persistPlan on the already-planned epic — appending
      // the whole phase set a second time and re-engaging the mission — and a submit on a `failed` job would
      // silently resurrect it. Only a job still `planning` may be submitted.
      if (job.status !== 'planning') return json({ error: `plan job already ${job.status}` }, 409);
      // A malformed body is "no phases", not a body-shape error: the pilot retries this endpoint, and
      // the answer it has always seen for garbage is `invalid phases`.
      let body: { phases?: unknown } = {};
      try { body = await req.json<{ phases?: unknown }>(); } catch { /* malformed → no phases */ }
      let phases: Phase[];
      try { phases = parsePhases(JSON.stringify(body.phases ?? [])); } // reuse the relay validator (DRY)
      catch { return json({ error: 'invalid phases' }, 400); }
      await finalizePlanJob(job.id, phases);
      return json(planJobs().get(job.id) as object);
    },
  });

  // Insert phases into an existing epic — a manual list of phases, or `goal` to replan
  // (decompose a residual goal). New phases run AFTER the epic's current chain; an active
  // mission picks up the freshly-ready phase on the next tick (triggered immediately here).
  ctx.registerApiRoute({
    rootMount: '/tasks/:epicId/phases', path: '', method: 'POST', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return unknownSubPath(req.auth);
      const epicId = req.params['epicId']!;
      const epic = tasks().get(epicId);
      if (!epic || epic.type !== 'epic') return json({ error: 'epic not found' }, 404);
      if (!canProject(req.auth, epic.project_id)) return json({ error: 'forbidden' }, 403);
      const b = insertPhasesSchema.parse(await req.json());
      if (b.exec && !config().get().allowedExecs.includes(b.exec)) return json({ error: 'exec not allowed' }, 400);
      if (b.exec && !execAllowedForUser(req.auth, b.exec)) return json({ error: 'exec not allowed for user' }, 403);

      // Manual insert: explicit phases, no LLM, no key. persistPlan appends after the epic's tail.
      if (Array.isArray(b.phases) && b.phases.length > 0) {
        const phases: Phase[] = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task', details: (p.details ?? '').trim() || undefined })).filter((p) => p.title);
        if (phases.length === 0) return json({ error: 'phases required' }, 400);
        const job = planJobs().create({ goal: epic.description?.trim() || epic.title, projectId: epic.project_id, epicId, dryRun: false, exec: b.exec, createdBy: epic.created_by ?? req.auth.userId });
        job.phases = phases;
        const { phases: created } = persistPlan(job);
        await agents()?.planFlow().planEngage(job, epicId); // tick an active mission so it picks up the new ready phase
        return json({ epic, phases: created.map((t) => tasks().get(t.id)) }, 201);
      }
      if (!(b.goal ?? '').trim()) return json({ error: 'phases or goal required' }, 400);

      // Replan: decompose the residual goal — async via a plan job scoped to this epic (so an agent
      // Pilot can do it; finalizePlanJob appends + ticks an active mission). One path, relay or agent.
      const cfg = config().get();
      // The agents context a replan inherits (the epic's frozen PR override, isolation, the mission's
      // session width and per-mission execs) is the plugin's call — carried into the job so the
      // parallelism guidance matches how the replanned phases will actually run. Plugin-less default:
      // a linear, non-isolated replan.
      const rc = agents()?.planFlow().replanContext(epicId) ?? { prEnabled: null, isolated: false, maxSessions: 1 };
      const replanParallelism = parallelismBlock(rc.maxSessions, rc.isolated);
      const job = planJobs().create({ goal: b.goal!.trim(), projectId: epic.project_id, epicId, dryRun: false, exec: b.exec, pilotExec: rc.pilotExec, overseerExec: rc.overseerExec, prEnabled: rc.prEnabled, maxSessions: rc.maxSessions, createdBy: epic.created_by ?? req.auth.userId });
      ctx.publishEvent({ type: 'plan', jobId: job.id, status: 'planning' });
      const replanPilot = agents()?.planFlow().pilotBackend(job.pilotExec) ?? null;
      if (replanPilot) {
        void replanPilot(job, pathFor(epic.project_id)).catch((e) => { planJobs().fail(job.id, String(e)); ctx.publishEvent({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); });
        return json({ jobId: job.id, epicId }, 202);
      }
      const relay = config().autopilotRelay();
      if (!relay) return json({ error: 'autopilot_key_missing' }, 400);
      const inf = ctx.host.relayClient({ baseUrl: relay.baseUrl, apiKey: relay.apiKey, model: cfg.autopilot.model });
      let phases: Phase[];
      // Preserve the epic owner's planner override across a replan; the current user is the fallback.
      const replanUserId = epic.created_by ?? req.auth.userId;
      const replanUserPlanner = replanUserId !== null ? ctx.host.prompts().userOverride(replanUserId, 'planner') : null;
      try { phases = await decompose(inf, b.goal!.trim(), b.prompt ?? replanUserPlanner ?? cfg.autopilot.prompt, { notes: stores().projects.get(epic.project_id)?.notes }, undefined, replanParallelism); }
      catch {
        planJobs().fail(job.id, 'plan_parse_failed');
        ctx.publishEvent({ type: 'plan', jobId: job.id, status: 'failed', error: 'plan_parse_failed' });
        return json({ jobId: job.id, error: 'plan_parse_failed' }, 502);
      }
      await finalizePlanJob(job.id, phases);
      return json({ jobId: job.id, epicId }, 202);
    },
  });
}
