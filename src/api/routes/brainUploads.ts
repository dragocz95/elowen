import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chooseUploadProject, createUploadTarget, sanitizeUploadName, uploadCandidates, uploadRelativeDir, type UploadProject } from '../../brain/chatUploads.js';
import { streamGuestUpload } from '../../brain/managedArtifacts.js';
import { managedGuestRoot } from '../../shared/projectExecution.js';
import { logger } from '../../shared/logger.js';
import type { ElowenApp } from '../context.js';
import type { BrainRouteContext } from './brainRouteContext.js';

/** Uploading a file into a conversation.
 *
 *  The body is the file itself, NOT multipart. A multipart parser has to materialize the part before it
 *  can hand it over, which would put the whole file in the daemon's heap and quietly reinstate the size
 *  ceiling this feature exists to remove. One file per request, its name in the query string, its bytes
 *  streamed straight to disk — or, for a managed project, straight through the guest transport's chunked
 *  upload, which is the same property one hop further out.
 *
 *  There is deliberately no type allow-list and no size cap. Both existed only because an attachment had
 *  to fit inside the message; a file in a project is just a file, and `plugins/files`' Read already
 *  decides what it can do with one.
 *
 *  WHERE it goes is the conversation's business, not the client's. The browser sends an OPAQUE session
 *  id; the server checks that the session belongs to the caller, reads the project the conversation is
 *  actually running in, and re-checks that the account may write there. A client never names a project,
 *  an execution kind or a filesystem path — on either side of the host/guest line.
 */
export function registerBrainUploadRoutes(app: ElowenApp, route: BrainRouteContext): void {
  const { d } = route;

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

  /** A refusal that already knows its HTTP status, so the handler stays one straight line of resolution. */
  interface Refusal { error: string; status: 400 | 403 | 404 | 409 | 503 }
  const refused = (value: UploadProject | Refusal): value is Refusal => 'error' in value;

  /**
   * Which project this upload belongs in.
   *
   * The conversation is the authority when it has one: `brain_sessions.execution_ref` is the target its
   * turns actually run in, so a file attached to it has to land where the agent will look for it. The
   * ref names a project IDENTITY only — its `kind` is re-derived from the project row, because a row can
   * be migrated to managed execution long after a session recorded `{kind:'host'}` against it, and the
   * row is what says where the files are today.
   *
   * Only a conversation with no project of its own falls back to the account's candidate set.
   */
  const resolveProject = (userId: number, sessionId: string | undefined): UploadProject | Refusal => {
    const candidates = candidatesFor(userId);
    if (sessionId) {
      const session = d.brainStore?.getSession(sessionId);
      if (!session) return { error: 'unknown conversation', status: 404 };
      // The session id is opaque and guessable-adjacent; ownership is what makes it safe to act on.
      if (session.user_id !== userId) return { error: 'this conversation belongs to another account', status: 403 };
      let ref;
      try {
        ref = d.brainStore?.getProjectExecution(sessionId);
      } catch {
        return { error: 'this conversation has an unreadable project target — pick one for the conversation and try again', status: 409 };
      }
      if (ref?.projectId !== undefined) {
        // Re-check the ACL against the project the CONVERSATION names: a session may have been shared or
        // retargeted, and the upload is authorized for the account making it, not for the session.
        const allowed = candidates.find((p) => p.id === ref.projectId);
        if (!allowed) return { error: 'you cannot upload into this conversation’s project', status: 403 };
        return allowed;
      }
    }
    try {
      return chooseUploadProject(candidates, d.project.path);
    } catch (e) {
      // A genuine configuration problem the caller cannot fix by retrying, so it says what to do.
      return { error: (e as Error).message, status: 409 };
    }
  };

  /** The client's declared byte count. The guest transport opens its upload handle against a size, so the
   *  managed branch needs one before the first byte arrives; it is a CLAIM, and the commit is what proves
   *  the file. Bounded integer or nothing — a NaN would reach the provider as a broken handle. */
  const declaredSize = (raw: string | undefined): number | null => {
    if (raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };

  app.post('/brain/uploads', async (c) => {

    const u = c.get('user');
    const raw = c.req.raw.body;
    if (!raw) return c.json({ error: 'request body required' }, 400);

    const project = resolveProject(u.id, c.req.query('session'));
    if (refused(project)) return c.json({ error: project.error }, project.status);

    if (project.executionKind === 'managed') {
      const size = declaredSize(c.req.query('size'));
      if (size === null) return c.json({ error: 'a declared file size is required to upload into this project' }, 400);

      // Resolved LIVE, per request: a control retained across a plugin reload is invalid, and an absent
      // one is an unavailable dependency rather than a reason to fall back to a host path.
      const sandbox = (await d.plugins?.get().catch(() => undefined))?.control('sandbox');
      if (!sandbox) return c.json({ error: 'project environment provider unavailable' }, 503);

      const name = sanitizeUploadName(c.req.query('name') ?? '');
      const relativeDir = uploadRelativeDir(u.username, new Date());
      const stored = await streamGuestUpload(
        { sandbox, projectRef: { kind: 'managed', projectId: project.id }, accountUserId: u.id },
        {
          root: managedGuestRoot(project.slug, project.id),
          relativeDir,
          baseName: name,
          declaredSize: size,
          body: Readable.fromWeb(raw as Parameters<typeof Readable.fromWeb>[0]),
        },
      );
      if (typeof stored === 'string') {
        logger('brain-uploads').warn(`managed upload into project ${project.id} failed: ${stored}`);
        return c.json({ error: stored }, 500);
      }
      return c.json({ ...stored, project: { id: project.id, slug: project.slug } });
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
