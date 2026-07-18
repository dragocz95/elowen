import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { extractText } from '../brain/messageView.js';
import {
  normalizeDelegatedExecutionScope,
  sameDelegatedExecutionScope,
  type DelegatedExecutionScope,
} from '../brain/delegatedScope.js';
import type { TokenUsage, CostSource } from '../integrations/usage/types.js';
import type { BrainCard, BrainGoalState, WorkflowNode, WorkflowUpdate } from '../brain/events.js';

export interface BrainSessionRow {
  id: string; user_id: number; title: string; model: string; work_dir: string; parent_session_id: string | null;
  delegated_access: string | null;
  created_at: string; updated_at: string;
}
export interface BrainMessageRow {
  id: string; session_id: string; parent_id: string | null; role: string; content: string; created_at: string;
}

/** One settled PI run, expressed without PI-specific types so the persistence layer remains the
 * only caller that translates agent messages. A `reusePreprojectedUser` entry keeps the clean user
 * row which was written before prompt() (and may differ from PI's ephemeral prompt framing). */
export interface BrainRunMessage {
  id?: string;
  parentId?: string | null;
  role: string;
  content?: unknown;
  reusePreprojectedUser?: boolean;
}
export interface BrainSearchHit {
  sessionId: string; sessionTitle: string; role: string; snippet: string; ts: string;
}
export type BrainGoalRow = BrainGoalState;
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
}
/** Store-neutral display shape consumed by shapeBrainMessages. */
export interface BrainSubagentRun extends BrainSubagentRunState {
  toolCallId: string;
  sessionId: string;
}
/** The validated latest snapshot of one workflow DAG (see brain_workflows). Aliases the wire payload on
 *  purpose: a `workflow` event carries the WHOLE DAG, so the durable row IS the snapshot and the row,
 *  the event and the state attached to the tool item cannot drift apart. Bounded display data only. */
export type BrainWorkflowRun = WorkflowUpdate;
/** A visible, display-only marker of an owner-driven session-state change (see brain_session_events).
 *
 *  The ONE list. It is also the read boundary's validator (getSessionEvents) and must stay in step with
 *  the table's CHECK constraint in schema.sql — a kind the type allows but the boundary rejects writes
 *  fine and then vanishes on the next reload, which no compiler catches: the boundary narrows a `string`
 *  from SQLite, so a stale check there stays perfectly well-typed. */
export const SESSION_EVENT_KINDS = ['model', 'mode', 'rename', 'reasoning', 'cwd'] as const;
export type SessionEventKind = typeof SESSION_EVENT_KINDS[number];
/** Narrow a kind read back from SQLite. The stored value is only ever `string` to the type system. */
const isSessionEventKind = (kind: string): kind is SessionEventKind =>
  (SESSION_EVENT_KINDS as readonly string[]).includes(kind);
export interface BrainSessionEvent {
  id: string;
  kind: SessionEventKind;
  detail: string;
  /** ISO 8601 (from the row's SQLite UTC created_at) — the transcript interleaves markers by this. */
  at: string;
}
export interface BrainSubagentResult {
  id: string;
  parentSessionId: string;
  toolCallId: string;
  sessionId: string;
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
}
/** A daemon-restart reconcile enqueues a SYNTHETIC terminal result for each orphaned running child so an
 *  autoDeliver parent still gets woken. Its id carries this prefix so a real completion arriving later for
 *  the same (parent_session_id, tool_call_id) can UPGRADE the still-pending synthetic row in place (see
 *  enqueueSubagentResult) rather than colliding with it. */
const SYNTHETIC_RESTART_RESULT_PREFIX = 'restart-';
export const syntheticRestartResultId = (parentSessionId: string, toolCallId: string): string =>
  `${SYNTHETIC_RESTART_RESULT_PREFIX}${parentSessionId}-${toolCallId}`;
/** Persisted usage of a delegated session tree. Unlike live context usage, these are cumulative token
 *  and cost totals only; callers must keep the root session's own context-window fill unchanged. */
export interface BrainDescendantUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  totalTokens: number; reasoning: number; cost: number;
}
/** Radius of context kept around a search match in its snippet. */
const SNIPPET_RADIUS = 60;

const bounded = (value: string, max: number): string => value.length <= max ? value : value.slice(0, max);

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
  };
}

function normalizeSubagentResult(raw: unknown): Omit<BrainSubagentResult, 'parentSessionId' | 'delivery' | 'attempts'> | undefined {
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
    ...(typeof o.result === 'string' ? { result: bounded(o.result, 100_000) } : {}),
    ...(typeof o.error === 'string' ? { error: bounded(o.error, 100_000) } : {}),
    tools: o.tools, ...(typeof o.tokens === 'number' ? { tokens: o.tokens } : {}), seconds: o.seconds,
    ...(typeof o.model === 'string' ? { model: bounded(o.model, 512) } : {}),
  };
}

// Normalized usage rows shared by usageByDay + usageByModel. One row per LIVE assistant message (its
// `$.usage`, attributed to the model it recorded in `$.model`) UNIONed with one row per per-model
// compaction-rollup bucket (`$.usageRollup[]` fanned out with json_each — a divider with no rollup
// contributes nothing). `ts` is the ms-epoch attribution point: a live row's own `$.timestamp`, or a
// rolled-up bucket's `at` (newest dropped row of that model) — so compaction NEVER moves spend to the
// compaction moment. `model` is the row's own producing model, falling back to the session's model only
// for legacy rows that predate per-message model capture. Purely static SQL (no user input) → safe to
// interpolate. Callers add the user/window/day filters + GROUP BY.
const USAGE_ROWS = `
  SELECT s.user_id AS user_id, s.id AS session_id,
         COALESCE(NULLIF(json_extract(m.content, '$.model'), ''), s.model) AS model,
         json_extract(m.content, '$.timestamp') AS ts,
         COALESCE(json_extract(m.content, '$.usage.input'), 0) AS input,
         COALESCE(json_extract(m.content, '$.usage.output'), 0) AS output,
         COALESCE(json_extract(m.content, '$.usage.cacheRead'), 0) AS cache_read,
         COALESCE(json_extract(m.content, '$.usage.cacheWrite'), 0) AS cache_write,
         COALESCE(json_extract(m.content, '$.usage.totalTokens'), 0) AS total,
         COALESCE(json_extract(m.content, '$.usage.reasoning'), 0) AS reasoning,
         json_extract(m.content, '$.usage.cost.total') AS cost
    FROM brain_messages m JOIN brain_sessions s ON s.id = m.session_id
   WHERE m.role = 'assistant'
  UNION ALL
  SELECT s.user_id AS user_id, s.id AS session_id,
         COALESCE(NULLIF(json_extract(je.value, '$.model'), ''), s.model) AS model,
         json_extract(je.value, '$.at') AS ts,
         COALESCE(json_extract(je.value, '$.input'), 0) AS input,
         COALESCE(json_extract(je.value, '$.output'), 0) AS output,
         COALESCE(json_extract(je.value, '$.cacheRead'), 0) AS cache_read,
         COALESCE(json_extract(je.value, '$.cacheWrite'), 0) AS cache_write,
         COALESCE(json_extract(je.value, '$.totalTokens'), 0) AS total,
         COALESCE(json_extract(je.value, '$.reasoning'), 0) AS reasoning,
         json_extract(je.value, '$.cost.total') AS cost
    FROM brain_messages m JOIN brain_sessions s ON s.id = m.session_id,
         json_each(json_extract(m.content, '$.usageRollup')) je
   WHERE m.role = 'compaction'`;

