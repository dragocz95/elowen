import { z } from 'zod';

/** Start the caller's advisor with a chosen executor (the allow-list check happens in advisor.start). */
export const advisorStartSchema = z.object({
  exec: z.string().min(1),
});
