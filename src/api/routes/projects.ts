import { homedir } from 'node:os';
import { createDir, CreateDirError, listDirs, isProjectImage, isProjectImageExtension, projectPathExists } from '../../integrations/projectFiles.js';
import { posix } from 'node:path';
import { RealGitReader } from '../../git/gitReader.js';
import { runManagedProjectCommand } from '../../integrations/managedProjectExecution.js';
import { managedGuestRoot } from '../../shared/projectExecution.js';
import { parseBody } from '../validation.js';
import { adoptProjectSchema, createDirectorySchema, createProjectSchema, deleteProjectSchema, updateProjectSchema, memoryMembersSchema } from '../schemas/projects.js';
import type { ElowenApp, RouteContext } from '../context.js';
import type { PluginProjectIndicator } from '../../plugins/api.js';
import { isPluginAllowedForUser } from '../../shared/pluginAccess.js';
import { PROJECT_ALREADY_MANAGED, PROJECT_LIMIT_REACHED, PROJECT_NOT_ADOPTED, type Project as StoredProject } from '../../store/projectStore.js';
import type { ProjectMemberView, ProjectView } from '../../shared/wireContract.js';

const MAX_MEMBER_SAMPLES = 3;
const MAX_INDICATORS_PER_PLUGIN = 3;
const MAX_INDICATORS_PER_PROJECT = 8;
const PROJECT_PATH_PROJECTION_CONCURRENCY = 8;
const INDICATOR_TONES = new Set(['muted', 'accent', 'success', 'warning', 'danger']);

/** The one project API projection. Stored metadata stays untouched; current filesystem state is attached
 * asynchronously at the response boundary for every endpoint that returns a project. */
async function toProjectView(project: StoredProject): Promise<ProjectView> {
  return project.executionKind === 'managed'
    ? { ...project, guestRoot: managedGuestRoot(project.slug, project.id) }
    : { ...project, pathExists: await projectPathExists(project.path) };
}

/** Enqueue the start that belongs to a just-created managed project and hand back the operation to
 *  follow. Best effort by design: the project is already durable and its environment surface reports its
 *  own state, so a provider that is unavailable or refuses costs the caller a progress window, never the
 *  project it just made. The request key is derived from the project, so a retried creation response
 *  reconciles onto the same operation instead of queueing a second one. */
