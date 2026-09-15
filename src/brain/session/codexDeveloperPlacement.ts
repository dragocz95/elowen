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

/** Codex's namespace for top-level function and custom tools (`DEFAULT_FUNCTION_NAMESPACE`,
 *  `codex-rs/protocol/src/tool_name.rs:7`). Its description is deliberately EMPTY — the default namespace
 *  is the one the model already knows (`default_namespace_description`, `tools/src/responses_api.rs:64-70`)
 *  — and a call inside it comes back under its BARE name, because `ToolName`'s Display writes no prefix
 *  for the default namespace (`tool_name.rs:54-61`). So the wrapper changes the declaration the backend
 *  reads, not the names we dispatch on. */
const DEFAULT_FUNCTION_NAMESPACE = 'functions';

/** Codex carries reasoning state across the whole thread for its lite models
 *  (`client.rs:785-791`: `use_responses_lite.then_some(ReasoningContext::AllTurns)`); the Responses default
 *  it otherwise falls back to is `current_turn`. pi-ai sends no `context` at all. */
const REASONING_CONTEXT_ALL_TURNS = 'all_turns';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The tools as Codex declares them in the lite shape: ONE `namespace` entry holding every function and
 * freeform tool (`create_tools_json_for_responses_lite`, `codex-rs/tools/src/tool_spec.rs:95-141`, chosen
 * whenever the provider advertises `namespace_tools`, which is the default and what the ChatGPT backend
 * gets — `client.rs:812-816`, `model-provider/src/provider.rs:70`). We were sending the flat array from
 * the other branch: legal, but not the shape this backend is handed.
 *
 * `strict` is normalised on the way in: Codex's field is a plain `bool` (`responses_api.rs:37`) while
 * pi-ai emits an explicit `null`, a value outside Codex's range.
 */
function namespacedTools(tools: readonly unknown[]): Record<string, unknown>[] {
  const inNamespace = tools.map((tool) => {
    if (!isRecord(tool) || tool.strict !== null) return tool;
    return { ...tool, strict: false };
  });
  return [{
    type: 'namespace',
    name: DEFAULT_FUNCTION_NAMESPACE,
    description: '',
    tools: inNamespace,
  }];
}

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
    prefix.push({ type: 'additional_tools', role: DEVELOPER_ROLE, tools: namespacedTools(payload.tools) });
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
    // Reasoning is left exactly as pi-ai and `codexReasoningSummary` built it, apart from the thread-wide
    // context Codex sets for these models. A body without a `reasoning` object gets none invented for it.
    ...(isRecord(payload.reasoning) ? { reasoning: { ...payload.reasoning, context: REASONING_CONTEXT_ALL_TURNS } } : {}),
  };
  // The tools now live in `input`; leaving the top-level copy would declare each of them twice.
  delete next.tools;
  return next;
}

/** Register the transform for one session. */
export function codexDeveloperPlacement(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event) => codexDeveloperPayload(event.payload));
}
