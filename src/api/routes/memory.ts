import { parseBody, queryInt } from '../validation.js';
import { hashBody } from '../../store/memoryStore.js';
import { toEmbeddingConfig } from '../../store/configStore.js';
import { isEmbeddingConfigured } from '../../embeddings/embeddingService.js';
import { vitality, type MemoryRetentionConfig } from '../../brain/memoryVitality.js';
import { buildVitalityHistory } from '../../brain/memoryVitalityHistory.js';
import {
  memoryCreateSchema, memoryPatchSchema, memoryMergeSchema, memoryRetrieveSchema, embeddingUpdateSchema,
  memoryPurgeSchema, memoryCategoryCreateSchema, memoryCategoryPatchSchema, memoryCategorySetSchema,
  memoryCategorySuggestIconSchema, categorizationUpdateSchema, memoryReclassifySchema,
  memoryMaintenanceStartSchema, memoryMaintenanceRecategorizeSchema,
} from '../schemas/memory.js';
import { MemoryMaintenanceUnavailableError } from '../../brain/memoryMaintenanceService.js';
import type { ElowenApp, RouteContext } from '../context.js';
import type { MemoryRow } from '../../shared/wireContract.js';

type MemoryWithVitality = MemoryRow & { vitality: number };

function withVitality(
  row: MemoryRow,
  memoryService: RouteContext['memoryService'],
  retention: () => MemoryRetentionConfig,
): MemoryWithVitality {
  return {
    ...row,
    vitality: memoryService?.vitalityOf(row) ?? vitality(row, retention(), Date.now()),
  };
}

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

function maintenanceError(error: unknown): string | null {
  return error instanceof MemoryMaintenanceUnavailableError ? error.message : null;
}

/** Per-user private RAW memory: durable facts a user (or the brain on their behalf) stores, with a
 *  semantic-retrieval debugging surface and a self-service re-embed. Identity is ALWAYS the caller
 *  (`c.get('user')`), never a body/param field, so a user can only read or mutate their OWN memories
 *  (the store is user_id-scoped and no-ops / 404s on a foreign id). Provider (embedding) settings are
 *  workspace-level and admin-gated. Degrades to 400 when the store isn't wired. */