async function startNewEnvironment(ctx: RouteContext, d: RouteContext['d'], projectId: number, accountUserId: number): Promise<string | undefined> {
  const sandbox = (await d.plugins?.get().catch(() => undefined))?.control('sandbox');
  if (!sandbox) return undefined;
  try {
    const operation = await sandbox.requestEnvironment({ project: { kind: 'managed', projectId }, accountUserId,
      action: { kind: 'start' }, requestId: `project-create:${projectId}` });
    return operation.id;
  } catch (error) {
    ctx.log.warn(`environment start was not requested for the new managed project ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** THE project-route answer to a provider refusal. The environment runtime signals a refused lifecycle
 *  request with a stable `code` and a 4xx `status` (an already running teardown, a stale generation, an
 *  environment that is deleting), which is a CONDITION of the environment rather than a server fault, so
 *  it answers 409 with the provider's code instead of `internal error`. The documented retry needs the
 *  same requestId and no client sends one, so the second click during a teardown is exactly this case.
 *  Anything without that shape is a real failure and keeps its 500. */
function environmentRefusal(error: unknown): { error: string; code: string } | null {
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  const refused = typeof value?.status === 'number' && value.status >= 400 && value.status < 500;
  if (!refused || typeof value.code !== 'string' || typeof value.message !== 'string') return null;
  return { error: value.message, code: value.code };
}

/** Bound concurrent filesystem projections so a large registry cannot flood the libuv worker pool. */
async function toProjectViews(projects: StoredProject[]): Promise<ProjectView[]> {
  const output = new Array<ProjectView>(projects.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= projects.length) return;
      output[index] = await toProjectView(projects[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROJECT_PATH_PROJECTION_CONCURRENCY, projects.length) }, worker));
  return output;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function sanitizeIndicator(value: PluginProjectIndicator, projectIds: ReadonlySet<number>): Omit<PluginProjectIndicator, 'projectId'> | null {
  if (!Number.isSafeInteger(value?.projectId) || !projectIds.has(value.projectId)) return null;
  const label = boundedText(value.label, 80);
  if (!label) return null;
  const output: Omit<PluginProjectIndicator, 'projectId'> = { label };
  const text = boundedText(value.value, 80);
  const icon = boundedText(value.icon, 40);
  if (text) output.value = text;
  if (icon) output.icon = icon;
  if (value.tone && INDICATOR_TONES.has(value.tone)) output.tone = value.tone;
  return output;
}

/** Project registration, tenancy and project metadata. The optional editor plugin owns project-file
 * routes; the core keeps icon validation because the project record persists that metadata. */
export function registerProjectRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, canAccessProject, notAdmin } = ctx;
  app.get('/projects', async (c) => {
    const all = d.projects ? d.projects.list() : [];
    if (!d.userProjects || !d.users) return c.json(await toProjectViews(all));
    const u = c.get('user');
    if (u && d.userProjects.isAdmin(u.id)) return c.json(await toProjectViews(all));
    const allowed = u ? new Set(d.userProjects.forUser(u.id)) : new Set<number>();
    return c.json(await toProjectViews(all.filter((p) => allowed.has(p.id))));
  });
  // One bounded server-side projection for the Project register. Core owns member tenancy; plugins receive
  // the already-filtered Project batch and contribute display-only capability indicators without browser
  // bundle loads or one API request per row.
  app.get('/projects/summary', async (c) => {
    const all = d.projects ? d.projects.list() : [];
    const user = c.get('user');
    const admin = !!(user && d.userProjects?.isAdmin(user.id));
    const allowed = admin || !d.userProjects || !d.users
      ? all
      : all.filter((project) => user && d.userProjects!.canAccess(user.id, project.id));
    const projectIds = new Set(allowed.map((project) => project.id));
    const indicatorMap = new Map<number, { plugin: string; label: string; value?: string; icon?: string; tone?: 'muted' | 'accent' | 'success' | 'warning' | 'danger' }[]>();
    const registry = await d.plugins?.get().catch(() => undefined);
    const pluginProjectCounts = new Map<string, number>();
    for (const provider of registry?.projectIndicatorProviders ?? []) {
      if (registry?.webAdminOnly.has(provider.plugin) && !admin) continue;
      if (!isPluginAllowedForUser(user, { name: provider.plugin, userGrantable: registry?.userGrantable.has(provider.plugin) })) continue;
      try {
        const contributed = await provider.fn({ projects: allowed, user: user ? { id: user.id, isAdmin: admin } : null });
        for (const raw of Array.isArray(contributed) ? contributed : []) {
          const clean = sanitizeIndicator(raw, projectIds);
          if (!clean) continue;
          const countKey = `${provider.plugin}:${raw.projectId}`;
          const count = pluginProjectCounts.get(countKey) ?? 0;
          const current = indicatorMap.get(raw.projectId) ?? [];
          if (count >= MAX_INDICATORS_PER_PLUGIN || current.length >= MAX_INDICATORS_PER_PROJECT) continue;
          current.push({ plugin: provider.plugin, ...clean });
          indicatorMap.set(raw.projectId, current);
          pluginProjectCounts.set(countKey, count + 1);
        }
      } catch (error) {
        ctx.log.warn(`plugin ${provider.plugin} failed to project Project indicators: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const users = admin && d.users ? new Map(d.users.list().filter((item) => !item.is_admin).map((item) => [item.id, item])) : null;
    return c.json(allowed.map((project) => {
      const assigned = users && d.userProjects
        ? d.userProjects.forProject(project.id).flatMap((id) => users.get(id) ? [users.get(id)!] : [])
        : [];
      return {
        projectId: project.id,
        ...(admin ? { members: {
          total: assigned.length,
          samples: assigned.slice(0, MAX_MEMBER_SAMPLES).map(({ id, username, name, avatar }) => ({ id, username, name, avatar })),
        } } : {}),
        indicators: indicatorMap.get(project.id) ?? [],
      };
    }));
  });
  // Project-centric access projection. Assignment writes keep using the canonical /users/:id/projects
  // routes so there is still only one mutation contract.
  //
  // The DEFAULT answer is the account-id list it has always been; `?view=profiles` is an opt-in that
  // asks the same authorized membership for the bounded identity a member row renders. It is additive
  // on purpose: a client that predates the option keeps the array of numbers it was written against.
  //
  // The option changes the SHAPE, never the audience. Both views answer the one membership authority
  // above, so a managed project's own members read it and everyone else is refused — which is the point
  // of the profile view: membership here grants access to every file, worktree and stored credential in
  // the shared environment, and a bare number never let a member check who that is. It lists only
  // accounts ALREADY assigned to this project, so it is not a way to enumerate the instance directory —
  // `GET /users` remains admin-only.
  app.get('/projects/:id/users', (c) => {
    if (!d.projects || !d.userProjects || !d.users) return c.json({ error: 'projects unavailable' }, 400);
    const id = Number(c.req.param('id'));
    const project = d.projects.get(id);
    if (!project) return c.json({ error: 'project not found' }, 404);
    if (project.executionKind === 'managed' ? !canAccessProject(c, id) : notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const members = d.userProjects.forProject(id);
    if (c.req.query('view') !== 'profiles') return c.json(members);
    // `UserStore.delete` clears `user_projects` in the same transaction as the account row, so every
    // membership id resolves; the flatMap only spells that invariant out.
    return c.json(members.flatMap((userId): ProjectMemberView[] => {
      const user = d.users!.get(userId);
      return user ? [{ id: user.id, username: user.username, name: user.name, email: user.email, avatar: user.avatar }] : [];
    }));
  });
  // Browse the server's directory tree to pick a new project's path (the new-project file manager).
  // Admin-only — it lists directory names outside any project root, so it sits behind the same gate as
  // project registration. Read-only and directory-only: never returns file contents.
  app.get('/fs/dirs', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const q = c.req.query('path');
    try { return c.json(listDirs(q && q.trim() ? q : homedir())); }
    catch { return c.json({ error: 'cannot read directory' }, 400); }
  });
  app.post('/fs/dirs', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const { parent, name } = await parseBody(c, createDirectorySchema);
    try { return c.json(createDir(parent, name), 201); }
    catch (error) {
      if (error instanceof CreateDirError) {
        if (error.code === 'exists') return c.json({ error: 'directory already exists' }, 409);
        if (error.code === 'invalid-name') return c.json({ error: 'invalid directory name' }, 400);
        if (error.code === 'invalid-parent') return c.json({ error: 'invalid parent directory' }, 400);
        if (error.code === 'forbidden') return c.json({ error: 'cannot create directory' }, 403);
      }
      return c.json({ error: 'cannot create directory' }, 500);
    }
  });
  app.post('/projects', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    // Authorization before validation, the order /fs/dirs uses: an account that may create neither kind of
    // project is refused without being told what the body should look like. A daemon with no user store
    // has no actor to ask and stays as open as it has always been.
    const actor = c.get('user');
    if (actor && !actor.is_admin && !actor.can_create_projects) return c.json({ error: 'project creation is not permitted' }, 403);
    const body = await parseBody(c, createProjectSchema);
    if (body.executionKind === 'managed') {
      if (!actor) return c.json({ error: 'project creation is not permitted' }, 403);
      try {
        const created = d.projects.createForUser(actor.id, body);
        // A managed project IS its environment: created and left stopped, it can hold nothing and run
        // nothing until someone presses start. The start is enqueued as part of the creation, and it is
        // the ordinary start operation, so the one operation the caller follows carries the container
        // work and the progress window shows it. Explicit stop and start stay what they are afterwards.
        const environmentOperationId = await startNewEnvironment(ctx, d, created.id, actor.id);
        return c.json({ ...await toProjectView(created), ...(environmentOperationId ? { environmentOperationId } : {}) }, 201);
      }
      catch (error) {
        if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return c.json({ error: 'slug taken' }, 409);
        if (error instanceof Error && error.message === PROJECT_LIMIT_REACHED) return c.json({ error: error.message }, 409);
        throw error;
      }
    }
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    try { return c.json(await toProjectView(d.projects.create(body)), 201); }
    catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return c.json({ error: 'slug taken' }, 409);
      throw error;
    }
  });
  app.post('/projects/default', async (c) => {
    const actor = c.get('user');
    if (!actor) return c.json({ error: 'forbidden' }, 403);
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 503);
    try { return c.json(await toProjectView(d.projects.ensureDefault(actor.id))); }
    catch (error) {
      // The same store limit is a 409 on POST /projects; it is reachable here once an administrator
      // lowers the limit below the account's current managed count.
      if (error instanceof Error && error.message === PROJECT_LIMIT_REACHED) return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  // Host path changes remain admin-only; managed metadata belongs to all project members.
  app.patch('/projects/:id', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const id = Number(c.req.param('id'));
    const cur = d.projects.get(id);
    if (!cur) return c.json({ error: 'project not found' }, 404);
    if (cur.executionKind === 'managed' ? !canAccessProject(c, id) : notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const b = await parseBody(c, updateProjectSchema);
    if (cur.executionKind === 'managed' && b.path !== undefined) return c.json({ error: 'managed projects do not have a host path' }, 400);
    const patch: { path?: string; notes?: string; icon?: string; memoryShared?: boolean } = {};
    if (typeof b.path === 'string' && b.path.trim()) patch.path = b.path.trim();
    if (typeof b.notes === 'string') patch.notes = b.notes;
    // Icon is a project-relative image path. '' clears it; anything else must resolve to a real image
    // file inside the project root (guards against path traversal / pointing at a non-image).
    if (typeof b.icon === 'string') {
      if (b.icon !== '') {
        if (cur.executionKind === 'managed') {
          const root = managedGuestRoot(cur.slug, id);
          const path = posix.resolve(root, b.icon);
          if (!isProjectImageExtension(b.icon) || b.icon.includes('\0') || posix.isAbsolute(b.icon) || !path.startsWith(`${root}/`)) {
            return c.json({ error: 'invalid icon path' }, 400);
          }
          const actor = c.get('user');
          if (!actor) return c.json({ error: 'forbidden' }, 403);
          const sandbox = (await d.plugins?.get())?.control('sandbox');
          if (!sandbox) return c.json({ error: 'project environment provider unavailable' }, 503);
          try {
            const resolved = await runManagedProjectCommand(sandbox, { kind: 'managed', projectId: id }, actor.id,
              { type: 'argv', file: '/usr/bin/realpath', args: ['--zero', '--canonicalize-existing', '--', path] },
              { cwd: root, maxBuffer: 8192, signal: c.req.raw.signal });
            const parts = resolved.stdout.split('\0');
            if (parts.length !== 2 || parts[1] !== '' || !parts[0]?.startsWith(`${root}/`)) {
              return c.json({ error: 'invalid icon path' }, 400);
            }
            const result = await sandbox.projectFiles({ project: { kind: 'managed', projectId: id }, accountUserId: actor.id,
              operation: { kind: 'stat', path: parts[0] } });
            if (result.kind !== 'stat') throw new Error('guest icon validation returned an invalid response');
            if (!result.entry || result.entry.kind !== 'file' || !posix.resolve(result.entry.path).startsWith(`${root}/`)) {
              return c.json({ error: 'invalid icon path' }, 400);
            }
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 1) return c.json({ error: 'invalid icon path' }, 400);
            ctx.log.warn(`managed project icon validation failed: ${error instanceof Error ? error.message : String(error)}`);
            return c.json({ error: 'project environment file validation unavailable' }, 503);
          }
        } else if (!isProjectImage(cur.path, b.icon)) return c.json({ error: 'invalid icon path' }, 400);
      }
      patch.icon = b.icon;
    }
    if (typeof b.memoryShared === 'boolean') patch.memoryShared = b.memoryShared;
    return c.json(await toProjectView(d.projects.update(id, patch)!));
  });
  // Adopting is not metadata editing: it changes where the project's directory lives and hands the
  // project's execution to the sandbox, so it has its own admin-only door rather than a PATCH field.
  // `{ undo: true }` is the way back and is refused once the environment has taken the directory.
  app.post('/projects/:id/adopt', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    // The daemon's own checkout is the one project that must never be moved into an environment. The
    // store cannot tell which row that is, so the refusal lives where the home project is known.
    if (id === d.project.id) return c.json({ error: 'cannot adopt the home project' }, 400);
    const raw = (await c.req.text()).trim();
    const { undo } = raw ? adoptProjectSchema.parse(JSON.parse(raw)) : {};
    try {
      if (!undo) return c.json(await toProjectView(d.projects.adoptAsManaged(id)));
      const project = d.projects.get(id);
      // The sandbox moves the directory into the project's workspace volume on the first start of the
      // environment, and after that a rollback would hand the project back pointing at a path that no
      // longer holds it. So the environment is asked before the row is reversed.
      if (project && project.adoptedPath !== null) {
        const actor = c.get('user');
        const sandbox = actor ? (await d.plugins?.get().catch(() => undefined))?.control('sandbox') : undefined;
        if (!sandbox) return c.json({ error: 'project environment provider unavailable' }, 503);
        const environment = await sandbox.environmentFor({ project: { kind: 'managed', projectId: id }, accountUserId: actor.id });
        if (environment.state !== 'unprovisioned') return c.json({ error: 'the project environment has taken the adopted directory' }, 409);
      }
      return c.json(await toProjectView(d.projects.releaseAdopted(id)));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'project not found') return c.json({ error: message }, 404);
      if ([PROJECT_ALREADY_MANAGED, PROJECT_NOT_ADOPTED, 'project deletion is pending'].includes(message)) return c.json({ error: message }, 409);
      if (message === 'slug is reserved by the project environment') return c.json({ error: message }, 400);
      throw error;
    }
  });
  // The project's shared-memory share list (admin-only). Empty = every project member shares the pool.
  app.get('/projects/:id/memory-members', (c) => {
    if (!d.projects || !d.userProjects) return c.json({ error: 'projects unavailable' }, 400);
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    if (!d.projects.get(id)) return c.json({ error: 'project not found' }, 404);
    return c.json(d.userProjects.memoryMembers(id));
  });
  // Replace the share list WHOLESALE (admin-only). Every userId must be an existing account AND an
  // assigned project member — a share grant can never exceed project access.
  app.put('/projects/:id/memory-members', async (c) => {
    if (!d.projects || !d.userProjects) return c.json({ error: 'projects unavailable' }, 400);
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    if (!d.projects.get(id)) return c.json({ error: 'project not found' }, 404);
    const { userIds } = await parseBody(c, memoryMembersSchema);
    for (const userId of [...new Set(userIds)]) {
      if (!d.users?.get(userId)) return c.json({ error: `user ${userId} not found` }, 404);
      if (!d.userProjects.canAccess(userId, id)) return c.json({ error: `user ${userId} is not a project member` }, 400);
    }
    d.userProjects.setMemoryMembers(id, userIds);
    return c.json(d.userProjects.memoryMembers(id));
  });
  // Remove a project from Elowen's core registry and access grants, but never touch files on disk.
  // Loaded plugins receive the lifecycle callback before the row disappears; plugins disabled at deletion
  // time must detect the missing Project in their own boot reconciliation when next enabled.
  app.delete('/projects/:id', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const id = Number(c.req.param('id'));
    if (id === d.project.id) return c.json({ error: 'cannot remove the home project' }, 400);
    const target = d.projects.get(id);
    if (!target) return c.json({ error: 'project not found' }, 404);
    if (target.executionKind === 'managed' ? !(c.get('user') && d.userProjects?.canManage(c.get('user').id, id)) : notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    // DELETE carries a body only when the caller wants idempotency or a stale-view check. Clients send a
    // JSON content-type even for a bodyless delete, so the empty body is decided on the payload itself;
    // a malformed or wrongly shaped one still fails like every other validated body.
    const raw = (await c.req.text()).trim();
    const body = raw ? deleteProjectSchema.parse(JSON.parse(raw)) : {};
    const registry = await d.plugins?.get().catch(() => undefined);
    if (target.executionKind === 'managed') {
      const sandbox = registry?.control('sandbox');
      if (!sandbox) return c.json({ error: 'project environment provider unavailable' }, 503);
      const actor = c.get('user');
      if (!actor) return c.json({ error: 'forbidden' }, 403);
      // The environment provider owns the durable deletion intent: it records the core `beginDeletion`
      // inside the same transaction as the enqueued operation. Recording it a second time here would
      // re-mark an already finished project as deleting when an idempotent retry returns its prior
      // operation, so core only forwards the caller's idempotency key and expected generation.
      try {
        const operation = await sandbox.requestEnvironment({ project: { kind: 'managed', projectId: id }, accountUserId: actor.id, action: { kind: 'delete' }, ...body });
        return c.json({ operation }, 202);
      } catch (error) {
        const refusal = environmentRefusal(error);
        if (!refusal) throw error;
        return c.json(refusal, 409);
      }
    }
    for (const handler of registry?.projectRemovedHandlers ?? []) {
      try { await handler.fn(id); }
      catch (error) {
        ctx.log.warn(`plugin ${handler.plugin} failed to handle removed project ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    d.projects.remove(id);
    return c.json({ ok: true });
  });
  app.get('/projects/:id/git', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = d.projects.get(Number(c.req.param('id')));
    if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    if (p.executionKind === 'managed') {
      const actor = c.get('user');
      if (!actor) return c.json({ error: 'forbidden' }, 403);
      const sandbox = (await d.plugins?.get().catch(() => undefined))?.control('sandbox');
      if (!sandbox) return c.json({ error: 'project environment provider unavailable' }, 503);
      // Reading a project's Overview must never START anything. The execution path below provisions an
      // environment that has none and then waits up to half a minute for the container, which is the
      // right thing when somebody asked to RUN something and the wrong thing when a tab merely opened.
      // A project whose environment is not running answers that plainly and costs one database read.
      const environment = await sandbox.environmentFor({ project: { kind: 'managed', projectId: p.id }, accountUserId: actor.id })
        .catch((error: unknown) => {
          ctx.log.warn(`managed project environment state unavailable: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
      if (!environment) return c.json({ error: 'project environment Git inspection unavailable' }, 503);
      if (environment.state !== 'running') return c.json({ error: 'project environment is not running' }, 409);
      const projectRoot = managedGuestRoot(p.slug, p.id);
      try {
        const reader = new RealGitReader(async (file, args, options) =>
          runManagedProjectCommand(sandbox, { kind: 'managed', projectId: p.id }, actor.id,
            { type: 'argv', file, args: ['-c', 'core.fsmonitor=false', ...args] }, { ...options, cwd: projectRoot, signal: c.req.raw.signal }), true);
        return c.json(await reader.read(projectRoot));
      } catch (error) {
        ctx.log.warn(`managed project Git inspection failed: ${error instanceof Error ? error.message : String(error)}`);
        return c.json({ error: 'project environment Git inspection unavailable' }, 503);
      }
    }
    if (!d.git) return c.json({ error: 'projects unavailable' }, 400);
    return c.json(await d.git.read(p.path));
  });

}
