import { z } from 'zod';

/** Start the caller's embedded brain, optionally choosing which configured provider drives it. */
export const brainStartSchema = z.object({
  provider: z.string().optional(),
  /** Resume this stored conversation (must belong to the caller). */
  session: z.string().optional(),
  /** Open a brand-new conversation instead of resuming. */
  fresh: z.boolean().optional(),
});

/** Switch the active conversation to another configured provider/model (the /model picker). */
export const brainModelSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
});

/** One attached image: base64 payload + its mime type. ~7 MB of base64 ≈ 5 MB binary — enough for
 *  screenshots and photos while keeping a request bounded. */
const imageSchema = z.object({
  data: z.string().min(1).max(7_000_000),
  mimeType: z.string().regex(/^image\//),
});

/** A single user message sent into the brain conversation, optionally with image attachments. */
export const brainSendSchema = z.object({
  text: z.string().min(1),
  images: z.array(imageSchema).max(4).optional(),
});

/** The user's answer to a parked ask_user_question (POST /brain/answer). `id` is the question id carried
 *  on the `ask` event; `answers` holds one entry per question with the picked label(s) + optional free
 *  text. Bounds mirror the tool schema (≤4 questions, each with a handful of picks). */
export const brainAnswerSchema = z.object({
  id: z.string().min(1),
  answers: z.array(z.object({
    header: z.string().max(500),
    selected: z.array(z.string().max(500)).max(16),
    other: z.string().max(2000).optional(),
  })).min(1).max(4),
});
