import { existsSync, mkdirSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { realPathWithin } from '../plugins/pathGuard.js';

/** Where a file the user dropped into the conversation lands, and under what name.
 *
 *  A chat attachment used to have to FIT IN THE MESSAGE: images travelled as base64 and text files were
 *  inlined into the prompt, which is why both carried type allow-lists and size caps. An upload instead
 *  becomes an ordinary file in the user's project, so there is nothing to cap and nothing to convert —
 *  and the agent reads it with the tools it already has. `plugins/files`' own Read already sniffs the
 *  type from magic bytes, inlines the image types as vision blocks and even renders PDF pages, so this
 *  module deliberately knows NOTHING about content types: it moves bytes to a path and stops there.
 *
 *  The layout is `uploads/<account>/<YYYY-MM-DD>/<name>` under the project root. Per account because a
 *  shared project is shared by everyone in it, and per day because a conversation that runs for months
 *  otherwise buries the file somebody is looking for. */

/** Longest stored file name. Well under the 255-byte ceiling every filesystem we run on enforces, with
 *  room left for the ` (2)` a collision appends. */
const MAX_NAME = 180;

/** How many times a colliding name is suffixed before the upload is refused. A user re-sending the same
 *  file a few times is ordinary; a thousand collisions is a caller in a loop, and silently spinning
 *  through them would stat the directory forever. */
const MAX_COLLISIONS = 200;

/** The name a file gets when the client sent nothing usable. */
const FALLBACK_NAME = 'upload';

/** Reduce one path segment to something safe to join.
 *
 *  This is the only thing standing between an attacker-chosen string and a path join, so it removes
 *  rather than rejects: separators, `..`, control characters, and the NUL that would truncate the path
 *  inside a syscall. A name that reduces to nothing falls back rather than producing an empty segment,
 *  which would silently write INTO the parent directory. */
function safeSegment(raw: string, fallback: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '-')
    .replace(/\s+/g, ' ')
    // Leading junk, stripped AFTER the separators became dashes so `../..\x` collapses in one pass. A
    // leading dot hides the file from every ordinary listing, `..` is the traversal itself, and a
    // leading dash makes the name look like an option to every command line it is ever pasted into.
    .replace(/^[.\-\s]+/, '')
    .trim();
  return cleaned || fallback;
}

/** The stored name for an uploaded file: the client's own name where it is usable, trimmed to length
 *  WITHOUT losing the extension — the extension is what lets the agent (and the user) tell a PDF from a
 *  spreadsheet, so truncating it away would defeat the read path this whole feature exists to feed. */
export function sanitizeUploadName(raw: string): string {
  // basename() first: the browser sends a bare name, but an API caller can send anything at all.
  const named = safeSegment(basename(String(raw ?? '')), FALLBACK_NAME);
  if (named.length <= MAX_NAME) return named;
  const ext = extname(named).slice(0, 32);
  return `${named.slice(0, MAX_NAME - ext.length)}${ext}`;
}

/** `name (2).pdf` — the suffix goes BEFORE the extension so the file keeps opening in the right app. */
function suffixed(name: string, n: number): string {
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

/** The directory an account's uploads for `now` belong in, relative to the project root. */
export function uploadRelativeDir(account: string, now: Date): string {
  const p = (v: number): string => String(v).padStart(2, '0');
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return join('uploads', safeSegment(account, 'account'), day);
}

export interface UploadTarget {
  /** Absolute path to write. */
  path: string;
  /** The name actually used, which is the sanitized name plus any collision suffix. */
  name: string;
  /** Path relative to the project root — what the UI shows and what reads nicely in a message. */
  relative: string;
}

/**
 * Resolve where to write one upload, creating the day directory.
 *
 * Containment is asserted against the project root even though every segment was sanitized on the way
 * in. The sanitizer is one function that could be wrong; the root check is a second, independent
 * property, and the cost of being wrong here is a write anywhere the daemon user can reach.
 *
 * `exists` is injectable so the collision walk can be tested without touching a disk.
 */
export function resolveUploadTarget(
  projectRoot: string,
  account: string,
  rawName: string,
  now: Date,
  exists: (path: string) => boolean = existsSync,
): UploadTarget {
  const relativeDir = uploadRelativeDir(account, now);
  const dir = resolve(projectRoot, relativeDir);
  // The directory has to exist before it can be resolved through symlinks, and the caller is about to
  // write into it anyway.
  mkdirSync(dir, { recursive: true });
  if (!realPathWithin(dir, [projectRoot])) {
    throw new Error('upload directory escapes the project root');
  }

  const base = sanitizeUploadName(rawName);
  for (let n = 1; n <= MAX_COLLISIONS; n += 1) {
    const name = n === 1 ? base : suffixed(base, n);
    // A collision must never overwrite: two people can drop `screenshot.png` into the same shared
    // project on the same day, and the second one silently replacing the first would lose data.
    if (exists(join(dir, name))) continue;
    const path = join(dir, name);
    if (path !== resolve(path) || name.includes(sep)) {
      throw new Error('upload name escapes its directory');
    }
    return { path, name, relative: join(relativeDir, name) };
  }
  throw new Error(`too many files named "${base}" in this folder today`);
}
