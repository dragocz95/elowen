/** The minimal stored-row shape `shapeBrainMessages` folds — just the fields it reads (the role and the
 *  raw content JSON). Kept as a local structural contract rather than importing `BrainMessageRow` from
 *  the store: the store imports `extractText` from here, so a type import back into the store would form
 *  a module cycle. `BrainMessageRow` satisfies this structurally, so callers pass their rows unchanged. */
type StoredTurnRow = { role: string; content: string };

export interface ToolOutputView {
  title: string;
  kind: 'console' | 'result';
  text: string;
  fullText?: string;
  command?: string;
  status?: string;
  tone?: 'normal' | 'success' | 'warning' | 'danger';
  /** Hook-appended annotations lifted off `result.details.notes` (the `tools.call.after` contract —
   *  e.g. "formatted a.ts with prettier"). Rendered as faint suffix lines under the output body. */
  notes?: string[];
}

/** One display piece of an assistant turn, in the order it happened: a text block, or a tool call
 *  (with a short argument summary and, for edits, the display diff). */
type BrainSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string; diff?: string; output?: ToolOutputView; command?: string };

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

function textParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
    .filter(Boolean)
    .join('\n');
}

function outputTone(text: string, exitCode?: unknown): ToolOutputView['tone'] {
  // Authoritative signals first: the tool's own error flag, then a numeric exit code. A clean exit 0
  // is SUCCESS no matter what words the output contains — grep hits for "error", npm's deprecation
  // spam and docs mentioning "failed" kept flagging perfectly fine runs as "needs attention", which
  // just trained users to ignore the status.
  if (exitCode === true) return 'warning';
  if (typeof exitCode === 'number') return exitCode !== 0 ? 'warning' : 'success';
  // No authoritative signal → conservative text heuristic: only unambiguous failure markers count
  // (a line STARTING with an error word, or an explicit "<something> failed" phrase).
  if (/(^|\n)\s*(error|fatal|exception|traceback)\b|\b(command|build|tests?|compilation|request) failed\b/i.test(text)) return 'warning';
  if (/\b(pass|passed|success|ok|done|green)\b/i.test(text)) return 'success';
  return 'normal';
}

function outputKind(toolName: string): ToolOutputView['kind'] {
  return /(shell|bash|command|terminal|exec|test|lint|knip|npm|pnpm|yarn)/i.test(toolName) ? 'console' : 'result';
}

function outputTitle(toolName: string, kind: ToolOutputView['kind']): string {
  if (kind === 'console') return 'console output';
  if (/(browser|playwright|chrome|page|web)/i.test(toolName)) return 'browser observation';
  if (/(grep|search|find|rg)/i.test(toolName)) return 'search result';
  return 'tool result';
}

/** The tool→output-visibility policy (see `toolOutput.ts`): true when a tool's SUCCESSFUL output is
 *  shown in the transcript (a declarative allowlist; output is hidden by default). Injected once at
 *  bootstrap via {@link setToolOutputPolicy} — the built-in show defaults merged with plugin manifests'
 *  `showOutput`, read live — and consulted per render on both the live (events.ts) and history
 *  (shapeBrainMessages) paths. This is the single seam that replaced the old implicit name-regex
 *  allowlist. Default shows all, so uninjected callers (unit tests) keep every tool's output. */
let toolOutputShown: (name: string) => boolean = () => true;
export function setToolOutputPolicy(resolve: (name: string) => boolean): void { toolOutputShown = resolve; }

/** Neutralize terminal control bytes from untrusted tool output before it reaches a renderer. ESC-led
 *  sequences (CSI colors, but also OSC-52 clipboard writes, title changes, DCS/PM/APC) and C0 controls
 *  other than \n/\t are stripped: the CLI measures width with ANSI stripped but WRITES lines verbatim, so
 *  a `cat`/`grep` over a file that embeds sequences would pass the width check and then EXECUTE them in
 *  the user's terminal. Colors are dropped too — output blocks are re-styled by the view anyway. */
