import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainMessageImage } from '../shared/wireContract.js';
import { storeContentAddressed, sweepContentAddressed } from './contentAddressedStore.js';

/** An image in a conversation, kept on disk so it still shows after a reload — one the USER attached, or
 *  one a TOOL produced (a screenshot, a page render) and the agent shared back. Raw base64 deliberately
 *  never reaches `brain_messages` (see persistence.ts) — the row carries this reference instead, and the
 *  bytes live next to the database like avatars do. */
export interface StoredChatImage {
  /** File name inside the chat-images dir; also the path segment the read route accepts. */
  file: string;
  mimeType: string;
}

/** The four types the send schema admits (src/api/schemas/brain.ts) mapped to the extension on disk.
 *  Anything else never gets here, and is dropped rather than guessed at. */
const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** A stored name is exactly `<uuid>.<ext>` or `<sha256>.<ext>` — no separators, no traversal, nothing the
 *  caller chose. The two forms differ by WHO names the file, which is why both exist: a user attachment is
 *  a one-off event and gets a random name, while a tool's image is named by its own CONTENT so that
 *  writing it twice is the same write. That matters because a turn is persisted twice — once as pending
 *  rows the moment each message lands, then again from `agent_end` once the real run order is known — and
 *  a random name would leave an orphan file behind on every screenshot. */
const STORED_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})\.(png|jpg|gif|webp)$/;

/** Whether `file` is a name this module could have written. Exported so a caller can reject a malformed
 *  name BEFORE spending real work on it — the name is the only thing standing between a request and a
 *  path join, and one validator keeps every caller agreeing on what a valid name is. */
export function isStoredChatImageName(file: string): boolean {
  return STORED_NAME.test(file);
}

/** Write a turn's attachments to disk and return the references to persist on the user row. Best-effort
 *  per image: one that cannot be written is skipped rather than failing the turn, because the message
 *  itself (and the copy the model sees) is unaffected — only its thumbnail after a reload is. */
export function storeChatImages(dir: string, images: readonly { data: string; mimeType: string }[]): StoredChatImage[] {
  const stored: StoredChatImage[] = [];
  for (const image of images) {
    const ext = EXTENSION[image.mimeType];
    if (!ext) continue;
    const file = `${randomUUID()}.${ext}`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), Buffer.from(image.data, 'base64'));
      stored.push({ file, mimeType: image.mimeType });
    } catch { /* keep the turn; the attachment just won't survive a reload */ }
  }
  return stored;
}

/** Write one image's bytes under a name derived from those bytes, and return the reference. Idempotent by
 *  construction: the same picture always lands on the same name, so persisting a turn twice writes the
 *  same file twice rather than leaving a duplicate behind. Returns null when the type is not one we serve
 *  or the write fails — the caller then keeps the original block rather than losing the image. */
export function storeImageByContent(dir: string, data: string, mimeType: string): StoredChatImage | null {
  // Own-property lookup: a mimeType of "constructor" would otherwise resolve up the prototype chain to a
  // truthy value and build a nonsense file name.
  const ext = Object.hasOwn(EXTENSION, mimeType) ? EXTENSION[mimeType] : undefined;
  if (!ext) return null;
  let bytes: Buffer;
  try { bytes = Buffer.from(data, 'base64'); } catch { return null; }
  const file = storeContentAddressed(dir, bytes, ext);
  return file ? { file, mimeType } : null;
}

/** An image block as it is PERSISTED: the bytes have moved to disk and the row keeps only the reference.
 *  The live block PI hands us (`{type:'image', data, mimeType}`) is never rewritten — that copy is what
 *  the provider already saw, and editing an already-sent message is what breaks a warm prompt cache. */
interface PersistedImageBlock { type: 'image'; ref: StoredChatImage }

export function isPersistedImageBlock(part: unknown): part is PersistedImageBlock {
  if (typeof part !== 'object' || part === null) return false;
  const { type, ref } = part as { type?: unknown; ref?: unknown };
  if (type !== 'image' || typeof ref !== 'object' || ref === null) return false;
  const { file, mimeType } = ref as { file?: unknown; mimeType?: unknown };
  return typeof file === 'string' && typeof mimeType === 'string' && STORED_NAME.test(file);
}

/** Move the image bytes out of a message that is about to be stored, leaving a reference in their place.
 *  Without this a single browser screenshot puts ~2 MB of base64 into `brain_messages`, where it is dead
 *  weight forever: it inflates the row, it is re-read on every rehydrate, and the invariant the file above
 *  states — that raw base64 stays out of the table — quietly did not hold for tool results.
 *
 *  Returns the message unchanged (same object identity) when there is nothing to move, so the common path
 *  costs one `Array.isArray` and the caller can store what it already had. */
export function externalizeImageBlocks<T>(message: T, dir: string): T {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return message;
  let changed = false;
  const rewritten = content.map((part) => {
    const block = part as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (block?.type !== 'image' || typeof block.data !== 'string' || typeof block.mimeType !== 'string') return part;
    const stored = storeImageByContent(dir, block.data, block.mimeType);
    if (!stored) return part; // unwritable or a type we do not serve — better a fat row than a lost image
    changed = true;
    return { type: 'image', ref: stored } satisfies PersistedImageBlock;
  });
  return changed ? { ...(message as object), content: rewritten } as T : message;
}

/** The one tool whose image result is put in front of the user on its own. Reading an image FILE is a
 *  deliberate, bounded act of looking at one thing, and until now the reader saw only the words
 *  "Read image file" while the model got the picture. Every other image-producing tool stays behind the
 *  explicit `ShareImage` for the reason that tool's own description gives: debugging a page means a
 *  screenshot every few seconds, and forwarding each one buries the conversation. */
