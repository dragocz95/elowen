// Files plugin: read/write/list, each confined to the caller's accessible repos via ctx.assertPathAllowed
// (which reads the per-session Policy). A guard rejection is returned as an error text so the model can
// react, not thrown, matching how the Elowen* tools surface API errors.
import { defineTool, withFileMutationQueue, truncateHead, truncateLine, formatSize, generateDiffString, generateUnifiedPatch, resizeImage, formatDimensionNote } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { promisify } from 'node:util';

const DEFAULT_MAX = 100_000;
const DEFAULT_SEARCH_MAX_MATCHES = 200;
const SEARCH_TIMEOUT_MS = 5_000;
const DIFF_CONTEXT = 3;
const DIFF_MAX_LINES = 200;
const RESULT_LINE_MAX = 500; // cap each search hit so one minified line can't flood the result set
// Raw-byte cap for embedding an image we couldn't resize. base64 inflates ~4/3, and the API rejects images
// whose encoded payload tops ~5 MB, so cap the RAW bytes at ~3.75 MB to keep the base64 under that ceiling.
const IMAGE_MAX_BYTES = 3_750_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'web-dist', '.next', '.turbo']);
/** A byte budget bounds the bytes a read returns; this bounds what those bytes COST in context. Dense text
 *  (minified JS, JSON, base64) carries far more tokens per byte than prose, so a page the byte cap allows —
 *  or one an explicit `limit` exempts from it — can still be several times the model's read budget. */
const MAX_READ_TOKENS = 25_000;
/** Above this a whole-file slurp is an OOM risk rather than an edit: V8 caps a string near 2^30 bytes. */
const MAX_EDIT_BYTES = 1024 ** 3;
/** Reading one of these blocks forever or never reaches EOF. Checked on the PATH, before any I/O, so the
 *  check itself cannot hang. Harmless special files such as /dev/null are deliberately not listed. */
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero', '/dev/random', '/dev/urandom', '/dev/full',
  '/dev/stdin', '/dev/tty', '/dev/console', '/dev/stdout', '/dev/stderr',
  '/dev/fd/0', '/dev/fd/1', '/dev/fd/2',
]);
/** Extensions whose content is not text. PDFs, notebooks and the image formats this tool renders natively
 *  are excluded at the call site, so only files nothing here can display reach the refusal. */
const BINARY_EXTENSIONS = new Set([
  '.ico', '.tiff', '.tif',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.mpeg', '.mpg',
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.aiff', '.opus',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.z', '.tgz', '.iso',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.obj', '.lib', '.app', '.msi', '.deb', '.rpm',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.pyc', '.pyo', '.class', '.jar', '.war', '.ear', '.node', '.wasm', '.rlib',
  '.sqlite', '.sqlite3', '.db', '.mdb', '.idx',
  '.psd', '.ai', '.eps', '.sketch', '.fig', '.xd', '.blend', '.3ds', '.max',
  '.swf', '.fla',
  '.lockb', '.dat', '.data',
]);
const DEFAULT_GLOB_MAX = 100;
/** How many files a traversal may visit before it gives up. Shared by Glob and Search's rg-less
 *  fallback so both report the same bound with the same wording. */
const WALK_CAP = 10_000;
const execFileP = promisify(execFile);
const RIPGREP_REQUIRED = 'Error: ripgrep (rg) is required for content search. Install ripgrep and retry (Ubuntu/Debian: apt install ripgrep; macOS: brew install ripgrep).';
const commandMissing = (error) => error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const ok = (tool, text, details = {}) => ({
  content: [{ type: 'text', text }],
  details: { ok: true, tool, truncated: false, ...details },
});
const fail = (tool, e, details = {}) => ok(tool, `Error: ${e instanceof Error ? e.message : String(e)}`, {
  ok: false,
  error: { message: e instanceof Error ? e.message : String(e) },
  ...details,
});

// ── Error delivery channel ───────────────────────────────────────────────────
// ONE rule, and this is the place it is written down: the web and mcp plugins carry the same helper with
// a pointer back here, because bundled plugins cannot import each other.
//
// THROW a failure the model cannot fix by calling differently — a transport or host fault: a network or
// DNS/socket error, an origin or search backend answering 5xx, ripgrep crashing or being killed, an MCP
// transport dying. The host turns a throw into a tool result flagged `is_error`, keeping the thrown
// message as the result text (its `details` are dropped), which is what makes a failure look like a
// failure in the UI and in the transcript instead of reading like an answer.
//
// RETURN TEXT for everything the model CAN act on itself: bad arguments, a path or resource that is not
// there, a policy refusal, an HTTP 4xx the origin answered with content. Those are answers, not faults,
// and throwing them would spend a turn painting a red banner over ordinary guidance.
const TRANSPORT_FAILURE = Symbol.for('elowen.transportFailure');
/** Tag `error` as a transport/host fault so the tool rethrows it instead of flattening it to text. */
export function markTransportFailure(error) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped[TRANSPORT_FAILURE] = true;
  return wrapped;
}
export function isTransportFailure(error) {
  return Boolean(error && typeof error === 'object' && error[TRANSPORT_FAILURE] === true);
}

/** Slice `text` to at most `maxBytes` UTF-8 bytes without splitting a multi-byte character. */
function sliceBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1; // back up to a UTF-8 char boundary
  return buf.subarray(0, end).toString('utf-8');
}

/** Prepend `cat -n` style line numbers (right-aligned, tab-separated) to each line of `text`.
 *  `startLine` is the 1-based number of the first line. */
