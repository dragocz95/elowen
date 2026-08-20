/** The minimal stored-row shape `shapeBrainMessages` folds — just the fields it reads (the role and the
 *  raw content JSON). Kept as a local structural contract rather than importing `BrainMessageRow` from
 *  the store: the store imports `extractText` from here, so a type import back into the store would form
 *  a module cycle. `BrainMessageRow` satisfies this structurally, so callers pass their rows unchanged. */
type StoredTurnRow = { id?: string; role: string; content: string; created_at?: string };

// The display-transcript shapes are the daemon↔web wire contract — defined once in src/shared and
// re-exported here for daemon callers (BrainStore passes its validated rows straight through). See
// wireContract.ts for why they live outside src/brain.
import type { ToolOutputView, BrainSubagentView, BrainWorkflowView, BrainSegment, BrainMessageView, BrainMessageImage, BrainPendingPlan } from '../shared/wireContract.js';
import { parseDbTs } from '../shared/time.js';
import { EXIT_PLAN_MODE_TOOL } from '../shared/planTool.js';
import { DEFAULT_BRAIN_LIMITS } from '../store/configStore.js';
import { parseStoredChatImages, stripAttachmentMarker, toMessageImages } from './chatImages.js';
import { collapseWhitespace } from '../shared/text.js';
// Only these two have daemon consumers that import them from here; BrainSubagentView/BrainWorkflowView/
// BrainSegment are used internally by the shaping code below, and anything else that needs them imports
// straight from wireContract.
export type { ToolOutputView, BrainMessageView };

const TOOL_DETAIL_MAX = 60;

function truncateToolDetail(value: string, max = TOOL_DETAIL_MAX): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

/** Requested 1-indexed line window for Read. This mirrors the plugin's offset/limit normalization,
 *  but deliberately describes the request rather than claiming how many lines the file actually had. */
function readRange(args: Record<string, unknown>): string | undefined {
  const rawOffset = args.offset;
  const rawLimit = args.limit;
  const hasOffset = typeof rawOffset === 'number' && Number.isFinite(rawOffset);
  const hasLimit = typeof rawLimit === 'number' && Number.isFinite(rawLimit);
  if (!hasOffset && !hasLimit) return undefined;
  const start = hasOffset ? Math.max(1, Math.floor(rawOffset)) : 1;
  if (!hasLimit) return `from line ${start}`;
  const count = Math.max(0, Math.floor(rawLimit));
  return count > 0 ? `lines ${start}–${start + count - 1}` : `0 lines from ${start}`;
}

/** A short, human-scannable summary of a tool call's most salient argument (the file path, command,
 *  query…), opencode-style: `read src/foo.ts`, `bash "npm test"`. `Read` keeps its requested line
 *  window visible at the end, even when a long path needs truncating. */
export function toolDetail(args: unknown, toolName?: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const raw = a.path ?? a.file_path ?? a.filename ?? a.command ?? a.pattern ?? a.query ?? a.url ?? a.name ?? a.text;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const s = collapseWhitespace(raw);
  const range = toolName === 'Read' ? readRange(a) : undefined;
  if (!range) return truncateToolDetail(s);
  const suffix = ` · ${range}`;
  return `${truncateToolDetail(s, TOOL_DETAIL_MAX - suffix.length)}${suffix}`;
}

/** Loading a skill IS a Read of its file (the system prompt tells the agent to Read it), so a Read
 *  pointed at a skill displays as `Skill <name>`, not `Read <path>`. Undefined for an ordinary read. */
function skillLoadDisplay(args: Record<string, unknown>): { name: string; detail: string } | undefined {
  const raw = args.path;
  if (typeof raw !== 'string') return undefined;
  // Everything past the `/skills/` segment: a flat skill file ("email-management.md") or a plugin
  // skill directory ("salon-operations/SKILL.md") — either way the skill's name leads.
  const after = raw.split('/skills/')[1];
  if (!after) return undefined;
  const lead = after.split('/')[0] ?? '';
  if (!lead || lead.toLowerCase() === 'skill.md') return undefined;
  const dot = lead.lastIndexOf('.');
  const name = dot > 0 ? lead.slice(0, dot) : lead;
  return name ? { name: 'Skill', detail: name } : undefined;
}

