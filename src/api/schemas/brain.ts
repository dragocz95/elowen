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
  /** Explicit owner surface for stable attachment behavior. Missing keeps legacy CLI semantics. */
  surface: z.enum(['web', 'cli']).optional(),
});

/** Mark an owned conversation activity sequence as read. CLI acknowledgements advance an existing web
 * baseline but never establish participation, so a CLI-only conversation can never become web-unread. */
export const brainActivityReadSchema = z.object({
  through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  surface: z.enum(['web', 'cli']),
});

/** A client reporting whether its window is on screen, so a finished turn can tell "nobody is reading
 *  this" from "a tab is still connected behind a locked screen". The client id ties it to that tab's
 *  live stream — the same id it opens the stream with. */
export const brainVisibilitySchema = z.object({
  client: z.string().min(1).max(200),
  hidden: z.boolean(),
});

/** Finalize one stable CLI generation. `generation` is the highest start the process has issued, so the
 *  daemon can fence a request that is still buffered behind this stop on another connection. */
export const brainStopSchema = z.object({
  session: z.string().max(200).optional(),
  client: z.string().min(1).max(200).optional(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  /** POST /brain/session/stop only: release this client's binding, but tear the live session down ONLY
   *  when it is idle. The web beacon sets it so a closing tab can never kill a running agent; the CLI
   *  omits it and keeps the original "closing the terminal ends my run" semantics. */
  detachOnly: z.boolean().optional(),
});

/** Rename one of the caller's conversations (PATCH /brain/sessions/:id). A non-string/absent title is a
 *  400 (as it was under the hand-rolled guard); a name collision is a 409 raised by renameSession. */
export const brainRenameSchema = z.object({
  title: z.string(),
});

/** Switch a conversation to another configured provider/model (the /model picker). `session` targets
 *  the caller's own explicit conversation (a bound CLI); absent → the active one. */
export const brainModelSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  session: z.string().max(200).optional(),
});

/** One attached image: base64 payload + its mime type. ~7 MB of base64 ≈ 5 MB binary — enough for
 *  screenshots and photos while keeping a request bounded. mimeType is restricted to what the vision
 *  providers actually decode (Anthropic: png/jpeg/gif/webp) — mirrors cli/chat/mentions.ts'
 *  IMAGE_MIME_BY_EXT. Anything else (heic, bmp, svg, avif…) must be rejected here, not forwarded to the
 *  provider: a mismatched/unsupported type there comes back as an opaque "Could not process image" 400. */
const imageSchema = z.object({
  data: z.string().min(1).max(7_000_000),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
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
  /** WHICH client this is, for the team activity feed. Web and CLI are otherwise indistinguishable —
   *  both POST this exact shape — so the caller states it. It is NOT inferred from User-Agent or IP:
   *  the client writes both, and the web BFF strips headers anyway. Absent → 'unknown', which the feed
   *  shows honestly rather than guessing a plausible surface. */
  surface: z.enum(['web', 'cli']).optional(),
});

/** A session-scoped live toggle (POST /brain/fast, /brain/yolo): `on` absent → toggle the current state,
 *  `session` targets the caller's bound conversation (absent → the active one). */
export const brainToggleSchema = z.object({
  on: z.boolean().optional(),
  session: z.string().max(200).optional(),
});

/** Set the caller's reasoning effort live (POST /brain/think). A non-string/absent `level` is a 400. */
export const brainThinkSchema = z.object({
  level: z.string(),
  session: z.string().max(200).optional(),
});

/** Annotate a client working-directory move (POST /brain/cwd). A non-string/absent `dir` is a 400. */
export const brainCwdSchema = z.object({
  dir: z.string(),
  session: z.string().max(200).optional(),
});

/** Manual context compaction (POST /brain/compact). `instruction` is an optional focus hint (trimmed +
 *  capped by the route); `session` targets the caller's bound conversation. */
export const brainCompactSchema = z.object({
  session: z.string().max(200).optional(),
  instruction: z.string().optional(),
});

/** Bind (MOVE) one of the caller's conversations into a platform channel slot (POST /brain/context,
 *  admin-only). Both are required strings (a missing one was a 400 under the hand-rolled guard). */
export const brainContextSchema = z.object({
  channel: z.string(),
  session: z.string(),
});

/** Open (or re-attach to) the caller's `elowen chat` terminal bound to their conversation
 *  (POST /brain/terminal, admin-only). A non-string/absent `session` is a 400. */
/** Set a persistent goal on the caller's conversation (POST /brain/goal). A non-string/absent `text` is a
 *  400; `turnBudget` is clamped to [1, 50] by the route; `draft` opens the goal in draft (contract) mode. */
export const brainGoalSchema = z.object({
  text: z.string(),
  draft: z.boolean().optional(),
  turnBudget: z.number().optional(),
  session: z.string().max(200).optional(),
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