function addLineNumbers(text, startLine) {
  const lines = text.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(startLine + i).padStart(width)}\t${line}`).join('\n');
}

// ── Fuzzy-edit core ──────────────────────────────────────────────────────────
// PI's edit tool tolerates smart quotes / Unicode dashes / trailing whitespace and preserves BOM+CRLF,
// but the package's exports map (only "." and "./rpc-entry") blocks importing edit-diff's fuzzyFindText /
// applyEditsToNormalizedContent / stripBom / line-ending helpers. These are a faithful port of that logic
// (node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js) so our own defineTool wrapper
// keeps the ctx.assertPathAllowed guard and details shape while gaining the same matching semantics.
// Being a frozen copy of code that moves upstream, its behaviour is pinned by the characterisation tests in
// tests/plugins/filesPorts.test.ts — when a PI upgrade breaks them, reconcile the port deliberately.

function detectLineEnding(content) {
  const crlf = content.indexOf('\r\n');
  const lf = content.indexOf('\n');
  if (lf === -1 || crlf === -1) return '\n';
  return crlf < lf ? '\r\n' : '\n';
}
function normalizeToLF(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function restoreLineEndings(text, ending) {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}
/** Strip trailing per-line whitespace and fold smart quotes / Unicode dashes / exotic spaces to ASCII. */
function normalizeForFuzzyMatch(text) {
  return text
    .normalize('NFKC')
    .split('\n').map((line) => line.trimEnd()).join('\n')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[  -   　]/g, ' ');
}
/** Strip a leading UTF-8 BOM, returning it separately so it can be restored on write. */
function stripBom(content) {
  return content.startsWith('﻿') ? { bom: '﻿', text: content.slice(1) } : { bom: '', text: content };
}
function splitLinesWithEndings(content) {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
function getLineSpans(content) {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}
function getReplacementLineRange(lines, replacement) {
  const start = replacement.matchIndex;
  const end = replacement.matchIndex + replacement.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start >= lines[i].start && start < lines[i].end) { startLine = i; break; }
  }
  if (startLine === -1) throw new Error('Replacement range is outside the base content.');
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < end) endLine++;
  if (endLine >= lines.length) throw new Error('Replacement range is outside the base content.');
  return { startLine, endLine: endLine + 1 };
}
/** Apply replacements (ascending, non-overlapping) to `content` in reverse so earlier offsets stay valid. */
function applyReplacements(content, replacements, offset = 0) {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    const at = r.matchIndex - offset;
    result = result.substring(0, at) + r.newText + result.substring(at + r.matchLength);
  }
  return result;
}
/** Overlay fuzzy-space replacements onto the original content, rewriting only the touched line blocks so
 *  every other line keeps its exact original bytes (base and original must share a line count). */
function applyReplacementsPreservingUnchangedLines(originalContent, baseContent, replacements) {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error('Cannot preserve unchanged lines because the base content has a different line count.');
  }
  const groups = [];
  for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }
  let originalLineIndex = 0;
  let result = '';
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join('');
    const groupStart = baseLines[group.startLine].start;
    const groupEnd = baseLines[group.endLine - 1].end;
    result += applyReplacements(baseContent.slice(groupStart, groupEnd), group.replacements, groupStart);
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join('');
  return result;
}
function findAllOccurrences(haystack, needle) {
  const out = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) { out.push(i); i = haystack.indexOf(needle, i + needle.length); }
  return out;
}
/** Plan an edit with exact matching by default. The optional fuzzy pass is an explicit Elowen extension;
 *  canonical Edit calls never normalize quotes, dashes, spaces, or trailing whitespace implicitly. BOM and
 *  line endings are preserved in either mode. */
export function planEdit(rawBefore, oldTextRaw, newTextRaw, replaceAll, fuzzyMatch = false) {
  const { bom, text } = stripBom(rawBefore);
  const ending = detectLineEnding(text);
  const content = normalizeToLF(text);
  const oldLF = normalizeToLF(oldTextRaw);
  const newLF = normalizeToLF(newTextRaw);
  if (oldLF.length === 0) return { error: 'empty' };
  let base = content;
  let needle = oldLF;
  let fuzzy = false;
  let idxs = findAllOccurrences(content, oldLF);
  if (idxs.length === 0 && fuzzyMatch) {
    base = normalizeForFuzzyMatch(content);
    needle = normalizeForFuzzyMatch(oldLF);
    fuzzy = true;
    idxs = needle.length === 0 ? [] : findAllOccurrences(base, needle);
  }
  if (idxs.length === 0) return { error: 'notfound' };
  if (idxs.length > 1 && !replaceAll) return { error: 'ambiguous', count: idxs.length };
  const targets = replaceAll ? idxs : [idxs[0]];
  const replacements = targets.map((matchIndex) => ({ matchIndex, matchLength: needle.length, newText: newLF }));
  const newContent = fuzzy
    ? applyReplacementsPreservingUnchangedLines(content, base, replacements)
    : applyReplacements(content, replacements);
  return { content, newContent, after: bom + restoreLineEndings(newContent, ending), count: targets.length };
}

/** PI's line-numbered display diff, capped so a huge edit can't flood the transcript. The CLI (renderDiff)
 *  and web (DiffBlock) renderers both accept this `±<n> text` / ` <n> text` row format. */
function displayDiff(before, after) {
  const { diff } = generateDiffString(before, after, DIFF_CONTEXT);
  if (!diff) return '';
  const lines = diff.split('\n');
  if (lines.length <= DIFF_MAX_LINES) return diff;
  return [...lines.slice(0, DIFF_MAX_LINES), `…[diff truncated: ${lines.length - DIFF_MAX_LINES} more lines]`].join('\n');
}
/** Applicable unified patch for review/tooling; omitted when large enough that it would bloat the event. */
function unifiedPatch(path, before, after) {
  const patch = generateUnifiedPatch(path, before, after, DIFF_CONTEXT);
  if (!patch || after === before) return undefined;
  return patch.split('\n').length > DIFF_MAX_LINES * 4 ? undefined : patch;
}

// Magic-byte image sniff — a faithful port of PI's detectSupportedImageMimeType
// (node_modules/@earendil-works/pi-coding-agent/dist/utils/mime.js). The full-header validation is NOT
// optional cosmetics: "BM", "GIF" and "\x89PNG" are common enough as plain-text/binary prefixes that a
// prefix-only sniff would misclassify a real text file as an image, drop into the image branch, fail to
// resize, and return an "[Image omitted]" stub instead of the file's actual text — silent data loss on a
// normal read. So BMP validates its 26-byte header, PNG its 8-byte signature + IHDR + non-animated, and
// JPEG rejects the unsupported JPEG-LS (0xf7) variant, exactly as PI does. Frozen copy, same as the edit
// core above: its behaviour is pinned by tests/plugins/filesPorts.test.ts.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function startsWithBytes(buf, bytes) {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}
function startsWithAscii(buf, offset, text) {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) if (buf[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}
function readUint16LE(buf, o) { return (buf[o] ?? 0) + ((buf[o + 1] ?? 0) << 8); }
function readUint32BE(buf, o) {
  return (buf[o] ?? 0) * 0x1000000 + ((buf[o + 1] ?? 0) << 16) + ((buf[o + 2] ?? 0) << 8) + (buf[o + 3] ?? 0);
}
function readUint32LE(buf, o) {
  return (buf[o] ?? 0) + ((buf[o + 1] ?? 0) << 8) + ((buf[o + 2] ?? 0) << 16) + (buf[o + 3] ?? 0) * 0x1000000;
}
function isPng(buf) {
  return buf.length >= 16 && readUint32BE(buf, PNG_SIGNATURE.length) === 13 && startsWithAscii(buf, 12, 'IHDR');
}
function isAnimatedPng(buf) {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buf.length) {
    const chunkLength = readUint32BE(buf, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buf, chunkTypeOffset, 'acTL')) return true;
    if (startsWithAscii(buf, chunkTypeOffset, 'IDAT')) return false;
    const next = offset + 8 + chunkLength + 4;
    if (next <= offset || next > buf.length) return false;
    offset = next;
  }
  return false;
}
function isBmp(buf) {
  if (buf.length < 26) return false;
  const declaredFileSize = readUint32LE(buf, 2);
  const pixelDataOffset = readUint32LE(buf, 10);
  const dibHeaderSize = readUint32LE(buf, 14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
  let colorPlanes;
  let bitsPerPixel;
  if (dibHeaderSize === 12) {
    colorPlanes = readUint16LE(buf, 22);
    bitsPerPixel = readUint16LE(buf, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (buf.length < 30) return false;
    colorPlanes = readUint16LE(buf, 26);
    bitsPerPixel = readUint16LE(buf, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}
export function detectImageMime(buf) {
  if (startsWithBytes(buf, [0xff, 0xd8, 0xff])) return buf[3] === 0xf7 ? null : 'image/jpeg';
  if (startsWithBytes(buf, PNG_SIGNATURE)) return isPng(buf) && !isAnimatedPng(buf) ? 'image/png' : null;
  // Require the full 6-byte GIF signature incl. version (PI sniffs only "GIF") — the 3-byte prefix alone
  // misfires on ordinary text ("GIFT ideas…"), which would then be embedded as a broken image/gif block.
  if (startsWithAscii(buf, 0, 'GIF87a') || startsWithAscii(buf, 0, 'GIF89a')) return 'image/gif';
  if (startsWithAscii(buf, 0, 'RIFF') && startsWithAscii(buf, 8, 'WEBP')) return 'image/webp';
  if (startsWithAscii(buf, 0, 'BM') && isBmp(buf)) return 'image/bmp';
  return null;
}
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function isBlockedDevicePath(filePath) {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true;
  // /proc/self/fd/0-2 and /proc/<pid>/fd/0-2 are Linux aliases for the same three streams.
  return filePath.startsWith('/proc/')
    && (filePath.endsWith('/fd/0') || filePath.endsWith('/fd/1') || filePath.endsWith('/fd/2'));
}

/** The binary extension of `filePath`, or null when this tool can render the file. */
export function binaryExtensionOf(filePath) {
  const ext = extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext) ? ext : null;
}

/** Rough token count for `content`. Dense JSON is mostly single-character tokens, so it costs about twice
 *  what the same bytes of prose do — the same two ratios the reference uses. */
export function estimateTokens(content, extension = '') {
  const ext = String(extension).replace(/^\./, '').toLowerCase();
  const bytesPerToken = ext === 'json' || ext === 'jsonl' || ext === 'jsonc' ? 2 : 4;
  return Math.round(content.length / bytesPerToken);
}

// ── PDF ──────────────────────────────────────────────────────────────────────
// Read via poppler (pdftotext / pdftoppm / pdfinfo) rather than a bundled parser: it handles the real
// world's malformed PDFs, and it is OPTIONAL in exactly the way `rg` is for Search — absent, we say
// so plainly instead of silently returning nothing. A page with a text layer comes back as text; a scanned
// page (no text layer) is rendered to a PNG and returned as an image, which is the only way its content
// reaches a model at all.
const DEFAULT_PDF_MAX_PAGES = 20;  // per call — enough to keep one call's output sane (cfg: pdfMaxPages)
const PDF_MAX_IMAGE_PAGES = 5;     // rendered pages per call; each is ~0.5-1 MB of base64, so cap them hard
// Rendered pages are sized by their LONG EDGE, not by dpi. A PDF may declare a MediaBox up to 200x200
// INCHES; at any fixed dpi that is a gigapixel render — hundreds of MB of PNG on disk and gigabytes of RGBA
// once decoded, so one hostile (or merely oversized) document could OOM the daemon. Fixing the long edge
// bounds the cost no matter what the page claims, and 2000px is exactly the ceiling the image resize below
// would clamp to anyway — so nothing is ever rendered large only to be shrunk.
const PDF_MAX_RENDER_PX = 2000;
const PDF_TIMEOUT_MS = 30_000;
const PDF_MAX_BUFFER = 8_000_000;

const isPdf = (buf) => startsWithAscii(buf, 0, '%PDF-');

/** Expand a `pages` spec — "3", "1-5", "1,3,5" (and combinations) — into a sorted, deduplicated page list.
 *  Returns `{ error }` for a malformed spec or one that asks for more than `maxPages`, so the model gets
 *  a reason it can act on rather than a silently truncated read. Ranges are rejected BEFORE expansion, so
 *  "1-999999" cannot balloon the set.
 *
 *  `maxPages` is passed in rather than read from the module: the tool DESCRIPTION states the same cap, and
 *  the two must come from one resolved value — a model told "at most 20" while validation enforces 5 would
 *  be sent into a failure it had no way to avoid. */
export function parsePageSpec(spec, maxPages = DEFAULT_PDF_MAX_PAGES) {
  const text = String(spec ?? '').trim();
  if (!text) return { error: 'pages is empty' };
  const pages = new Set();
  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    const single = /^(\d+)$/.exec(part);
    let from;
    let to;
    if (range) { from = Number(range[1]); to = Number(range[2]); }
    else if (single) { from = Number(single[1]); to = from; }
    else return { error: `"${part}" is not a page or a range — use "3", "1-5" or "1,3,5"` };
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
      return { error: `"${part}" uses a non-finite or unsafe integer page number` };
    }
    if (from < 1 || to < from) return { error: `"${part}" is not a valid page range (pages start at 1)` };
    if (to - from + 1 > maxPages) return { error: `"${part}" spans more than ${maxPages} pages` };
    for (let page = from; page <= to; page += 1) {
      pages.add(page);
      if (pages.size > maxPages) return { error: `at most ${maxPages} pages can be read in one call` };
    }
  }
  if (pages.size === 0) return { error: 'pages is empty' };
  return { pages: [...pages].sort((a, b) => a - b) };
}

/** Total page count via pdfinfo, or null when it cannot be determined (we then just try the pages asked for
 *  and let pdftotext report an empty result). Doubles as the poppler-availability probe. */
async function pdfPageCount(abs) {
  const { stdout } = await execFileP('pdfinfo', [abs], { encoding: 'utf8', timeout: PDF_TIMEOUT_MS, maxBuffer: PDF_MAX_BUFFER });
  const m = /^Pages:\s+(\d+)$/m.exec(stdout);
  return m ? Number(m[1]) : null;
}

/** One page's text layer (empty string for a scanned page). `-layout` preserves the visual column layout,
 *  which is what makes tables and invoices readable instead of an interleaved word soup. */
async function pdfPageText(abs, page) {
  const { stdout } = await execFileP('pdftotext', ['-layout', '-f', String(page), '-l', String(page), abs, '-'], {
    encoding: 'utf8', timeout: PDF_TIMEOUT_MS, maxBuffer: PDF_MAX_BUFFER,
  });
  return stdout;
}

/** Render one page to PNG bytes. pdftoppm only writes to disk, so this runs through a temp dir that is
 *  always removed — including when the render throws. */
async function pdfPageImage(abs, page) {
  const dir = mkdtempSync(join(tmpdir(), 'elowen-pdf-'));
  try {
    const prefix = join(dir, 'page');
    // `-scale-to` fixes the long edge and overrides any dpi setting — which is the point: the output size
    // is decided by us, never by what the page declares its dimensions to be.
    await execFileP('pdftoppm', [
      '-png', '-scale-to', String(PDF_MAX_RENDER_PX),
      '-f', String(page), '-l', String(page), '-singlefile', abs, prefix,
    ], { timeout: PDF_TIMEOUT_MS, maxBuffer: PDF_MAX_BUFFER });
    return readFileSync(`${prefix}.png`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Embed rendered page bytes as an image content block, resized like any other image read. Returns null
 *  when it cannot be embedded (Photon unavailable AND the raw PNG is over the API's payload ceiling). */
async function pdfImageBlock(png) {
  const resized = await resizeImage(png, 'image/png', { maxWidth: 2000, maxHeight: 2000 }).catch(() => null);
  if (resized && INLINE_IMAGE_TYPES.has(resized.mimeType)) {
    return { type: 'image', data: resized.data, mimeType: resized.mimeType };
  }
  if (png.length <= IMAGE_MAX_BYTES) return { type: 'image', data: png.toString('base64'), mimeType: 'image/png' };
  return null;
}

/** Read the requested pages of a PDF: text where there is a text layer, a rendered image where there is
 *  not. Returns the PI tool-result shape directly. */
async function readPdf(abs, pageSpec, supportsImages, readCap, maxPages) {
  let total = null;
  try {
    total = await pdfPageCount(abs);
  } catch (e) {
    // ENOENT here means poppler is not installed; anything else is a genuinely broken/encrypted PDF.
    if (e && typeof e === 'object' && e.code === 'ENOENT') {
      return fail('Read', new Error('Reading PDFs requires poppler-utils (pdfinfo/pdftotext/pdftoppm), which is not installed on this host.'), { path: abs, pdf: true });
    }
    return fail('Read', new Error(`Could not read the PDF: ${e instanceof Error ? e.message : String(e)}`), { path: abs, pdf: true });
  }

  if (pageSpec === undefined) {
    if (total === null || total > 10) {
      return fail('Read', new Error(`The PDF has ${total ?? 'more than 10'} pages. Pass \`pages\` to select at most ${maxPages} pages.`), {
        path: abs, pdf: true, pageCount: total,
      });
    }
    pageSpec = total === 1 ? '1' : `1-${total}`;
  }
  const parsed = parsePageSpec(pageSpec, maxPages);
  if (parsed.error) return fail('Read', new Error(`Invalid pages: ${parsed.error}.`), { path: abs, pdf: true, pageCount: total });

  const wanted = total === null ? parsed.pages : parsed.pages.filter((p) => p <= total);
  const outOfRange = total === null ? [] : parsed.pages.filter((p) => p > total);
  if (wanted.length === 0) {
    return fail('Read', new Error(`The PDF has ${total} page(s); none of the requested pages exist.`), { path: abs, pdf: true, pageCount: total });
  }

  const parts = [];
  const images = [];
  let rendered = 0;
  let skippedImages = 0;
  for (const page of wanted) {
    const text = await pdfPageText(abs, page);
    if (text.trim()) {
      parts.push(`--- page ${page} ---\n${text.trimEnd()}`);
      continue;
    }
    // No text layer — a scanned page. Rendering is the only way its content reaches the model at all, but
    // each image is expensive, so cap them and tell the caller which pages were left out.
    if (rendered >= PDF_MAX_IMAGE_PAGES || !supportsImages) { skippedImages += 1; continue; }
    const block = await pdfImageBlock(await pdfPageImage(abs, page)).catch(() => null);
    if (!block) { skippedImages += 1; continue; }
    images.push(block);
    rendered += 1;
    parts.push(`--- page ${page} (no text layer — rendered as an image below) ---`);
  }

  const body = parts.join('\n\n');
  const capped = truncateHead(body, { maxBytes: readCap, maxLines: Infinity });
  const notes = [];
  if (capped.truncated) notes.push(`[Text truncated at the ${formatSize(readCap)} read limit — request fewer pages.]`);
  if (outOfRange.length) notes.push(`[Skipped page(s) ${outOfRange.join(', ')}: the PDF has ${total}.]`);
  if (skippedImages) {
    notes.push(supportsImages
      ? `[${skippedImages} page(s) had no text layer and were not rendered (limit ${PDF_MAX_IMAGE_PAGES} images per call) — request them in a smaller \`pages\` range.]`
      : `[${skippedImages} page(s) had no text layer and the current model cannot accept images.]`);
  }
  const text = [capped.content || '(no text on the requested pages)', ...notes].join('\n\n');
  const truncated = capped.truncated || skippedImages > 0;
  const fullContentVisible = total !== null && wanted.length === total
    && wanted.every((page, index) => page === index + 1) && !truncated;
  return {
    content: [{ type: 'text', text }, ...images],
    details: {
      ok: true, tool: 'Read', path: abs, pdf: true, pageCount: total,
      pages: wanted, renderedPages: rendered, truncated, fullContentVisible,
    },
  };
}

