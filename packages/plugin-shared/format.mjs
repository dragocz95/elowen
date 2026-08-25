// Pure text/format helpers shared by every platform adapter (Discord / Telegram / WhatsApp), their
// streaming renderers and the tests. Genuinely per-surface pieces — the chunk size, the footer style, the
// reply-quote shape, Discord's mention resolution — stay in each plugin's own format.mjs; only the
// transport-neutral logic lives here. Every entry guards a null/undefined body (an empty daemon reply must
// never crash a send).

/** Flatten a markdown reply into plain prose for text-to-speech: drop code blocks, links, images and
 *  markdown punctuation so the voice reads the words, not the syntax. */
export function stripForSpeech(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code — unspeakable
    .replace(/`([^`]+)`/g, '$1')              // inline code → its text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links → label
    .replace(/^#{1,6}\s+/gm, '')              // heading markers
    .replace(/https?:\/\/\S+/g, ' ')          // bare URLs
    .replace(/[*_>#~|`]+/g, ' ')              // leftover md punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// The two daemon image paths an adapter may turn into a real upload, with the file-name rule of each.
// A matched name is joined onto a directory and read off disk, so these patterns are a security boundary:
// they mirror the daemon's own validation exactly and admit nothing with a separator, a `..` or another
// extension. `/brain/images/` is the image-gen/image-edit output (route check `[a-z0-9]+\.png`);
// `/brain/chat-images/` is a stored chat image (STORED_NAME in src/brain/chatImages.ts) — a random uuid
// for a user attachment, a content hash for a tool's picture, in any of the four types we serve.
const GENERATED_NAME = '[a-z0-9]+\\.png';
const STORED_NAME = '(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})\\.(?:png|jpg|gif|webp)';
const REF_TAIL = `\\/brain\\/(?:images\\/(${GENERATED_NAME})|chat-images\\/(${STORED_NAME}))`;
const MARKDOWN_IMAGE = new RegExp(`!\\[[^\\]]*\\]\\([^)\\s]*${REF_TAIL}\\)`, 'g');
const IMAGE_REF = new RegExp(`^[^\\s]*${REF_TAIL}$`);

/** Find image markdown links — `![…](…/brain/images/<name>.png)` or `![…](…/brain/chat-images/<name>)`,
 *  relative or absolute — and return the text with them removed plus the extracted file names. */
export function extractImageRefs(text) {
  const files = [];
  const cleaned = String(text ?? '').replace(MARKDOWN_IMAGE, (_, generated) => {
    // Only the generated-image directory is honoured from PROSE. `chat-images` is one shared directory
    // holding every user's private attachments, and this text is written by the model — treating a name
    // it typed as permission to read and upload that file would be an authorization check we never made.
    // Those arrive as an `image` event instead, which the daemon emits only after checking ownership.
    if (generated) files.push(generated);
    return '';
  });
  return { cleaned, files };
}

/** The stored file name an `image` stream event's `ref` points at (`/api/brain/chat-images/<name>` or the
 *  older `/api/brain/images/<name>.png`), or null when the ref is anything else. An event reaches the
 *  filesystem the same way a markdown link does, so it is held to the same name rule rather than trusted
 *  for coming from the daemon. */
export function imageRefName(ref) {
  const m = IMAGE_REF.exec(String(ref ?? ''));
  return m ? (m[1] ?? m[2]) : null;
}

/** Strip inline chain-of-thought (`<think>…</think>` / `<thinking>…</thinking>`) that some vision-fallback
 *  models emit into the text stream instead of a separate reasoning channel. Mirrors the daemon's
 *  `stripInlineReasoning` so an adapter's text-fallback path never leaks reasoning into the visible answer.
 *  The unclosed-trailing and leading-close rules are anchored to a line boundary for the reason spelled out
 *  in the daemon copy: unanchored, they silently truncate any prose that merely mentions a reasoning tag.
 *  tests/contract/inlineReasoningParity.test.ts holds this copy and the daemon's to the same corpus. */
