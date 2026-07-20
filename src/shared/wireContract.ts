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