// ── Jupyter notebooks ────────────────────────────────────────────────────────
const NOTEBOOK_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const notebookText = (value) => Array.isArray(value) ? value.map(String).join('') : String(value ?? '');

/** Render a notebook as cells and outputs rather than exposing its JSON encoding. Image outputs use the
 * same supported inline MIME set as ordinary image reads and are validated by their bytes before embedding. */
function readNotebook(raw, supportsImages, readCap) {
  let notebook;
  try { notebook = JSON.parse(raw.toString('utf8')); }
  catch (error) { return fail('Read', new Error(`Could not parse Jupyter notebook: ${error instanceof Error ? error.message : String(error)}`), { notebook: true }); }
  if (!notebook || !Array.isArray(notebook.cells)) {
    return fail('Read', new Error('Invalid Jupyter notebook: `cells` must be an array.'), { notebook: true });
  }

  const sections = [];
  const images = [];
  let omittedImages = 0;
  notebook.cells.forEach((cell, cellIndex) => {
    const type = typeof cell?.cell_type === 'string' ? cell.cell_type : 'unknown';
    const execution = type === 'code' && cell?.execution_count != null ? `, execution_count=${cell.execution_count}` : '';
    const lines = [`Cell ${cellIndex + 1} [${type}${execution}]`, notebookText(cell?.source)];
    const outputs = Array.isArray(cell?.outputs) ? cell.outputs : [];
    outputs.forEach((output, outputIndex) => {
      const outputType = typeof output?.output_type === 'string' ? output.output_type : 'unknown';
      if (outputType === 'stream') {
        lines.push(`Output ${outputIndex + 1} [stream ${String(output?.name ?? 'stdout')}]`, notebookText(output?.text));
        return;
      }
      if (outputType === 'error') {
        const name = String(output?.ename ?? 'Error');
        const value = String(output?.evalue ?? '');
        lines.push(`Output ${outputIndex + 1} [error ${name}${value ? `: ${value}` : ''}]`,
          Array.isArray(output?.traceback) ? output.traceback.map(String).join('\n') : `${name}${value ? `: ${value}` : ''}`);
        return;
      }
      const data = output?.data && typeof output.data === 'object' ? output.data : {};
      lines.push(`Output ${outputIndex + 1} [${outputType}]`);
      const plain = notebookText(data['text/plain']);
      if (plain) lines.push(plain);
      for (const mime of NOTEBOOK_IMAGE_MIMES) {
        const encoded = notebookText(data[mime]).replace(/\s+/gu, '');
        if (!encoded) continue;
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES || detectImageMime(bytes) !== mime) {
          omittedImages += 1;
          lines.push(`[Invalid or oversized ${mime} output omitted.]`);
          continue;
        }
        if (!supportsImages) {
          omittedImages += 1;
          lines.push(`[${mime} output omitted because the current model does not support images.]`);
          continue;
        }
        images.push({ type: 'image', data: encoded, mimeType: mime });
        lines.push(`[${mime} output attached below.]`);
      }
    });
    sections.push(lines.filter((line) => line !== '').join('\n'));
  });

  const rendered = sections.join('\n\n');
  const capped = truncateHead(rendered, { maxBytes: readCap, maxLines: 2000 });
  const notes = [];
  if (capped.truncated) notes.push(`[Notebook text truncated; read a smaller notebook or inspect selected cells with Python.]`);
  if (omittedImages) notes.push(`[${omittedImages} notebook image output(s) were omitted.]`);
  return {
    content: [{ type: 'text', text: [capped.content || '(notebook has no cells)', ...notes].join('\n\n') }, ...images],
    details: {
      ok: true, tool: 'Read', notebook: true, cells: notebook.cells.length, images: images.length,
      truncated: capped.truncated || omittedImages > 0,
    },
  };
}

// ── Read-before-modify guard ─────────────────────────────────────────────────
// Editing a file the agent never looked at is how content silently disappears: it writes from assumption,
// not from what is actually there. So a mutation of an EXISTING file requires that this conversation has
// read it, and that it still holds the bytes the agent saw.
//
// The state is per BRAIN SESSION (ctx.currentSessionId), so a sub-agent's reads never vouch for its
// parent's edits — each conversation must have seen a file itself. Outside a turn there is no session to
// key on and the guard is inert rather than wrong.
//
// The subtlety is our own formatters plugin: it rewrites the file from a `tools.call.after` hook, AFTER
// Write/Edit has already returned, so the bytes on disk stop matching what we recorded — and we
// get no signal that it happened. Treating that as "changed behind your back" would refuse every edit that
// follows a formatted write: the guard would spend its life blocking us rather than protecting us.
//
// We cannot tell a formatter's rewrite from an outsider's, so the two mutations are held to DIFFERENT bars,
// on one principle: a blind full overwrite is never allowed against bytes the agent has not seen; a targeted
// edit is, because its `old_string` anchor still has to match the current content to apply at all.
//   - Write: any divergence refuses. Post-formatter, an overwrite means re-reading first — rare, and
//     the refusal says exactly that.
//   - Edit: a divergence from content WE authored (`ours`) is forgiven once and re-baselined — that is
//     the formatter's window — while a file we only READ and never wrote is fully protected either way.
const READ_STATE_MAX_SESSIONS = 64;
const READ_STATE_MAX_FILES = 512;
/** sessionId → (path-state key → authorization). Any successful Read of a file authorizes mutation, paged
 * or not; what the guard still enforces is that the bytes on disk are the ones that read hashed.
 * An entry is `{ hash, ours }`, and a text Read adds the `offset`/`limit` it returned — the one extra
 * thing the dedup below needs, kept on the SAME entry so the hash stays the only authorization. */
const readState = new Map();

const hashOf = (buf) => createHash('sha256').update(buf).digest('hex');

function installSessionFiles(sessionId, files) {
  readState.delete(sessionId);
  if (files.size > 0) readState.set(sessionId, files);
  if (readState.size > READ_STATE_MAX_SESSIONS) readState.delete(readState.keys().next().value);
}

function sessionFiles(sessionId) {
  let files = readState.get(sessionId);
  if (files) readState.delete(sessionId);
  else files = new Map();
  readState.set(sessionId, files);
  if (readState.size > READ_STATE_MAX_SESSIONS) readState.delete(readState.keys().next().value);
  return files;
}

function recordEntry(files, key, entry) {
  files.delete(key);
  files.set(key, entry);
  if (files.size > READ_STATE_MAX_FILES) files.delete(files.keys().next().value);
}

function recordHash(sessionId, key, hash, ours) {
  if (!sessionId) return;
  recordEntry(sessionFiles(sessionId), key, { hash, ours });
}

/** Record that this conversation now knows `key` holds exactly `content`. `ours` marks bytes written by us,
 * which earns Edit's narrow post-formatter tolerance in the live process only. */
export function markFileRead(sessionId, key, content, ours = false) {
  recordHash(sessionId, key, hashOf(content), ours);
}

/** Record what a text Read saw, and which range it put in front of the model. A page of the file authorizes
 * mutation just as a whole-file read does — the hash is of the WHOLE file either way, so the staleness check
 * keeps its teeth. Re-reading bytes we authored keeps the `ours` marker: the formatter tolerance is about who
 * wrote the file, not how often it was read. */
function recordTextRead(sessionId, key, hash, offset, limit) {
  if (!sessionId) return;
  const files = sessionFiles(sessionId);
  const prior = files.get(key);
  recordEntry(files, key, { hash, ours: prior?.hash === hash && prior.ours === true, offset, limit });
}

/** The reference's two non-content Read outcomes, verbatim (`FileReadTool.ts:706-707`). Neither is an
 * error: the file is there, it just has nothing to show for this request, and saying so as a warning is
 * what stops a model retrying the same read as though it had failed. */
const EMPTY_FILE_REMINDER = '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>';
const overOffsetReminder = (startLine, totalLines) =>
  `<system-reminder>Warning: the file exists but is shorter than the provided offset (${startLine}). `
  + `The file has ${totalLines} lines.</system-reminder>`;

/** Claude Code's `file_unchanged` stub, verbatim (`src/tools/FileReadTool/prompt.ts:7-8`). */
const FILE_UNCHANGED_STUB = 'File unchanged since last read. The content from the earlier Read tool_result '
  + 'in this conversation is still current — refer to that instead of re-reading.';

/** Whether this Read would hand back bytes an earlier Read already put in front of the model, so the stub
 * above can stand in for them (`FileReadTool.ts:522-573`). Same conversation, same file, same range, and the
 * same hash the guard already computes — nothing here decides authorization, it only chooses what to say.
 *
 * The range is what says a READ recorded this entry: a Write/Edit baseline, a PDF/image/notebook read and a
 * transcript replay all record a hash without one, and none of them displayed this text. That is exactly the
 * reference's `existingState.offset !== undefined` (`FileReadTool.ts:547-551`) — `ours` is a different
 * question (who wrote the bytes, for Edit's formatter tolerance) and stays sticky across re-reads, so using
 * it here would silence the dedup for every file the conversation has ever edited. */
function readIsDuplicate(sessionId, key, hash, offset, limit) {
  if (!sessionId) return false;
  const entry = readState.get(sessionId)?.get(key);
  return entry !== undefined && entry.hash === hash
    && entry.offset === offset && entry.limit === limit;
}

/** Forget which range the entry displayed, keeping the hash that authorizes mutation. The stub points at an
 * earlier tool_result the plugin cannot see the fate of: toolResultClearing replaces older Read results with
 * placeholders and compaction drops them entirely. Dropping the range makes the NEXT identical Read send the
 * content again, so a stub is never the only copy the model has, while an immediate re-read still dedups.
 * Called only from the duplicate branch, where the session and the entry both exist. */
function dropReadRange(sessionId, key) {
  const files = sessionFiles(sessionId);
  const prior = files.get(key);
  recordEntry(files, key, { hash: prior.hash, ours: prior.ours });
}

/** Rebuild this session's authorization atomically from the visible transcript. Only successful Read results
 * vouch, and only those carrying the hash of the bytes the model saw. Write/Edit results contain diffs, not
 * the baseline, so they never authorize a later blind overwrite. */
export function seedReadStateFromHistory(sessionId, messages) {
  if (!sessionId) return 0;
  const files = new Map();
  let seeded = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    const d = m?.details;
    if (m?.role !== 'toolResult' || m?.isError === true
      || !d || d.ok !== true || d.tool !== 'Read'
      || typeof d.path !== 'string' || typeof d.contentHash !== 'string') continue;
    const key = typeof d.workspaceId === 'string' && d.workspaceId
      ? `${d.workspaceId}\0${d.path}`
      : d.path;
    recordEntry(files, key, { hash: d.contentHash, ours: false });
    seeded++;
  }
  installSessionFiles(sessionId, files);
  return seeded;
}

