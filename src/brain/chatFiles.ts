import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainMessageFile } from '../shared/wireContract.js';
import { storeContentAddressed, sweepContentAddressed } from './contentAddressedStore.js';

/** A general file the agent shared into a conversation. The bytes use a server-chosen content name; the
 *  caller-chosen original name stays metadata only and is used for the browser's download filename. */
export interface StoredChatFile {
  /** File name inside the chat-files dir; also the only path segment the read route accepts. */
  file: string;
  name: string;
  size: number;
}

/** General files never inherit an attacker-controlled extension. The fixed `.bin` suffix and exact SHA-256
 *  shape keep traversal, SQL LIKE wildcards, and broad ownership scans out before the database is touched. */
const STORED_NAME = /^[0-9a-f]{64}\.bin$/;

export function isStoredChatFileName(file: string): boolean {
  return STORED_NAME.test(file);
}

/** Keep general downloads beside chat-images without adding another data-root setting to every runtime
 *  boundary. `chatImagesDir` is already the injected per-instance attachment root. */
export function chatFilesDir(chatImagesDir: string): string {
  return join(dirname(chatImagesDir), 'chat-files');
}

/** Copy an immutable download artifact into the conversation store. Its address covers BOTH bytes and the
 *  original basename: double persistence stays idempotent, while identical bytes shared under two names get
 *  distinct URLs and therefore cannot race to supply the wrong Content-Disposition metadata. */
export function storeFileByContent(dir: string, bytes: Buffer, originalName: string): StoredChatFile | null {
  const nameBytes = Buffer.from(originalName, 'utf8');
  const nameLength = Buffer.allocUnsafe(4);
  nameLength.writeUInt32BE(nameBytes.length);
  const file = storeContentAddressed(dir, bytes, 'bin', Buffer.concat([nameLength, nameBytes, bytes]), true);
  return file ? { file, name: originalName, size: bytes.length } : null;
}

/** Every valid shared-file reference in a persisted row. Ownership and sweeping both use this parser, so a
 *  filename appearing in assistant prose cannot grant access or keep unrelated bytes alive. */
export function collectChatFiles(content: unknown): StoredChatFile[] {
  if (typeof content !== 'object' || content === null) return [];
  const shared = ((content as { details?: unknown }).details as { sharedFile?: unknown } | null | undefined)?.sharedFile;
  if (typeof shared !== 'object' || shared === null) return [];
  const { file, name, size } = shared as { file?: unknown; name?: unknown; size?: unknown };
  if (typeof file !== 'string' || !STORED_NAME.test(file)) return [];
  if (typeof name !== 'string' || !name || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return [];
  return [{ file, name, size }];
}

/** Read bytes only from a name this module could have written. The route supplies download metadata from
 *  the owned message reference; the arbitrary source path used by ShareFile is never retained or revisited. */
export function readChatFile(dir: string, file: string): Buffer | null {
  if (!STORED_NAME.test(file)) return null;
  try { return readFileSync(join(dir, file)); }
  catch { return null; }
}

function chatFileUrl(file: string): string {
  return `/brain/chat-files/${file}`;
}

export function toMessageFile(stored: StoredChatFile): BrainMessageFile {
  return { url: chatFileUrl(stored.file), name: stored.name, size: stored.size };
}

/** RFC 5987 carries the exact UTF-8 basename; the quoted fallback is deliberately ASCII/control-safe so an
 *  unusual filesystem name cannot inject or invalidate response headers. */
export function chatFileDisposition(name: string): string {
  const fallback = name
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Delete stored files no persisted message references any more. The grace window prevents a sweep racing
 *  the write-before-row-commit sequence from removing a file that is just becoming live. */
export function sweepChatFiles(dir: string, referenced: ReadonlySet<string>, graceMs: number, now = Date.now()): number {
  return sweepContentAddressed(dir, referenced, isStoredChatFileName, graceMs, now);
}
