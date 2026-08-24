import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chooseUploadProject, createUploadTarget, uploadCandidates, type UploadProject } from '../../brain/chatUploads.js';
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
  const { d, forbidden } = route;

  /** The projects this account may write into, as upload candidates — the same decision a platform room's
   *  attachment goes through (see brain/channelAttachments.ts), which is why the rule itself is shared. */
  const candidatesFor = (userId: number): UploadProject[] => {
    if (!d.projects) return [];
    return uploadCandidates({
      all: d.projects.list(),
      assigned: d.userProjects?.forUser(userId) ?? [],
      isAdmin: d.users?.get(userId)?.is_admin === true,
    });
  };

  app.post('/brain/uploads', async (c) => {
    // Writing a file into somebody's project is a mutation, and every other brain mutation is closed to
    // an agent-scoped token. An upload has no reason to be the one exception.
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);

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
      target = createUploadTarget(project.path, u.username, c.req.query('name') ?? '', new Date());
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    // Built before the body is touched so that a failure anywhere below still has something that owns
    // the descriptor: destroying the sink closes it, where an early throw would leak it.
    const sink = createWriteStream(target.path, { fd: target.fd, autoClose: true });
    try {
      await pipeline(Readable.fromWeb(raw as Parameters<typeof Readable.fromWeb>[0]), sink);
    } catch (e) {
      // A half-written file is worse than none: the agent would read a truncated document and report on
      // it as if it were whole. Remove it and let the caller retry.
      sink.destroy();
      await rm(target.path, { force: true }).catch(() => {});
      logger('brain-uploads').warn(`upload of "${target.name}" failed: ${(e as Error).message}`);
      return c.json({ error: 'upload failed' }, 500);
    }

    let size: number;
    try {
      size = (await stat(target.path)).size;
    } catch (e) {
      // The bytes may well be on disk, but we cannot say what landed. Reporting a confident `size: 0`
      // with HTTP 200 would hand back an upload that looks fine and send the agent to read a file we
      // could not even measure.
      logger('brain-uploads').warn(`upload of "${target.name}" could not be measured: ${(e as Error).message}`);
      return c.json({ error: 'upload could not be verified' }, 500);
    }

    return c.json({
      path: target.path,
      relative: target.relative,
      name: target.name,
      size,
      project: { id: project.id, slug: project.slug },
    });
  });
}