/** Why a mutation must not proceed, or null when it may. The wording is Claude Code's verbatim, so a model
 * trained on that phrasing reacts to the refusal the way it was trained to — no path is prepended, because
 * that would change the sentence. */
export function readGuardError(sessionId, key, current, tolerateAuthoredDrift = false) {
  if (!sessionId) return null;
  if (current === null) return null;
  const entry = readState.get(sessionId)?.get(key);
  if (!entry) return 'File has not been read yet. Read it first before writing to it.';
  if (hashOf(current) === entry.hash) return null;
  if (entry.ours && tolerateAuthoredDrift) return null;
  return 'File has been modified since read, either by the user or by a linter. '
    + 'Read it again before attempting to write it.';
}

const TEXT_READ_CHUNK_BYTES = 64 * 1024;
const FILE_PROBE_BYTES = 64;

function sameFileSnapshot(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

/** Read only enough bytes to classify the file before choosing a bounded text path or a binary renderer. */
function readFileProbe(abs) {
  const fd = openSync(abs, 'r');
  try {
    const probe = Buffer.allocUnsafe(FILE_PROBE_BYTES);
    const bytesRead = readSync(fd, probe, 0, probe.length, 0);
    return probe.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function looksLikeImage(probe) {
  return startsWithBytes(probe, [0xff, 0xd8, 0xff]) || startsWithBytes(probe, PNG_SIGNATURE)
    || startsWithAscii(probe, 0, 'GIF87a') || startsWithAscii(probe, 0, 'GIF89a')
    || (startsWithAscii(probe, 0, 'RIFF') && startsWithAscii(probe, 8, 'WEBP'))
    || startsWithAscii(probe, 0, 'BM');
}

/** Stream one text snapshot through a fixed-size buffer. The selected output is retained only up to readCap
 * plus a small UTF-8 boundary allowance, while line counting and hashing continue without retaining the file. */
function readTextSnapshot(abs, start, requestedLines, readCap, expectedProbe) {
  const fd = openSync(abs, 'r');
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error('path is not a regular file');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(TEXT_READ_CHUNK_BYTES);
    const retained = [];
    const retainLimit = readCap + 4;
    let retainedBytes = 0;
    let selectedBytes = 0;
    let currentLine = 0;
    let selectedLines = 0;
    let atLineStart = true;
    let totalBytes = 0;
    let lastByte = null;
    const actualProbe = Buffer.allocUnsafe(expectedProbe.length);
    let actualProbeBytes = 0;
    const selectedEnd = start + requestedLines;
    const retain = (buf) => {
      selectedBytes += buf.length;
      if (retainedBytes >= retainLimit || buf.length === 0) return;
      const slice = buf.subarray(0, Math.min(buf.length, retainLimit - retainedBytes));
      retained.push(Buffer.from(slice));
      retainedBytes += slice.length;
    };
    const beginSelectedLine = () => {
      if (!atLineStart) return;
      if (selectedLines > 0) retain(Buffer.from('\n'));
      selectedLines += 1;
      atLineStart = false;
    };
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      if (actualProbeBytes < actualProbe.length) {
        const copy = Math.min(data.length, actualProbe.length - actualProbeBytes);
        data.copy(actualProbe, actualProbeBytes, 0, copy);
        actualProbeBytes += copy;
      }
      hash.update(data);
      totalBytes += bytesRead;
      lastByte = data[data.length - 1];
      let cursor = 0;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0A) continue;
        if (currentLine >= start && currentLine < selectedEnd) {
          beginSelectedLine();
          retain(data.subarray(cursor, index));
        }
        currentLine += 1;
        atLineStart = true;
        cursor = index + 1;
      }
      if (cursor < data.length && currentLine >= start && currentLine < selectedEnd) {
        beginSelectedLine();
        retain(data.subarray(cursor));
      }
    }
    const totalLines = currentLine + (totalBytes > 0 && lastByte !== 0x0A ? 1 : 0);
    const after = fstatSync(fd, { bigint: true });
    if (!sameFileSnapshot(before, after) || actualProbeBytes !== expectedProbe.length
      || !actualProbe.subarray(0, actualProbeBytes).equals(expectedProbe)) {
      throw new Error('file changed while it was being read; retry the Read');
    }
    const content = Buffer.concat(retained, retainedBytes).toString('utf8');
    return {
      content: selectedBytes > readCap ? sliceBytes(content, readCap) : content,
      contentHash: hash.digest('hex'),
      totalLines,
      totalBytes,
      byteTruncated: selectedBytes > readCap,
      selectedEnd: Math.min(selectedEnd, totalLines),
    };
  } finally {
    closeSync(fd);
  }
}

function safeRegexSource(query) {
  try { new RegExp(query); return query; }
  catch { return String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
}

/** Whether the resolved default base is the filesystem root — the daemon's cwd is `/` under systemd, so
 *  a no-path Glob/Grep from an all-access turn would otherwise walk the whole disk. */
const isFsRoot = (dir) => dirname(dir) === dir;

/** File mtime in ms, or 0 when it can't be stat'd (deleted between listing and stat). */
const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

/** Whether `p` is an existing regular file — used to disambiguate rg's path prefix from a `:n:`/`-n-`
 *  line-number separator when a directory is named like `x-12-y`. */
function isExistingFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Relativize an rg content-mode line to `root`. Handles match lines (`/abs:12:text`), context lines
 *  (`/abs-12-text`, dash-separated with -A/-B/-C) and the `--` group separator. The longest prefix that
 *  is a real file wins, so a directory named `x-12-y` can't be mistaken for a line-number boundary. */
function relativizeContentLine(line, root) {
  if (line === '--' || !line.startsWith('/')) return line;
  const re = /([:-])(\d+)\1/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const candidate = line.slice(0, m.index);
    if (candidate && isExistingFile(candidate)) return `${relative(root, candidate) || candidate}${line.slice(candidate.length)}`;
  }
  const first = /[:-]\d+[:-]/.exec(line);
  if (first) { const c = line.slice(0, first.index); return `${relative(root, c) || c}${line.slice(c.length)}`; }
  return line;
}

