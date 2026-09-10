import { z } from 'zod';
import { isCreatableDirectoryName } from '../../integrations/projectFiles.js';
import { isReservedProjectSlug } from '../../shared/projectExecution.js';

/** Register a project. slug + path are required; notes is the optional Pilot brief.
 *  A managed project is mounted in its container under its own slug, so a slug that names a directory
 *  of the base image is refused here: the project would be created and every start would fail on the
 *  mount target, with no way to rename it. */
export const createProjectSchema = z.union([
  z.object({ slug: z.string().min(1), path: z.string().min(1), notes: z.string().optional(), executionKind: z.literal('host').optional() }),
  z.object({
    slug: z.string().trim().min(1).max(128).refine((slug) => !isReservedProjectSlug(slug), 'slug is reserved by the project environment'),
    notes: z.string().optional(),
    executionKind: z.literal('managed'),
  }).strict(),
]);

/** Edit a project. All fields optional; trimming and icon validation stay in the handler.
 *  `memoryShared` toggles the project's shared memory pool (admin-only, like the rest of the patch). */
export const updateProjectSchema = z.object({
  path: z.string().optional(),
  notes: z.string().optional(),
  icon: z.string().optional(),
  memoryShared: z.boolean().optional(),
});

/** Create exactly one child directory under an existing absolute server path. Names are one portable
 * filesystem segment; the integration keeps operating-system permission and atomicity decisions. */
export const createDirectorySchema = z.object({
  parent: z.string().min(1).refine((value) => value.startsWith('/'), 'parent must be an absolute path'),
  name: z.string().trim().refine(isCreatableDirectoryName, 'name must be a creatable directory segment'),
});

/** Adopt an existing host project as managed, or undo that adoption. A bodyless POST adopts: `undo` is
 *  the only thing this request can say, and it says it once. */
export const adoptProjectSchema = z.object({ undo: z.boolean().optional() });

/** Delete a managed project. Both fields are optional and are forwarded verbatim to the environment
 *  provider, which owns the durable deletion intent: `requestId` makes a retried DELETE return the same
 *  operation instead of colliding with the pending one, and `expectedGeneration` refuses the delete when
 *  the caller's view of the environment is stale. A host project ignores both. */
export const deleteProjectSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/, 'invalid idempotency key').optional(),
  expectedGeneration: z.number().int().nonnegative().optional(),
});

/** Replace a project's shared-memory share list WHOLESALE (admin-only). An empty list means every
 *  project member shares the pool — the "nobody picked = everyone" default of the feature contract. */
export const memoryMembersSchema = z.object({
  userIds: z.array(z.number().int().positive('userId must be positive')).max(500, 'too many users'),
});
