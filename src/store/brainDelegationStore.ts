import type { Db } from './db.js';
import { withWriteLock } from './db.js';
import type { WorkflowNode, WorkflowUpdate } from '../brain/events.js';
import { SUBAGENT_PREFIX } from '../brain/sessionId.js';
import { logger } from '../shared/logger.js';

/** Validated latest UI state of one delegated child. The child id is a first-class indexed column in
 *  brain_subagent_runs; this JSON state contains only bounded display data. */
interface BrainSubagentRunState {
  status: 'running' | 'done' | 'error';
  task: string;
  detail?: string;
  tools: number;
  tokens?: number;
  seconds: number;
  model?: string;
  thinkingLevel?: string;
  thinkingLabel?: string;
  background?: boolean;
  autoDeliver?: boolean;
  resultDelivery?: 'pending' | 'acknowledged';
  /** Sandbox workspace the child was confined to (Delegate's `workspaceId`). Mirrors BrainSubagentView;
   *  display-only, drives the sandboxed-run glyph. */
  workspaceId?: string;
}
/** Store-neutral display shape consumed by shapeBrainMessages. */
export interface BrainSubagentRun extends BrainSubagentRunState {
  toolCallId: string;
  sessionId: string;
  /** Insertion order of the run row — the only honest "which run of this child is newest" (a
   *  boot-claimed `recovering` row keeps the pause's updated_at for as long as its respawn runs). */
  rowid: number;
  /** The delegated child's existing brain_sessions.created_at value. */
  startedAt?: string;
  /** The run sidecar's existing brain_subagent_runs.updated_at value. */
  updatedAt?: string;
}
/** One restart-orphaned delegation claimed for recovery at boot: enough to rehydrate the child session,
 *  classify its discarded suffix and decide respawn vs recovery_required. `attempt` is the post-increment
 *  count, so boot recovery can cap a run that keeps crashing its own recovery. */
export interface RecoverableRun {
  parentSessionId: string;
  toolCallId: string;
  childSessionId: string;
  attempt: number;
  state: BrainSubagentRunState;
}
/** The validated latest snapshot of one workflow DAG (see brain_workflows). Aliases the wire payload on
 *  purpose: a `workflow` event carries the WHOLE DAG, so the durable row IS the snapshot and the row,
 *  the event and the state attached to the tool item cannot drift apart. Bounded display data only. */
export type BrainWorkflowRun = WorkflowUpdate;
/** One restart-orphaned workflow claimed for resume at boot. The snapshot is display-grade (clipped
 *  previews) — the engine's own recovery journal, not this row, carries what a resume actually needs; the
 *  claim is what makes exactly one boot responsible for either resuming or terminalizing the DAG.
 *  `attempt` is post-increment, mirroring RecoverableRun. */
export interface RecoverableWorkflow {
  parentSessionId: string;
  toolCallId: string;
  workflowId: string;
  attempt: number;
  state: BrainWorkflowRun;
}
/** One delegated child of a conversation, as its PARENT sees it: enough to recognise which sub-agent
 *  this was and decide whether to continue it. `task`/`status`/`model` come from the child's
 *  brain_subagent_runs row and are absent for a child the engine never recorded one for (a workflow
 *  node), which is why the listing is driven by the durable session relation instead. */
export interface DelegatedChildSummary {
  sessionId: string;
  title: string;
  task?: string;
  status?: 'running' | 'done' | 'error';
  /** Turns already in the child's transcript — what a continuation would resume on top of. */
  messages: number;
  model?: string;
  startedAt: string;
  updatedAt: string;
}

/** Ceiling for one listing. A conversation that fanned out hundreds of children must not turn a single
 *  tool call into an unbounded transcript dump. */
const MAX_DELEGATED_CHILDREN = 50;

/** `provider/model` when both are known, the bare model when only that is. A bare id is ambiguous once
 *  several providers serve similarly named models, and the listing is what an agent reads to report which
 *  model actually ran — so it should not have to guess. */
function qualifiedModel(provider: string | null, model: string | null): string | undefined {
  if (!model) return undefined;
  return provider ? `${provider}/${model}` : model;
}

export interface BrainSubagentResult {
  /** Which producer enqueued this row (see brain_subagent_results.kind). A 'workflow' result carries an
   *  empty `sessionId` and a `workflowId` instead of a child session. */
  kind: 'subagent' | 'workflow';
  id: string;
  parentSessionId: string;
  toolCallId: string;
  sessionId: string;
  workflowId?: string;
  status: 'done' | 'error';
  task: string;
  result?: string;
  error?: string;
  tools: number;
  tokens?: number;
  seconds: number;
  model?: string;
  delivery: 'pending' | 'acknowledged';
  attempts: number;
  /** This is an unsafe-recovery notice, not a completion the parent may act on autonomously. */
  requiresUserAction: boolean;
}
/** A daemon-restart reconcile enqueues a SYNTHETIC terminal result for each orphaned running child so an
 *  autoDeliver parent still gets woken. Its id carries this prefix so a real completion arriving later for
 *  the same (parent_session_id, tool_call_id) can UPGRADE the still-pending synthetic row in place (see
 *  enqueueSubagentResult) rather than colliding with it. */
const SYNTHETIC_RESTART_RESULT_PREFIX = 'restart-';
export const syntheticRestartResultId = (parentSessionId: string, toolCallId: string): string =>
  `${SYNTHETIC_RESTART_RESULT_PREFIX}${parentSessionId}-${toolCallId}`;

const bounded = (value: string, max: number): string => value.length <= max ? value : value.slice(0, max);

/** The delivery-path twin of `bounded` for the one field a parent reads as the ANSWER: an over-long result
 *  keeps its END, because a report's conclusion is its last paragraph. Head-first is still right everywhere a
 *  bound produces a preview (a task line, a snapshot row) and for an error, which leads with what broke.
 *
 *  Deliberate mirror of `clipTail` in plugins/subagent/lib/results.mjs — a plugin may not import daemon
 *  sources and the daemon may not import a plugin's ESM, so the two carry the same note and the same
 *  arithmetic. tests/store/brainStore.test.ts asserts they agree character for character. */
const truncationNote = (dropped: number): string =>
  `[truncated: first ${dropped} chars dropped, end kept — read it in full with DelegateRead]\n`;
const boundedTail = (value: string, max: number): string => {
  if (value.length <= max) return value;
  const kept = Math.max(0, max - truncationNote(value.length).length);
  // `slice(-0)` is `slice(0)` — the whole string — so a zero-width tail has to be spelled out.
  return `${truncationNote(value.length - kept)}${kept === 0 ? '' : value.slice(-kept)}`;
};

// Bounds for a persisted workflow snapshot, mirroring the engine's own limits (dag.mjs MAX_NODES /
// MAX_ID_CHARS, workflow.mjs SNAPSHOT_TASK_PREVIEW). The whole DAG re-fans on every tool event of every
// node, so an unbounded blob would be a write amplifier as much as a DoS: `deps` dominates the ceiling,
// since every node may name every other, so 64 nodes x ~5.4k caps a row near 350k. `task` allows the
// preview plus its ellipsis; `detail` is one "tool + arg" line, so it gets far less room than a
// sub-agent's 2k -- 64 of those at that size would be 128k per snapshot.
const MAX_WORKFLOW_NODES = 64;
const MAX_WORKFLOW_ID_CHARS = 64;
const MAX_WORKFLOW_TASK_CHARS = 600;
const MAX_WORKFLOW_DETAIL_CHARS = 500;
// Terminal result/error previews (engine clips to SNAPSHOT_RESULT_PREVIEW + a truncation marker).
const MAX_WORKFLOW_RESULT_CHARS = 600;

function normalizeWorkflowWorkspaceRef(raw: unknown): { workspaceId: string; projectId: number } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.workspaceId !== 'string' || !value.workspaceId || value.workspaceId.length > 128) return undefined;
  if (!Number.isSafeInteger(value.projectId) || (value.projectId as number) <= 0) return undefined;
  return { workspaceId: value.workspaceId, projectId: value.projectId as number };
}

/** One node of a persisted DAG. Rejects rather than coerces: a malformed node means the snapshot came
 *  from something other than the engine, and guessing its intent would put fiction on the user's screen. */
