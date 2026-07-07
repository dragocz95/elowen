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

function shouldShowToolOutput(toolName: string, text: string, tone: ToolOutputView['tone']): boolean {
  if (tone === 'warning' || tone === 'danger') return true;
  return /(shell|bash|command|terminal|exec|test|lint|knip|npm|pnpm|yarn|browser|playwright|chrome|page|grep|search|find|rg)/i.test(toolName)
    && text.trim().length > 0;
}

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

function expandedOutput(text: string): string {
  const lines = stripControl(text.replace(/\r\n/g, '\n')).split('\n').map((line) => line.replace(/\s+$/g, ''));
  const meaningful = lines.filter((line, index) => line.trim() || (lines[index - 1]?.trim() && lines[index + 1]?.trim()));
  const maxLines = 80;
  const omitted = Math.max(0, meaningful.length - maxLines);
  const shown = meaningful.slice(-maxLines);
  if (omitted) shown.unshift(`… ${omitted} earlier lines hidden`);
  const clipped = shown.join('\n').trim();
  return clipped.length > 12000 ? `${clipped.slice(0, 11999)}…` : clipped;
}

/** Return a compact, user-useful tool output preview. Most raw tool results stay hidden; command/test
 *  output, browser/search observations, and warnings/errors are useful enough to show in the chat. */
export function toolOutputView(toolName: string, args: unknown, result: unknown, isError?: boolean): ToolOutputView | undefined {
  const r = (result && typeof result === 'object') ? result as { content?: unknown; details?: Record<string, unknown>; status?: unknown; error?: unknown; isError?: unknown } : {};
  if (typeof r.details?.diff === 'string' && r.details.diff.trim()) return undefined;
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
  if (!consoleCommand) {
    if (!text) return undefined;
    if (!shouldShowToolOutput(toolName, text, tone)) return undefined;
  }
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
  return { title: outputTitle(toolName, kind), kind, text, ...(fullText && fullText !== text ? { fullText } : {}), command, status, tone };
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

/** Shape stored brain rows for display — shared by the advisor chat history and the orca worker's
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
