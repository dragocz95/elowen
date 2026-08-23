import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chooseUploadProject, resolveUploadTarget, type UploadProject } from '../../brain/chatUploads.js';
import { logger } from '../../shared/logger.js';
import type { ElowenApp } from '../context.js';
import type { BrainRouteContext } from './brainRouteContext.js';

/** Uploading a file into a conversation.
 *
 *  The body is the file itself, NOT multipart. A multipart parser has to materialize the part before it
 *  can hand it over, which would put the whole file in the daemon's heap and quietly reinstate the size
 *  ceiling this feature exists to remove. One file per request, its name in the query string, its bytes
 *  streamed straight to disk.
 *
 *  There is deliberately no type allow-list and no size cap. Both existed only because an attachment had
 *  to fit inside the message; a file in a project is just a file, and `plugins/files`' Read already
 *  decides what it can do with one.
 */
export function registerBrainUploadRoutes(app: ElowenApp, route: BrainRouteContext): void {
  const { d } = route;

  /** The projects this account may write into, as upload candidates. An admin with no explicit
   *  assignment administers every project, matching how resolvePolicy treats one for path access. */
  const candidatesFor = (userId: number): UploadProject[] => {
    if (!d.projects) return [];
    const all = d.projects.list();
    const assigned = d.userProjects?.forUser(userId) ?? [];
    if (assigned.length > 0) {
      const wanted = new Set(assigned);
      return all.filter((p) => wanted.has(p.id)).map((p) => ({ id: p.id, slug: p.slug, path: p.path }));
    }
    const isAdmin = d.users?.get(userId)?.is_admin === true;
    return isAdmin ? all.map((p) => ({ id: p.id, slug: p.slug, path: p.path })) : [];
  };

  app.post('/brain/uploads', async (c) => {
    const u = c.get('user');
    const raw = c.req.raw.body;
    if (!raw) return c.json({ error: 'request body required' }, 400);

    let project: UploadProject;
    try {
      project = chooseUploadProject(candidatesFor(u.id), d.project.path);
    } catch (e) {
      // A genuine configuration problem the caller cannot fix by retrying, so it says what to do.
      return c.json({ error: (e as Error).message }, 409);
    }

    let target;
    try {
      target = resolveUploadTarget(project.path, u.username, c.req.query('name') ?? '', new Date());
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    try {
      await pipeline(Readable.fromWeb(raw as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(target.path));
    } catch (e) {
      // A half-written file is worse than none: the agent would read a truncated document and report on
      // it as if it were whole. Remove it and let the caller retry.
      await rm(target.path, { force: true }).catch(() => {});
      logger('brain-uploads').warn(`upload of "${target.name}" failed: ${(e as Error).message}`);
      return c.json({ error: 'upload failed' }, 500);
    }

    const size = await stat(target.path).then((s) => s.size).catch(() => 0);
    return c.json({
      path: target.path,
      relative: target.relative,
      name: target.name,
      size,
      project: { id: project.id, slug: project.slug },
    });
  });
}