// A `brain-task-<id>` worker session is EXCLUDED from the brain aggregates ONLY when its spend is
// already snapshotted in task_usage (merged separately by /usage/by-model & /usage/by-day) — excluding
// it here too would double-count a task creator's spend. A worker that crashed BEFORE snapshotting
// (task then failed/cancelled, never relaunched) has NO task_usage row, so its persisted spend is KEPT
// here instead of vanishing from every stat. Non-task chat sessions always pass. `substr(id, 12)` strips
// the `brain-task-` prefix (11 chars) to recover the task id.
const TASK_SNAPSHOT_EXCLUSION = `NOT (session_id LIKE 'brain-task-%' AND EXISTS (SELECT 1 FROM task_usage tu WHERE tu.task_id = substr(session_id, 12)))`;

/** One per-model bucket of usage rolled up from the assistant rows a compaction DROPS, folded onto the
 *  `compaction` divider so historical spend survives (compaction deletes those rows). Stored as an ARRAY
 *  under `$.usageRollup` — one bucket per model that produced dropped spend — under a key that is NEVER
 *  `usage`, so PI's live session and `usageOf` (statusline) never double-count it after rehydrate.
 *  `model` preserves per-model attribution across compaction; `at` is the ms-epoch of the newest dropped
 *  row of that model (the day/window attribution basis, standing in for a live row's `$.timestamp`). */
interface UsageRollupBucket {
  model: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  totalTokens: number; reasoning: number; at: number; cost?: { total: number };
}

/** Fold the usage of the rows a compaction is about to delete into PER-MODEL rollup buckets: assistant
 *  rows via `$.usage`, attributed to their own `$.model`; and any earlier compaction dividers via their
 *  own `$.usageRollup` buckets, so multiple compactions chain without losing spend OR its per-model
 *  breakdown. Each bucket's `at` is the ms-epoch of the newest dropped row of THAT model, so rolled-up
 *  spend keeps its ORIGINAL date instead of jumping to the compaction moment. Returns null when nothing
 *  dropped carried usage (keeps the divider clean). */
function rollupDroppedUsage(dropped: BrainMessageRow[]): UsageRollupBucket[] | null {
  const byModel = new Map<string, UsageRollupBucket>();
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const bucketFor = (model: string): UsageRollupBucket => {
    let b = byModel.get(model);
    if (!b) { b = { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, at: 0 }; byModel.set(model, b); }
    return b;
  };
  const fold = (b: UsageRollupBucket, u: Record<string, unknown>, at: number): void => {
    b.input += num(u.input); b.output += num(u.output);
    b.cacheRead += num(u.cacheRead); b.cacheWrite += num(u.cacheWrite);
    b.reasoning += num(u.reasoning); b.totalTokens += num(u.totalTokens);
    const cost = (u as { cost?: { total?: unknown } }).cost;
    if (cost && typeof cost === 'object' && typeof cost.total === 'number') b.cost = { total: (b.cost?.total ?? 0) + cost.total };
    if (at > b.at) b.at = at; // newest dropped row of this model wins as its attribution point
  };
  for (const row of dropped) {
    let content: unknown;
    try { content = JSON.parse(row.content); } catch { continue; }
    if (typeof content !== 'object' || content === null) continue;
    const c = content as { usage?: Record<string, unknown>; usageRollup?: unknown; model?: unknown; timestamp?: unknown };
    if (Array.isArray(c.usageRollup)) {
      // A prior divider — merge each of its per-model buckets (chained compaction).
      for (const raw of c.usageRollup) {
        if (!raw || typeof raw !== 'object') continue;
        const pb = raw as Record<string, unknown>;
        fold(bucketFor(typeof pb.model === 'string' ? pb.model : ''), pb, num(pb.at));
      }
    } else if (c.usage && typeof c.usage === 'object') {
      // An assistant message — attribute to the model it recorded (empty → resolved to the session model
      // in SQL for legacy rows that predate per-message model capture).
      fold(bucketFor(typeof c.model === 'string' ? c.model : ''), c.usage, typeof c.timestamp === 'number' ? c.timestamp : 0);
    }
  }
  const buckets = [...byModel.values()].filter((b) => b.totalTokens !== 0 || b.cost != null);
  if (buckets.length === 0) return null;
  for (const b of buckets) if (b.at === 0) b.at = Date.now(); // undated legacy → the compaction moment
  return buckets;
}

/** Persistence for the embedded brain's conversations — the SOLE authoritative store (design D1).
 *  The PI agent session runs in-memory; every settled turn is projected here, and history is
 *  rehydrated from here on start. Exactly one writer (BrainService), so no dual-write drift. */
export class BrainStore {
  constructor(private db: Db) {}

  /** Create a top-level or delegated session. A supplied parent must already exist and belong to the
   *  same owner: the relation is later traversed for billing, so accepting a foreign/missing parent
   *  would either leak another user's spend or silently lose the child's. Nested parents are valid. */
  createSession(input: {
    id: string; userId: number; title?: string; model: string; parentSessionId?: string | null;
    /** Immutable execution boundary for a newly-created delegated child. */
    delegatedAccess?: DelegatedExecutionScope;
  }): BrainSessionRow {
    const parentSessionId = input.parentSessionId ?? null;
    const delegatedAccess = input.delegatedAccess === undefined
      ? undefined
      : normalizeDelegatedExecutionScope(input.delegatedAccess);
    if (input.delegatedAccess !== undefined && !delegatedAccess) throw new Error('invalid delegated access');
    if (delegatedAccess && parentSessionId === null) throw new Error('delegated access requires a parent session');
    this.db.transaction(() => {
      if (parentSessionId !== null) {
        const parent = this.db.prepare('SELECT user_id FROM brain_sessions WHERE id = ?').get(parentSessionId) as { user_id: number } | undefined;
        if (!parent) throw new Error(`parent brain session not found: ${parentSessionId}`);
        if (parent.user_id !== input.userId) throw new Error('parent brain session belongs to another user');
      }
      this.db.prepare(
        `INSERT INTO brain_sessions (id, user_id, title, model, parent_session_id, delegated_access)
         VALUES (@id, @user_id, @title, @model, @parent_session_id, @delegated_access)`
      ).run({
        id: input.id, user_id: input.userId, title: input.title ?? '', model: input.model,
        parent_session_id: parentSessionId,
        delegated_access: delegatedAccess ? JSON.stringify(delegatedAccess) : null,
      });
    })();
    return this.getSession(input.id)!;
  }

