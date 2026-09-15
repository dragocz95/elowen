/**
 * Shapes a finished or yielded cell into the tool result the model reads.
 *
 * Ported 1:1 from Codex `core/src/tools/code_mode/mod.rs::handle_runtime_response` plus the
 * truncation helpers in `utils/string/src/truncate.rs` and `utils/output-truncation/src/lib.rs`.
 * Two details are load-bearing and easy to get wrong when reimplementing:
 *  - truncation keeps the HEAD AND THE TAIL, because the last `text()` of a script is usually the
 *    answer and a head-only cut throws it away;
 *  - the status header is prepended AFTER truncation, so it is never itself truncated and never
 *    charged against the budget.
 * Budgets are byte-based with a four-bytes-per-token estimate, matching Codex exactly, so a UTF-16
 * length would be wrong here: everything measures UTF-8 bytes.
 */

const APPROX_BYTES_PER_TOKEN = 4;

/** Codex's `resolve_max_tokens` default for a cell result. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

export type CodeModeOutputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string; detail?: string };

export type ScriptStatus =
  | { kind: 'yielded'; cellId: string }
  | { kind: 'terminated' }
  | { kind: 'completed' }
  | { kind: 'failed' };

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function approxTokenCount(text: string): number {
  return Math.floor((byteLength(text) + (APPROX_BYTES_PER_TOKEN - 1)) / APPROX_BYTES_PER_TOKEN);
}

export function approxBytesForTokens(tokens: number): number {
  return tokens * APPROX_BYTES_PER_TOKEN;
}

function approxTokensFromByteCount(bytes: number): number {
  return Math.floor((bytes + (APPROX_BYTES_PER_TOKEN - 1)) / APPROX_BYTES_PER_TOKEN);
}

/**
 * Splits `text` at two UTF-8 byte offsets that fall on code-point boundaries, returning the kept
 * head, the kept tail and how many code points were dropped between them.
 */
function splitString(
  text: string,
  beginningBytes: number,
  endBytes: number,
): { removedChars: number; before: string; after: string } {
  const buffer = Buffer.from(text, 'utf8');
  const length = buffer.length;
  const tailStartTarget = Math.max(0, length - endBytes);

  let prefixEnd = 0;
  let suffixStart = length;
  let removedChars = 0;
  let suffixStarted = false;

  let index = 0;
  for (const ch of text) {
    const charBytes = Buffer.byteLength(ch, 'utf8');
    const charEnd = index + charBytes;
    if (charEnd <= beginningBytes) {
      prefixEnd = charEnd;
      index = charEnd;
      continue;
    }
    if (index >= tailStartTarget) {
      if (!suffixStarted) {
        suffixStart = index;
        suffixStarted = true;
      }
      index = charEnd;
      continue;
    }
    removedChars += 1;
    index = charEnd;
  }

  if (suffixStart < prefixEnd) suffixStart = prefixEnd;

  return {
    removedChars,
    before: buffer.subarray(0, prefixEnd).toString('utf8'),
    after: buffer.subarray(suffixStart).toString('utf8'),
  };
}

function formatTruncationMarker(removedTokens: number): string {
  return `…${removedTokens} tokens truncated…`;
}

/** Keeps the head and the tail within a token budget; returns the text unchanged when it fits. */
export function truncateMiddleWithTokenBudget(text: string, maxTokens: number): string {
  if (text.length === 0) return '';
  const maxBytes = approxBytesForTokens(maxTokens);
  if (maxTokens > 0 && byteLength(text) <= maxBytes) return text;

  const totalBytes = byteLength(text);
  if (maxBytes === 0) {
    return formatTruncationMarker(approxTokensFromByteCount(totalBytes));
  }
  if (totalBytes <= maxBytes) return text;

  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  const { before, after } = splitString(text, leftBudget, rightBudget);
  const marker = formatTruncationMarker(approxTokensFromByteCount(totalBytes - maxBytes));
  return `${before}${marker}${after}`;
}