function normalizeWorkflowNode(raw: unknown): WorkflowNode | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || o.id.length > MAX_WORKFLOW_ID_CHARS) return undefined;
  if (typeof o.task !== 'string') return undefined;
  if (o.status !== 'pending' && o.status !== 'running' && o.status !== 'done' && o.status !== 'error') return undefined;
  if (!Array.isArray(o.deps) || o.deps.length > MAX_WORKFLOW_NODES) return undefined;
  if (!o.deps.every((d): d is string => typeof d === 'string' && !!d && d.length <= MAX_WORKFLOW_ID_CHARS)) return undefined;
  if (o.sessionId !== undefined && (typeof o.sessionId !== 'string' || !o.sessionId || o.sessionId.length > 512)) return undefined;
  if (o.detail !== undefined && typeof o.detail !== 'string') return undefined;
  if (o.model !== undefined && typeof o.model !== 'string') return undefined;
  if (o.tokens !== undefined && (typeof o.tokens !== 'number' || !Number.isSafeInteger(o.tokens) || o.tokens < 0)) return undefined;
  if (o.seconds !== undefined && (typeof o.seconds !== 'number' || !Number.isSafeInteger(o.seconds) || o.seconds < 0)) return undefined;
  if (o.startedAt !== undefined && (typeof o.startedAt !== 'number' || !Number.isSafeInteger(o.startedAt) || o.startedAt < 0)) return undefined;
  if (o.result !== undefined && typeof o.result !== 'string') return undefined;
  if (o.error !== undefined && typeof o.error !== 'string') return undefined;
  const workspaceRef = o.workspaceRef === undefined ? undefined : normalizeWorkflowWorkspaceRef(o.workspaceRef);
  if (o.workspaceRef !== undefined && !workspaceRef) return undefined;
  return {
    id: o.id,
    task: bounded(o.task, MAX_WORKFLOW_TASK_CHARS),
    status: o.status,
    deps: o.deps,
    ...(typeof o.sessionId === 'string' ? { sessionId: o.sessionId } : {}),
    ...(typeof o.detail === 'string' ? { detail: bounded(o.detail, MAX_WORKFLOW_DETAIL_CHARS) } : {}),
    ...(typeof o.tokens === 'number' ? { tokens: o.tokens } : {}),
    ...(typeof o.seconds === 'number' ? { seconds: o.seconds } : {}),
    ...(typeof o.model === 'string' ? { model: bounded(o.model, 512) } : {}),
    ...(typeof o.startedAt === 'number' ? { startedAt: o.startedAt } : {}),
    ...(typeof o.result === 'string' ? { result: bounded(o.result, MAX_WORKFLOW_RESULT_CHARS) } : {}),
    ...(typeof o.error === 'string' ? { error: bounded(o.error, MAX_WORKFLOW_RESULT_CHARS) } : {}),
    ...(workspaceRef ? { workspaceRef } : {}),
  };
}

/** Runtime validation for an engine-produced or DB-loaded workflow snapshot. Same reject-don't-coerce
 *  contract as normalizeSubagentState, plus the DAG's own rule that node ids are unique — a duplicate
 *  would make the modal's per-node keying ambiguous. */
function normalizeWorkflowState(raw: unknown): BrainWorkflowRun | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || o.id.length > 512) return undefined;
  if (typeof o.toolCallId !== 'string' || !o.toolCallId || o.toolCallId.length > 512) return undefined;
  if (o.status !== 'running' && o.status !== 'done' && o.status !== 'error' && o.status !== 'cancelled') return undefined;
  if (o.title !== undefined && typeof o.title !== 'string') return undefined;
  if (o.background !== undefined && typeof o.background !== 'boolean') return undefined;
  const workspaceRef = o.workspaceRef === undefined ? undefined : normalizeWorkflowWorkspaceRef(o.workspaceRef);
  if (o.workspaceRef !== undefined && !workspaceRef) return undefined;
  if (!Array.isArray(o.nodes) || o.nodes.length > MAX_WORKFLOW_NODES) return undefined;
  const nodes: WorkflowNode[] = [];
  const seen = new Set<string>();
  for (const raw of o.nodes) {
    const node = normalizeWorkflowNode(raw);
    if (!node || seen.has(node.id)) return undefined;
    seen.add(node.id);
    nodes.push(node);
  }
  return {
    id: o.id,
    toolCallId: o.toolCallId,
    ...(typeof o.title === 'string' ? { title: bounded(o.title, 200) } : {}),
    status: o.status,
    // Load-bearing, not display trivia: BrainService.sparedChildSessionIds reads it to spare a background
    // workflow's node sessions from a parent abort, exactly as it spares a detached delegate's child.
    // Dropping it here silently turned that sparing into dead code, so any stop/detach on the origin
    // conversation killed every node of a running background workflow.
    ...(o.background === true ? { background: true } : {}),
    ...(workspaceRef ? { workspaceRef } : {}),
    nodes,
  };
}

/** Runtime validation for plugin-produced progress and DB JSON. Reject malformed numeric/status fields
 *  rather than letting NaN, negative counters, or arbitrary objects reach every connected renderer. */
function normalizeSubagentState(raw: unknown): BrainSubagentRunState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.status !== 'running' && o.status !== 'done' && o.status !== 'error') return undefined;
  if (typeof o.task !== 'string') return undefined;
  if (typeof o.tools !== 'number' || !Number.isSafeInteger(o.tools) || o.tools < 0) return undefined;
  if (typeof o.seconds !== 'number' || !Number.isSafeInteger(o.seconds) || o.seconds < 0) return undefined;
  if (o.tokens !== undefined && (typeof o.tokens !== 'number' || !Number.isSafeInteger(o.tokens) || o.tokens < 0)) return undefined;
  if (o.detail !== undefined && typeof o.detail !== 'string') return undefined;
  if (o.model !== undefined && typeof o.model !== 'string') return undefined;
  if (o.thinkingLevel !== undefined && typeof o.thinkingLevel !== 'string') return undefined;
  if (o.thinkingLabel !== undefined && typeof o.thinkingLabel !== 'string') return undefined;
  if (o.background !== undefined && typeof o.background !== 'boolean') return undefined;
  if (o.autoDeliver !== undefined && typeof o.autoDeliver !== 'boolean') return undefined;
  if (o.resultDelivery !== undefined && o.resultDelivery !== 'pending' && o.resultDelivery !== 'acknowledged') return undefined;
  if (o.workspaceId !== undefined && typeof o.workspaceId !== 'string') return undefined;
  return {
    status: o.status,
    task: bounded(o.task, 8_000),
    ...(typeof o.detail === 'string' ? { detail: bounded(o.detail, 2_000) } : {}),
    tools: o.tools,
    ...(typeof o.tokens === 'number' ? { tokens: o.tokens } : {}),
    seconds: o.seconds,
    ...(typeof o.model === 'string' ? { model: bounded(o.model, 512) } : {}),
    ...(typeof o.thinkingLevel === 'string' ? { thinkingLevel: bounded(o.thinkingLevel, 64) } : {}),
    ...(typeof o.thinkingLabel === 'string' ? { thinkingLabel: bounded(o.thinkingLabel, 64) } : {}),
    ...(typeof o.background === 'boolean' ? { background: o.background } : {}),
    ...(typeof o.autoDeliver === 'boolean' ? { autoDeliver: o.autoDeliver } : {}),
    ...(o.resultDelivery === 'pending' || o.resultDelivery === 'acknowledged' ? { resultDelivery: o.resultDelivery } : {}),
    ...(typeof o.workspaceId === 'string' ? { workspaceId: bounded(o.workspaceId, 256) } : {}),
  };
}

function normalizeSubagentResult(raw: unknown): Omit<BrainSubagentResult, 'parentSessionId' | 'delivery' | 'attempts' | 'kind' | 'workflowId' | 'requiresUserAction'> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || o.id.length > 512) return undefined;
  if (typeof o.toolCallId !== 'string' || !o.toolCallId || o.toolCallId.length > 512) return undefined;
  if (typeof o.sessionId !== 'string' || (o.sessionId.length === 0 && o.status !== 'error')) return undefined;
  if (o.status !== 'done' && o.status !== 'error') return undefined;
  if (typeof o.task !== 'string') return undefined;
  if (typeof o.tools !== 'number' || !Number.isSafeInteger(o.tools) || o.tools < 0) return undefined;
  if (typeof o.seconds !== 'number' || !Number.isSafeInteger(o.seconds) || o.seconds < 0) return undefined;
  if (o.tokens !== undefined && (typeof o.tokens !== 'number' || !Number.isSafeInteger(o.tokens) || o.tokens < 0)) return undefined;
  if (o.result !== undefined && typeof o.result !== 'string') return undefined;
  if (o.error !== undefined && typeof o.error !== 'string') return undefined;
  if (o.model !== undefined && typeof o.model !== 'string') return undefined;
  return {
    id: o.id, toolCallId: o.toolCallId, sessionId: o.sessionId, status: o.status,
    task: bounded(o.task, 8_000),
    ...(typeof o.result === 'string' ? { result: boundedTail(o.result, 100_000) } : {}),
    ...(typeof o.error === 'string' ? { error: bounded(o.error, 100_000) } : {}),
    tools: o.tools, ...(typeof o.tokens === 'number' ? { tokens: o.tokens } : {}), seconds: o.seconds,
    ...(typeof o.model === 'string' ? { model: bounded(o.model, 512) } : {}),
  };
}