export function stripThinking(text) {
  const s = String(text ?? '');
  if (!/<\/?think(?:ing)?\b/i.test(s)) return s;
  let out = s
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/^[ \t]*<think(?:ing)?\b[^>]*>[\s\S]*$/im, '');
  const lead = /^[\s\S]*?<\/think(?:ing)?>[ \t]*(?:\n|$)/i.exec(out);
  if (lead) out = out.slice(lead[0].length);
  return out.trim();
}

/**
 * The runtime footer a turn settles with (`model · context %`), wrapped in the surface's own subtext
 * markup. `fence` is that markup: Discord `{ open: '-# ' }`, Telegram `{ open: '— ' }`, WhatsApp
 * `{ open: '_', close: '_' }`, Teams `{ open: '' }` (bot messages there have no small-text style at all).
 * The provider is dropped here (`openai-codex/gpt-5.6-luna` renders as `gpt-5.6-luna`). A chat surface is
 * not where anyone picks a model or reconciles spend — the qualified identity belongs in the CLI status
 * line and the web pickers, where two providers offering the same model name have to be told apart. In a
 * message footer it is noise under every single answer. Splitting is delegated to `parseModelExec` rather
 * than done inline, because a model name may itself contain a slash (`ai-coresynth-io/deepseek/…`), so
 * only the FIRST separator divides provider from model.
 *
 * The percentage is rounded; missing data simply omits its fragment, and an idle event carrying neither
 * yields '' so no empty subtext line is posted. The percentage is checked for finiteness, not merely for
 * being a number: it reaches us from the agent runtime's context accounting, where a zero-sized window
 * would divide out to Infinity and print as `Infinity %`.
 */
export function runtimeFooter(idle, fence) {
  const parts = [];
  const raw = typeof idle?.model === 'string' ? idle.model.trim() : '';
  const model = raw ? (parseModelExec(raw)?.model ?? raw) : '';
  if (model) parts.push(model);
  const pct = idle?.usage?.percent;
  if (Number.isFinite(pct) && pct >= 0) parts.push(`${Math.round(pct)} %`);
  return parts.length ? `${fence.open}${parts.join(' · ')}${fence.close ?? ''}` : '';
}

/**
 * Drop a trailing {@link runtimeFooter} from a message body — for feeding channel history back into a
 * prompt, where the footer is our own runtime metadata rather than anything a person said.
 *
 * Without this the model reads "messages in this thread end with `-# <model> · <n> %`" as part of the
 * house style and starts writing that line ITSELF, inventing a model name it never ran on. The forged
 * footer then lands in the next history window and reinforces the pattern.
 *
 * Matched structurally, not by pattern: the last non-blank line must open (and, where the surface closes
 * its markup, close) with the SAME fence we emit, and hold something between the two. So a bare `_` is
 * not mistaken for an empty WhatsApp footer. Caller-restricted to messages we authored — a person's own
 * subtext line is theirs to keep.
 */
export function stripRuntimeFooter(text, fence) {
  const body = String(text ?? '');
  // An unfenced surface (Teams) has nothing to recognise a footer BY: every line "starts with" the empty
  // string, so a reader there would eat the last line of every message it was handed. Refuse rather than
  // guess — a surface that wants its footer back off has to mark it on the way out first.
  if (!fence.open && !(fence.close ?? '')) return body;
  const lines = body.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  if (last < 0) return body;
  const line = lines[last].trim();
  const close = fence.close ?? '';
  if (line.length <= fence.open.length + close.length) return body;
  if (!line.startsWith(fence.open)) return body;
  if (close && !line.endsWith(close)) return body;
  return lines.slice(0, last).join('\n').trimEnd();
}

/** Parse a picker exec (`elowen:<provider>/<model>`, `<provider>/<model>`, or bare model) into the brain's
 *  model selection shape. */