/** Display name + detail for a tool call: the tool's own name with toolDetail(), except a skill-file
 *  Read, which renders as `Skill <name>` on every surface (CLI row, live platform trace, web). */
/** The plan markdown a settled ExitPlanMode call submitted, for the client's plan panel and decision.
 *  Read from the result's `details` (client-bound metadata) rather than from its text, which is addressed
 *  to the model. Keyed on the tool name so no other tool can put a plan panel on screen by shipping a
 *  `plan` detail of its own.
 *
 *  Stripped like any other tool output, for the reason given on `stripControl`: the plan is rendered
 *  into a framed panel whose width is measured with ANSI removed but whose lines are written verbatim.
 *  This content is not the model's own prose — it comes off disk, so it carries whatever the model
 *  copied out of the repository it was reading, or whatever the user typed while editing the file. */
export function submittedPlan(toolName: string, result: unknown): string | undefined {
  if (toolName !== EXIT_PLAN_MODE_TOOL) return undefined;
  const details = (result as { details?: unknown } | null | undefined)?.details;
  const plan = (details as { plan?: unknown } | null | undefined)?.plan;
  return typeof plan === 'string' && plan.trim() ? stripControl(plan) : undefined;
}

/** Index of the first row of the newest turn: one past the LAST user row, 0 when the session has no
 *  user row. A user row is the single turn-boundary marker in the durable transcript — everything after
 *  it belongs to the newest turn, so every consumer that cuts "the newest turn" out of stored rows must
 *  cut on exactly this. BrainStore's `getLatestTurn` mirrors it in SQL (rowid > MAX(rowid) over
 *  role='user') because that path must not load the whole history, and `persistAgentRun` verifies its
 *  pre-projected user suffix against the same boundary from the tail — tests/store/turnBoundary.test.ts
 *  holds the SQL mirror and this scan to the same data so one cannot drift from the other. */
export function newestTurnStart(rows: readonly { role?: string }[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]?.role === 'user') return i + 1;
  return 0;
}

/** The plan the conversation is currently waiting on a decision for, rebuilt from its durable rows: the
 *  plan an `ExitPlanMode` call submitted in the NEWEST assistant turn, or null.
 *
 *  Same question the CLI answers over its own in-memory transcript (`TranscriptModel.lastSubmittedPlan`),
 *  answered here for every client that has no transcript of its own — which is what lets the decision
 *  survive a reload, a second tab and a client that was not attached when the turn ran.
 *
 *  The scan is the newest turn, not the newest row: a turn ends on plain text as often as on the tool call
 *  itself, and taking only the last assistant row would lose a plan that had prose after it. A newer USER
 *  row ends the turn and the decision with it — the conversation moved on. Display-only session events
 *  (a model/mode marker landing between the plan and the turn's end) live in their own table, so nothing
 *  in this row stream can hide the plan. */
export function pendingSubmittedPlan(rows: readonly StoredTurnRow[]): BrainPendingPlan | null {
  const turn = rows.slice(newestTurnStart(rows));
  const results = new Map<string, unknown>();
  for (const row of turn) {
    if (row.role !== 'toolResult') continue;
    try {
      const message = JSON.parse(row.content) as { toolCallId?: string };
      if (message.toolCallId) results.set(message.toolCallId, message);
    } catch { /* malformed row → no result to read a plan off */ }
  }
  let found: BrainPendingPlan | null = null;
  for (const row of turn) {
    if (row.role !== 'assistant') continue;
    let content: unknown;
    try { content = (JSON.parse(row.content) as { content?: unknown }).content; }
    catch { continue; }
    for (const part of Array.isArray(content) ? content : []) {
      const call = part as { type?: string; id?: string; name?: string };
      if (call?.type !== 'toolCall' || typeof call.name !== 'string' || !call.id) continue;
      const plan = submittedPlan(call.name, results.get(call.id));
      if (plan) found = { id: call.id, plan };
    }
  }
  return found;
}

