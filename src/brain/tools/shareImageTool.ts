import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { assertPathAllowed, isAllAccess } from '../../plugins/pathGuard.js';
import { currentSessionId, currentTurnToken, currentIdentity } from '../../plugins/policyContext.js';
import { sniffImageMime, storeImageByContent, type StoredChatImage } from '../chatImages.js';
import type { BrainStore } from '../../store/brainStore.js';

/** Above this a picture stops being a picture and starts being a payload: it has to be read into memory,
 *  base64'd for a platform upload, and pushed down whatever connection the reader is on. Well past any
 *  screenshot; a full-page capture of a long page lands around 2 MB. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Per turn. A model that decides screenshots are the answer can otherwise turn one reply into a gallery,
 *  and on a chat platform that is N separate uploads. Matches the platforms' own `maxUploadImages`. */
const MAX_PER_TURN = 4;

export interface ShareImageDeps {
  store: BrainStore;
  /** Where shared bytes are kept. Absent (in-memory store) the tool refuses rather than pretending. */
  imagesDir?: string;
}

function text(message: string) {
  return { content: [{ type: 'text' as const, text: message }], details: {} };
}

/** Let the agent put an image in front of the user — a browser screenshot, a rendered chart, a file from
 *  the repo. Tools that produce images hand them to the MODEL (they arrive as image blocks in a tool
 *  result); nothing before this could forward one to the person actually asking, so the answer to "what
 *  does the page look like now" was always the model's word for it.
 *
 *  Deliberately explicit rather than automatic. Debugging a page means a screenshot every few seconds, and
 *  a rule that forwarded each one would bury the conversation and, on a chat platform, fire an upload for
 *  every single one. */
export function buildShareImageTool(deps: ShareImageDeps) {
  // Keyed on the turn scope's own identity, which is a fresh object per turn — the session id is the same
  // for the whole conversation, so budgeting on it would spend the allowance once and refuse ever after.
  const spent = new WeakMap<object, number>();
  return defineTool({
    name: 'ShareImage',
    label: 'Share image',
    description: 'Show the user an image in the conversation — a screenshot you just took, a chart you rendered, a photo or an image file from the repo. Use it when what you are describing is easier to SEE than to read: a layout that looks wrong, a rendered page, a photo the user asked about; do not use it to echo back an image the user themselves sent, and do not attach one to every step of a debugging session. Pass `path` for a file on disk, or `latest: true` for the image the most recent tool call returned to you (a screenshot taken without a file path exists only in that result). Exactly one of the two, and `caption` is one short line saying what they are looking at. Sharing by `path` is restricted to the verified operator on an unrestricted session, the file must stay inside your accessible repositories, and it must really be a png, jpeg, gif or webp (sniffed from the bytes, not the extension) under 10 MB — anything else comes back as a refusal, not a share. At most 4 images per turn; after that describe the rest in words. The image appears in THIS conversation — the web chat and any connected platform — so from a sub-agent it reaches the panel for that sub-agent, not the parent conversation. It does not go back into your own context, which already has it, so do not describe it back in full afterwards.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Absolute path to an image file (png, jpeg, gif or webp).' })),
      latest: Type.Optional(Type.Boolean({ description: 'Share the image the most recent tool call returned instead of a file on disk.' })),
      caption: Type.Optional(Type.String({ description: 'One short line telling the user what they are looking at.' })),
    }),
    execute: async (_id: string, p: { path?: string; latest?: boolean; caption?: string }) => {
      const dir = deps.imagesDir;
      if (!dir) return text('ShareImage: this session has nowhere to store images, so it cannot share them.');
      if ((p.path === undefined) === (p.latest !== true)) {
        return text('ShareImage: pass exactly one of `path` (a file on disk) or `latest: true` (the image the last tool returned).');
      }
      const sessionId = currentSessionId();
      const turn = currentTurnToken();
      if (!sessionId || !turn) return text('ShareImage: no conversation to share into.');
      const used = spent.get(turn) ?? 0;
      if (used >= MAX_PER_TURN) {
        return text(`ShareImage: already shared ${MAX_PER_TURN} images in this turn — say what the rest show instead.`);
      }

      const stored = p.latest === true ? latestToolImage(deps.store, sessionId) : fromDisk(p.path!, dir);
      if (typeof stored === 'string') return text(stored);
      spent.set(turn, used + 1);
      const caption = p.caption?.trim();
      return {
        content: [{ type: 'text' as const, text: `Shared the image with the user${caption ? ` (${caption})` : ''}. They can see it; do not describe it back to them in full.` }],
        // The client-bound half. `events.ts` turns this into an `image` event for live surfaces and
        // `messageView` rebuilds the same picture from it after a reload.
        details: { sharedImage: { ...stored, ...(caption ? { caption } : {}) } },
      };
    },
  });
}

/** Take the picture the last tool handed the model. It is already on disk — every tool result's image
 *  bytes are externalized as the turn is persisted — so this is a lookup, not a copy. */
function latestToolImage(store: BrainStore, sessionId: string): StoredChatImage | string {
  const found = store.latestToolImage(sessionId);
  if (!found) return 'ShareImage: no tool has returned an image in this conversation yet. Take a screenshot first, or pass `path`.';
  return found;
}

/** Take a file the caller names. Every check here is about what the WEB will later serve from the same
 *  origin as the app, so none of them may be skipped: the path must be inside the caller's own roots, the
 *  size must be sane, and the type must come from the bytes rather than the name. */
function fromDisk(rawPath: string, dir: string): StoredChatImage | string {
  // An all-access turn skips path roots entirely (pathGuard), so for those the guard below is the ONLY
  // boundary on which host file may be uploaded. `owner` covers the operator and every admin account
  // (see IdentityResolver.isOwner). Same authority, and the same reasoning, as the terminal tools.
  if (isAllAccess() && currentIdentity()?.owner !== true) {
    return 'ShareImage: sharing a file by path is not available to you. Use `latest: true` for an image a tool produced in this conversation.';
  }
  let path: string;
  try { path = assertPathAllowed(rawPath); }
  catch (e) { return `ShareImage: ${(e as Error).message}`; }

  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return `ShareImage: ${basename(path)} is not a file.`;
    size = stat.size;
  } catch { return `ShareImage: cannot find ${basename(path)}.`; }
  // Checked BEFORE the read, so a huge file is refused rather than pulled into memory to be refused.
  if (size > MAX_BYTES) {
    return `ShareImage: ${basename(path)} is ${(size / 1048576).toFixed(1)} MB, over the ${MAX_BYTES / 1048576} MB limit.`;
  }

  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch { return `ShareImage: cannot read ${basename(path)}.`; }
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) return `ShareImage: ${basename(path)} is not a png, jpeg, gif or webp image.`;

  const stored = storeImageByContent(dir, bytes.toString('base64'), mimeType);
  return stored ?? `ShareImage: could not store ${basename(path)}.`;
}