export function parseModelExec(spec) {
  const s = typeof spec === 'string' ? spec.trim().replace(/^elowen:/, '') : '';
  if (!s) return null;
  const slash = s.indexOf('/');
  return slash > 0 ? { provider: s.slice(0, slash), model: s.slice(slash + 1) } : { model: s };
}

/** @typedef {string | number | boolean | null | undefined} ColumnValue */
/** @typedef {'left' | 'center' | 'right'} ColumnAlignment */
/** @typedef {{ maxWidth?: number, gap?: number, alignments?: ReadonlyArray<ColumnAlignment> }} ColumnFormatOptions */
/** @typedef {{ maxWidth?: number, fence?: boolean }} ChatTableOptions */

const DEFAULT_COLUMN_WIDTH = 72;
const DEFAULT_COLUMN_GAP = 2;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// East Asian Wide/Fullwidth code points, which a monospace grid renders two cells wide. JS exposes no
// `East_Asian_Width` property escape, so the W/F classes are spelled out; emoji are covered separately by
// `Emoji_Presentation`, which V8 DOES expose and which tracks the standard far better than a hand table.
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd],
];

const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}/u;

/** Cells that must never reach a chat surface: C0/C1 controls, and the format characters (bidi overrides,
 *  zero-width spaces) that silently reorder or pad a rendered line. ZWJ is kept — it is load-bearing inside
 *  an emoji sequence, which the grapheme segmenter then measures as one cluster. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

function isWide(codePoint) {
  for (const [low, high] of WIDE_RANGES) if (codePoint >= low && codePoint <= high) return true;
  return false;
}

/** Rendered width of ONE grapheme cluster, in monospace cells. Combining marks, variation selectors and
 *  ZWJ joiners live inside the cluster and therefore cost nothing extra — which is the whole reason this
 *  measures clusters instead of code points: `ř` typed as `r`+U+030C is one cell, not two, and a ZWJ
 *  family emoji is two cells, not five. */
function graphemeWidth(cluster) {
  if (cluster.includes('\uFE0F')) return 2;            // VS16 forces emoji presentation
  if (EMOJI_PRESENTATION.test(cluster)) return 2;
  return isWide(cluster.codePointAt(0)) ? 2 : 1;
}

/** Normalize a value to one printable line: NFC (so a macOS-decomposed `Příliš` measures like a composed
 *  one), whitespace collapsed, invisibles dropped. Runs of three or more backticks are collapsed to one,
 *  because {@link formatColumnsCodeBlock} puts this text inside a ``` fence and `splitContent` counts those
 *  fences to decide where it may cut — a stray terminator in a cell breaks the rest of the message. */
function normalizeCell(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(INVISIBLE, (c) => (c === '\u200D' ? c : ' '))
    .replace(/`{3,}/gu, '`')
    .replace(/\s+/gu, ' ')
    .trim();
}

const EMPTY_CELL = { text: '', clusters: [], width: 0 };

/** Split a normalized cell into measured grapheme clusters plus its total rendered width. */
function measureCell(text) {
  const clusters = [];
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    const cellWidth = graphemeWidth(segment);
    clusters.push({ segment, width: cellWidth });
    width += cellWidth;
  }
  return { text, clusters, width };
}

/** Fit a measured cell into `width` cells on ONE line — truncated with `…`, never wrapped, and never cut
 *  inside a grapheme cluster (which would orphan a diacritic or halve a ZWJ emoji). */
function fitCell(cell, width) {
  if (cell.width <= width) return cell;
  let text = '';
  let used = 0;
  for (const { segment, width: cellWidth } of cell.clusters) {
    if (used + cellWidth > width - 1) break;
    text += segment;
    used += cellWidth;
  }
  return { text: `${text}…`, clusters: null, width: used + 1 };
}