export function toolDisplay(toolName: string, args: unknown): { name: string; detail?: string } {
  if (toolName === 'Read' && args && typeof args === 'object') {
    const skill = skillLoadDisplay(args as Record<string, unknown>);
    if (skill) return skill;
  }
  return { name: toolName, detail: toolDetail(args, toolName) };
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
  // No authoritative signal → judge the HEADLINE only (first non-blank line). A tool's verdict is its
  // opening line; the same word further down is data, not this call's status — DelegateList naming a
  // sub-agent whose own run ended in `error`, a grep hit on "error", a task description mentioning a
  // "build failed" bug. Scanning the whole body turned every such informational listing into a red row.
  const headline = text.split('\n').find((line) => line.trim()) ?? '';
  if (/^\s*(error|fatal|exception|traceback)\b|\b(command|build|tests?|compilation|request) failed\b/i.test(headline)) return 'warning';
  if (/\b(pass|passed|success|ok|done|green)\b/i.test(headline)) return 'success';
  return 'normal';
}

function outputKind(toolName: string): ToolOutputView['kind'] {
  return /(shell|bash|command|terminal|exec|test|lint|knip|npm|pnpm|yarn)/i.test(toolName) ? 'console' : 'result';
}

function outputTitle(toolName: string, kind: ToolOutputView['kind']): string {
  if (kind === 'console') return 'console output';
  if (/(browser|playwright|chrome|page|web)/i.test(toolName)) return 'browser observation';
  // LSP tools carry their own identity in the output header so a check reads as LSP, not a generic result:
  // the diagnostics tool says "LSP diagnostics", the navigation/symbol ones "LSP result".
  if (/^lsp/i.test(toolName)) return /diagnostic/i.test(toolName) ? 'LSP diagnostics' : 'LSP result';
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
let toolOutputCaps: () => { lines: number; chars: number } = () => ({ lines: DEFAULT_BRAIN_LIMITS.toolOutputMaxLines, chars: DEFAULT_BRAIN_LIMITS.toolOutputMaxChars });
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

/** The image segment a stored `ShareImage` result rebuilds into, or undefined when the result is not one.
 *  Read from `details` (client-bound metadata) rather than the text, exactly like the plan and diff fields
 *  beside it — the text is addressed to the model and is free to change wording. */
function sharedImageOf(result: unknown): { kind: 'image'; image: BrainMessageImage; caption?: string } | undefined {
  const shared = (result as { details?: { sharedImage?: unknown } } | null | undefined)?.details?.sharedImage;
  if (typeof shared !== 'object' || shared === null) return undefined;
  const { file, mimeType, caption } = shared as { file?: unknown; mimeType?: unknown; caption?: unknown };
  if (typeof file !== 'string' || typeof mimeType !== 'string') return undefined;
  const [image] = toMessageImages([{ file, mimeType }]);
  if (!image) return undefined;
  return { kind: 'image', image, ...(typeof caption === 'string' && caption ? { caption } : {}) };
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
      const s = collapseWhitespace(n);
      return s.length > 200 ? `${s.slice(0, 199)}…` : s;
    });
  return notes.length > 0 ? notes : undefined;
}

/** Drop the console framing that exists for the MODEL, not the reader: the leading `$ <cmd>` echo (the
 *  renderer prints the command on its own top line), the `(cwd: …)` line (lifted into the structured `cwd`
 *  field) and the trailing `[exit N]` marker (the exit code travels as `details.exitCode` → tone/status).
 *  The terminal plugin is the only producer of this framing and it always frames output as
 *  `$ <cmd>\n(cwd: …)\n…\n[exit N]`, so match that exact PAIR — a `$ ` line immediately followed by a
 *  `(cwd: …)` line — rather than any lone `$ ` line, so genuine output that merely starts with `$ ` (or
 *  ends in a bracketed word) is left intact. Gated on the tool KIND, not on the presence of args: the live
 *  `tool_execution_end` event carries no args, and the framing must never leak into the display there
 *  either (it used to surface as a literal `[exit 0]` summary in the chat adapters). */
