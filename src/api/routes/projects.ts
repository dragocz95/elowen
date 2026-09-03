import { homedir } from 'node:os';
import { listDirs, isProjectImage } from '../../integrations/projectFiles.js';
import { parseBody } from '../validation.js';
import { createProjectSchema, updateProjectSchema, memoryMembersSchema } from '../schemas/projects.js';
import type { ElowenApp, RouteContext } from '../context.js';
import type { PluginProjectIndicator } from '../../plugins/api.js';
import { isPluginAllowedForUser } from '../../shared/pluginAccess.js';

const MAX_MEMBER_SAMPLES = 3;
const MAX_INDICATORS_PER_PLUGIN = 3;
const MAX_INDICATORS_PER_PROJECT = 8;
const INDICATOR_TONES = new Set(['muted', 'accent', 'success', 'warning', 'danger']);

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
  app.get('/projects', (c) => {
    const all = d.projects ? d.projects.list() : [];
    if (!d.userProjects || !d.users) return c.json(all);
    const u = c.get('user');
    if (u && d.userProjects.isAdmin(u.id)) return c.json(all);
    const allowed = u ? new Set(d.userProjects.forUser(u.id)) : new Set<number>();
    return c.json(all.filter((p) => allowed.has(p.id)));
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
  // Project-centric access projection for the administrator's Project detail. Assignment writes keep
  // using the canonical /users/:id/projects routes so there is still only one mutation contract.
  app.get('/projects/:id/users', (c) => {
    if (!d.projects || !d.userProjects || !d.users) return c.json({ error: 'projects unavailable' }, 400);
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    if (!d.projects.get(id)) return c.json({ error: 'project not found' }, 404);
    return c.json(d.userProjects.forProject(id));
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
  app.post('/projects', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    // Only the admin may register projects (when multi-user auth is on).
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const { slug, path, notes } = await parseBody(c, createProjectSchema);
    try { return c.json(d.projects.create({ slug, path, notes }), 201); }
    catch { return c.json({ error: 'slug taken' }, 409); }
  });
  // Edit a project's path / notes (slug stays immutable). Admin-only, like registration.
  app.patch('/projects/:id', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    const cur = d.projects.get(id);
    if (!cur) return c.json({ error: 'project not found' }, 404);
    const b = await parseBody(c, updateProjectSchema);
    const patch: { path?: string; notes?: string; icon?: string; memoryShared?: boolean } = {};
    if (typeof b.path === 'string' && b.path.trim()) patch.path = b.path.trim();
    if (typeof b.notes === 'string') patch.notes = b.notes;
    // Icon is a project-relative image path. '' clears it; anything else must resolve to a real image
    // file inside the project root (guards against path traversal / pointing at a non-image).
    if (typeof b.icon === 'string') {
      if (b.icon !== '' && !isProjectImage(cur.path, b.icon)) return c.json({ error: 'invalid icon path' }, 400);
      patch.icon = b.icon;
    }
    if (typeof b.memoryShared === 'boolean') patch.memoryShared = b.memoryShared;
    return c.json(d.projects.update(id, patch));
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
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    if (id === d.project.id) return c.json({ error: 'cannot remove the home project' }, 400);
    if (!d.projects.get(id)) return c.json({ error: 'project not found' }, 404);
    const registry = await d.plugins?.get().catch(() => undefined);
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
    if (!d.projects || !d.git) return c.json({ error: 'projects unavailable' }, 400);
    const p = d.projects.get(Number(c.req.param('id')));
    if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    return c.json(await d.git.read(p.path));
  });

}