function fitColumnWidths(desired, available) {
  const total = desired.reduce((sum, width) => sum + width, 0);
  if (total <= available) return desired;

  let low = 1;
  let high = Math.max(...desired);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const used = desired.reduce((sum, width) => sum + Math.min(width, mid), 0);
    if (used <= available) low = mid;
    else high = mid - 1;
  }

  const widths = desired.map((width) => Math.min(width, low));
  let spare = available - widths.reduce((sum, width) => sum + width, 0);
  for (let i = 0; i < widths.length && spare > 0; i++) {
    if (widths[i] < desired[i]) {
      widths[i]++;
      spare--;
    }
  }
  return widths;
}

function columnLayout(rows, options) {
  const maxWidth = options.maxWidth ?? DEFAULT_COLUMN_WIDTH;
  const gap = options.gap ?? DEFAULT_COLUMN_GAP;
  const alignments = options.alignments ?? [];
  if (!Number.isInteger(maxWidth) || maxWidth < 1) throw new RangeError('maxWidth must be a positive integer');
  if (!Number.isInteger(gap) || gap < 0) throw new RangeError('gap must be a non-negative integer');
  if (!Array.isArray(alignments)) throw new TypeError('alignments must be an array');
  for (const alignment of alignments) {
    if (alignment != null && !['left', 'center', 'right'].includes(alignment)) {
      throw new TypeError(`unsupported column alignment: ${alignment}`);
    }
  }

  // A non-array row used to render as a blank line, which reads as "this entry has no data" rather than as
  // the caller bug it is. Reject it instead of shipping a plausible-looking hole in the table.
  const measured = rows.map((row, index) => {
    if (!Array.isArray(row)) throw new TypeError(`formatColumns: row ${index} is not an array`);
    return row.map((value) => measureCell(normalizeCell(value)));
  });
  const columnCount = measured.reduce((max, row) => Math.max(max, row.length), 0);
  const activeColumns = Array.from({ length: columnCount }, (_, index) => index)
    .filter((index) => measured.some((row) => (row[index]?.text ?? '') !== ''));
  if (activeColumns.length === 0) return { measured, activeColumns, widths: [], alignments: [], gap };

  const gapWidth = gap * (activeColumns.length - 1);
  const available = maxWidth - gapWidth;
  if (available < activeColumns.length) {
    throw new RangeError(`maxWidth ${maxWidth} cannot fit ${activeColumns.length} columns with gap ${gap}`);
  }

  const desired = activeColumns.map((index) => measured.reduce(
    (max, row) => Math.max(max, row[index]?.width ?? 0),
    1,
  ));
  return {
    measured,
    activeColumns,
    widths: fitColumnWidths(desired, available),
    alignments: activeColumns.map((column) => alignments[column] ?? 'left'),
    gap,
  };
}

function renderColumnLayout({ measured, activeColumns, widths, alignments, gap }) {
  if (activeColumns.length === 0) return '';
  const separator = ' '.repeat(gap);
  return measured.map((row) => activeColumns.map((column, index) => {
    const cell = fitCell(row[column] ?? EMPTY_CELL, widths[index]);
    const padding = widths[index] - cell.width;
    const left = alignments[index] === 'right' ? padding : alignments[index] === 'center' ? Math.floor(padding / 2) : 0;
    const right = padding - left;
    return `${' '.repeat(left)}${cell.text}${index === activeColumns.length - 1 ? '' : ' '.repeat(right)}`;
  }).join(separator).trimEnd()).join('\n');
}

/**
 * Format rows as aligned monospace columns. Cells are single-line strings measured in RENDERED CELLS —
 * grapheme clusters, with East Asian and emoji glyphs counted as two — because the output is read on a
 * monospace grid, not by a code-point counter. Columns that are empty in every row are omitted, and wider
 * cells are truncated with `…`, never wrapped: one wrapped cell would destroy the alignment of every other
 * row. No rendered line exceeds `maxWidth`.
 *
 * @param {ReadonlyArray<ReadonlyArray<ColumnValue>>} rows
 * @param {ColumnFormatOptions} [options]
 * @returns {string}
 */
export function formatColumns(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  return renderColumnLayout(columnLayout(rows, options));
}

