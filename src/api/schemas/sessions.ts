import { z } from 'zod';

/** Manual worker launch: the task to (re)spawn and an optional executor override. */
export const launchSessionSchema = z.object({
  taskId: z.string().min(1),
  exec: z.string().optional(),
});

/** tmux `send-keys` tokens. A non-empty list of plain key tokens; reject any leading-'-' entry so a
 *  crafted token can't smuggle a tmux flag (e.g. `-t <other-session>`) and redirect keystrokes into a
 *  session the caller shouldn't reach. */
export const sessionKeysSchema = z.object({
  keys: z.array(z.string().min(1).refine((k) => !k.startsWith('-'), 'flag tokens are not allowed'))
    .min(1, 'keys must be a non-empty array of non-flag strings'),
});

/** Raw interactive input forwarded verbatim to the pane (`send-keys -l`). */
export const sessionInputSchema = z.object({
  data: z.string().min(1),
});

/** Terminal resize. */
export const sessionResizeSchema = z.object({
  cols: z.number(),
  rows: z.number(),
});
