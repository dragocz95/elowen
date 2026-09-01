import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Db } from './db.js';
import { withWriteLock } from './db.js';
import { extractText } from '../brain/messageView.js';
import { dbTsToIso } from '../shared/time.js';
import { planFilePath, toolResultSpillDir } from '../shared/paths.js';
import { logger } from '../shared/logger.js';
import { CHANNEL_PREFIX, SUBAGENT_PREFIX, CRON_PREFIX, isArchivedChannelSession } from '../brain/sessionId.js';
import { collectImageFiles, isPersistedImageBlock } from '../brain/chatImages.js';
import { collectChatFiles, type StoredChatFile } from '../brain/chatFiles.js';
import { rollupActivatedTools } from '../brain/continuity/activatedTools.js';
import { rollupWorkingSet } from '../brain/continuity/workingSet.js';
import {
  normalizeDelegatedExecutionScope,
  sameDelegatedExecutionScope,
  type DelegatedExecutionScope,
} from '../brain/delegatedScope.js';
import { BrainUsageStore, numeric, rollupDroppedUsage } from './brainUsageStore.js';
import { BrainDelegationStore } from './brainDelegationStore.js';
import type { BrainCard, BrainGoalState } from '../brain/events.js';
import { ProviderRequestStore } from './providerRequestStore.js';
import type { BrainDebugLegacyTranscriptPage } from '../shared/wireContract.js';

// The delegated-execution slice (sub-agent runs/results + workflow-run DAGs) lives in its own store;
// BrainStore is the facade that delegates to it. Re-export the parts of its surface external callers
// still import FROM here so those importers stay unchanged (statusService: BrainWorkflowRun;
// brainService + tests: syntheticRestartResultId). BrainSubagentRun/BrainSubagentResult have no external
// importer (consumed structurally), so they are not re-exported.
export { syntheticRestartResultId } from './brainDelegationStore.js';
export type { BrainWorkflowRun, RecoverableRun, RecoverableWorkflow } from './brainDelegationStore.js';

export interface BrainSessionRow {
  id: string; user_id: number; title: string; model: string; provider: string; work_dir: string; parent_session_id: string | null;
  delegated_access: string | null;
  forked_from_session_id: string | null;
  /** Immutable spill namespace (see schema.sql). '' on rows minted by older builds = "use the id". */
  spill_ns: string;
  /** When /clear last emptied this conversation (see schema.sql) — the only durable evidence that a
   *  conversation with no messages has in fact been used. NULL = never cleared. */
  cleared_at: string | null;
  /** 1 = a direct 1:1 platform chat rather than a shared room (see schema.sql). Legacy rows are 0, which
   *  is the safe reading: everything that widens a permission must require this to be explicitly set. */
  direct: number;
  /** The account that last WROTE here — a different question from `user_id` on a shared room, which is
   *  anchored on the operator because a room has no single author. NULL where nobody identifiable has
   *  written yet (an unlinked sender, or a row older than the column). */
  last_writer_user_id: number | null;
  /** When the step-boundary shutdown drain parked this conversation's live turn (see schema.sql).
   *  NULL = nothing parked; the boot resume sweep continues every marked conversation. */
  parked_at: string | null;
  /** Boot resume attempts on the current park; bumped durably before each attempt, reset on clear. */
  park_attempts: number;
  created_at: string; updated_at: string;
}
/** A boot-resumed platform turn's answer that is computed but not yet posted (see
 *  brain_platform_turn_deliveries in schema.sql). Everything a retry needs and nothing more: the exact
 *  text, the encoded destination, and the sender→account claim the retry must RE-PROVE before posting. */
export interface PendingPlatformDelivery {
  sessionId: string;
  reply: string;
  /** Encoded `destination:` string (plugins/destinations.ts) — fail-closed, never a broadcast. */
  target: string;
  /** The platform half of the captured IDENTITY (envelope.identity.platform), i.e. exactly what the
   *  binding proof is keyed on — not the orchestrator's routing platform. */
  platform: string;
  platformUserId: string;
  accountUserId: number;
  /** Post attempts already made on this answer; bumped durably before each one. */
  attempts: number;
}
type PendingPlatformDeliveryRow = {
  session_id: string; reply: string; target: string;
  platform: string; platform_user_id: string; account_user_id: number; attempts: number;
};
const pendingPlatformDeliveryOf = (row: PendingPlatformDeliveryRow): PendingPlatformDelivery => ({
  sessionId: row.session_id, reply: row.reply, target: row.target, platform: row.platform,
  platformUserId: row.platform_user_id, accountUserId: row.account_user_id, attempts: row.attempts,
});

export interface BrainMessageRow {
  id: string; session_id: string; parent_id: string | null; role: string; content: string; created_at: string;
  usage_epoch: number;
  /** 1 while this is the provisional message_end crash-recovery mirror; 0 once it is display history. */
  pending: number;
  /** Display-only whole-turn wall time, present on the settled run's last assistant row. */
  turn_duration_ms?: number | null;
}
/** One persisted tool-result clearing latch entry (brain_tool_result_spills): everything needed to
 *  re-send a cleared occurrence's placeholder byte-identically after a respawn. `placeholder` is that
 *  exact text (null on legacy rows predating the column — those re-render with the current renderer);
 *  `occurredAt` is the tool-result message's own timestamp, the second half of the occurrence key (0 =
 *  legacy row, matched heuristically); `preview`/`path` are the placeholder's ingredients, stored
 *  verbatim, never recomputed, because reproducing already-sent bytes is the whole point. `createdAt`
 *  is supplied on read for the legacy-row heuristic and ignored on save. Shaped for
 *  toolResultClearing's `ToolResultLatchStore` seam (structural match). */
export interface ToolResultSpillRecord {
  toolCallId: string; occurredAt: number; mode: 'time' | 'preview'; bytes: number; preview: string | null;
  path: string; placeholder: string | null; createdAt?: string;
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
  /** Display metadata for the last assistant row only; never serialized into `content`. */
  turnDurationMs?: number;
}
export interface BrainSearchHit {
  sessionId: string; sessionTitle: string; role: string; snippet: string; ts: string;
}
export type BrainGoalRow = BrainGoalState;
/** A visible, display-only marker of an owner-driven session-state change (see brain_session_events).
 *
 *  The ONE list. It is also the read boundary's validator (getSessionEvents) and must stay in step with
 *  the table's CHECK constraint in schema.sql — a kind the type allows but the boundary rejects writes
 *  fine and then vanishes on the next reload, which no compiler catches: the boundary narrows a `string`
 *  from SQLite, so a stale check there stays perfectly well-typed. */
export const SESSION_EVENT_KINDS = ['model', 'mode', 'rename', 'reasoning', 'cwd', 'subagent', 'workflow'] as const;
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
/** Radius of context kept around a search match in its snippet. */
const SNIPPET_RADIUS = 60;

/** Mint a conversation's immutable spill namespace: the creation-time id for on-disk readability, plus
 *  a random suffix for uniqueness. The suffix is NOT decoration — channel-slot ids are deterministic
 *  and REUSED across generations (`brain-ch-<key>` frees up whenever its occupant is archived), so a
 *  namespace equal to the bare id would make every generation share one spill directory: the new
 *  occupant could read the archived conversation's spills through its pathGuard allowance, and
 *  deleting either conversation would sweep the other's files. */
function mintSpillNamespace(sessionId: string): string {
  return `${sessionId}-${randomUUID().slice(0, 8)}`;
}

/** Persistence for the embedded brain's conversations — the SOLE authoritative store (design D1).
 *  The PI agent session runs in-memory; every settled turn is projected here, and history is
 *  rehydrated from here on start. Exactly one writer (BrainService), so no dual-write drift. */
export class BrainStore {
  /** Usage-accounting views (per-day/per-model spend, descendant-tree totals) live in their own store;
   *  BrainStore is the facade that delegates to it so callers are unchanged. Shares only the Db handle. */
  private readonly usage: BrainUsageStore;
  /** Delegated-execution views (sub-agent runs/results, workflow-run DAGs) live in their own store;
   *  BrainStore is the facade that delegates to it so callers are unchanged. Shares only the Db handle. */
  private readonly delegation: BrainDelegationStore;
  /** Exact provider request attempts and their content-addressed payload segments. Public so the session
   * recorder and later debugger API share one store contract instead of reaching for the raw Db. */
  readonly providerRequests: ProviderRequestStore;
  constructor(private db: Db) {
    this.usage = new BrainUsageStore(db);
    this.delegation = new BrainDelegationStore(db);
    this.providerRequests = new ProviderRequestStore(db);
  }

