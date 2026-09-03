import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import type { MemoryRow, MemoryEventRow, MemoryCategoryRow } from '../shared/wireContract.js';
import { memoryCategoryFingerprint } from './memoryCategoryStore.js';
import { sharedCategoryIds, canUseCategory } from './sharedMemoryAccess.js';

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

/** Optional, content-free correlation for a recall that happened inside a live model turn. */
export interface MemoryUsageContext {
  sessionId: string;
  turnId: string;
  searchIndex: number;
}

export interface ListMemoriesOpts {
  status?: string; // default 'active'; pass '' or 'all' to include every status
  kind?: string;
  categoryId?: number | null; // undefined = no filter; null = uncategorized; a number = that category
  /** Shared pool category ids this reader may see. When set, the user filter widens to
   *  `(user_id = ? OR category_id IN (…))` so other authors' shared rows are returned too. */
  sharedCategoryIds?: number[];
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

  /** The shared pool categories this reader may touch, resolved fresh per call (sharing config can
   *  change at any moment; nothing here may be cached across requests). */
  private sharedIds(userId: number): number[] {
    return sharedCategoryIds(this.db, userId);
  }

  /** Ids of EVERY instance-owned shared pool category (user_id = 0, project-bound). Who may touch which
   *  pool is resolved elsewhere; this raw exclusion set feeds the passes that must never touch shared
   *  rows at all (the personal reclassify pass). */
  sharedPoolCategoryIds(): number[] {
    const rows = this.db.prepare(
      'SELECT id FROM memory_categories WHERE user_id = 0 AND project_id IS NOT NULL',
    ).all() as { id: number }[];
    return rows.map((r) => r.id);
  }

  /** One memory the user may READ/WRITE: their own row, or ANOTHER author's row sitting in a shared
   *  pool they share. This is the row-side access boundary — every cross-user-capable mutation and
   *  read routes through it instead of the owner-scoped {@link get}. */
  getAccessible(userId: number, id: number): MemoryRow | undefined {
    const shared = this.sharedIds(userId);
    if (shared.length === 0) return this.get(userId, id);
    const placeholders = shared.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT * FROM memories WHERE id = ? AND (user_id = ? OR category_id IN (${placeholders}))`,
    ).get(id, userId, ...shared) as MemoryRow | undefined;
  }

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
   *  status '' or 'all' to include every status. With `sharedCategoryIds` the result also carries other
   *  authors' rows sitting in those shared pools. */
  list(userId: number, opts: ListMemoriesOpts = {}): MemoryRow[] {
    const status = opts.status === undefined ? 'active' : opts.status;
    const shared = opts.sharedCategoryIds ?? [];
    const scope = shared.length > 0
      ? `(user_id = ? OR category_id IN (${shared.map(() => '?').join(', ')}))`
      : 'user_id = ?';
    const clauses = [scope];
    const params: (string | number)[] = shared.length > 0 ? [userId, ...shared] : [userId];
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

  listRecent(userId: number, limit: number, sharedCategoryIds: number[] = []): MemoryRow[] {
    const scope = sharedCategoryIds.length > 0
      ? `(user_id = ? OR category_id IN (${sharedCategoryIds.map(() => '?').join(', ')}))`
      : 'user_id = ?';
    const params: (string | number)[] = sharedCategoryIds.length > 0 ? [userId, ...sharedCategoryIds, limit] : [userId, limit];
    return this.db.prepare(
      `SELECT * FROM memories WHERE ${scope} AND status = 'active'
       ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(...params) as MemoryRow[];
  }