  getSession(id: string): BrainSessionRow | undefined {
    return this.db.prepare('SELECT * FROM brain_sessions WHERE id = ?').get(id) as BrainSessionRow | undefined;
  }

  /** Read a child's immutable delegation boundary. Both legacy NULL rows and malformed DB JSON are
   * deliberately returned as undefined so callers fail closed before executing a continuation. */
  delegatedAccessFor(sessionId: string): DelegatedExecutionScope | undefined {
    const row = this.getSession(sessionId);
    if (!row?.parent_session_id || !row.delegated_access) return undefined;
    try { return normalizeDelegatedExecutionScope(JSON.parse(row.delegated_access)); }
    catch { return undefined; }
  }

  /** A respawn may only use the exact boundary originally minted for this durable child. It never writes
   * a missing/changed value: legacy or corrupt rows stay unusable rather than being upgraded by request input. */
  hasDelegatedAccess(sessionId: string, supplied: DelegatedExecutionScope): boolean {
    const stored = this.delegatedAccessFor(sessionId);
    const normalized = normalizeDelegatedExecutionScope(supplied);
    return !!stored && !!normalized && sameDelegatedExecutionScope(stored, normalized);
  }

  listSessions(userId: number): BrainSessionRow[] {
    return this.db.prepare('SELECT * FROM brain_sessions WHERE user_id = ? ORDER BY updated_at DESC, rowid ASC')
      .all(userId) as BrainSessionRow[];
  }

