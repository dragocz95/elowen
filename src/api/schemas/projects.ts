import { z } from 'zod';

/** Register a project. slug + path are required; notes is the optional Pilot brief. */
export const createProjectSchema = z.object({
  slug: z.string().min(1),
  path: z.string().min(1),
  notes: z.string().optional(),
});

/** Edit a project. All fields optional; the trim / icon-is-image / pr_enabled tri-state rules stay in
 *  the handler. pr_enabled: null = inherit the global default, a boolean = force on/off. */
export const updateProjectSchema = z.object({
  path: z.string().optional(),
  notes: z.string().optional(),
  icon: z.string().optional(),
  pr_enabled: z.boolean().nullable().optional(),
});