function stripConsoleFraming(text: string, isConsole: boolean): { text: string; cwd?: string } {
  if (!text || !isConsole) return { text };
  const lines = text.split('\n');
  if (!(lines[0]?.startsWith('$ ') && lines[1]?.startsWith('(cwd: '))) return { text };
  const cwd = /^\(cwd: (.+)\)$/.exec(lines[1] ?? '')?.[1];
  lines.splice(0, 2);
  if (/^\[exit \d+\]$/.test((lines[lines.length - 1] ?? '').trim())) lines.pop();
  return { text: lines.join('\n'), ...(cwd ? { cwd } : {}) };
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
  // Console plugins frame their result as `$ <cmd>\n(cwd: …)\n<output>\n[exit N]` so the LLM reads full
  // context — but for the READER that framing is redundant noise: the command echo re-derives from args,
  // the cwd becomes the structured `cwd` field and the exit code arrives as `details.exitCode` (tone +
  // status). Strip it at this single view seam (live + history + web all pass through here) so only the
  // real output remains in the body.
  const framed = stripConsoleFraming([raw, errorText].filter(Boolean).join('\n'), kind === 'console');
  const joined = framed.text;
  const text = compactOutput(joined);
  const tone = outputTone(text, exitCode);
  // Single-source output visibility (see `toolOutput.ts`): output is HIDDEN by default — a tool NOT on
  // the show allowlist (Read/List/Grep/memory/cron/…) keeps its SUCCESSFUL output out of the transcript
  // so repeated calls collapse into one row — but a FAILURE (warning/danger tone) or a hook-appended note
  // always surfaces so nothing important is swallowed. This replaced the old name-regex allowlist; the
  // policy is injected at bootstrap.
  if (!toolOutputShown(toolName) && tone !== 'warning' && tone !== 'danger' && !notes) return undefined;
  // Nothing worth a block: a tool that exited truly silently with no notes (a shown tool whose output
  // was genuinely empty). A console FAILURE keeps its block even then — the framing strip can leave a
  // silent failing command with an empty body, and the status chip (exit N) is the whole story; the live
  // path carries no args, so `consoleCommand` alone cannot vouch for it.
  const consoleFailure = kind === 'console' && (tone === 'warning' || tone === 'danger');
  if (!consoleCommand && !notes && !text && !consoleFailure) return undefined;
  // A clean exit 0 carries NO status — success is the default state of a settled row, and naming it
  // ("exit 0"/"ok") just trained every consumer to filter the string back out. Mirrors localShellTurn.
  // A failure keeps its exit code so the trace still says WHY the row is flagged.
  const status = typeof exitCode === 'number'
    ? (exitCode === 0 ? undefined : `exit ${exitCode}`)
    : tone === 'success'
      ? 'ok'
      : tone === 'warning'
        ? 'needs attention'
        : consoleCommand
          ? 'done'
          : undefined;
  const fullText = expandedOutput(joined);
  return { title: outputTitle(toolName, kind), kind, text, ...(fullText && fullText !== text ? { fullText } : {}), command, ...(framed.cwd ? { cwd: framed.cwd } : {}), status, tone, ...(notes ? { notes } : {}) };
}

/** The verbatim shell command a console tool ran (for the always-on first line), collapsed to one line
 *  and capped so a pathological one-liner can't blow up the row. Undefined for non-command tools. */
export function toolCommand(args: unknown): string | undefined {
  const raw = (args && typeof args === 'object') ? (args as { command?: unknown }).command : undefined;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const s = collapseWhitespace(raw);
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
 *  reasoning yields '', which every caller already treats as "no text".
 *
 *  The two open-ended rules are ANCHORED TO A LINE BOUNDARY, and that anchoring is load-bearing. Both
 *  delete an unbounded span — to end-of-string, and from start-of-string — so an unanchored match turns
 *  any prose that merely MENTIONS a reasoning tag into a silently truncated answer. That is not
 *  hypothetical: a report discussing this very function lost ~10 000 characters to it. A genuinely cut-off
 *  stream always begins its reasoning on a fresh line, and a close tag that really ends streamed reasoning
 *  is followed by a newline before the answer, so requiring those boundaries keeps every real case while
 *  leaving inline mentions (`<think>` inside a sentence or backticks) untouched.
 *  Mirrored by `stripThinking` in plugins/_shared/format.mjs — tests/contract/inlineReasoningParity.test.ts
 *  holds the two to the same corpus. */
export function stripInlineReasoning(text: string): string {
  if (!/<\/?think(?:ing)?\b/i.test(text)) return text;
  let out = text
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '') // complete <think>…</think> blocks
    .replace(/^[ \t]*<think(?:ing)?\b[^>]*>[\s\S]*$/im, '');           // an unclosed trailing block, line-anchored
  const lead = /^[\s\S]*?<\/think(?:ing)?>[ \t]*(?:\n|$)/i.exec(out); // reasoning that streamed before an open tag
  if (lead) out = out.slice(lead[0].length);
  return out.trim();
}

