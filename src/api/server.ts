import { basename, join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hermesStatus, installHermesPlugin } from '../integrations/hermesInstall.js';
import { detectClis } from '../integrations/cliDetection.js';
import { readTaskUsage } from '../integrations/usage/index.js';
import { listProjectFiles, readProjectFile, writeProjectFile, readProjectBytes, createProjectFile, createProjectDir, deleteProjectEntry, renameProjectEntry, copyProjectEntry, projectFileAtHead, projectFileDiff, projectCommitDiff, projectCommitFiles, projectCommitFileDiff, projectChangedFiles, projectWorkingDiff } from '../integrations/projectFiles.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { TaskStore } from '../store/taskStore.js';
import type { Readiness } from '../store/readiness.js';
import type { MissionStore } from '../store/missionStore.js';
import type { MissionEngine } from '../overseer/missionEngine.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { EventBus } from './sse.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import { resolveExecutor } from '../overseer/routing.js';
import { decompose, parsePhases, VALID_TYPES as VALID_PHASE_TYPES, type Phase } from '../overseer/planner.js';
import { classifySession } from '../overseer/sessionInfo.js';
import { isDestructive } from '../overseer/decision.js';
import { PlanJobStore, type PlanJob } from '../overseer/planJob.js';
import { DecisionQueue } from '../overseer/decisionQueue.js';
import type { Task } from '../store/types.js';
import { RelayClient } from '../inference/client.js';
import type { InferenceClient, RelayConfig } from '../inference/types.js';
import { uniqueName } from '../daemon/uniqueName.js';
import type { Clock } from '../shared/clock.js';
import type { ConfigStore } from '../store/configStore.js';
import { assembleMissionDetail } from '../store/missionDetail.js';
import type { UserStore, User } from '../store/userStore.js';
import { authMiddleware } from './auth.js';
import type { EventStore } from '../store/eventStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { UserProjectStore } from '../store/userProjectStore.js';
import type { GitReader } from '../git/gitReader.js';


export interface ServerDeps {
  tasks: TaskStore; readiness: Readiness; missions: MissionStore;
  engine: MissionEngine; spawn: SpawnService; tmux: TmuxDriver; bus: EventBus;
  project: { id: number; path: string };
  fallback: AgentSpec;
  clock: Clock;
  config: ConfigStore;
  users?: UserStore;
  events?: EventStore;
  projects?: ProjectStore;
  userProjects?: UserProjectStore;
  git?: GitReader;
  /** Directory where uploaded user avatars are stored/served. Absent → avatar upload disabled. */
  avatarsDir?: string;
  /** Factory for the planning LLM client; defaults to RelayClient. Overridable in tests. */
  makeInference?: (cfg: RelayConfig) => InferenceClient;
  /** Async planning job registry (relay or agent backend resolves into it). Defaulted when absent. */
  planJobs?: PlanJobStore;
  /** Per-mission decision queue consumed by the parked overseer agent (long-poll). Defaulted when absent. */
  decisionQueue?: DecisionQueue;
  /** Spawn the Pilot agent for an agent-mode plan job (Task 9). Absent → relay-only planning. */
  pilot?: (job: PlanJob, projectPath: string) => Promise<void>;
}

