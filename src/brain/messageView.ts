import type { BrainMessageRow } from '../store/brainStore.js';

/** One display piece of an assistant turn, in the order it happened: a text block, or a tool call
 *  (with a short argument summary and, for edits, the display diff). */
type BrainSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string; diff?: string };

/** A stored turn shaped for display (the `GET /brain/messages` payload consumed by channels).
 *  `text` is the flat reply (title derivation, plain clients); `segments` preserve the true order. */
export interface BrainMessageView { role: string; text: string; segments?: BrainSegment[] }

/** A short, human-scannable summary of a tool call's most salient argument (the file path, command,
 *  query…), opencode-style: `read src/foo.ts`, `bash "npm test"`. */
export function toolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const raw = a.path ?? a.file_path ?? a.filename ?? a.command ?? a.pattern ?? a.query ?? a.url ?? a.name ?? a.text;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const s = raw.replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

/** Wrap untrusted content (retrieved memories, plugin-hook context) in a named frame, neutralizing any
 *  literal closing delimiter inside the body so the content can't break out of the frame and have the
 *  text after it read as un-framed prompt input. Single source for every untrusted live-prompt block. */
export function frameUntrusted(tag: string, preface: string, body: string): string {
  const safe = body.replace(new RegExp(`<\\s*/\\s*${tag}\\s*>`, 'gi'), `[/${tag}]`);
  return `<${tag}>\n${preface}\n${safe}\n</${tag}>\n\n`;
}

/** Pull display text out of a stored message's content JSON. Content is either a plain string or an
 *  array of parts ({type:'text', text}); anything else yields an empty string. */
export function extractText(msg: unknown): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('');
  }
  return '';
}

/** Shape stored brain rows for display — shared by the advisor chat history and the orca worker's
 *  task-conversation endpoint. Only user + assistant turns surface; toolResult/summary rows are
 *  persisted for rehydration but never shown (edit diffs are lifted off toolResult rows onto their
 *  matching assistant toolCall segment). */
export function shapeBrainMessages(rows: BrainMessageRow[]): BrainMessageView[] {
  // Edit diffs live on the toolResult rows (never shown raw) — index them so the matching
  // assistant toolCall segment can carry its diff.
  const diffs = new Map<string, string>();
  for (const row of rows) {
    if (row.role !== 'toolResult') continue;
    try {
      const m = JSON.parse(row.content) as { toolCallId?: string; details?: { diff?: unknown } };
      if (!m.toolCallId) continue;
      if (typeof m.details?.diff === 'string' && m.details.diff.trim()) diffs.set(m.toolCallId, m.details.diff);
    } catch { /* malformed row → no diff */ }
  }
  const views: BrainMessageView[] = [];
  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    let msg: { content?: unknown } = {};
    try { msg = JSON.parse(row.content) as { content?: unknown }; } catch { /* malformed row → skipped below */ }
    if (row.role === 'user') {
      const text = extractText(msg);
      if (text.trim()) views.push({ role: 'user', text });
      continue;
    }
    // Assistant: the content array preserves the true order of text and tool calls.
    const segments: BrainSegment[] = [];
    let text = '';
    for (const part of Array.isArray(msg.content) ? msg.content : []) {
      const p = part as { type?: string; text?: unknown; id?: string; name?: string; arguments?: unknown };
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        text += p.text;
        segments.push({ kind: 'text', text: p.text });
      } else if (p.type === 'toolCall' && typeof p.name === 'string') {
        segments.push({ kind: 'tool', name: p.name, detail: toolDetail(p.arguments), diff: p.id ? diffs.get(p.id) : undefined });
      }
    }
    if (typeof msg.content === 'string' && msg.content.trim()) { text = msg.content; segments.push({ kind: 'text', text }); }
    if (segments.length > 0) views.push({ role: 'assistant', text, segments });
  }
  return views;
}