/** Pull display text out of a stored message's content JSON. Content is either a plain string or an
 *  array of parts ({type:'text', text}); anything else yields an empty string. Inline reasoning tags are
 *  stripped here (single source) so no consumer — reply, curator, title — ever sees leaked chain-of-thought.
 *
 *  `msg` is genuinely unknown: callers hand it straight from `JSON.parse` of a stored row, and `null` (a
 *  row whose content is the literal `null`) parses fine. Reading `.content` off it would throw and take
 *  the WHOLE transcript down, so the access is optional. */
export function extractText(msg: unknown): string {
  const content = (msg as { content?: unknown } | null | undefined)?.content;
  if (typeof content === 'string') return stripInlineReasoning(content);
  if (Array.isArray(content)) {
    return stripInlineReasoning(content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join(''));
  }
  return '';
}

/** Imported platform transcript rows are model-only context. Their JSON envelope intentionally remains
 *  in storage and provider payloads, but no human transcript should render it as a chat message. Require
 *  the complete provenance shape so an ordinary JSON-looking user message is not hidden by accident. */
function isPlatformHistoryMessage(msg: { content?: unknown }): boolean {
  const raw = typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content) && msg.content.length === 1
      && msg.content[0]?.type === 'text' && typeof msg.content[0].text === 'string'
      ? msg.content[0].text
      : undefined;
  if (!raw) return false;
  try {
    const envelope: unknown = JSON.parse(raw);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
    const e = envelope as Record<string, unknown>;
    return e.source === 'platform_history' && e.untrusted === true
      && typeof e.platform === 'string' && typeof e.channelId === 'string' && typeof e.text === 'string';
  } catch {
    return false;
  }
}

/** The most recent assistant message in a list, or undefined — the single "what did the agent last say"
 *  expression, reused by the turn runner, channels, spawner and status views. Scans from the end so it
 *  neither copies nor reverses the array. */
export function lastAssistant<T extends { role?: string }>(messages: readonly T[]): T | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.role === 'assistant') return messages[i];
  return undefined;
}

/** The last thing the agent said, as plain text, from STORED rows — whose `content` is still JSON. Takes
 *  the rows rather than the store so a caller that only needs the newest turn can hand over just that
 *  instead of the whole conversation. Unparseable content reads as no answer at all, never as raw JSON. */
