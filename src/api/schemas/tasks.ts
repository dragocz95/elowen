import { z } from 'zod';

/** Create a task. title is required; everything else is optional and defaulted by the store. */
export const createTaskSchema = z.object({
  title: z.string(),
  type: z.string().optional(),
  priority: z.string().optional(),
  id: z.string().optional(),
  description: z.string().optional(),
  scheduled_at: z.string().nullable().optional(),
  autostart: z.number().optional(),
  deps: z.array(z.string()).optional(),
  project_id: z.number().optional(),
});

/** Patch a task. Every field is optional — the handler applies each only when present (status flip,
 *  exec gate, field update, dep rewire). The close-path side effects stay in the handler/ReviewService. */
export const patchTaskSchema = z.object({
  status: z.enum(['open', 'in_progress', 'blocked', 'closed', 'cancelled']).optional(),
  result_summary: z.string().optional(),
  outcome: z.string().optional(),
  exec: z.string().optional(),
  title: z.string().optional(),
  type: z.string().optional(),
  priority: z.string().optional(),
  description: z.string().optional(),
  scheduled_at: z.string().nullable().optional(),
  autostart: z.number().optional(),
  deps: z.array(z.string()).optional(),
});

/** A worker's free-text question to the autopilot (`orca ask`), or a human's reply to one. text is
 *  required-non-empty so an empty turn can't be recorded or block on nothing, and capped so a
 *  prompt-injected agent can't store a huge blob per turn (the route also caps the turn count). */
export const askSchema = z.object({ text: z.string().min(1).max(4000) });

/** A planner phase as it arrives over the wire (manual mode / playground). The handler trims and
 *  validates the type against VALID_TYPES, so the shape here is permissive. */
const phaseInputSchema = z.object({
  title: z.string().optional(),
  type: z.string().optional(),
  details: z.string().optional(),
});

/** Plan a mission: a manual phase list or an autopilot goal. goal is required-non-empty in the handler
 *  (it trims first), so it's optional here; prEnabled is the tri-state PR override (true/false/null). */
export const planSchema = z.object({
  goal: z.string().optional(),
  name: z.string().optional(),
  exec: z.string().optional(),
  autoModel: z.boolean().optional(),
  autonomy: z.string().optional(),
  maxSessions: z.number().optional(),
  engage: z.boolean().optional(),
  phases: z.array(phaseInputSchema).optional(),
  dryRun: z.boolean().optional(),
  prompt: z.string().optional(),
  project_id: z.number().optional(),
  prEnabled: z.boolean().nullable().optional(),
});

/** Insert phases into an existing epic: a manual phase list or a residual `goal` to replan. The handler
 *  enforces phases-or-goal. */
export const insertPhasesSchema = z.object({
  phases: z.array(phaseInputSchema).optional(),
  goal: z.string().optional(),
  prompt: z.string().optional(),
  exec: z.string().optional(),
});