export function createServer(d: ServerDeps): Hono<{ Variables: { user: User; token: string } }> {
  // Core reasoning stores are optional in deps for back-compat with existing call sites/tests; the
  // daemon (bootstrap) injects shared instances. Default here so every route has a working store.
  const planJobs = d.planJobs ?? new PlanJobStore();
  const decisionQueue = d.decisionQueue ?? new DecisionQueue();
  const app = new Hono<{ Variables: { user: User; token: string } }>();
  app.use('*', cors());
  app.get('/health', c => c.json({ ok: true }));
  // Public: lets the web decide whether to show onboarding (no users yet) or the login form.
  app.get('/setup', c => c.json({ needsSetup: d.users ? d.users.count() === 0 : false }));

  if (d.users) {
    const users = d.users;
    app.use('*', authMiddleware(users));

    // Gate the project-scoped surface: a non-admin must be assigned to the daemon's project to
    // touch its tasks/missions/sessions. Admin passes (canAccess checks is_admin). Without a
    // userProjects store this is a no-op (single-user mode keeps full access).
    if (d.userProjects) {
      const up = d.userProjects;
      // Every route family that exposes the daemon's project data — including the activity log and
      // the live SSE event stream, which carry task/mission ids + statuses. Boundary-matched so
      // '/tasksfoo' can't sneak past '/tasks'.
      const GATED = ['/tasks', '/missions', '/sessions', '/activity', '/events'];
      app.use('*', async (c, next) => {
        const p = c.req.path;
        if (!GATED.some((g) => p === g || p.startsWith(g + '/'))) return next();
        if (users.count() === 0) return next(); // setup mode — no users to gate yet
        const u = c.get('user');
        if (u && up.canAccess(u.id, d.project.id)) return next();
        return c.json({ error: 'forbidden' }, 403);
      });
    }

    app.post('/auth/login', async (c) => {
      const { username, password } = await c.req.json();
      const user = users.verify(username, password);
      if (!user) return c.json({ error: 'invalid credentials' }, 401);
      return c.json({ token: users.issueToken(user.id), user });
    });
    app.post('/auth/logout', (c) => { const t = c.get('token'); if (t) users.revokeToken(t); return c.json({ ok: true }); });
    app.get('/auth/me', (c) => c.json({ user: c.get('user') }));
    // Self-service profile: name / email / preferred default executor. A user edits only their own.
    app.patch('/auth/me', async (c) => {
      const u = c.get('user');
      const b = await c.req.json() as { name?: string; email?: string; default_exec?: string };
      if (typeof b.default_exec === 'string' && b.default_exec) {
        // The preferred default must be one the user is actually allowed to run.
        const globalOk = d.config.get().allowedExecs.includes(b.default_exec);
        const personalOk = u.allowed_execs.length === 0 || u.allowed_execs.includes(b.default_exec);
        if (!globalOk || !personalOk) return c.json({ error: 'exec not allowed' }, 400);
      }
      return c.json(users.setProfile(u.id, { name: b.name, email: b.email, default_exec: b.default_exec }));
    });
    // Avatar upload (multipart). Validated by type + size; stored as <userId>.<ext> under avatarsDir.
    const AVATAR_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    const AVATAR_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
    app.post('/auth/me/avatar', async (c) => {
      if (!d.avatarsDir) return c.json({ error: 'avatars unavailable' }, 400);
      const u = c.get('user');
      const form = await c.req.formData();
      const file = form.get('avatar');
      if (!(file instanceof File)) return c.json({ error: 'avatar file required' }, 400);
      const ext = AVATAR_EXT[file.type];
      if (!ext) return c.json({ error: 'unsupported image type' }, 415);
      if (file.size > 2 * 1024 * 1024) return c.json({ error: 'image too large (max 2MB)' }, 413);
      mkdirSync(d.avatarsDir, { recursive: true });
      // Drop any prior avatar of a different extension so a user never keeps two files.
      for (const e of Object.values(AVATAR_EXT)) { if (e !== ext) { const f = join(d.avatarsDir, `${u.id}.${e}`); if (existsSync(f)) { try { unlinkSync(f); } catch { /* best-effort */ } } } }
      const filename = `${u.id}.${ext}`;
      writeFileSync(join(d.avatarsDir, filename), Buffer.from(await file.arrayBuffer()));
      return c.json(users.setAvatar(u.id, filename));
    });
    // Serve a user's avatar bytes. Reachable as an <img> src via the ?token= query (auth accepts it).
    app.get('/users/:id/avatar', (c) => {
      if (!d.avatarsDir) return c.json({ error: 'not found' }, 404);
      const target = users.get(Number(c.req.param('id')));
      if (!target || !target.avatar) return c.json({ error: 'not found' }, 404);
      const path = join(d.avatarsDir, target.avatar);
      if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
      const ext = target.avatar.split('.').pop() ?? '';
      const body = new Uint8Array(readFileSync(path)).buffer;
      return c.body(body, 200, { 'content-type': AVATAR_MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    });
    app.get('/users', (c) => c.json(users.list()));
    app.post('/users', async (c) => {
      const { username, password } = await c.req.json();
      try { return c.json(users.create(username, password), 201); }
      catch { return c.json({ error: 'username taken' }, 409); }
    });
    app.delete('/users/:id', (c) => {
      if (users.count() <= 1) return c.json({ error: 'cannot delete the last user' }, 400);
      // Never delete the admin: it would lock out assignment management and (on restart) silently
      // re-elect another user as admin. The flag must be transferred deliberately first.
      if (users.isAdmin(Number(c.req.param('id')))) return c.json({ error: 'cannot delete the admin' }, 400);
      users.delete(Number(c.req.param('id')));
      return c.json({ ok: true });
    });

    // Admin edits another user's permissions: role (is_admin) and per-user model allow-list.
    app.patch('/users/:id', async (c) => {
      const actor = c.get('user');
      if (!actor || !users.isAdmin(actor.id)) return c.json({ error: 'forbidden' }, 403);
      const id = Number(c.req.param('id'));
      const target = users.get(id);
      if (!target) return c.json({ error: 'user not found' }, 404);
      const b = await c.req.json() as { is_admin?: boolean; allowed_execs?: string[] };
      if (typeof b.is_admin === 'boolean') {
        // Refuse to demote the last admin — it would lock out role/assignment management.
        if (!b.is_admin && target.is_admin && users.adminCount() <= 1) return c.json({ error: 'cannot demote the last admin' }, 400);
        users.setAdmin(id, b.is_admin);
      }
      if (Array.isArray(b.allowed_execs)) {
        // Can't grant beyond what the daemon globally allows; keep only known execs (dedup).
        const globalAllowed = new Set(d.config.get().allowedExecs);
        users.setAllowedExecs(id, [...new Set(b.allowed_execs.filter((e) => typeof e === 'string' && globalAllowed.has(e)))]);
      }
      return c.json(users.get(id));
    });

    // User ↔ project assignments. Only the bootstrap admin may view/manage them.
    if (d.userProjects) {
      const up = d.userProjects;
      const adminOnly = (c: { get: (k: 'user') => User }) => up.isAdmin(c.get('user').id);
      app.get('/users/:id/projects', (c) => {
        if (!adminOnly(c)) return c.json({ error: 'forbidden' }, 403);
        return c.json(up.forUser(Number(c.req.param('id'))));
      });
      app.post('/users/:id/projects', async (c) => {
        if (!adminOnly(c)) return c.json({ error: 'forbidden' }, 403);
        const { projectId } = await c.req.json() as { projectId?: number };
        if (projectId == null) return c.json({ error: 'projectId required' }, 400);
        up.assign(Number(c.req.param('id')), Number(projectId));
        return c.json({ ok: true });
      });
      app.delete('/users/:id/projects/:pid', (c) => {
        if (!adminOnly(c)) return c.json({ error: 'forbidden' }, 403);
        up.unassign(Number(c.req.param('id')), Number(c.req.param('pid')));
        return c.json({ ok: true });
      });
    }
  }

  // A non-admin user may only see/operate projects assigned to them; the admin (and open mode)
  // sees everything. Returns true when access is permitted.
  const canAccessProject = (c: { get: (k: 'user') => User | undefined }, id: number): boolean => {
    if (!d.userProjects || !d.users) return true; // open mode / single-user → no gating
    const u = c.get('user');
    return !!u && d.userProjects.canAccess(u.id, id);
  };

  // The set of project ids the caller may see, or null for unrestricted (open mode / admin).
  // Computed once for list endpoints so they don't run a per-row access query.
  const accessibleProjects = (c: { get: (k: 'user') => User | undefined }): Set<number> | null => {
    if (!d.userProjects || !d.users) return null;
    const u = c.get('user');
    if (!u || d.userProjects.isAdmin(u.id)) return null;
    return new Set(d.userProjects.forUser(u.id));
  };

  // A mission belongs to its epic's project — gate by that project's access. Open/single-user mode
  // has no tenancy boundary, so it always passes (even if the epic row is absent).
  const missionAccessible = (c: { get: (k: 'user') => User | undefined }, epicId: string): boolean => {
    if (!d.userProjects || !d.users) return true;
    const epic = d.tasks.get(epicId);
    return !!epic && canAccessProject(c, epic.project_id);
  };

  // Per-user model allow-list: a non-admin whose allowed_execs is non-empty may only use those
  // execs. Open mode (no auth), admins, or an empty list → unrestricted. The global
  // config.allowedExecs check still applies independently and is the outer bound.
  const execAllowedForUser = (c: { get: (k: 'user') => User | undefined }, exec: string): boolean => {
    if (!d.users) return true;
    const u = c.get('user');
    if (!u || u.is_admin) return true;
    return u.allowed_execs.length === 0 || u.allowed_execs.includes(exec);
  };

  // Filesystem path of a project. The daemon's home project is always known; others resolve via the
  // ProjectStore (falling back to the home path when the store is absent — e.g. legacy single-project).
  const pathFor = (projectId: number): string =>
    projectId === d.project.id ? d.project.path : (d.projects?.get(projectId)?.path ?? d.project.path);

  // Resolve the target project for a create/plan request. Defaults to the daemon's home project;
  // any other project_id must exist and be accessible to the caller.
  const resolveTarget = (c: { get: (k: 'user') => User | undefined }, projectId?: number):
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
    const newId = () => `${basename(path)}-${randomBytes(4).toString('hex')}`;
    const epicId = job.epicId ?? newId();
    let epic = d.tasks.get(epicId);
    if (!epic) {
      epic = d.tasks.create({ id: epicId, project_id: job.projectId, title: job.goal, type: 'epic', description: job.goal });
      d.bus.publish({ type: 'task', taskId: epic.id, status: epic.status });
    }
    const existing = d.tasks.descendants(epic.id);
    const dependedOn = new Set(d.tasks.depsAmong(existing.map((t) => t.id)).map((e) => e.depends_on_id));
    const leaves = existing.map((t) => t.id).filter((id) => !dependedOn.has(id));
    const overallGoal = epic.description?.trim() || epic.title;
    const created: Task[] = [];
    let prevId: string | null = null;
    for (const ph of job.phases) {
      const childDesc = ph.details ? `${ph.details}\n\nOverall goal: ${overallGoal}` : `Overall goal: ${overallGoal}`;
      const child = d.tasks.create({ id: newId(), project_id: job.projectId, title: ph.title, type: ph.type, parent_id: epic.id, labels: ph.agent ? [`agent:${ph.agent}`] : [], description: childDesc });
      if (prevId) d.tasks.addDep(child.id, prevId); // chain within the new batch
      else for (const leaf of leaves) d.tasks.addDep(child.id, leaf); // first new phase waits on the tail
      if (job.exec) d.tasks.setExec(child.id, job.exec);
      d.bus.publish({ type: 'task', taskId: child.id, status: child.status });
      created.push(child);
      prevId = child.id;
    }
    return { epic, phases: created };
  }

  // Finalize an async plan job: a dryRun job records phases without persisting; otherwise persist the
  // epic+children, optionally engage a mission, tick an already-active mission so it picks up the new
  // ready phase, and announce the result over SSE. Shared by the relay path and the agent submit path.
  async function finalizePlanJob(jobId: string, phases: Phase[]): Promise<void> {
    const job = planJobs.get(jobId);
    if (!job) return;
    if (job.dryRun) {
      planJobs.setPhases(jobId, phases);
      d.bus.publish({ type: 'plan', jobId, status: 'done', phases });
      return;
    }
    job.phases = phases;
    const { epic, phases: created } = persistPlan(job);
    job.epicId = epic.id;
    planJobs.setPhases(jobId, phases);
    if (job.engage) {
      await d.engine.engage({ epicId: epic.id, autonomy: job.engage.autonomy, maxSessions: job.engage.maxSessions, clearedGuardrails: [] });
    } else {
      const missionId = `m-${epic.id}`;
      if (d.engine?.isActive(missionId)) await d.engine.tick(missionId); // replan into a live mission
    }
    d.bus.publish({ type: 'plan', jobId, status: 'done', epicId: epic.id, phases: created.map((t) => ({ title: t.title, type: t.type })) });
  }

  app.get('/projects', (c) => {
    const all = d.projects ? d.projects.list() : [];
    if (!d.userProjects || !d.users) return c.json(all);
    const u = c.get('user');
    if (u && d.userProjects.isAdmin(u.id)) return c.json(all);
    const allowed = u ? new Set(d.userProjects.forUser(u.id)) : new Set<number>();
    return c.json(all.filter((p) => allowed.has(p.id)));
  });
  app.post('/projects', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    // Only the admin may register projects (when multi-user auth is on).
    if (d.userProjects && d.users) { const u = c.get('user'); if (!u || !d.userProjects.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    const { slug, path, notes } = await c.req.json();
    try { return c.json(d.projects.create({ slug, path, notes }), 201); }
    catch { return c.json({ error: 'slug taken' }, 409); }
  });
  // Edit a project's path / Pilot notes (slug stays immutable). Admin-only, like registration.
  app.patch('/projects/:id', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    if (d.userProjects && d.users) { const u = c.get('user'); if (!u || !d.userProjects.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    const id = Number(c.req.param('id'));
    if (!d.projects.get(id)) return c.json({ error: 'project not found' }, 404);
    const b = await c.req.json() as { path?: string; notes?: string };
    const patch: { path?: string; notes?: string } = {};
    if (typeof b.path === 'string' && b.path.trim()) patch.path = b.path.trim();
    if (typeof b.notes === 'string') patch.notes = b.notes;
    return c.json(d.projects.update(id, patch));
  });
  app.get('/projects/:id/git', async (c) => {
    if (!d.projects || !d.git) return c.json({ error: 'projects unavailable' }, 400);
    const p = d.projects.get(Number(c.req.param('id')));
    if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    return c.json(await d.git.read(p.path));
  });

  // --- Project file editor: tree, read, write, per-file diff. Paths are validated to stay inside
  // the project root (see projectFiles.safe); access is gated to the project's assigned users. ---
  const projectOf = (c: { req: { param: (k: string) => string } }) => d.projects?.get(Number(c.req.param('id'))) ?? null;
  app.get('/projects/:id/files', (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    return c.json(listProjectFiles(p.path));
  });
  app.get('/projects/:id/file', (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json(readProjectFile(p.path, path)); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.put('/projects/:id/file', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json() as { path?: string; content?: string };
    if (!b.path || typeof b.content !== 'string') return c.json({ error: 'path and content required' }, 400);
    try { writeProjectFile(p.path, b.path, b.content); return c.json({ ok: true }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  // Raw file bytes for binary previews (images). Content-type from extension; unknown → octet-stream.
  app.get('/projects/:id/raw', (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try {
      const bytes = readProjectBytes(p.path, path);
      if (!bytes) return c.json({ error: 'not previewable' }, 415);
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif' };
      const body = new Uint8Array(bytes).buffer; // fresh ArrayBuffer (not the Buffer's shared pool)
      return c.body(body, 200, { 'content-type': mime[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    } catch { return c.json({ error: 'invalid path' }, 400); }
  });
  // File-manager operations (create / mkdir / rename / copy / delete). Each validates the path(s)
  // stay inside the project root and is gated to the project's assigned users.
  app.post('/projects/:id/new-file', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json() as { path?: string };
    if (!b.path) return c.json({ error: 'path required' }, 400);
    try { createProjectFile(p.path, b.path); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.post('/projects/:id/dir', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json() as { path?: string };
    if (!b.path) return c.json({ error: 'path required' }, 400);
    try { createProjectDir(p.path, b.path); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.post('/projects/:id/rename', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json() as { from?: string; to?: string };
    if (!b.from || !b.to) return c.json({ error: 'from and to required' }, 400);
    try { renameProjectEntry(p.path, b.from, b.to); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.post('/projects/:id/copy', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json() as { from?: string; to?: string };
    if (!b.from || !b.to) return c.json({ error: 'from and to required' }, 400);
    try { copyProjectEntry(p.path, b.from, b.to); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.delete('/projects/:id/entry', (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { deleteProjectEntry(p.path, path); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.get('/projects/:id/diff', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json({ diff: await projectFileDiff(p.path, path) }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.get('/projects/:id/head', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json({ content: await projectFileAtHead(p.path, path) }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.get('/projects/:id/commit/:hash', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const hash = c.req.param('hash');
    const [diff, files] = await Promise.all([projectCommitDiff(p.path, hash), projectCommitFiles(p.path, hash)]);
    return c.json({ diff, files });
  });
  app.get('/projects/:id/commit/:hash/diff', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json({ diff: await projectCommitFileDiff(p.path, c.req.param('hash'), path) }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.get('/projects/:id/changed', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    return c.json({ changed: await projectChangedFiles(p.path) });
  });
  app.get('/projects/:id/changes', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    return c.json({ diff: await projectWorkingDiff(p.path) });
  });

  app.get('/activity', (c) => {
    if (!d.events) return c.json([]);
    const limit = Number(c.req.query('limit')) || undefined;
    const type = c.req.query('type') || undefined;
    return c.json(d.events.list({ limit, type }));
  });

  app.get('/tasks', c => {
    const allowed = accessibleProjects(c);
    const all = d.tasks.list();
    return c.json(allowed ? all.filter((t) => allowed.has(t.project_id)) : all);
  });
  app.post('/tasks', async c => {
    const b = await c.req.json() as { title: string; type?: string; priority?: string; id?: string; description?: string; scheduled_at?: string | null; autostart?: number; deps?: string[]; project_id?: number };
    const target = resolveTarget(c, b.project_id);
    if ('error' in target) return c.json({ error: target.error }, target.status);
    const id = b.id ?? `${basename(target.project.path)}-${randomBytes(4).toString('hex')}`;
    const created = d.tasks.create({ id, project_id: target.project.id, title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart });
    if (Array.isArray(b.deps)) d.tasks.setDeps(created.id, b.deps);
    d.bus.publish({ type: 'task', taskId: created.id, status: created.status });
    return c.json(created, 201);
  });
  app.get('/tasks/ready', c => c.json(d.readiness.ready(d.project.id)));
  app.get('/tasks/deps', c => c.json(d.tasks.allDeps()));
  // Token/cost usage for a task's agent run, read from the executor CLI's local session storage
  // (opencode / claude / codex) — portable, no relay. Null usage → no matching session found.
  app.get('/tasks/:id/usage', c => {
    const task = d.tasks.get(c.req.param('id'));
    if (!task) return c.json({ error: 'not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    // Pass the task's own project siblings so usage can disambiguate concurrent agents by start-order
    // rank, and read sessions from that project's path (not the daemon home, under multi-project).
    return c.json(readTaskUsage(task, d.tasks.list({ project_id: task.project_id }), pathFor(task.project_id), d.fallback));
  });
  app.patch('/tasks/:id', async c => {
    const b = await c.req.json();
    const id = c.req.param('id');
    const existing = d.tasks.get(id);
    if (!existing) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, existing.project_id)) return c.json({ error: 'forbidden' }, 403);
    if (b.status) {
      if (b.status === 'closed') d.tasks.close(id, { summary: b.result_summary, outcome: b.outcome });
      else d.tasks.setStatus(id, b.status);
      d.bus.publish({ type: 'task', taskId: id, status: b.status });
      // Post-done review (opt-in): when a mission phase closes, let the parked overseer judge the
      // outcome. Non-blocking (void) — it must never delay the agent's close. Default off, and only
      // active with an agent overseer configured. A rejected/destructive verdict blocks the phase(s)
      // waiting on this one, so a bad result halts the mission for a human instead of rolling on.
      const cfg = d.config.get();
      if (b.status === 'closed' && existing.parent_id && cfg.autopilot.reviewOnDone && cfg.autopilot.overseerExec) {
        const mission = d.missions.active().find((m) => m.epic_id === existing.parent_id);
        if (mission) {
          const localDestructive = isDestructive(`${existing.title} ${b.result_summary ?? ''}`);
          void decisionQueue.enqueue(mission.id, 'review', { title: existing.title, outcome: b.outcome ?? '', summary: b.result_summary ?? '' }, localDestructive)
            .then((verdict) => {
              if (verdict.approve && !verdict.destructive) return;
              for (const e of d.tasks.allDeps()) {
                if (e.depends_on_id !== id) continue;
                const dep = d.tasks.get(e.task_id);
                if (dep && dep.status === 'open') { d.tasks.setStatus(dep.id, 'blocked'); d.bus.publish({ type: 'task', taskId: dep.id, status: 'blocked' }); }
              }
            });
        }
      }
    }
    if (typeof b.exec === 'string') { d.tasks.setExec(id, b.exec); }
    if (typeof b.title === 'string' || typeof b.type === 'string' || typeof b.priority === 'string' || typeof b.description === 'string' || b.scheduled_at !== undefined || b.autostart !== undefined) {
      d.tasks.update(id, { title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart });
    }
    if (Array.isArray(b.deps)) d.tasks.setDeps(id, b.deps);
    return c.json(d.tasks.get(id));
  });
  app.get('/tasks/:id/deps', c => c.json(d.tasks.depsFor(c.req.param('id'))));
  app.delete('/tasks/:id', c => {
    const id = c.req.param('id');
    const existing = d.tasks.get(id);
    if (!existing) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, existing.project_id)) return c.json({ error: 'forbidden' }, 403);
    d.tasks.delete(id);
    d.bus.publish({ type: 'task', taskId: id, status: 'cancelled' }); // live SSE so open UIs drop the row
    d.events?.deleteForTarget(id); // purge its history — a removed task leaves no dead feed
    return c.json({ ok: true });
  });
  app.post('/tasks/plan', async c => {
    const b = await c.req.json() as { goal?: string; exec?: string; autonomy?: string; maxSessions?: number; engage?: boolean; phases?: { title?: string; type?: string }[]; dryRun?: boolean; prompt?: string; project_id?: number };
    const goal = (b.goal ?? '').trim();
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
      const job = planJobs.create({ goal, projectId: target.project.id, epicId: null, dryRun: false, exec: b.exec });
      job.phases = phases;
      const { epic, phases: created } = persistPlan(job);
      job.epicId = epic.id;
      planJobs.setPhases(job.id, phases);
      let mission;
      if (b.engage === true) mission = await d.engine.engage({ epicId: epic.id, autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1, clearedGuardrails: [] });
      return c.json({ epic, phases: created.map((t) => d.tasks.get(t.id)), mission }, 201);
    }

    // Autopilot mode: always async via a plan job — one path for the relay and the agent backends.
    const cfg = d.config.get();
    const job = planJobs.create({
      goal, projectId: target.project.id, epicId: null, dryRun: b.dryRun === true, exec: b.exec,
      engage: b.engage === true ? { autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1 } : undefined,
    });
    d.bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
    if (cfg.autopilot.pilotExec && d.pilot) {
      // Agent backend: spawn the Pilot in the repo; it submits via `orca plan submit`.
      void d.pilot(job, target.project.path).catch((e) => { planJobs.fail(job.id, String(e)); d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); });
      return c.json({ jobId: job.id }, 202);
    }
    // Relay backend: decompose inline and resolve the job before responding.
    const key = d.config.apiKey();
    if (!key) return c.json({ error: 'autopilot_key_missing' }, 400);
    const inf = (d.makeInference ?? ((rc) => new RelayClient(rc)))({ baseUrl: cfg.autopilot.apiUrl, apiKey: key, model: cfg.autopilot.model });
    let phases: Phase[];
    try {
      const notes = d.projects?.get(target.project.id)?.notes;
      phases = await decompose(inf, goal, b.prompt ?? cfg.autopilot.prompt, { notes });
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
    if (!canAccessProject(c, job.projectId)) return c.json({ error: 'forbidden' }, 403);
    return c.json(job);
  });

  app.post('/plan/:jobId/submit', async (c) => {
    const job = planJobs.get(c.req.param('jobId'));
    if (!job) return c.json({ error: 'not found' }, 404);
    if (!canAccessProject(c, job.projectId)) return c.json({ error: 'forbidden' }, 403);
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
    const b = await c.req.json() as { phases?: { title?: string; type?: string }[]; goal?: string; prompt?: string; exec?: string };
    if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);
    if (b.exec && !execAllowedForUser(c, b.exec)) return c.json({ error: 'exec not allowed for user' }, 403);

    // Manual insert: explicit phases, no LLM, no key. persistPlan appends after the epic's tail.
    if (Array.isArray(b.phases) && b.phases.length > 0) {
      const phases: Phase[] = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task' })).filter((p) => p.title);
      if (phases.length === 0) return c.json({ error: 'phases required' }, 400);
      const job = planJobs.create({ goal: epic.description?.trim() || epic.title, projectId: epic.project_id, epicId, dryRun: false, exec: b.exec });
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
    const job = planJobs.create({ goal: b.goal!.trim(), projectId: epic.project_id, epicId, dryRun: false, exec: b.exec });
    d.bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
    if (cfg.autopilot.pilotExec && d.pilot) {
      void d.pilot(job, pathFor(epic.project_id)).catch((e) => { planJobs.fail(job.id, String(e)); d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); });
      return c.json({ jobId: job.id, epicId }, 202);
    }
    const key = d.config.apiKey();
    if (!key) return c.json({ error: 'autopilot_key_missing' }, 400);
    const inf = (d.makeInference ?? ((rc) => new RelayClient(rc)))({ baseUrl: cfg.autopilot.apiUrl, apiKey: key, model: cfg.autopilot.model });
    let phases: Phase[];
    try { phases = await decompose(inf, b.goal!.trim(), b.prompt ?? cfg.autopilot.prompt, { notes: d.projects?.get(epic.project_id)?.notes }); }
    catch {
      planJobs.fail(job.id, 'plan_parse_failed');
      d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: 'plan_parse_failed' });
      return c.json({ jobId: job.id, error: 'plan_parse_failed' }, 502);
    }
    await finalizePlanJob(job.id, phases);
    return c.json({ jobId: job.id, epicId }, 202);
  });

  // Hermes integration — install the bundled orca plugin into a same-host Hermes instance.
  const hermesHome = (override?: string) => (override?.trim() || process.env.HERMES_HOME || '/var/www/.hermes');
  app.get('/integrations/hermes/status', c => c.json(hermesStatus(hermesHome(c.req.query('home')))));
  app.post('/integrations/hermes/install', async c => {
    const b = await c.req.json() as { home?: string; url?: string; token?: string; timeout?: number };
    const url = (b.url ?? '').trim();
    const token = (b.token ?? '').trim();
    if (!url || !token) return c.json({ error: 'url and token required' }, 400);
    const home = hermesHome(b.home);
    const pluginSrc = join(d.project.path, 'hermes-plugin', 'orca');
    try {
      const result = installHermesPlugin({ home, pluginSrc, url, token, timeout: b.timeout });
      return c.json({ ...result, status: hermesStatus(home) }, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get('/integrations/cli-status', c => {
    const cfg = d.config.get();
    const ctx = {
      configPersisted: d.config.hasSettings(),
      hasApiKey: cfg.autopilot.apiKeySet,
      hasCustomSetup: cfg.customModels.length > 0 || cfg.hiddenPresets.length > 0,
      userCount: d.users?.count() ?? 0,
      projectCount: d.projects?.list().length ?? 0,
    };
    return c.json(detectClis(ctx));
  });

  app.get('/sessions', async c => c.json((await d.tmux.list()).filter((s) => s.startsWith('orca-')).map(classifySession)));
  app.post('/sessions', async (c) => {
    const { taskId, exec } = await c.req.json() as { taskId: string; exec?: string };
    if (exec && !d.config.get().allowedExecs.includes(exec)) return c.json({ error: 'exec not allowed' }, 400);
    if (exec && !execAllowedForUser(c, exec)) return c.json({ error: 'exec not allowed for user' }, 403);
    const spec = resolveExecutor(exec ? [`exec:${exec}`] : [], d.fallback);
    const task = d.tasks.get(taskId);
    if (!task) return c.json({ error: 'task not found' }, 404); // don't spawn a phantom agent for a missing task
    // Launch in the task's own project (multi-project), gated to the caller's access.
    const projectId = task.project_id;
    if (!canAccessProject(c, projectId)) return c.json({ error: 'forbidden' }, 403);
    if (exec) d.tasks.setExec(taskId, exec); // remember which model ran it — drives the model icon
    const agentName = uniqueName();
    d.tasks.setAgent(taskId, agentName);     // link task → orca-<agentName> session for run controls
    d.tasks.markStarted(taskId, d.clock.now()); // precise spawn time → correct usage attribution under concurrency
    d.tasks.setStatus(taskId, 'in_progress');
    const { session } = await d.spawn.launch({ projectId, projectPath: pathFor(projectId), taskId, agentName, spec, taskTitle: task.title, taskDescription: task.description, epicId: task.parent_id ?? undefined });
    d.bus.publish({ type: 'task', taskId, status: 'in_progress' });
    return c.json({ session }, 201);
  });
  app.delete('/sessions/:name', async c => { await d.tmux.kill(c.req.param('name')); return c.json({ ok: true }); });
  app.post('/sessions/:name/keys', async c => { const { keys } = await c.req.json(); await d.tmux.sendKeys(c.req.param('name'), keys); return c.json({ ok: true }); });
  app.post('/sessions/:name/resize', async c => {
    const { cols, rows } = await c.req.json() as { cols?: number; rows?: number };
    if (typeof cols !== 'number' || typeof rows !== 'number') return c.json({ error: 'cols and rows required' }, 400);
    await d.tmux.resize(c.req.param('name'), cols, rows);
    return c.json({ ok: true });
  });
  app.get('/sessions/:name/pane', async c => {
    const name = c.req.param('name');
    const pane = c.req.query('ansi') ? await d.tmux.capturePaneAnsi(name, 60) : await d.tmux.capturePane(name, 60);
    return c.json({ pane });
  });

  app.get('/sessions/:name/stream', (c) => {
    const name = c.req.param('name');
    return streamSSE(c, async (stream) => {
      const frame = async () => {
        const pane = await d.tmux.capturePaneAnsi(name, 200);
        await stream.writeSSE({ data: JSON.stringify({ pane }), event: 'pane' });
      };
      await frame(); // first frame synchronously so clients render immediately
      const stop = d.clock.setInterval(() => { frame().catch(() => { /* transient capture error — skip this frame, keep the stream alive */ }); }, 1000);
      c.req.raw.signal.addEventListener('abort', stop);
      while (!c.req.raw.signal.aborted) await stream.sleep(1000);
      stop();
    });
  });

  app.get('/missions', c => {
    const allowed = accessibleProjects(c);
    const live = d.missions.live();
    return c.json(allowed ? live.filter((m) => { const epic = d.tasks.get(m.epic_id); return epic && allowed.has(epic.project_id); }) : live);
  });
  app.get('/missions/:id', (c) => {
    const mission = d.missions.get(c.req.param('id'));
    if (!mission) return c.json({ error: 'mission not found' }, 404);
    if (!missionAccessible(c, mission.epic_id)) return c.json({ error: 'forbidden' }, 403);
    const detail = assembleMissionDetail({ missions: d.missions, tasks: d.tasks }, c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'mission not found' }, 404);
  });
  app.post('/missions', async c => {
    const b = await c.req.json();
    if (!missionAccessible(c, b.epicId)) return c.json({ error: 'forbidden' }, 403);
    return c.json(await d.engine.engage(b), 201);
  });
  app.patch('/missions/:id', async (c) => {
    const id = c.req.param('id');
    const mission = d.missions.get(id);
    if (!mission) return c.json({ error: 'mission not found' }, 404);
    if (!missionAccessible(c, mission.epic_id)) return c.json({ error: 'forbidden' }, 403);
    const { action } = await c.req.json();
    if (action === 'pause') {
      await d.engine.pause(id); // kills running agents + reverts their tasks, then marks paused
    } else if (action === 'resume') {
      await d.engine.resume(id); // flips active, re-parks the overseer, then ticks
    }
    return c.json(d.missions.get(id));
  });
  app.delete('/missions/:id', async c => {
    const mission = d.missions.get(c.req.param('id'));
    if (!mission) return c.json({ error: 'mission not found' }, 404);
    if (!missionAccessible(c, mission.epic_id)) return c.json({ error: 'forbidden' }, 403);
    await d.engine.disengage(c.req.param('id'));
    return c.json({ ok: true });
  });

  // Overseer long-poll: the parked per-mission overseer agent polls `next` (blocks until a decision
  // is needed or a heartbeat) and answers via `decide`. Decisions are keyed by mission id in the
  // path; both sit behind the bearer middleware. No model output is parsed — the agent posts a
  // structured verdict, and the local destructive heuristic stays authoritative (applied at enqueue).
  // Gate the overseer routes by the mission's OWN project (not the daemon home project the GATED
  // middleware checks) so a cross-project user can't read/answer another tenant's decisions. A
  // non-existent mission id has nothing to leak, so it falls through (harmless heartbeat / no-op).
  const overseerForbidden = (c: { get: (k: 'user') => User | undefined }, missionId: string): boolean => {
    const mission = d.missions.get(missionId);
    return !!mission && !missionAccessible(c, mission.epic_id);
  };
  app.get('/missions/:id/overseer/next', async (c) => {
    const id = c.req.param('id');
    if (overseerForbidden(c, id)) return c.json({ error: 'forbidden' }, 403);
    const raw = Number(c.req.query('timeoutMs'));
    const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30_000) : undefined;
    const req = await decisionQueue.next(id, timeoutMs);
    return c.json(req ?? {});
  });
  app.post('/missions/:id/overseer/decide', async (c) => {
    const id = c.req.param('id');
    if (overseerForbidden(c, id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json().catch(() => ({})) as { id?: string; approve?: boolean; confidence?: number; rationale?: string };
    if (!b.id) return c.json({ error: 'id required' }, 400);
    const ok = decisionQueue.resolve(id, b.id, {
      approve: b.approve === true,
      confidence: typeof b.confidence === 'number' ? Math.max(0, Math.min(1, b.confidence)) : 0,
      destructive: false, // never trusted from the agent — the enqueue-time heuristic is authoritative
      rationale: typeof b.rationale === 'string' ? b.rationale : '',
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'no such decision' }, 404);
  });

  app.get('/config', (c) => c.json(d.config.get()));
  app.put('/config', async (c) => {
    // Editing the daemon config is admin-only (the Administration surface); reads stay open so the
    // app can populate model pickers etc. During setup (no users yet) it's open so onboarding can
    // save providers/the API key before the first admin exists.
    if (d.users && d.users.count() > 0) { const u = c.get('user'); if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    const patch = await c.req.json();
    return c.json(d.config.update(patch));
  });

  app.get('/events', c => streamSSE(c, async stream => {
    const off = d.bus.subscribe(e => void stream.writeSSE({ data: JSON.stringify(e), event: e.type }));
    c.req.raw.signal.addEventListener('abort', off);
    while (!c.req.raw.signal.aborted) await stream.sleep(30000);
  }));

  return app;
}
