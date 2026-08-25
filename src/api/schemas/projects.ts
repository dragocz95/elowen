import { z } from 'zod';

/** Register a project. slug + path are required; notes is the optional Pilot brief. */
export const createProjectSchema = z.object({
  slug: z.string().min(1),
  path: z.string().min(1),
  notes: z.string().optional(),
});

/** Edit a project. All fields optional; trimming and icon validation stay in the handler. */
export const updateProjectSchema = z.object({
  path: z.string().optional(),
  notes: z.string().optional(),
  icon: z.string().optional(),
});
