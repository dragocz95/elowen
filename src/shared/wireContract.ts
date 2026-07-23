/** The daemon↔web wire contract: the pure display-transcript shapes the daemon serves over
 *  `GET /brain/messages` and the SSE stream, and the web dock renders. This is the ONE definition both
 *  toolchains import, so a field added on the daemon can never be silently missing on the web mirror —
 *  the exact drift this file exists to end (ToolOutputView.notes, the workflow `wf` segment, the
 *  `kind`/`detail` event rows, and the sub-agent state fields all diverged while these were hand-copied).
 *
 *  It carries TYPES only and imports nothing, so:
 *   - the daemon (NodeNext) and web (Bundler) resolvers both accept `../shared/wireContract.js`;
 *   - a type-only import erases at build time, adding zero runtime code to the Next bundle.
 *
 *  `src/brain/messageView.ts` re-exports these to the daemon; `web/lib/types.ts` re-exports them to the
 *  web. Neither redeclares the shapes. */

export interface ToolOutputView {
  title: string;
  kind: 'console' | 'result';
  text: string;
  fullText?: string;
  command?: string;
  /** Working directory of a console run, lifted out of the terminal plugin's `(cwd: …)` framing line so
   *  the body carries only real output. Renderers show it as faint context under the command echo. */
  cwd?: string;
  status?: string;
  tone?: 'normal' | 'success' | 'warning' | 'danger';
  /** Hook-appended annotations lifted off `result.details.notes` (the `tools.call.after` contract —
   *  e.g. "formatted a.ts with prettier"). Rendered as faint suffix lines under the output body. */
  notes?: string[];
}

/** Durable latest state attached to a delegated tool call (a sub-agent `Task`). */
export interface BrainSubagentView {
  sessionId: string;
  status: 'running' | 'done' | 'error';
  task: string;
  detail?: string;
  tools: number;
  tokens?: number;
  seconds: number;
  model?: string;
  background?: boolean;
  autoDeliver?: boolean;
  resultDelivery?: 'pending' | 'acknowledged';
}

/** Durable latest state of a workflow DAG attached to its `WorkflowStart` call. */
export interface BrainWorkflowView {
  id: string;
  toolCallId: string;
  title?: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  nodes: {
    id: string;
    task: string;
    status: 'pending' | 'running' | 'done' | 'error';
    deps: string[];
    sessionId?: string;
    detail?: string;
    tokens?: number;
    seconds?: number;
    model?: string;
    /** Epoch ms of the node's launch — clients tick live elapsed time from it between snapshots. */
    startedAt?: number;
    /** Short preview of a terminal node's outcome (bounded by the engine and again on persist). */
    result?: string;
    error?: string;
  }[];
}

/** One display piece of an assistant turn, in the order it happened: a text block, or a tool call (with a
 *  short argument summary and, for edits, the display diff). The call id stays on the wire so a
 *  post-parent-idle background update can patch the already-settled row. */
export type BrainSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; id?: string; detail?: string; diff?: string; output?: ToolOutputView; command?: string; sub?: BrainSubagentView; wf?: BrainWorkflowView };

/** A durable display row (the `GET /brain/messages` payload). `id` is the SQLite message UUID when the
 *  source is a real store row (the only case served over HTTP); structural callers may omit it. `text` is
 *  the flat reply; `segments` preserve the true order. `kind`/`detail` mark a non-message system row (a
 *  model/mode/rename/cwd event) rather than an assistant/user turn. */
export interface BrainMessageView { id?: string; role: string; text: string; segments?: BrainSegment[]; kind?: string; detail?: string }

/** Which chat surface exposes a slash command. Part of the wire contract because `GET /brain/commands`
 *  serves the filtered list to every surface (CLI, web dock, platform bots). */
export type SlashSurface = 'cli' | 'discord' | 'whatsapp' | 'telegram' | 'msteams' | 'web';

/** How a surface handles a command once picked: `action` (server effect), `info` (fetch+render),
 *  `picker` (surface-local chooser), `mode` (local work-mode switch), `prompt` (plugin prompt macro). */
type SlashKind = 'action' | 'info' | 'picker' | 'mode' | 'prompt';

/** A chat slash command as served over `GET /brain/commands`. Defined ONCE here so the daemon's
 *  canonical list (src/brain/slashCommands.ts) and the web dock's menu can never drift — the web copy had
 *  silently lost `surfaces` (which gates visibility) and `plugin` (menu attribution). */
export interface SlashCommandDef {
  name: string;
  /** One-line help shown in every surface's menu. English (surfaces localize their own chrome only). */
  description: string;
  kind: SlashKind;
  /** Gated to admins (server-side check is `user.is_admin`). e.g. `restart`. */
  adminOnly?: boolean;
  /** Which surfaces expose it. Omitted → all. */
  surfaces?: SlashSurface[];
  /** For `kind:'prompt'` (plugin) commands: the prompt template PI expands when the raw slash arrives. */
  prompt?: string;
  /** For plugin commands: the owning plugin's name (menu attribution + provenance). */
  plugin?: string;
}