function stripControl(s: string): string {
  return s
    // ESC-led sequence: CSI (\u001b[…cmd), OSC (\u001b]…BEL|ST), DCS/SOS/PM/APC (\u001bP/X/^/_…ST), else eat one char.
    .replace(/\u001b(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|.)?/g, '')
    // Remaining C0 controls (incl. lone \r and BEL) except \n and \t, plus DEL.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

function compactOutput(text: string): string {
  const lines = stripControl(text.replace(/\r\n/g, '\n')).split('\n').map((line) => line.replace(/\s+$/g, ''));
  const meaningful = lines.filter((line, index) => line.trim() || (lines[index - 1]?.trim() && lines[index + 1]?.trim()));
  const maxLines = 6;
  const omitted = Math.max(0, meaningful.length - maxLines);
  const shown = meaningful.slice(-maxLines);
  if (omitted) shown.unshift(`… ${omitted} earlier lines hidden`);
  const clipped = shown.join('\n').trim();
  return clipped.length > 800 ? `${clipped.slice(0, 799)}…` : clipped;
}

/** Caps for the expandable ("full") tool-output view. Operator-tunable (Elowen AI → Limits): injected once
 *  at bootstrap via {@link setToolOutputCaps} and read live per render, so a Settings change applies
 *  without a restart. `mapEvent` is a pure transform shared by the live and history paths (and mirrored
 *  in the web transcript), so a module-level resolver is the single seam rather than threading config
 *  through every call site. Defaults match the historical constants. */
let toolOutputCaps: () => { lines: number; chars: number } = () => ({ lines: 80, chars: 12000 });
export function setToolOutputCaps(resolve: () => { lines: number; chars: number }): void { toolOutputCaps = resolve; }

function expandedOutput(text: string): string {
  const lines = stripControl(text.replace(/\r\n/g, '\n')).split('\n').map((line) => line.replace(/\s+$/g, ''));
  const meaningful = lines.filter((line, index) => line.trim() || (lines[index - 1]?.trim() && lines[index + 1]?.trim()));
  const { lines: maxLines, chars: maxChars } = toolOutputCaps();
  const omitted = Math.max(0, meaningful.length - maxLines);
  const shown = meaningful.slice(-maxLines);
  if (omitted) shown.unshift(`… ${omitted} earlier lines hidden`);
  const clipped = shown.join('\n').trim();
  return clipped.length > maxChars ? `${clipped.slice(0, maxChars - 1)}…` : clipped;
}

/** Hook-appended annotations riding a tool result (`details.notes` — the `tools.call.after` contract),
 *  validated defensively: the array is untrusted plugin output, so non-strings are dropped and the
 *  survivors are whitespace-collapsed and capped. Undefined when nothing usable remains. */
function resultNotes(details: Record<string, unknown> | undefined): string[] | undefined {
  const raw = details?.notes;
  if (!Array.isArray(raw)) return undefined;
  const notes = raw
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    .slice(0, 5)
    .map((n) => {
      const s = n.replace(/\s+/g, ' ').trim();
      return s.length > 200 ? `${s.slice(0, 199)}…` : s;
    });
  return notes.length > 0 ? notes : undefined;
}

/** Return a compact, user-useful tool output preview. Most raw tool results stay hidden; command/test
 *  output, browser/search observations, warnings/errors — and hook-appended notes — are useful enough
 *  to show in the chat. */
export function toolOutputView(toolName: string, args: unknown, result: unknown, isError?: boolean): ToolOutputView | undefined {
  const r = (result && typeof result === 'object') ? result as { content?: unknown; details?: Record<string, unknown>; status?: unknown; error?: unknown; isError?: unknown } : {};
  const notes = resultNotes(r.details);
  if (typeof r.details?.diff === 'string' && r.details.diff.trim()) {
    // The diff renders as its own block, so no output preview — unless a hook annotated the result
    // (e.g. "formatted a.ts with prettier"): the note then survives as a minimal notes-only view.
    return notes ? { title: outputTitle(toolName, 'result'), kind: 'result', text: '', tone: 'normal', notes } : undefined;
  }
  const raw = textParts(r.content);
  const errorText = typeof r.error === 'string' ? r.error : '';
  const joined = [raw, errorText].filter(Boolean).join('\n');
  const text = compactOutput(joined);
  const kind = outputKind(toolName);
  const command = toolCommand(args);
  // A shell/console tool ALWAYS surfaces its command on the first line — even when it exited silently
  // (mkdir, cd, a passing test with no stdout). Only the command line + a status chip render then; the
  // (possibly empty) output body follows, with the rest expandable on click. Non-console tools keep the
  // old gating (most raw results stay hidden unless useful). Live and history both reach this: the live
  // path passes the command from `tool_execution_start` (the end event carries no args), history passes
  // the matching assistant tool-call's arguments.
  const consoleCommand = kind === 'console' && !!command;
  // `isError` off the PI event is authoritative when present (the persisted result may not repeat it);
  // fall back to the result object's own flag for the history path.
  const exitCode = (isError ?? r.isError) === true ? true : (r.details?.exitCode ?? r.details?.code ?? r.status);
  const tone = outputTone(text, exitCode);
  // Single-source output visibility (see `toolOutput.ts`): output is HIDDEN by default — a tool NOT on
  // the show allowlist (Read/List/Grep/memory/cron/…) keeps its SUCCESSFUL output out of the transcript
  // so repeated calls collapse into one row — but a FAILURE (warning/danger tone) or a hook-appended note
  // always surfaces so nothing important is swallowed. This replaced the old name-regex allowlist; the
  // policy is injected at bootstrap.
  if (!toolOutputShown(toolName) && tone !== 'warning' && tone !== 'danger' && !notes) return undefined;
  // Nothing worth a block: a non-console tool that exited truly silently with no notes (a shown tool
  // whose output was genuinely empty).
  if (!consoleCommand && !notes && !text) return undefined;
  const status = typeof exitCode === 'number'
    ? `exit ${exitCode}`
    : tone === 'success'
      ? 'ok'
      : tone === 'warning'
        ? 'needs attention'
        : consoleCommand
          ? 'done'
          : undefined;
  const fullText = expandedOutput(joined);
  return { title: outputTitle(toolName, kind), kind, text, ...(fullText && fullText !== text ? { fullText } : {}), command, status, tone, ...(notes ? { notes } : {}) };
}

/** The verbatim shell command a console tool ran (for the always-on first line), collapsed to one line
 *  and capped so a pathological one-liner can't blow up the row. Undefined for non-command tools. */
export function toolCommand(args: unknown): string | undefined {
  const raw = (args && typeof args === 'object') ? (args as { command?: unknown }).command : undefined;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const s = raw.replace(/\s+/g, ' ').trim();
  return s.length > 400 ? `${s.slice(0, 399)}…` : s;
}

/** Wrap untrusted content (retrieved memories, plugin-hook context) in a named frame, neutralizing any
 *  literal closing delimiter inside the body so the content can't break out of the frame and have the
 *  text after it read as un-framed prompt input. Single source for every untrusted live-prompt block. */
export function frameUntrusted(tag: string, preface: string, body: string): string {
  const safe = body.replace(new RegExp(`<\\s*/\\s*${tag}\\s*>`, 'gi'), `[/${tag}]`);
  return `<${tag}>\n${preface}\n${safe}\n</${tag}>\n\n`;
}

/** Strip inline chain-of-thought that some models (notably the vision-fallback endpoints) emit INSIDE
 *  the text content as literal `<think>…</think>` / `<thinking>…</thinking>` tags instead of through a
 *  separate reasoning channel. pi-ai maps such content to `text_delta`, so without this it leaks into
 *  the user-visible reply. Removes complete blocks, an unclosed trailing block (a stream cut off before
 *  the answer), and a leading close tag (reasoning that streamed before any open tag). Native-reasoning
 *  models are unaffected — their thinking never appears in the text at all. A reply that is ONLY
 *  reasoning yields '', which every caller already treats as "no text". */
export function stripInlineReasoning(text: string): string {
  if (!/<\/?think(?:ing)?\b/i.test(text)) return text;
  let out = text
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '') // complete <think>…</think> blocks
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/i, '');                   // an unclosed trailing block
  const lead = /^[\s\S]*?<\/think(?:ing)?>/i.exec(out); // reasoning that streamed before an open tag
  if (lead) out = out.slice(lead[0].length);
  return out.trim();
}

