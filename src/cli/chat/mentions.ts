import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { dataDir } from '../paths.js';

/** `@` file mentions for the chat TUI (opencode-style): a fuzzy+frecency file suggester over the
 *  project, token parsing on submit, and attachment expansion — text files ride inside the prompt as
 *  fenced blocks, image files (and `@clipboard`) become image content blocks on /brain/send. Pure
 *  helpers throughout; the only I/O is the file index, the frecency store and the clipboard readers. */

/** Hard cap on the session file index — beyond this the suggester is noise anyway. */
const MAX_INDEX_FILES = 5000;
/** Largest text file attached inline; bigger ones get a one-line note instead. */
export const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
/** Mirrors `imageSchema` in src/api/schemas/brain.ts: ≤7M base64 chars (≈5 MB binary) per image. */
const MAX_IMAGE_BASE64_CHARS = 7_000_000;
/** Mirrors `brainSendSchema.images.max(4)`. */
export const MAX_IMAGES_PER_MESSAGE = 4;
/** The pseudo-mention that attaches the system clipboard image (`@clipboard`, also `/paste`). */
export const CLIPBOARD_MENTION = 'clipboard';
/** Frecency entries kept per project (pruned by recency, mirroring opencode's frecency store). */
export const MAX_FRECENCY_ENTRIES = 200;

/** Image types the brain send path accepts as content blocks, keyed by extension. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** The image mime type for a path, or null when it isn't an attachable image. */
export function imageMimeFor(path: string): string | null {
  return IMAGE_MIME_BY_EXT[extname(path).toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Token detection (typing) + parsing (submit)
// ---------------------------------------------------------------------------

/** The `@`-mention being typed at the cursor, or null. The `@` must start a word (line start or after
 *  whitespace) so emails and mid-word `@`s never trigger. A quoted token (`@"my fi`) stays active
 *  across spaces until its closing quote; an unquoted one ends at the first whitespace. */
export function activeMention(line: string, col: number): { query: string; start: number } | null {
  const before = line.slice(0, col);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const raw = before.slice(at + 1);
  if (raw.startsWith('"')) {
    if (raw.includes('"', 1)) return null; // closing quote typed — the token is complete
    return { query: raw.slice(1), start: at };
  }
  if (/[\s"]/.test(raw)) return null;
  return { query: raw, start: at };
}

export interface MentionToken {
  /** The token as typed, including the `@` (and quotes). */
  raw: string;
  /** The referenced path (quotes stripped, trailing sentence punctuation trimmed). */
  path: string;
}

/** Every `@path` / `@"path with spaces"` token in a submitted message. Word-start only — `a@b.com`
 *  yields nothing. Trailing sentence punctuation on unquoted tokens is trimmed (`look at @x.ts,`). */
export function parseMentionTokens(text: string): MentionToken[] {
  const out: MentionToken[] = [];
  const re = /(^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const quoted = m[2];
    const bare = m[3]?.replace(/[).,;:!?\]}]+$/, '');
    const path = quoted ?? bare;
    if (!path) continue;
    out.push({ raw: quoted != null ? `@"${quoted}"` : `@${bare}`, path });
  }
  return out;
}

/** The token to insert for a picked path — quoted when the path contains whitespace. */
export function mentionInsertText(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

// ---------------------------------------------------------------------------
// File index (git ls-files → bounded walk fallback)
// ---------------------------------------------------------------------------

const SKIP_WALK_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', '__pycache__']);

/** Bounded recursive listing for non-git projects: breadth-first, skipping dot-directories and the
 *  usual dependency/build output, capped at `cap` files. Paths are relative with `/` separators. */
export function walkFiles(cwd: string, cap = MAX_INDEX_FILES): string[] {
  const out: string[] = [];
  const queue = [''];
  while (queue.length > 0 && out.length < cap) {
    const rel = queue.shift()!;
    let entries;
    try { entries = readdirSync(join(cwd, rel), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (out.length >= cap) break;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIP_WALK_DIRS.has(entry.name)) queue.push(path);
      } else if (entry.isFile()) {
        out.push(path);
      }
    }
  }
  return out;
}

/** The mentionable project files under `cwd`: `git ls-files --cached --others --exclude-standard`
 *  (respects .gitignore) when in a repo, the bounded walk otherwise. Capped at {@link MAX_INDEX_FILES}. */
function listProjectFiles(cwd: string): string[] {
  try {
    const stdout = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = stdout.split('\n').filter(Boolean);
    if (files.length > 0) return files.slice(0, MAX_INDEX_FILES);
  } catch { /* not a git repo (or git missing) → walk */ }
  return walkFiles(cwd);
}

/** Session-scoped file list: lazy-loaded on the first `@`, cached, re-listed only when the caller asks
 *  (a fresh mention after the TTL) — never on every keystroke. */
export class FileIndex {
  private cached: string[] | null = null;
  private loadedAt = 0;

  constructor(
    private readonly cwd: string,
    private readonly list: (cwd: string) => string[] = listProjectFiles,
    private readonly ttlMs = 60_000,
  ) {}

  files(): string[] {
    if (this.cached == null) {
      try { this.cached = this.list(this.cwd); } catch { this.cached = []; }
      this.loadedAt = Date.now();
    }
    return this.cached;
  }

  /** Drop the cache when it outlived the TTL — called when a NEW mention opens, so a file created
   *  mid-session shows up without re-listing on every keystroke. */
  refreshIfStale(now = Date.now()): void {
    if (this.cached != null && now - this.loadedAt > this.ttlMs) this.cached = null;
  }
}

// ---------------------------------------------------------------------------
// Frecency (persisted per project, mirroring promptHistory.ts)
// ---------------------------------------------------------------------------

interface FrecencyEntry { uses: number; lastUsed: number }
export type FrecencyMap = Record<string, FrecencyEntry>;

function mentionsFile(env: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'cli-mentions.json');
}

