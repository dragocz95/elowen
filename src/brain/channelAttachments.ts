import { closeSync, rmSync, writeSync } from 'node:fs';
import { chooseUploadProject, createUploadTarget, uploadCandidates, type UploadProject } from './chatUploads.js';

/** A file somebody attached to a message in a platform room.
 *
 *  The web has been able to do this for a while: the browser streams the bytes into the sender's project
 *  and the agent is handed a real path, so `plugins/files`' Read decides what to do with a PDF. A room
 *  could only carry base64 IMAGES; everything else became the text note `[Attachment: x.pdf (…)]` — the
 *  agent was told a file existed and given no way to open it. This module is the room's half of that one
 *  upload path, so "here is the PDF" behaves the same on both surfaces.
 *
 *  Everything here arrives from a platform and is therefore attacker-controlled: the sender chooses the
 *  file name, its size and the content type they declare. Name and containment are handled by the SAME
 *  `createUploadTarget` the web route uses (sanitized segment, exclusive `wx` create, containment asserted
 *  against the project root) rather than by a second sanitizer that could disagree with it.
 */

/** Largest single room attachment, in decoded bytes.
 *
 *  The web route deliberately has no size cap, and that is not an inconsistency to copy: it STREAMS the
 *  request body to disk, so a large upload costs disk, not memory. A platform attachment reaches the
 *  daemon as base64 inside a plugin call, which means the whole file is already in the heap before this
 *  module sees it. The ceiling is therefore a property of the transport, not a second opinion about what
 *  a user may upload. Generous enough for the documents people actually send into a chat. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Most attachments accepted from one message. Platforms already cap this far lower; the guard exists so
 *  one message cannot claim an unbounded number of file descriptors and day-directory entries. */
export const MAX_ATTACHMENTS = 10;

/** One inbound attachment as an adapter hands it over: the sender's file name, the bytes as base64, and
 *  the content type the platform reported. */
export interface ChannelAttachment {
  name: string;
  /** Base64 file content. */
  data: string;
  /** The platform's declared content type. Recorded in the turn text for the agent's benefit and NEVER
   *  used to decide anything: it is sender-controlled, the stored name comes from the sanitizer, and
   *  `plugins/files` sniffs the real type from magic bytes when it reads the file. An unknown or absent
   *  type is consequently not an error — refusing one would reject ordinary files (a `.zip` arrives as
   *  `application/octet-stream` on half the platforms) while blocking nothing an attacker cares about. */
  mimeType?: string;
}

/** Where a stored room attachment ended up — the absolute path is what the agent is given. */
export interface StoredChannelAttachment {
  name: string;
  path: string;
  relative: string;
  size: number;
  mimeType?: string;
}

export interface ChannelUploadDeps {
  /** Every registered project, for the candidate set. */
  projects?: { list(): UploadProject[] };
  /** The writer's project assignment. */
  userProjects?: { forUser(userId: number): number[] };
  /** Account lookup: the upload folder is named after the account, and an admin with no assignment may
   *  write anywhere. */
  users?: { get(userId: number): { username?: string; is_admin?: boolean } | null | undefined };
  /** The instance's configured workspace, which breaks a tie between several candidate projects. */
  projectPath?: () => string | undefined;
}

/** Store a room message's attachments in the WRITER's project and return their real paths.
 *
 *  Throws on every refusal rather than dropping the file, because a dropped attachment is precisely the
 *  defect being fixed: the sender sees their PDF in the channel, the agent never receives it, and nobody
 *  is told. The caller surfaces the message to the room.
 *
 *  `writerUserId` is the verified account behind the platform sender. There is intentionally no fallback
 *  to the room's owner: writing a stranger's file into the room opener's project under the opener's name
 *  would put attacker-supplied bytes inside somebody else's workspace on their behalf.
 */
export function storeChannelAttachments(
  deps: ChannelUploadDeps,
  writerUserId: number | undefined,
  attachments: readonly ChannelAttachment[],
  now: Date = new Date(),
): StoredChannelAttachment[] {
  if (attachments.length === 0) return [];
  if (writerUserId == null) {
    throw new Error('an attachment needs a verified sender — link your platform account first');
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`too many attachments in one message (${attachments.length}; the limit is ${MAX_ATTACHMENTS})`);
  }
  const account = deps.users?.get(writerUserId);
  if (!account) throw new Error('unknown account — the attachment has nowhere to go');
  const project = chooseUploadProject(
    uploadCandidates({
      all: deps.projects?.list() ?? [],
      assigned: deps.userProjects?.forUser(writerUserId) ?? [],
      isAdmin: account.is_admin === true,
    }),
    deps.projectPath?.() ?? '',
  );

  const stored: StoredChannelAttachment[] = [];
  for (const attachment of attachments) {
    const bytes = Buffer.from(String(attachment.data ?? ''), 'base64');
    if (bytes.length === 0) throw new Error(`attachment "${attachment.name}" arrived empty`);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment "${attachment.name}" is too large (${bytes.length} bytes; the limit is ${MAX_ATTACHMENT_BYTES})`);
    }
    // Same claim-then-write sequence as the web route: the descriptor is opened exclusively before any
    // byte is written, so a collision or a symlink planted at the name cannot redirect the write.
    const target = createUploadTarget(project.path, account.username ?? String(writerUserId), attachment.name, now);
    try {
      writeSync(target.fd, bytes);
    } catch (e) {
      // A half-written file is worse than none — the agent would read a truncated document and report on
      // it as though it were whole.
      rmSync(target.path, { force: true });
      throw e;
    } finally {
      closeSync(target.fd);
    }
    stored.push({
      name: target.name, path: target.path, relative: target.relative, size: bytes.length,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    });
  }
  return stored;
}

/** The line a stored attachment adds to the turn text. Model-facing (hence English, like every other
 *  core-authored turn marker) and shaped so the agent sees a path it can Read rather than a claim that a
 *  file exists somewhere. */
export function attachmentTurnNote(stored: readonly StoredChannelAttachment[]): string {
  return stored
    .map((f) => `[📎 ${f.name}${f.mimeType ? ` (${f.mimeType})` : ''} — saved to ${f.path}]`)
    .join('\n');
}