/** Strip the search root from a row that carries no line-number boundary (`-n: false`). */
function relativizePathPrefix(line, root) {
  if (line === '--' || !line.startsWith('/')) return line;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

/** A killed rg is a timeout, not a search that found nothing: say which bound was hit and what to narrow,
 *  otherwise the caller reads the generic failure as "no matches here" and moves on. */
/** ripgrep DYING rather than answering: killed by a signal (our own timeout, or a crash) or an exec-level
 *  failure with no exit status at all. An ordinary `rg` exit 2 — a bad pattern, an unreadable path — is
 *  ripgrep ANSWERING, which the caller can act on, so it stays a text result. */
export function ripgrepDied(error) {
  if (!error || typeof error !== 'object') return false;
  return error.killed === true || typeof error.signal === 'string' || error.code === 'ETIMEDOUT';
}

export function grepTimeoutError(error) {
  const killed = error && typeof error === 'object'
    && (error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT');
  if (!killed) return null;
  return new Error(`Search timed out after ${SEARCH_TIMEOUT_MS / 1000} seconds. `
    + 'The search may have matched files but did not complete in time. '
    + 'Try searching a more specific path or pattern.');
}

/** Relativize an rg `--count` line (`/abs:count`). */
function relativizeCountLine(line, root) {
  if (!line.startsWith('/')) return line;
  const idx = line.lastIndexOf(':');
  if (idx < 0) return line;
  const p = line.slice(0, idx);
  return `${relative(root, p) || p}${line.slice(idx)}`;
}

/** A file next to `target` that differs only in extension, or null. A model that mis-constructs a path
 *  usually gets the stem right and the suffix wrong, and naming the real neighbour saves a whole round. */
function similarSibling(target) {
  const dir = dirname(target);
  const base = basename(target);
  const stem = base.slice(0, base.length - extname(base).length) || base;
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  const match = entries.find((name) => name !== base
    && (name.slice(0, name.length - extname(name).length) || name) === stem);
  return match ? join(dir, match) : null;
}

/** The one missing-path message for Read, Glob and Grep: what is missing, where the tool is looking, and
 *  the neighbour the caller probably meant. `lead` names the thing so each tool keeps its own noun. */
export function pathNotFoundMessage(lead, target, cwd, display = (p) => p) {
  const suggestion = similarSibling(target);
  return [
    lead,
    `Note: your current working directory is ${display(cwd)}.`,
    ...(suggestion ? [`Did you mean ${display(suggestion)}?`] : []),
  ].join(' ');
}

/** Split a `glob` value the way the reference does: on whitespace, then on commas, keeping a brace group
 *  whole. Each token becomes its own `--glob`, so "*.js,*.ts" filters on both instead of matching nothing.
 *  The comma split counts brace depth rather than skipping any token that contains a brace, because
 *  "*.{ts,tsx},*.js" is both forms at once and rg matches nothing at all when it arrives as one pattern. */
export function splitGlobPatterns(value) {
  if (typeof value !== 'string') return [];
  const out = [];
  for (const token of value.split(/\s+/).filter(Boolean)) {
    let depth = 0;
    let current = '';
    for (const ch of token) {
      if (ch === ',' && depth === 0) {
        if (current) out.push(current);
        current = '';
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}' && depth > 0) depth -= 1;
      current += ch;
    }
    if (current) out.push(current);
  }
  return out;
}

/** Split an ABSOLUTE glob into the directory it is anchored to and the pattern relative to that directory,
 *  so `/repo/src/**\/*.ts` searches `/repo/src`. Returns null for a relative pattern, which keeps its
 *  existing meaning of "relative to `path`". Without this an absolute pattern matches nothing at all,
 *  because the matcher only ever sees paths relative to the search root. */
export function extractGlobBase(pattern) {
  const source = String(pattern ?? '');
  if (!source.startsWith('/')) return null;
  const segments = source.split('/');
  const literal = [];
  let index = 1;
  for (; index < segments.length - 1; index += 1) {
    if (/[*?{}[\]]/.test(segments[index])) break;
    literal.push(segments[index]);
  }
  return { base: `/${literal.join('/')}`, pattern: segments.slice(index).join('/') || '*' };
}

function globRegex(glob) {
  if (!glob) return null;
  const source = String(glob);
  let escaped = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '*') {
      if (source[i + 1] === '*') {
        // Standard glob `**/` = zero-or-more directories (so `src/**/*.ts` also matches `src/a.ts` and
        // `**/*.js` matches a top-level `foo.js`). A bare `**` matches anything, path separators included.
        if (source[i + 2] === '/') { escaped += '(?:[^/]*/)*'; i += 2; }
        else { escaped += '.*'; i += 1; }
      } else {
        escaped += '[^/]*';
      }
    } else if (ch === '?') {
      escaped += '[^/]'; // single non-separator character
    } else if (ch === '{') {
      const close = source.indexOf('}', i + 1);
      if (close > i + 1) {
        const variants = source.slice(i + 1, close).split(',').filter(Boolean);
        escaped += `(?:${variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        i = close;
      } else {
        escaped += '\\{';
      }
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      escaped += `\\${ch}`;
    } else {
      escaped += ch;
    }
  }
  return new RegExp(`^${escaped}$`);
}

/** Walk up to `limit` files. Callers that REPORT the cap ask for `limit + 1` and treat an over-long
 *  result as capped: a walk that returns exactly `limit` is otherwise indistinguishable from a tree that
 *  happens to hold exactly that many files, and claiming truncation there is a lie about completeness. */
function walkFiles(root, limit = 5000) {
  const s = statSync(root);
  if (s.isFile()) return [root];
  const out = [];
  const walk = (dir) => {
    if (out.length >= limit) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) break;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(join(dir, ent.name));
      } else if (ent.isFile()) {
        out.push(join(dir, ent.name));
      }
    }
  };
  walk(root);
  return out;
}

/** Ripgrep collects the WHOLE match set and this trims it, so `total` is the real number of matches —
 *  reported so the caller can say "showing N of M" rather than guessing from a full page. */
async function rgSearch(abs, root, queryText, include, maxMatches) {
  const ignoreGlobs = [...SKIP_DIRS].map((d) => `!${d}/**`);
  // `-i` is deliberate and fixed, not an oversight next to Grep's opt-in `-i`: Search is the discovery
  // entry point and its behaviour is one rule the model can state. Grep is the precise ripgrep tool and
  // keeps ripgrep's case-sensitive default. Making this a flag would either break every existing caller
  // (default false) or leave two tools with opposite defaults for the same flag.
  const args = [
    '--line-number', '--with-filename', '--color', 'never', '--no-heading', '-i',
    ...ignoreGlobs.flatMap((g) => ['--glob', g]),
    // Same split as Grep: one `--glob` per pattern, so "*.js,*.ts" filters on both instead of being
    // handed to rg as a single pattern that matches nothing.
    ...splitGlobPatterns(include).flatMap((g) => ['--glob', g]),
    '--',
    safeRegexSource(queryText),
    abs,
  ];
  try {
    const { stdout } = await execFileP('rg', args, { cwd: root, encoding: 'utf8', timeout: SEARCH_TIMEOUT_MS, maxBuffer: 1_000_000 });
    const all = stdout.split('\n').filter(Boolean).map((line) => {
      if (!line.startsWith('/')) return line;
      const first = line.indexOf(':');
      const second = first >= 0 ? line.indexOf(':', first + 1) : -1;
      if (second < 0) return line;
      return `${relative(root, line.slice(0, first))}${line.slice(first)}`;
    });
    return { lines: all.slice(0, maxMatches), total: all.length };
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 1) return { lines: [], total: 0 };
    // A missing rg is answered with the install note; a crash or a kill is a host fault the caller
    // rethrows; an ordinary rg error exit is ripgrep answering, and stays a readable result.
    if (commandMissing(e)) throw e;
    if (ripgrepDied(e)) throw markTransportFailure(grepTimeoutError(e) ?? e);
    throw e;
  }
}

/** ripgrep's own `--type-list` is the allowlist for the `type` parameter: a hand-maintained copy would
 *  drift from whatever rg is installed, and a free-form value would reach rg as an unexplained exit 2.
 *  Cached per process — the set only changes when the rg binary itself does. */
let rgTypeNames = null;
async function assertKnownType(type, root) {
  if (!rgTypeNames?.size) {
    const { stdout } = await execFileP('rg', ['--type-list'], { cwd: root, encoding: 'utf8', timeout: SEARCH_TIMEOUT_MS, maxBuffer: 1_000_000 });
    rgTypeNames = new Set(stdout.split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean));
  }
  if (!rgTypeNames.has(type)) {
    throw new Error(`unknown type "${type}". Use a ripgrep type name (see \`rg --type-list\`), for example ts, js, py, go, rust, or use glob instead.`);
  }
}

/** ripgrep wrapper for the Grep tool: supports output modes, context lines, multiline, case folding,
 *  type filters and head_limit/offset paging.
 *  `target` is the rg PATH — a directory OR a single file (rg accepts both); `root` relativizes output.
 *  Returns `{ lines, truncated, total }`: `lines` is the `offset`-th page of the WHOLE match set, `total`
 *  is that set's real size and `truncated` says whether anything remains AFTER the returned page, so the
 *  caller can name the offset that continues it. `headLimit: 0` means unlimited (reference semantics),
 *  still bounded by `maxMatches`. */
async function rgGrep(target, root, pattern, opts = {}) {
  const { include, type, outputMode = 'content', beforeContext, afterContext, contextLines, lineNumbers = true, multiline, caseInsensitive, headLimit, offset = 0, maxMatches } = opts;
  if (type) await assertKnownType(type, root);
  const ignoreGlobs = [...SKIP_DIRS].map((d) => `!${d}/**`);
  // Hidden files are ordinary source in a repository — CI workflows, dotfile configs, .env templates — and
  // rg skips them by default. The SKIP_DIRS globs below still keep .git out of the result set.
  const args = ['--color', 'never', '--no-heading', '--hidden'];
  // A single minified or base64 line must not eat the whole result cap. `--max-columns-preview` keeps the
  // first RESULT_LINE_MAX columns and lets rg append its own "[... omitted end of long line]" marker;
  // without it rg drops the line body entirely. This is the ONLY per-line length bound for Grep — a
  // second truncateLine pass over the formatted row would cut rg's marker back off.
  args.push('--max-columns', String(RESULT_LINE_MAX), '--max-columns-preview');
  // `offset` pages a match set that a SECOND rg process produces, so the order of that set must be the
  // same in both runs. Ripgrep searches files in parallel and emits them in completion order, which
  // differs run to run — without this, page 2 would repeat some results and silently skip others.
  args.push('--sort', 'path');
  if (caseInsensitive) args.push('-i');
  if (outputMode === 'files_with_matches') {
    args.push('--files-with-matches');
  } else if (outputMode === 'count') {
    args.push('--count');
  } else {
    args.push('--with-filename');
    if (lineNumbers) args.push('--line-number');
    // A symmetric context window replaces the one-sided flags rather than adding to them, so `context`
    // and `-C` mean exactly what they say when a caller passes both forms.
    if (contextLines != null) {
      args.push('-C', String(contextLines));
    } else {
      if (beforeContext != null) args.push('-B', String(beforeContext));
      if (afterContext != null) args.push('-A', String(afterContext));
    }
  }
  // `--multiline-dotall` makes `.` cross newlines, which is what the tool description promises multiline
  // does — `--multiline` alone only lets an explicit `\n` in the pattern span lines.
  if (multiline) args.push('--multiline', '--multiline-dotall');
  args.push(...ignoreGlobs.flatMap((g) => ['--glob', g]));
  for (const globPattern of splitGlobPatterns(include)) args.push('--glob', globPattern);
  if (type) args.push('--type', type);
  args.push('--', pattern, target);
  let stdout;
  try {
    ({ stdout } = await execFileP('rg', args, { cwd: root, encoding: 'utf8', timeout: SEARCH_TIMEOUT_MS, maxBuffer: 2_000_000 }));
  } catch (e) {
    // rg exits 1 on "no matches" (same as content mode) — a real empty result, not an rg-missing signal.
    if (e && typeof e === 'object' && 'code' in e && e.code === 1) return { lines: [], truncated: false, total: 0 };
    // A missing rg is answered with the install note; a crash or a kill is a host fault the caller
    // rethrows; an ordinary rg error exit is ripgrep answering, and stays a readable result.
    if (commandMissing(e)) throw e;
    if (ripgrepDied(e)) throw markTransportFailure(grepTimeoutError(e) ?? e);
    throw e;
  }
  const raw = stdout.split('\n').filter(Boolean);
  const effHead = headLimit === 0 ? Infinity : (headLimit ?? Infinity); // 0 → unlimited
  const cap = Math.min(effHead, maxMatches ?? Infinity);
  // Order the WHOLE match set before paging, so `offset` walks one stable sequence: page 2 must continue
  // page 1, not re-rank a different subset (files_with_matches is mtime-ordered across all matches; the
  // sort is stable, so rg's `--sort path` order breaks ties the same way on every page).
  const relativizeRow = (line) => {
    if (outputMode === 'count') return relativizeCountLine(line, root);
    // Without `-n` a content row is `path:text` and a context row `path-text`, which carry no line-number
    // boundary for the content relativizer to find — a plain prefix strip is what is left.
    return lineNumbers ? relativizeContentLine(line, root) : relativizePathPrefix(line, root);
  };
  const ordered = outputMode === 'files_with_matches'
    ? raw.map((abs) => ({ abs, mtime: mtimeOf(abs) })).sort((a, b) => b.mtime - a.mtime).map((f) => relative(root, f.abs) || f.abs)
    : raw.map(relativizeRow);
  const lines = ordered.slice(offset, offset + cap);
  return { lines, truncated: ordered.length > offset + lines.length, total: ordered.length };
}

export function register(ctx) {
  const readCap = Math.min(Math.max(Number(ctx.config.readCap) || DEFAULT_MAX, 20_000), 500_000);
  // One bound for both Search's match cap and Grep's page size — one config key, one clamp. Resolved
  // here because Grep's description quotes the number to the model as its declared default head cap.
  const searchMaxMatches = Math.min(Math.max(Number(ctx.config.searchMaxMatches) || DEFAULT_SEARCH_MAX_MATCHES, 50), 1000);
  // Resolved BEFORE the tool is defined, because the Read description below quotes this cap to the model.
  // The bounds MUST mirror the manifest's: the server stores plugin config unvalidated, so this clamp is
  // the only one there is.
  const pdfMaxPages = Math.min(Math.max(Number(ctx.config.pdfMaxPages) || DEFAULT_PDF_MAX_PAGES, 10), DEFAULT_PDF_MAX_PAGES);
  const pathMeta = (abs) => {
    const path = ctx.displayPath(abs);
    const workspaceId = ctx.currentAccess().workspaceRef?.workspaceId;
    return { path, ...(workspaceId ? { workspaceId } : {}) };
  };
  const statePath = (abs) => ctx.pathStateKey(abs);
  const safeError = (error) => new Error(ctx.sanitizePathOutput(error instanceof Error ? error.message : String(error)));
  const sanitizeResult = (result, abs) => ({
    ...result,
    content: result.content?.map((item) => item?.type === 'text'
      ? { ...item, text: ctx.sanitizePathOutput(item.text) }
      : item),
    details: { ...(result.details ?? {}), ...pathMeta(abs) },
  });

  // A conversation coming back after a daemon restart brings its history with it — and with it every
  // file this session has already seen. Replay that into the read state so the guard picks up where the
  // previous process left off instead of treating the whole conversation as file-blind.
  ctx.registerHook({
    name: 'brain.session.afterSpawn',
    run: (payload) => { seedReadStateFromHistory(payload?.sessionId, payload?.messages); },
  });

  // Every path tool below is declared `workspaceSafe`, which is what lets a sub-agent confined to one
  // Sandbox worktree have file tools at all. The declaration is not a promise made here — it states that
  // these tools route their paths through the host's workspace machinery instead of touching disk on
  // their own: `ctx.assertPathAllowed` resolves through the active PathView BEFORE the admin all-access
  // branch (so an admin parent cannot widen a confined child), `ctx.defaultCwd` is the workspace root,
  // and results leave through displayPath/pathStateKey/sanitizePathOutput so no host prefix crosses the
  // boundary. The spawner rewrites their "path must be absolute" wording and path parameters into
  // the workspace-relative contract, so the descriptions stay true in both modes.
  // Without the declaration the spawner drops them fail-closed and the child has no file access at all.
  ctx.registerTool(defineTool({
    name: 'Read', label: 'Read file',
    description: [
      'Read a UTF-8 text file, an image, a PDF, or a Jupyter notebook within the accessible repositories.',
      'This is the right tool when you need exact source text, config, logs or docs before editing. For broad discovery across the codebase, use Search or ListDir first.',
      'The path must be absolute. Missing files, directories and invalid arguments return an error and do not count as reading the file. An existing empty file comes back as a system-reminder warning and does count as having read it; an offset past the end of the file comes back as a system-reminder warning naming the real line count and does NOT, because it showed you nothing. Text reads return at most 2000 lines by default. For a large file use offset and limit to read only the part you need; offsets 0 and 1 both start at the first line. A read without an explicit limit whose text would exceed the read cap returns an error instead of a silent prefix — re-read it with offset and limit.',
      'Text results use cat -n format: line number + tab + content.',
      'Images (jpg/png/gif/webp/bmp) come back as an attachment. Jupyter notebooks are rendered as cells with text and supported image outputs.',
      `PDFs with at most 10 pages may omit \`pages\`; longer PDFs require it. Page ranges use "3", "1-5" or "1,3,5", with at most ${pdfMaxPages} pages per call. Text-layer pages return text and scanned pages return an image.`,
      'Do not re-read a file you just edited to check the change landed — Edit and Write would have errored if the write failed, so a verification read costs a round and tells you nothing.',
    ].join(' '),
    parameters: Type.Object({
      file_path: Type.String({ description: 'Absolute path to the file' }),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Line number to start reading from; 0 and 1 both mean the first line' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'Maximum number of lines to read' })),
      pages: Type.Optional(Type.String({ description: `PDF pages to read: "3", "1-5" or "1,3,5" (max ${pdfMaxPages} per call). Required only when the PDF has more than 10 pages; ignored for other files.` })),
    }, { additionalProperties: false }),
    execute: async (_id, p, _signal, _onUpdate, ectx) => {
      try {
        const abs = ctx.assertPathAllowed(p.file_path);
        if (p.offset !== undefined && (!Number.isSafeInteger(p.offset) || p.offset < 0)) {
          return fail('Read', new Error('offset must be a non-negative integer.'), pathMeta(abs));
        }
        if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || p.limit < 1)) {
          return fail('Read', new Error('limit must be a positive integer.'), pathMeta(abs));
        }
        // Both checks are on the PATH and run before any I/O: opening a blocking device to find out that it
        // blocks is the failure they exist to prevent, and a binary file has nothing to show either way.
        if (isBlockedDevicePath(abs)) {
          return fail('Read', new Error(`Cannot read '${ctx.displayPath(abs)}': this device file would block or produce infinite output.`), pathMeta(abs));
        }
        const binaryExt = binaryExtensionOf(abs);
        if (binaryExt) {
          return fail('Read', new Error(`This tool cannot read binary files. The file appears to be a binary ${binaryExt} file. Please use appropriate tools for binary file analysis.`), pathMeta(abs));
        }
        if (!existsSync(abs)) {
          return fail('Read', new Error(pathNotFoundMessage('File does not exist.', abs, ctx.defaultCwd(), (value) => ctx.displayPath(value))), pathMeta(abs));
        }
        const probe = readFileProbe(abs);
        // An existing empty file is not a failed read: the reference answers it with a warning and marks
        // the file read, and so do we. There is no content the model could be editing blind against —
        // there is no content at all — so the hash of those zero bytes authorizes a later Write exactly
        // as any other full read would, and the staleness check keeps its teeth if anything is appended.
        if (probe.length === 0) {
          const empty = Buffer.alloc(0);
          markFileRead(ctx.currentSessionId?.(), statePath(abs), empty);
          return ok('Read', EMPTY_FILE_REMINDER, { ...pathMeta(abs), bytes: 0, contentHash: hashOf(empty) });
        }
        const model = ectx?.model ?? ctx.model;
        const supportsImages = !model || (Array.isArray(model.input) ? model.input.includes('image') : true);
        if (isPdf(probe)) {
          const raw = readFileSync(abs);
          const result = sanitizeResult(await readPdf(abs, p.pages, supportsImages, readCap, pdfMaxPages), abs);
          if (!result.details?.ok) return result;
          // Only a read that actually put the whole document in front of the model authorizes a later
          // mutation, and `contentHash` is what vouches — live and when the transcript is replayed after a
          // restart — so it is emitted only for such a read.
          const { fullContentVisible, ...details } = result.details;
          if (fullContentVisible !== true) return { ...result, details };
          markFileRead(ctx.currentSessionId?.(), statePath(abs), raw);
          return { ...result, details: { ...details, contentHash: hashOf(raw) } };
        }
        if (extname(abs).toLowerCase() === '.ipynb') {
          const raw = readFileSync(abs);
          const result = sanitizeResult(readNotebook(raw, supportsImages, readCap), abs);
          if (!result.details?.ok) return result;
          // Same rule as the PDF branch: a truncated render, or one whose images the model cannot see, is
          // not a read of the notebook and must not vouch for overwriting it.
          if (result.details.truncated === true) return result;
          markFileRead(ctx.currentSessionId?.(), statePath(abs), raw);
          return { ...result, details: { ...result.details, contentHash: hashOf(raw) } };
        }
        if (looksLikeImage(probe)) {
          const raw = readFileSync(abs);
          const mime = detectImageMime(raw);
          if (mime) {
            const details = { ok: true, tool: 'Read', truncated: false, ...pathMeta(abs), bytes: raw.length, image: true, mimeType: mime };
            const resized = await resizeImage(raw, mime, { maxWidth: 2000, maxHeight: 2000 }).catch(() => null);
            let data = resized?.data;
            let outMime = resized?.mimeType ?? mime;
            const hints = [];
            if (resized) {
              const dim = formatDimensionNote(resized);
              if (dim) hints.push(dim);
            } else if (INLINE_IMAGE_TYPES.has(mime) && raw.length <= IMAGE_MAX_BYTES) {
              data = raw.toString('base64');
              outMime = mime;
            }
            if (data && !INLINE_IMAGE_TYPES.has(outMime)) data = undefined;
            details.mimeType = outMime;
            let note = `Read image file [${outMime}]`;
            if (hints.length) note += `\n${hints.join('\n')}`;
            if (!data) {
              note += `\n[Image omitted: could not be resized or embedded inline.]`;
              return { content: [{ type: 'text', text: note }], details };
            }
            if (!supportsImages) {
              note += `\n[Current model does not support images. The image will be omitted from this request.]`;
              return { content: [{ type: 'text', text: note }], details };
            }
            markFileRead(ctx.currentSessionId?.(), statePath(abs), raw);
            return {
              content: [{ type: 'text', text: note }, { type: 'image', data, mimeType: outMime }],
              details: { ...details, contentHash: hashOf(raw) },
            };
          }
        }
        const start = p.offset === undefined || p.offset <= 1 ? 0 : p.offset - 1;
        const requestedLines = p.limit ?? 2000;
        // An explicit `limit` is the caller taking responsibility for the size of the page, so no byte cap
        // applies to it. Without one, an oversized selection is an ERROR rather than a silent truncation:
        // quietly handing back a prefix is how a model ends up editing against content it never saw.
        const byteCap = p.limit === undefined ? readCap : Infinity;
        const snapshot = readTextSnapshot(abs, start, requestedLines, byteCap, probe);
        const total = snapshot.totalLines;
        if (total === 0) {
          markFileRead(ctx.currentSessionId?.(), statePath(abs), Buffer.alloc(0));
          return ok('Read', EMPTY_FILE_REMINDER, { ...pathMeta(abs), bytes: 0, contentHash: snapshot.contentHash });
        }
        // An offset past the end is answered, not refused — but it is the one read that displays NOTHING
        // of a file that HAS content, so it deliberately records no authorization and emits no
        // `contentHash`: neither this session nor a replayed transcript may treat it as having seen the
        // file. (The reference does mark it read; that is the divergence, and it is the direction that
        // keeps "a blind overwrite is never allowed against bytes the agent has not seen" true.)
        if (start >= total) return ok('Read', overOffsetReminder(p.offset, total), { ...pathMeta(abs), bytes: snapshot.totalBytes });
        if (snapshot.byteTruncated) {
          return fail('Read', new Error(
            `File content (${formatSize(snapshot.totalBytes)}) exceeds maximum allowed size (${formatSize(readCap)}). `
            + 'Use offset and limit parameters to read specific portions of the file, or search for specific '
            + 'content instead of reading the whole file.',
          ), pathMeta(abs));
        }
        // Same scope as the byte cap: an explicit `limit` is the caller taking responsibility for the page
        // it asked for, and that rule is what the paged-read contract rests on. What this adds is the
        // second bound the byte cap cannot express — dense content (JSON, minified sources) costs about
        // twice the tokens per byte of prose, so a page well under the byte ceiling can still be far over
        // the model's read budget.
        const tokens = estimateTokens(snapshot.content, extname(abs));
        if (p.limit === undefined && tokens > MAX_READ_TOKENS) {
          return fail('Read', new Error(
            `File content (${tokens} tokens) exceeds maximum allowed tokens (${MAX_READ_TOKENS}). `
            + 'Use offset and limit parameters to read specific portions of the file, or search for specific '
            + 'content instead of reading the whole file.',
          ), pathMeta(abs));
        }
        const endShown = snapshot.selectedEnd;
        const truncated = endShown < total;
        const sessionId = ctx.currentSessionId?.();
        const key = statePath(abs);
        const details = { ...pathMeta(abs), bytes: snapshot.totalBytes, truncated, contentHash: snapshot.contentHash };
        // Re-reading the same range of a file that has not moved would send a second copy of content the
        // earlier tool_result still carries. Point at that copy instead, once: dropping the range keeps the
        // entry (a file read through the stub is still a file in use, and without that touch a busy
        // conversation could age its own entry out from under the guard) while letting a third identical
        // Read return the bytes again, in case the result the stub pointed at is no longer in the context.
        if (readIsDuplicate(sessionId, key, snapshot.contentHash, start, p.limit)) {
          dropReadRange(sessionId, key);
          return ok('Read', FILE_UNCHANGED_STUB, details);
        }
        let text = addLineNumbers(snapshot.content, start + 1);
        if (truncated) {
          text += `\n\n[Showing lines ${start + 1}-${endShown} of ${total}. Use offset=${endShown + 1} to continue.]`;
        }
        recordTextRead(sessionId, key, snapshot.contentHash, start, p.limit);
        return ok('Read', text, details);
      } catch (e) { return fail('Read', safeError(e)); }
    },
  }), { workspaceSafe: true });

  ctx.registerTool(defineTool({
    name: 'Write', label: 'Write file',
    description: [
      'Create a new UTF-8 text file, or fully replace an existing one, within the accessible repositories.',
      'Use it only when you intend to replace the ENTIRE file content — for a localized change use Edit instead.',
      'Creating a new file still requires an allowed path. To overwrite an EXISTING file you must have read it in this conversation first, and it must not have changed on disk since; a Read error or an omitted image does not count as having read it. Overwriting a file you have not inspected discards content you never reviewed, so the write is refused until you have.',
      'Missing parent directories are created for you. Never create documentation files (*.md, README) unless the user explicitly asked, and keep emojis out of file content unless asked.',
      'Output includes a human summary, details.diff for review and details.patch (unified) for tooling. Read the diff before you consider an overwrite done.',
    ].join(' '),
    parameters: Type.Object({
      file_path: Type.String({ description: 'Absolute path to the file' }),
      content: Type.String({ description: 'The complete new content of the file' }),
    }, { additionalProperties: false }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.file_path);
        const sessionId = ctx.currentSessionId?.();
        // Serialize the read-modify-write against other mutations of the SAME file (different files still
        // run in parallel) so a concurrent edit can't slip between the diff-baseline read and the write.
        // The guard check lives INSIDE the queue for the same reason: a file that changed between the check
        // and the write would defeat the point of checking.
        return await withFileMutationQueue(abs, async () => {
          let beforeBuf = null;
          try { beforeBuf = readFileSync(abs); } catch { /* new file */ }
          const display = ctx.displayPath(abs);
          const guard = readGuardError(sessionId, statePath(abs), beforeBuf, false);
          if (guard) return ok('Write', `Error: ${guard}`, { ok: false, ...pathMeta(abs) });
          // Create the parent tree the way the reference does, so writing into a new directory costs no
          // extra round trip. It runs AFTER the guard and before the write: the guard decides whether this
          // write may happen at all, and a directory created for a refused write would be litter. The path
          // is already through ctx.assertPathAllowed, so every directory made here sits inside a root the
          // caller may write to.
          if (beforeBuf === null) mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, p.content, 'utf-8');
          const written = Buffer.from(p.content, 'utf-8');
          markFileRead(sessionId, statePath(abs), written, true);
          const base = beforeBuf?.toString('utf-8') ?? '';
          const diff = displayDiff(base, p.content);
          const patch = unifiedPatch(display, base, p.content);
          const summary = beforeBuf === null
            ? `File created successfully at: ${display}`
            : `The file ${display} has been updated successfully.`;
          return ok('Write', summary, {
            ...pathMeta(abs), bytes: Buffer.byteLength(p.content), contentHash: hashOf(written),
            ...(diff ? { diff } : {}), ...(patch ? { patch } : {}),
          });
        });
      } catch (e) { return fail('Write', safeError(e)); }
    },
  }), { workspaceSafe: true });

  ctx.registerTool(defineTool({
    name: 'Edit', label: 'Edit file',
    description: [
      'Replace an exact text snippet in a UTF-8 file within the accessible repositories. Use it for a targeted change, after reading enough surrounding context to locate the change precisely.',
      'You must have read the file in this conversation before editing it; Read errors and omitted images do not count. It must not have changed on disk since — an edit written from assumption, or against content that moved, is how work gets silently discarded.',
      'An empty old_string on a path that does not exist creates the file with new_string, parent directories included, and needs no prior Read. On a path that DOES exist it is refused: use Write to replace content that is already there.',
      'When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.',
      'By default old_string must match exactly ONCE, including indentation and whitespace. If it appears more than once, include more context. Set replace_all when every occurrence really is the same change. BOM and CRLF line endings are preserved. The optional fuzzy_match extension tolerates smart quotes, Unicode dashes, exotic spaces and trailing whitespace, but canonical calls must leave it false.',
      'This tool applies ONE replacement per call — there is no batch `edits` array. To make several changes to the same file, call it once per change.',
      'Output includes details.diff for review and details.patch (unified). If old_string is missing or ambiguous, read the file again and give more context.',
    ].join(' '),
    parameters: Type.Object({
      file_path: Type.String({ description: 'Absolute path to the file' }),
      old_string: Type.String({ description: 'Exact text to replace' }),
      new_string: Type.String({ description: 'Replacement text; must differ from old_string' }),
      replace_all: Type.Optional(Type.Boolean({ default: false, description: 'Replace every occurrence (default false)' })),
      fuzzy_match: Type.Optional(Type.Boolean({ default: false, description: 'Elowen extension: normalize smart quotes, Unicode dashes, exotic spaces and trailing whitespace before matching (default false)' })),
    }, { additionalProperties: false }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.file_path);
        const sessionId = ctx.currentSessionId?.();
        // Serialize the read-modify-write against other mutations of the SAME file (different files still
        // run in parallel) so a concurrent write can't slip between the match read and the write.
        return await withFileMutationQueue(abs, async () => {
          // An empty `old_string` is the reference's file-creation form (`FileEditTool.ts:224-263`), and it
          // is the ONE Edit that runs without a prior Read — there is nothing on disk to have read. On an
          // existing path it stays a refusal, in the reference's own words, so creation never turns into a
          // silent overwrite; Write, with its read-before-overwrite gate, remains the only way to replace
          // content that is already there.
          if (p.old_string === '') {
            const display = ctx.displayPath(abs);
            if (p.new_string === '') {
              return ok('Edit', 'Error: No changes to make: old_string and new_string are exactly the same.', { ok: false, ...pathMeta(abs) });
            }
            if (existsSync(abs)) {
              return ok('Edit', 'Error: Cannot create new file - file already exists.', { ok: false, ...pathMeta(abs) });
            }
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, p.new_string, 'utf-8');
            const created = Buffer.from(p.new_string, 'utf-8');
            markFileRead(sessionId, statePath(abs), created, true);
            const newDiff = displayDiff('', p.new_string);
            const newPatch = unifiedPatch(display, '', p.new_string);
            return ok('Edit', `File created successfully at: ${display}`, {
              ...pathMeta(abs), replacements: 1, contentHash: hashOf(created),
              ...(newDiff ? { diff: newDiff } : {}), ...(newPatch ? { patch: newPatch } : {}),
            });
          }
          // Checked on the stat, before the slurp: reading a gigabyte-plus file into a single string is the
          // out-of-memory failure this refusal exists to prevent, so it cannot come after the read.
          const size = statSync(abs).size;
          if (size > MAX_EDIT_BYTES) {
            return ok('Edit', `Error: File is too large to edit (${formatSize(size)}). Maximum editable file size is 1 GB.`,
              { ok: false, ...pathMeta(abs) });
          }
          const beforeBuf = readFileSync(abs);
          // `true`: an anchored edit may proceed through a post-write reformat of our OWN content — its
          // old_string still has to match what is on disk now. A blind overwrite (Write) gets no such pass.
          const display = ctx.displayPath(abs);
          const guard = readGuardError(sessionId, statePath(abs), beforeBuf, true);
          if (guard) return ok('Edit', `Error: ${guard}`, { ok: false, ...pathMeta(abs) });
          const before = beforeBuf.toString('utf-8');
          if (p.old_string === p.new_string) return ok('Edit', 'Error: No changes to make: old_string and new_string are exactly the same.', { ok: false, ...pathMeta(abs) });
          const plan = planEdit(before, p.old_string, p.new_string, p.replace_all ?? false, p.fuzzy_match === true);
          if (plan.error === 'empty') return ok('Edit', 'Error: old_string must not be empty.', { ok: false, ...pathMeta(abs) });
          if (plan.error === 'notfound') return ok('Edit', `Error: String to replace not found in file.\nString: ${p.old_string}`, { ok: false, ...pathMeta(abs) });
          if (plan.error === 'ambiguous') {
            return ok('Edit', `Error: Found ${plan.count} matches of the string to replace, but replace_all is false. `
              + 'To replace all occurrences, set replace_all to true. To replace only one occurrence, please '
              + `provide more context to uniquely identify the instance.\nString: ${p.old_string}`,
            { ok: false, ...pathMeta(abs), matches: plan.count });
          }
          if (plan.newContent === plan.content) return ok('Edit', 'Error: the replacement produced identical content.', { ok: false, ...pathMeta(abs) });
          writeFileSync(abs, plan.after, 'utf-8');
          const written = Buffer.from(plan.after, 'utf-8');
          markFileRead(sessionId, statePath(abs), written, true);
          const diff = displayDiff(plan.content, plan.newContent);
          const patch = unifiedPatch(display, plan.content, plan.newContent);
          return ok('Edit', `Edited ${display} (${plan.count > 1 ? `${plan.count} replacements` : '1 replacement'})`, {
            ...pathMeta(abs), replacements: plan.count, contentHash: hashOf(written), ...(diff ? { diff } : {}), ...(patch ? { patch } : {}),
          });
        });
      } catch (e) { return fail('Edit', safeError(e)); }
    },
  }), { workspaceSafe: true });

  ctx.registerTool(defineTool({
    name: 'ListDir', label: 'List directory',
    description: [
      'List the entries of a directory within the accessible repositories.',
      'Use for focused navigation when you already know the directory.',
      'Do not use recursively; use Search for codebase-wide discovery.',
    ].join(' '),
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const entries = readdirSync(abs).map((n) => {
          try { return statSync(join(abs, n)).isDirectory() ? `${n}/` : n; } catch { return n; }
        });
        return ok('ListDir', entries.join('\n') || '(empty)', { ...pathMeta(abs), count: entries.length });
      } catch (e) { return fail('ListDir', safeError(e)); }
    },
  }), { workspaceSafe: true });

  ctx.registerTool(defineTool({
    name: 'Search', label: 'Search files',
    description: [
      'Search UTF-8 file CONTENTS within an accessible repository path.',
      'Use for codebase discovery before reading or editing files. Always use this tool or Grep for content search — never grep or rg through Bash.',
      'It does not search file names: use Glob for name patterns, which is the tool that owns them, and never find through Bash.',
      'Input path must be an accessible directory or file. Output is grouped matches with line numbers and is capped; details.truncated indicates more specific searches are needed.',
      'Matching is always case-insensitive here, on every path that returns results. When case matters, use Grep, whose -i flag makes case folding explicit.',
    ].join(' '),
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path to search within' }),
      query: Type.String({ description: 'Literal text or regular expression to search for in file contents' }),
      include: Type.Optional(Type.String({ description: 'Optional file glob, e.g. "*.ts", "**/*.tsx", or "*.{ts,tsx}"; a comma- or space-separated list filters on every pattern in it' })),
    }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        if (!String(p.query ?? '').trim()) return ok('Search', 'Error: query is required.', { ok: false, ...pathMeta(abs) });
        const root = statSync(abs).isDirectory() ? abs : dirname(abs);
        const queryText = String(p.query);
        const lines = [];
        // Matches found, INCLUDING the ones past the cap. Counting them is what lets the notice below say
        // "showing 200 of 431" instead of guessing truncation from a full page — a page that is exactly
        // full is far more often a complete result than a trimmed one.
        let total = 0;
        try {
          const hits = await rgSearch(abs, root, queryText, p.include, searchMaxMatches);
          lines.push(...hits.lines);
          total = hits.total;
        } catch (error) {
          if (!commandMissing(error)) throw error;
          // Content search fails closed without rg — reading arbitrary whole files as UTF-8 is exactly how
          // a broad /data search pulled a production SQLite database into the V8 heap.
          return ok('Search', RIPGREP_REQUIRED, { ok: false, path: abs, mode: 'content' });
        }
        // Cap each hit so one minified/very long match line can't flood the result set.
        const formatted = lines.map((l) => truncateLine(l, RESULT_LINE_MAX).text).join('\n');
        const truncated = total > lines.length;
        // Say so out loud, like Grep does. The cut used to live only in `details.truncated`, which the
        // model never sees — so a search that stopped at its limit was indistinguishable from one that
        // found everything, and "not found" was reported for files that were simply past the cap.
        const notices = truncated
          ? [`[Showing ${lines.length} of ${total} matches — narrow the query or the include pattern for the rest.]`]
          : [];
        const text = [formatted || 'No matches found.', ...notices].join('\n\n');
        return ok('Search', text, { ...pathMeta(abs), mode: 'content', matches: lines.length, total, truncated });
      } catch (e) {
        if (isTransportFailure(e)) throw safeError(e);
        return fail('Search', safeError(e));
      }
    },
  }), { workspaceSafe: true });

  ctx.registerTool(defineTool({
    name: 'FileInfo', label: 'File info',
    description: [
      'Inspect basic filesystem metadata for a file or directory inside accessible repositories.',
      'Use to verify existence, size, file type, and modification time before reading a large file or writing changes.',
      'Output is JSON so it can be parsed by the model.',
    ].join(' '),
    parameters: Type.Object({ path: Type.String({ description: 'Absolute path to inspect' }) }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const s = statSync(abs);
        const info = { ...pathMeta(abs), type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', bytes: s.size, modifiedAt: s.mtime.toISOString() };
        return ok('FileInfo', JSON.stringify(info, null, 2), info);
      } catch (e) { return fail('FileInfo', safeError(e)); }
    },
  }), { workspaceSafe: true });

  ctx.registerTool(defineTool({
    name: 'GitStatus', label: 'Git status',
    description: [
      'Report concise git repository state for an accessible project path.',
      'Use before/after edits to understand branch, dirty files, and staged changes.',
      'Do not use for arbitrary shell commands; it only runs safe git status/rev-parse commands.',
    ].join(' '),
    parameters: Type.Object({ path: Type.String({ description: 'Absolute repository path or file path inside it' }) }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const access = ctx.currentAccess();
        if (access.workspaceRef) {
          const sandbox = ctx.control('sandbox');
          if (!sandbox?.gitStatus || !Number.isSafeInteger(access.contributionUserId)) {
            throw new Error('GitStatus is unavailable because Sandbox workspace Git support is not loaded');
          }
          const status = await sandbox.gitStatus({
            accountUserId: access.contributionUserId,
            workspace: access.workspaceRef,
            path: ctx.displayPath(abs),
          });
          const lines = status.lines;
          const out = [`branch ${status.branch}`, 'root .', lines.length ? '' : 'clean', ...lines.slice(0, 120)];
          return ok('GitStatus', out.join('\n'), { root: '.', workspaceId: access.workspaceRef.workspaceId, branch: status.branch, dirtyFiles: lines.length, truncated: lines.length > 120 });
        }
        const cwd = statSync(abs).isDirectory() ? abs : dirname(abs);
        const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const root = run(['rev-parse', '--show-toplevel']);
        ctx.assertPathAllowed(root);
        const branch = run(['branch', '--show-current']) || run(['rev-parse', '--short', 'HEAD']);
        const porcelain = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const lines = porcelain.split('\n').filter(Boolean);
        const out = [`branch ${branch}`, `root ${root}`, lines.length ? '' : 'clean', ...lines.slice(0, 120)];
        return ok('GitStatus', out.join('\n'), { root, branch, dirtyFiles: lines.length, truncated: lines.length > 120 });
      } catch (e) { return fail('GitStatus', safeError(e)); }
    },
  }), { workspaceSafe: true });

  ctx.registerTool(defineTool({
    name: 'Glob', label: 'Find files by pattern',
    description: [
      'Fast file pattern matching tool that works with any codebase size.',
      'Supports glob patterns like "**/*.js" or "src/**/*.ts".',
      'Returns matching file paths sorted by modification time (newest first).',
      'This is the tool that owns file-name search: use it whenever you need to find files by name patterns, and never find through Bash. For content search, use Grep or Search.',
    ].join(' '),
    parameters: Type.Object({
      pattern: Type.String({ description: 'The glob pattern to match files against (e.g. "**/*.ts", "src/**/*.{js,jsx}")' }),
      path: Type.Optional(Type.String({ description: 'The directory to search in. Defaults to the current working directory.' })),
    }),
    execute: async (_id, p) => {
      try {
        // An absolute pattern carries its own search root, which is what makes it match at all: the
        // matcher only ever sees paths relative to that root.
        const anchored = extractGlobBase(p.pattern);
        const searchRoot = anchored
          ? ctx.assertPathAllowed(anchored.base)
          : (p.path ? ctx.assertPathAllowed(p.path) : ctx.defaultCwd());
        if (!existsSync(searchRoot)) {
          return ok('Glob', `Error: ${pathNotFoundMessage(
            `Directory does not exist: ${ctx.displayPath(searchRoot)}.`, searchRoot, ctx.defaultCwd(), (value) => ctx.displayPath(value),
          )}`, { ok: false, ...pathMeta(searchRoot) });
        }
        const abs = statSync(searchRoot).isDirectory() ? searchRoot : dirname(searchRoot);
        if (!p.path && !anchored && isFsRoot(abs)) return ok('Glob', 'Error: no path given and no project root is set — pass an explicit path.', { ok: false });
        const regex = globRegex(anchored ? anchored.pattern : p.pattern);
        if (!regex) return ok('Glob', 'Error: invalid glob pattern.', { ok: false });
        const globMax = Math.min(Math.max(Number(ctx.config.globMax) || DEFAULT_GLOB_MAX, 10), 500);
        // One over the cap, so "the tree holds exactly WALK_CAP files" is distinguishable from "the walk
        // ran out of budget" — the notice below claims matches were never examined, which must not be
        // said about a traversal that actually finished.
        const walked = walkFiles(abs, WALK_CAP + 1);
        const walkTruncated = walked.length > WALK_CAP;
        const files = walked.slice(0, WALK_CAP);
        // "newest first" must hold across the WHOLE match set, so collect EVERY match (matching is cheap),
        // then sort by mtime and trim — never stop the walk in traversal order and sort only that subset,
        // which would drop a newer file that happened to sit past the cap.
        const matched = [];
        for (const file of files) {
          const rel = relative(abs, file) || file;
          if (regex.test(rel) || regex.test(rel.split('/').at(-1) ?? rel)) matched.push({ path: rel, mtime: mtimeOf(file) });
        }
        matched.sort((a, b) => b.mtime - a.mtime);
        const results = matched.slice(0, globMax).map((m) => m.path);
        const truncated = matched.length > globMax;
        // Both cuts used to live only in `details`, which the model never sees. They mean different
        // things and are reported separately: the first trimmed a KNOWN match set (so it can name the
        // real total), while the second stopped the traversal itself, meaning matches may be missing
        // altogether rather than merely trimmed — the more serious of the two, and the one that silently
        // turned an incomplete answer into a confident one. When the traversal WAS capped, "newest" and
        // the total describe only what it examined, which is what the second notice warns about.
        const notices = [
          ...(truncated ? [`[Showing the ${results.length} newest of ${matched.length} matching files — narrow the pattern for more.]`] : []),
          ...(walkTruncated ? [`[The traversal stopped at ${WALK_CAP} files, so matches beyond it were never examined — search a narrower path.]`] : []),
        ];
        const text = [results.join('\n') || 'No files found', ...notices].join('\n\n');
        return ok('Glob', text, {
          ...pathMeta(abs), pattern: p.pattern, matches: results.length, truncated, walkTruncated,
        });
      } catch (e) { return fail('Glob', safeError(e)); }
    },
  }), { workspaceSafe: true });

  ctx.registerTool(defineTool({
    name: 'Grep', label: 'Search file contents',
    description: [
      'A powerful search tool built on ripgrep for searching file contents by regular expression.',
      'ALWAYS use Grep for content search tasks. NEVER invoke grep or rg as a Bash command. The Grep tool has been optimized for correct permissions and access.',
      'Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+").',
      'Pattern syntax: uses ripgrep (not grep) — literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code).',
      'Filter files with the glob parameter (e.g. "*.js", "**/*.tsx"); a comma- or space-separated list filters on every pattern in it.',
      'Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts per file.',
      'Use context lines (-A/-B/-C) to show surrounding lines in content mode.',
      'For multiline patterns (crossing line boundaries), set multiline: true.',
      'Matching is case-sensitive unless you pass -i; the sibling Search tool always matches case-insensitively, so use Grep when case matters.',
      `Returns at most ${searchMaxMatches} results per call; when more exist the result says which offset continues the listing, so page through with offset instead of re-running a broader search.`,
      `Matching lines are cut at ${RESULT_LINE_MAX} columns and carry ripgrep's own "[... omitted end of long line]" marker, so one minified line cannot fill the page.`,
    ].join(' '),
    parameters: Type.Object({
      pattern: Type.String({ description: 'The regular expression pattern to search for in file contents' }),
      path: Type.Optional(Type.String({ description: 'File or directory to search in. Defaults to the current working directory.' })),
      glob: Type.Optional(Type.String({ description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")' })),
      type: Type.Optional(Type.String({ description: 'File type to search (rg --type), e.g. "ts", "js", "py", "go", "rust". Cheaper and more precise than glob for standard types; must be a name ripgrep lists in --type-list.' })),
      output_mode: Type.Optional(Type.Union([
        Type.Literal('content'), Type.Literal('files_with_matches'), Type.Literal('count'),
      ], { description: 'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".' })),
      '-A': Type.Optional(Type.Number({ description: 'Lines to show after each match (content mode only).' })),
      '-B': Type.Optional(Type.Number({ description: 'Lines to show before each match (content mode only).' })),
      '-C': Type.Optional(Type.Number({ description: 'Lines to show before and after each match (content mode only). Alias for context.' })),
      context: Type.Optional(Type.Number({ description: 'Lines to show before and after each match (rg -C), content mode only. Takes precedence over -C, -A and -B.' })),
      '-i': Type.Optional(Type.Boolean({ description: 'Case-insensitive search (rg -i). Defaults to false.' })),
      '-n': Type.Optional(Type.Boolean({ description: 'Show line numbers in output (rg -n), content mode only. Defaults to true.' })),
      multiline: Type.Optional(Type.Boolean({ description: 'Enable multiline matching for patterns crossing line boundaries.' })),
      head_limit: Type.Optional(Type.Integer({ minimum: 0, description: `Max number of result lines to return. Defaults to ${searchMaxMatches}; 0 removes the head limit but the ${searchMaxMatches} cap still applies.` })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Skip this many results before the page returned, for continuing a truncated listing. Defaults to 0.' })),
    }),
    execute: async (_id, p) => {
      try {
        // rg accepts a single FILE as its search path — pass it through so `path` pointing at a file
        // searches that file, not its whole parent directory. `root` (its dirname) only relativizes output.
        const target = p.path ? ctx.assertPathAllowed(p.path) : ctx.defaultCwd();
        if (!existsSync(target)) {
          return ok('Grep', `Error: ${pathNotFoundMessage(
            `Path does not exist: ${ctx.displayPath(target)}.`, target, ctx.defaultCwd(), (value) => ctx.displayPath(value),
          )}`, { ok: false, ...pathMeta(target) });
        }
        const isDir = statSync(target).isDirectory();
        const root = isDir ? target : dirname(target);
        if (!p.path && isFsRoot(root)) return ok('Grep', 'Error: no path given and no project root is set — pass an explicit path.', { ok: false });
        if (!String(p.pattern ?? '').trim()) return ok('Grep', 'Error: pattern is required.', { ok: false });
        if (p.offset !== undefined && (!Number.isSafeInteger(p.offset) || p.offset < 0)) {
          return ok('Grep', 'Error: offset must be a non-negative integer.', { ok: false });
        }
        if (p.head_limit !== undefined && (!Number.isSafeInteger(p.head_limit) || p.head_limit < 0)) {
          return ok('Grep', 'Error: head_limit must be a non-negative integer.', { ok: false });
        }
        // The reference's default: a file listing, not matching lines. It is the cheaper first answer for
        // the "where does this live" question that most searches actually are, and the description states
        // it, so a caller that wants line content asks for `content` explicitly.
        const outputMode = p.output_mode ?? 'files_with_matches';
        const offset = p.offset ?? 0;
        let lines;
        let truncated = false;
        let total = 0;
        try {
          const r = await rgGrep(target, root, p.pattern, {
            include: p.glob,
            type: p.type,
            outputMode,
            beforeContext: p['-B'],
            afterContext: p['-A'],
            contextLines: p.context ?? p['-C'],
            lineNumbers: p['-n'] !== false,
            caseInsensitive: p['-i'] === true,
            multiline: p.multiline === true,
            headLimit: p.head_limit,
            offset,
            maxMatches: searchMaxMatches,
          });
          lines = r.lines;
          truncated = r.truncated;
          total = r.total;
        } catch (error) {
          if (!commandMissing(error)) throw error;
          return ok('Grep', RIPGREP_REQUIRED, { ok: false, path: root, pattern: p.pattern, outputMode });
        }
        // Content rows are already bounded by rg's --max-columns and carry its marker, so re-cutting them
        // here would only chop that marker off. --max-columns does NOT apply to the other two modes, whose
        // rows are file paths, so those keep the explicit bound.
        const rows = outputMode === 'content' ? lines : lines.map((l) => truncateLine(l, RESULT_LINE_MAX).text);
        // The reference splits the empty result by mode: a file listing that found nothing says so about
        // files, the other two modes about matches.
        let text = rows.join('\n') || (outputMode === 'files_with_matches' ? 'No files found' : 'No matches found');
        // Say out loud which slice of the result set this is, and — when more remains — the exact offset
        // that continues it. Counted in RESULT ROWS, which is what `offset` skips: in content mode with
        // -A/-B/-C a row may be a context line, so "results" is not the same as "matches". Unlike Read's
        // 1-based line offset, this offset counts rows already shown, so the next page starts AT that
        // number, not at that plus one.
        const lastShown = offset + rows.length;
        if (!rows.length && total > 0) {
          text = `No more results — offset ${offset} is past the ${total} results found.`;
        } else if (rows.length && (truncated || offset > 0)) {
          text += `\n\n[Showing results ${offset + 1}-${lastShown} of ${total}.${truncated ? ` Use offset=${lastShown} to continue.` : ''}]`;
        }
        return ok('Grep', text, {
          ...pathMeta(root), pattern: p.pattern, outputMode, matches: rows.length, total, offset, truncated,
        });
      } catch (e) {
        if (isTransportFailure(e)) throw safeError(e);
        return fail('Grep', safeError(e));
      }
    },
  }), { workspaceSafe: true });

  ctx.logger.info('registered Read, Write, Edit, ListDir, Search, FileInfo, GitStatus, Glob, Grep');
}