/**
 * Format rows and wrap the result in the fenced monospace block used by text chat surfaces.
 * Empty rows stay empty rather than producing a blank code block.
 *
 * @param {ReadonlyArray<ReadonlyArray<ColumnValue>>} rows
 * @param {ColumnFormatOptions} [options]
 * @returns {string}
 */
export function formatColumnsCodeBlock(rows, options = {}) {
  const table = formatColumns(rows, options);
  return table ? `\`\`\`\n${table}\n\`\`\`` : '';
}

function sourceLines(text) {
  const lines = [];
  const newline = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = newline.exec(text); match; match = newline.exec(text)) {
    lines.push({ start, contentEnd: match.index, text: text.slice(start, match.index) });
    start = newline.lastIndex;
  }
  if (start < text.length) lines.push({ start, contentEnd: text.length, text: text.slice(start) });
  return lines;
}

function fencedLines(lines) {
  const fenced = Array(lines.length).fill(false);
  let marker = '';
  let length = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].text;
    if (!marker) {
      const opening = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
      if (!opening) continue;
      marker = opening[1][0];
      length = opening[1].length;
      fenced[index] = true;
      continue;
    }
    fenced[index] = true;
    const closing = new RegExp(`^[ \\t]{0,3}${marker}{${length},}[ \\t]*$`);
    if (closing.test(line)) marker = '';
  }
  return fenced;
}

function stripInlineMarkdown(value) {
  return String(value ?? '')
    .replace(/!\[([^\]]*)\]\([^\s)]{0,500}\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\s)]{0,500}\)/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1')
    .replace(/(`+)([^`]*?)\1/g, '$2')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(?<!\w)([*_])([^*_]+)\1(?!\w)/g, '$2')
    .replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, '$1');
}

function markdownRow(line, stripMarkdown = true) {
  const source = line.trim();
  const cells = [];
  let current = '';
  let sawPipe = false;
  for (const char of source) {
    if (char !== '|') {
      current += char;
      continue;
    }
    let slashes = 0;
    for (let index = current.length - 1; index >= 0 && current[index] === '\\'; index--) slashes++;
    if (slashes % 2 === 1) {
      current = `${current.slice(0, -1)}|`;
      continue;
    }
    sawPipe = true;
    cells.push(current);
    current = '';
  }
  cells.push(current);
  if (!sawPipe) return null;
  if (source.startsWith('|')) cells.shift();
  let trailingSlashes = 0;
  for (let index = source.length - 2; index >= 0 && source[index] === '\\'; index--) trailingSlashes++;
  if (source.endsWith('|') && trailingSlashes % 2 === 0) cells.pop();
  if (cells.length < 2) return null;
  return cells.map((cell) => stripMarkdown ? stripInlineMarkdown(cell.trim()) : cell.trim());
}

function delimiterAlignment(cell) {
  const marker = cell.trim();
  if (/^:-+:$/.test(marker)) return 'center';
  if (/^-{2,}:$/.test(marker)) return 'right';
  if (/^:-{2,}$/.test(marker) || /^-{3,}$/.test(marker)) return 'left';
  return null;
}

function parsedTable(lines, fenced, start) {
  if (fenced[start] || fenced[start + 1]) return null;
  const header = markdownRow(lines[start]?.text ?? '');
  const delimiter = markdownRow(lines[start + 1]?.text ?? '', false);
  if (!header || !delimiter || header.length !== delimiter.length) return null;
  const alignments = delimiter.map(delimiterAlignment);
  if (alignments.some((alignment) => alignment == null)) return null;

  const body = [];
  let end = start + 2;
  while (end < lines.length && !fenced[end]) {
    const row = markdownRow(lines[end].text);
    if (!row || row.length !== header.length) break;
    body.push(row);
    end++;
  }
  if (body.length === 0) return null;
  return { header, body, alignments, end: end - 1 };
}