  private currentUsageEpochForSession(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(r.usage_epoch, 0) AS usage_epoch
         FROM brain_sessions s LEFT JOIN brain_usage_reset_state r ON r.user_id = s.user_id
        WHERE s.id = ?`,
    ).get(sessionId) as { usage_epoch: number } | undefined;
    if (!row) throw new Error(`brain session not found: ${sessionId}`);
    return row.usage_epoch;
  }

  /** Create a top-level or delegated session. A supplied parent must already exist and belong to the
   *  same owner: the relation is later traversed for billing, so accepting a foreign/missing parent
   *  would either leak another user's spend or silently lose the child's. Nested parents are valid. */
  createSession(input: {
    id: string; userId: number; title?: string; model: string;
    /** CONFIG provider entry id the session starts on. Written HERE as well as in touchSession: without
     *  it a brand-new conversation carries a model with no provider, and the pair-restore on respawn
     *  (see ConversationLifecycle.ensureLive) skips it — so the very first respawn would still lose the
     *  model, which is the bug that restore exists to prevent. */
    provider?: string;
    parentSessionId?: string | null;
    /** Immutable execution boundary for a newly-created delegated child. */
    delegatedAccess?: DelegatedExecutionScope;
  }): BrainSessionRow {
    const parentSessionId = input.parentSessionId ?? null;
    const delegatedAccess = input.delegatedAccess === undefined
      ? undefined
      : normalizeDelegatedExecutionScope(input.delegatedAccess);
    if (input.delegatedAccess !== undefined && !delegatedAccess) throw new Error('invalid delegated access');
    if (delegatedAccess && parentSessionId === null) throw new Error('delegated access requires a parent session');
    withWriteLock(this.db, () => {
      if (parentSessionId !== null) {
        const parent = this.db.prepare('SELECT user_id FROM brain_sessions WHERE id = ?').get(parentSessionId) as { user_id: number } | undefined;
        if (!parent) throw new Error(`parent brain session not found: ${parentSessionId}`);
        if (parent.user_id !== input.userId) throw new Error('parent brain session belongs to another user');
      }
      this.db.prepare(
        `INSERT INTO brain_sessions (id, user_id, title, model, provider, parent_session_id, delegated_access, spill_ns)
         VALUES (@id, @user_id, @title, @model, @provider, @parent_session_id, @delegated_access, @spill_ns)`
      ).run({
        id: input.id, user_id: input.userId, title: input.title ?? '', model: input.model,
        provider: input.provider ?? '',
        parent_session_id: parentSessionId,
        delegated_access: delegatedAccess ? JSON.stringify(delegatedAccess) : null,
        spill_ns: mintSpillNamespace(input.id),
      });
    });
    return this.getSession(input.id)!;
  }

  /** Branch a conversation: a NEW session seeded with a copy of the source's transcript, so the user can
   *  take it in a different direction without touching the original thread. ONE transaction — the session
   *  row and every message land together or not at all, so a failure partway through can never leave an
   *  empty orphan row in the picker.
   *
   *  The fork is a PEER of its source, never a delegated child: the origin is recorded in
   *  `forked_from_session_id`, NOT `parent_session_id`. That column means "delegated child" to the usage
   *  roll-up (which would count the copied messages a second time into the source's tree), to the
   *  retention janitor (which never deletes a child), to the sub-agent listing and to the eviction guard
   *  for parents with running children — so reusing it would make a fork look like a running sub-agent.
   *
   *  Copies exactly what a conversation needs to RESUME — owner, model, provider, work_dir and the
   *  transcript. Sidecar state is deliberately NOT copied: sub-agent runs/results, workflow DAGs, cards,
   *  goals and session-event markers all describe work that ran in the SOURCE, and duplicating a running
   *  child's bookkeeping under a second session id would give two conversations a claim on one child.
   *  A fork therefore starts with a clean slate for those.
   *
   *  Message rows are copied with fresh ids (the id is the table's primary key) in transcript order,
   *  keeping their original role, content, timestamp and `pending` flag — a provisional mid-turn row
   *  carries the same "graduate on the next respawn" meaning in the fork as it does in the source.
   *  `parent_id` references source message ids and nothing reads it, so it is dropped rather than left
   *  pointing at another session's rows. */
  forkSession(sourceId: string, newId: string): BrainSessionRow {
    this.db.transaction(() => {
      const source = this.getSession(sourceId);
      if (!source) throw new Error(`brain session not found: ${sourceId}`);
      this.db.prepare(
        `INSERT INTO brain_sessions (id, user_id, title, model, provider, work_dir, forked_from_session_id, spill_ns)
         VALUES (@id, @user_id, @title, @model, @provider, @work_dir, @forked_from_session_id, @spill_ns)`
      ).run({
        id: newId, user_id: source.user_id, title: source.title, model: source.model,
        provider: source.provider, work_dir: source.work_dir, forked_from_session_id: sourceId,
        // A fork gets its OWN namespace: it copies the transcript, never the source's latch rows, so it
        // has no placeholders pointing into the source's spill dir — and sharing one would let either
        // session's deletion sweep the other's files.
        spill_ns: mintSpillNamespace(newId),
      });
      this.db.prepare(
        `INSERT INTO brain_messages (id, session_id, parent_id, role, content, created_at, pending, turn_duration_ms, usage_epoch)
         SELECT lower(hex(randomblob(16))), @new_id, NULL, role, content, created_at, pending, turn_duration_ms, usage_epoch
           FROM brain_messages WHERE session_id = @source_id ORDER BY rowid ASC`
      ).run({ new_id: newId, source_id: sourceId });
    })();
    return this.getSession(newId)!;
  }

  getSession(id: string): BrainSessionRow | undefined {
    return this.db.prepare('SELECT * FROM brain_sessions WHERE id = ?').get(id) as BrainSessionRow | undefined;
  }

  /** Stamp the shutdown park marker (see schema.sql): this conversation's live turn was parked at its
   *  step boundary by a draining daemon and MUST be resumed at the next boot. Written synchronously the
   *  moment the loop parks, so it is durable before the process exits. */
  markSessionParked(id: string): void {
    this.db.prepare("UPDATE brain_sessions SET parked_at = datetime('now') WHERE id = ?").run(id);
  }

  /** Clear the park marker and its attempt counter. Idempotent; called by every path that makes the boot
   *  resume unnecessary or wrong: a successful resume, the sweep failing closed, an explicit user abort
   *  of the parked turn, and the user's own next message (their message is the continuation then). */
  clearSessionPark(id: string): void {
    this.db.prepare('UPDATE brain_sessions SET parked_at = NULL, park_attempts = 0 WHERE id = ?').run(id);
  }

  /** Every conversation the last shutdown parked — the boot resume sweep's worklist. */
  parkedSessions(): BrainSessionRow[] {
    return this.db.prepare('SELECT * FROM brain_sessions WHERE parked_at IS NOT NULL').all() as BrainSessionRow[];
  }

  /** Claim one boot resume attempt: bump the counter, but only while the marker still stands. A false
   *  return means the park was cleared since the sweep read its worklist — the user spoke (their turn
   *  admission clears the marker) or aborted — and the sweep must NOT inject its own continuation on
   *  top. This compare-and-bump is the sweep's ordering rule against concurrent user input. */
  claimParkResumeAttempt(id: string): boolean {
    return this.db.prepare(
      'UPDATE brain_sessions SET park_attempts = park_attempts + 1 WHERE id = ? AND parked_at IS NOT NULL',
    ).run(id).changes > 0;
  }

  /** Result-specific continuation CAS: unlike claimParkResumeAttempt this does not spend the generic park
   * retry budget. It only proves the user has not spoken or aborted since the boot worklist was claimed. */
  claimParkedResultContinuation(id: string): boolean {
    return this.db.prepare(
      'UPDATE brain_sessions SET parked_at = parked_at WHERE id = ? AND parked_at IS NOT NULL',
    ).run(id).changes > 0;
  }

  /** Capture (or replace) the durable resume envelope for a platform channel turn that is about to run
   *  (see brain_platform_turn_envelopes in schema.sql). Written synchronously before the turn's first
   *  async boundary so a process death mid-turn always leaves the row behind. The payload is an opaque
   *  JSON string here on purpose: its shape and validation belong to the brain layer
   *  (normalizePlatformTurnEnvelope), mirroring how delegated_access is stored. */
  savePlatformTurnEnvelope(sessionId: string, envelope: string): void {
    this.db.prepare(
      `INSERT INTO brain_platform_turn_envelopes (session_id, envelope) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET envelope = excluded.envelope, captured_at = datetime('now')`,
    ).run(sessionId, envelope);
  }

  /** The raw captured envelope for one channel session, or undefined when none is in flight — which is
   *  also what every pre-upgrade session reads (the table exists but has no row for it). */
  platformTurnEnvelope(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT envelope FROM brain_platform_turn_envelopes WHERE session_id = ?')
      .get(sessionId) as { envelope: string } | undefined;
    return row?.envelope;
  }

  /** Drop a settled turn's envelope. Idempotent — the settle path calls it unconditionally. */
  clearPlatformTurnEnvelope(sessionId: string): void {
    this.db.prepare('DELETE FROM brain_platform_turn_envelopes WHERE session_id = ?').run(sessionId);
  }

  /** Every envelope left behind by an interrupted turn — a boot sweep's worklist. */
  platformTurnEnvelopes(): { sessionId: string; envelope: string; capturedAt: string }[] {
    return (this.db.prepare(
      'SELECT session_id, envelope, captured_at FROM brain_platform_turn_envelopes ORDER BY captured_at ASC, session_id ASC',
    ).all() as { session_id: string; envelope: string; captured_at: string }[])
      .map((row) => ({ sessionId: row.session_id, envelope: row.envelope, capturedAt: row.captured_at }));
  }

  /** THE PROMOTION: a resumed platform turn's answer stops being "a turn to run" and becomes "a message
   *  to post" (see brain_platform_turn_deliveries in schema.sql). ONE transaction on purpose — the park
   *  marker and the envelope go, the pending delivery appears, and no crash can leave a moment where
   *  both halves exist (two model turns) or neither does (the answer lost). After it returns, the only
   *  durable trace of this turn is text plus a destination: there is nothing left to run a model from. */
  promotePlatformTurnToDelivery(sessionId: string, delivery: {
    reply: string; target: string; platform: string; platformUserId: string; accountUserId: number;
  }): PendingPlatformDelivery {
    return this.db.transaction(() => {
      this.db.prepare('UPDATE brain_sessions SET parked_at = NULL, park_attempts = 0 WHERE id = ?').run(sessionId);
      this.db.prepare('DELETE FROM brain_platform_turn_envelopes WHERE session_id = ?').run(sessionId);
      this.db.prepare(
        `INSERT INTO brain_platform_turn_deliveries
           (session_id, reply, target, platform, platform_user_id, account_user_id, attempts)
         VALUES (@session_id, @reply, @target, @platform, @platform_user_id, @account_user_id, 0)
         ON CONFLICT(session_id) DO UPDATE SET
           reply = excluded.reply, target = excluded.target, platform = excluded.platform,
           platform_user_id = excluded.platform_user_id, account_user_id = excluded.account_user_id,
           attempts = 0, created_at = datetime('now')`,
      ).run({
        session_id: sessionId, reply: delivery.reply, target: delivery.target, platform: delivery.platform,
        platform_user_id: delivery.platformUserId, account_user_id: delivery.accountUserId,
      });
      // Read back rather than echo the input: the caller posts from what is DURABLE, so a row that did
      // not land the way it was written can never be delivered as if it had.
      return this.pendingPlatformDelivery(sessionId)!;
    })();
  }

  /** The computed-but-undelivered answer for one channel session, or undefined when there is none. */
  pendingPlatformDelivery(sessionId: string): PendingPlatformDelivery | undefined {
    const row = this.db.prepare('SELECT * FROM brain_platform_turn_deliveries WHERE session_id = ?')
      .get(sessionId) as PendingPlatformDeliveryRow | undefined;
    return row ? pendingPlatformDeliveryOf(row) : undefined;
  }

  /** Every answer a boot computed but never got posted — the delivery half of the sweep's worklist. */
  pendingPlatformDeliveries(): PendingPlatformDelivery[] {
    return (this.db.prepare(
      'SELECT * FROM brain_platform_turn_deliveries ORDER BY created_at ASC, session_id ASC',
    ).all() as PendingPlatformDeliveryRow[]).map(pendingPlatformDeliveryOf);
  }

  /** Claim one delivery attempt: bump the counter, but only while the row still stands. A false return
   *  means the answer was posted (and the row cleared) since the sweep read its worklist, so this attempt
   *  must not post it a second time. Bumped BEFORE the post, so a boot that dies mid-post still counts. */
  claimPlatformDeliveryAttempt(sessionId: string): boolean {
    return this.db.prepare('UPDATE brain_platform_turn_deliveries SET attempts = attempts + 1 WHERE session_id = ?')
      .run(sessionId).changes > 0;
  }

  /** Drop a delivered (or durably given-up) answer. Idempotent. */
  clearPlatformTurnDelivery(sessionId: string): void {
    this.db.prepare('DELETE FROM brain_platform_turn_deliveries WHERE session_id = ?').run(sessionId);
  }

  /** Read a child's immutable delegation boundary. Both legacy NULL rows and malformed DB JSON are
   * deliberately returned as undefined so callers fail closed before executing a continuation. */
  delegatedAccessFor(sessionId: string): DelegatedExecutionScope | undefined {
    const row = this.getSession(sessionId);
    if (!row?.parent_session_id || !row.delegated_access) return undefined;
    try { return normalizeDelegatedExecutionScope(JSON.parse(row.delegated_access)); }
    catch { return undefined; }
  }

  /** Replace a child's frozen boundary with a PROMOTED one — the only write to `delegated_access` after
   *  the first spawn, and the reason every other path can keep treating that column as immutable.
   *
   *  A compare-and-swap on the exact stored scope, not a plain UPDATE: the caller decided what `next` may
   *  be from a scope it read earlier (see promoteDelegatedScope), so anything that changed the row in
   *  between — a concurrent promotion, a rehydrated stale read — must lose rather than overwrite. Returns
   *  false instead of throwing so the caller can report a retryable conflict. A row with no parent, no
   *  stored scope, or a corrupt one is never upgraded here: those must stay unusable.
   *
   *  It does NOT re-derive authority. Widening rules live entirely in promoteDelegatedScope; this only
   *  persists a decision already made, and refuses `next` if it fails canonical validation. */
  promoteDelegatedAccess(sessionId: string, expected: DelegatedExecutionScope, next: DelegatedExecutionScope): boolean {
    const normalized = normalizeDelegatedExecutionScope(next);
    if (!normalized) throw new Error('invalid delegated access');
    return this.db.transaction(() => {
      if (!this.hasDelegatedAccess(sessionId, expected)) return false;
      this.db.prepare('UPDATE brain_sessions SET delegated_access = ? WHERE id = ?')
        .run(JSON.stringify(normalized), sessionId);
      return true;
    })();
  }

  /** A respawn may only use the exact boundary originally minted for this durable child. It never writes
   * a missing/changed value: legacy or corrupt rows stay unusable rather than being upgraded by request input. */
  hasDelegatedAccess(sessionId: string, supplied: DelegatedExecutionScope): boolean {
    const stored = this.delegatedAccessFor(sessionId);
    const normalized = normalizeDelegatedExecutionScope(supplied);
    return !!stored && !!normalized && sameDelegatedExecutionScope(stored, normalized);
  }

  /** EVERY user's sessions, each carrying its owner's display name, for the admin oversight register.
   *  Deliberately a separate method rather than an optional argument on `listSessions`: a listing that
   *  crosses accounts must be asked for explicitly, never reached by forgetting to pass a user id.
   *  The name is resolved by JOIN at read time, so renaming an account renames it here too. */
  listAllSessionsWithOwner(): (BrainSessionRow & { owner_name: string; owner_username: string; writer_name: string; writer_username: string })[] {
    // The writer is resolved by a SECOND join on the same users table — like the owner name it is never
    // denormalized, so renaming an account renames it throughout the register's history too.
    return this.db.prepare(
      `SELECT s.*,
              COALESCE(u.name, '') AS owner_name, COALESCE(u.username, '') AS owner_username,
              COALESCE(w.name, '') AS writer_name, COALESCE(w.username, '') AS writer_username
         FROM brain_sessions s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN users w ON w.id = s.last_writer_user_id
        ORDER BY s.updated_at DESC, s.rowid ASC`
    ).all() as (BrainSessionRow & { owner_name: string; owner_username: string; writer_name: string; writer_username: string })[];
  }

  private tokenTotalRows(userId?: number): { id: string; tokens: number }[] {
    const scoped = userId === undefined ? '' : 'AND owner.user_id = ?';
    const outer = userId === undefined ? '' : 'WHERE s.user_id = ?';
    const params = userId === undefined ? [] : [userId, userId, userId];
    return this.db.prepare(
      `WITH usage_rows AS (
         SELECT m.session_id AS id, ${numeric('m.content', '$.usage.totalTokens')} AS tokens
           FROM brain_sessions owner
           JOIN brain_messages m ON m.session_id = owner.id
           LEFT JOIN brain_usage_reset_state reset ON reset.user_id = owner.user_id
          WHERE m.role = 'assistant' AND m.usage_epoch = COALESCE(reset.usage_epoch, 0)
            AND json_valid(m.content) AND json_type(m.content) = 'object' ${scoped}
         UNION ALL
         SELECT m.session_id AS id, ${numeric('je.value', '$.totalTokens')} AS tokens
           FROM brain_sessions owner
           JOIN brain_messages m ON m.session_id = owner.id
           LEFT JOIN brain_usage_reset_state reset ON reset.user_id = owner.user_id,
                json_each(CASE WHEN json_valid(m.content)
                               THEN CASE WHEN json_type(m.content, '$.usageRollup') = 'array'
                                         THEN json_extract(m.content, '$.usageRollup') END END) je
          WHERE m.role = 'compaction' AND je.type = 'object'
            AND CASE WHEN json_type(je.value, '$.usageEpoch') = 'integer'
                     THEN json_extract(je.value, '$.usageEpoch') ELSE m.usage_epoch END = COALESCE(reset.usage_epoch, 0)
            ${scoped}
       )
       SELECT s.id AS id, COALESCE(SUM(usage_rows.tokens), 0) AS tokens
         FROM brain_sessions s LEFT JOIN usage_rows ON usage_rows.id = s.id
         ${outer}
        GROUP BY s.id`
    ).all(...params) as { id: string; tokens: number }[];
  }

  /** Token totals across every account — the cross-account counterpart of {@link tokenTotals}. */
  tokenTotalsAll(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.tokenTotalRows()) out[row.id] = row.tokens ?? 0;
    return out;
  }

  /** Empty shells across every account — the cross-account counterpart of {@link unspokenSessionIds}. */
  unspokenSessionIdsAll(): Set<string> {
    const rows = this.db.prepare(
      `SELECT s.id FROM brain_sessions s
       WHERE s.cleared_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM brain_messages m WHERE m.session_id = s.id)`
    ).all() as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  listSessions(userId: number): BrainSessionRow[] {
    return this.db.prepare('SELECT * FROM brain_sessions WHERE user_id = ? ORDER BY updated_at DESC, rowid ASC')
      .all(userId) as BrainSessionRow[];
  }

  /** The user's sessions that hold no message at all. A live session owns its row from the moment it
   *  spawns — that is what the delegation parent check, the work-dir binding and every ownership check
   *  read — but a row nobody has spoken into is not yet a CONVERSATION: it is the empty shell the CLI
   *  leaves behind simply by launching. One query, so a listing can filter without an N+1.
   *
   *  A CLEARED conversation is empty for the opposite reason — it was used and then deliberately emptied
   *  by /clear — so `cleared_at` excludes it here. Without that it would silently disappear from the
   *  session picker and the history rail, and be swept by dropIfUnspoken on the next quit. */
  unspokenSessionIds(userId: number): Set<string> {
    const rows = this.db.prepare(
      `SELECT s.id FROM brain_sessions s
       WHERE s.user_id = ? AND s.cleared_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM brain_messages m WHERE m.session_id = s.id)`
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
         AND s.updated_at < datetime('now', '-${d} days')
         AND EXISTS (SELECT 1 FROM brain_messages m WHERE m.session_id = s.id)
         AND (
           -- The caller's own conversations: only roots, so a child is never deleted out from under
           -- the transcript that links to it.
           (s.parent_session_id IS NULL AND s.id NOT LIKE '${CHANNEL_PREFIX}%')
           -- One-shot runs (see isEphemeralRunSession): judged on their OWN age, parent or not. A
           -- finished delegation is finished whether or not the conversation that started it lives on,
           -- and these are what actually accumulate. A real platform channel stays excluded.
           OR s.id LIKE '${SUBAGENT_PREFIX}%'
           OR s.id LIKE '${CRON_PREFIX}%'
           -- Archived channel transcripts: a channel that sat quiet past the idle cutoff is rolled over
           -- (its prompt cache has expired), the old transcript is re-keyed under a unique -arch- id and
           -- the deterministic channel id is freed for a fresh session. mayDeliverToSession refuses the
           -- archive outright, so nothing will ever be added to it again. Matched loosely here and
           -- narrowed by the exact predicate below — a channel NAME could contain "-arch-" and must not
           -- be mistaken for an archive while it is still live.
           OR s.id LIKE '%-arch-%'
         )`
    ).all(userId) as { id: string }[];
    return rows
      .map((row) => row.id)
      .filter((id) => !id.includes('-arch-') || isArchivedChannelSession(id));
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

  /** Daily token/cost spend of the user's own brain sessions for the dashboard tiles — see
   *  {@link BrainUsageStore.usageByDay}. */
  usageByDay(userId: number, days = 7): ReturnType<BrainUsageStore['usageByDay']> {
    return this.usage.usageByDay(userId, days);
  }

  /** Per-model token/cost spend of the user's own brain chat sessions for the Stats page — see
   *  {@link BrainUsageStore.usageByModel}. */
  usageByModel(userId: number, window?: { fromIso?: string; toIso?: string }): ReturnType<BrainUsageStore['usageByModel']> {
    return this.usage.usageByModel(userId, window);
  }

  /** Atomically advance chat usage, zero the small provider summaries and clear the independent origin
   * counters. Historical messages, projection rows and provider request payloads are never rewritten. */
  resetUsage(userId: number, clearOrigins: () => number = () => 0): { chatCleared: number; originsCleared: number } {
    return this.db.transaction(() => {
      const chatCleared = this.usage.advanceUsageEpoch(userId);
      this.providerRequests.resetUsageSummariesForUser(userId);
      const originsCleared = clearOrigins();
      return { chatCleared, originsCleared };
    })();
  }

  /** Backwards-compatible store facade: one successful logical reset, not a count of historical rows. */
  clearUsage(userId: number): number {
    return this.resetUsage(userId).chatCleared;
  }

  /** Cumulative token total per session for the current usage epoch. Live assistant usage and compaction
   * rollup buckets share the same normalized rules, so compacting current history cannot make this panel
   * lose spend and pre-reset buckets cannot leak back into it. Persisted rows only, so a mid-turn session
   * reads slightly stale (acceptable). */
  tokenTotals(userId: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.tokenTotalRows(userId)) out[row.id] = row.tokens ?? 0;
    return out;
  }

  /** Cumulative token/cost total of a session's whole delegated descendant tree — see
   *  {@link BrainUsageStore.descendantUsage}. */
  descendantUsage(sessionId: string): ReturnType<BrainUsageStore['descendantUsage']> {
    return this.usage.descendantUsage(sessionId);
  }

  appendMessage(input: { id: string; sessionId: string; parentId: string | null; role: string; content: unknown; turnDurationMs?: number }): BrainMessageRow {
    this.db.prepare(
      `INSERT INTO brain_messages (id, session_id, parent_id, role, content, turn_duration_ms, usage_epoch)
       VALUES (@id, @session_id, @parent_id, @role, @content, @turn_duration_ms,
               (SELECT COALESCE(r.usage_epoch, 0) FROM brain_sessions s
                 LEFT JOIN brain_usage_reset_state r ON r.user_id = s.user_id WHERE s.id = @session_id))`
    ).run({
      id: input.id, session_id: input.sessionId, parent_id: input.parentId,
      role: input.role, content: JSON.stringify(input.content), turn_duration_ms: input.turnDurationMs ?? null,
    });
    return this.db.prepare('SELECT * FROM brain_messages WHERE id = ?').get(input.id) as BrainMessageRow;
  }

  /** Finalize display-only timing after PI's canonical `agent_settled`. This updates only the side column:
   *  `content` (the provider-visible message bytes) and its usage-rollup update trigger are untouched. */
  setTurnDuration(messageId: string, sessionId: string, durationMs: number): void {
    this.db.prepare('UPDATE brain_messages SET turn_duration_ms = ? WHERE id = ? AND session_id = ?')
      .run(Math.max(0, Math.round(durationMs)), messageId, sessionId);
  }

  /** The newest message rowid, as a change stamp for callers that cache a derived read.
   *
   *  `MAX(rowid)` is free (SQLite reads the last b-tree page) where `MAX(created_at)` costs ~60 ms on
   *  this table, because only `session_id` is indexed. Any new message raises it, so a cache keyed on
   *  it refreshes the moment work happens instead of on a timer. */
  lastMessageRowId(): number {
    const row = this.db.prepare('SELECT MAX(rowid) AS id FROM brain_messages').get() as { id: number | null };
    return row.id ?? 0;
  }

  /** Which tools each session ran recently, newest first — what the activity feed draws under a name.
   *
   *  Read from `brain_messages` because tool calls are recorded nowhere else: `events` knows only THAT
   *  somebody took a turn, and `brain_session_events` tracks delegations alone. The read is therefore
   *  HARD-BOUNDED by both a time window and a row cap rather than left open-ended — better-sqlite3 is
   *  synchronous, so every row parsed here is time the daemon's event loop spends serving nobody else.
   *  Measured at ~86 ms for 300 rows on the live database, which is why the caller caches it.
   *
   *  A malformed row is skipped rather than thrown on: this feeds a decorative column, and one unparseable
   *  message must not take down the whole timeline. */
  recentToolCalls(opts: { sinceHours: number; limit: number }): Map<string, { at: string; names: string[] }[]> {
    const hours = Math.max(1, Math.min(48, Math.trunc(opts.sinceHours)));
    const limit = Math.max(1, Math.min(20_000, Math.trunc(opts.limit)));
    // The names are extracted by SQLite rather than by parsing message bodies in JS. Both cost about the
    // same per row, but this never hands multi-kilobyte transcript JSON to the JS heap, so the SAME
    // ~95 ms covers the whole six-hour window instead of the ~400 newest messages (measured on the live
    // database: 2132 tool calls across 27 sessions, versus 418 from one hour). `json_valid` keeps a
    // corrupt row from aborting the query — this feeds a decorative column and must never be fatal.
    const rows = this.db.prepare(
      `SELECT m.session_id AS sessionId, m.created_at AS at, je.value ->> '$.name' AS name
         FROM brain_messages m, json_each(m.content, '$.content') je
        WHERE m.role = 'assistant'
          AND m.created_at >= datetime('now', ?)
          AND json_valid(m.content)
          AND je.value ->> '$.type' = 'toolCall'
          AND je.value ->> '$.name' IS NOT NULL
        ORDER BY m.created_at DESC
        LIMIT ?`
    ).all(`-${hours} hours`, limit) as { sessionId: string; at: string; name: string }[];

    // Re-fold into one entry per message timestamp, which is the shape the caller matches on.
    const out = new Map<string, { at: string; names: string[] }[]>();
    for (const row of rows) {
      const list = out.get(row.sessionId) ?? [];
      const last = list[list.length - 1];
      if (last && last.at === row.at) last.names.push(row.name);
      else list.push({ at: row.at, names: [row.name] });
      out.set(row.sessionId, list);
    }
    return out;
  }

  /** Seed one brand-new conversation with imported platform transcript rows. The empty-session check and
   *  every insert share one SQLite transaction, so a crash cannot leave a partial history prefix. */
  seedMessages(sessionId: string, messages: readonly { id: string; role: string; content: unknown }[]): number {
    if (!messages.length) return 0;
    return this.db.transaction(() => {
      const exists = this.db.prepare('SELECT 1 FROM brain_messages WHERE session_id = ? LIMIT 1').get(sessionId);
      if (exists) return 0;
      for (const message of messages) {
        const content = message.content as { role?: unknown; content?: unknown } | null;
        const validId = typeof message.id === 'string' && message.id.trim().length > 0 && message.id.length <= 256;
        const validRole = message.role === 'user' || message.role === 'assistant';
        const assistantBlocks = content?.content;
        const validAssistant = Array.isArray(assistantBlocks) && assistantBlocks.length > 0 && assistantBlocks.length <= 16
          && assistantBlocks.every((block) => block !== null && typeof block === 'object' && !Array.isArray(block)
            && (block as { type?: unknown }).type === 'text'
            && typeof (block as { text?: unknown }).text === 'string');
        const validContent = content !== null && typeof content === 'object' && !Array.isArray(content)
          && content.role === message.role
          && (message.role === 'user'
            ? typeof content.content === 'string' && content.content.length <= 64_000
            : validAssistant);
        if (!validId || !validRole || !validContent) throw new TypeError('invalid seeded platform message');
      }
      const insert = this.db.prepare(
        `INSERT INTO brain_messages (id, session_id, parent_id, role, content, usage_epoch)
         VALUES (@id, @session_id, NULL, @role, @content,
                 (SELECT COALESCE(r.usage_epoch, 0) FROM brain_sessions s
                   LEFT JOIN brain_usage_reset_state r ON r.user_id = s.user_id WHERE s.id = @session_id))`,
      );
      for (const message of messages) {
        insert.run({ id: message.id, session_id: sessionId, role: message.role, content: JSON.stringify(message.content) });
      }
      this.touchSession(sessionId);
      return messages.length;
    })();
  }

  /** Remove one message only from its expected session. Used to roll back a pre-projected user row when
   * PI rejects a prompt before its native preflight boundary; the session condition prevents a stale
   * caller from deleting a row that compaction/session migration moved elsewhere. */
  deleteMessage(sessionId: string, messageId: string): boolean {
    return this.db.prepare('DELETE FROM brain_messages WHERE id = ? AND session_id = ?')
      .run(messageId, sessionId).changes > 0;
  }

  /** Delete a message AND every message after it in the same session (by rowid, the canonical transcript
   *  order) — literally to the END of the session, not to the end of a turn: the SQL has no upper bound.
   *  Used to discard a whole aborted user turn: the user row plus any partial assistant output its
   *  agent_end persisted before the abort landed — deleting only the user row would leave an answer
   *  fragment with no question after a reconnect. Safe only because the caller passes the TRAILING user
   *  turn (discard is refused once the turn produced output), so there is nothing later to lose; handing
   *  it an id from the middle of a transcript would take out everything below it. Returns the number of
   *  rows removed (0 if the id is unknown / in another session). */
  deleteMessagesFrom(sessionId: string, fromId: string): number {
    const row = this.db.prepare('SELECT rowid FROM brain_messages WHERE id = ? AND session_id = ?')
      .get(fromId, sessionId) as { rowid: number } | undefined;
    if (!row) return 0;
    return this.db.prepare('DELETE FROM brain_messages WHERE session_id = ? AND rowid >= ?')
      .run(sessionId, row.rowid).changes;
  }

  /** Mirror ONE message the moment PI finishes it, so a daemon restart mid-turn no longer discards the
   *  whole run. Provisional by construction: these rows never outlive their turn — `persistAgentRun`
   *  drops every pending row in the same transaction that writes the settled run in PI's real execution
   *  order, and rows that survive at all are the remains of a turn that never settled, graduated by
   *  `settlePartialTurn` on respawn. The caller mints the id: PI's `message_end` carries the finished
   *  message but no entry id of its own. */
  appendPendingMessage(input: { id: string; sessionId: string; role: string; content: unknown }): void {
    this.db.prepare(
      `INSERT INTO brain_messages (id, session_id, parent_id, role, content, pending, usage_epoch)
       VALUES (@id, @session_id, NULL, @role, @content, 1,
               (SELECT COALESCE(r.usage_epoch, 0) FROM brain_sessions s
                 LEFT JOIN brain_usage_reset_state r ON r.user_id = s.user_id WHERE s.id = @session_id))
       ON CONFLICT(id) DO NOTHING`
    ).run({ id: input.id, session_id: input.sessionId, role: input.role, content: JSON.stringify(input.content) });
  }

  /** Persist one cleared tool result's placeholder state (see brain_tool_result_spills in schema.sql).
   *  Upsert, because an EEXIST reconciliation legitimately re-latches the same occurrence key. */
  upsertToolResultSpill(sessionId: string, spill: ToolResultSpillRecord): void {
    this.db.prepare(
      `INSERT INTO brain_tool_result_spills (session_id, tool_call_id, occurred_at, mode, bytes, preview, path, placeholder)
       VALUES (@session_id, @tool_call_id, @occurred_at, @mode, @bytes, @preview, @path, @placeholder)
       ON CONFLICT(session_id, tool_call_id, occurred_at) DO UPDATE SET
         mode = excluded.mode, bytes = excluded.bytes, preview = excluded.preview,
         path = excluded.path, placeholder = excluded.placeholder`
    ).run({
      session_id: sessionId, tool_call_id: spill.toolCallId, occurred_at: spill.occurredAt, mode: spill.mode,
      bytes: spill.bytes, preview: spill.preview, path: spill.path, placeholder: spill.placeholder,
    });
  }

  /** Drop one latch row by its occurrence key — toolResultClearing prunes a row whose occurrence a
   *  compaction removed from the history, so it can never capture a later reuse of the same id. */
  deleteToolResultSpill(sessionId: string, toolCallId: string, occurredAt: number): void {
    this.db.prepare(
      'DELETE FROM brain_tool_result_spills WHERE session_id = ? AND tool_call_id = ? AND occurred_at = ?'
    ).run(sessionId, toolCallId, occurredAt);
  }

  /** Every persisted latch row of one session, oldest first (insertion order — the order they were
   *  cleared in, though restoration does not depend on it). */
  toolResultSpills(sessionId: string): ToolResultSpillRecord[] {
    const rows = this.db.prepare(
      'SELECT tool_call_id, occurred_at, mode, bytes, preview, path, placeholder, created_at FROM brain_tool_result_spills WHERE session_id = ? ORDER BY rowid ASC'
    ).all(sessionId) as { tool_call_id: string; occurred_at: number; mode: string; bytes: number; preview: string | null; path: string; placeholder: string | null; created_at: string }[];
    return rows.map((row) => ({
      toolCallId: row.tool_call_id,
      occurredAt: row.occurred_at,
      // Only the daemon writes this table, so anything but the two known modes means manual DB surgery;
      // 'time' (no preview in the placeholder) is the conservative reading of an unknown value.
      mode: row.mode === 'preview' ? 'preview' : 'time',
      bytes: row.bytes, preview: row.preview, path: row.path, placeholder: row.placeholder,
      createdAt: row.created_at,
    }));
  }

  /** The session's immutable spill namespace — '' (older rows before backfill, unknown ids) falls back
   *  to the id itself, which is exactly where a pre-namespace build put the files. */
  spillNamespace(sessionId: string): string {
    const row = this.db.prepare('SELECT spill_ns FROM brain_sessions WHERE id = ?').get(sessionId) as { spill_ns: string } | undefined;
    return row?.spill_ns || sessionId;
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
      const usageEpoch = this.currentUsageEpochForSession(sessionId);
      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ? AND pending = 1').run(sessionId);
      const userCount = messages.filter((message) => message.reusePreprojectedUser).length;
      if (userCount === 0) return false;
      const rows = this.db.prepare(
        'SELECT id, session_id, parent_id, role, content, created_at, pending, turn_duration_ms, usage_epoch FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC'
      ).all(sessionId) as BrainMessageRow[];
      // The pre-projected users must still be the transcript's trailing user rows — the same turn
      // boundary `newestTurnStart` (../brain/messageView.js) cuts on, seen from the tail. Anything that
      // landed after them would make this slice non-user and correctly fall back to the append path
      // instead of splicing foreign rows into the run's order.
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
          pending: 0,
          turn_duration_ms: message.turnDurationMs ?? null,
          usage_epoch: usageEpoch,
        });
      }
      if (nextUser !== users.length) return false;

      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ?').run(sessionId);
      const insert = this.db.prepare(
        `INSERT INTO brain_messages (id, session_id, parent_id, role, content, created_at, pending, turn_duration_ms, usage_epoch)
         VALUES (@id, @session_id, @parent_id, @role, @content, @created_at, @pending, @turn_duration_ms, @usage_epoch)`
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

  /** Raw transcript rows, including provisional message_end mirrors. Recovery, compaction alignment and
   *  diagnostics need this exact on-disk state; user-facing history must use getSettledMessages instead. */
  getMessages(sessionId: string): BrainMessageRow[] {
    return this.db.prepare('SELECT * FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC')
      .all(sessionId) as BrainMessageRow[];
  }

  /** The one user-facing transcript read model. Pending rows remain queryable through getMessages for crash
   *  recovery, but cannot consume a display window slot or shift the cursor shared by snapshot and paging. */
  getSettledMessages(sessionId: string): BrainMessageRow[] {
    return this.db.prepare('SELECT * FROM brain_messages WHERE session_id = ? AND pending = 0 ORDER BY rowid ASC')
      .all(sessionId) as BrainMessageRow[];
  }

  /** Best-effort transcript for admin diagnostics of sessions created before exact provider capture.
   *  This is deliberately session-indexed and lazy: the global debugger listings never touch brain_messages. */
  debugLegacyTranscript(sessionId: string, opts: { cursor?: string; limit?: number; maxBytes?: number } = {}): BrainDebugLegacyTranscriptPage | undefined {
    if (!this.getSession(sessionId)) return undefined;
    let after = 0;
    if (opts.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8')) as { rowid?: unknown };
        if (!Number.isInteger(decoded.rowid) || Number(decoded.rowid) < 0) throw new Error();
        after = Number(decoded.rowid);
      } catch { throw new Error('invalid debug cursor'); }
    }
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(100, Math.floor(opts.limit!))) : 50;
    const maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(1, Math.min(4 * 1024 * 1024, Math.floor(opts.maxBytes!))) : 256 * 1024;
    const candidates = this.db.prepare(
      `SELECT rowid cursor, id, role, created_at, length(CAST(content AS BLOB)) byte_length
         FROM brain_messages WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?`
    ).all(sessionId, after, limit + 1) as { cursor: number; id: string; role: string; created_at: string; byte_length: number }[];
    const accepted: typeof candidates = [];
    let loadedBytes = 0;
    for (const row of candidates.slice(0, limit)) {
      if (row.byte_length > maxBytes - loadedBytes) {
        if (accepted.length === 0) throw new Error(`debug payload exceeds byte limit:${row.byte_length}`);
        break;
      }
      accepted.push(row);
      loadedBytes += row.byte_length;
    }
    const hasMore = candidates.length > accepted.length;
    const contentByCursor = new Map<number, string>();
    if (accepted.length > 0) {
      const placeholders = accepted.map(() => '?').join(',');
      const contents = this.db.prepare(
        `SELECT rowid cursor, content FROM brain_messages WHERE session_id = ? AND rowid IN (${placeholders})`
      ).all(sessionId, ...accepted.map((row) => row.cursor)) as { cursor: number; content: string }[];
      for (const row of contents) contentByCursor.set(row.cursor, row.content);
    }
    const items: BrainDebugLegacyTranscriptPage['items'] = accepted.map((row) => {
      const stored = contentByCursor.get(row.cursor);
      if (stored === undefined) throw new Error(`brain message missing during debug read: ${row.id}`);
      let content: unknown;
      try { content = JSON.parse(stored) as unknown; }
      catch { content = stored; }
      return { cursor: row.cursor, id: row.id, role: row.role, content, createdAt: row.created_at, byteLength: row.byte_length };
    });
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ rowid: last.cursor })).toString('base64url') : null,
      loadedBytes,
      exact: false,
    };
  }

  /** The newest turn's rows only — everything after the last user message (or the whole session when it
   *  has none yet). Lets a hot status poll read a still-pending plan off durable history without loading
   *  the entire conversation the way getMessages does.
   *
   *  This SQL is the mirror of `newestTurnStart` in ../brain/messageView.js, the canonical TS definition
   *  of the same boundary; it must stay SQL so the poll never loads the whole history. Keep the two in
   *  step — tests/store/turnBoundary.test.ts verifies they cut the same boundary for the same rows. */
  getLatestTurn(sessionId: string): BrainMessageRow[] {
    const floor = (this.db.prepare("SELECT MAX(rowid) AS r FROM brain_messages WHERE session_id = ? AND role = 'user'")
      .get(sessionId) as { r: number | null }).r ?? 0;
    return this.db.prepare('SELECT * FROM brain_messages WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC')
      .all(sessionId, floor) as BrainMessageRow[];
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

  /** Stamp this daemon boot's identity onto the delegation store, so a `running` sub-agent row records the
   *  boot that owns it and a later boot can tell a restart orphan from live work — see
   *  {@link BrainDelegationStore.setBootId}. Called once at daemon start. */
  setDelegationBootId(bootId: string): void {
    this.delegation.setBootId(bootId);
  }

  /** The current daemon boot id — see {@link BrainDelegationStore.currentBootId}. */
  delegationBootId(): string {
    return this.delegation.currentBootId();
  }

  /** Persist the newest progress snapshot for one delegate tool call — see
   *  {@link BrainDelegationStore.upsertSubagentRun}. */
  upsertSubagentRun(
    parentSessionId: string,
    raw: unknown,
    durableStatus?: 'running' | 'done' | 'error',
  ): boolean {
    return this.delegation.upsertSubagentRun(parentSessionId, raw, durableStatus);
  }

  /** The still-valid direct same-owner sub-agent runs of a conversation — see
   *  {@link BrainDelegationStore.getSubagentRuns}. */
  getSubagentRuns(parentSessionId: string): ReturnType<BrainDelegationStore['getSubagentRuns']> {
    return this.delegation.getSubagentRuns(parentSessionId);
  }

  /** The child sessions durably claimed for restart recovery — see
   *  {@link BrainDelegationStore.recoveringSubagentSessionIds}. */
  recoveringSubagentSessionIds(parentSessionId: string): ReturnType<BrainDelegationStore['recoveringSubagentSessionIds']> {
    return this.delegation.recoveringSubagentSessionIds(parentSessionId);
  }

  /** Claim every restart-orphaned delegation for this boot — see
   *  {@link BrainDelegationStore.claimRecoverableRuns}. */
  claimRecoverableRuns(leaseMs: number): ReturnType<BrainDelegationStore['claimRecoverableRuns']> {
    return this.delegation.claimRecoverableRuns(leaseMs);
  }

  /** Claim every restart-orphaned workflow for this boot — see
   *  {@link BrainDelegationStore.claimRecoverableWorkflows}. */
  claimRecoverableWorkflows(): ReturnType<BrainDelegationStore['claimRecoverableWorkflows']> {
    return this.delegation.claimRecoverableWorkflows();
  }

  /** Release a run claim superseded by boot workflow resume — see
   *  {@link BrainDelegationStore.supersedeClaimedRun}. */
  supersedeClaimedRun(parentSessionId: string, toolCallId: string, reason: string): boolean {
    return this.delegation.supersedeClaimedRun(parentSessionId, toolCallId, reason);
  }

  /** Zero a workflow's resume-attempt counter after a successful resume — see
   *  {@link BrainDelegationStore.clearWorkflowClaimAttempts}. */
  clearWorkflowClaimAttempts(parentSessionId: string, toolCallId: string): void {
    this.delegation.clearWorkflowClaimAttempts(parentSessionId, toolCallId);
  }

  /** Park a claimed run as recovery_required — see {@link BrainDelegationStore.markRecoveryRequired}. */
  markRecoveryRequired(parentSessionId: string, toolCallId: string, reason: string, raw: unknown): boolean {
    return this.delegation.markRecoveryRequired(parentSessionId, toolCallId, reason, raw);
  }

  /** Terminalize a claimed run and enqueue its result in one transaction — see
   *  {@link BrainDelegationStore.completeRecoveredRun}. */
  completeRecoveredRun(parentSessionId: string, toolCallId: string, raw: unknown): boolean {
    return this.delegation.completeRecoveredRun(parentSessionId, toolCallId, raw);
  }

  /** The delegated sub-agents one conversation spawned, newest first — see
   *  {@link BrainDelegationStore.listDelegatedChildren}. */
  listDelegatedChildren(parentSessionId: string, limit?: number): ReturnType<BrainDelegationStore['listDelegatedChildren']> {
    return this.delegation.listDelegatedChildren(parentSessionId, limit);
  }

  /** Persist the newest whole-DAG workflow snapshot for one tool call — see
   *  {@link BrainDelegationStore.upsertWorkflowRun}. */
  upsertWorkflowRun(parentSessionId: string, raw: unknown): boolean {
    return this.delegation.upsertWorkflowRun(parentSessionId, raw);
  }

  /** The durable workflow DAGs of one conversation, drill-in targets re-derived from the live relation —
   *  see {@link BrainDelegationStore.getWorkflowRuns}. */
  getWorkflowRuns(parentSessionId: string): ReturnType<BrainDelegationStore['getWorkflowRuns']> {
    return this.delegation.getWorkflowRuns(parentSessionId);
  }

  /** The persisted status of ONE workflow — the finish-marker guard reads only this, never the whole DAG
   *  (getWorkflowRuns would parse every snapshot of the conversation on a live tick) — see
   *  {@link BrainDelegationStore.workflowStatus}. */
  workflowStatus(parentSessionId: string, workflowId: string): ReturnType<BrainDelegationStore['workflowStatus']> {
    return this.delegation.workflowStatus(parentSessionId, workflowId);
  }

  hasRunningWorkflow(parentSessionId: string): boolean {
    return this.delegation.hasRunningWorkflow(parentSessionId);
  }

  runningWorkflowIds(parentSessionId: string, limit?: number): string[] {
    return this.delegation.runningWorkflowIds(parentSessionId, limit);
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
    return { id, kind, detail, at: dbTsToIso(row.created_at) };
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
      out.push({ id: row.event_id, kind: row.kind, detail: row.detail, at: dbTsToIso(row.created_at) });
    }
    return out;
  }

  /** Persist a terminal child result before any attempt to wake the parent — see
   *  {@link BrainDelegationStore.enqueueSubagentResult}. */
  enqueueSubagentResult(parentSessionId: string, raw: unknown): boolean {
    return this.delegation.enqueueSubagentResult(parentSessionId, raw);
  }

  /** Persist a terminal workflow result into the shared delegated-result inbox — see
   *  {@link BrainDelegationStore.enqueueWorkflowResult}. */
  enqueueWorkflowResult(parentSessionId: string, raw: unknown): boolean {
    return this.delegation.enqueueWorkflowResult(parentSessionId, raw);
  }

  /** The parent's still-undelivered child results, oldest first — see
   *  {@link BrainDelegationStore.pendingSubagentResults}. */
  pendingSubagentResults(parentSessionId: string): ReturnType<BrainDelegationStore['pendingSubagentResults']> {
    return this.delegation.pendingSubagentResults(parentSessionId);
  }

  /** @see BrainDelegationStore.countPendingDeliveries */
  countPendingDeliveries(): number {
    return this.delegation.countPendingDeliveries();
  }

  /** @see BrainDelegationStore.pendingDeliveryParentSessionIds */
  pendingDeliveryParentSessionIds(): string[] {
    return this.delegation.pendingDeliveryParentSessionIds();
  }

  /** @see BrainDelegationStore.hasPendingDelivery */
  hasPendingDelivery(parentSessionId: string): boolean {
    return this.delegation.hasPendingDelivery(parentSessionId);
  }

  pendingDeliveryWakeAttempts(parentSessionId: string): number {
    return this.delegation.pendingDeliveryWakeAttempts(parentSessionId);
  }

  notePendingDeliveryWakeFailure(parentSessionId: string): number {
    return this.delegation.notePendingDeliveryWakeFailure(parentSessionId);
  }

  abandonPendingDeliveries(parentSessionId: string): number {
    return this.delegation.abandonPendingDeliveries(parentSessionId);
  }

  /** @see BrainDelegationStore.discardOrphanedDeliveries */
  discardOrphanedDeliveries(): number {
    return this.delegation.discardOrphanedDeliveries();
  }

  acknowledgeSubagentResult(parentSessionId: string, resultId: string): boolean {
    return this.delegation.acknowledgeSubagentResult(parentSessionId, resultId);
  }

  requeueSubagentResult(parentSessionId: string, resultId: string): boolean {
    return this.delegation.requeueSubagentResult(parentSessionId, resultId);
  }

  noteSubagentResultFailure(parentSessionId: string, resultId: string): void {
    this.delegation.noteSubagentResultFailure(parentSessionId, resultId);
  }

  /** The user's OWN words in one conversation inside a UTC window — the dashboard digest's transcript
   *  sample. Bounded per session and read through idx_brain_messages_session (never a full-table scan;
   *  tests/store/dashDigestPlan.test.ts pins the plan). Synthetic meta rows (memory recall injections)
   *  are skipped — they are the daemon talking to the model, not the user talking. */
  userMessagesBetween(sessionId: string, fromIso: string, toIso: string, limit: number): string[] {
    const rows = this.db.prepare(
      `SELECT content FROM brain_messages
        WHERE session_id = ? AND role = 'user' AND created_at >= ? AND created_at < ?
        ORDER BY rowid DESC LIMIT ?`
    ).all(sessionId, fromIso, toIso, Math.max(1, limit)) as { content: string }[];
    const out: string[] = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.content) as { isMeta?: boolean };
        if (parsed && typeof parsed === 'object' && parsed.isMeta) continue;
        const text = extractText(parsed).trim();
        if (text) out.push(text);
      } catch { /* non-JSON legacy row — not a user utterance we can quote */ }
    }
    return out.reverse(); // oldest first, the order a reader expects
  }

  /** Case-insensitive fulltext search across the user's OWN chat conversations. Shared platform
   *  sessions (`brain-ch-*`, which carry other members' messages) are excluded — the search backs the
   *  personal chat sidebar, not the Discord logs.
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
          AND m.session_id NOT LIKE '${CHANNEL_PREFIX}%'
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

  /** Mark (or unmark) a platform conversation as a DIRECT 1:1 chat — see `direct` in schema.sql. Written
   *  on every inbound platform message rather than only at creation, because the flag is a property of the
   *  CONVERSATION, not of the moment the row happened to be minted: rows created before this column
   *  existed would otherwise stay 0 forever and a private DM would keep behaving like a shared room.
   *  Deliberately does NOT touch `user_id` — re-pointing an existing transcript (with its usage, spills and
   *  processes) at a different account is not something a routine message should do silently. The single
   *  narrow exception is {@link adoptPersonalChat}, which states its own case. */
  setDirect(id: string, direct: boolean): void {
    this.db.prepare('UPDATE brain_sessions SET direct = ? WHERE id = ?').run(direct ? 1 : 0, id);
  }

  /** Hand a DIRECT 1:1 platform chat to the account that actually talks in it, but ONLY while the row is
   *  still anchored on `fromUserId`. Returns whether the transfer happened.
   *
   *  A private chat can end up anchored on the instance operator through no fault of its owner, because the
   *  row is minted when the FIRST message lands: a sender who had not linked their account yet, or a chat
   *  the bot opened proactively (which carries no sender at all), both fall back to the operator. Without
   *  this the row stayed there permanently and the admin register showed one colleague's private DM as
   *  another person's conversation.
   *
   *  Safe because a 1:1 chat is between the bot and exactly ONE person, so the operator can never be a
   *  participant in somebody else's — the anchor is a fallback, not a claim. The `user_id = @from` predicate
   *  makes this a compare-and-swap: it can only ever take the row FROM the account named, and two concurrent
   *  messages cannot transfer twice, since after the first the owner no longer matches. Nothing else has to
   *  move — messages, spills, cards and usage are keyed by session id, which does not change here. */
  /** Record who just wrote in a conversation. Cheap on purpose — one indexed UPDATE per inbound turn —
   *  because the alternative is answering "who talks here" on every listing by scanning brain_messages,
   *  the largest table, with a per-row json_extract. */
  setLastWriter(id: string, userId: number): void {
    this.db.prepare('UPDATE brain_sessions SET last_writer_user_id = ? WHERE id = ?').run(userId, id);
  }

  adoptPersonalChat(id: string, fromUserId: number, toUserId: number): boolean {
    return this.db.prepare(
      'UPDATE brain_sessions SET user_id = @to, direct = 1 WHERE id = @id AND user_id = @from'
    ).run({ id, from: fromUserId, to: toUserId }).changes > 0;
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

  /** Stamp the conversation as touched, optionally recording the provider+model it is now running on.
   *  `provider` is the CONFIG entry id and is written alongside the model so a later respawn can restore
   *  the exact pair — a model id on its own does not identify a provider. An omitted `provider` clears
   *  the stored one rather than leaving a stale entry id pointing at a model it no longer goes with. */
  touchSession(id: string, model?: string, provider?: string): void {
    if (model === undefined) {
      this.db.prepare("UPDATE brain_sessions SET updated_at = datetime('now') WHERE id = ?").run(id);
    } else {
      this.db.prepare("UPDATE brain_sessions SET updated_at = datetime('now'), model = ?, provider = ? WHERE id = ?")
        .run(model, provider ?? '', id);
    }
  }

  /** Record which provider+model a conversation is now running on WITHOUT stamping it as touched.
   *
   *  Attaching a live session is not activity: opening the web chat, waking a channel and respawning an
   *  evicted conversation all spawn against an existing row, and if that moved `updated_at` the register
   *  sorted by "Updated" showed a conversation nobody had written in since yesterday at the very top,
   *  timestamped the moment the page was opened. `updated_at` therefore moves only where a message is
   *  actually persisted (see projectUserTurn/persistence.ts), which is what a reader takes it to mean.
   *
   *  Consequence worth knowing: retention windows on `updated_at` no longer treat merely OPENING an old
   *  conversation as keeping it alive. Writing in it still does. */
  setSessionModel(id: string, model: string, provider?: string): void {
    this.db.prepare('UPDATE brain_sessions SET model = ?, provider = ? WHERE id = ?')
      .run(model, provider ?? '', id);
  }

  /** Delete one conversation and its goal + messages atomically — a crash between the DELETEs would
   *  otherwise orphan goal/message rows against a gone session (no FK CASCADE here). */
  deleteSession(id: string): void {
    // Resolved BEFORE the row disappears: the spill dir is keyed by the immutable namespace, and after
    // the DELETE below there is nothing left to resolve it from.
    const spillNs = this.spillNamespace(id);
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
      this.db.prepare('DELETE FROM brain_tool_result_spills WHERE session_id = ?').run(id);
      this.providerRequests.clearSession(id);
      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_sessions WHERE id = ?').run(id);
    })();
    // Cleared tool-result spills live outside the DB, one directory per conversation (keyed by its
    // immutable namespace) — remove them with it. Best-effort: a missing or unwritable spill dir must
    // not fail the delete.
    try { rmSync(toolResultSpillDir(process.env, spillNs), { recursive: true, force: true }); }
    catch (e) { logger('brain-store').warn(`failed to remove tool-result spills for ${id}`, e); }
    // The plan file is outside the DB for the same reason and needs the same sweep — and a leftover one
    // is worse than a leftover spill: nothing reads a stale spill, but a plan is re-injected into the
    // prompt of whatever session next lands on this id.
    this.removePlanFile(id);
  }

  /** Wipe one conversation's CONTENT while keeping the conversation itself — the `/clear` command. Every
   *  table that feeds a respawn's context is emptied in ONE transaction, so a rehydrate after this can
   *  only produce an empty history: `brain_messages` (including the `pending = 1` mid-turn rows, which
   *  `settlePartialTurn` would otherwise graduate back into history on the next spawn), the transcript
   *  markers, the display cards (the todo checklist) and the cleared-tool-result latches.
   *
   *  The parent-scoped delegation bookkeeping goes too — `brain_subagent_runs`, `brain_subagent_results`
   *  and `brain_workflows` keyed by `parent_session_id`. They describe calls made from the transcript
   *  being deleted, and a fresh PI session restarts its `call_N` tool-call ids, so a surviving row both
   *  reports delegated work the (now empty) transcript never did and collides on
   *  `UNIQUE (parent_session_id, tool_call_id)` — which would make the NEXT delegation's result
   *  undeliverable. Only the parent side is swept: the child `brain_sessions` rows are separate
   *  conversations with their own transcripts and stay browsable (a caller clears only once nothing is
   *  running or awaiting delivery, so no live child is stranded).
   *
   *  Deliberately NOT touched: the `brain_sessions` row itself (id, title, model/provider, work_dir and
   *  spill namespace are the conversation's identity, which `/clear` must preserve) beyond the
   *  `cleared_at` stamp below, other users' or children's data, and `brain_goals` (a persistent goal is a
   *  standing user instruction managed by /goal, not conversation content).
   *
   *  The session's historical token/cost rows go with the messages, exactly as they do on a delete —
   *  unlike a compaction, which folds them onto its divider, there is no row left here to carry them.
   *  `usage_by_origin` is a separate write-time rollup and is untouched. */
  clearSessionHistory(id: string): void {
    // Resolved before the wipe for the same reason deleteSession resolves it before the DELETE: the
    // namespace is the only key to the spill directory on disk.
    const spillNs = this.spillNamespace(id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM brain_subagent_results WHERE parent_session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_subagent_runs WHERE parent_session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_workflows WHERE parent_session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_cards WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_session_events WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_tool_result_spills WHERE session_id = ?').run(id);
      this.providerRequests.clearSession(id);
      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ?').run(id);
      // The clear itself is the conversation's remaining evidence of ever having been used — see
      // brain_sessions.cleared_at. Written in the same transaction as the wipe that erases the messages
      // it stands in for, so the two can never disagree.
      this.db.prepare("UPDATE brain_sessions SET cleared_at = datetime('now') WHERE id = ?").run(id);
    })();
    // Both live outside SQLite and both would resurrect context the wipe just removed: a spill file backs
    // a placeholder the cleared history referenced, and a leftover plan is re-injected into the prompt of
    // whatever runs on this id next — which after /clear is this very conversation.
    try { rmSync(toolResultSpillDir(process.env, spillNs), { recursive: true, force: true }); }
    catch (e) { logger('brain-store').warn(`failed to remove tool-result spills for ${id}`, e); }
    this.removePlanFile(id);
  }

  /** Drop a conversation's plan file. Best-effort and ENOENT-tolerant: a conversation that never
   *  proposed a plan simply has no file, which is not an error worth failing a delete over. */
  private removePlanFile(sessionId: string): void {
    try { rmSync(planFilePath(process.env, sessionId), { force: true }); }
    catch (e) {
      logger('brain-store').warn(`failed to remove plan file for ${sessionId}`, e);
      this.blankPlanFile(sessionId);
    }
  }

  /** Last resort when a plan file can be neither removed nor moved: empty it where it lies.
   *
   *  Channel ids are deterministic and get REUSED, so a plan left behind is not merely orphaned — it is
   *  re-injected into the prompt of the next conversation minted onto that id, which would hand someone
   *  else's plan to a fresh session. `readPlan` treats an empty file as "no plan", so blanking it removes
   *  the only harm the leftover can do. Deliberately not a tombstone or a retry queue: the failure needs
   *  the file to be undeletable but still writable, and losing a plan we were discarding anyway costs
   *  nothing. If even this fails there is nothing further to try, and the warning is the record. */
  private blankPlanFile(sessionId: string): void {
    try { writeFileSync(planFilePath(process.env, sessionId), ''); }
    catch (e) { logger('brain-store').warn(`failed to blank plan file for ${sessionId}`, e); }
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
      this.providerRequests.reassignSession(oldId, newId);
      // The latch rows follow the conversation — left behind they would resurrect another
      // conversation's placeholders in the next session minted onto the freed id. `path` moves
      // VERBATIM: the spill dir is keyed by the immutable spill_ns (which travels inside the session
      // row), so the files never move and the stored path stays true. The old code rewrote old-dir →
      // new-dir here and renamed the directory, which silently invalidated the cached prefix of every
      // WARM conversation a /context bind moved (reassignment is NOT only cold idle rollover) — one
      // changed placeholder byte re-caches the entire history.
      this.db.prepare('UPDATE brain_tool_result_spills SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_goals SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_cards SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_session_events SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      // No JSON surgery for the node session ids inside `state`: only a session addressed by a
      // deterministic channel id is ever re-keyed, and node children run on single-use uuid channel ids,
      // so a node can never be `oldId`. getWorkflowRuns re-validates them on read regardless.
      this.db.prepare('UPDATE brain_workflows SET parent_session_id = ? WHERE parent_session_id = ?').run(newId, oldId);
    })();
    // Tool-result spills need NO filesystem move: their directory is keyed by the immutable spill_ns,
    // which just travelled with the session row. That also removes the old failure mode where the DB
    // move committed but renameSync failed, stranding the files under the freed id — readable (and
    // deletable) by whatever conversation was minted onto it next.
    // The plan follows the conversation for the same reason: left under the freed old id it would be
    // orphaned forever AND would surface in the next session minted onto that id.
    try { renameSync(planFilePath(process.env, oldId), planFilePath(process.env, newId)); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger('brain-store').warn(`failed to move plan file ${oldId} → ${newId}`, e);
        // The move failed, so the plan is still sitting under the id this rollover just freed for a new
        // conversation. Blank it rather than leave it there to be read as that conversation's own plan:
        // the archived transcript loses its plan, which is the lesser of the two outcomes.
        this.blankPlanFile(oldId);
      }
    }
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
      const usageEpoch = this.currentUsageEpochForSession(sessionId);
      const rows = this.db.prepare(
        'SELECT id, session_id, parent_id, role, content, created_at, pending, turn_duration_ms, usage_epoch FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC'
      ).all(sessionId) as BrainMessageRow[];
      const keep = keepLastN <= 0 ? [] : rows.slice(Math.max(0, rows.length - keepLastN));
      // Fold the token/cost usage of the rows about to be deleted onto the divider (under `$.usageRollup`)
      // so a compacted session's historical spend survives — the usage aggregates read it. Deleting these
      // rows would otherwise silently ERASE that spend from the Stats page / daily tiles.
      const dropped = rows.slice(0, rows.length - keep.length);
      const rollup = rollupDroppedUsage(dropped);
      // Fold the FILES those same rows named onto the divider too (under `$.workingSet`). Same reason
      // and same last-chance timing as the usage rollup: after the DELETE below there is no record left
      // that the conversation was ever working in them, and the model would resume from a summary with
      // no idea which files it had open.
      const workingSet = rollupWorkingSet(dropped);
      // And the deferred tools the model had already fetched (under `$.activatedTools`). Same last-chance
      // timing: the ToolSearch results that recorded them are among the rows about to be deleted, and
      // without this a later respawn re-seeds an empty set and the model calls a tool that is no longer
      // advertised. See rollupActivatedTools.
      const activatedTools = rollupActivatedTools(dropped);
      const carriable = typeof summary.content === 'object' && summary.content !== null && !Array.isArray(summary.content);
      const summaryContent = carriable && (rollup || workingSet || activatedTools)
        ? {
            ...(summary.content as Record<string, unknown>),
            ...(rollup ? { usageRollup: rollup } : {}),
            ...(workingSet ? { workingSet } : {}),
            ...(activatedTools ? { activatedTools } : {}),
          }
        : summary.content;
      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ?').run(sessionId);
      const insert = this.db.prepare(
        `INSERT INTO brain_messages (id, session_id, parent_id, role, content, created_at, pending, turn_duration_ms, usage_epoch)
         VALUES (@id, @session_id, @parent_id, @role, @content, @created_at, @pending, @turn_duration_ms, @usage_epoch)`
      );
      // Summary first → it gets the lowest rowid of the fresh batch. Pin its display/accounting timestamp
      // to the oldest kept row while rowid remains the authoritative transcript order.
      const summaryTs = keep[0]?.created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
      insert.run({ id: summary.id, session_id: sessionId, parent_id: null, role: summary.role, content: JSON.stringify(summaryContent), created_at: summaryTs, pending: 0, turn_duration_ms: null, usage_epoch: usageEpoch });
      for (const r of keep) {
        insert.run({ id: r.id, session_id: sessionId, parent_id: r.parent_id, role: r.role, content: r.content, created_at: r.created_at, pending: r.pending, turn_duration_ms: r.turn_duration_ms ?? null, usage_epoch: r.usage_epoch });
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
    // Collected BEFORE the transaction: plan files are keyed by session id, and once the session rows
    // are gone there is nothing left to enumerate them from — they would linger unreachable forever.
    const planned = (this.db.prepare('SELECT id FROM brain_sessions WHERE user_id = ?').all(userId) as { id: string }[]).map((r) => r.id);
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
      this.db.prepare('DELETE FROM brain_request_session_summary WHERE session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_provider_requests WHERE session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_request_segments WHERE session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_messages WHERE session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_sessions WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM brain_usage_reset_state WHERE user_id = ?').run(userId);
    })();
    for (const id of planned) this.removePlanFile(id);
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

  /** Whether this user owns a conversation whose message references this chat image. The read route asks
   *  before serving: the file name is unguessable, but that is secrecy, not authorization — an attachment
   *  is as private as the conversation it was sent in, and a photo of an invoice must not be readable by
   *  another account that comes by the name. The LIKE only narrows the scan; the match itself is decided
   *  by parsing the row, so a name appearing in unrelated prose cannot grant access. */
  chatImageBelongsTo(userId: number, file: string): boolean {
    // Deliberately not filtered by role: an image is just as private when a tool produced it (a screenshot
    // of a logged-in page) as when the user attached it, and those live on `toolResult` and `assistant`
    // rows instead of `user` ones.
    const rows = this.db.prepare(
      `SELECT m.content FROM brain_messages m
         JOIN brain_sessions s ON s.id = m.session_id
        WHERE s.user_id = ? AND m.content LIKE ?`,
    ).all(userId, `%${file}%`) as { content: string }[];
    for (const row of rows) {
      try {
        if (collectImageFiles(JSON.parse(row.content)).includes(file)) return true;
      } catch { /* a malformed row references nothing */ }
    }
    return false;
  }

  /** The owned shared-file reference, including the original download name. The route needs the metadata
   *  from the same parsed row that proves ownership; prose containing the hash grants neither access nor a
   *  filename. Like images, tool-result rows are intentionally included. */
  chatFileForUser(userId: number, file: string): StoredChatFile | undefined {
    const rows = this.db.prepare(
      `SELECT m.content FROM brain_messages m
         JOIN brain_sessions s ON s.id = m.session_id
        WHERE s.user_id = ? AND m.content LIKE ?`,
    ).all(userId, `%${file}%`) as { content: string }[];
    for (const row of rows) {
      try {
        const found = collectChatFiles(JSON.parse(row.content)).find((ref) => ref.file === file);
        if (found) return found;
      } catch { /* a malformed row references nothing */ }
    }
    return undefined;
  }

  /** Boolean counterpart of `chatImageBelongsTo`, useful to callers that need authorization only. */
  chatFileBelongsTo(userId: number, file: string): boolean {
    return this.chatFileForUser(userId, file) !== undefined;
  }

  /** The image the most recent tool call in this conversation produced, or undefined when none has. Read
   *  from the store rather than from live state so it still answers after a restart, and so it sees the
   *  pending row a tool result writes the moment it lands — which is what makes `ShareImage({latest})`
   *  work on a screenshot taken seconds earlier in the same turn. */
  latestToolImage(sessionId: string): { file: string; mimeType: string } | undefined {
    const rows = this.db.prepare(
      `SELECT content FROM brain_messages
        WHERE session_id = ? AND role = 'toolResult' AND content LIKE '%"ref"%'
        ORDER BY rowid DESC LIMIT 20`,
    ).all(sessionId) as { content: string }[];
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.content); } catch { continue; }
      const content = (parsed as { content?: unknown }).content;
      // Last block wins within a row: a tool that returned several images ends on its newest.
      for (const part of Array.isArray(content) ? [...content].reverse() : []) {
        const block = part as { type?: unknown; ref?: unknown };
        if (block?.type !== 'image') continue;
        // Validated here, not just where it is read back: a plugin or MCP tool can put whatever it likes
        // in a `ref`, and this value goes on to be served and uploaded by name.
        if (isPersistedImageBlock(block)) return { file: block.ref.file, mimeType: block.ref.mimeType };
      }
    }
    return undefined;
  }

  /** Every chat-image file still referenced by any stored message. The sweep deletes what this does NOT
   *  return, so it has to stay complete: the LIKE only narrows the scan, the names themselves come from
   *  parsing each candidate row. Both reference shapes are matched — a user attachment carries `images`,
   *  an externalized tool image carries `ref` — and missing one here would delete live pictures. */
  referencedChatImages(): Set<string> {
    const rows = this.db.prepare(
      `SELECT content FROM brain_messages WHERE content LIKE '%"images"%' OR content LIKE '%"ref"%' OR content LIKE '%"sharedImage"%'`,
    ).all() as { content: string }[];
    const files = new Set<string>();
    for (const row of rows) {
      try {
        for (const file of collectImageFiles(JSON.parse(row.content))) files.add(file);
      } catch { /* a malformed row references nothing */ }
    }
    return files;
  }

  /** Every general chat file still referenced by a stored ShareFile result. */
  referencedChatFiles(): Set<string> {
    const rows = this.db.prepare(`SELECT content FROM brain_messages WHERE content LIKE '%"sharedFile"%'`).all() as { content: string }[];
    const files = new Set<string>();
    for (const row of rows) {
      try { for (const ref of collectChatFiles(JSON.parse(row.content))) files.add(ref.file); }
      catch { /* a malformed row references nothing */ }
    }
    return files;
  }
}
