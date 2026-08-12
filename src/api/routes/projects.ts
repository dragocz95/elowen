import { homedir } from 'node:os';
import { listDirs, isProjectImage } from '../../integrations/projectFiles.js';
import { parseBody } from '../validation.js';
import { createProjectSchema, updateProjectSchema } from '../schemas/projects.js';
import type { ElowenApp, RouteContext } from '../context.js';

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
  // Edit a project's path / Pilot notes (slug stays immutable). Admin-only, like registration.
  app.patch('/projects/:id', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    const cur = d.projects.get(id);
    if (!cur) return c.json({ error: 'project not found' }, 404);
    const b = await parseBody(c, updateProjectSchema);
    const patch: { path?: string; notes?: string; icon?: string; pr_enabled?: boolean | null } = {};
    if (typeof b.path === 'string' && b.path.trim()) patch.path = b.path.trim();
    if (typeof b.notes === 'string') patch.notes = b.notes;
    // Icon is a project-relative image path. '' clears it; anything else must resolve to a real image
    // file inside the project root (guards against path traversal / pointing at a non-image).
    if (typeof b.icon === 'string') {
      if (b.icon !== '' && !isProjectImage(cur.path, b.icon)) return c.json({ error: 'invalid icon path' }, 400);
      patch.icon = b.icon;
    }
    // Tri-state PR-flow override: null = inherit the global default, a boolean = force on/off. Only a
    // boolean or explicit null is accepted; an absent key leaves it unchanged.
    if (b.pr_enabled === null || typeof b.pr_enabled === 'boolean') patch.pr_enabled = b.pr_enabled;
    return c.json(d.projects.update(id, patch));
  });
  // Remove a project from elowen entirely: cascades to its tasks, missions, agents and access grants
  // (ProjectStore.remove), but never touches the files on disk. Admin-only; the daemon's home project
  // can't be removed (it's where the daemon itself lives).
  app.delete('/projects/:id', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    if (id === d.project.id) return c.json({ error: 'cannot remove the home project' }, 400);
    if (!d.projects.get(id)) return c.json({ error: 'project not found' }, 404);
    // Stop every live agent this project drives BEFORE the transactional cascade removes its rows —
    // otherwise a running tmux session/embedded worker keeps editing a checkout whose project the UI
    // already shows as gone. A mission's worktree also leaks (missionGit resolves it via the epic TASK
    // row, which the cascade deletes), so every mission is freed here too, not just the running ones.
    // Mirrors the epic-delete teardown at DELETE /tasks/:id.
    for (const t of d.tasks.list({ project_id: id })) {
      if (t.type === 'epic') {
        const missionId = `m-${t.id}`;
        const mission = d.missions.get(missionId);
        if (mission && mission.state !== 'disengaged') await d.engine?.disengage(missionId).catch(() => { /* best-effort */ });
        await d.missionGit?.cleanup(missionId).catch(() => { /* best-effort */ });
        continue;
      }
      if (t.status !== 'in_progress') continue;
      const agent = t.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
      if (!agent) continue;
      const session = `elowen-${agent}`;
      if (d.brainWorkers?.isLive(session)) await d.brainWorkers.abort(session).catch(() => { /* already gone */ });
      else await d.tmux.kill(session).catch(() => { /* already gone */ });
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