/** Pull display text out of a stored message's content JSON. Content is either a plain string or an
 *  array of parts ({type:'text', text}); anything else yields an empty string. Inline reasoning tags are
 *  stripped here (single source) so no consumer — reply, curator, title — ever sees leaked chain-of-thought. */
export function extractText(msg: unknown): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return stripInlineReasoning(content);
  if (Array.isArray(content)) {
    return stripInlineReasoning(content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join(''));
  }
  return '';
}

/** The ONE automatic recovery prompt for a thinking-only turn (see `isThinkingOnlyReply`). Sent straight
 *  to session.prompt — never persisted as a user message (only its assistant reply lands in history). */
export const NO_REPLY_NUDGE = 'Your last turn produced no visible reply or tool call. Answer the user now, in plain text.';

/** Whether a SETTLED assistant message is thinking-only: the turn ended normally (stopReason 'stop') but
 *  its content carries no visible text and no tool call — only reasoning. Some reasoning models (kimi /
 *  deepseek via relays) end turns like this ("…I'll tell the user" stays in the thinking channel), so the
 *  user sees NOTHING. Errored/aborted turns are excluded — they have their own surfacing paths. Covers
 *  inline `<think>` leakage too: extractText strips it, so a reply that is ONLY inline reasoning counts. */
export function isThinkingOnlyReply(msg: unknown): boolean {
  const m = msg as { role?: string; stopReason?: string; content?: unknown };
  if (m.role !== 'assistant' || m.stopReason !== 'stop') return false;
  const blocks = Array.isArray(m.content) ? (m.content as { type?: string }[]) : [];
  if (blocks.some((b) => b && typeof b === 'object' && b.type === 'toolCall')) return false;
  return extractText(m).trim() === '';
}

