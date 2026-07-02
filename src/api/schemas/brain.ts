import { z } from 'zod';

/** Start the caller's embedded brain, optionally choosing which configured provider drives it. */
export const brainStartSchema = z.object({
  provider: z.string().optional(),
  /** Resume this stored conversation (must belong to the caller). */
  session: z.string().optional(),
  /** Open a brand-new conversation instead of resuming. */
  fresh: z.boolean().optional(),
});

/** A single user message sent into the brain conversation. */
export const brainSendSchema = z.object({
  text: z.string().min(1),
});