export const IMAGE_PREVIEW_TOOL = 'Read';

/** Move the image a tool result handed the MODEL into the chat-image store, and return its reference.
 *  Reads the LIVE block (`{type:'image', data, mimeType}`) — the shape a tool returns, before the turn is
 *  persisted. Content-addressed, so this names the exact same file `externalizeImageBlocks` writes for the
 *  same result a moment later at `message_end`: the live event and the reloaded transcript point at one
 *  file rather than two copies of one picture. Only the first image is taken; a result carrying several is
 *  not something the preview tool produces. */
export function storeToolResultImage(result: unknown, dir: string): StoredChatImage | null {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  for (const part of Array.isArray(content) ? content : []) {
    const block = part as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (block?.type !== 'image' || typeof block.data !== 'string' || typeof block.mimeType !== 'string') continue;
    const stored = storeImageByContent(dir, block.data, block.mimeType);
    if (stored) return stored;
  }
  return null;
}

/** The same pictures, rebuilt from a STORED tool result — the bytes have long since moved to disk, so the
 *  row carries `{type:'image', ref}` instead. The reload twin of {@link storeToolResultImage}; the strict
 *  block validator is what keeps a hand-edited row from naming an arbitrary path. */
export function persistedToolResultImages(result: unknown): BrainMessageImage[] {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  const refs: StoredChatImage[] = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (isPersistedImageBlock(part)) refs.push(part.ref);
  }
  return toMessageImages(refs);
}

/** Every stored image file a persisted row references, whatever kind of row it is: a user attachment
 *  (`images`), a tool result whose bytes were externalized (`content[].ref`), or an image the agent shared
 *  (`details.sharedImage`). Ownership and the sweep both read through here, so a new way to reference an
 *  image only has to be taught to this one function — miss it in the sweep and live pictures get deleted,
 *  miss it in the ownership check and a private image answers 404 to the person who owns it. */
export function collectImageFiles(content: unknown): string[] {
  if (typeof content !== 'object' || content === null) return [];
  const files: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string' && STORED_NAME.test(value)) files.push(value);
  };
  const row = content as { images?: unknown; content?: unknown; details?: unknown };
  for (const image of Array.isArray(row.images) ? row.images : []) {
    add((image as { file?: unknown } | null)?.file);
  }
  for (const part of Array.isArray(row.content) ? row.content : []) {
    if (isPersistedImageBlock(part)) add(part.ref.file);
  }
  const shared = (row.details as { sharedImage?: unknown } | null | undefined)?.sharedImage;
  if (typeof shared === 'object' && shared !== null) add((shared as { file?: unknown }).file);
  return files;
}

/** The real type of these bytes, from their MAGIC NUMBER — never from the file name. A caller can point
 *  `ShareImage` at any readable path, and serving `evil.png` that is actually HTML would be a stored XSS
 *  against the very same origin the web UI runs on. Returns null for anything that is not one of the four
 *  types we serve, which is also what keeps a PDF or a video from being renamed into the image route. */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  // RIFF....WEBP — the size field sits between the two markers, so both ends have to be checked.
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** Read a stored image back. Returns null for an unknown or malformed name, so the route answers 404
 *  without distinguishing "never existed" from "swept away". */
export function readChatImage(dir: string, file: string): { body: Buffer; mimeType: string } | null {
  if (!STORED_NAME.test(file)) return null;
  const mimeType = MIME_BY_EXTENSION[file.slice(file.lastIndexOf('.') + 1)];
  if (!mimeType) return null;
  try {
    return { body: readFileSync(join(dir, file)), mimeType };
  } catch {
    return null;
  }
}

/** What a persisted user row says instead of carrying the image bytes. It is the model's only trace of
 *  the attachment after the turn, so it stays in the stored text even when the files survive. */
export function attachmentMarker(count: number): string {
  return `\n[📎 ${count}× image]`;
}

const MARKER = /\n?\[📎 \d+× image\]$/u;

/** Drop the marker for a client that renders the attachments themselves. View-only — never write the
 *  result back to the store, or the model loses the trace. */
export function stripAttachmentMarker(text: string): string {
  return text.replace(MARKER, '');
}

/** The daemon path a client loads a stored image from. Kept next to the route that serves it so the live
 *  echo and the history DTO cannot drift apart; the web surface prefixes its own `/api` proxy base. */
function chatImageUrl(file: string): string {
  return `/brain/chat-images/${file}`;
}

/** Shape stored references into the wire form both the `user` event and a history row carry. */
export function toMessageImages(stored: readonly StoredChatImage[]): BrainMessageImage[] {
  return stored.map((image) => ({ url: chatImageUrl(image.file), mimeType: image.mimeType }));
}

/** Delete stored images no message references any more — a turn discarded before it produced output, or
 *  a conversation that was deleted. Files younger than `graceMs` are always kept: a turn writes its files
 *  before the row that references them is committed, so a sweep racing an admission would otherwise delete
 *  an attachment that is about to become live. Returns how many files were removed. */
export function sweepChatImages(dir: string, referenced: ReadonlySet<string>, graceMs: number, now = Date.now()): number {
  return sweepContentAddressed(dir, referenced, isStoredChatImageName, graceMs, now);
}

/** Parse the `images` field off a persisted user row. The column is free-form JSON written by older
 *  builds too, so every shape that isn't exactly what we write is treated as "no attachments". */
export function parseStoredChatImages(value: unknown): StoredChatImage[] {
  if (!Array.isArray(value)) return [];
  const out: StoredChatImage[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { file, mimeType } = entry as { file?: unknown; mimeType?: unknown };
    if (typeof file !== 'string' || typeof mimeType !== 'string') continue;
    if (!STORED_NAME.test(file)) continue;
    out.push({ file, mimeType });
  }
  return out;
}