/** Adds the two-line warning header Codex puts in front of truncated output. */
export function formattedTruncateText(content: string, maxTokens: number): string {
  if (byteLength(content) <= approxBytesForTokens(maxTokens)) return content;

  const originalTokenCount = approxTokenCount(content);
  const totalLines = countLines(content);
  const result = truncateMiddleWithTokenBudget(content, maxTokens);
  return `Warning: truncated output (original token count: ${originalTokenCount})\nTotal output lines: ${totalLines}\n\n${result}`;
}

/** Matches Rust's `str::lines`: a trailing newline does not open a further line. */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  const withoutTrailing = content.endsWith('\n') ? content.slice(0, -1) : content;
  return withoutTrailing.split('\n').length;
}

/**
 * Text-only results are joined with newlines, truncated as one document and returned as a single
 * item, which is what makes head-and-tail truncation meaningful across several `text()` calls.
 */
function truncateTextOnlyItems(items: CodeModeOutputItem[], maxTokens: number): CodeModeOutputItem[] {
  const segments = items.filter((item): item is { type: 'text'; text: string } => item.type === 'text');
  if (segments.length === 0) return items;

  const combined = segments.map((item) => item.text).join('\n');
  if (byteLength(combined) <= approxBytesForTokens(maxTokens)) return items;

  return [{ type: 'text', text: formattedTruncateText(combined, maxTokens) }];
}

/**
 * Mixed results walk the items in order against a running budget. Images pass through free: they
 * are billed by the provider as image tokens, which this text budget does not model.
 */
function truncateMixedItems(items: CodeModeOutputItem[], maxTokens: number): CodeModeOutputItem[] {
  const out: CodeModeOutputItem[] = [];
  let remainingBudget = maxTokens;
  let omittedTextItems = 0;

  for (const item of items) {
    if (item.type === 'image') {
      out.push(item);
      continue;
    }

    // Empty text contributes no model content but still consumes an API array slot.
    if (item.text.length === 0) continue;
    if (remainingBudget === 0) {
      omittedTextItems += 1;
      continue;
    }

    const cost = approxTokenCount(item.text);
    if (cost <= remainingBudget) {
      out.push(item);
      remainingBudget -= cost;
      continue;
    }

    const snippet = truncateMiddleWithTokenBudget(item.text, remainingBudget);
    if (snippet.length === 0) omittedTextItems += 1;
    else out.push({ type: 'text', text: snippet });
    remainingBudget = 0;
  }

  if (omittedTextItems > 0) {
    out.push({ type: 'text', text: `[omitted ${omittedTextItems} text items ...]` });
  }

  return out;
}

export function truncateCodeModeResult(
  items: CodeModeOutputItem[],
  maxOutputTokens: number | undefined,
): CodeModeOutputItem[] {
  const maxTokens = maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return items.every((item) => item.type === 'text')
    ? truncateTextOnlyItems(items, maxTokens)
    : truncateMixedItems(items, maxTokens);
}

export function formatScriptStatus(status: ScriptStatus): string {
  switch (status.kind) {
    case 'yielded':
      return `Script running with cell ID ${status.cellId}`;
    case 'terminated':
      return 'Script terminated';
    case 'completed':
      return 'Script completed';
    case 'failed':
      return 'Script failed';
  }
}

/**
 * Builds the final item list for a cell observation: optional error item, truncation, then the
 * status header in front. `wallTimeMs` is rendered to one decimal exactly as Codex does.
 */
export function buildCodeModeResultItems(options: {
  status: ScriptStatus;
  items: CodeModeOutputItem[];
  errorText?: string;
  maxOutputTokens?: number;
  wallTimeMs: number;
}): CodeModeOutputItem[] {
  const items = [...options.items];
  if (options.errorText !== undefined) {
    items.push({ type: 'text', text: `Script error:\n${options.errorText}` });
  }

  const truncated = truncateCodeModeResult(items, options.maxOutputTokens);
  const wallTimeSeconds = Math.round((options.wallTimeMs / 1000) * 10) / 10;
  const header = `${formatScriptStatus(options.status)}\nWall time ${wallTimeSeconds.toFixed(1)} seconds\nOutput:\n`;
  return [{ type: 'text', text: header }, ...truncated];
}