function loadAllFrecency(env: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(mentionsFile(env), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch { return {}; }
}

function frecencyFor(all: Record<string, unknown>, workDir: string): FrecencyMap {
  const raw = all[workDir];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map: FrecencyMap = {};
  for (const [path, entry] of Object.entries(raw as Record<string, unknown>)) {
    const e = entry as { uses?: unknown; lastUsed?: unknown };
    if (typeof e?.uses === 'number' && typeof e?.lastUsed === 'number') map[path] = { uses: e.uses, lastUsed: e.lastUsed };
  }
  return map;
}

/** This project's mention frecency (path → uses/lastUsed). Corrupt/missing file → empty map. */
export function loadMentionFrecency(workDir: string, env: NodeJS.ProcessEnv = process.env): FrecencyMap {
  return frecencyFor(loadAllFrecency(env), workDir);
}

/** Record one picked mention and return the updated project map. Prunes to the most recently used
 *  {@link MAX_FRECENCY_ENTRIES}. Best-effort — a read-only config dir must not break the TUI. */
export function bumpMentionFrecency(workDir: string, path: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): FrecencyMap {
  const all = loadAllFrecency(env);
  const map = frecencyFor(all, workDir);
  map[path] = { uses: (map[path]?.uses ?? 0) + 1, lastUsed: now };
  const pruned = Object.fromEntries(
    Object.entries(map).sort(([, a], [, b]) => b.lastUsed - a.lastUsed).slice(0, MAX_FRECENCY_ENTRIES),
  );
  try {
    all[workDir] = pruned;
    const file = mentionsFile(env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(all));
  } catch { /* best-effort persistence */ }
  return pruned;
}

// ---------------------------------------------------------------------------
// Fuzzy + frecency ranking
// ---------------------------------------------------------------------------

/** Match tier for a query against a path — 0 means no match. Basename hits outrank full-path hits,
 *  exact > prefix > substring > subsequence (the SlashOverlay scale, extended with a basename axis). */
export function fuzzyScore(query: string, path: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const base = basename(p);
  if (base === q || p === q) return 100;
  if (base.startsWith(q)) return 90;
  if (p.startsWith(q)) return 80;
  if (base.includes(q)) return 70;
  if (p.includes(q)) return 60;
  let pos = 0;
  for (const ch of q) {
    pos = p.indexOf(ch, pos);
    if (pos === -1) return 0;
    pos += 1;
  }
  return 20;
}

/** opencode's frecency decay: uses over age in days — a file picked often and recently scores highest. */
function frecencyScore(entry: FrecencyEntry | undefined, now: number): number {
  if (!entry) return 0;
  return entry.uses / (1 + Math.max(0, now - entry.lastUsed) / 86_400_000);
}

/** Rank the index against a query: fuzzy tier first, frecency breaks ties within a tier (a just-picked
 *  file floats to the top of its tier), then shorter/alphabetical paths. */
export function rankMentionFiles(files: string[], query: string, frecency: FrecencyMap, limit = 50, now = Date.now()): string[] {
  const scored: { path: string; tier: number; frec: number }[] = [];
  for (const path of files) {
    const tier = fuzzyScore(query, path);
    if (tier <= 0) continue;
    scored.push({ path, tier, frec: frecencyScore(frecency[path], now) });
  }
  return scored
    .sort((a, b) => b.tier - a.tier || b.frec - a.frec || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((s) => s.path);
}

// ---------------------------------------------------------------------------
// Attachment expansion (submit)
// ---------------------------------------------------------------------------

/** One image ready for the /brain/send `images` param, plus display metadata for the chip row. */
export interface PendingImage { name: string; data: string; mimeType: string; bytes: number }

export interface MentionExpansion {
  /** Fenced attachment blocks and one-line skip notes, '' when the message has no file mentions. */
  block: string;
  /** Image-file mentions, already base64-encoded for the send path. */
  images: PendingImage[];
  /** True when an `@clipboard` token was present — the caller reads the clipboard (async) itself. */
  wantsClipboard: boolean;
}

const skipNote = (path: string, reason: string): string => `Attached file @${path}: skipped (${reason}).`;

/** Expand every `@path` token in a submitted message: text files (within cwd, ≤256 KB, no NUL byte)
 *  become fenced blocks, image files become image attachments, everything else gets a one-line note.
 *  The visible transcript keeps the original text — only the composed prompt carries the contents. */
export function expandMentions(text: string, cwd: string): MentionExpansion {
  const blocks: string[] = [];
  const images: PendingImage[] = [];
  let wantsClipboard = false;
  const seen = new Set<string>();
  const root = resolve(cwd);
  for (const token of parseMentionTokens(text)) {
    if (token.path === CLIPBOARD_MENTION) { wantsClipboard = true; continue; }
    if (seen.has(token.path)) continue;
    seen.add(token.path);
    const abs = resolve(root, token.path);
    if (abs !== root && !abs.startsWith(root + sep)) { blocks.push(skipNote(token.path, 'outside the project directory')); continue; }
    let stat;
    try { stat = statSync(abs); } catch { blocks.push(skipNote(token.path, 'not found')); continue; }
    if (!stat.isFile()) { blocks.push(skipNote(token.path, 'not a regular file')); continue; }
    const mime = imageMimeFor(token.path);
    if (mime) {
      let buf: Buffer;
      try { buf = readFileSync(abs); } catch { blocks.push(skipNote(token.path, 'unreadable')); continue; }
      const data = buf.toString('base64');
      if (data.length > MAX_IMAGE_BASE64_CHARS) { blocks.push(skipNote(token.path, 'image larger than the upload limit')); continue; }
      images.push({ name: basename(token.path), data, mimeType: mime, bytes: buf.length });
      continue;
    }
    if (stat.size > MAX_TEXT_ATTACHMENT_BYTES) { blocks.push(skipNote(token.path, `larger than ${MAX_TEXT_ATTACHMENT_BYTES / 1024} KB`)); continue; }
    let buf: Buffer;
    try { buf = readFileSync(abs); } catch { blocks.push(skipNote(token.path, 'unreadable')); continue; }
    if (buf.includes(0)) { blocks.push(skipNote(token.path, 'binary file')); continue; }
    blocks.push(`Attached file @${token.path}:\n\`\`\`\n${buf.toString('utf8').replace(/\n$/, '')}\n\`\`\``);
  }
  return { block: blocks.join('\n\n'), images, wantsClipboard };
}

/** Prepend the mention attachments to the outgoing message. The full outgoing composition is
 *  `composeWithShellContext(composeWithAttachments(text, block), shellResults)` — one path, ordered
 *  shell context → attachments → the user's own words (closest to the model's attention). */
export function composeWithAttachments(message: string, block: string): string {
  return block ? `${block}\n\n${message}` : message;
}

// ---------------------------------------------------------------------------
// Clipboard image (best-effort, per platform)
// ---------------------------------------------------------------------------

export interface ClipboardCommand { command: string; args: string[] }

/** Ordered clipboard-image readers for a platform: `pngpaste` (then `pbpaste` as a long-shot raw-PNG
 *  fallback) on macOS; `wl-paste`/`xclip` on Linux, Wayland first when $WAYLAND_DISPLAY is set. */
export function clipboardImageCommands(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ClipboardCommand[] {
  if (platform === 'darwin') {
    return [
      { command: 'pngpaste', args: ['-'] },
      { command: 'pbpaste', args: [] },
    ];
  }
  const wayland: ClipboardCommand = { command: 'wl-paste', args: ['-t', 'image/png'] };
  const x11: ClipboardCommand = { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'] };
  return env.WAYLAND_DISPLAY ? [wayland, x11] : [x11, wayland];
}

/** Magic-byte sniff for the attachable image types; null for anything else (incl. text/empty). */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export type RunClipboardFn = (cmd: ClipboardCommand, signal?: AbortSignal) => Promise<Buffer | null>;

const runClipboardCommand: RunClipboardFn = (cmd, signal) => new Promise((resolvePromise) => {
  let settled = false;
  let child: ReturnType<typeof execFile> | null = null;
  const finish = (value: Buffer | null): void => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    resolvePromise(value);
  };
  const onAbort = (): void => {
    child?.kill();
    finish(null);
  };
  child = execFile(cmd.command, cmd.args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 5000 }, (error, stdout) => {
    finish(error || stdout.length === 0 ? null : stdout);
  });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
});

/** Read an image off the system clipboard: try each platform command in order and take the first
 *  output that sniffs as an image. Never rejects — failures land in `error` for a notice. */
export async function readClipboardImage(
  run: RunClipboardFn = runClipboardCommand,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<{ image?: PendingImage; error?: string }> {
  for (const cmd of clipboardImageCommands(platform, env)) {
    if (signal?.aborted) return { error: 'clipboard read cancelled' };
    const buf = await run(cmd, signal);
    if (signal?.aborted) return { error: 'clipboard read cancelled' };
    if (!buf || buf.length === 0) continue;
    const mimeType = sniffImageMime(buf);
    if (!mimeType) continue;
    const data = buf.toString('base64');
    if (data.length > MAX_IMAGE_BASE64_CHARS) return { error: 'clipboard image is too large (≈5 MB max)' };
    const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
    return { image: { name: `clipboard.${ext}`, data, mimeType, bytes: buf.length } };
  }
  return { error: 'no image on the clipboard (needs xclip, wl-clipboard or pngpaste)' };
}