  /** Active memories in the supplied categories, most-recently created first. The category filter lives
   * in SQL so excluded recent rows cannot crowd eligible rows out of a limited result. With
   * `sharedCategoryIds` the reader widening applies BEFORE the category filter, so the scope's shared
   * category can actually surface other authors' rows. */
  listRecentInCategories(
    userId: number, categoryIds: ReadonlySet<number>, limit: number, sharedCategoryIds: number[] = [],
  ): MemoryRow[] {
    const ids = [...categoryIds];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const scope = sharedCategoryIds.length > 0
      ? `(user_id = ? OR category_id IN (${sharedCategoryIds.map(() => '?').join(', ')}))`
      : 'user_id = ?';
    const params: (string | number)[] = sharedCategoryIds.length > 0
      ? [userId, ...sharedCategoryIds, ...ids, limit]
      : [userId, ...ids, limit];
    return this.db.prepare(
      `SELECT * FROM memories WHERE ${scope} AND status = 'active' AND category_id IN (${placeholders})
       ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(...params) as MemoryRow[];
  }

  /** v1 keyword fallback: case-insensitive LIKE scan over body, active only, newest-updated first.
   *  (Vector search lives in Phase 4 — not here.) With `sharedCategoryIds`, other authors' rows in
   *  those pools match too. */
  search(userId: number, query: string, limit: number, sharedCategoryIds: number[] = []): MemoryRow[] {
    const q = query.trim();
    if (q.length < 2) return [];
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const scope = sharedCategoryIds.length > 0
      ? `(user_id = ? OR category_id IN (${sharedCategoryIds.map(() => '?').join(', ')}))`
      : 'user_id = ?';
    const params: (string | number)[] = sharedCategoryIds.length > 0
      ? [userId, ...sharedCategoryIds, like, limit]
      : [userId, like, limit];
    return this.db.prepare(
      `SELECT * FROM memories WHERE ${scope} AND status = 'active' AND body LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC, id DESC LIMIT ?`
    ).all(...params) as MemoryRow[];
  }

  /** Patch a memory (own row, or another author's shared-pool row via {@link getAccessible}), bump
   *  updated_at, audit 'update' with before/after. A body change is NOT re-embedded here — the caller
   *  re-embeds (needsEmbedding will report it stale). Returns the updated row, or undefined if the
   *  memory doesn't exist for this user. */
  update(userId: number, id: number, patch: MemoryPatch, actor: string, reason: string, model?: string | null): MemoryRow | undefined {
    return this.db.transaction(() => {
      const before = this.getAccessible(userId, id);
      if (!before) return undefined;
      const sets: string[] = [];
      const params: Record<string, string | number> = { id };
      if (patch.body !== undefined) { sets.push('body = @body'); params.body = patch.body; }
      if (patch.kind !== undefined) { sets.push('kind = @kind'); params.kind = patch.kind; }
      if (patch.importance !== undefined) { sets.push('importance = @importance'); params.importance = patch.importance; }
      if (patch.confidence !== undefined) { sets.push('confidence = @confidence'); params.confidence = patch.confidence; }
      if (patch.status !== undefined) { sets.push('status = @status'); params.status = patch.status; }
      sets.push("updated_at = datetime('now')");
      this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id`).run(params);
      const after = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
      this.audit(before.user_id, id, 'update', before, after, actor, reason, model);
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

  /** HARD-delete one memory of ANY status the caller can access (not a soft status flip) — the row is
   *  physically removed and its embedding cascades away (memory_embeddings FK ON DELETE CASCADE). A
   *  'purge' audit is written first (memory_id nullable) so the trail survives the gone row.
   *  Access-scoped via {@link getAccessible}: a foreign/missing id is a no-op → false. Atomic. */
  purge(userId: number, id: number, actor: string, reason: string): boolean {
    return this.db.transaction(() => {
      const before = this.getAccessible(userId, id);
      if (!before) return false;
      // Audit BEFORE the delete: the before_json snapshots the vanishing row; memory_id points at the
      // id that is about to disappear (kept for the trail — the memories row is gone after this).
      this.audit(before.user_id, id, 'purge', before, null, actor, reason);
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      // Usage events go with the row (they are analytics, not audit). SQLite may hand this rowid to the
      // next memory, which would otherwise inherit a stranger's recall history.
      this.db.prepare('DELETE FROM memory_usage_events WHERE memory_id = ?').run(id);
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

  /** Merge several memories into one new memory carrying `mergedBody`; the sources are soft-deleted.
   *  Sources are access-scoped ({@link getAccessible}) — a foreign non-shared id is skipped, never
   *  merged. When every matched source sits in ONE category the caller may use, the merged row keeps
   *  that category; otherwise it lands uncategorized exactly as before (the classifier re-files it).
   *  The 'merge' audit's after_json carries the source ids. Atomic. */
  merge(userId: number, ids: number[], mergedBody: string, actor: string, reason: string): MemoryRow {
    return this.db.transaction(() => {
      const info = this.db.prepare(
        `INSERT INTO memories (user_id, body, source) VALUES (@user_id, @body, 'merge')`
      ).run({ user_id: userId, body: mergedBody });
      const merged = this.db.prepare('SELECT * FROM memories WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as MemoryRow;
      const sourceIds: number[] = [];
      const sourceCategories = new Set<number>();
      for (const id of ids) {
        const before = this.getAccessible(userId, id);
        if (!before) continue; // access enforced: skip rows this caller cannot touch
        this.db.prepare("UPDATE memories SET status = 'deleted', updated_at = datetime('now') WHERE id = ?")
          .run(id);
        sourceIds.push(id);
        if (before.category_id !== null) sourceCategories.add(before.category_id);
      }
      // Keep the merged row in its category only when the sources agree on ONE and the caller may use
      // it — a shared pool must not be exited by a merge, and a personal re-filing stays with the
      // reclassify pass as before.
      if (sourceCategories.size === 1) {
        const carried = [...sourceCategories][0]!;
        if (canUseCategory(this.db, userId, carried)) {
          this.db.prepare("UPDATE memories SET category_id = ?, updated_at = datetime('now') WHERE id = ?")
            .run(carried, merged.id);
          merged.category_id = carried;
        }
      }
      this.audit(userId, merged.id, 'merge', null, { mergedId: merged.id, sourceIds }, actor, reason);
      return merged;
    })();
  }

  /** Bump use_count and set last_used_at for each memory the READER may access, and log one usage event
   *  per id. The counter update and the event share ONE transaction on purpose: the vitality chart
   *  reconstructs `use_count(t)` and `last_used_at(t)` by replaying the log, so a counter that could
   *  move without its event (or the reverse) would make the curve disagree with the number shown next
   *  to it. The event is written only for rows the UPDATE actually matched, so a foreign or missing id
   *  logs nothing.
   *
   *  The bump is deliberately NOT reader-keyed: a memory must count recalls by anyone who may see it,
   *  or another member's daily recalls would never raise its vitality and the retention sweep would
   *  soft-delete a live shared memory as if it were dead. The `memory_usage_events.user_id` therefore
   *  records the READER (that is what recallActivityToday/recallCountsSince group on), while the
   *  counter rides on the memory row itself. */
  markUsed(userId: number, ids: number[], context?: MemoryUsageContext): void {
    if (ids.length === 0) return;
    const shared = this.sharedIds(userId);
    const bump = shared.length > 0
      ? this.db.prepare(
        `UPDATE memories SET use_count = use_count + 1, last_used_at = datetime('now')
          WHERE id = ? AND (user_id = ? OR category_id IN (${shared.map(() => '?').join(', ')}))`
      )
      : this.db.prepare(
        "UPDATE memories SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ? AND user_id = ?"
      );
    const bumpArgs = (id: number): (string | number)[] => shared.length > 0 ? [id, userId, ...shared] : [id, userId];
    const logUse = this.db.prepare(
      `INSERT INTO memory_usage_events
        (memory_id, user_id, used_at, session_id, turn_id, search_index)
       VALUES (?, ?, datetime('now'), ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const id of ids) {
        if (bump.run(...bumpArgs(id)).changes > 0) {
          logUse.run(id, userId, context?.sessionId ?? null, context?.turnId ?? null, context?.searchIndex ?? null);
        }
      }
    })();
  }

  /** A memory's recall timestamps, oldest first — the raw series the vitality history is rebuilt from.
   *  Unlike {@link eventsForMemory} this needs no created_at bound: usage events are deleted with their
   *  memory, so a reused rowid cannot inherit them. NOT reader-keyed: every member's recall of a shared
   *  memory is part of its history. */
  usageHistory(memoryId: number): string[] {
    const rows = this.db.prepare(
      'SELECT used_at FROM memory_usage_events WHERE memory_id = ? ORDER BY used_at ASC, id ASC'
    ).all(memoryId) as { used_at: string }[];
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

  /** Monotonic mutation token for ONE memory, keyed to its AUTHOR (memory_events.user_id is the row's
   *  author, not whoever mutated it). Every supported memory mutation appends an audit event, so this
   *  catches ABA changes that return body/category/status to their original values during inference.
   *  Author-derived rather than caller-keyed so a member's CAS on a shared row compares against the
   *  same event stream the author's writes produced. */
  revision(memoryId: number): number {
    const row = this.db.prepare('SELECT user_id FROM memories WHERE id = ?').get(memoryId) as
      { user_id: number } | undefined;
    if (!row) return 0;
    const events = this.db.prepare(
      'SELECT COALESCE(MAX(id), 0) AS revision FROM memory_events WHERE user_id = ? AND memory_id = ?',
    ).get(row.user_id, memoryId) as { revision: number };
    return events.revision;
  }

  /** Assign (or clear with null) a memory's category. Access-scoped via {@link getAccessible}; a
   *  non-null categoryId must be usable by the CALLER (their own category, or a shared pool they
   *  share — see canUseCategory). On a FOREIGN row (another author's shared memory) the ONLY permitted
   *  target is the pool the row already sits in: a member must not pull someone else's shared memory
   *  into a personal category (theft from the pool) nor re-file it elsewhere. Bumps updated_at, audits
   *  'categorize' against the ROW's author. */
  setCategory(userId: number, id: number, categoryId: number | null, actor: string, reason: string, model?: string | null): boolean {
    return this.db.transaction(() => {
      const before = this.getAccessible(userId, id);
      if (!before) return false;
      if (categoryId !== null && !canUseCategory(this.db, userId, categoryId)) return false;
      if (before.user_id !== userId && categoryId !== before.category_id) return false; // asymmetry rule
      this.db.prepare("UPDATE memories SET category_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(categoryId, id);
      const after = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
      this.audit(before.user_id, id, 'categorize', before, after, actor, reason, model);
      return true;
    })();
  }

  /** Assign a category only while the memory still matches the snapshot that was classified. This is the
   *  background-maintenance CAS: a body edit, status transition or manual category choice made during the
   *  model round-trip wins. A non-null target category must be usable by the caller (canUseCategory); on
   *  a foreign shared row the same asymmetry rule as {@link setCategory} applies. The revision compare is
   *  keyed to the ROW's author (see {@link revision}). */
  setCategoryIfUnchanged(
    userId: number,
    id: number,
    expected: {
      bodyHash: string;
      categoryId: number | null;
      revision?: number;
      targetCategoryFingerprint?: string | null;
    },
    categoryId: number | null,
    actor: string,
    reason: string,
    model?: string | null,
  ): boolean {
    return this.db.transaction(() => {
      const before = this.getAccessible(userId, id);
      if (!before || before.status !== 'active') return false;
      if (hashBody(before.body) !== expected.bodyHash || before.category_id !== expected.categoryId) return false;
      if (expected.revision !== undefined && this.revision(id) !== expected.revision) return false;
      if (categoryId !== null) {
        const target = this.db.prepare(
          `SELECT id, user_id, name, description, color, icon, is_builtin,
                  project_id AS projectId, created_at
             FROM memory_categories WHERE id = ?`,
        ).get(categoryId) as MemoryCategoryRow | undefined;
        if (!target || !canUseCategory(this.db, userId, categoryId)) return false;
        if (before.user_id !== userId && categoryId !== before.category_id) return false; // asymmetry rule
        if (expected.targetCategoryFingerprint !== undefined
          && memoryCategoryFingerprint(target) !== expected.targetCategoryFingerprint) return false;
      }
      if (categoryId === before.category_id) return true;
      this.db.prepare("UPDATE memories SET category_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(categoryId, id);
      const after = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
      this.audit(before.user_id, id, 'categorize', before, after, actor, reason, model);
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
   *  Float32Array. User-scoped (the join keys on this user's memories) — with `sharedCategoryIds`,
   *  other authors' rows in those pools join the candidate set. Powers vector retrieval —
   *  MemoryService cosine-scans this set. Rows without an embedding are excluded (INNER JOIN); rows whose
   *  stored vector is STALE (the body was edited since it was embedded, so content_hash no longer matches
   *  the current body) are also excluded, so retrieval never ranks against an out-of-date vector — the
   *  memory falls back to keyword search until the embed queue re-vectorizes it. */
  listActiveWithEmbeddings(userId: number, sharedCategoryIds: number[] = []): { memory: MemoryRow; vector: Float32Array }[] {
    const scope = sharedCategoryIds.length > 0
      ? `(m.user_id = ? OR m.category_id IN (${sharedCategoryIds.map(() => '?').join(', ')}))`
      : 'm.user_id = ?';
    const params: (string | number)[] = sharedCategoryIds.length > 0 ? [userId, ...sharedCategoryIds] : [userId];
    const rows = this.db.prepare(
      `SELECT m.*, e.vector AS vector, e.content_hash AS embedded_hash
         FROM memories m JOIN memory_embeddings e ON e.memory_id = m.id
        WHERE ${scope} AND m.status = 'active'
        ORDER BY m.updated_at DESC, m.id DESC`
    ).all(...params) as (MemoryRow & { vector: Buffer; embedded_hash: string })[];
    return rows
      .filter((r) => r.embedded_hash === hashBody(r.body)) // drop stale vectors — body edited since embed
      .map(({ vector, embedded_hash, ...memory }) => ({
        memory: memory as MemoryRow,
        // Unpack the little-endian BLOB. Slice to a fresh ArrayBuffer so the view isn't tied to the
        // BLOB's byteOffset within a shared buffer (better-sqlite3 hands back a Node Buffer).
        vector: new Float32Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)),
      }));
  }

  /** Upsert an ACTIVE memory's embedding. Packs a Float32Array into a raw BLOB (a Buffer is stored as-is).
   *  Returns whether the compare-and-set wrote the vector.
   *  Compare-and-set on THREE invariants, so a background embed can't persist a wrong or obsolete vector:
   *   - ownership: no-op if the memory isn't owned by this user (a foreign embedding must never be written);
   *   - lifecycle: no-op if the memory was archived/deleted while provider inference was in flight;
   *   - freshness: no-op if the current body no longer hashes to `input.contentHash`. The queue embeds a
   *     snapshot body, awaits the provider, then writes back — if the body was edited during that await,
   *     the snapshot vector is stale and writing it would clobber the current body's (or a fresher) vector.
   *  The read+write is atomic (better-sqlite3 is synchronous — no await between them). */
  setEmbedding(userId: number, memoryId: number, input: SetEmbeddingInput): boolean {
    const owned = this.db.prepare('SELECT body, status FROM memories WHERE id = ? AND user_id = ?')
      .get(memoryId, userId) as { body: string; status: string } | undefined;
    if (!owned || owned.status !== 'active') return false;
    // Compare-and-set: only persist the vector if it was computed from the active body still in the DB.
    if (hashBody(owned.body) !== input.contentHash) return false;
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
    return true;
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
   *  memory's created_at keeps the trail to this memory only. Keyed to the ROW's author (events carry the
   *  author's user_id, whoever mutated the memory), so a member sees the shared memory's full trail. */
  eventsForMemory(memoryId: number): MemoryEventRow[] {
    return this.db.prepare(
      `SELECT e.* FROM memory_events e
        WHERE e.memory_id = ?
          AND e.user_id = (SELECT user_id FROM memories WHERE id = ?)
          AND e.created_at >= (SELECT created_at FROM memories WHERE id = ?)
        ORDER BY e.id DESC`
    ).all(memoryId, memoryId, memoryId) as MemoryEventRow[];
  }

  /** Hard-delete everything a user OWNS (memories cascade to embeddings) plus their audit events.
   *  Used only by user-delete cleanup — normal deletes are soft.
   *
   *  Shared-pool rows authored by the deleted user are NOT deleted: the pool belongs to the team, so
   *  they are re-attributed to the instance sentinel (user_id = 0) together with their audit events,
   *  keeping `eventsForMemory`'s author-derivation consistent. Their own recall events as a READER are
   *  deleted with the account (they are the deleted account's analytics). */
  removeForUser(userId: number): void {
    this.db.transaction(() => {
      const sharedRowIds = this.db.prepare(
        `SELECT id FROM memories WHERE user_id = ? AND category_id IN
           (SELECT id FROM memory_categories WHERE user_id = 0 AND project_id IS NOT NULL)`
      ).all(userId) as { id: number }[];
      for (const { id } of sharedRowIds) {
        this.db.prepare('UPDATE memories SET user_id = 0 WHERE id = ?').run(id);
        this.db.prepare('UPDATE memory_events SET user_id = 0 WHERE memory_id = ?').run(id);
      }
      this.db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM memory_events WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM memory_usage_events WHERE user_id = ?').run(userId);
    })();
  }

  /** Set a memory's status (own row, or another author's shared-pool row) and audit the transition.
   *  Returns false if not accessible. */
  private setStatus(userId: number, id: number, status: string, action: string, actor: string, reason: string): boolean {
    return this.db.transaction(() => {
      const before = this.getAccessible(userId, id);
      if (!before) return false;
      this.db.prepare("UPDATE memories SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(status, id);
      const after = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
      this.audit(before.user_id, id, action, before, after, actor, reason);
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
