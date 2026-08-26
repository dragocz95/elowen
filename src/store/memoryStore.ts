import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import type { MemoryRow, MemoryEventRow } from '../shared/wireContract.js';

// The memory row shapes are the daemon↔web wire contract (served over /memory) — defined once in
// src/shared and re-exported here, so a field added on the daemon can never be missing on the web.
export type { MemoryRow, MemoryEventRow };

/** How long recall events are kept. Long enough for the vitality chart's default window (30 days) and a
 *  season of comparison on top, short enough that the table stays a fraction of the message log at the
 *  measured few hundred recalls a day. A code constant on purpose: exposing it as a knob would drag the
 *  web mirror, the retention editor and its parity test along for no operational gain. */
export const USAGE_HISTORY_DAYS = 90;

/** One packed-Float32 embedding per memory. content_hash pins which body text was embedded. */
export interface MemoryEmbeddingRow {
  memory_id: number;
  provider: string;
  model: string;
  dimensions: number;
  vector: Buffer;
  content_hash: string;
  created_at: string;
}

export interface MemoryInput {
  body: string;
  kind?: string;
  importance?: number;
  confidence?: number;
  source?: string;
}

export interface MemoryPatch {
  body?: string;
  kind?: string;
  importance?: number;
  confidence?: number;
  status?: string;
}

export interface ListMemoriesOpts {
  status?: string; // default 'active'; pass '' or 'all' to include every status
  kind?: string;
  categoryId?: number | null; // undefined = no filter; null = uncategorized; a number = that category
  limit?: number;
  offset?: number;
}

export interface SetEmbeddingInput {
  provider: string;
  model: string;
  dimensions: number;
  vector: Float32Array | Buffer;
  contentHash: string;
}

/** Stable content hash of a memory body — sha256 hex. Used to detect a stale embedding after an edit. */
export function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Pack a Float32 vector into a raw little-endian BLOB buffer for storage. Internal — the reverse
 *  unpack lands with the Phase-4 retrieval consumer that actually reads vectors back. */
