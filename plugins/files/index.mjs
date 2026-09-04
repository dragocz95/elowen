// Files plugin: read/write/list, each confined to the caller's accessible repos via ctx.assertPathAllowed
// (which reads the per-session Policy). A guard rejection is returned as an error text so the model can
// react, not thrown, matching how the Elowen* tools surface API errors.
import { defineTool, withFileMutationQueue, truncateHead, truncateLine, formatSize, generateDiffString, generateUnifiedPatch, resizeImage, formatDimensionNote } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
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
const DEFAULT_GLOB_MAX = 100;
/** How many files a traversal may visit before it gives up. Shared by Glob and Search's rg-less
 *  fallback so both report the same bound with the same wording. */
const WALK_CAP = 10_000;
const DEFAULT_GREP_MAX_MATCHES = 200;
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
  return {
    content: [{ type: 'text', text }, ...images],
    details: {
      ok: true, tool: 'Read', path: abs, pdf: true, pageCount: total,
      pages: wanted, renderedPages: rendered, truncated: capped.truncated || skippedImages > 0,
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
/** sessionId → (absolute path → { hash, ours }). Bounded LRU-ish: Map preserves insertion order, so the
 *  oldest entry is evicted once a cap is passed. */
const readState = new Map();

const hashOf = (buf) => createHash('sha256').update(buf).digest('hex');

function sessionFiles(sessionId) {
  let files = readState.get(sessionId);
  // Re-insert on every touch, so eviction is by least-recently-USED, not by creation order. Insertion
  // order alone would evict the oldest-OPENED conversation — typically the long-running CLI session the
  // operator is actually sitting in — as soon as 64 short-lived sub-agent/cron sessions had come and gone,
  // and its next edit would be refused with a bewildering "has not been read in this conversation".
  if (files) readState.delete(sessionId);
  else files = new Map();
  readState.set(sessionId, files);
  if (readState.size > READ_STATE_MAX_SESSIONS) readState.delete(readState.keys().next().value);
  return files;
}

function recordHash(sessionId, abs, hash, ours) {
  if (!sessionId) return;
  const files = sessionFiles(sessionId);
  files.delete(abs); // re-insert so the entry counts as freshest for eviction
  files.set(abs, { hash, ours });
  if (files.size > READ_STATE_MAX_FILES) files.delete(files.keys().next().value);
}

/** Record that this conversation now knows `abs` holds exactly `content`. `ours` marks content WE just
 *  wrote (as opposed to read), which is what earns the one post-write formatter forgiveness above. */
export function markFileRead(sessionId, key, content, ours = false) {
  recordHash(sessionId, key, hashOf(content), ours);
}

/** Which tool results vouch for a file's content, and whether that content counts as OURS — the `ours`
 *  tier has to survive a restart too, or the first edit after one would trip over a formatter rewrite
 *  that the live session would have forgiven. */
const VOUCHING_TOOLS = { Read: false, Write: true, Edit: true };

/** Re-seed this session's read state from its own rehydrated history.
 *
 *  The state above lives in daemon memory, but the CONVERSATION outlives the process — and Elowen
 *  restarts routinely (auto-update). Without this, reopening a conversation made the guard insist the
 *  agent had never seen a file it read three messages ago and still has in its context: a pointless
 *  re-read of a file that had not changed, on every restart, for every file.
 *
 *  Seeding from the transcript rather than from a persisted map is what keeps the guard HONEST. The
 *  recorded hash is replayed from the very tool result the model can still see, so the two move
 *  together: a Read that compaction dropped from the context seeds nothing and the guard correctly
 *  forgets it too. A persisted map would keep vouching for content the model no longer holds.
 *
 *  Messages arrive oldest-first, so the newest result for a file wins — the same last-write-wins order
 *  the live path has. Nothing is trusted about the file itself: the replayed hash still has to match
 *  what is on disk now, so anything edited while the daemon was down is refused exactly as before. */
export function seedReadStateFromHistory(sessionId, messages) {
  if (!sessionId || !Array.isArray(messages)) return 0;
  let seeded = 0;
  for (const m of messages) {
    const d = m?.details;
    if (!d || d.ok !== true || typeof d.path !== 'string' || typeof d.contentHash !== 'string') continue;
    const ours = VOUCHING_TOOLS[d.tool];
    if (ours === undefined) continue; // some other tool's result that happens to carry a path
    const key = typeof d.workspaceId === 'string' && d.workspaceId
      ? `${d.workspaceId}\0${d.path}`
      : d.path;
    recordHash(sessionId, key, d.contentHash, ours);
    seeded++;
  }
  return seeded;
}

/** Why a mutation of `abs` must not proceed, or null when it may. `current` is the file's bytes on disk, or
 *  null when it does not exist yet (a brand-new file is always allowed — there is nothing to lose).
 *  `tolerateAuthoredDrift` is set by Edit only: see the note above on why an anchored edit may proceed
 *  through the formatter's window while a blind overwrite may not.
 *
 *  PURE — it decides, it never records. A mutation that is allowed here but then FAILS (an `old_string` that
 *  no longer matches) must leave the recorded state exactly as it was: baselining the divergent bytes at
 *  decision time would bless content the agent never actually saw, and the blind overwrite it is supposed
 *  to refuse would sail through on the next call. Only a mutation that really lands re-records (markFileRead). */
export function readGuardError(sessionId, key, current, tolerateAuthoredDrift = false, display = key) {
  if (!sessionId) return null;  // no turn scope to key on — inert, not wrong
  if (current === null) return null; // new file: nothing was there to overwrite
  const entry = readState.get(sessionId)?.get(key);
  if (!entry) {
    return `${display} has not been read in this conversation. Read it first — editing a file you have not seen `
      + 'risks overwriting content you never reviewed.';
  }
  if (hashOf(current) === entry.hash) return null;
  // Content we wrote, reshaped afterwards (the formatters hook). An anchored edit may proceed: its `old_string`
  // still has to match these current bytes to apply at all, which is what keeps it honest.
  if (entry.ours && tolerateAuthoredDrift) return null;
  return `${display} has changed on disk since you last read it. Read it again before writing — otherwise your `
    + 'change is based on stale content and would discard whatever else was written.';
}

function safeRegex(query) {
  try { return new RegExp(query, 'i'); }
  catch { return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
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

/** Relativize an rg `--count` line (`/abs:count`). */
function relativizeCountLine(line, root) {
  if (!line.startsWith('/')) return line;
  const idx = line.lastIndexOf(':');
  if (idx < 0) return line;
  const p = line.slice(0, idx);
  return `${relative(root, p) || p}${line.slice(idx)}`;
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
async function rgSearch(abs, root, queryText, include, mode, maxMatches) {
  const ignoreGlobs = [...SKIP_DIRS].map((d) => `!${d}/**`);
  if (mode === 'files') {
    const args = ['--files', ...ignoreGlobs.flatMap((g) => ['--glob', g]), ...(include ? ['--glob', include] : []), abs];
    try {
      const { stdout } = await execFileP('rg', args, { cwd: root, encoding: 'utf8', timeout: SEARCH_TIMEOUT_MS, maxBuffer: 1_000_000 });
      const query = safeRegex(queryText);
      const all = stdout.split('\n').filter(Boolean)
        .map((p) => relative(root, p.startsWith('/') ? p : join(root, p)) || p)
        .filter((p) => query.test(p));
      return { lines: all.slice(0, maxMatches), total: all.length };
    } catch (e) {
      // rg exits 1 on "no files matched" just like content mode — that's a real empty result, NOT an
      // rg-unavailable signal. Without this the caller would treat it as a miss and fall back to the JS
      // walk (which ignores .gitignore), surfacing gitignored files rg deliberately skipped.
      if (e && typeof e === 'object' && 'code' in e && e.code === 1) return { lines: [], total: 0 };
      throw e;
    }
  }
  const args = [
    '--line-number', '--with-filename', '--color', 'never', '--no-heading', '-i',
    ...ignoreGlobs.flatMap((g) => ['--glob', g]),
    ...(include ? ['--glob', include] : []),
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
    throw e;
  }
}

/** ripgrep wrapper for the Grep tool: supports output modes, context lines, multiline and head_limit.
 *  `target` is the rg PATH — a directory OR a single file (rg accepts both); `root` relativizes output.
 *  Returns `{ lines, truncated }`, where `truncated` is computed BEFORE the head_limit slice so the
 *  caller can tell the model results were cut. `head_limit: 0` means unlimited (reference semantics). */
async function rgGrep(target, root, pattern, opts = {}) {
  const { include, outputMode = 'content', beforeContext, afterContext, contextLines, multiline, headLimit, maxMatches } = opts;
  const ignoreGlobs = [...SKIP_DIRS].map((d) => `!${d}/**`);
  const args = ['--color', 'never', '--no-heading'];
  if (outputMode === 'files_with_matches') {
    args.push('--files-with-matches');
  } else if (outputMode === 'count') {
    args.push('--count');
  } else {
    args.push('--line-number', '--with-filename');
    if (beforeContext != null) args.push('-B', String(beforeContext));
    if (afterContext != null) args.push('-A', String(afterContext));
    if (contextLines != null) args.push('-C', String(contextLines));
  }
  // `--multiline-dotall` makes `.` cross newlines, which is what the tool description promises multiline
  // does — `--multiline` alone only lets an explicit `\n` in the pattern span lines.
  if (multiline) args.push('--multiline', '--multiline-dotall');
  args.push(...ignoreGlobs.flatMap((g) => ['--glob', g]));
  if (include) args.push('--glob', include);
  args.push('--', pattern, target);
  let stdout;
  try {
    ({ stdout } = await execFileP('rg', args, { cwd: root, encoding: 'utf8', timeout: SEARCH_TIMEOUT_MS, maxBuffer: 2_000_000 }));
  } catch (e) {
    // rg exits 1 on "no matches" (same as content mode) — a real empty result, not an rg-missing signal.
    if (e && typeof e === 'object' && 'code' in e && e.code === 1) return { lines: [], truncated: false };
    throw e;
  }
  const raw = stdout.split('\n').filter(Boolean);
  const effHead = headLimit === 0 ? Infinity : (headLimit ?? Infinity); // 0 → unlimited
  const cap = Math.min(effHead, maxMatches ?? Infinity);

  if (outputMode === 'files_with_matches') {
    // Sort by mtime (newest first) and relativize — matches Glob and the Claude reference.
    const files = raw.map((abs) => ({ abs, mtime: mtimeOf(abs) })).sort((a, b) => b.mtime - a.mtime);
    const truncated = files.length > cap;
    return { lines: files.slice(0, cap).map((f) => relative(root, f.abs) || f.abs), truncated };
  }
  const truncated = raw.length > cap;
  const kept = raw.slice(0, cap);
  const lines = kept.map((line) => outputMode === 'count' ? relativizeCountLine(line, root) : relativizeContentLine(line, root));
  return { lines, truncated };
}

export function register(ctx) {
  const readCap = Math.min(Math.max(Number(ctx.config.readCap) || DEFAULT_MAX, 20_000), 500_000);
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
  // boundary. The spawner rewrites their "path must be absolute" wording and their `path` parameter into
  // the workspace-relative contract, so the descriptions stay true in both modes.
  // Without the declaration the spawner drops them fail-closed and the child has no file access at all.
  ctx.registerTool(defineTool({
    name: 'Read', label: 'Read file',
    description: [
      'Read a UTF-8 text file, an image, a PDF, or a Jupyter notebook within the accessible repositories.',
      'This is the right tool when you need exact source text, config, logs or docs before editing. For broad discovery across the codebase, use Search or ListDir first.',
      'The path must be absolute. Missing files, directories, empty files, and invalid ranges return an error and do not count as reading the file. Text reads return at most 2000 lines by default. For a large file use offset and limit to read only the part you need; offsets 0 and 1 both start at the first line.',
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
    }),
    execute: async (_id, p, _signal, _onUpdate, ectx) => {
      try {
        const abs = ctx.assertPathAllowed(p.file_path);
        const raw = readFileSync(abs);
        if (raw.length === 0) return fail('Read', new Error('Cannot read an empty file.'), pathMeta(abs));
        const model = ectx?.model ?? ctx.model;
        const supportsImages = !model || (Array.isArray(model.input) ? model.input.includes('image') : true);
        if (isPdf(raw)) {
          const result = sanitizeResult(await readPdf(abs, p.pages, supportsImages, readCap, pdfMaxPages), abs);
          // Only a read that actually SHOWED the agent something counts. A bad `pages` spec, an encrypted
          // PDF or a missing poppler must not leave the file marked as read — that would license a later
          // blind Write over a document nobody ever saw.
          if (!result.details?.ok) return result;
          markFileRead(ctx.currentSessionId?.(), statePath(abs), raw);
          // The hash rides the RESULT so a later process can re-seed the read state from this very
          // message (see seedReadStateFromHistory) instead of demanding the file be read again.
          return { ...result, details: { ...result.details, contentHash: hashOf(raw) } };
        }
        if (extname(abs).toLowerCase() === '.ipynb') {
          const result = sanitizeResult(readNotebook(raw, supportsImages, readCap), abs);
          if (!result.details?.ok) return result;
          markFileRead(ctx.currentSessionId?.(), statePath(abs), raw);
          return { ...result, details: { ...result.details, contentHash: hashOf(raw) } };
        }
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
            data = raw.toString('base64'); // Photon unavailable: embed the original bytes for supported formats
            outMime = mime;
          }
          // The API accepts only jpeg/png/gif/webp image blocks. resizeImage can hand back a small BMP
          // unconverted (raw bytes, mimeType still image/bmp); embedding that would 400 the whole turn, so
          // drop any image whose final type isn't inline-supported and fall through to the text-only note.
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
        const body = raw.toString('utf-8');
        const allLines = body.split('\n');
        // A trailing newline yields a phantom empty final element — it terminates the last line, it is not a
        // line of its own. Drop it from the count so pagination doesn't advertise (and truncate at) a bogus
        // extra empty line, which would report `truncated: true` and hand out a continuation offset that
        // reads back nothing.
        const total = allLines.length - (body.endsWith('\n') && allLines.length > 1 ? 1 : 0);
        if (p.offset !== undefined && (!Number.isSafeInteger(p.offset) || p.offset < 0)) {
          return fail('Read', new Error('offset must be a non-negative integer.'), pathMeta(abs));
        }
        if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || p.limit < 1)) {
          return fail('Read', new Error('limit must be a positive integer.'), pathMeta(abs));
        }
        const start = p.offset === undefined || p.offset <= 1 ? 0 : p.offset - 1;
        if (start >= total) return fail('Read', new Error(`Offset ${p.offset} is beyond end of file (${total} lines total)`), pathMeta(abs));
        const requestedLines = p.limit ?? 2000;
        const endLine = Math.min(start + requestedLines, total);
        const selected = allLines.slice(start, endLine).join('\n');
        const r = truncateHead(selected, { maxBytes: readCap, maxLines: Infinity });
        let shownText;
        let shownLines;
        let byteTruncated;
        if (r.firstLineExceedsLimit) {
          shownText = sliceBytes(selected, readCap);
          shownLines = 1;
          byteTruncated = true;
        } else {
          shownText = r.content;
          byteTruncated = r.truncated;
          shownLines = r.truncated ? r.outputLines : (endLine - start);
        }
        const endShown = start + shownLines; // 1-indexed last line shown
        const truncated = byteTruncated || endShown < total;
        let text = addLineNumbers(shownText, start + 1);
        if (r.firstLineExceedsLimit) {
          text += `\n\n[Line ${start + 1} exceeds the ${formatSize(readCap)} read limit; showing the first ${formatSize(Buffer.byteLength(shownText))}. Use bash (sed/head) to read the rest.]`;
        } else if (truncated) {
          text += `\n\n[Showing lines ${start + 1}-${endShown} of ${total}. Use offset=${endShown + 1} to continue.]`;
        }
        // Record the WHOLE file's bytes, not just the slice returned: the guard tracks what is on disk, and
        // a paginated read still establishes the current file baseline after its range has been validated.
        markFileRead(ctx.currentSessionId?.(), statePath(abs), raw);
        return ok('Read', text, { ...pathMeta(abs), bytes: Buffer.byteLength(body), truncated, contentHash: hashOf(raw) });
      } catch (e) { return fail('Read', safeError(e)); }
    },
  }), { workspaceSafe: true });

  ctx.registerTool(defineTool({
    name: 'Write', label: 'Write file',
    description: [
      'Create a new UTF-8 text file, or fully replace an existing one, within the accessible repositories.',
      'Use it only when you intend to replace the ENTIRE file content — for a localized change use Edit instead.',
      'Creating a new file still requires an allowed path and an existing parent directory. To overwrite an EXISTING file you must have successfully read it in this conversation first; a Read error or omitted image does not count. Overwriting a file you have not inspected discards content you never reviewed, so the write is refused until you have.',
      'The parent directory must already exist — create it with Bash (mkdir -p) first if needed. Never create documentation files (*.md, README) unless the user explicitly asked, and keep emojis out of file content unless asked.',
      'Output includes a human summary, details.diff for review and details.patch (unified) for tooling. Read the diff before you consider an overwrite done.',
    ].join(' '),
    parameters: Type.Object({
      file_path: Type.String({ description: 'Absolute path to the file' }),
      content: Type.String({ description: 'The complete new content of the file' }),
    }),
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
          const guard = readGuardError(sessionId, statePath(abs), beforeBuf, false, display);
          if (guard) return ok('Write', `Error: ${guard}`, { ok: false, ...pathMeta(abs) });
          writeFileSync(abs, p.content, 'utf-8');
          const written = Buffer.from(p.content, 'utf-8');
          markFileRead(sessionId, statePath(abs), written, true);
          const base = beforeBuf?.toString('utf-8') ?? '';
          const diff = displayDiff(base, p.content);
          const patch = unifiedPatch(display, base, p.content);
          return ok('Write', `Wrote ${Buffer.byteLength(p.content)} bytes to ${display}`, {
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
      'You must have successfully read the file in this conversation before editing it; a Read error or omitted image does not count. It must not have changed on disk since — an edit written from assumption, or against content that moved, is how work gets silently discarded.',
      'By default old_string must match exactly ONCE, including indentation and whitespace. If it appears more than once, include more context. Set replace_all when every occurrence really is the same change. BOM and CRLF line endings are preserved. The optional fuzzy_match extension tolerates smart quotes, Unicode dashes, exotic spaces and trailing whitespace, but canonical calls must leave it false.',
      'This tool applies ONE replacement per call — there is no batch `edits` array. To make several changes to the same file, call it once per change.',
      'Output includes details.diff for review and details.patch (unified). If old_string is missing or ambiguous, read the file again and give more context.',
    ].join(' '),
    parameters: Type.Object({
      file_path: Type.String({ description: 'Absolute path to the file' }),
      old_string: Type.String({ description: 'Exact text to replace' }),
      new_string: Type.String({ description: 'Replacement text; must differ from old_string' }),
      replace_all: Type.Optional(Type.Boolean({ description: 'Replace every occurrence (default false)' })),
      fuzzy_match: Type.Optional(Type.Boolean({ description: 'Elowen extension: normalize smart quotes, Unicode dashes, exotic spaces and trailing whitespace before matching (default false)' })),
    }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.file_path);
        const sessionId = ctx.currentSessionId?.();
        // Serialize the read-modify-write against other mutations of the SAME file (different files still
        // run in parallel) so a concurrent write can't slip between the match read and the write.
        return await withFileMutationQueue(abs, async () => {
          const beforeBuf = readFileSync(abs);
          // `true`: an anchored edit may proceed through a post-write reformat of our OWN content — its
          // old_string still has to match what is on disk now. A blind overwrite (Write) gets no such pass.
          const display = ctx.displayPath(abs);
          const guard = readGuardError(sessionId, statePath(abs), beforeBuf, true, display);
          if (guard) return ok('Edit', `Error: ${guard}`, { ok: false, ...pathMeta(abs) });
          const before = beforeBuf.toString('utf-8');
          if (p.old_string === p.new_string) return ok('Edit', 'Error: old_string and new_string are identical.', { ok: false, ...pathMeta(abs) });
          const plan = planEdit(before, p.old_string, p.new_string, p.replace_all ?? false, p.fuzzy_match === true);
          if (plan.error === 'empty') return ok('Edit', 'Error: old_string must not be empty.', { ok: false, ...pathMeta(abs) });
          if (plan.error === 'notfound') return ok('Edit', 'Error: old_string not found in the file. Match it exactly, including whitespace.', { ok: false, ...pathMeta(abs) });
          if (plan.error === 'ambiguous') return ok('Edit', `Error: old_string matches ${plan.count} times. Provide more context to make it unique, or set replace_all.`, { ok: false, ...pathMeta(abs), matches: plan.count });
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
      'Search file names or UTF-8 file contents within an accessible repository path.',
      'Use for codebase discovery before reading or editing files. Prefer content mode for symbols/text and files mode for path/name lookup. Always use this tool for content or name search — never grep, rg or find through Bash.',
      'Input path must be an accessible directory or file. Output is grouped matches with line numbers and is capped; details.truncated indicates more specific searches are needed.',
    ].join(' '),
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path to search within' }),
      query: Type.String({ description: 'Literal text or regular expression to search for' }),
      mode: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('files')], { description: 'Search content (default) or file names' })),
      include: Type.Optional(Type.String({ description: 'Optional file glob, e.g. "*.ts", "**/*.tsx", or "*.{ts,tsx}"' })),
    }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const mode = p.mode === 'files' ? 'files' : 'content';
        if (!String(p.query ?? '').trim()) return ok('Search', 'Error: query is required.', { ok: false, ...pathMeta(abs) });
        const root = statSync(abs).isDirectory() ? abs : dirname(abs);
        const queryText = String(p.query);
        const query = safeRegex(queryText);
        const include = globRegex(p.include);
        const lines = [];
        // Matches found, INCLUDING the ones past the cap. Counting them is what lets the notice below say
        // "showing 200 of 431" instead of guessing truncation from a full page — a page that is exactly
        // full is far more often a complete result than a trimmed one.
        let total = 0;
        // Set when the traversal itself ran out of budget, so matches may be missing rather than trimmed.
        let walkTruncated = false;
        try {
          const hits = await rgSearch(abs, root, queryText, p.include, mode, searchMaxMatches);
          lines.push(...hits.lines);
          total = hits.total;
        } catch (error) {
          if (!commandMissing(error)) throw error;
          // Filename matching stays safe without rg: the bounded walk reads directory entries and stats,
          // never file contents. Content search must fail closed — reading arbitrary whole files as UTF-8
          // is exactly how a broad /data search pulled a production SQLite database into the V8 heap.
          if (mode === 'content') return ok('Search', RIPGREP_REQUIRED, { ok: false, path: abs, mode });
          const walked = walkFiles(abs, WALK_CAP + 1);
          walkTruncated = walked.length > WALK_CAP;
          for (const file of walked.slice(0, WALK_CAP)) {
            const rel = relative(root, file) || file;
            if (include && !include.test(rel) && !include.test(rel.split('/').at(-1) ?? rel)) continue;
            if (!query.test(rel)) continue;
            // Keep counting past the cap: the walk is already bounded, so the extra work is a regex test
            // per file and it buys an honest total instead of "at least this many".
            total += 1;
            if (lines.length < searchMaxMatches) lines.push(rel);
          }
        }
        // Cap each hit so one minified/very long match line can't flood the result set.
        const formatted = lines.map((l) => truncateLine(l, RESULT_LINE_MAX).text).join('\n');
        const truncated = total > lines.length;
        // Say so out loud, like Grep does. The cut used to live only in `details.truncated`, which the
        // model never sees — so a search that stopped at its limit was indistinguishable from one that
        // found everything, and "not found" was reported for files that were simply past the cap.
        const notices = [
          ...(truncated ? [`[Showing ${lines.length} of ${total} matches — narrow the query or the include pattern for the rest.]`] : []),
          ...(walkTruncated ? [`[The traversal stopped at ${WALK_CAP} files, so matches beyond it were never examined — search a narrower path.]`] : []),
        ];
        const text = [formatted || 'No matches found.', ...notices].join('\n\n');
        return ok('Search', text, { ...pathMeta(abs), mode, matches: lines.length, total, truncated, walkTruncated });
      } catch (e) { return fail('Search', safeError(e)); }
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
      'Use this tool when you need to find files by name patterns. For content search, use Grep or Search.',
    ].join(' '),
    parameters: Type.Object({
      pattern: Type.String({ description: 'The glob pattern to match files against (e.g. "**/*.ts", "src/**/*.{js,jsx}")' }),
      path: Type.Optional(Type.String({ description: 'The directory to search in. Defaults to the current working directory.' })),
    }),
    execute: async (_id, p) => {
      try {
        const searchRoot = p.path ? ctx.assertPathAllowed(p.path) : ctx.defaultCwd();
        const abs = statSync(searchRoot).isDirectory() ? searchRoot : dirname(searchRoot);
        if (!p.path && isFsRoot(abs)) return ok('Glob', 'Error: no path given and no project root is set — pass an explicit path.', { ok: false });
        const regex = globRegex(p.pattern);
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
        const text = [results.join('\n') || 'No files matched.', ...notices].join('\n\n');
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
      'ALWAYS use Grep for content search tasks. NEVER invoke grep or rg as a Bash command.',
      'Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+").',
      'Filter files with the glob parameter (e.g. "*.js", "**/*.tsx").',
      'Output modes: "content" shows matching lines (default), "files_with_matches" shows only file paths, "count" shows match counts per file.',
      'Use context lines (-A/-B/-C) to show surrounding lines in content mode.',
      'For multiline patterns (crossing line boundaries), set multiline: true.',
    ].join(' '),
    parameters: Type.Object({
      pattern: Type.String({ description: 'The regular expression pattern to search for in file contents' }),
      path: Type.Optional(Type.String({ description: 'File or directory to search in. Defaults to the current working directory.' })),
      glob: Type.Optional(Type.String({ description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")' })),
      output_mode: Type.Optional(Type.Union([
        Type.Literal('content'), Type.Literal('files_with_matches'), Type.Literal('count'),
      ], { description: 'Output mode: "content" shows matching lines (default), "files_with_matches" shows file paths, "count" shows match counts.' })),
      '-A': Type.Optional(Type.Number({ description: 'Lines to show after each match (content mode only).' })),
      '-B': Type.Optional(Type.Number({ description: 'Lines to show before each match (content mode only).' })),
      '-C': Type.Optional(Type.Number({ description: 'Lines to show before and after each match (content mode only).' })),
      multiline: Type.Optional(Type.Boolean({ description: 'Enable multiline matching for patterns crossing line boundaries.' })),
      head_limit: Type.Optional(Type.Number({ description: 'Max number of result lines to return (0 = unlimited).' })),
    }),
    execute: async (_id, p) => {
      try {
        // rg accepts a single FILE as its search path — pass it through so `path` pointing at a file
        // searches that file, not its whole parent directory. `root` (its dirname) only relativizes output.
        const target = p.path ? ctx.assertPathAllowed(p.path) : ctx.defaultCwd();
        const isDir = statSync(target).isDirectory();
        const root = isDir ? target : dirname(target);
        if (!p.path && isFsRoot(root)) return ok('Grep', 'Error: no path given and no project root is set — pass an explicit path.', { ok: false });
        if (!String(p.pattern ?? '').trim()) return ok('Grep', 'Error: pattern is required.', { ok: false });
        const outputMode = p.output_mode ?? 'content';
        const grepMax = Math.min(Math.max(Number(ctx.config.searchMaxMatches) || DEFAULT_GREP_MAX_MATCHES, 50), 1000);
        let lines;
        let truncated = false;
        try {
          const r = await rgGrep(target, root, p.pattern, {
            include: p.glob,
            outputMode,
            beforeContext: p['-B'],
            afterContext: p['-A'],
            contextLines: p['-C'],
            multiline: p.multiline === true,
            headLimit: p.head_limit,
            maxMatches: grepMax,
          });
          lines = r.lines;
          truncated = r.truncated;
        } catch (error) {
          if (!commandMissing(error)) throw error;
          return ok('Grep', RIPGREP_REQUIRED, { ok: false, path: root, pattern: p.pattern, outputMode });
        }
        const formatted = lines.map((l) => truncateLine(l, RESULT_LINE_MAX).text).join('\n');
        let text = formatted || 'No matches found.';
        // Surface the head_limit/max-matches cut so the model knows there may be more (the old code sliced
        // silently). Wording mirrors the Claude reference's pagination note.
        if (truncated && lines.length) text += `\n\n[Showing results with pagination — output truncated at ${lines.length} results; narrow the pattern or raise head_limit for more.]`;
        return ok('Grep', text, {
          ...pathMeta(root), pattern: p.pattern, outputMode, matches: lines.length, truncated,
        });
      } catch (e) { return fail('Grep', safeError(e)); }
    },
  }), { workspaceSafe: true });

  ctx.logger.info('registered Read, Write, Edit, ListDir, Search, FileInfo, GitStatus, Glob, Grep');
}