export function registerMemoryRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, canAccessProject, notAdminUnlessSetup } = ctx;
  const store = d.memoryStore;
  const withCurrentVitality = (row: MemoryRow): MemoryWithVitality =>
    withVitality(row, ctx.memoryService, () => d.config.get().runtime.memoryRetention);

  // --- Literal sub-paths registered before `/memory/:id` so they can never be captured as an id. ---

  // The caller's whole audit feed (newest first). Own memories only.
  app.get('/memory/events', (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const limit = queryInt(c.req.query('limit'), { min: 1, fallback: undefined }); // guard NaN → LIMIT bind → 500
    return c.json(store.listEvents(c.get('user').id, { limit }));
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
    if (notAdminUnlessSetup(c)) return c.json({ error: 'forbidden' }, 403);
    const b = await parseBody(c, embeddingUpdateSchema);
    return c.json(d.config.update({ embedding: b }).embedding);
  });

  // Admin probe: embed a tiny string to verify the configured provider/model actually works. Not
  // configured → 400; an embed failure surfaces as { ok:false, error } (200) so the UI can show it.
  app.post('/memory/embedding/test', async (c) => {
    if (notAdminUnlessSetup(c)) return c.json({ error: 'forbidden' }, 403);
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
    return c.json(withCurrentVitality(store.merge(userId, b.ids, b.body, `user:${userId}`, 'merged via API')), 201);
  });

  // Hard-delete a batch of the caller's memories by id (any status) — a real DELETE, not a soft flip.
  // Owner-scoped in the store (a foreign id is skipped), and atomic: the batch is one transaction, so a
  // failure part-way through can't leave its prefix irreversibly deleted. Registered before `/memory/:id`.
  app.post('/memory/purge', async (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const { ids } = await parseBody(c, memoryPurgeSchema);
    return c.json({ purged: store.purgeMany(userId, ids, `user:${userId}`, 'purged via API') });
  });

  // Empty the trash: hard-delete ALL of the caller's soft-deleted memories. Owner-scoped, atomic.
  app.post('/memory/empty-trash', (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    return c.json({ purged: store.purgeDeleted(userId, `user:${userId}`, 'emptied trash via API') });
  });

  // Retrieval-debugging: rank the caller's memories against a query and return the picked set plus the
  // full scoring breakdown. Retrieval no longer touches usage counters at all — only a caller that
  // actually delivers the memories to the model marks them — so inspection needs no opt-out.
  app.post('/memory/retrieve', async (c) => {
    if (!ctx.memoryService) return c.json({ error: 'memory unavailable' }, 400);
    const { query } = await parseBody(c, memoryRetrieveSchema);
    const userId = c.get('user').id;
    // The inspector has no turn/project context, so scoping it like a real recall would collapse to the
    // caller's global categories and hide their project memories. Inspect across every category instead;
    // uncategorized stay excluded, matching what recall would never surface.
    return c.json(await ctx.memoryService.retrieve(userId, query, {
      scope: ctx.memoryService.allCategoriesScope(userId),
    }));
  });

  // Owner-scoped background maintenance. The body carries no identity; a duplicate start returns the
  // existing running job, and GET reports only the caller's own two operation slots.
  app.get('/memory/maintenance', (c) => {
    if (!ctx.memoryMaintenance) return c.json({ error: 'memory unavailable' }, 400);
    return c.json(ctx.memoryMaintenance.status(c.get('user').id));
  });

  app.post('/memory/maintenance/reindex', async (c) => {
    if (!ctx.memoryMaintenance) return c.json({ error: 'memory unavailable' }, 400);
    await parseBody(c, memoryMaintenanceStartSchema);
    try {
      return c.json(ctx.memoryMaintenance.startReindex(c.get('user').id), 202);
    } catch (error) {
      const message = maintenanceError(error);
      if (message) return c.json({ error: message }, 400);
      throw error;
    }
  });

  app.post('/memory/maintenance/recategorize', async (c) => {
    if (!ctx.memoryMaintenance) return c.json({ error: 'memory unavailable' }, 400);
    const { mode } = await parseBody(c, memoryMaintenanceRecategorizeSchema);
    try {
      return c.json(ctx.memoryMaintenance.startRecategorize(c.get('user').id, mode), 202);
    } catch (error) {
      const message = maintenanceError(error);
      if (message) return c.json({ error: message }, 400);
      throw error;
    }
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
        const written = store.setEmbedding(userId, row.id, {
          provider: cfg.providerId ?? '', model: cfg.model, dimensions: vec.length,
          vector: vec, contentHash: hashBody(row.body),
        });
        if (written) embedded += 1;
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
    if (b.projectId != null) {
      const projectExists = b.projectId === d.project.id || !!d.projects?.get(b.projectId);
      if (!projectExists) return c.json({ error: 'project not found' }, 404);
      if (!canAccessProject(c, b.projectId)) return c.json({ error: 'forbidden' }, 403);
    }
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
    if (b.projectId != null) {
      const projectExists = b.projectId === d.project.id || !!d.projects?.get(b.projectId);
      if (!projectExists) return c.json({ error: 'project not found' }, 404);
      if (!canAccessProject(c, b.projectId)) return c.json({ error: 'forbidden' }, 403);
    }
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
    if (notAdminUnlessSetup(c)) return c.json({ error: 'forbidden' }, 403);
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
      const lim = queryInt(limit, { min: 1, max: 500, fallback: 50 }); // guard NaN → LIMIT bind → 500
      const rows = ctx.memoryService
        ? await ctx.memoryService.searchSemantic(userId, q, lim)
        : store.search(userId, q, lim);
      return c.json(rows.map(withCurrentVitality));
    }
    const cat = c.req.query('categoryId');
    const rows = store.list(userId, {
      status: c.req.query('status'),
      kind: c.req.query('kind'),
      categoryId: cat === undefined ? undefined : (cat === '' || cat === 'null' ? null : Number(cat)),
      limit: queryInt(limit, { min: 1, max: 500, fallback: undefined }),
      offset: queryInt(c.req.query('offset'), { min: 0, fallback: undefined }),
    });
    return c.json(rows.map(withCurrentVitality));
  });

  // Create a memory for the caller (source='user', actor='user:<id>').
  app.post('/memory', async (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const b = await parseBody(c, memoryCreateSchema);
    const row = store.add(userId, { ...b, source: 'user' }, `user:${userId}`, 'created via API');
    // Same fire-and-forget the curator does. Without it a memory created from the web stayed
    // uncategorized, since classification used to hang off the post-turn curator alone.
    d.memoryCategorizer?.classifyNewMemory(userId, row.id, `user:${userId}`);
    return c.json(withCurrentVitality(row), 201);
  });

  // Read one of the caller's memories. Owner-scoped → a foreign id is 404.
  app.get('/memory/:id', (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const row = store.get(c.get('user').id, Number(c.req.param('id')));
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(withCurrentVitality(row));
  });

  // Partial update. The store scopes to the owner, so a patch aimed at a foreign id matches nothing and
  // returns undefined → 404 (the ownership boundary).
  app.patch('/memory/:id', async (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const b = await parseBody(c, memoryPatchSchema);
    const updated = store.update(userId, Number(c.req.param('id')), b, `user:${userId}`, 'edited via API');
    if (!updated) return c.json({ error: 'not found' }, 404);
    return c.json(withCurrentVitality(updated));
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
    const row = store.get(userId, id);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(withCurrentVitality(row));
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

  // That memory's vitality over time (owner-scoped). Reconstructed server-side because the half-life
  // table is a daemon-side config the web deliberately does not know — same division as `vitality`
  // itself, which the web only ever displays.
  app.get('/memory/:id/vitality-history', (c) => {
    if (!store) return c.json({ error: 'memory unavailable' }, 400);
    const userId = c.get('user').id;
    const id = Number(c.req.param('id'));
    const row = store.get(userId, id);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(buildVitalityHistory({
      memory: row,
      recalls: store.usageHistory(userId, id),
      retention: d.config.get().runtime.memoryRetention,
      now: Date.now(),
      pastDays: queryInt(c.req.query('days'), { min: 1, max: 365, fallback: 30 }),
    }));
  });
}