  /** The user's sessions that hold no message at all. A live session owns its row from the moment it
   *  spawns — that is what the delegation parent check, the work-dir binding and every ownership check
   *  read — but a row nobody has spoken into is not yet a CONVERSATION: it is the empty shell the CLI
   *  leaves behind simply by launching. One query, so a listing can filter without an N+1. */
  unspokenSessionIds(userId: number): Set<string> {
    const rows = this.db.prepare(
      `SELECT s.id FROM brain_sessions s
       WHERE s.user_id = ? AND NOT EXISTS (SELECT 1 FROM brain_messages m WHERE m.session_id = s.id)`
    ).all(userId) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  /** Ids of a user's own top-level conversations whose last activity is older than `days` — the
   *  candidates for the retention janitor. The DB-derivable exclusions live HERE so they are applied
   *  atomically and can never drift from the delete: a non-user session (channel/task shell), a delegated
   *  child (`parent_session_id` set — deleting one out from under its parent tree is wrong), and an
   *  unspoken empty shell are all filtered out. The live-state exclusions (running, active, running
   *  children) cannot be seen from SQLite and are the caller's to apply before deleting. `days` is clamped
   *  to a positive integer — it is interpolated into a SQLite date modifier, so it must never be a string. */
  staleConversationIds(userId: number, days: number): string[] {
    const d = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 90;
    const rows = this.db.prepare(
      `SELECT s.id FROM brain_sessions s
       WHERE s.user_id = ?
         AND s.parent_session_id IS NULL
         AND s.id NOT LIKE 'brain-ch-%'
         AND s.id NOT LIKE 'brain-task-%'
         AND s.updated_at < datetime('now', '-${d} days')
         AND EXISTS (SELECT 1 FROM brain_messages m WHERE m.session_id = s.id)`
    ).all(userId) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** Per-user overview stats for the users admin panel: total session count and the model used in the
   *  most sessions over the whole history (indexed on user_id). One count + one grouped query, no N+1.
   *  `topModel` is null when the user has no sessions with a recorded model. */
  userStats(userId: number): { sessionCount: number; topModel: string | null } {
    const sessionCount = (this.db.prepare('SELECT COUNT(*) AS n FROM brain_sessions WHERE user_id = ?').get(userId) as { n: number }).n;
    const top = this.db.prepare(
      "SELECT model, COUNT(*) AS c FROM brain_sessions WHERE user_id = ? AND model != '' GROUP BY model ORDER BY c DESC, model ASC LIMIT 1"
    ).get(userId) as { model: string; c: number } | undefined;
    return { sessionCount, topModel: top?.model ?? null };
  }

  /** Daily token/cost totals of the user's OWN brain sessions (CLI/web chat and their channel/cron
   *  sessions) over the last `days` days, for the dashboard spend tiles — task_usage only covers task
   *  workers, so without this a paid chat model burned money invisibly. Reads the normalized USAGE_ROWS
   *  (live assistant `$.usage` + per-model compaction rollups), so a compacted session's history keeps
   *  counting and rolled-up spend keeps its ORIGINAL date (the bucket's `at`, not the compaction moment).
   *  `brain-task-%` sessions are excluded only when already snapshotted in task_usage — see
   *  TASK_SNAPSHOT_EXCLUSION (a crashed-before-snapshot worker's spend is kept, not lost). Platform
   *  channel sessions (Discord) ARE included — the operator anchors them, so their spend is the operator's.
   *  Cost is null when NO row that day carried one (distinguishes "free/unknown" from a real $0.00). */
  usageByDay(userId: number, days = 7): { day: string; tokens: number; cost: number | null }[] {
    return this.db.prepare(
      `WITH usage_rows AS (${USAGE_ROWS})
       SELECT date(ts / 1000, 'unixepoch') AS day,
              COALESCE(SUM(total), 0) AS tokens,
              CASE WHEN COUNT(cost) = 0 THEN NULL ELSE SUM(cost) END AS cost
         FROM usage_rows
        WHERE user_id = ?
          AND ts IS NOT NULL
          AND ${TASK_SNAPSHOT_EXCLUSION}
          AND date(ts / 1000, 'unixepoch') >= date('now', ?)
        GROUP BY day ORDER BY day`
    ).all(userId, `-${Math.max(0, Math.floor(days) - 1)} days`) as { day: string; tokens: number; cost: number | null }[];
  }

  /** Total token/cost usage of the user's OWN brain CHAT sessions aggregated per model (exec spec), for
   *  the web Stats page's /usage/by-model view — the analogue of usageByDay, so chat spend on a paid
   *  model is no longer invisible there. Groups the normalized USAGE_ROWS by the model that ACTUALLY
   *  produced each assistant row (its `$.model`, or a rollup bucket's `model`) — NOT the session's
   *  current model, so switching a conversation's model never retroactively re-attributes its history —
   *  and emits `elowen:<model>` so a model that ALSO ran as a task worker folds into the SAME bucket the
   *  task_usage aggregate uses. `brain-task-%` sessions are excluded only when already snapshotted in
   *  task_usage (TASK_SNAPSHOT_EXCLUSION); platform channel sessions (Discord) ARE included — the operator
   *  anchors them, so their spend counts as the operator's. Brain chat cost is OpenRouter provider-reported, so a costed
   *  bucket is `provider_reported`; an uncosted one is `unavailable` (costUsd null), matching usageByDay's
   *  null-vs-real-$0 distinction. Optional `window` narrows by each row's own attribution timestamp (ms
   *  epoch), same basis as usageByDay; undated rows are excluded from BOTH the windowed and unwindowed
   *  view (`ts IS NOT NULL`) so windowed totals always sum to the unwindowed total. A bucket comes back
   *  if it has any tokens OR any cost (a provider that reports cost with zero tokens still counts). */
  usageByModel(userId: number, window?: { fromIso?: string; toIso?: string }): { exec: string; usage: TokenUsage }[] {
    const clauses = [`user_id = ?`, `ts IS NOT NULL`, `model != ''`, TASK_SNAPSHOT_EXCLUSION];
    const params: (string | number)[] = [userId];
    const fromMs = window?.fromIso ? Date.parse(window.fromIso) : NaN;
    const toMs = window?.toIso ? Date.parse(window.toIso) : NaN;
    if (Number.isFinite(fromMs)) { clauses.push(`ts >= ?`); params.push(fromMs); }
    if (Number.isFinite(toMs)) { clauses.push(`ts <= ?`); params.push(toMs); }
    interface Row { model: string; input: number; output: number; cache_read: number; cache_write: number; total: number; reasoning: number; cost: number | null }
    const rows = this.db.prepare(
      `WITH usage_rows AS (${USAGE_ROWS})
       SELECT model AS model,
              COALESCE(SUM(input), 0) AS input,
              COALESCE(SUM(output), 0) AS output,
              COALESCE(SUM(cache_read), 0) AS cache_read,
              COALESCE(SUM(cache_write), 0) AS cache_write,
              COALESCE(SUM(total), 0) AS total,
              COALESCE(SUM(reasoning), 0) AS reasoning,
              CASE WHEN COUNT(cost) = 0 THEN NULL ELSE SUM(cost) END AS cost
         FROM usage_rows
        WHERE ${clauses.join(' AND ')}
        GROUP BY model`
    ).all(...params) as Row[];
    return rows
      .filter((r) => r.total > 0 || (r.cost ?? 0) > 0)
      .map((r) => {
        const costSource: CostSource = r.cost != null ? 'provider_reported' : 'unavailable';
        const usage: TokenUsage = {
          input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write,
          total: r.total, reasoning: r.reasoning, costUsd: r.cost, currency: r.cost != null ? 'USD' : null, costSource,
        };
        return { exec: `elowen:${r.model}`, usage };
      });
  }

  /** Cumulative token total per session (summed from each stored assistant message's usage) for the
   *  session-management panel. One grouped query — no N+1. Sessions with no usage-bearing messages
   *  come back 0. Persisted messages only, so a mid-turn session reads slightly stale (acceptable). */
  tokenTotals(userId: number): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT s.id AS id, COALESCE(SUM(json_extract(m.content, '$.usage.totalTokens')), 0) AS tokens
         FROM brain_sessions s LEFT JOIN brain_messages m ON m.session_id = s.id
        WHERE s.user_id = ? GROUP BY s.id`
    ).all(userId) as { id: string; tokens: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.id] = r.tokens ?? 0;
    return out;
  }

  /** Sum every persisted descendant of `sessionId` (direct child + arbitrary nested delegates) from
   *  the SAME normalized rows used by the global usage views. This includes compaction `usageRollup`
   *  buckets, so archiving old child context never makes its spend disappear. The root itself is
   *  intentionally excluded: its live PI session remains authoritative for its own statusline usage.
   *  No task-snapshot exclusion applies here — this is one conversation tree, not the global task/chat
   *  merge. The owner predicate is defensive against a manually-corrupted cross-user relation. */
  descendantUsage(sessionId: string): BrainDescendantUsage {
    interface Row {
      input: number; output: number; cache_read: number; cache_write: number;
      total: number; reasoning: number; cost: number;
    }
    const row = this.db.prepare(
      `WITH RECURSIVE descendants(id, user_id) AS (
         SELECT child.id, child.user_id
           FROM brain_sessions child
           JOIN brain_sessions root ON root.id = ?
          WHERE child.parent_session_id = root.id AND child.user_id = root.user_id
         UNION
         SELECT child.id, child.user_id
           FROM brain_sessions child JOIN descendants parent ON child.parent_session_id = parent.id
          WHERE child.user_id = parent.user_id
       ), usage_rows AS (${USAGE_ROWS})
       SELECT COALESCE(SUM(u.input), 0) AS input,
              COALESCE(SUM(u.output), 0) AS output,
              COALESCE(SUM(u.cache_read), 0) AS cache_read,
              COALESCE(SUM(u.cache_write), 0) AS cache_write,
              COALESCE(SUM(u.total), 0) AS total,
              COALESCE(SUM(u.reasoning), 0) AS reasoning,
              COALESCE(SUM(u.cost), 0) AS cost
         FROM usage_rows u JOIN descendants d ON d.id = u.session_id`
    ).get(sessionId) as Row;
    return {
      input: row.input, output: row.output, cacheRead: row.cache_read, cacheWrite: row.cache_write,
      totalTokens: row.total, reasoning: row.reasoning, cost: row.cost,
    };
  }

  appendMessage(input: { id: string; sessionId: string; parentId: string | null; role: string; content: unknown }): BrainMessageRow {
    this.db.prepare(
      `INSERT INTO brain_messages (id, session_id, parent_id, role, content)
       VALUES (@id, @session_id, @parent_id, @role, @content)`
    ).run({
      id: input.id, session_id: input.sessionId, parent_id: input.parentId,
      role: input.role, content: JSON.stringify(input.content),
    });
    return this.db.prepare('SELECT * FROM brain_messages WHERE id = ?').get(input.id) as BrainMessageRow;
  }

  /** Remove one message only from its expected session. Used to roll back a pre-projected user row when
   * PI rejects a prompt before its native preflight boundary; the session condition prevents a stale
   * caller from deleting a row that compaction/session migration moved elsewhere. */
  deleteMessage(sessionId: string, messageId: string): boolean {
    return this.db.prepare('DELETE FROM brain_messages WHERE id = ? AND session_id = ?')
      .run(messageId, sessionId).changes > 0;
  }

  /** Mirror ONE message the moment PI finishes it, so a daemon restart mid-turn no longer discards the
   *  whole run. Provisional by construction: these rows never outlive their turn — `persistAgentRun`
   *  drops every pending row in the same transaction that writes the settled run in PI's real execution
   *  order, and rows that survive at all are the remains of a turn that never settled, graduated by
   *  `settlePartialTurn` on respawn. The caller mints the id: PI's `message_end` carries the finished
   *  message but no entry id of its own. */
  appendPendingMessage(input: { id: string; sessionId: string; role: string; content: unknown }): void {
    this.db.prepare(
      `INSERT INTO brain_messages (id, session_id, parent_id, role, content, pending)
       VALUES (@id, @session_id, NULL, @role, @content, 1)
       ON CONFLICT(id) DO NOTHING`
    ).run({ id: input.id, session_id: input.sessionId, role: input.role, content: JSON.stringify(input.content) });
  }

  /** The session's provisional mid-turn rows, oldest first. */
  pendingMessages(sessionId: string): BrainMessageRow[] {
    return this.db.prepare('SELECT * FROM brain_messages WHERE session_id = ? AND pending = 1 ORDER BY rowid ASC')
      .all(sessionId) as BrainMessageRow[];
  }

  /** Promote the session's surviving mid-turn rows to durable history. Called when a session is respawned
   *  with rows still pending, which can only mean the turn that wrote them never settled (a restart or a
   *  crash) — so what it managed to produce is all the history that turn will ever have. */
  settlePendingMessages(sessionId: string): void {
    this.db.prepare('UPDATE brain_messages SET pending = 0 WHERE session_id = ? AND pending = 1').run(sessionId);
  }

  /**
   * Persist one settled agent run in the order PI actually executed it. User prompts are intentionally
   * projected before `prompt()` so compaction can see them, but a mid-turn steer can arrive after the
   * agent has already emitted assistant/tool output. At `agent_end`, reconstructing the run atomically
   * lets those existing clean user rows land between the matching generated messages instead of leaving
   * them prematurely at the end of the previous durable prefix. Message rowid is the canonical transcript
   * sequence: `created_at` remains the real wall-clock metadata and therefore cannot order an assistant
   * emitted before a later steer when that assistant is only persisted at agent_end.
   *
   * Returns false when the expected pre-projected user suffix is no longer present. Callers then retain
   * the safe legacy append path rather than guessing which historical rows belong to this run.
   *
   * EITHER WAY this drops the run's provisional mid-turn rows first, inside the same transaction: the
   * settled `agent_end` carries the very same messages, so leaving them would duplicate the entire turn.
   * That is why the drop happens here rather than at the call site — the fallback append path above must
   * never run against a store that still holds them.
   */
  persistAgentRun(sessionId: string, messages: BrainRunMessage[]): boolean {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ? AND pending = 1').run(sessionId);
      const userCount = messages.filter((message) => message.reusePreprojectedUser).length;
      if (userCount === 0) return false;
      const rows = this.db.prepare(
        'SELECT id, session_id, parent_id, role, content, created_at FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC'
      ).all(sessionId) as BrainMessageRow[];
      const users = rows.slice(-userCount);
      if (users.length !== userCount || users.some((row) => row.role !== 'user')) return false;

      const prefix = rows.slice(0, rows.length - userCount);
      let nextUser = 0;
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const ordered: BrainMessageRow[] = [...prefix];
      for (const message of messages) {
        if (message.reusePreprojectedUser) {
          const user = users[nextUser++];
          if (!user) return false; // defensive; the count check above should make this unreachable
          ordered.push(user);
          continue;
        }
        if (!message.id || message.content === undefined) return false;
        ordered.push({
          id: message.id,
          session_id: sessionId,
          parent_id: message.parentId ?? null,
          role: message.role,
          content: JSON.stringify(message.content),
          created_at: now,
        });
      }
      if (nextUser !== users.length) return false;

      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ?').run(sessionId);
      const insert = this.db.prepare(
        `INSERT INTO brain_messages (id, session_id, parent_id, role, content, created_at)
         VALUES (@id, @session_id, @parent_id, @role, @content, @created_at)`
      );
      for (const row of ordered) insert.run(row);
      return true;
    })();
  }

  /** created_at of the session's newest stored message (undefined when it has none) — drives the
   *  idle-rollover check without loading the whole history. */
  lastMessageAt(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT MAX(created_at) AS ts FROM brain_messages WHERE session_id = ?').get(sessionId) as { ts: string | null };
    return row.ts ?? undefined;
  }

  getMessages(sessionId: string): BrainMessageRow[] {
    return this.db.prepare('SELECT * FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC')
      .all(sessionId) as BrainMessageRow[];
  }

  /** Persist a display card (ctx.emitCard) so the panel outlives the live session — closing the chat
   *  disposes the session, and a memory-only todo list would die with it. An upsert keeps the row's
   *  rowid, so re-emitting a card updates it in place without jumping to the end of the panel. */
  upsertCard(sessionId: string, card: BrainCard): void {
    this.db.prepare(`INSERT INTO brain_cards (session_id, card_id, payload, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(session_id, card_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(sessionId, card.id, JSON.stringify(card));
  }

  deleteCard(sessionId: string, cardId: string): void {
    this.db.prepare('DELETE FROM brain_cards WHERE session_id = ? AND card_id = ?').run(sessionId, cardId);
  }

  /** The conversation's persisted cards, in the order they were first emitted. A row that no longer parses
   *  (hand-edited DB, a payload written by an older shape) is skipped rather than taking the panel down. */
  getCards(sessionId: string): BrainCard[] {
    const rows = this.db.prepare('SELECT payload FROM brain_cards WHERE session_id = ? ORDER BY rowid ASC')
      .all(sessionId) as { payload: string }[];
    const cards: BrainCard[] = [];
    for (const row of rows) {
      try {
        const card = JSON.parse(row.payload) as BrainCard;
        if (card && typeof card.id === 'string' && card.id) cards.push(card);
      } catch { /* unparseable row — drop this card, keep the rest of the panel */ }
    }
    return cards;
  }

  /** Persist the newest progress snapshot for one delegate tool call. This is deliberately synchronous:
   *  a background child may finish after the parent turn has already settled, and the live event must
   *  never race ahead of the durable state a reconnect reads. Both sessions must exist, have the same
   *  owner, and be a DIRECT parent/child pair; a plugin cannot smuggle a foreign transcript id into the
   *  parent's drill-in UI. A tool-call id is permanently bound to its first child. */
  upsertSubagentRun(parentSessionId: string, raw: unknown): boolean {
    if (!parentSessionId || !raw || typeof raw !== 'object') return false;
    const update = raw as Record<string, unknown>;
    if (typeof update.id !== 'string' || !update.id || update.id.length > 512) return false;
    if (typeof update.sessionId !== 'string' || !update.sessionId) return false;
    const state = normalizeSubagentState(update);
    if (!state) return false;
    return this.db.transaction(() => {
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
      this.db.prepare(
        `INSERT INTO brain_subagent_runs (parent_session_id, tool_call_id, child_session_id, state)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(parent_session_id, tool_call_id) DO UPDATE SET
           state = excluded.state, updated_at = datetime('now')`
      ).run(parentSessionId, update.id, update.sessionId, JSON.stringify(state));
      return true;
    })();
  }

  /** Read only still-valid direct same-owner relations. Malformed legacy/corrupted JSON is ignored at
   *  this boundary, so all downstream wire shapes remain trusted and finite. */
  getSubagentRuns(parentSessionId: string): BrainSubagentRun[] {
    const rows = this.db.prepare(
      `SELECT r.tool_call_id, r.child_session_id, r.state, x.delivery_state
         FROM brain_subagent_runs r
         JOIN brain_sessions p ON p.id = r.parent_session_id
         JOIN brain_sessions c ON c.id = r.child_session_id
         LEFT JOIN brain_subagent_results x
           ON x.parent_session_id = r.parent_session_id AND x.tool_call_id = r.tool_call_id
        WHERE r.parent_session_id = ?
          AND c.parent_session_id = p.id
          AND c.user_id = p.user_id
        ORDER BY r.updated_at ASC, r.rowid ASC`
    ).all(parentSessionId) as { tool_call_id: string; child_session_id: string; state: string; delivery_state: string | null }[];
    const out: BrainSubagentRun[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.state); } catch { continue; }
      const state = normalizeSubagentState(parsed);
      if (state) out.push({
        toolCallId: row.tool_call_id, sessionId: row.child_session_id, ...state,
        ...(row.delivery_state === 'pending' || row.delivery_state === 'acknowledged'
          ? { resultDelivery: row.delivery_state } : {}),
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
    return this.db.transaction(() => {
      const parent = this.db.prepare('SELECT id FROM brain_sessions WHERE id = ?').get(parentSessionId) as { id: string } | undefined;
      if (!parent) return false;
      const prior = this.db.prepare(
        'SELECT workflow_id FROM brain_workflows WHERE parent_session_id = ? AND tool_call_id = ?'
      ).get(parentSessionId, state.toolCallId) as { workflow_id: string } | undefined;
      if (prior && prior.workflow_id !== state.id) return false;
      this.db.prepare(
        `INSERT INTO brain_workflows (parent_session_id, tool_call_id, workflow_id, state)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(parent_session_id, tool_call_id) DO UPDATE SET
           state = excluded.state, updated_at = datetime('now')`
      ).run(parentSessionId, state.toolCallId, state.id, JSON.stringify(state));
      return true;
    })();
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

  /** Append a display-only session-event marker (model/mode/rename/reasoning change). Insertion order
   *  (rowid) is the timeline; the marker never touches brain_messages, so it stays out of model context. */
  appendSessionEvent(sessionId: string, kind: SessionEventKind, detail: string): BrainSessionEvent {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO brain_session_events (session_id, event_id, kind, detail) VALUES (?, ?, ?, ?)'
    ).run(sessionId, id, kind, detail);
    const row = this.db.prepare(
      'SELECT created_at FROM brain_session_events WHERE session_id = ? AND event_id = ?'
    ).get(sessionId, id) as { created_at: string };
    return { id, kind, detail, at: new Date(`${row.created_at.replace(' ', 'T')}Z`).toISOString() };
  }

  /** The session's markers in event order, for the boot/reconnect snapshot (interleaved into the
   *  transcript client-side by `at`). Malformed rows are dropped at this boundary. */
  getSessionEvents(sessionId: string): BrainSessionEvent[] {
    const rows = this.db.prepare(
      'SELECT event_id, kind, detail, created_at FROM brain_session_events WHERE session_id = ? ORDER BY rowid ASC'
    ).all(sessionId) as { event_id: string; kind: string; detail: string; created_at: string }[];
    const out: BrainSessionEvent[] = [];
    for (const row of rows) {
      if (!isSessionEventKind(row.kind)) continue;
      out.push({ id: row.event_id, kind: row.kind, detail: row.detail, at: new Date(`${row.created_at.replace(' ', 'T')}Z`).toISOString() });
    }
    return out;
  }

  /** Persist a terminal child result before any attempt to wake the parent. Stable result/tool ids make
   * duplicate plugin callbacks idempotent; the durable direct-child relation is revalidated here. */
  enqueueSubagentResult(parentSessionId: string, raw: unknown): boolean {
    const result = normalizeSubagentResult(raw);
    if (!parentSessionId || !result) return false;
    return this.db.transaction(() => {
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
           attempts = 0, last_error = NULL,
           delivery_state = 'pending', acknowledged_at = NULL
         WHERE brain_subagent_results.result_id LIKE '${SYNTHETIC_RESTART_RESULT_PREFIX}%'
           AND excluded.result_id NOT LIKE '${SYNTHETIC_RESTART_RESULT_PREFIX}%'`
      ).run(result.id, parentSessionId, result.toolCallId, result.sessionId, result.status, result.task, payload);
      const row = this.db.prepare(
        `SELECT parent_session_id, tool_call_id, child_session_id FROM brain_subagent_results WHERE result_id = ?`
      ).get(result.id) as { parent_session_id: string; tool_call_id: string; child_session_id: string } | undefined;
      return row?.parent_session_id === parentSessionId && row.tool_call_id === result.toolCallId && row.child_session_id === result.sessionId;
    })();
  }

  pendingSubagentResults(parentSessionId: string): BrainSubagentResult[] {
    const rows = this.db.prepare(
      `SELECT * FROM brain_subagent_results WHERE delivery_state = 'pending'
       AND parent_session_id = ? ORDER BY created_at, rowid`
    ).all(parentSessionId) as Record<string, unknown>[];
    return rows.flatMap((row) => {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(String(row.payload)) as Record<string, unknown>; } catch { return []; }
      const normalized = normalizeSubagentResult({
        id: row.result_id, toolCallId: row.tool_call_id, sessionId: row.child_session_id,
        status: row.status, task: row.task, ...payload,
      });
      return normalized ? [{
        ...normalized, parentSessionId: String(row.parent_session_id), delivery: 'pending' as const,
        attempts: Number(row.attempts) || 0,
      }] : [];
    });
  }

  acknowledgeSubagentResult(parentSessionId: string, resultId: string): boolean {
    return this.db.prepare(
      `UPDATE brain_subagent_results SET delivery_state = 'acknowledged', acknowledged_at = datetime('now')
       WHERE parent_session_id = ? AND result_id = ? AND delivery_state = 'pending'`
    ).run(parentSessionId, resultId).changes === 1;
  }

  noteSubagentResultFailure(parentSessionId: string, resultId: string, error: string): void {
    this.db.prepare(
      `UPDATE brain_subagent_results SET attempts = attempts + 1, last_error = ?
       WHERE parent_session_id = ? AND result_id = ? AND delivery_state = 'pending'`
    ).run(bounded(error, 2_000), parentSessionId, resultId);
  }

  /** Case-insensitive fulltext search across the user's OWN chat conversations. Shared platform
   *  sessions (`brain-ch-*`, which carry other members' messages) and ephemeral subagent runs
   *  (`brain-task-*`) are excluded — the search backs the personal chat sidebar, not the Discord logs.
   *  The LIKE over the raw content JSON is a coarse prefilter; each candidate is confirmed against its
   *  extracted display text (so JSON keys never match) and shaped into a ±60-char snippet. Newest first.
   *  The SQL row scan is bounded (recent-biased) so a broad `%q%` can't scan the whole table. */
  searchMessages(userId: number, query: string, limit = 50): BrainSearchHit[] {
    const q = query.trim();
    if (q.length < 2) return [];
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rows = this.db.prepare(
      `SELECT m.session_id, s.title, m.role, m.content, m.created_at
         FROM brain_messages m JOIN brain_sessions s ON s.id = m.session_id
        WHERE s.user_id = ? AND m.role IN ('user', 'assistant') AND m.content LIKE ? ESCAPE '\\'
          AND m.session_id NOT LIKE 'brain-ch-%' AND m.session_id NOT LIKE 'brain-task-%'
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT 500`
    ).all(userId, like) as { session_id: string; title: string; role: string; content: string; created_at: string }[];
    const needle = q.toLowerCase();
    const hits: BrainSearchHit[] = [];
    for (const r of rows) {
      if (hits.length >= limit) break;
      let text = '';
      try { text = extractText(JSON.parse(r.content)); } catch { continue; }
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue; // LIKE hit the JSON structure, not the display text
      const from = Math.max(0, at - SNIPPET_RADIUS);
      const to = Math.min(text.length, at + q.length + SNIPPET_RADIUS);
      const body = text.slice(from, to).replace(/\s+/g, ' ');
      hits.push({
        sessionId: r.session_id, sessionTitle: r.title, role: r.role,
        snippet: `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`, ts: r.created_at,
      });
    }
    return hits;
  }

  /** Bind a conversation to the client-reported working directory it was started/used from (already
   *  validated by the caller — see BrainService.stampWorkDir). Empty stays empty: a cwd-less legacy or
   *  web session is never stamped, so it keeps working as "matches nowhere" for the CLI resolution. */
  setWorkDir(id: string, workDir: string): void {
    this.db.prepare('UPDATE brain_sessions SET work_dir = ? WHERE id = ?').run(workDir, id);
  }

  /** Set a session's display title (derived from its first user message; set once). */
  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE brain_sessions SET title = ? WHERE id = ?').run(title, id);
  }

  /** Replace an automatically seeded title only while it is still the exact provisional value.
   *  Title generation runs in the background; this compare-and-set prevents its late result from
   *  overwriting a manual /rename that completed while inference was in flight. */
  setTitleIfCurrent(id: string, current: string, title: string): boolean {
    return this.db.prepare('UPDATE brain_sessions SET title = ? WHERE id = ? AND title = ?')
      .run(title, id, current).changes > 0;
  }

  renameSession(id: string, title: string): void {
    this.db.prepare("UPDATE brain_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id);
  }

  touchSession(id: string, model?: string): void {
    if (model === undefined) {
      this.db.prepare("UPDATE brain_sessions SET updated_at = datetime('now') WHERE id = ?").run(id);
    } else {
      this.db.prepare("UPDATE brain_sessions SET updated_at = datetime('now'), model = ? WHERE id = ?").run(model, id);
    }
  }

  /** Delete one conversation and its goal + messages atomically — a crash between the DELETEs would
   *  otherwise orphan goal/message rows against a gone session (no FK CASCADE here). */
  deleteSession(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM brain_subagent_results WHERE parent_session_id = ? OR child_session_id = ?').run(id, id);
      this.db.prepare('DELETE FROM brain_subagent_runs WHERE parent_session_id = ? OR child_session_id = ?').run(id, id);
      // A child remains a valid standalone transcript if its parent is deleted from history.
      this.db.prepare('UPDATE brain_sessions SET parent_session_id = NULL WHERE parent_session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_goals WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_cards WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_session_events WHERE session_id = ?').run(id);
      // Only as the ORIGIN: a workflow outlives any one of its node children (getWorkflowRuns simply
      // stops resolving that node's drill-in), so deleting a node session must not take the DAG with it.
      this.db.prepare('DELETE FROM brain_workflows WHERE parent_session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_sessions WHERE id = ?').run(id);
    })();
  }

  /** Re-key a session — its row, messages and goal — to a new id, atomically (a crash mid-move would
   *  otherwise split a conversation across two ids). Used by channel idle rollover to ARCHIVE the old
   *  transcript under a fresh unique id (freeing the deterministic channel id for a new session) while
   *  keeping the old conversation and its title fully browsable, exactly as owner-chat rollover keeps
   *  the prior conversation. Delegated children follow the archived parent id; `parent_id` on messages
   *  references message ids (not session ids), so that separate column needs no rewrite. */
  reassignSession(oldId: string, newId: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE brain_sessions SET id = ? WHERE id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_sessions SET parent_session_id = ? WHERE parent_session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_subagent_runs SET parent_session_id = ? WHERE parent_session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_subagent_runs SET child_session_id = ? WHERE child_session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_subagent_results SET parent_session_id = ? WHERE parent_session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_subagent_results SET child_session_id = ? WHERE child_session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_messages SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_goals SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_cards SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_session_events SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      // No JSON surgery for the node session ids inside `state`: only a session addressed by a
      // deterministic channel id is ever re-keyed, and node children run on single-use uuid channel ids,
      // so a node can never be `oldId`. getWorkflowRuns re-validates them on read regardless.
      this.db.prepare('UPDATE brain_workflows SET parent_session_id = ? WHERE parent_session_id = ?').run(newId, oldId);
    })();
  }

  /** Fold a context compaction into the store, atomically (ONE transaction — never a partial state):
   *  KEEP the last `keepLastN` message rows exactly as they already are (original id, role, content AND
   *  original created_at — the CLEAN persisted turns), DROP every row older than that tail, and insert
   *  the compaction summary as a `compaction` divider directly BEFORE the kept tail. So both
   *  `getMessages`/history and `rehydrate` return the model's shrunk context (summary + kept tail)
   *  instead of the full pre-compaction log — fixing the otherwise-ephemeral compaction (token savings
   *  were silently lost on the next respawn).
   *
   *  Why NOT re-serialize the live PI context: those user messages carry the ephemeral live-prompt
   *  framing (memory/permissions/turn-context blocks) + raw image bytes, so persisting them verbatim
   *  would leak internal framing into history and bloat SQLite. The store's own rows are the single
   *  clean source of history — this only rearranges rows already in it (see `persistCompaction`).
   *
   *  Implementation: the kept tail is deleted-and-reinserted with its ORIGINAL id/content/created_at so
   *  the summary is inserted first in the canonical rowid sequence while every kept row keeps its true
   *  timestamp (searchMessages / lastMessageAt stay truthful). `keepLastN >= total` keeps the whole log;
   *  `keepLastN <= 0` keeps just the summary. */
  compactSessionMessages(sessionId: string, summary: { id: string; role: string; content: unknown }, keepLastN: number): void {
    this.db.transaction(() => {
      const rows = this.db.prepare(
        'SELECT id, parent_id, role, content, created_at FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC'
      ).all(sessionId) as BrainMessageRow[];
      const keep = keepLastN <= 0 ? [] : rows.slice(Math.max(0, rows.length - keepLastN));
      // Fold the token/cost usage of the rows about to be deleted onto the divider (under `$.usageRollup`)
      // so a compacted session's historical spend survives — the usage aggregates read it. Deleting these
      // rows would otherwise silently ERASE that spend from the Stats page / daily tiles.
      const dropped = rows.slice(0, rows.length - keep.length);
      const rollup = rollupDroppedUsage(dropped);
      const summaryContent = rollup && typeof summary.content === 'object' && summary.content !== null && !Array.isArray(summary.content)
        ? { ...(summary.content as Record<string, unknown>), usageRollup: rollup }
        : summary.content;
      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ?').run(sessionId);
      const insert = this.db.prepare(
        `INSERT INTO brain_messages (id, session_id, parent_id, role, content, created_at)
         VALUES (@id, @session_id, @parent_id, @role, @content, @created_at)`
      );
      // Summary first → it gets the lowest rowid of the fresh batch. Pin its display/accounting timestamp
      // to the oldest kept row while rowid remains the authoritative transcript order.
      const summaryTs = keep[0]?.created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
      insert.run({ id: summary.id, session_id: sessionId, parent_id: null, role: summary.role, content: JSON.stringify(summaryContent), created_at: summaryTs });
      for (const r of keep) {
        insert.run({ id: r.id, session_id: sessionId, parent_id: r.parent_id, role: r.role, content: r.content, created_at: r.created_at });
      }
      // Markers annotate turns, so they die with the turns they annotate. Both tables stamp `datetime('now')`,
      // so this compares chronologically; `<` keeps any marker sharing the oldest kept row's second. Without
      // it a summarized-away marker outlives its turn and, being older than the divider, renders ABOVE it —
      // annotating a turn the reader can no longer see.
      this.db.prepare('DELETE FROM brain_session_events WHERE session_id = ? AND created_at < ?').run(sessionId, summaryTs);
    })();
  }

  /** Delete every conversation (+ goals + messages) for a user atomically — same orphan concern. */
  removeForUser(userId: number): void {
    this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM brain_subagent_results
          WHERE parent_session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)
             OR child_session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)`
      ).run(userId, userId);
      this.db.prepare(
        `DELETE FROM brain_subagent_runs
          WHERE parent_session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)
             OR child_session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)`
      ).run(userId, userId);
      this.db.prepare('DELETE FROM brain_goals WHERE user_id = ?').run(userId);
      // Every per-session sidecar goes too. These three were missing, so deleting a user left rows
      // holding their conversation content behind — keyed to session ids that no longer exist.
      this.db.prepare('DELETE FROM brain_workflows WHERE parent_session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_cards WHERE session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_session_events WHERE session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_messages WHERE session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_sessions WHERE user_id = ?').run(userId);
    })();
  }

  upsertGoal(input: { sessionId: string; userId: number; goal: string; status?: BrainGoalRow['status']; draft?: string; turnBudget?: number }): BrainGoalRow {
    this.db.prepare(
      `INSERT INTO brain_goals (session_id, user_id, status, goal, draft, turn_budget)
       VALUES (@session_id, @user_id, @status, @goal, @draft, @turn_budget)
       ON CONFLICT(session_id) DO UPDATE SET
         user_id = excluded.user_id,
         status = excluded.status,
         goal = excluded.goal,
         draft = excluded.draft,
         turns_used = 0,
         turn_budget = excluded.turn_budget,
         last_verdict = '',
         last_evidence = '',
         paused_reason = '',
         created_at = datetime('now'),
         updated_at = datetime('now')`
    ).run({
      session_id: input.sessionId,
      user_id: input.userId,
      status: input.status ?? 'active',
      goal: input.goal,
      draft: input.draft ?? '',
      turn_budget: input.turnBudget ?? 8,
    });
    return this.getGoal(input.sessionId)!;
  }

  getGoal(sessionId: string): BrainGoalRow | undefined {
    return this.db.prepare('SELECT * FROM brain_goals WHERE session_id = ?').get(sessionId) as BrainGoalRow | undefined;
  }

  /** All goals currently marked `active`. Used at daemon boot to reconcile restart zombies — their
   *  in-memory continuation timers died with the process, so the rows falsely claim to be running. */
  activeGoals(): BrainGoalRow[] {
    return this.db.prepare("SELECT * FROM brain_goals WHERE status = 'active'").all() as BrainGoalRow[];
  }

  updateGoal(sessionId: string, patch: Partial<Pick<BrainGoalRow, 'status' | 'subgoals' | 'turns_used' | 'last_verdict' | 'last_evidence' | 'paused_reason'>>): BrainGoalRow | undefined {
    // Runtime column whitelist — the keys are interpolated into SQL, so never trust the object's shape
    // (a route could forward a parsed body here); only these columns may be written.
    const ALLOWED = new Set(['status', 'subgoals', 'turns_used', 'last_verdict', 'last_evidence', 'paused_reason']);
    const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && ALLOWED.has(k));
    if (entries.length === 0) return this.getGoal(sessionId);
    const sets = entries.map(([k]) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE brain_goals SET ${sets}, updated_at = datetime('now') WHERE session_id = @session_id`)
      .run({ ...Object.fromEntries(entries), session_id: sessionId });
    return this.getGoal(sessionId);
  }

  clearGoal(sessionId: string): void {
    this.db.prepare('DELETE FROM brain_goals WHERE session_id = ?').run(sessionId);
  }
}
