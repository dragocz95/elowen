import { parseBody } from '../validation.js';
import { hashBody } from '../../store/memoryStore.js';
import { toEmbeddingConfig } from '../../store/configStore.js';
import { isEmbeddingConfigured } from '../../embeddings/embeddingService.js';
import {
  memoryCreateSchema, memoryPatchSchema, memoryMergeSchema, memoryRetrieveSchema, embeddingUpdateSchema,
  memoryPurgeSchema, memoryCategoryCreateSchema, memoryCategoryPatchSchema, memoryCategorySetSchema,
  memoryCategorySuggestIconSchema, categorizationUpdateSchema, memoryReclassifySchema,
} from '../schemas/memory.js';
import type { ElowenApp, RouteContext } from '../context.js';

/** How many pending memories one self-service /memory/reindex pass will re-embed. Bounded so a big
 *  backlog can't turn a single request into a long-running provider hammer — the rest drains via the
 *  background queue. */
const REINDEX_MAX = 100;

/** True for a better-sqlite3 UNIQUE-constraint violation (the per-user category-name key). The category
 *  store lets the SqliteError propagate so the route can map it to a 409 without a pre-check race. */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err
    && (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** Per-user private RAW memory: durable facts a user (or the brain on their behalf) stores, with a
 *  semantic-retrieval debugging surface and a self-service re-embed. Identity is ALWAYS the caller
 *  (`c.get('user')`), never a body/param field, so a user can only read or mutate their OWN memories
 *  (the store is user_id-scoped and no-ops / 404s on a foreign id). Provider (embedding) settings are
 *  workspace-level and admin-gated. Degrades to 400 when the store isn't wired. */
export function registerMemoryRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d } = ctx;
  const store = d.memoryStore;

  // --- Literal sub-paths registered before `/memory/:id` so they can never be captured as an id. ---

  // The caller's whole audit feed (newest first). Own memories only.
  app.get('/memory/events', (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const limit = c.req.query('limit');
    return c.json(store.listEvents(c.get('user').id, { limit: limit ? Number(limit) : undefined }));
  });

  // Read the workspace embedding block plus a computed `configured` flag (for the settings UI). Any
  // authed user may read it; only an admin may change it (PUT below).
  app.get('/memory/embedding', (c) => {
    const block = d.config.embeddingConfig();
    return c.json({ ...block, configured: isEmbeddingConfigured(toEmbeddingConfig(block)) });
  });

  // Update the workspace embedding provider/model. Admin-gated (mirrors PUT /config): during setup
  // (no users yet) it's open so onboarding can configure it before the first admin exists.
  app.put('/memory/embedding', async (c) => {
    if (d.users && d.users.count() > 0) {
      const u = c.get('user');
      if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403);
    }
    const b = await parseBody(c, embeddingUpdateSchema);
    return c.json(d.config.update({ embedding: b }).embedding);
  });

  // Admin probe: embed a tiny string to verify the configured provider/model actually works. Not
  // configured → 400; an embed failure surfaces as { ok:false, error } (200) so the UI can show it.
  app.post('/memory/embedding/test', async (c) => {
    if (d.users && d.users.count() > 0) {
      const u = c.get('user');
      if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403);
    }
    if (!d.embeddings) return c.json({ ok: false, error: 'memory unavailable' }, 400);
    const cfg = toEmbeddingConfig(d.config.embeddingConfig());
    if (!isEmbeddingConfigured(cfg)) return c.json({ ok: false, error: 'embeddings not configured' }, 400);
    try {
      const vec = await d.embeddings.embed(cfg, 'elowen memory embedding probe');
      return c.json({ ok: true, dimensions: vec.length, provider: cfg.providerId ?? cfg.baseUrl ?? null, model: cfg.model });
    } catch (err) {
      return c.json({ ok: false, error: String(err) });
    }
  });

  // Merge several of the caller's memories into one new fact; the sources are soft-deleted (owner-scoped
  // — a foreign source id is skipped, never merged).
  app.post('/memory/merge', async (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const b = await parseBody(c, memoryMergeSchema);
    return c.json(store.merge(userId, b.ids, b.body, `user:${userId}`, 'merged via API'), 201);
  });

  // Hard-delete a batch of the caller's memories by id (any status) — a real DELETE, not a soft flip.
  // Owner-scoped in the store (a foreign id is skipped). Registered before `/memory/:id`.
  app.post('/memory/purge', async (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const { ids } = await parseBody(c, memoryPurgeSchema);
    let purged = 0;
    for (const id of ids) { if (store.purge(userId, id, `user:${userId}`, 'purged via API')) purged += 1; }
    return c.json({ purged });
  });

  // Empty the trash: hard-delete ALL of the caller's soft-deleted memories. Owner-scoped, atomic.
  app.post('/memory/empty-trash', (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    return c.json({ purged: store.purgeDeleted(userId, `user:${userId}`, 'emptied trash via API') });
  });

  // Retrieval-debugging: rank the caller's memories against a query and return the picked set plus the
  // full scoring breakdown. POST because retrieve() mutates (markUsed) the returned memories.
  app.post('/memory/retrieve', async (c) => {
    if (!ctx.memoryService) return c.json({ error: 'memory unavailable' }, 400);
    const { query } = await parseBody(c, memoryRetrieveSchema);
    return c.json(await ctx.memoryService.retrieve(c.get('user').id, query));
  });

  // Self-service re-embed of the caller's pending (missing/stale) memories. Bounded per request and
  // best-effort per memory (a throwing embed is logged and skipped, not fatal). Embeddings unconfigured
  // → 400.
  app.post('/memory/reindex', async (c) => {
    if (!store || !d.embeddings) return c.json({ error: 'memory unavailable' }, 400);
    const cfg = toEmbeddingConfig(d.config.embeddingConfig());
    if (!isEmbeddingConfigured(cfg)) return c.json({ error: 'embeddings not configured' }, 400);
    const userId = c.get('user').id;
    const pending = store.needsEmbedding(userId, { model: cfg.model, dimensions: cfg.dimensions ?? null });
    let embedded = 0;
    for (const row of pending.slice(0, REINDEX_MAX)) {
      try {
        const vec = await d.embeddings.embed(cfg, row.body);
        store.setEmbedding(userId, row.id, {
          provider: cfg.providerId ?? '', model: cfg.model, dimensions: vec.length,
          vector: vec, contentHash: hashBody(row.body),
        });
        embedded += 1;
      } catch (err) {
        ctx.log.warn('reindex embed failed', { userId, memoryId: row.id, error: String(err) });
      }
    }
    return c.json({ embedded });
  });

  // --- Memory categories (owner-scoped) + the workspace categorization model. All literal `/memory/*`
  //     sub-paths, so they MUST stay above `/memory/:id` or the id route would swallow them. ---

  // The caller's categories, name-sorted. Own categories only.
  app.get('/memory/categories', (c) => {
    const cats = d.memoryCategoryStore;
    if (!cats) return c.json({ error: 'memory unavailable' }, 400);
    return c.json(cats.list(c.get('user').id));
  });

  // Model-suggest one allowlist icon for a category name (fail-soft 'Folder'). Literal sub-path — kept
  // above `/memory/categories/:cid`; the :cid routes are PATCH/DELETE so there is no method clash anyway.
  app.post('/memory/categories/suggest-icon', async (c) => {
    const categorizer = d.memoryCategorizer;
    const { name } = await parseBody(c, memoryCategorySuggestIconSchema);
    // No categorizer wired → fail-soft to the default glyph (the store's clamp fallback), never a 400.
    const icon = categorizer ? await categorizer.suggestIcon(name) : 'Folder';
    return c.json({ icon });
  });

  // Create a category for the caller. A duplicate name (UNIQUE(user_id,name)) → 409. When no icon is
  // supplied, the server auto-suggests one from the name (model-driven, fail-soft 'Folder').
  app.post('/memory/categories', async (c) => {
    const cats = d.memoryCategoryStore;
    if (!cats) return c.json({ error: 'memory unavailable' }, 400);
    const b = await parseBody(c, memoryCategoryCreateSchema);
    const icon = b.icon ?? (d.memoryCategorizer ? await d.memoryCategorizer.suggestIcon(b.name) : undefined);
    try {
      return c.json(cats.create(c.get('user').id, { ...b, icon }), 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: 'category name already exists' }, 409);
      throw err;
    }
  });

  // Partial update (owner-scoped → 404 on a foreign/missing id). A name collision → 409.
  app.patch('/memory/categories/:cid', async (c) => {
    const cats = d.memoryCategoryStore;
    if (!cats) return c.json({ error: 'memory unavailable' }, 400);
    const b = await parseBody(c, memoryCategoryPatchSchema);
    try {
      const updated = cats.update(c.get('user').id, Number(c.req.param('cid')), b);
      if (!updated) return c.json({ error: 'not found' }, 404);
      return c.json(updated);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: 'category name already exists' }, 409);
      throw err;
    }
  });

  // Delete a category (idempotent). The store atomically clears the category off referencing memories
  // before removing it, so no memory is left pointing at a dangling id.
  app.delete('/memory/categories/:cid', (c) => {
    const cats = d.memoryCategoryStore;
    if (!cats) return c.json({ error: 'memory unavailable' }, 400);
    cats.delete(c.get('user').id, Number(c.req.param('cid')));
    return c.json({ ok: true });
  });

  // Read the workspace categorization model block plus a computed `configured` flag (for the settings
  // UI). Any authed user may read it; only an admin may change it (PUT below).
  app.get('/memory/categorization', (c) => {
    const block = d.config.categorizationConfig();
    return c.json({ ...block, configured: !!(block.providerId && block.model) });
  });

  // Update the workspace categorization provider/model. Admin-gated (mirrors PUT /memory/embedding):
  // during setup (no users yet) it's open so onboarding can configure it before the first admin exists.
  app.put('/memory/categorization', async (c) => {
    if (d.users && d.users.count() > 0) {
      const u = c.get('user');
      if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403);
    }
    const b = await parseBody(c, categorizationUpdateSchema);
    return c.json(d.config.update({ categorization: b }).categorization);
  });

  // Manual (re)classify pass over the caller's active memories. Owner-scoped (NOT admin) — a user
  // reclassifies their OWN memories. 400 when the categorizer isn't wired or has no model configured.
  app.post('/memory/reclassify', async (c) => {
    const categorizer = d.memoryCategorizer;
    if (!categorizer) return c.json({ error: 'memory unavailable' }, 400);
    if (!categorizer.configured()) return c.json({ error: 'categorization not configured' }, 400);
    const b = await parseBody(c, memoryReclassifySchema);
    return c.json(await categorizer.reclassify(c.get('user').id, b));
  });

  // --- Collection + id-addressed CRUD (owner-scoped). ---

  // List the caller's memories, optionally narrowed (?status=&kind=&categoryId=&limit=&offset=). A `?q=`
  // runs a semantic (embedding) search — ranked by relevance to the query, on-topic only — degrading to
  // the store's keyword LIKE search when embeddings aren't configured. `categoryId` empty/`null` =
  // uncategorized, a number = that category, absent = no category filter. Own memories only.
  app.get('/memory', async (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const q = c.req.query('q');
    const limit = c.req.query('limit');
    if (q && q.trim() !== '') {
      const lim = limit ? Number(limit) : 50;
      if (ctx.memoryService) return c.json(await ctx.memoryService.searchSemantic(userId, q, lim));
      return c.json(store.search(userId, q, lim));
    }
    const cat = c.req.query('categoryId');
    return c.json(store.list(userId, {
      status: c.req.query('status'),
      kind: c.req.query('kind'),
      categoryId: cat === undefined ? undefined : (cat === '' || cat === 'null' ? null : Number(cat)),
      limit: limit ? Number(limit) : undefined,
      offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
    }));
  });

  // Create a memory for the caller (source='user', actor='user:<id>').
  app.post('/memory', async (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const b = await parseBody(c, memoryCreateSchema);
    return c.json(store.add(userId, { ...b, source: 'user' }, `user:${userId}`, 'created via API'), 201);
  });

  // Read one of the caller's memories. Owner-scoped → a foreign id is 404.
  app.get('/memory/:id', (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const row = store.get(c.get('user').id, Number(c.req.param('id')));
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(row);
  });

  // Partial update. The store scopes to the owner, so a patch aimed at a foreign id matches nothing and
  // returns undefined → 404 (the ownership boundary).
  app.patch('/memory/:id', async (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const b = await parseBody(c, memoryPatchSchema);
    const updated = store.update(userId, Number(c.req.param('id')), b, `user:${userId}`, 'edited via API');
    if (!updated) return c.json({ error: 'not found' }, 404);
    return c.json(updated);
  });

  // Soft-delete (owner-scoped no-op on a foreign id).
  app.delete('/memory/:id', (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    store.softDelete(userId, Number(c.req.param('id')), `user:${userId}`, 'deleted via API');
    return c.json({ ok: true });
  });

  // Hard-delete ONE of the caller's memories (any status) — a real DELETE, not a soft flip. Owner-scoped
  // → 404 on a foreign/missing id. The embedding cascades away; a 'purge' audit is written first.
  app.delete('/memory/:id/purge', (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const ok = store.purge(userId, Number(c.req.param('id')), `user:${userId}`, 'purged via API');
    if (!ok) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  // Restore a soft-deleted memory. Owner-scoped → 404 on a foreign/missing id.
  app.post('/memory/:id/restore', (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const ok = store.restore(userId, Number(c.req.param('id')), `user:${userId}`, 'restored via API');
    if (!ok) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  // Assign (or clear with null) a memory's category — a separately-audited 'categorize' write, not a
  // field on PATCH. Owner-scoped: the store rejects a foreign/missing memory AND a categoryId not owned
  // by the caller, so a bad id can't plant a dangling/foreign category → both surface as 404.
  app.put('/memory/:id/category', async (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const id = Number(c.req.param('id'));
    const b = await parseBody(c, memoryCategorySetSchema);
    const ok = store.setCategory(userId, id, b.categoryId, `user:${userId}`, 'categorized via API');
    if (!ok) return c.json({ error: 'not found' }, 404);
    return c.json(store.get(userId, id));
  });

  // That one memory's audit trail (owner-scoped): verify ownership, then read events scoped to THIS
  // memory's lifetime (a reused rowid must not surface the prior, purged memory's history).
  app.get('/memory/:id/events', (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const id = Number(c.req.param('id'));
    if (!store.get(userId, id)) return c.json({ error: 'not found' }, 404);
    return c.json(store.eventsForMemory(userId, id));
  });
}