export function lastAssistantTextIn(rows: readonly { role?: string; content: string }[]): string {
  const row = lastAssistant(rows);
  if (!row) return '';
  try { return extractText(JSON.parse(row.content)); }
  catch { return ''; }
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
export function shapeBrainMessages(
  rows: StoredTurnRow[],
  subagentRuns: readonly ({ toolCallId: string } & BrainSubagentView)[] = [],
  sessionEvents: readonly { id: string; kind: string; detail: string; at: string }[] = [],
  workflowRuns: readonly BrainWorkflowView[] = [],
): BrainMessageView[] {
  // Edit diffs and raw tool results live on the toolResult rows (never shown raw) — index them by
  // toolCallId so the matching assistant toolCall segment can lift its diff and build its output view.
  // The result view is built LATER, from the assistant toolCall's `arguments` (the toolResult row has no
  // arguments), so a console tool's verbatim command survives into the preview.
  const diffs = new Map<string, string>();
  const results = new Map<string, { result: unknown; isError?: boolean }>();
  const subagents = new Map(subagentRuns.map(({ toolCallId, ...state }) => [toolCallId, state]));
  // Not destructured like the sub-agent above: a subagent's `id` IS its tool call id and would collide
  // with the tool item's own `id`, whereas a workflow's `id` is its own — so the view keeps every field
  // and stays identical to the durable row and the wire event.
  const workflows = new Map(workflowRuns.map((run) => [run.toolCallId, run]));
  for (const row of rows) {
    if (row.role !== 'toolResult') continue;
    try {
      const m = JSON.parse(row.content) as { toolCallId?: string; details?: { diff?: unknown }; isError?: boolean };
      if (!m.toolCallId) continue;
      if (typeof m.details?.diff === 'string' && m.details.diff.trim()) diffs.set(m.toolCallId, m.details.diff);
      results.set(m.toolCallId, { result: m, isError: m.isError });
    } catch { /* malformed row → no diff */ }
  }
  // Stamp each produced view with its source row's time so display-only session-event markers can be
  // interleaved into the (time-ordered) transcript at their real position.
  const stamped: { at: string; view: BrainMessageView }[] = [];
  for (const row of rows) {
    // A persisted compaction boundary (persistCompaction stores PI's compactionSummary under this role):
    // surface a marker turn so every client draws a subtle "context compacted" divider before the kept
    // tail. The summary itself stays out of the transcript — it's context for the model, not the reader.
    if (row.role === 'compaction') {
      stamped.push({ at: row.created_at ?? '', view: { ...(row.id ? { id: row.id } : {}), role: 'compaction', text: '' } });
      continue;
    }
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    // A stored row is only usable as a message when it parses to an OBJECT: `null` and bare scalars are
    // valid JSON, so the parse alone would let them through and every `.content` read below would throw —
    // taking the entire transcript down over one bad row. Anything else stays the empty message, which
    // produces no view and is skipped.
    let msg: { content?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(row.content);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) msg = parsed;
    } catch { /* malformed row → skipped below */ }
    if (isPlatformHistoryMessage(msg)) continue;
    if (row.role === 'user') {
      const images = parseStoredChatImages((msg as { images?: unknown }).images);
      // The stored text keeps its `[📎 N× image]` marker — that is the only trace the MODEL has of the
      // attachment once the bytes are gone. A client that can draw the thumbnails does not need the words
      // too, so the marker is dropped from the view (and only there) when the files still exist.
      const text = images.length ? stripAttachmentMarker(extractText(msg)) : extractText(msg);
      if (text.trim() || images.length) {
        stamped.push({
          at: row.created_at ?? '',
          view: { ...(row.id ? { id: row.id } : {}), role: 'user', text, ...(images.length ? { images: toMessageImages(images) } : {}) },
        });
      }
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
        // A successful share becomes the picture itself — the "ShareImage" pill next to it would say
        // nothing the image does not. A FAILED one falls through to the normal tool row, so the reason it
        // did not appear stays readable.
        const shared = sharedImageOf(res?.result);
        if (shared && res?.isError !== true) { segments.push(shared); continue; }
        const output = res ? toolOutputView(p.name, p.arguments, res.result, res.isError) : undefined;
        const display = toolDisplay(p.name, p.arguments);
        const diff = p.id ? diffs.get(p.id) : undefined;
        const command = toolCommand(p.arguments);
        const plan = submittedPlan(p.name, res?.result);
        segments.push({
          kind: 'tool', name: display.name,
          ...(p.id ? { id: p.id } : {}),
          ...(display.detail ? { detail: display.detail } : {}),
          ...(diff ? { diff } : {}),
          ...(output ? { output } : {}),
          ...(command ? { command } : {}),
          ...(plan ? { plan } : {}),
          ...(p.id && subagents.has(p.id) ? { sub: subagents.get(p.id) } : {}),
          // Gated on the tool NAME, not just the call id: workflow state must only ever ride its own
          // WorkflowStart row — on an id collision it would otherwise decorate an unrelated tool call,
          // and withWorkflowAnchors (same name gate) would suppress the real anchor's synthesis over it.
          ...(p.id && p.name === 'WorkflowStart' && workflows.has(p.id) ? { wf: workflows.get(p.id) } : {}),
        });
      }
    }
    if (typeof msg.content === 'string') {
      const clean = stripInlineReasoning(msg.content);
      if (clean.trim()) { text = clean; segments.push({ kind: 'text', text }); }
    }
    if (segments.length > 0) stamped.push({ at: row.created_at ?? '', view: { ...(row.id ? { id: row.id } : {}), role: 'assistant', text, segments } });
  }
  // Merge the session-event markers into the time-ordered views (both streams are already chronological).
  // Message rows carry SQLite time (`YYYY-MM-DD HH:MM:SS`, second precision), events carry ISO 8601, so
  // normalize both to epoch ms.
  //
  // Second precision means a marker and the row it borders routinely land on the SAME second, and a plain
  // sort would order them arbitrarily. The tie is broken by what a marker MEANS: it is recorded between
  // turns — after the reply it followed, before the next thing the user says. So on a tie the marker goes
  // BEFORE a user row and AFTER any other row. That is what makes a mode switch (always recorded in the
  // same second as the very turn it precedes) render identically here and in the live event fold.
  if (sessionEvents.length === 0) return stamped.map((s) => s.view);
  const events = sessionEvents.map((e) => ({
    ms: parseDbTs(e.at),
    view: { id: e.id, role: 'event', text: '', kind: e.kind, detail: e.detail } as BrainMessageView,
  }));
  const merged: BrainMessageView[] = [];
  let next = 0;
  for (const row of stamped) {
    const ms = parseDbTs(row.at);
    while (next < events.length
      && (events[next]!.ms < ms || (events[next]!.ms === ms && row.view.role === 'user'))) {
      merged.push(events[next]!.view);
      next += 1;
    }
    merged.push(row.view);
  }
  for (; next < events.length; next += 1) merged.push(events[next]!.view);
  return merged;
}

