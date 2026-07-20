import { homedir } from 'node:os';
import { listProjectFiles, listDirs, readProjectFile, writeProjectFile, readProjectBytes, createProjectFile, createProjectDir, deleteProjectEntry, renameProjectEntry, copyProjectEntry, projectFileAtHead, projectFileDiff, projectCommitDiff, projectCommitFiles, projectCommitFileDiff, projectCommitLog, projectChangedFiles, projectWorkingDiff, isProjectImage } from '../../integrations/projectFiles.js';
import { parseBody, queryInt } from '../validation.js';
import { createProjectSchema, updateProjectSchema, writeFileSchema, pathBodySchema, fromToSchema } from '../schemas/projects.js';
import type { Context } from 'hono';
import type { ElowenApp, RouteContext } from '../context.js';

/** Project registration + the in-app file editor (tree, read/write, raw bytes, file-manager ops) and
 *  read-only git surface (diff, head, commits, changed files). Paths are validated to stay inside the
 *  project root (projectFiles.safe); writes are gated to the project's assigned users. */
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
  app.delete('/projects/:id', (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    if (id === d.project.id) return c.json({ error: 'cannot remove the home project' }, 400);
    if (!d.projects.get(id)) return c.json({ error: 'project not found' }, 404);
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

  // --- Project file editor: tree, read, write, per-file diff. Paths are validated to stay inside
  // the project root (see projectFiles.safe); access is gated to the project's assigned users. ---
  const projectOf = (c: Context) => d.projects?.get(Number(c.req.param('id'))) ?? null;
  /** Resolve `:id` to a project the caller may access, or the error Response to return — folds the
   *  projects-unavailable (400) / not-found (404) / forbidden (403) triplet every handler repeated, so the
   *  tenancy gate lives in ONE place instead of ~16 copies. */
  const requireProject = (c: Context):
    { project: NonNullable<ReturnType<typeof projectOf>> } | { res: Response } => {
    if (!d.projects) return { res: c.json({ error: 'projects unavailable' }, 400) };
    const project = projectOf(c);
    if (!project) return { res: c.json({ error: 'project not found' }, 404) };
    if (!canAccessProject(c, project.id)) return { res: c.json({ error: 'forbidden' }, 403) };
    return { project };
  };
  app.get('/projects/:id/files', (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    return c.json(listProjectFiles(p.path));
  });
  app.get('/projects/:id/file', (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json(readProjectFile(p.path, path)); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.put('/projects/:id/file', async (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const b = await parseBody(c, writeFileSchema);
    try { writeProjectFile(p.path, b.path, b.content); return c.json({ ok: true }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  // Raw file bytes for binary previews (images). Content-type from extension; unknown → octet-stream.
  app.get('/projects/:id/raw', (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
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
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const b = await parseBody(c, pathBodySchema);
    try { createProjectFile(p.path, b.path); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.post('/projects/:id/dir', async (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const b = await parseBody(c, pathBodySchema);
    try { createProjectDir(p.path, b.path); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.post('/projects/:id/rename', async (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const b = await parseBody(c, fromToSchema);
    try { renameProjectEntry(p.path, b.from, b.to); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.post('/projects/:id/copy', async (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const b = await parseBody(c, fromToSchema);
    try { copyProjectEntry(p.path, b.from, b.to); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.delete('/projects/:id/entry', (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { deleteProjectEntry(p.path, path); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.get('/projects/:id/diff', async (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json({ diff: await projectFileDiff(p.path, path) }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.get('/projects/:id/head', async (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json({ content: await projectFileAtHead(p.path, path) }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.get('/projects/:id/commit/:hash', async (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const hash = c.req.param('hash');
    const [diff, files] = await Promise.all([projectCommitDiff(p.path, hash), projectCommitFiles(p.path, hash)]);
    return c.json({ diff, files });
  });
  app.get('/projects/:id/commit/:hash/diff', async (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json({ diff: await projectCommitFileDiff(p.path, c.req.param('hash'), path) }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.get('/projects/:id/commits', async (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    const limit = queryInt(c.req.query('limit'), { min: 1, max: 500, fallback: 30 });
    return c.json({ commits: await projectCommitLog(p.path, limit) });
  });
  app.get('/projects/:id/changed', async (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    return c.json({ changed: await projectChangedFiles(p.path) });
  });
  app.get('/projects/:id/changes', async (c) => {
    const gate = requireProject(c); if ('res' in gate) return gate.res;
    const p = gate.project;
    return c.json({ diff: await projectWorkingDiff(p.path) });
  });
}
