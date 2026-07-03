import { z } from 'zod';

/** Create a memory. Only `body` is required; kind/importance/confidence default in the store. Generous
 *  body ceiling guards the DB row without constraining real facts. importance is a 1..5 rank, confidence
 *  a 0..1 probability. */
export const memoryCreateSchema = z.object({
  body: z.string().trim().min(1, 'body cannot be empty').max(100_000, 'body too long'),
  kind: z.string().trim().min(1, 'kind required').max(40, 'kind too long').optional(),
  importance: z.number().int().min(1, 'importance 1..5').max(5, 'importance 1..5').optional(),
  confidence: z.number().min(0, 'confidence 0..1').max(1, 'confidence 0..1').optional(),
});

/** Partial update — every field optional, only the provided ones are written (mirrors the store patch).
 *  A body change is re-embedded lazily by the background queue (needsEmbedding reports it stale). */
export const memoryPatchSchema = z.object({
  body: z.string().trim().min(1, 'body cannot be empty').max(100_000, 'body too long').optional(),
  kind: z.string().trim().min(1, 'kind required').max(40, 'kind too long').optional(),
  importance: z.number().int().min(1, 'importance 1..5').max(5, 'importance 1..5').optional(),
  confidence: z.number().min(0, 'confidence 0..1').max(1, 'confidence 0..1').optional(),
  status: z.enum(['active', 'archived', 'deleted']).optional(),
});

/** Merge several source memories into one new memory carrying `body`; the sources are soft-deleted. */
export const memoryMergeSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1, 'at least one source id'),
  body: z.string().trim().min(1, 'merged body cannot be empty').max(100_000, 'body too long'),
});

/** Retrieval-debugging probe: the query text to rank the caller's memories against. */
export const memoryRetrieveSchema = z.object({
  query: z.string().trim().min(1, 'query cannot be empty').max(4000, 'query too long'),
});

/** Admin update of the workspace embedding block. All fields optional — the config store merges each
 *  provided field over the current block (mirrors PUT /config partial semantics). */
export const embeddingUpdateSchema = z.object({
  providerId: z.string().max(200, 'providerId too long').optional(),
  model: z.string().max(200, 'model too long').optional(),
  baseUrl: z.string().max(1000, 'baseUrl too long').optional(),
  dimensions: z.number().int().positive('dimensions must be positive').nullable().optional(),
});

/** Create a memory category. `name` is the per-user label (UNIQUE(user_id,name) → the route maps a
 *  collision to 409); `description` is the LLM-facing guide the classifier binds against; `color` is an
 *  optional UI hint. `is_builtin` is never client-settable — the store defaults it. */
export const memoryCategoryCreateSchema = z.object({
  name: z.string().trim().min(1, 'name cannot be empty').max(60, 'name too long'),
  description: z.string().trim().max(1000, 'description too long').optional(),
  color: z.string().trim().max(20, 'color too long').optional(),
});

/** Partial update of a category — every field optional, only the provided ones are written. A name
 *  collision again surfaces as 409 (mirrors create). */
export const memoryCategoryPatchSchema = z.object({
  name: z.string().trim().min(1, 'name cannot be empty').max(60, 'name too long').optional(),
  description: z.string().trim().max(1000, 'description too long').optional(),
  color: z.string().trim().max(20, 'color too long').optional(),
});

/** Assign (or clear with null) a memory's category. A non-null id must be one of the caller's own
 *  categories — the store rejects a foreign id (→ 404 at the route). */
export const memoryCategorySetSchema = z.object({
  categoryId: z.number().int().positive('categoryId must be positive').nullable(),
});

/** Admin update of the workspace categorization model block (mirrors the embedding block minus
 *  dimensions — the categorizer reuses the referenced brain provider's key at call time). */
export const categorizationUpdateSchema = z.object({
  providerId: z.string().max(200, 'providerId too long').optional(),
  model: z.string().max(200, 'model too long').optional(),
  baseUrl: z.string().max(1000, 'baseUrl too long').optional(),
});

/** Manual reclassify pass. `limit` bounds the round-trips (hard-capped at 200 in the categorizer);
 *  `includeCategorized` re-tags every active memory instead of only the uncategorized ones. */
export const memoryReclassifySchema = z.object({
  limit: z.number().int().positive('limit must be positive').max(200, 'limit too large').optional(),
  includeCategorized: z.boolean().optional(),
});
