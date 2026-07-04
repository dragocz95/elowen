import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { MemoryStore, hashBody } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';

describe('MemoryStore', () => {
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(openDb(':memory:')); });

  it('add returns the full row and writes an add audit event', () => {
    const m = store.add(1, { body: 'likes espresso', importance: 5 }, 'agent', 'observed');
    expect(m).toMatchObject({ user_id: 1, body: 'likes espresso', kind: 'fact', importance: 5, status: 'active', use_count: 0 });
    expect(store.get(1, m.id)).toMatchObject({ id: m.id, body: 'likes espresso' });

    const events = store.listEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ memory_id: m.id, action: 'add', actor: 'agent', reason: 'observed' });
    expect(JSON.parse(events[0]!.after_json!)).toMatchObject({ body: 'likes espresso' });
    expect(events[0]!.before_json).toBeNull();
  });

  it('eventsForMemory scopes to the memory lifetime — a reused rowid never shows the prior memory\'s events', () => {
    const db = openDb(':memory:');
    const s = new MemoryStore(db);
    const m = s.add(1, { body: 'VPS má 30 GB RAM' }, 'agent', 'curator: new durable fact');
    // Simulate a PRIOR occupant of this rowid (what a hard purge + rowid reuse leaves behind): an event
    // with the same memory_id but dated BEFORE this memory was created.
    db.prepare(
      `INSERT INTO memory_events (memory_id, user_id, action, after_json, actor, reason, created_at)
       VALUES (?, 1, 'add', ?, 'agent', 'curator: new durable fact', '2000-01-01 00:00:00')`
    ).run(m.id, JSON.stringify({ body: 'Projekt sarah_hair má dvě databáze' }));

    const scoped = s.eventsForMemory(1, m.id);
    expect(scoped.some((e) => (e.after_json ?? '').includes('sarah_hair'))).toBe(false);
    expect(scoped.some((e) => (e.after_json ?? '').includes('VPS'))).toBe(true);
  });

  it('list default excludes soft-deleted and orders updated_at DESC', () => {
    const a = store.add(1, { body: 'a' }, 'agent', '');
    const b = store.add(1, { body: 'b' }, 'agent', '');
    store.softDelete(1, a.id, 'agent', '');
    const list = store.list(1);
    expect(list.map((m) => m.id)).toEqual([b.id]);
    // status '' includes every status
    expect(store.list(1, { status: '' }).map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('softDelete then restore roundtrips and audits both transitions', () => {
    const m = store.add(1, { body: 'x' }, 'agent', '');
    expect(store.softDelete(1, m.id, 'user:1', 'obsolete')).toBe(true);
    expect(store.get(1, m.id)?.status).toBe('deleted');
    expect(store.restore(1, m.id, 'user:1', 'oops')).toBe(true);
    expect(store.get(1, m.id)?.status).toBe('active');

    const actions = store.listEvents(1).map((e) => e.action);
    expect(actions).toContain('delete');
    expect(actions).toContain('restore');
  });

  it('merge creates a new memory, soft-deletes sources, and audits source ids', () => {
    const a = store.add(1, { body: 'lives in Prague' }, 'agent', '');
    const b = store.add(1, { body: 'moved to Prague 2020' }, 'agent', '');
    const merged = store.merge(1, [a.id, b.id], 'lives in Prague since 2020', 'agent', 'dedup');

    expect(merged.body).toBe('lives in Prague since 2020');
    expect(merged.status).toBe('active');
    expect(store.get(1, a.id)?.status).toBe('deleted');
    expect(store.get(1, b.id)?.status).toBe('deleted');

    const mergeEvent = store.listEvents(1).find((e) => e.action === 'merge')!;
    expect(JSON.parse(mergeEvent.after_json!)).toMatchObject({ mergedId: merged.id, sourceIds: [a.id, b.id] });
  });

  it('purge is a HARD delete: the row is gone from EVERY status and its embedding cascades away', () => {
    const active = store.add(1, { body: 'still active' }, 'agent', '');
    const trashed = store.add(1, { body: 'in trash' }, 'agent', '');
    store.setEmbedding(1, trashed.id, { provider: 'p', model: 'm', dimensions: 1, vector: new Float32Array([1]), contentHash: hashBody('in trash') });
    store.softDelete(1, trashed.id, 'user:1', '');
    expect(store.getEmbedding(1, trashed.id)).toBeDefined(); // embedding present before purge

    // Purge a SOFT-DELETED row: it must physically vanish (not a status flip) and its vector cascade away.
    expect(store.purge(1, trashed.id, 'user:1', 'gone')).toBe(true);
    expect(store.get(1, trashed.id)).toBeUndefined();                       // not readable at any status
    expect(store.list(1, { status: 'all' }).map((m) => m.id)).toEqual([active.id]); // truly removed
    expect(store.getEmbedding(1, trashed.id)).toBeUndefined();              // embedding cascaded

    // Purge also works on an ACTIVE row (any status), leaving a 'purge' audit behind.
    expect(store.purge(1, active.id, 'user:1', 'gone')).toBe(true);
    expect(store.list(1, { status: 'all' })).toHaveLength(0);
    expect(store.listEvents(1).some((e) => e.action === 'purge')).toBe(true);
  });

  it('purge is owner-scoped: a foreign id is a no-op and never deletes another user’s row', () => {
    const mine = store.add(1, { body: 'mine' }, 'agent', '');
    const theirs = store.add(2, { body: 'theirs' }, 'agent', '');
    expect(store.purge(1, theirs.id, 'user:1', 'x')).toBe(false); // not owned → false
    expect(store.get(2, theirs.id)).toBeDefined();                 // untouched
    expect(store.purge(1, 99999, 'user:1', 'x')).toBe(false);      // missing → false
    expect(store.get(1, mine.id)).toBeDefined();
  });

  it('purgeDeleted hard-deletes ONLY soft-deleted rows and returns the count', () => {
    const active = store.add(1, { body: 'a' }, 'agent', '');
    const d1 = store.add(1, { body: 'd1' }, 'agent', '');
    const d2 = store.add(1, { body: 'd2' }, 'agent', '');
    const otherUserDeleted = store.add(2, { body: 'other' }, 'agent', '');
    store.softDelete(1, d1.id, 'user:1', '');
    store.softDelete(1, d2.id, 'user:1', '');
    store.softDelete(2, otherUserDeleted.id, 'user:2', '');

    expect(store.purgeDeleted(1, 'user:1', 'trash')).toBe(2);
    expect(store.list(1, { status: 'all' }).map((m) => m.id)).toEqual([active.id]); // active kept
    expect(store.get(2, otherUserDeleted.id)?.status).toBe('deleted');              // other user untouched
    // Nothing deleted left for this user → a second empty-trash returns 0.
    expect(store.purgeDeleted(1, 'user:1', 'trash')).toBe(0);
  });

  it('add/update/setCategory record the model on the audit row; other events keep model null', () => {
    const db = openDb(':memory:');
    const s = new MemoryStore(db);
    const cats = new MemoryCategoryStore(db);
    const m = s.add(1, { body: 'fact' }, 'agent', 'observed', 'gpt-add');
    s.update(1, m.id, { body: 'fact v2' }, 'agent', 'revised', 'gpt-update');
    const cat = cats.create(1, { name: 'Infra' });
    s.setCategory(1, m.id, cat.id, 'agent', 'categorized', 'gpt-cat');
    s.softDelete(1, m.id, 'user:1', 'obsolete'); // no model passed → null

    const byAction = Object.fromEntries(s.listEvents(1).map((e) => [e.action, e.model]));
    expect(byAction.add).toBe('gpt-add');
    expect(byAction.update).toBe('gpt-update');
    expect(byAction.categorize).toBe('gpt-cat');
    expect(byAction.delete).toBeNull();
  });

  it('setEmbedding/getEmbedding roundtrips a Float32 vector exactly', () => {
    const m = store.add(1, { body: 'vec' }, 'agent', '');
    const vec = new Float32Array([0.1, -0.5, 3.14159, 0, 42.25]);
    store.setEmbedding(1, m.id, { provider: 'openai', model: 'text-embedding-3-small', dimensions: vec.length, vector: vec, contentHash: hashBody('vec') });

    const row = store.getEmbedding(1, m.id)!;
    expect(row.dimensions).toBe(5);
    expect(row.provider).toBe('openai');
    const back = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    expect(Array.from(back)).toEqual(Array.from(vec));
  });

  it('setEmbedding upserts (replaces) an existing embedding', () => {
    const m = store.add(1, { body: 'vec' }, 'agent', '');
    const h = hashBody('vec');
    store.setEmbedding(1, m.id, { provider: 'a', model: 'm1', dimensions: 2, vector: new Float32Array([1, 2]), contentHash: h });
    store.setEmbedding(1, m.id, { provider: 'b', model: 'm2', dimensions: 2, vector: new Float32Array([3, 4]), contentHash: h });
    const row = store.getEmbedding(1, m.id)!;
    expect(row.provider).toBe('b');
    expect(row.model).toBe('m2');
    expect(row.content_hash).toBe(h);
  });

  it('listActiveWithEmbeddings returns active rows joined to their unpacked vectors, user-scoped', () => {
    const a = store.add(1, { body: 'has vector' }, 'agent', '');
    store.add(1, { body: 'no vector yet' }, 'agent', ''); // excluded: no embedding
    const deleted = store.add(1, { body: 'deleted with vector' }, 'agent', '');
    store.add(2, { body: "other user's" }, 'agent', '');

    const va = new Float32Array([0.25, -1.5, 3]);
    store.setEmbedding(1, a.id, { provider: 'p', model: 'm', dimensions: va.length, vector: va, contentHash: hashBody('has vector') });
    store.setEmbedding(1, deleted.id, { provider: 'p', model: 'm', dimensions: 2, vector: new Float32Array([1, 2]), contentHash: hashBody('deleted with vector') });
    store.softDelete(1, deleted.id, 'agent', ''); // now inactive → excluded

    const rows = store.listActiveWithEmbeddings(1);
    expect(rows.map((r) => r.memory.id)).toEqual([a.id]);
    expect(Array.from(rows[0]!.vector)).toEqual(Array.from(va));
    // user 2 sees nothing (their memory has no embedding, and A's is not theirs)
    expect(store.listActiveWithEmbeddings(2)).toHaveLength(0);
  });

  it('listActiveWithEmbeddings excludes a STALE vector until the body is re-embedded', () => {
    const m = store.add(1, { body: 'original body' }, 'agent', '');
    const v = new Float32Array([1, 2, 3]);
    store.setEmbedding(1, m.id, { provider: 'p', model: 'm', dimensions: 3, vector: v, contentHash: hashBody('original body') });
    // Fresh embedding → visible to retrieval.
    expect(store.listActiveWithEmbeddings(1).map((r) => r.memory.id)).toEqual([m.id]);

    // Edit the body: the stored vector is now stale (embedded from the old body). The row still has an
    // embedding, but retrieval must NOT use it, or it would rank the memory against out-of-date text.
    store.update(1, m.id, { body: 'edited body' }, 'user:1', 'fix');
    expect(store.listActiveWithEmbeddings(1)).toHaveLength(0);

    // Re-embed the new body → visible again.
    store.setEmbedding(1, m.id, { provider: 'p', model: 'm', dimensions: 3, vector: v, contentHash: hashBody('edited body') });
    expect(store.listActiveWithEmbeddings(1).map((r) => r.memory.id)).toEqual([m.id]);
  });

  it('setEmbedding is a compare-and-set: a vector for an outdated body is not written', () => {
    const m = store.add(1, { body: 'v1' }, 'agent', '');
    store.setEmbedding(1, m.id, { provider: 'p', model: 'm', dimensions: 1, vector: new Float32Array([1]), contentHash: hashBody('v1') });

    // Simulate the embed-queue race: the body was edited AFTER the snapshot was embedded but BEFORE the
    // vector is written back. The write carries the OLD body's hash → it must be rejected, leaving the
    // fresh (v1) vector in place rather than clobbering it with a stale one.
    store.update(1, m.id, { body: 'v2' }, 'user:1', 'edit');
    store.setEmbedding(1, m.id, { provider: 'stale', model: 'm', dimensions: 1, vector: new Float32Array([9]), contentHash: hashBody('v1') });
    const emb = store.getEmbedding(1, m.id)!;
    expect(emb.provider).toBe('p'); // unchanged — the stale write was a no-op
    expect(emb.content_hash).toBe(hashBody('v1'));
  });

  it('needsEmbedding detects missing and stale (body changed) embeddings', () => {
    const a = store.add(1, { body: 'has no vector' }, 'agent', '');
    const b = store.add(1, { body: 'fresh body' }, 'agent', '');
    // b gets a current embedding
    store.setEmbedding(1, b.id, { provider: 'p', model: 'm', dimensions: 1, vector: new Float32Array([1]), contentHash: hashBody('fresh body') });

    // Only a needs one (no embedding at all)
    expect(store.needsEmbedding(1).map((m) => m.id)).toEqual([a.id]);

    // Edit b's body → its stored hash goes stale
    store.update(1, b.id, { body: 'edited body' }, 'user:1', 'fix');
    expect(store.needsEmbedding(1).map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('needsEmbedding re-flags rows embedded under a different model/dimensions', () => {
    const m = store.add(1, { body: 'stable body' }, 'agent', '');
    store.setEmbedding(1, m.id, { provider: 'p', model: 'model-a', dimensions: 3, vector: new Float32Array([1, 2, 3]), contentHash: hashBody('stable body') });

    // Same model+dims → not stale.
    expect(store.needsEmbedding(1, { model: 'model-a', dimensions: 3 })).toHaveLength(0);
    // Model switched → re-embed even though the body is unchanged.
    expect(store.needsEmbedding(1, { model: 'model-b', dimensions: 3 }).map((r) => r.id)).toEqual([m.id]);
    // Dimensions switched → re-embed.
    expect(store.needsEmbedding(1, { model: 'model-a', dimensions: 768 }).map((r) => r.id)).toEqual([m.id]);
    // No active config passed → falls back to body-hash staleness only (unchanged behavior).
    expect(store.needsEmbedding(1)).toHaveLength(0);
  });

  it('markUsed bumps use_count and sets last_used_at', () => {
    const m = store.add(1, { body: 'x' }, 'agent', '');
    expect(store.get(1, m.id)?.use_count).toBe(0);
    store.markUsed(1, [m.id]);
    store.markUsed(1, [m.id]);
    const row = store.get(1, m.id)!;
    expect(row.use_count).toBe(2);
    expect(row.last_used_at).not.toBeNull();
  });

  it('removeForUser wipes memories, embeddings, and events for that user', () => {
    const m = store.add(1, { body: 'x' }, 'agent', '');
    store.setEmbedding(1, m.id, { provider: 'p', model: 'm', dimensions: 1, vector: new Float32Array([1]), contentHash: hashBody('x') });
    store.add(2, { body: 'other user' }, 'agent', '');

    store.removeForUser(1);
    expect(store.get(1, m.id)).toBeUndefined();
    expect(store.getEmbedding(1, m.id)).toBeUndefined(); // cascaded
    expect(store.listEvents(1)).toHaveLength(0);
    // user 2 untouched
    expect(store.list(2)).toHaveLength(1);
  });

  it('enforces cross-user isolation: user B cannot read or mutate user A memory', () => {
    const a = store.add(1, { body: 'secret of A' }, 'agent', '');
    // B cannot read
    expect(store.get(2, a.id)).toBeUndefined();
    // B cannot see it in lists/search
    expect(store.list(2)).toHaveLength(0);
    expect(store.search(2, 'secret', 10)).toHaveLength(0);
    // B cannot mutate
    expect(store.update(2, a.id, { body: 'hacked' }, 'user:2', 'x')).toBeUndefined();
    expect(store.softDelete(2, a.id, 'user:2', 'x')).toBe(false);
    // B cannot write an embedding onto A's memory, nor read A's embedding
    store.setEmbedding(1, a.id, { provider: 'p', model: 'm', dimensions: 1, vector: new Float32Array([1]), contentHash: hashBody('secret of A') });
    store.setEmbedding(2, a.id, { provider: 'evil', model: 'm', dimensions: 1, vector: new Float32Array([9]), contentHash: hashBody('secret of A') });
    expect(store.getEmbedding(1, a.id)?.provider).toBe('p'); // B's write was a no-op
    expect(store.getEmbedding(2, a.id)).toBeUndefined();
    // A's memory is intact and unaudited by B's failed attempts
    expect(store.get(1, a.id)?.body).toBe('secret of A');
    expect(store.listEvents(2)).toHaveLength(0);
  });

  it('search is an active-only keyword LIKE fallback', () => {
    const a = store.add(1, { body: 'prefers dark mode' }, 'agent', '');
    store.add(1, { body: 'uses vim keybindings' }, 'agent', '');
    const deleted = store.add(1, { body: 'dark theme old note' }, 'agent', '');
    store.softDelete(1, deleted.id, 'agent', '');

    const hits = store.search(1, 'dark', 10);
    expect(hits.map((m) => m.id)).toEqual([a.id]); // deleted excluded
  });

  it('add defaults category_id to null', () => {
    const m = store.add(1, { body: 'x' }, 'agent', '');
    expect(m.category_id).toBeNull();
  });
});

describe('MemoryStore category assignment', () => {
  let db: ReturnType<typeof openDb>;
  let store: MemoryStore;
  let cats: MemoryCategoryStore;
  beforeEach(() => {
    db = openDb(':memory:');
    store = new MemoryStore(db);
    cats = new MemoryCategoryStore(db);
  });

  it('setCategory assigns an owned category, bumps updated_at, and audits categorize', () => {
    const c = cats.create(1, { name: 'Práce' });
    const m = store.add(1, { body: 'x' }, 'agent', '');
    expect(store.setCategory(1, m.id, c.id, 'user:1', 'tag')).toBe(true);
    expect(store.get(1, m.id)?.category_id).toBe(c.id);

    const ev = store.listEvents(1).find((e) => e.action === 'categorize')!;
    expect(ev).toMatchObject({ memory_id: m.id, actor: 'user:1', reason: 'tag' });
    expect(JSON.parse(ev.before_json!).category_id).toBeNull();
    expect(JSON.parse(ev.after_json!).category_id).toBe(c.id);
  });

  it('setCategory(null) clears the category', () => {
    const c = cats.create(1, { name: 'Práce' });
    const m = store.add(1, { body: 'x' }, 'agent', '');
    store.setCategory(1, m.id, c.id, 'user:1', 'tag');
    expect(store.setCategory(1, m.id, null, 'user:1', 'clear')).toBe(true);
    expect(store.get(1, m.id)?.category_id).toBeNull();
  });

  it('setCategory rejects a foreign category id (no dangling write)', () => {
    const foreign = cats.create(2, { name: 'Other' });
    const m = store.add(1, { body: 'x' }, 'agent', '');
    expect(store.setCategory(1, m.id, foreign.id, 'user:1', 'tag')).toBe(false);
    expect(store.get(1, m.id)?.category_id).toBeNull();
    // No categorize audit was written.
    expect(store.listEvents(1).some((e) => e.action === 'categorize')).toBe(false);
  });

  it('setCategory returns false for a memory not owned by the user', () => {
    const c = cats.create(1, { name: 'Práce' });
    const m = store.add(1, { body: 'x' }, 'agent', '');
    expect(store.setCategory(2, m.id, c.id, 'user:2', 'tag')).toBe(false);
  });

  it('list filters by categoryId (number, null, and undefined)', () => {
    const c = cats.create(1, { name: 'Práce' });
    const tagged = store.add(1, { body: 'tagged' }, 'agent', '');
    const untagged = store.add(1, { body: 'untagged' }, 'agent', '');
    store.setCategory(1, tagged.id, c.id, 'user:1', 'tag');

    expect(store.list(1, { categoryId: c.id }).map((m) => m.id)).toEqual([tagged.id]);
    expect(store.list(1, { categoryId: null }).map((m) => m.id)).toEqual([untagged.id]);
    expect(store.list(1).map((m) => m.id).sort()).toEqual([tagged.id, untagged.id].sort());
  });
});
