import { z } from 'zod';

/** Engage a mission on an epic. epicId is required (an absent one would spawn a zombie `m-undefined`);
 *  the engage params are defaulted in the handler so a partial body never reaches the engine undefined. */
export const engageMissionSchema = z.object({
  epicId: z.string().min(1),
  autonomy: z.string().optional(),
  maxSessions: z.number().optional(),
});

/** Mission control action. Optional so an unknown/absent action is a no-op (returns the mission
 *  unchanged), matching the prior switch; an empty body still fails the object shape → 400. */
export const missionActionSchema = z.object({
  action: z.string().optional(),
});

/** The overseer's structured verdict for a pending decision. id is required; confidence is clamped to
 *  [0,1] in the handler, and a missing choice lets the deriver escalate to a human. */
export const overseerDecideSchema = z.object({
  id: z.string().min(1),
  approve: z.boolean().optional(),
  confidence: z.number().optional(),
  rationale: z.string().optional(),
  choice: z.string().optional(),
  /** For a 'message' decision: the overseer's free-text reply to the agent's question. Absent (with
   *  no choice/approve) ⇒ the overseer escalated → the ask falls to the human window. */
  message: z.string().optional(),
  /** For a 'check' decision: kill + relaunch the idle worker (the overseer judged it stuck). */
  restart: z.boolean().optional(),
});
