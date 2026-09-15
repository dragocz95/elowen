/**
 * Send a codex Responses request the way OpenAI Codex sends it for its `use_responses_lite` models:
 * `instructions` empty, the system prompt and the tool list spliced into `input` as `developer` items.
 *
 * WHY, and why it is not cosmetic. gpt-5.6 was trained against that request shape: the base instructions
 * arrive as a developer TURN rather than as the out-of-band `instructions` field, and the tools arrive
 * beside them instead of as a top-level array. pi-ai builds the opposite shape and hardcodes
 * `parallel_tool_calls: true`, which Codex disables for exactly these models
 * (`codex-rs/core/src/client.rs:805-842` and `:887`). Measured on 2026-09-15, a code-mode turn issued one
 * `exec` per batch with one nested call per script — the round trips code mode exists to remove.
 *
 * WHERE it hooks in. pi-ai hands the whole request body to `onPayload` before it chooses a transport
 * (`openai-codex-responses.js:171-175`) and re-validates nothing afterwards, so one transform covers both
 * the WebSocket and the SSE path — unlike `options.fetch`, which only reaches SSE. `codexReasoningSummary`
 * in `factory.ts` uses the same seam for `reasoning.summary`.
 *
 * SCOPE. Gated on code mode, not on the provider: every other codex session keeps its current body and its
 * cached prefix. The transform is pure and total — anything it does not recognise is returned unchanged,
 * because a body it cannot read is a body it must not rewrite.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** The role Codex gives both spliced items. */
const DEVELOPER_ROLE = 'developer';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Rewrite one Responses body into Codex's lite shape, or return `undefined` to leave it alone.
 *
 * `undefined` is pi's "unchanged" answer, and it is returned for a body that is already in the target
 * shape as well as for one that does not look like a Responses request at all. That makes the transform
 * idempotent: a second pass over its own output is a no-op rather than a second splice.
 */
export function codexDeveloperPayload(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const instructions = payload.instructions;
  const input = payload.input;
  // An empty `instructions` means the splice already happened (or there is no prompt to move).
  if (typeof instructions !== 'string' || instructions.length === 0) return undefined;
  if (!Array.isArray(input)) return undefined;

  const prefix: Record<string, unknown>[] = [];
  // Tools first, then the prompt — Codex's order, and the order the model saw in training.
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    prefix.push({ type: 'additional_tools', role: DEVELOPER_ROLE, tools: payload.tools });
  }
  prefix.push({
    type: 'message',
    role: DEVELOPER_ROLE,
    content: [{ type: 'input_text', text: instructions }],
  });

  const next: Record<string, unknown> = {
    ...payload,
    instructions: '',
    input: [...prefix, ...input],
    // Codex: `prompt.parallel_tool_calls && !model_info.use_responses_lite`, i.e. always false here. A
    // model that cannot fan out in the request is the one that composes its calls inside a script.
    parallel_tool_calls: false,
  };
  // The tools now live in `input`; leaving the top-level copy would declare each of them twice.
  delete next.tools;
  return next;
}

/** Register the transform for one session. */
export function codexDeveloperPlacement(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event) => codexDeveloperPayload(event.payload));
}
