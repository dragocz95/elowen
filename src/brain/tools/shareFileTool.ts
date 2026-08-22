import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { assertPathAllowed } from '../../plugins/pathGuard.js';
import { currentSessionId, currentTurnToken } from '../../plugins/policyContext.js';
import { chatFilesDir, storeFileByContent, type StoredChatFile } from '../chatFiles.js';

/** Large enough for normal documents, archives, and generated artifacts while staying below common chat
 *  upload ceilings and bounding the synchronous read + in-memory copy this local handoff necessarily makes. */
const MAX_BYTES = 25 * 1024 * 1024;

/** Matches ShareImage: one model turn may hand over a small set of deliberate artifacts, not dump a tree. */
const MAX_PER_TURN = 4;

export interface ShareFileDeps {
  /** The existing attachment root; general files are stored in its sibling `chat-files` directory. */
  imagesDir?: string;
}

function text(message: string) {
  return { content: [{ type: 'text' as const, text: message }], details: {} };
}

/** Let the agent hand a durable artifact to the web-chat user. Unlike ShareImage, the browser always treats
 *  these bytes as a download and never renders them from the application's origin. */
export function buildShareFileTool(deps: ShareFileDeps) {
  const spent = new WeakMap<object, number>();
  return defineTool({
    name: 'ShareFile',
    label: 'Share file',
    description: 'Give the user a file to download from the web conversation — a document, archive, generated report, HTML file, source bundle, or another artifact they should KEEP. Use ShareImage instead when an image is something the user should SEE directly in the conversation; use ShareFile when the deliverable should be saved to their device. Pass an absolute `path` and optionally one short `caption`. The path must stay inside the caller’s accessible repositories, and the file must be at most 25 MB. At most 4 files may be shared per turn. The bytes are copied into conversation storage and served only as an authenticated download; the original filename is preserved. This affordance is implemented by the web chat (including a sub-agent’s own panel); on another chat platform use its platform-specific file-upload tool instead.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path to the file the user should download.' }),
      caption: Type.Optional(Type.String({ description: 'One short line explaining what the file is.' })),
    }),
    execute: async (_id: string, p: { path: string; caption?: string }) => {
      if (!deps.imagesDir) return text('ShareFile: this session has nowhere to store files, so it cannot share them.');
      const sessionId = currentSessionId();
      const turn = currentTurnToken();
      if (!sessionId || !turn) return text('ShareFile: no conversation to share into.');
      const used = spent.get(turn) ?? 0;
      if (used >= MAX_PER_TURN) return text(`ShareFile: already shared ${MAX_PER_TURN} files in this turn — describe or bundle the rest instead.`);

      const stored = fromDisk(p.path, chatFilesDir(deps.imagesDir));
      if (typeof stored === 'string') return text(stored);
      spent.set(turn, used + 1);
      const caption = p.caption?.trim();
      return {
        content: [{ type: 'text' as const, text: `Shared ${stored.name} with the user as a download${caption ? ` (${caption})` : ''}. Do not replace it with a file:// link.` }],
        details: { sharedFile: { ...stored, ...(caption ? { caption } : {}) } },
      };
    },
  });
}

function fromDisk(rawPath: string, dir: string): StoredChatFile | string {
  // WHICH file may be published is decided by the path guard alone, exactly as it is for Read and Write.
  // There used to be an extra `owner` check here for all-access turns; it protected nothing, because an
  // all-access caller can already read that byte range with Read and paste it into the same conversation —
  // it only made sharing behave differently from reading, for the same person, on the same file.
  let path: string;
  try { path = assertPathAllowed(rawPath); }
  catch (e) { return `ShareFile: ${(e as Error).message}`; }

  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return `ShareFile: ${basename(path)} is not a file.`;
    size = stat.size;
  } catch { return `ShareFile: cannot find ${basename(path)}.`; }
  // Checked BEFORE readFileSync so an oversized artifact is refused without first allocating it in memory.
  if (size > MAX_BYTES) return `ShareFile: ${basename(path)} is ${(size / 1048576).toFixed(1)} MB, over the ${MAX_BYTES / 1048576} MB limit.`;

  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch { return `ShareFile: cannot read ${basename(path)}.`; }
  const stored = storeFileByContent(dir, bytes, basename(path));
  return stored ?? `ShareFile: could not store ${basename(path)}.`;
}
