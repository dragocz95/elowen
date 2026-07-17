import { z } from 'zod';

/** Start the caller's embedded brain, optionally choosing which configured provider drives it. `cwd`
 *  mirrors brainSendSchema: the CLI's launch directory, validated server-side and used as the session's
 *  working directory (the model is told about it, so it must be the user's project). */
export const brainStartSchema = z.object({
  provider: z.string().optional(),
  /** Resume this stored conversation (must belong to the caller). */
  session: z.string().optional(),
  /** Open a brand-new conversation instead of resuming. */
  fresh: z.boolean().optional(),
  cwd: z.string().max(4096).optional(),
  /** Stable CLI identity, scoped to the authenticated user by the route/service. */
  client: z.string().min(1).max(200).optional(),
  /** Monotonic per-process start generation; rejects network-reordered older selections server-side. */
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

/** Finalize one stable CLI generation. `generation` is the highest start the process has issued, so the
 *  daemon can fence a request that is still buffered behind this stop on another connection. */
export const brainStopSchema = z.object({
  session: z.string().max(200).optional(),
  client: z.string().min(1).max(200).optional(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

/** Switch a conversation to another configured provider/model (the /model picker). `session` targets
 *  the caller's own explicit conversation (a bound CLI); absent → the active one. */
export const brainModelSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  session: z.string().max(200).optional(),
});

/** One attached image: base64 payload + its mime type. ~7 MB of base64 ≈ 5 MB binary — enough for
 *  screenshots and photos while keeping a request bounded. */
const imageSchema = z.object({
  data: z.string().min(1).max(7_000_000),
  mimeType: z.string().regex(/^image\//),
});

/** A single user message sent into the brain conversation, optionally with image attachments. `cwd` is
 *  the client's working directory (the CLI reports where the user launched it) — the daemon binds the
 *  turn's tools there when it is a real directory within the caller's repo access. `session` binds the
 *  message to the caller's own explicit conversation (a session-bound CLI; ownership-checked, channel
 *  sessions rejected server-side); absent → the active conversation (web dock). */
export const brainSendSchema = z.object({
  text: z.string().min(1),
  mode: z.enum(['build', 'plan', 'workflow']).optional(),
  images: z.array(imageSchema).max(4).optional(),
  cwd: z.string().max(4096).optional(),
  session: z.string().max(200).optional(),
  /** A bound CLI carries the generation that committed `session`. Both remain optional so web/API sends
   *  keep their existing resume-on-demand behavior; together they fence delayed sends after CLI stop. */
  client: z.string().min(1).max(200).optional(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  /** The client's CLEAN rendering of the message (before @mention/prompt expansion) — what the daemon's
   *  authoritative `user` echo and the queued chip show. Absent → the model-facing `text` is echoed. */
  display: z.string().optional(),
});

/** Install one registry language server by its binary name (POST /brain/lsp/install, admin-only). */
export const lspInstallSchema = z.object({
  command: z.string().min(1).max(100),
});

/** The owner talking into a delegated sub-agent's session (POST /brain/subagent/send): steered into the
 *  child's running turn, or run as a fresh turn when it is idle. Ownership + the `brain-ch-subagent-`
 *  kind are enforced in BrainService.sendToSubagent. */
export const subagentSendSchema = z.object({
  session: z.string().min(1).max(200),
  text: z.string().min(1).max(32_000),
});

/** The user's answer to a parked AskUserQuestion (POST /brain/answer). `id` is the question id carried
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