/** The terminal payload the workflow engine emits for a detached/background workflow. Mirrors the
 *  sub-agent completion, but the whole DAG summary is one body and its link is the workflow's origin
 *  call, not a child session. `cancelled` collapses to 'error' for the queue's binary status column;
 *  the summary body still names the true engine status. */
function normalizeWorkflowCompletion(
  raw: unknown,
): { id: string; toolCallId: string; status: 'done' | 'error'; task: string; result: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || o.id.length > 512) return undefined;
  if (typeof o.toolCallId !== 'string' || !o.toolCallId || o.toolCallId.length > 512) return undefined;
  if (o.status !== 'done' && o.status !== 'error' && o.status !== 'cancelled') return undefined;
  if (typeof o.result !== 'string') return undefined;
  const title = typeof o.title === 'string' && o.title ? o.title : o.id;
  return {
    id: o.id,
    toolCallId: o.toolCallId,
    status: o.status === 'done' ? 'done' : 'error',
    task: bounded(title, 8_000),
    // A DAG summary is every node's result end to end, so it is the one payload here that really can exceed
    // the ceiling — and cutting its head costs the FIRST nodes, not the last ones the parent was waiting for.
    result: boundedTail(o.result, 100_000),
  };
}

/** Persistence for the delegated-execution slice of the embedded brain: sub-agent runs (live progress),
 *  sub-agent results (the terminal payload delivered back to a parent turn), and workflow-run DAG
 *  snapshots. Extracted from {@link BrainStore} (which delegates to it) — it shares only the {@link Db}
 *  handle. Same reject-don't-coerce validation and durable-relation revalidation as before the split. */
export class BrainDelegationStore {
  constructor(private db: Db) {}

  /** This daemon boot's identity, stamped onto every `running` row so a LATER boot can tell a restart
   *  orphan (owner_boot_id != current) from its own live work, and accept a completion only for the boot
   *  that owns the run. Empty until the daemon calls setBootId at start; a store used without it (most
   *  unit tests) simply writes an empty owner_boot_id, which boot recovery never claims. */
  private bootId = '';
  setBootId(bootId: string): void { this.bootId = bootId; }
  /** The current boot id — read by boot recovery so the claim + completion use one authoritative value. */
  currentBootId(): string { return this.bootId; }

  /** Persist the newest progress snapshot for one delegate tool call. This is deliberately synchronous:
   *  a background child may finish after the parent turn has already settled, and the live event must
   *  never race ahead of the durable state a reconnect reads. Both sessions must exist, have the same
   *  owner, and be a DIRECT parent/child pair; a plugin cannot smuggle a foreign transcript id into the
   *  parent's drill-in UI. A tool-call id is permanently bound to its first child. */
  upsertSubagentRun(
    parentSessionId: string,
    raw: unknown,
    durableStatus?: BrainSubagentRunState['status'],
  ): boolean {
    if (!parentSessionId || !raw || typeof raw !== 'object') return false;
    const update = raw as Record<string, unknown>;
    if (typeof update.id !== 'string' || !update.id || update.id.length > 512) return false;
    if (typeof update.sessionId !== 'string' || !update.sessionId) return false;
    const state = normalizeSubagentState(update);
    if (!state) return false;
    if (durableStatus !== undefined && durableStatus !== 'running' && durableStatus !== 'done' && durableStatus !== 'error') return false;
    return withWriteLock(this.db, () => {
      const relation = this.db.prepare(
        `SELECT p.user_id AS parent_user, c.user_id AS child_user, c.parent_session_id AS linked_parent
           FROM brain_sessions p JOIN brain_sessions c ON c.id = ?
          WHERE p.id = ?`
      ).get(update.sessionId, parentSessionId) as { parent_user: number; child_user: number; linked_parent: string | null } | undefined;
      if (!relation || relation.parent_user !== relation.child_user || relation.linked_parent !== parentSessionId) return false;
      const prior = this.db.prepare(
        'SELECT child_session_id FROM brain_subagent_runs WHERE parent_session_id = ? AND tool_call_id = ?'
      ).get(parentSessionId, update.id) as { child_session_id: string } | undefined;
      if (prior && prior.child_session_id !== update.sessionId) return false;
      // The JSON status is the DISPLAY projection, while lifecycle is the recovery authority. Usually they
      // match. A DelegateContinue that finishes after steering into an older still-running child is the one
      // exception: the UI deliberately keeps that row visibly running until the child's actual call claim
      // ends, but the continuation tool call itself is already terminal and must never be restart-recovered.
      // Stamp THIS boot only on genuinely running lifecycle rows; terminal rows retain their prior owner as
      // audit context and are excluded from recovery regardless of the visible JSON status.
      const lifecycle = durableStatus ?? state.status;
      const ownerBootId = lifecycle === 'running' ? this.bootId : null;
      this.db.prepare(
        `INSERT INTO brain_subagent_runs (parent_session_id, tool_call_id, child_session_id, state, lifecycle, owner_boot_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(parent_session_id, tool_call_id) DO UPDATE SET
           state = excluded.state, lifecycle = excluded.lifecycle,
           owner_boot_id = CASE WHEN excluded.lifecycle = 'running'
                                THEN excluded.owner_boot_id ELSE brain_subagent_runs.owner_boot_id END,
           updated_at = datetime('now')`
      ).run(parentSessionId, update.id, update.sessionId, JSON.stringify(state), lifecycle, ownerBootId);
      return true;
    });
  }