/** Every workflow rendering keys on the WorkflowStart tool row: the transcript chip, the panel projection
 *  (both clients rebuild it from the loaded views) and even LIVE `workflow` events, which clients attach
 *  by tool call id and silently drop when no such row is loaded. That row is not guaranteed to be there —
 *  compaction trims it out of the durable history, and the chat's windowed first page can cut it off —
 *  while the engine keeps running the DAG regardless. Without an anchor a RUNNING workflow becomes
 *  invisible to the conversation that owns it, which is exactly the state this repairs: prepend a
 *  synthetic anchor view for each running workflow that has no real one among `views`.
 *
 *  Only RUNNING workflows are synthesized. A terminal one already left its durable finish marker in the
 *  transcript, and resurrecting every finished DAG of a long conversation at the top of each page would
 *  be noise, not recovered state.
 *
 *  The synthetic view's id is derived (stable across refetches, so client turn-dedup works — and NOT a
 *  SQLite row UUID, the one exception to the wire contract's id rule, which is why the view carries
 *  `synthetic: true`) and its tool item carries the run's REAL toolCallId — that is what re-attaches
 *  subsequent live snapshots. Prepended because the missing anchor is by construction older than every
 *  loaded view; when paging later reaches the real anchor row, both render — the `synthetic` mark is what
 *  lets a client drop the synthetic copy by toolCallId once the real row arrives.
 *
 *  A view counts as an existing anchor only when it is a WorkflowStart call: any other tool segment that
 *  happens to carry the same id (an id collision) must not suppress the synthesis — the workflow state
 *  would then hang off a foreign tool row instead of an anchor of its own. */
export function withWorkflowAnchors(views: BrainMessageView[], workflowRuns: readonly BrainWorkflowView[]): BrainMessageView[] {
  const running = workflowRuns.filter((run) => run.status === 'running');
  if (running.length === 0) return views;
  const anchored = new Set<string>();
  for (const view of views) {
    for (const segment of view.segments ?? []) {
      if (segment.kind === 'tool' && segment.id && segment.name === 'WorkflowStart') anchored.add(segment.id);
    }
  }
  const synthetic = running
    .filter((run) => !anchored.has(run.toolCallId))
    .map((run): BrainMessageView => ({
      id: `wf-anchor-${run.toolCallId}`,
      synthetic: true,
      role: 'assistant',
      text: '',
      segments: [{ kind: 'tool', name: 'WorkflowStart', id: run.toolCallId, ...(run.title ? { detail: run.title } : {}), wf: run }],
    }));
  return synthetic.length ? [...synthetic, ...views] : views;
}
