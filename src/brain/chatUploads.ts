import { mkdirSync, openSync } from 'node:fs';
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

/** Longest stored file name, IN BYTES. The filesystem limit is 255 bytes, not characters, and the
 *  difference is not academic here: `Přehled hospodaření` spends two bytes on every accented letter, so
 *  a perfectly ordinary Czech file name can pass a 180-CHARACTER check and still be rejected by the
 *  kernel with ENAMETOOLONG — which the upload would report as a bare 500 with nothing to act on.
 *  Well under 255 either way, leaving room for the ` (2)` a collision appends. */
const MAX_NAME_BYTES = 180;

/** Longest extension worth preserving, also in bytes. */
const MAX_EXT_BYTES = 32;

/** Cut a string to a byte budget without splitting a character in half.
 *
 *  Slicing the UTF-8 buffer would be shorter and wrong: it can land mid-sequence and leave a byte that
 *  decodes to U+FFFD, so the stored name would differ from the one the user sent. Iterating the string
 *  walks whole code points (surrogate pairs included), so the result is always a prefix of the input. */
function clampBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let out = '';
  let used = 0;
  for (const ch of value) {
    const width = Buffer.byteLength(ch);
    if (used + width > maxBytes) break;
    out += ch;
    used += width;
  }
  return out;
}

export interface UploadProject {
  id: number;
  path: string;
  slug: string;
}

/**
 * Which of the caller's projects an upload belongs in.
 *
 * A web conversation cannot answer this: `brain_sessions.work_dir` is empty for one (it exists so a CLI
 * can find the conversation belonging to a directory), so there is no cwd to inherit. Nor can the id be
 * assumed — the daemon's own `project` is hardcoded to id 1 while its PATH comes from the environment,
 * and on a deployment where those disagree, trusting the id drops uploads into the source checkout.
 *
 * So: the caller's own projects decide. One project is unambiguous. Several are resolved by preferring
 * the instance's configured workspace, which is the shared folder everyone is assigned to. Anything
 * still ambiguous FAILS rather than guessing — writing somebody's file into the wrong project is not
 * something they would notice, and silently picking the lowest id would put it in the sources.
 */
export function chooseUploadProject(candidates: readonly UploadProject[], preferredPath: string): UploadProject {
  if (candidates.length === 0) {
    throw new Error('no project to upload into — ask an administrator to assign you one');
  }
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only) return only;
  const preferred = candidates.find((p) => samePath(p.path, preferredPath));
  if (preferred) return preferred;
  const names = candidates.map((p) => p.slug).join(', ');
  throw new Error(`several projects could hold this upload (${names}) and none is the shared workspace — ask an administrator to set one`);
}

function samePath(a: string, b: string): boolean {
  const strip = (v: string): string => (v.length > 1 && v.endsWith(sep) ? v.slice(0, -1) : v);
  return strip(resolve(a)) === strip(resolve(b));
}

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
  if (Buffer.byteLength(named) <= MAX_NAME_BYTES) return named;
  const ext = clampBytes(extname(named), MAX_EXT_BYTES);
  const stem = clampBytes(named.slice(0, named.length - extname(named).length), MAX_NAME_BYTES - Buffer.byteLength(ext));
  return `${stem || FALLBACK_NAME}${ext}`;
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
  /** Absolute path of the file, which by now EXISTS and is empty. */
  path: string;
  /** The name actually used, which is the sanitized name plus any collision suffix. */
  name: string;
  /** Path relative to the project root — what the UI shows and what reads nicely in a message. */
  relative: string;
  /** Descriptor of the exclusively created file. The caller owns it and must close it. */
  fd: number;
}

/**
 * Claim where to write one upload, creating the day directory and the file itself.
 *
 * The file is created EXCLUSIVELY (`wx`) rather than tested for and then opened. A check followed by an
 * open is two operations with a gap between them, and both things that fit in that gap are real: two
 * people dropping `screenshot.png` into the same shared project in the same second would each see a
 * free name and the second would silently replace the first, and a symlink left at the chosen name
 * would send the write wherever it points — `existsSync` FOLLOWS symlinks, so a dangling one does not
 * even register as a collision. `wx` refuses both in a single syscall, with no gap to exploit.
 *
 * It follows that the descriptor is opened BEFORE the request body is touched: a stream cannot be
 * rewound, so a collision discovered mid-write could no longer be retried under another name.
 *
 * Containment is asserted against the project root even though every segment was sanitized on the way
 * in. The sanitizer is one function that could be wrong; the root check is a second, independent
 * property, and the cost of being wrong here is a write anywhere the daemon user can reach.
 *
 * `create` is injectable so the collision walk can be tested without touching a disk.
 */
export function createUploadTarget(
  projectRoot: string,
  account: string,
  rawName: string,
  now: Date,
  create: (path: string) => number = (path) => openSync(path, 'wx'),
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
    const path = join(dir, name);
    if (path !== resolve(path) || name.includes(sep)) {
      throw new Error('upload name escapes its directory');
    }
    let fd: number;
    try {
      fd = create(path);
    } catch (e) {
      // Taken — by a concurrent upload, or by something already sitting at that name. Either way the
      // answer is the next name. Anything else is a real filesystem failure the caller must hear.
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    return { path, name, relative: join(relativeDir, name), fd };
  }
  throw new Error(`too many files named "${base}" in this folder today`);
}