function packVector(vector: Float32Array | Buffer): Buffer {
  if (Buffer.isBuffer(vector)) return vector;
  // Copy the underlying bytes exactly (respecting byteOffset/length of the view).
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Persistence for Elowen RAW memories (v1: user-scoped). Every read/write is filtered by user_id and
 *  id-addressed ops enforce ownership. Embeddings live inline as packed Float32 BLOBs (no external
 *  vector DB); this store does NOT make embedding HTTP calls — that's EmbeddingService. Vector search
 *  is Phase 4; `search` here is a keyword LIKE fallback. Deletes are soft (status='deleted'); every
 *  mutation is audited in memory_events. */
export class MemoryStore {
  constructor(private db: Db) {}

  /** Insert a memory and audit the 'add' (after_json = the new row). `model` names the inference model
   *  behind the write (curator) — null for human/API adds. Atomic. Returns the full row. */
  add(userId: number, input: MemoryInput, actor: string, reason: string, model?: string | null): MemoryRow {
    return this.db.transaction(() => {
      const info = this.db.prepare(
        `INSERT INTO memories (user_id, body, kind, importance, confidence, source)
         VALUES (@user_id, @body, @kind, @importance, @confidence, @source)`
      ).run({
        user_id: userId,
        body: input.body,
        kind: input.kind ?? 'fact',
        importance: input.importance ?? 3,
        confidence: input.confidence ?? 0.8,
        source: input.source ?? 'agent',
      });
      const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(Number(info.lastInsertRowid)) as MemoryRow;
      this.audit(userId, row.id, 'add', null, row, actor, reason, model);
      return row;
    })();
  }

  /** Read one memory (any status) owned by this user. */
  get(userId: number, id: number): MemoryRow | undefined {
    return this.db.prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?')
      .get(id, userId) as MemoryRow | undefined;
  }

  /** List memories, newest-updated first. Default excludes soft-deleted (status='active'). Pass
   *  status '' or 'all' to include every status. */
  list(userId: number, opts: ListMemoriesOpts = {}): MemoryRow[] {
    const status = opts.status === undefined ? 'active' : opts.status;
    const clauses = ['user_id = ?'];
    const params: (string | number)[] = [userId];
    if (status !== '' && status !== 'all') { clauses.push('status = ?'); params.push(status); }
    if (opts.kind !== undefined) { clauses.push('kind = ?'); params.push(opts.kind); }
    if (opts.categoryId !== undefined) {
      if (opts.categoryId === null) clauses.push('category_id IS NULL');
      else { clauses.push('category_id = ?'); params.push(opts.categoryId); }
    }
    let sql = `SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id DESC`;
    if (opts.limit !== undefined) { sql += ' LIMIT ?'; params.push(opts.limit); }
    // SQLite's grammar only allows OFFSET after a LIMIT; when paging without an explicit cap, use
    // LIMIT -1 (unbounded) so `offset` alone doesn't produce `... OFFSET ?` — invalid SQL that 500s.
    if (opts.offset !== undefined) { sql += opts.limit === undefined ? ' LIMIT -1 OFFSET ?' : ' OFFSET ?'; params.push(opts.offset); }
    return this.db.prepare(sql).all(...params) as MemoryRow[];
  }

  /** Oldest active memories first, bounded for the daily retention sweep. */
  listActiveForEviction(userId: number, limit: number): MemoryRow[] {
    return this.db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND status = 'active'
       ORDER BY created_at ASC, id ASC LIMIT ?`
    ).all(userId, limit) as MemoryRow[];
  }

  /** Count a user's active memories (indexed on user_id+status — cheap enough for a page-load stat). */
  count(userId: number): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND status = 'active'").get(userId) as { n: number };
    return r.n;
  }

  /** Active memories, most-recently created first. */
  listRecent(userId: number, limit: number): MemoryRow[] {
    return this.db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND status = 'active'
       ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(userId, limit) as MemoryRow[];
  }

  /** Active memories in the supplied categories, most-recently created first. The category filter lives
   * in SQL so excluded recent rows cannot crowd eligible rows out of a limited result. */
  listRecentInCategories(userId: number, categoryIds: ReadonlySet<number>, limit: number): MemoryRow[] {
    const ids = [...categoryIds];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND status = 'active' AND category_id IN (${placeholders})
       ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(userId, ...ids, limit) as MemoryRow[];
  }

  /** v1 keyword fallback: case-insensitive LIKE scan over body, active only, newest-updated first.
   *  (Vector search lives in Phase 4 — not here.) */
  search(userId: number, query: string, limit: number): MemoryRow[] {
    const q = query.trim();
    if (q.length < 2) return [];
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    return this.db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND status = 'active' AND body LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC, id DESC LIMIT ?`
    ).all(userId, like, limit) as MemoryRow[];
  }

  /** Patch a memory (owned by user), bump updated_at, audit 'update' with before/after. A body change
   *  is NOT re-embedded here — the caller re-embeds (needsEmbedding will report it stale). Returns the
   *  updated row, or undefined if the memory doesn't exist for this user. */
  update(userId: number, id: number, patch: MemoryPatch, actor: string, reason: string, model?: string | null): MemoryRow | undefined {
    return this.db.transaction(() => {
      const before = this.get(userId, id);
      if (!before) return undefined;
      const sets: string[] = [];
      const params: Record<string, string | number> = { id, user_id: userId };
      if (patch.body !== undefined) { sets.push('body = @body'); params.body = patch.body; }
      if (patch.kind !== undefined) { sets.push('kind = @kind'); params.kind = patch.kind; }
      if (patch.importance !== undefined) { sets.push('importance = @importance'); params.importance = patch.importance; }
      if (patch.confidence !== undefined) { sets.push('confidence = @confidence'); params.confidence = patch.confidence; }
      if (patch.status !== undefined) { sets.push('status = @status'); params.status = patch.status; }
      sets.push("updated_at = datetime('now')");
      this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id AND user_id = @user_id`).run(params);
      const after = this.get(userId, id)!;
      this.audit(userId, id, 'update', before, after, actor, reason, model);
      return after;
    })();
  }

  /** Soft-delete: set status='deleted' and audit 'delete'. Returns false if not owned/found. */
  softDelete(userId: number, id: number, actor: string, reason: string): boolean {
    return this.setStatus(userId, id, 'deleted', 'delete', actor, reason);
  }

  /** Restore a soft-deleted memory: set status='active' and audit 'restore'. */
  restore(userId: number, id: number, actor: string, reason: string): boolean {
    return this.setStatus(userId, id, 'active', 'restore', actor, reason);
  }

  /** HARD-delete one owned memory of ANY status (not a soft status flip) — the row is physically removed
   *  and its embedding cascades away (memory_embeddings FK ON DELETE CASCADE). A 'purge' audit is written
   *  first (memory_id nullable) so the trail survives the gone row. Owner-scoped: a foreign/missing id is
   *  a no-op → false. Atomic. */
  purge(userId: number, id: number, actor: string, reason: string): boolean {
    return this.db.transaction(() => {
      const before = this.get(userId, id);
      if (!before) return false;
      // Audit BEFORE the delete: the before_json snapshots the vanishing row; memory_id points at the
      // id that is about to disappear (kept for the trail — the memories row is gone after this).
      this.audit(userId, id, 'purge', before, null, actor, reason);
      this.db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId);
      // Usage events go with the row (they are analytics, not audit). SQLite may hand this rowid to the
      // next memory, which would otherwise inherit a stranger's recall history.
      this.db.prepare('DELETE FROM memory_usage_events WHERE memory_id = ? AND user_id = ?').run(id, userId);
      return true;
    })();
  }

  /** HARD-delete a BATCH of owned memories in ONE transaction (nested as a savepoint per id). A
   *  per-id loop of {@link purge} commits each delete on its own, so a failure part-way through leaves
   *  the batch's prefix irreversibly gone while the caller sees an error; here the whole batch rolls
   *  back instead. Owner-scoped: a foreign/missing id is skipped. Returns the count purged. */
  purgeMany(userId: number, ids: number[], actor: string, reason: string): number {
    return this.db.transaction(() => {
      let purged = 0;
      for (const id of ids) { if (this.purge(userId, id, actor, reason)) purged += 1; }
      return purged;
    })();
  }

  /** HARD-delete ALL of this user's soft-deleted (status='deleted') memories — empties the trash. Each
   *  row's embedding cascades away; each purge is audited. Owner-scoped, atomic. Returns the count purged. */
  purgeDeleted(userId: number, actor: string, reason: string): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM memories WHERE user_id = ? AND status = 'deleted'")
        .all(userId) as MemoryRow[];
      const dropUsage = this.db.prepare('DELETE FROM memory_usage_events WHERE memory_id = ? AND user_id = ?');
      for (const row of rows) {
        this.audit(userId, row.id, 'purge', row, null, actor, reason);
        dropUsage.run(row.id, userId);
      }
      this.db.prepare("DELETE FROM memories WHERE user_id = ? AND status = 'deleted'").run(userId);
      return rows.length;
    })();
  }

  /** Merge several source memories into one new memory carrying `mergedBody`; the sources are
   *  soft-deleted. The 'merge' audit's after_json carries the source ids. Atomic. */
  merge(userId: number, ids: number[], mergedBody: string, actor: string, reason: string): MemoryRow {
    return this.db.transaction(() => {
      const info = this.db.prepare(
        `INSERT INTO memories (user_id, body, source) VALUES (@user_id, @body, 'merge')`
      ).run({ user_id: userId, body: mergedBody });
      const merged = this.db.prepare('SELECT * FROM memories WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as MemoryRow;
      const sourceIds: number[] = [];
      for (const id of ids) {
        const before = this.get(userId, id);
        if (!before) continue; // ownership enforced: skip rows not owned by this user
        this.db.prepare("UPDATE memories SET status = 'deleted', updated_at = datetime('now') WHERE id = ? AND user_id = ?")
          .run(id, userId);
        sourceIds.push(id);
      }
      this.audit(userId, merged.id, 'merge', null, { mergedId: merged.id, sourceIds }, actor, reason);
      return merged;
    })();
  }

  /** Bump use_count and set last_used_at for each of the user's own memories, and log one usage event
   *  per id. The counter update and the event share ONE transaction on purpose: the vitality chart
   *  reconstructs `use_count(t)` and `last_used_at(t)` by replaying the log, so a counter that could
   *  move without its event (or the reverse) would make the curve disagree with the number shown next
   *  to it. The event is written only for rows the UPDATE actually matched, so a foreign or missing id
   *  logs nothing. */
  markUsed(userId: number, ids: number[]): void {
    if (ids.length === 0) return;
    const bump = this.db.prepare(
      "UPDATE memories SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ? AND user_id = ?"
    );
    const logUse = this.db.prepare(
      "INSERT INTO memory_usage_events (memory_id, user_id, used_at) VALUES (?, ?, datetime('now'))"
    );
    this.db.transaction(() => {
      for (const id of ids) {
        if (bump.run(id, userId).changes > 0) logUse.run(id, userId);
      }
    })();
  }

  /** A memory's recall timestamps, oldest first — the raw series the vitality history is rebuilt from.
   *  Unlike {@link eventsForMemory} this needs no created_at bound: usage events are deleted with their
   *  memory, so a reused rowid cannot inherit them. */
  usageHistory(userId: number, memoryId: number): string[] {
    const rows = this.db.prepare(
      'SELECT used_at FROM memory_usage_events WHERE memory_id = ? AND user_id = ? ORDER BY used_at ASC, id ASC'
    ).all(memoryId, userId) as { used_at: string }[];
    return rows.map((row) => row.used_at);
  }

  /** Today's recall volume across the whole instance: how many memories each person's turns pulled in,
   *  plus the same total broken down by hour. Instance-wide rather than owner-scoped — like
   *  {@link purgeUsageEventsOlderThan} below — because the dashboard's pulse tile reports on the team as
   *  a whole by the instance owner's decision (see the /activity/pulse route for that call).
   *
   *  Hours are UTC, the same basis `activity_buckets` keys its own rollup with, so the two series the
   *  tile draws sit on one clock and the client can shift both by a single offset. Bounded with a range
   *  on `used_at` rather than `date(used_at) = date('now')` so the comparison stays sargable. */
  recallActivityToday(): {
    byUser: { userId: number; count: number }[];
    byHour: { hour: number; count: number }[];
  } {
    const since = "strftime('%Y-%m-%d 00:00:00','now')";
    const byUser = this.db.prepare(
      `SELECT user_id AS userId, COUNT(*) AS count
         FROM memory_usage_events
        WHERE used_at >= ${since}
        GROUP BY user_id`
    ).all() as { userId: number; count: number }[];
    const byHour = this.db.prepare(
      `SELECT CAST(strftime('%H', used_at) AS INTEGER) AS hour, COUNT(*) AS count
         FROM memory_usage_events
        WHERE used_at >= ${since}
        GROUP BY hour
        ORDER BY hour`
    ).all() as { hour: number; count: number }[];
    return { byUser, byHour };
  }

  /** The same per-person recall volume as {@link recallActivityToday}, over a window of whole days —
   *  what the pulse tile's ring reports, which is a month rather than a day.
   *
   *  No hourly breakdown here on purpose: a month of hours is a shape nothing draws, and computing it
   *  would scan the same rows for an answer nobody reads. `days` is clamped and interpolated rather than
   *  bound because SQLite's datetime() modifier takes a literal — the clamp is what makes that safe,
   *  the same shape as {@link purgeUsageEventsOlderThan}. */
  recallCountsSince(days: number): { userId: number; count: number }[] {
    const d = Number.isFinite(days) && days >= 1 ? Math.min(365, Math.floor(days)) : 30;
    return this.db.prepare(
      `SELECT user_id AS userId, COUNT(*) AS count
         FROM memory_usage_events
        WHERE used_at >= datetime('now', '-${d} days')
        GROUP BY user_id`
    ).all() as { userId: number; count: number }[];
  }

  /** Drop usage events older than `days`. Called by the daily retention sweep — this table grows with
   *  every recall (hundreds of rows a day), so it is the one memory table that needs age pruning.
   *  `days` is clamped here rather than bound as a parameter because SQLite's datetime() modifier takes
   *  a literal; the clamp is what makes the interpolation safe (same shape as EventStore.purgeOlderThan). */
  purgeUsageEventsOlderThan(days: number): number {
    const d = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 90;
    return this.db.prepare(`DELETE FROM memory_usage_events WHERE used_at < datetime('now', '-${d} days')`)
      .run().changes;
  }

  /** Assign (or clear with null) a memory's category. Owner-scoped; a non-null categoryId must be one
   *  of this user's own categories (else no-op → false). Bumps updated_at, audits 'categorize'. */
  setCategory(userId: number, id: number, categoryId: number | null, actor: string, reason: string, model?: string | null): boolean {
    return this.db.transaction(() => {
      const before = this.get(userId, id);
      if (!before) return false;
      if (categoryId !== null) {
        const owned = this.db.prepare('SELECT 1 FROM memory_categories WHERE id = ? AND user_id = ?').get(categoryId, userId);
        if (!owned) return false; // foreign/unknown category → reject, never write a dangling id
      }
      this.db.prepare("UPDATE memories SET category_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(categoryId, id, userId);
      const after = this.get(userId, id)!;
      this.audit(userId, id, 'categorize', before, after, actor, reason, model);
      return true;
    })();
  }

  /** Read the embedding for a memory owned by this user (join enforces ownership). */
  getEmbedding(userId: number, memoryId: number): MemoryEmbeddingRow | undefined {
    return this.db.prepare(
      `SELECT e.* FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
        WHERE e.memory_id = ? AND m.user_id = ?`
    ).get(memoryId, userId) as MemoryEmbeddingRow | undefined;
  }

  /** Active memories that already carry a FRESH embedding, paired with their vector unpacked back to a
   *  Float32Array. User-scoped (the join keys on this user's memories). Powers vector retrieval —
   *  MemoryService cosine-scans this set. Rows without an embedding are excluded (INNER JOIN); rows whose
   *  stored vector is STALE (the body was edited since it was embedded, so content_hash no longer matches
   *  the current body) are also excluded, so retrieval never ranks against an out-of-date vector — the
   *  memory falls back to keyword search until the embed queue re-vectorizes it. */
  listActiveWithEmbeddings(userId: number): { memory: MemoryRow; vector: Float32Array }[] {
    const rows = this.db.prepare(
      `SELECT m.*, e.vector AS vector, e.content_hash AS embedded_hash
         FROM memories m JOIN memory_embeddings e ON e.memory_id = m.id
        WHERE m.user_id = ? AND m.status = 'active'
        ORDER BY m.updated_at DESC, m.id DESC`
    ).all(userId) as (MemoryRow & { vector: Buffer; embedded_hash: string })[];
    return rows
      .filter((r) => r.embedded_hash === hashBody(r.body)) // drop stale vectors — body edited since embed
      .map(({ vector, embedded_hash, ...memory }) => ({
        memory: memory as MemoryRow,
        // Unpack the little-endian BLOB. Slice to a fresh ArrayBuffer so the view isn't tied to the
        // BLOB's byteOffset within a shared buffer (better-sqlite3 hands back a Node Buffer).
        vector: new Float32Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)),
      }));
  }

  /** Upsert a memory's embedding. Packs a Float32Array into a raw BLOB (a Buffer is stored as-is).
   *  Compare-and-set on TWO invariants, so a background embed can't persist a wrong vector:
   *   - ownership: no-op if the memory isn't owned by this user (a foreign embedding must never be written);
   *   - freshness: no-op if the current body no longer hashes to `input.contentHash`. The queue embeds a
   *     snapshot body, awaits the provider, then writes back — if the body was edited during that await,
   *     the snapshot vector is stale and writing it would clobber the current body's (or a fresher) vector.
   *  The read+write is atomic (better-sqlite3 is synchronous — no await between them). */
  setEmbedding(userId: number, memoryId: number, input: SetEmbeddingInput): void {
    const owned = this.db.prepare('SELECT body FROM memories WHERE id = ? AND user_id = ?')
      .get(memoryId, userId) as { body: string } | undefined;
    if (!owned) return;
    // Compare-and-set: only persist the vector if it was computed from the body still in the DB.
    if (hashBody(owned.body) !== input.contentHash) return;
    this.db.prepare(
      `INSERT INTO memory_embeddings (memory_id, provider, model, dimensions, vector, content_hash)
       VALUES (@memory_id, @provider, @model, @dimensions, @vector, @content_hash)
       ON CONFLICT(memory_id) DO UPDATE SET
         provider = excluded.provider, model = excluded.model, dimensions = excluded.dimensions,
         vector = excluded.vector, content_hash = excluded.content_hash, created_at = datetime('now')`
    ).run({
      memory_id: memoryId,
      provider: input.provider,
      model: input.model,
      dimensions: input.dimensions,
      vector: packVector(input.vector),
      content_hash: input.contentHash,
    });
  }

  /** Active memories with no embedding, or whose stored vector is stale: the body changed (content_hash
   *  mismatch) OR — when `active` is given — it was embedded under a different model/dimensions than the
   *  currently configured one (so switching the embedding model re-vectorizes existing memories instead
   *  of leaving old-width vectors that cosine to 0). Feeds the embed queue. */
  needsEmbedding(userId: number, active?: { model?: string; dimensions?: number | null }): MemoryRow[] {
    const rows = this.db.prepare(
      `SELECT m.*, e.content_hash AS embedded_hash, e.model AS embedded_model, e.dimensions AS embedded_dims
         FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id = m.id
        WHERE m.user_id = ? AND m.status = 'active'
        ORDER BY m.created_at DESC, m.id DESC`
    ).all(userId) as (MemoryRow & { embedded_hash: string | null; embedded_model: string | null; embedded_dims: number | null })[];
    return rows
      .filter((r) => {
        if (r.embedded_hash === null || r.embedded_hash !== hashBody(r.body)) return true; // missing or body-stale
        if (active?.model && r.embedded_model !== active.model) return true; // model changed
        if (active?.dimensions != null && r.embedded_dims !== active.dimensions) return true; // dimensions changed
        return false;
      })
      .map(({ embedded_hash, embedded_model, embedded_dims, ...m }) => m as MemoryRow);
  }

  /** Audit feed for a user, newest first. */
  listEvents(userId: number, opts: { limit?: number } = {}): MemoryEventRow[] {
    const limit = opts.limit ?? 100;
    return this.db.prepare(
      'SELECT * FROM memory_events WHERE user_id = ? ORDER BY id DESC LIMIT ?'
    ).all(userId, limit) as MemoryEventRow[];
  }

  /** One memory's OWN audit trail (newest first), scoped to its lifetime. `memories.id` is a plain
   *  rowid, so after a hard purge SQLite may REUSE that id for a new memory — and purged memories' events
   *  are retained for audit. Filtering by memory_id alone would then surface the PRIOR occupant's events
   *  (a "VPS RAM" memory showing a purged "sarah_hair" memory's history). Bounding to events at/after this
   *  memory's created_at keeps the trail to this memory only. */
  eventsForMemory(userId: number, memoryId: number): MemoryEventRow[] {
    return this.db.prepare(
      `SELECT e.* FROM memory_events e
        WHERE e.memory_id = ? AND e.user_id = ?
          AND e.created_at >= (SELECT created_at FROM memories WHERE id = ? AND user_id = ?)
        ORDER BY e.id DESC`
    ).all(memoryId, userId, memoryId, userId) as MemoryEventRow[];
  }

  /** Hard-delete everything for a user (memories cascade to embeddings) plus their audit events.
   *  Used only by user-delete cleanup — normal deletes are soft. */
  removeForUser(userId: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM memory_events WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM memory_usage_events WHERE user_id = ?').run(userId);
    })();
  }

  /** Set a memory's status (owned by user) and audit the transition. Returns false if not found. */
  private setStatus(userId: number, id: number, status: string, action: string, actor: string, reason: string): boolean {
    return this.db.transaction(() => {
      const before = this.get(userId, id);
      if (!before) return false;
      this.db.prepare("UPDATE memories SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(status, id, userId);
      const after = this.get(userId, id)!;
      this.audit(userId, id, action, before, after, actor, reason);
      return true;
    })();
  }

  /** Append one audit row. before/after are JSON-serialized (null passes through as SQL NULL). `model`
   *  names the inference model behind the mutation — omitted/null for human/API-driven events. */
  private audit(userId: number, memoryId: number | null, action: string,
                before: unknown, after: unknown, actor: string, reason: string, model?: string | null): void {
    this.db.prepare(
      `INSERT INTO memory_events (memory_id, user_id, action, before_json, after_json, actor, reason, model)
       VALUES (@memory_id, @user_id, @action, @before_json, @after_json, @actor, @reason, @model)`
    ).run({
      memory_id: memoryId,
      user_id: userId,
      action,
      before_json: before === null || before === undefined ? null : JSON.stringify(before),
      after_json: after === null || after === undefined ? null : JSON.stringify(after),
      actor,
      reason,
      model: model ?? null,
    });
  }
}