function shouldStackTable(rows, alignments, maxWidth) {
  let layout;
  try {
    layout = columnLayout(rows, { maxWidth, alignments });
  } catch (error) {
    if (error instanceof RangeError && /cannot fit/.test(error.message)) return true;
    throw error;
  }

  // A column layout stops carrying useful information once a heading itself is clipped, or a data cell
  // would retain less than half of its measured display cells after reserving one cell for the ellipsis.
  // This uses the renderer's grapheme-aware widths rather than a guessed character count for phone screens.
  return layout.activeColumns.some((column, index) => {
    const width = layout.widths[index];
    if ((layout.measured[0]?.[column]?.width ?? 0) > width) return true;
    return layout.measured.slice(1).some((row) => {
      const cellWidth = row[column]?.width ?? 0;
      return cellWidth > width && Math.max(0, width - 1) * 2 < cellWidth;
    });
  });
}

function stackedTable(headers, body, maxWidth) {
  return body.map((row) => headers.map((header, index) => {
    const key = normalizeCell(header) || `Column ${index + 1}`;
    const value = normalizeCell(row[index]);
    return fitCell(measureCell(`${key}: ${value}`), maxWidth).text;
  }).join('\n')).join('\n\n');
}

/**
 * Replace GitHub-style markdown tables in arbitrary model text with chat-safe aligned columns. Fenced code
 * blocks are scanned first and left byte-for-byte intact; malformed candidates are ignored. Any unexpected
 * parse/format failure returns the complete original text because raw pipes are preferable to a failed send.
 *
 * @param {unknown} text
 * @param {ChatTableOptions} [options]
 * @returns {string}
 */
export function renderChatTables(text, options = {}) {
  const original = String(text ?? '');
  try {
    const maxWidth = options.maxWidth ?? DEFAULT_COLUMN_WIDTH;
    const fence = options.fence ?? true;
    if (!Number.isInteger(maxWidth) || maxWidth < 1) throw new RangeError('maxWidth must be a positive integer');
    if (typeof fence !== 'boolean') throw new TypeError('fence must be a boolean');

    const lines = sourceLines(original);
    const fenced = fencedLines(lines);
    let cursor = 0;
    let output = '';
    for (let index = 0; index < lines.length; index++) {
      const table = parsedTable(lines, fenced, index);
      if (!table) continue;
      const rows = [table.header, ...table.body];
      const rendered = shouldStackTable(rows, table.alignments, maxWidth)
        ? stackedTable(table.header, table.body, maxWidth)
        : formatColumns(rows, { maxWidth, alignments: table.alignments });
      const replacement = fence ? `\`\`\`\n${rendered}\n\`\`\`` : rendered;
      output += original.slice(cursor, lines[index].start) + replacement;
      cursor = lines[table.end].contentEnd;
      index = table.end;
    }
    return cursor ? output + original.slice(cursor) : original;
  } catch {
    return original;
  }
}

/** Split text into ≤`chunk` pieces WITHOUT breaking a fenced code block: if a cut lands inside ``` … ```,
 *  close the fence on this piece and reopen it (same language) on the next. Prefers newline cuts. `chunk`
 *  is per-surface (Discord 1990, Telegram/WhatsApp 4000), so each adapter passes its own. */
export function splitContent(text, chunk) {
  const pieces = [];
  let rest = String(text ?? '');
  let reopen = '';
  while (rest.length > chunk) {
    let cut = rest.lastIndexOf('\n', chunk);
    if (cut < chunk * 0.5) cut = chunk; // no good newline → hard cut
    let piece = reopen + rest.slice(0, cut);
    rest = rest.slice(cut);
    // Count fences in this piece; an odd count means we're mid-block → close + remember to reopen.
    const fences = piece.match(/```/g)?.length ?? 0;
    if (fences % 2 === 1) {
      const lang = /```([^\n`]*)\n[^]*$/.exec(piece)?.[1] ?? '';
      piece += '\n```';
      reopen = '```' + lang + '\n';
    } else {
      reopen = '';
    }
    pieces.push(piece);
  }
  pieces.push(reopen + rest);
  return pieces;
}
