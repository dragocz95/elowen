import { z } from 'zod';
import { isCreatableDirectoryName } from '../../integrations/projectFiles.js';

/** Register a project. slug + path are required; notes is the optional Pilot brief. */
export const createProjectSchema = z.object({
  slug: z.string().min(1),
  path: z.string().min(1),
  notes: z.string().optional(),
});

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

/** Replace a project's shared-memory share list WHOLESALE (admin-only). An empty list means every
 *  project member shares the pool — the "nobody picked = everyone" default of the feature contract. */
export const memoryMembersSchema = z.object({
  userIds: z.array(z.number().int().positive('userId must be positive')).max(500, 'too many users'),
});