  /** Read only still-valid direct same-owner relations. Malformed legacy/corrupted JSON is ignored at
   *  this boundary, so all downstream wire shapes remain trusted and finite. */
  getSubagentRuns(parentSessionId: string): BrainSubagentRun[] {
    const rows = this.db.prepare(
      `SELECT r.tool_call_id, r.child_session_id, r.state, c.created_at AS started_at,
              r.updated_at, x.delivery_state, r.rowid AS rowid
         FROM brain_subagent_runs r
         JOIN brain_sessions p ON p.id = r.parent_session_id
         JOIN brain_sessions c ON c.id = r.child_session_id
         LEFT JOIN brain_subagent_results x
           ON x.parent_session_id = r.parent_session_id AND x.tool_call_id = r.tool_call_id
        WHERE r.parent_session_id = ?
          AND c.parent_session_id = p.id
          AND c.user_id = p.user_id
        ORDER BY r.updated_at ASC, r.rowid ASC`
    ).all(parentSessionId) as {
      tool_call_id: string; child_session_id: string; state: string;
      rowid: number;
      started_at: string; updated_at: string; delivery_state: string | null;
    }[];
    const out: BrainSubagentRun[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.state); } catch { continue; }
      const state = normalizeSubagentState(parsed);
      if (state) out.push({
        toolCallId: row.tool_call_id, sessionId: row.child_session_id, ...state,
        startedAt: row.started_at, updatedAt: row.updated_at, rowid: row.rowid,
        ...(row.delivery_state === 'pending' || row.delivery_state === 'acknowledged'
          ? { resultDelivery: row.delivery_state } : {}),
      });
    }
    return out;
  }

  /** Workflow ids THIS boot owns: rows it claimed for resume at boot, and rows the engine stamped with this
   *  boot while running. A read-model liveness source, the workflow twin of recoveringSubagentSessionIds:
   *  in the window between the HTTP boot and the engine's resume (the plugin registry is still loading,
   *  the liveness probe answers "unknown") such a row is being recovered, not dead, and must not be
   *  terminalized for display. A previous boot's row stays out: nothing of this process holds it. */
  recoveringWorkflowIds(parentSessionId: string): string[] {
    const cur = this.bootId;
    if (!cur) return [];
    return (this.db.prepare(
      `SELECT workflow_id FROM brain_workflows
        WHERE parent_session_id = ? AND owner_boot_id = ?
          AND json_valid(state) AND json_extract(state, '$.status') = 'running'`
    ).all(parentSessionId, cur) as { workflow_id: string }[]).map((row) => row.workflow_id);
  }

  /** Child sessions THIS boot still durably owns during restart recovery. This is a read-model liveness
   *  source: all rows are claimed before serial recovery starts, so later queued rows may outlive the initial
   *  lease while still owned by this process. A previous boot stays hidden because it has no worker. Keep the
   *  same parent/child owner validation as getSubagentRuns so status shaping cannot widen tenancy. */
  recoveringSubagentSessionIds(parentSessionId: string): string[] {
    const cur = this.bootId;
    if (!cur) return [];
    return (this.db.prepare(
      `SELECT r.child_session_id
         FROM brain_subagent_runs r
         JOIN brain_sessions p ON p.id = r.parent_session_id
         JOIN brain_sessions c ON c.id = r.child_session_id
        WHERE r.parent_session_id = ?
          AND r.lifecycle = 'recovering'
          AND r.owner_boot_id = ?
          AND c.parent_session_id = p.id
          AND c.user_id = p.user_id
        ORDER BY r.updated_at ASC, r.rowid ASC`
    ).all(parentSessionId, cur) as { child_session_id: string }[]).map((row) => row.child_session_id);
  }

  /** Child sessions of one conversation with a delegated call STILL OPEN on them — a run row whose
   *  lifecycle is `running` or `recovering`, whichever boot or process owns it. This is THE durable
   *  answer to "which of this conversation's sub-agents are running", shared by the transcript read model
   *  (BrainStatusService.subagentRuns), the DelegateList listing (listDelegatedChildren's `active_run`)
   *  and the settlement of a delegated call whose child delegated further (BrainService.settleDelegatedReply)
   *  — so the rail, the web card, the tool and the parent's blocking call cannot disagree about a child.
   *  Lifecycle, not the JSON display status: a steered DelegateContinue leaves its own row visibly
   *  `running` under a terminal lifecycle on purpose. ANY live row counts, not only the newest: the same
   *  steered continuation is the newest row of a child whose original call still runs. A previous boot's
   *  live rows are claimed (`recovering`) before any client attaches, so no filter on the owner is needed —
   *  and none may be added: a row this boot is recovering in another process (the sub-agent runner stamps
   *  its own boot id) is as live as one it runs itself. Same parent/child owner validation as
   *  getSubagentRuns, so no reader can widen tenancy through it. */
  activeDelegationChildIds(parentSessionId: string): string[] {
    if (!parentSessionId) return [];
    return (this.db.prepare(
      `SELECT DISTINCT r.child_session_id
         FROM brain_subagent_runs r
         JOIN brain_sessions p ON p.id = r.parent_session_id
         JOIN brain_sessions c ON c.id = r.child_session_id
        WHERE r.parent_session_id = ?
          AND r.lifecycle IN ('running', 'recovering')
          AND c.parent_session_id = p.id
          AND c.user_id = p.user_id`
    ).all(parentSessionId) as { child_session_id: string }[]).map((row) => row.child_session_id);
  }

  /** The delegated sub-agents ONE conversation spawned, newest first — the parent's own record of what
   *  it already ran, and the only way it may address a child for a continuation.
   *
   *  Scoped by the durable relation alone: a row is returned only when it names THIS parent and still
   *  shares its owner. That is the security boundary — the caller passes no user id and cannot widen the
   *  query, so a conversation can never see (or reach) a sibling conversation's or another account's
   *  children. Ownership is re-derived on every read rather than trusted from the row, so a child that
   *  changed hands stops being listable immediately.
   *
   *  Unlike getSubagentRuns this starts from brain_sessions and only ENRICHES from brain_subagent_runs:
   *  a workflow node is a real continuable child even though the engine records the DAG instead of a
   *  per-child run row. Non-sub-agent nested sessions (a bound channel) are filtered out — they are not
   *  delegated children and have no immutable scope to resume under. */
  /** Every workflow node of one conversation, keyed by the child session it ran in. The engine records a
   *  whole-DAG snapshot instead of a per-child run row, so this is where a node's task and status live —
   *  and the only way `listDelegatedChildren` can describe one rather than calling it unknown. */
  private workflowNodesBySession(parentSessionId: string): Map<string, { task: string; status: 'running' | 'done' | 'error' }> {
    const out = new Map<string, { task: string; status: 'running' | 'done' | 'error' }>();
    const rows = this.db.prepare(
      'SELECT state FROM brain_workflows WHERE parent_session_id = ?'
    ).all(parentSessionId) as { state: string }[];
    for (const row of rows) {
      let parsed: unknown;
      // A malformed snapshot costs the enrichment, never the listing: the child is still continuable.
      try { parsed = JSON.parse(row.state); } catch { continue; }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const nodes = (parsed as { nodes?: unknown }).nodes;
      if (!Array.isArray(nodes)) continue;
      for (const raw of nodes) {
        if (typeof raw !== 'object' || raw === null) continue;
        const n = raw as { sessionId?: unknown; task?: unknown; status?: unknown };
        if (typeof n.sessionId !== 'string' || !n.sessionId) continue;
        const status = n.status === 'running' || n.status === 'done' || n.status === 'error' ? n.status : undefined;
        if (!status) continue;
        out.set(n.sessionId, { task: typeof n.task === 'string' ? n.task : '', status });
      }
    }
    return out;
  }

  listDelegatedChildren(parentSessionId: string, limit = MAX_DELEGATED_CHILDREN): DelegatedChildSummary[] {
    if (!parentSessionId) return [];
    const capped = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_DELEGATED_CHILDREN) : MAX_DELEGATED_CHILDREN;
    const rows = this.db.prepare(
      `SELECT c.id, c.title, c.created_at, c.updated_at, c.model, c.provider,
              r.state, r.lifecycle, r.updated_at AS run_updated_at,
              EXISTS(
                SELECT 1 FROM brain_subagent_runs active
                 WHERE active.parent_session_id = c.parent_session_id
                   AND active.child_session_id = c.id
                   AND active.lifecycle IN ('running', 'recovering')
              ) AS active_run,
              (SELECT COUNT(*) FROM brain_messages m WHERE m.session_id = c.id) AS messages
         FROM brain_sessions c
         JOIN brain_sessions p ON p.id = c.parent_session_id
         LEFT JOIN brain_subagent_runs r
           ON r.rowid = (
             SELECT rr.rowid FROM brain_subagent_runs rr
              WHERE rr.parent_session_id = c.parent_session_id AND rr.child_session_id = c.id
              -- One row = one Delegate/DelegateContinue call. Creation order, not a later progress update
              -- on an older call, decides which call is the child's current listing entry.
              ORDER BY rr.rowid DESC LIMIT 1
           )
        WHERE c.parent_session_id = ?
          AND c.user_id = p.user_id
          AND c.id LIKE ?
        ORDER BY c.created_at DESC, c.rowid DESC
        LIMIT ?`
    ).all(parentSessionId, `${SUBAGENT_PREFIX}%`, capped) as {
      id: string; title: string; created_at: string; updated_at: string;
      model: string | null; provider: string | null;
      state: string | null; lifecycle: string | null; run_updated_at: string | null; active_run: number; messages: number;
    }[];
    // Parsed at most once per listing, and only when a row actually needs it: a conversation that never
    // ran a workflow must not pay to parse DAG snapshots, and one that did must not re-parse per row.
    let nodesBySession: Map<string, { task: string; status: 'running' | 'done' | 'error' }> | undefined;
    const workflowNodes = (): Map<string, { task: string; status: 'running' | 'done' | 'error' }> => {
      if (!nodesBySession) nodesBySession = this.workflowNodesBySession(parentSessionId);
      return nodesBySession;
    };
    const out: DelegatedChildSummary[] = [];
    for (const row of rows) {
      // Malformed run JSON degrades to "no run detail" rather than hiding the child: the transcript is
      // still there and still continuable, which is what this listing exists to expose.
      let state: BrainSubagentRunState | undefined;
      if (row.state) {
        try { state = normalizeSubagentState(JSON.parse(row.state)); } catch { state = undefined; }
      }
      // `state.status` is the live UI projection. A steered DelegateContinue terminalizes its OWN durable
      // row while the original call claim keeps that projection visibly `running`; once the process exits
      // there is no later update to rewrite it. The host-owned lifecycle is therefore authoritative for a
      // terminal latest row, while running/recovering rows keep the projection's richer status.
      const lifecycleStatus = row.active_run ? 'running'
        : row.lifecycle === 'done' ? 'done'
          : row.lifecycle === 'error' || row.lifecycle === 'recovery_required' || row.lifecycle === 'legacy_interrupted'
            ? 'error' : undefined;
      // A workflow node has no run row, so its task/status live in the DAG snapshot instead — without
      // this it listed as "unknown" forever, including long after it finished.
      const node = state ? undefined : workflowNodes().get(row.id);
      // The session row is the one place that always knows which model actually ran, and it keeps the
      // provider too. The run state carries a bare model id at best and is absent for workflow nodes,
      // so it is only the fallback now: "kimi-coding/k3" beats "k3" beats nothing.
      const model = qualifiedModel(row.provider, row.model) ?? state?.model;
      out.push({
        sessionId: row.id,
        title: row.title,
        ...(state ? { task: state.task, status: lifecycleStatus ?? state.status } : {}),
        ...(node ? { task: node.task, status: node.status } : {}),
        ...(model ? { model } : {}),
        messages: Number(row.messages) || 0,
        startedAt: row.created_at,
        updatedAt: row.run_updated_at ?? row.updated_at,
      });
    }
    return out;
  }

  /** Persist the newest whole-DAG snapshot for one `WorkflowStart` tool call. Synchronous for the same
   *  reason as upsertSubagentRun: the live event must never race ahead of the durable state a reconnect
   *  reads. The origin session must exist, and a tool call is permanently bound to its first workflow id.
   *
   *  Node child sessions are deliberately NOT validated here. A node's `session` event can outrun its
   *  store row, and rejecting the whole DAG over one not-yet-verifiable node would lose the workflow —
   *  worse, stripping the id at write time would lose the drill-in permanently. getWorkflowRuns re-derives
   *  each node's target from the live relation instead, which is also correct for children deleted later. */
  upsertWorkflowRun(parentSessionId: string, raw: unknown): boolean {
    if (!parentSessionId) return false;
    const state = normalizeWorkflowState(raw);
    if (!state) return false;
    return withWriteLock(this.db, () => {
      const parent = this.db.prepare('SELECT id FROM brain_sessions WHERE id = ?').get(parentSessionId) as { id: string } | undefined;
      if (!parent) return false;
      const prior = this.db.prepare(
        'SELECT workflow_id FROM brain_workflows WHERE parent_session_id = ? AND tool_call_id = ?'
      ).get(parentSessionId, state.toolCallId) as { workflow_id: string } | undefined;
      if (prior && prior.workflow_id !== state.id) return false;
      // owner_boot_id mirrors the sub-agent run claim: a running snapshot is stamped with THIS boot so a
      // later boot can tell an orphan (owner dead) from live work; a terminal snapshot clears it so the
      // row is never claimable again. attempt is untouched here — only the boot reconcile bumps it.
      const ownerBootId = state.status === 'running' ? (this.bootId || null) : null;
      this.db.prepare(
        `INSERT INTO brain_workflows (parent_session_id, tool_call_id, workflow_id, state, owner_boot_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(parent_session_id, tool_call_id) DO UPDATE SET
           state = excluded.state, owner_boot_id = excluded.owner_boot_id, updated_at = datetime('now')`
      ).run(parentSessionId, state.toolCallId, state.id, JSON.stringify(state), ownerBootId);
      return true;
    });
  }

  /** Read the durable DAGs of one conversation, with each node's drill-in target re-derived from the
   *  LIVE parent/child relation: a node whose session is gone, foreign-owned, or not a direct child of
   *  this conversation keeps its row but loses `sessionId`, so a stored id can never point the drill-in
   *  UI at a transcript this conversation does not own.
   *
   *  Note the deliberate difference from getSubagentRuns, which JOINs the child and so hides the whole
   *  run when it disappears: a workflow must not vanish because ONE of its nodes did. Per-node
   *  degradation is the right granularity — the DAG is still the record of what ran. */
  getWorkflowRuns(parentSessionId: string): BrainWorkflowRun[] {
    const rows = this.db.prepare(
      `SELECT w.state FROM brain_workflows w
         JOIN brain_sessions p ON p.id = w.parent_session_id
        WHERE w.parent_session_id = ?
        ORDER BY w.updated_at ASC, w.rowid ASC`
    ).all(parentSessionId) as { state: string }[];
    if (rows.length === 0) return [];
    const children = new Set((this.db.prepare(
      `SELECT c.id FROM brain_sessions c JOIN brain_sessions p ON p.id = c.parent_session_id
        WHERE c.parent_session_id = ? AND c.user_id = p.user_id`
    ).all(parentSessionId) as { id: string }[]).map((r) => r.id));
    const out: BrainWorkflowRun[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.state); } catch { continue; }
      const state = normalizeWorkflowState(parsed);
      if (!state) continue;
      out.push({
        ...state,
        nodes: state.nodes.map(({ sessionId, ...node }) =>
          (sessionId && children.has(sessionId) ? { ...node, sessionId } : node)),
      });
    }
    return out;
  }

  /** The persisted status of one workflow (the last snapshot's `status`), or undefined when the store has
   *  no row for it. ONE cheap json_extract read — the workflow finish-marker guard needs only the prior
   *  status to fire once on the running→terminal transition, and getWorkflowRuns would cost a whole-DAG
   *  parse per live tick. */
  workflowStatus(parentSessionId: string, workflowId: string): 'running' | 'done' | 'error' | 'cancelled' | undefined {
    if (!parentSessionId || !workflowId) return undefined;
    const row = this.db.prepare(
      `SELECT state FROM brain_workflows WHERE parent_session_id = ? AND workflow_id = ?`
    ).get(parentSessionId, workflowId) as { state: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed: unknown = JSON.parse(row.state);
      const status = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).status : undefined;
      return status === 'running' || status === 'done' || status === 'error' || status === 'cancelled' ? status : undefined;
    } catch { return undefined; }
  }

  /** Whether this delegated conversation still owns a live workflow. A workflow can be running between
   *  node dispatches with ZERO child claims; treating that gap as idle terminalized its outer Delegate. */
  hasRunningWorkflow(parentSessionId: string): boolean {
    return this.runningWorkflowIds(parentSessionId, 1).length > 0;
  }

  runningWorkflowIds(parentSessionId: string, limit = 64): string[] {
    if (!parentSessionId) return [];
    const capped = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 64) : 64;
    return (this.db.prepare(
      `SELECT workflow_id FROM brain_workflows
        WHERE parent_session_id = ? AND json_valid(state) AND json_extract(state, '$.status') = 'running'
        ORDER BY updated_at DESC, rowid DESC LIMIT ?`
    ).all(parentSessionId, capped) as { workflow_id: string }[]).map((row) => row.workflow_id);
  }

  /** Persist a terminal child result before any attempt to wake the parent. Stable result/tool ids make
   * duplicate plugin callbacks idempotent; the durable direct-child relation is revalidated here. */
  enqueueSubagentResult(parentSessionId: string, raw: unknown): boolean {
    const result = normalizeSubagentResult(raw);
    if (!parentSessionId || !result) return false;
    return withWriteLock(this.db, () => this.enqueueResultRowLocked(parentSessionId, result));
  }

  /** The INSERT half of {@link enqueueSubagentResult}, WITHOUT its own write lock, so the recovery path
   *  can enqueue the result in the SAME transaction that terminalizes the run (see completeRecoveredRun).
   *  withWriteLock uses an IMMEDIATE transaction; nesting one would demote it to a savepoint and lose the
   *  fencing, so this shared seam takes no lock and the two public callers each own theirs. */
  private enqueueResultRowLocked(
    parentSessionId: string,
    result: NonNullable<ReturnType<typeof normalizeSubagentResult>>,
    requiresUserAction = false,
  ): boolean {
    const linked = result.sessionId ? this.db.prepare(
      `SELECT 1 FROM brain_subagent_runs r
        JOIN brain_sessions p ON p.id = r.parent_session_id
        JOIN brain_sessions c ON c.id = r.child_session_id
       WHERE r.parent_session_id = ? AND r.tool_call_id = ? AND r.child_session_id = ?
         AND c.parent_session_id = p.id AND c.user_id = p.user_id`
    ).get(parentSessionId, result.toolCallId, result.sessionId) : this.db.prepare(
      'SELECT 1 FROM brain_sessions WHERE id = ?'
    ).get(parentSessionId);
    if (!linked || (!result.sessionId && result.status !== 'error')) return false;
    const payload = JSON.stringify({
      result: result.result, error: result.error, tools: result.tools, tokens: result.tokens,
      seconds: result.seconds, model: result.model,
      ...(requiresUserAction ? { requiresUserAction: true } : {}),
    });
    // Handle BOTH unique constraints (result_id PK + parent/tool_call) so a late or duplicate callback can
    // never throw and silently drop a result. A real completion arriving for a (parent, tool_call) that a
    // restart reconcile already filled with a SYNTHETIC `restart-` row UPGRADES it in place, keeping its
    // queue position (created_at untouched). That holds even once the synthetic was delivered: the parent
    // was told the delegate had been interrupted, so the truth has to reach it — the row goes back to
    // pending and is delivered again. A synthetic never overwrites a real row, and a real row is never
    // clobbered by a second distinct real result (first-write-wins).
    this.db.prepare(
      `INSERT INTO brain_subagent_results
        (result_id, parent_session_id, tool_call_id, child_session_id, status, task, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(result_id) DO NOTHING
       ON CONFLICT(parent_session_id, tool_call_id) DO UPDATE SET
         result_id = excluded.result_id, child_session_id = excluded.child_session_id,
         status = excluded.status, task = excluded.task, payload = excluded.payload,
         attempts = 0, wake_attempts = 0, delivery_state = 'pending'
       WHERE brain_subagent_results.result_id LIKE '${SYNTHETIC_RESTART_RESULT_PREFIX}%'
         AND excluded.result_id NOT LIKE '${SYNTHETIC_RESTART_RESULT_PREFIX}%'`
    ).run(result.id, parentSessionId, result.toolCallId, result.sessionId, result.status, result.task, payload);
    const row = this.db.prepare(
      `SELECT parent_session_id, tool_call_id, child_session_id FROM brain_subagent_results WHERE result_id = ?`
    ).get(result.id) as { parent_session_id: string; tool_call_id: string; child_session_id: string } | undefined;
    return row?.parent_session_id === parentSessionId && row.tool_call_id === result.toolCallId && row.child_session_id === result.sessionId;
  }

  /** Persist a terminal WORKFLOW result before waking the parent. Same durable queue as a sub-agent
   *  completion (one place for retry/backoff/drain/ack), but the linkage is kind-aware: the row is
   *  accepted only against an existing brain_workflows DAG for this exact (parent_session_id,
   *  tool_call_id). A workflow leaves child_session_id empty and carries its id in workflow_id.
   *  First-write-wins and idempotent on a duplicate emit; workflows never take part in the synthetic
   *  restart upgrade (a daemon restart drops the in-memory engine, so there is nothing to reconcile). */
  enqueueWorkflowResult(parentSessionId: string, raw: unknown): boolean {
    const result = normalizeWorkflowCompletion(raw);
    if (!parentSessionId || !result) return false;
    return withWriteLock(this.db, () => {
      // The workflow id is part of the linkage, not just the (parent, tool_call) pair: without it a
      // completion naming a DIFFERENT workflow is accepted and filed under this row, so the parent is
      // woken with a summary that belongs to another DAG. upsertWorkflowRun already refuses to let a
      // second workflow id take over a tool call, so the stored id is the authoritative one.
      const linked = this.db.prepare(
        'SELECT 1 FROM brain_workflows WHERE parent_session_id = ? AND tool_call_id = ? AND workflow_id = ?'
      ).get(parentSessionId, result.toolCallId, result.id);
      if (!linked) return false;
      const payload = JSON.stringify({ result: result.result });
      this.db.prepare(
        `INSERT INTO brain_subagent_results
          (result_id, parent_session_id, tool_call_id, child_session_id, kind, workflow_id, status, task, payload)
         VALUES (?, ?, ?, '', 'workflow', ?, ?, ?, ?)
         ON CONFLICT(result_id) DO NOTHING
         ON CONFLICT(parent_session_id, tool_call_id) DO NOTHING`
      ).run(result.id, parentSessionId, result.toolCallId, result.id, result.status, result.task, payload);
      const row = this.db.prepare(
        'SELECT parent_session_id, tool_call_id FROM brain_subagent_results WHERE result_id = ?'
      ).get(result.id) as { parent_session_id: string; tool_call_id: string } | undefined;
      return row?.parent_session_id === parentSessionId && row.tool_call_id === result.toolCallId;
    });
  }

  /** How many delegated results are still waiting to reach a parent turn, across every conversation.
   *
   *  Read by the daemon's shutdown drain. A finished sub-agent is NOT finished work: its answer only
   *  counts once a parent turn has taken it, and exiting in that window is what left a completed
   *  delegation undelivered — the child had already stopped running, so no other signal showed it. */
  countPendingDeliveries(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM brain_subagent_results WHERE delivery_state = 'pending'"
    ).get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Parent conversations with durable delivery work, independent of whether each payload is usable.
   *
   *  Boot recovery needs the raw queue as its wake source: parsing through pendingSubagentResults would
   *  hide a malformed row and falsely report that the parent had no work. The delivery drain still owns
   *  validation and the diagnostic for such a row. */
  pendingDeliveryParentSessionIds(): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT parent_session_id FROM brain_subagent_results
        WHERE delivery_state = 'pending' ORDER BY parent_session_id`
    ).all() as { parent_session_id: string }[];
    return rows.map((row) => row.parent_session_id);
  }

  /** Raw queue presence for one parent. Unlike pendingSubagentResults, malformed payloads still count. */
  hasPendingDelivery(parentSessionId: string): boolean {
    return this.db.prepare(
      `SELECT 1 FROM brain_subagent_results
        WHERE parent_session_id = ? AND delivery_state = 'pending' LIMIT 1`
    ).get(parentSessionId) !== undefined;
  }

  pendingDeliveryWakeAttempts(parentSessionId: string): number {
    const row = this.db.prepare(
      `SELECT MAX(wake_attempts) AS attempts FROM brain_subagent_results
        WHERE parent_session_id = ? AND delivery_state = 'pending'`
    ).get(parentSessionId) as { attempts: number | null } | undefined;
    return row?.attempts ?? 0;
  }

  notePendingDeliveryWakeFailure(parentSessionId: string): number {
    this.db.prepare(
      `UPDATE brain_subagent_results SET wake_attempts = wake_attempts + 1
        WHERE parent_session_id = ? AND delivery_state = 'pending'`
    ).run(parentSessionId);
    return this.pendingDeliveryWakeAttempts(parentSessionId);
  }

  abandonPendingDeliveries(parentSessionId: string): number {
    return this.db.prepare(
      `UPDATE brain_subagent_results SET delivery_state = 'acknowledged'
        WHERE parent_session_id = ? AND delivery_state = 'pending'`
    ).run(parentSessionId).changes;
  }

  /** Retire pending results whose parent can never take them, and report how many. Boot-time sweep.
   *
   *  A delegated result is delivered by steering it into the parent, but the row only flips to
   *  `acknowledged` once that message reaches the parent's transcript — which needs another TURN. An owner
   *  conversation always gets one eventually, because the user comes back. A SUB-AGENT does not: once its
   *  own run is terminal it is never prompted again, so a result addressed to it waits forever.
   *
   *  That is not theoretical. One such row from 18 Aug — a synthetic restart result for a sub-agent that
   *  had already finished — was counted by {@link countPendingDeliveries}, which the shutdown drain waits
   *  on globally, so EVERY restart afterwards burned the full ten-minute budget on a single dead row.
   *
   *  Only terminal parents qualify. `recovering` and `recovery_required` are left alone: those runs are
   *  claimed for respawn and will get a turn. Owner conversations have no run row at all and are never
   *  touched. The row is marked, not deleted, so the answer stays readable in the delegation history.
   *
   *  Retired as `acknowledged` because that is the only non-pending state the column allows, and the column
   *  drives the QUEUE rather than an audit trail: it answers "is anyone still waiting for this", and after
   *  this sweep nobody is. Widening the CHECK to carry a third state would mean rebuilding the table for a
   *  distinction only this comment needs. */
  discardOrphanedDeliveries(): number {
    return withWriteLock(this.db, () => {
      const info = this.db.prepare(
        `UPDATE brain_subagent_results SET delivery_state = 'acknowledged'
          WHERE delivery_state = 'pending'
            AND (
              SELECT json_extract(r.state, '$.status') FROM brain_subagent_runs r
               WHERE r.child_session_id = brain_subagent_results.parent_session_id
               ORDER BY r.updated_at DESC LIMIT 1
            ) IN ('done', 'error', 'cancelled')`
      ).run();
      return info.changes;
    });
  }

  pendingSubagentResults(parentSessionId: string): BrainSubagentResult[] {
    const rows = this.db.prepare(
      `SELECT * FROM brain_subagent_results WHERE delivery_state = 'pending'
       AND parent_session_id = ? ORDER BY created_at, rowid`
    ).all(parentSessionId) as Record<string, unknown>[];
    return rows.flatMap((row): BrainSubagentResult[] => {
      // `null` and bare scalars are valid JSON, so parsing is not enough: reading `payload.result` off a
      // `null` throws and kills the WHOLE drain, leaving every pending result of this parent undelivered
      // over one bad row. Only an object payload is usable; anything else drops just its own row.
      let parsed: unknown;
      try { parsed = JSON.parse(String(row.payload)); } catch { parsed = undefined; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        // The row stays pending but can never be delivered, so without this line the parent simply never
        // hears back and nothing distinguishes that from a child still working. Mirrors the ingress-side
        // "dropped sub-agent result" error in turnRunner: a lost result is never silent.
        logger('brain-store').warn(
          `unusable payload for pending delegated result ${String(row.result_id)} (parent ${parentSessionId}, tool ${String(row.tool_call_id)}) — dropped from the drain`
        );
        return [];
      }
      const payload = parsed as Record<string, unknown>;
      // A workflow row has no child session and a whole-DAG summary body, so it is read directly rather
      // than through the sub-agent validator (which requires a non-empty child sessionId).
      if (row.kind === 'workflow') {
        return [{
          kind: 'workflow' as const, id: String(row.result_id), parentSessionId: String(row.parent_session_id),
          toolCallId: String(row.tool_call_id), sessionId: '',
          ...(typeof row.workflow_id === 'string' ? { workflowId: row.workflow_id } : {}),
          status: row.status === 'done' ? 'done' as const : 'error' as const, task: String(row.task ?? ''),
          ...(typeof payload.result === 'string' ? { result: payload.result } : {}),
          tools: 0, seconds: 0, delivery: 'pending' as const, attempts: Number(row.attempts) || 0,
          requiresUserAction: false,
        }];
      }
      const normalized = normalizeSubagentResult({
        id: row.result_id, toolCallId: row.tool_call_id, sessionId: row.child_session_id,
        status: row.status, task: row.task, ...payload,
      });
      return normalized ? [{
        ...normalized, kind: 'subagent' as const, parentSessionId: String(row.parent_session_id),
        delivery: 'pending' as const, attempts: Number(row.attempts) || 0,
        requiresUserAction: payload.requiresUserAction === true,
      }] : [];
    });
  }

  acknowledgeSubagentResult(parentSessionId: string, resultId: string): boolean {
    return this.db.prepare(
      `UPDATE brain_subagent_results SET delivery_state = 'acknowledged'
       WHERE parent_session_id = ? AND result_id = ? AND delivery_state = 'pending'`
    ).run(parentSessionId, resultId).changes === 1;
  }

  requeueSubagentResult(parentSessionId: string, resultId: string): boolean {
    return this.db.prepare(
      `UPDATE brain_subagent_results SET delivery_state = 'pending'
       WHERE parent_session_id = ? AND result_id = ? AND delivery_state = 'acknowledged'`
    ).run(parentSessionId, resultId).changes === 1;
  }

  noteSubagentResultFailure(parentSessionId: string, resultId: string): void {
    this.db.prepare(
      `UPDATE brain_subagent_results SET attempts = attempts + 1
       WHERE parent_session_id = ? AND result_id = ? AND delivery_state = 'pending'`
    ).run(parentSessionId, resultId);
  }

  /** Atomically CLAIM every restart-orphaned delegation for THIS boot, returning what to recover. Called
   *  exactly once at boot. The compare-and-swap is the whole point: `owner_boot_id != current` is the
   *  whole signal — a `running` OR `recovering` row owned by a PREVIOUS boot is by definition an orphan.
   *  The daemon is a singleton, so the boot that owned it is gone, and that holds just as much for a row
   *  that boot had itself claimed for recovery: its recovery turn died with the process exactly like a
   *  first-run turn does. The lease that used to fence a `recovering` row (meant for a concurrent second
   *  instance, which a singleton never has) is what orphaned four delegations on 5 Sep: two restarts three
   *  minutes apart, and the second boot skipped every row the first had claimed because its five-minute
   *  lease had not lapsed — nothing ever ran them again, while the read model kept showing them running.
   *  `lease_until` is always NULL now; the workflow claim below never had a lease for the same reason.
   *  attempt is bumped so a run that keeps crashing recovery eventually caps out. json_valid guards the
   *  SELECT's later parse and skips a corrupt row (which then stays put — a malformed row is neither
   *  claimable nor renderable, so it is inert rather than dangerous). */
  claimRecoverableRuns(): RecoverableRun[] {
    const cur = this.bootId;
    if (!cur) return []; // no boot identity (unit test store) -> nothing is ours to claim
    return withWriteLock(this.db, () => {
      // Legacy rows written before the durable/display status split can claim a finished tool call as
      // running (most notably a DelegateContinue terminal update masked for UI while its target child was
      // still active). A SETTLED toolResult in the parent transcript is proof that this exact call already
      // returned; recovering it would redo completed work and enqueue a synthetic answer that wakes the
      // parent again. Heal those rows in place before claiming. `pending = 0` is load-bearing: a provisional
      // mid-turn tool result from a crash is not proof that the parent turn completed and still needs normal
      // recovery. This is boot-time, read-derived healing, so existing databases repair themselves without a
      // migration or a one-shot live data write.
      //
      // A synthetic `[interrupted]` result (details.interrupted) is the one settled toolResult that proves
      // the OPPOSITE: the pause wrote it in place of an answer that never came, and it promises the parent
      // the child resumes. Counting it as "this call already returned" healed the run to `error` on the
      // NEXT restart, nobody respawned the child, and the parent sat on a promise with no worker behind it.
      this.db.prepare(
        `UPDATE brain_subagent_runs AS r
            SET lifecycle = CASE WHEN EXISTS (
                  SELECT 1 FROM brain_messages m
                   WHERE m.session_id = r.parent_session_id AND m.pending = 0 AND json_valid(m.content)
                     AND json_extract(m.content, '$.role') = 'toolResult'
                     AND json_extract(m.content, '$.toolCallId') = r.tool_call_id
                     AND COALESCE(json_extract(m.content, '$.details.interrupted'), 0) = 0
                     AND json_extract(m.content, '$.isError') = 1
                ) THEN 'error' ELSE 'done' END,
                state = CASE WHEN json_valid(state) THEN json_set(
                  state, '$.status', CASE WHEN EXISTS (
                    SELECT 1 FROM brain_messages m
                     WHERE m.session_id = r.parent_session_id AND m.pending = 0 AND json_valid(m.content)
                       AND json_extract(m.content, '$.role') = 'toolResult'
                       AND json_extract(m.content, '$.toolCallId') = r.tool_call_id
                       AND COALESCE(json_extract(m.content, '$.details.interrupted'), 0) = 0
                       AND json_extract(m.content, '$.isError') = 1
                  ) THEN 'error' ELSE 'done' END
                ) ELSE state END,
                owner_boot_id = NULL, lease_until = NULL, updated_at = datetime('now')
          WHERE lifecycle IN ('running', 'recovering', 'recovery_required')
            -- Background/detached tools return a settled handle while their child is genuinely still running.
            -- Only a foreground toolResult proves the delegated call itself reached a terminal state.
            AND CASE WHEN json_valid(r.state)
              THEN COALESCE(json_extract(r.state, '$.background'), 0) ELSE 1 END = 0
            AND EXISTS (
              SELECT 1 FROM brain_messages m
               WHERE m.session_id = r.parent_session_id AND m.pending = 0 AND json_valid(m.content)
                 AND json_extract(m.content, '$.role') = 'toolResult'
                 AND json_extract(m.content, '$.toolCallId') = r.tool_call_id
                 AND COALESCE(json_extract(m.content, '$.details.interrupted'), 0) = 0
            )`
      ).run();
      // A recovery claim that a NEWER call on the same child overtook is retired, not recovered again.
      // Production shape (5 Sep): a boot claimed a background Delegate row for recovery, the next boot
      // missed it (the lease bug above), and the parent's DelegateContinue then drove the same child under
      // a new row. Recovering the old claim as well would run the child's continuation a second time and
      // wake the parent with two answers for one piece of work; the newer call is the one every read model
      // reports on (the newest row) and the one whose recovery carries the child's answer. Deliberately
      // ONLY a `recovering` older row: a `running` one is a call that was genuinely open when the process
      // died (a background Delegate beside a later continuation is a legitimate pair — killing it would
      // silently lose the parent's background handle), and `recovery_required` already carries a durable
      // parent notice. Both of those are claimed and recovered on their own terms below.
      this.db.prepare(
        `UPDATE brain_subagent_runs AS r
            SET lifecycle = 'error', owner_boot_id = NULL, lease_until = NULL,
                state = CASE WHEN json_valid(state)
                  THEN json_set(state, '$.status', 'error', '$.detail', 'superseded by a later call on the same sub-agent')
                  ELSE state END,
                updated_at = datetime('now')
          WHERE lifecycle = 'recovering' AND owner_boot_id != ?
            AND EXISTS (
              SELECT 1 FROM brain_subagent_runs newer
               WHERE newer.parent_session_id = r.parent_session_id
                 AND newer.child_session_id = r.child_session_id
                 AND newer.rowid > r.rowid
                 AND newer.lifecycle IN ('running', 'recovering')
            )`
      ).run(cur);
      this.db.prepare(
        `UPDATE brain_subagent_runs
            SET lifecycle = 'recovering', owner_boot_id = ?, attempt = attempt + 1, lease_until = NULL
          WHERE json_valid(state) AND lifecycle IN ('running', 'recovering')
            AND owner_boot_id IS NOT NULL AND owner_boot_id != ?`
      ).run(cur, cur);
      // Every recovering row now owned by this boot is one we just claimed (a fresh boot held none before).
      const rows = this.db.prepare(
        `SELECT parent_session_id, tool_call_id, child_session_id, attempt, state
           FROM brain_subagent_runs WHERE owner_boot_id = ? AND lifecycle = 'recovering'`
      ).all(cur) as { parent_session_id: string; tool_call_id: string; child_session_id: string; attempt: number; state: string }[];
      return rows.flatMap((r) => {
        let raw: unknown;
        try { raw = JSON.parse(r.state); } catch { return []; }
        const state = normalizeSubagentState(raw);
        if (!state) return [];
        return [{
          parentSessionId: r.parent_session_id, toolCallId: r.tool_call_id,
          childSessionId: r.child_session_id, attempt: r.attempt, state,
        }];
      });
    });
  }

  /** Atomically CLAIM every restart-orphaned workflow for THIS boot, returning what to resume. Called
   *  exactly once at boot, mirroring {@link claimRecoverableRuns}: a `running` DAG owned by a previous
   *  boot (or by no boot — a pre-upgrade row) is by definition an orphan, because the in-memory engine
   *  that drove it died with its process. This replaces the old boot sweep that terminalized every such
   *  row as `cancelled` — and unlike that sweep it scans brain_workflows DIRECTLY, so a running workflow
   *  with no nested delegation in flight (which runningDelegationParentSessionIds never surfaced) can no
   *  longer escape reconciliation and sit `running` forever. No lease column: workflows are resumed by
   *  the boot reconcile only, which a singleton daemon runs once, so owner_boot_id alone is the fence. */
  claimRecoverableWorkflows(): RecoverableWorkflow[] {
    const cur = this.bootId;
    if (!cur) return []; // no boot identity (unit test store) -> nothing is ours to claim
    return withWriteLock(this.db, () => {
      // Select-then-claim, atomically under the write lock. Unlike the runs claim there is no lifecycle
      // column to tell "just claimed" from "owned live by this boot" (upsertWorkflowRun stamps the current
      // boot on every running snapshot), so the orphan predicate itself picks the rows and the UPDATE is
      // scoped to exactly those keys.
      const rows = this.db.prepare(
        `SELECT parent_session_id, tool_call_id, workflow_id, attempt, state
           FROM brain_workflows
          WHERE json_valid(state) AND json_extract(state, '$.status') = 'running'
            AND (owner_boot_id IS NULL OR owner_boot_id != ?)`
      ).all(cur) as { parent_session_id: string; tool_call_id: string; workflow_id: string; attempt: number; state: string }[];
      const claim = this.db.prepare(
        'UPDATE brain_workflows SET owner_boot_id = ?, attempt = attempt + 1 WHERE parent_session_id = ? AND tool_call_id = ?'
      );
      return rows.flatMap((r) => {
        let raw: unknown;
        try { raw = JSON.parse(r.state); } catch { return []; }
        const state = normalizeWorkflowState(raw);
        if (!state) return [];
        claim.run(cur, r.parent_session_id, r.tool_call_id);
        return [{
          parentSessionId: r.parent_session_id, toolCallId: r.tool_call_id,
          workflowId: r.workflow_id, attempt: r.attempt + 1, state,
        }];
      });
    });
  }

  /** Zero a workflow's resume-attempt counter once the engine ACTUALLY took it back (resumed: true).
   *  Without this, `attempt` only ever grows — one bump per boot claim — so four perfectly ordinary
   *  deploys under one long-running workflow would hit the resume cap and kill it healthy. Guarded by the
   *  claim: only the boot that owns the row may declare its resume successful. */
  clearWorkflowClaimAttempts(parentSessionId: string, toolCallId: string): void {
    const cur = this.bootId;
    if (!parentSessionId || !toolCallId || !cur) return;
    withWriteLock(this.db, () => this.db.prepare(
      'UPDATE brain_workflows SET attempt = 0 WHERE parent_session_id = ? AND tool_call_id = ? AND owner_boot_id = ?'
    ).run(parentSessionId, toolCallId, cur));
  }

  /** Release a run claim WITHOUT recovering it, terminalizing the row as `error`. Used when boot workflow
   *  resume supersedes the generic recovery of a delegation nested INSIDE a claimed workflow's node: the
   *  resumed node re-issues its Delegate call itself, so respawning the old child would run the same work
   *  twice and wake the node session with a duplicate answer. Deliberately does NOT enqueue a result —
   *  the row's parent is a node session whose interrupted turn is being replaced wholesale. Guarded by
   *  the claim, like every other transition out of `recovering`. */
  supersedeClaimedRun(parentSessionId: string, toolCallId: string, reason: string): boolean {
    const cur = this.bootId;
    if (!parentSessionId || !toolCallId) return false;
    return withWriteLock(this.db, () => this.db.prepare(
      `UPDATE brain_subagent_runs
          SET lifecycle = 'error', owner_boot_id = NULL, lease_until = NULL,
              state = CASE WHEN json_valid(state)
                THEN json_set(state, '$.status', 'error', '$.detail', ?)
                ELSE state END,
              updated_at = datetime('now')
        WHERE parent_session_id = ? AND tool_call_id = ? AND owner_boot_id = ? AND lifecycle = 'recovering'`
    ).run(bounded(reason, 2_000), parentSessionId, toolCallId, cur).changes === 1);
  }

  /** Park a claimed run as `recovery_required`: recovery could not safely replay it (an unanswered
   *  mutating tool call in the discarded suffix), so the parent must decide via DelegateContinue. Only the
   *  boot that holds the claim may do this. The reason is stored for the UI; owner/lease are cleared so the
   *  row is inert (no longer claimable, no auto-delivery). Returns whether a claimed row was updated. */
  /** Park a claimed run that is NOT safe to replay (an unanswered tool call in the crash-discarded tail),
   *  AND — in the SAME transaction — enqueue a `notice` result so the parent actually learns the delegation
   *  was interrupted instead of the run silently sitting `recovery_required` in the DB. Same atomicity
   *  argument as {@link completeRecoveredRun}: a foreground parent's blocking turn did not survive the
   *  restart, so the only way it hears about the outcome is the durable inbox. The row stays
   *  `recovery_required` (not `error`) so the state is auditable and a later DelegateContinue can resume it.
   *  Guarded by the claim: only the boot still holding the `recovering` row may park it. */
  markRecoveryRequired(parentSessionId: string, toolCallId: string, reason: string, raw: unknown): boolean {
    const cur = this.bootId;
    const result = normalizeSubagentResult(raw);
    if (!parentSessionId || !result || result.toolCallId !== toolCallId) return false;
    return withWriteLock(this.db, () => {
      const changed = this.db.prepare(
        `UPDATE brain_subagent_runs
            SET lifecycle = 'recovery_required', owner_boot_id = NULL, lease_until = NULL,
                state = CASE WHEN json_valid(state)
                  THEN json_set(state, '$.status', 'error', '$.detail', ?, '$.recoveryReason', ?)
                  ELSE state END,
                updated_at = datetime('now')
          WHERE parent_session_id = ? AND tool_call_id = ? AND owner_boot_id = ? AND lifecycle = 'recovering'`
      ).run(bounded(reason, 2_000), bounded(reason, 2_000), parentSessionId, toolCallId, cur).changes === 1;
      if (!changed) return false;
      return this.enqueueResultRowLocked(parentSessionId, result, true);
    });
  }

  /** Finish a claimed run in ONE transaction: terminalize the run row AND enqueue its result for the
   *  parent. Atomicity closes the crash-between-the-two gap (a `done` run with no inbox row a parent could
   *  never receive). Guarded by the claim: only the boot whose owner_boot_id still holds a `recovering`
   *  row may complete it, so a completion from a superseded boot is rejected. Enqueues for foreground runs
   *  too — the blocking parent turn did not survive the restart, so its answer has to reach the parent
   *  through the durable inbox like a background one. Returns false if the claim no longer holds. */
  completeRecoveredRun(parentSessionId: string, toolCallId: string, raw: unknown): boolean {
    const cur = this.bootId;
    const result = normalizeSubagentResult(raw);
    if (!parentSessionId || !result || result.toolCallId !== toolCallId) return false;
    return withWriteLock(this.db, () => {
      const run = this.db.prepare(
        'SELECT owner_boot_id, lifecycle FROM brain_subagent_runs WHERE parent_session_id = ? AND tool_call_id = ?'
      ).get(parentSessionId, toolCallId) as { owner_boot_id: string | null; lifecycle: string } | undefined;
      if (!run || run.owner_boot_id !== cur || run.lifecycle !== 'recovering') return false;
      this.db.prepare(
        `UPDATE brain_subagent_runs
            SET lifecycle = ?, owner_boot_id = NULL, lease_until = NULL,
                state = CASE WHEN json_valid(state) THEN json_set(state, '$.status', ?) ELSE state END,
                updated_at = datetime('now')
          WHERE parent_session_id = ? AND tool_call_id = ?`
      ).run(result.status, result.status, parentSessionId, toolCallId);
      return this.enqueueResultRowLocked(parentSessionId, result);
    });
  }
}
