import { createHash } from 'node:crypto';
import type { Db } from './db.js';

/** A durable RAW memory row (v1: user-scoped). Deletes are SOFT (status='deleted'). */
export interface MemoryRow {
  id: number;
  user_id: number;
  body: string;
  kind: string;
  importance: number;
  confidence: number;
  source: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
}

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

/** Append-only audit of a memory mutation. before/after are JSON snapshots. */
export interface MemoryEventRow {
  id: number;
  memory_id: number | null;
  user_id: number;
  action: string;
  before_json: string | null;
  after_json: string | null;
  actor: string;
  reason: string;
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

/** Persistence for Orca RAW memories (v1: user-scoped). Every read/write is filtered by user_id and
 *  id-addressed ops enforce ownership. Embeddings live inline as packed Float32 BLOBs (no external
 *  vector DB); this store does NOT make embedding HTTP calls — that's EmbeddingService. Vector search
 *  is Phase 4; `search` here is a keyword LIKE fallback. Deletes are soft (status='deleted'); every
 *  mutation is audited in memory_events. */
export class MemoryStore {
  constructor(private db: Db) {}

  /** Insert a memory and audit the 'add' (after_json = the new row). Atomic. Returns the full row. */
  add(userId: number, input: MemoryInput, actor: string, reason: string): MemoryRow {
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
      this.audit(userId, row.id, 'add', null, row, actor, reason);
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
    let sql = `SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id DESC`;
    if (opts.limit !== undefined) { sql += ' LIMIT ?'; params.push(opts.limit); }
    if (opts.offset !== undefined) { sql += ' OFFSET ?'; params.push(opts.offset); }
    return this.db.prepare(sql).all(...params) as MemoryRow[];
  }

  /** Active memories, most-recently created first. */
  listRecent(userId: number, limit: number): MemoryRow[] {
    return this.db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND status = 'active'
       ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(userId, limit) as MemoryRow[];
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
  update(userId: number, id: number, patch: MemoryPatch, actor: string, reason: string): MemoryRow | undefined {
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
      this.audit(userId, id, 'update', before, after, actor, reason);
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

  /** Bump use_count and set last_used_at for each of the user's own memories. */
  markUsed(userId: number, ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      "UPDATE memories SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ? AND user_id = ?"
    );
    this.db.transaction(() => { for (const id of ids) stmt.run(id, userId); })();
  }

  /** Read the embedding for a memory owned by this user (join enforces ownership). */
  getEmbedding(userId: number, memoryId: number): MemoryEmbeddingRow | undefined {
    return this.db.prepare(
      `SELECT e.* FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
        WHERE e.memory_id = ? AND m.user_id = ?`
    ).get(memoryId, userId) as MemoryEmbeddingRow | undefined;
  }

  /** Active memories that already carry an embedding, paired with their vector unpacked back to a
   *  Float32Array. User-scoped (the join keys on this user's memories). Powers vector retrieval —
   *  MemoryService cosine-scans this set. Rows without an embedding are excluded (INNER JOIN). */
  listActiveWithEmbeddings(userId: number): { memory: MemoryRow; vector: Float32Array }[] {
    const rows = this.db.prepare(
      `SELECT m.*, e.vector AS vector
         FROM memories m JOIN memory_embeddings e ON e.memory_id = m.id
        WHERE m.user_id = ? AND m.status = 'active'
        ORDER BY m.updated_at DESC, m.id DESC`
    ).all(userId) as (MemoryRow & { vector: Buffer })[];
    return rows.map(({ vector, ...memory }) => ({
      memory: memory as MemoryRow,
      // Unpack the little-endian BLOB. Slice to a fresh ArrayBuffer so the view isn't tied to the
      // BLOB's byteOffset within a shared buffer (better-sqlite3 hands back a Node Buffer).
      vector: new Float32Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)),
    }));
  }

  /** Upsert a memory's embedding. Packs a Float32Array into a raw BLOB (a Buffer is stored as-is). No-op
   *  if the memory isn't owned by this user — a foreign embedding must never be written. */
  setEmbedding(userId: number, memoryId: number, input: SetEmbeddingInput): void {
    const owned = this.db.prepare('SELECT 1 FROM memories WHERE id = ? AND user_id = ?').get(memoryId, userId);
    if (!owned) return;
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

  /** Hard-delete everything for a user (memories cascade to embeddings) plus their audit events.
   *  Used only by user-delete cleanup — normal deletes are soft. */
  removeForUser(userId: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM memory_events WHERE user_id = ?').run(userId);
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

  /** Append one audit row. before/after are JSON-serialized (null passes through as SQL NULL). */
  private audit(userId: number, memoryId: number | null, action: string,
                before: unknown, after: unknown, actor: string, reason: string): void {
    this.db.prepare(
      `INSERT INTO memory_events (memory_id, user_id, action, before_json, after_json, actor, reason)
       VALUES (@memory_id, @user_id, @action, @before_json, @after_json, @actor, @reason)`
    ).run({
      memory_id: memoryId,
      user_id: userId,
      action,
      before_json: before === null || before === undefined ? null : JSON.stringify(before),
      after_json: after === null || after === undefined ? null : JSON.stringify(after),
      actor,
      reason,
    });
  }
}