/** Shape stored brain rows for display — shared by the advisor chat history and the elowen worker's
 *  task-conversation endpoint. Only user + assistant turns surface; toolResult/summary rows are
 *  persisted for rehydration but never shown (edit diffs are lifted off toolResult rows onto their
 *  matching assistant toolCall segment). */
export function shapeBrainMessages(rows: StoredTurnRow[]): BrainMessageView[] {
  // Edit diffs and raw tool results live on the toolResult rows (never shown raw) — index them by
  // toolCallId so the matching assistant toolCall segment can lift its diff and build its output view.
  // The result view is built LATER, from the assistant toolCall's `arguments` (the toolResult row has no
  // arguments), so a console tool's verbatim command survives into the preview.
  const diffs = new Map<string, string>();
  const results = new Map<string, { result: unknown; isError?: boolean }>();
  for (const row of rows) {
    if (row.role !== 'toolResult') continue;
    try {
      const m = JSON.parse(row.content) as { toolCallId?: string; details?: { diff?: unknown }; isError?: boolean };
      if (!m.toolCallId) continue;
      if (typeof m.details?.diff === 'string' && m.details.diff.trim()) diffs.set(m.toolCallId, m.details.diff);
      results.set(m.toolCallId, { result: m, isError: m.isError });
    } catch { /* malformed row → no diff */ }
  }
  const views: BrainMessageView[] = [];
  for (const row of rows) {
    // A persisted compaction boundary (persistCompaction stores PI's compactionSummary under this role):
    // surface a marker turn so every client draws a subtle "context compacted" divider before the kept
    // tail. The summary itself stays out of the transcript — it's context for the model, not the reader.
    if (row.role === 'compaction') { views.push({ role: 'compaction', text: '' }); continue; }
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
      if (p.type === 'text' && typeof p.text === 'string') {
        // Strip leaked inline <think> tags here too — same as extractText(); otherwise a model that emits
        // reasoning as literal tags would surface them in stored history / task-conversation views.
        const clean = stripInlineReasoning(p.text);
        if (clean.trim()) { text += clean; segments.push({ kind: 'text', text: clean }); }
      } else if (p.type === 'toolCall' && typeof p.name === 'string') {
        // Build the output preview here (not in the toolResult loop) so the toolCall's `arguments` — the
        // only place the verbatim shell command survives — reaches the console renderer.
        const res = p.id ? results.get(p.id) : undefined;
        const output = res ? toolOutputView(p.name, p.arguments, res.result, res.isError) : undefined;
        segments.push({ kind: 'tool', name: p.name, detail: toolDetail(p.arguments), diff: p.id ? diffs.get(p.id) : undefined, output, command: toolCommand(p.arguments) });
      }
    }
    if (typeof msg.content === 'string') {
      const clean = stripInlineReasoning(msg.content);
      if (clean.trim()) { text = clean; segments.push({ kind: 'text', text }); }
    }
    if (segments.length > 0) views.push({ role: 'assistant', text, segments });
  }
  return views;
}
