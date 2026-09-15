import { openAiApiFor, type BrainProviderEntry } from '../providers.js';

/** The tools that stay DIRECTLY visible to the model under code mode, on top of `exec` and `wait`.
 *
 *  Only one, and it is a safety choice rather than a convenience: asking the user a question is how an
 *  agent stops and checks, and a script is the wrong place for it — the question would be buried inside a
 *  running cell whose result the model has not seen yet. Codex keeps the same tool visible for the same
 *  reason (its `ToolExposure::DirectModelOnly`). Provider-hosted tools such as web search are not composed
 *  ToolDefinitions at all, so they are never hidden by this and need no entry here. */
export const CODE_MODE_ALWAYS_VISIBLE_TOOLS: readonly string[] = ['AskUserQuestion'];

/** Does this provider entry speak Codex's own request dialect?
 *
 *  Only the ChatGPT account does. Codex's `use_responses_lite` shape — an empty `instructions`, with the
 *  prompt and the tool declarations as `developer` items inside `input` — is understood by the ChatGPT
 *  backend and by nothing else: measured against a third-party Responses endpoint (Alibaba DashScope,
 *  2026-09-15), a tool declared only in `additional_tools` made the model answer that it "isn't an available
 *  tool". Code mode on any other provider therefore declares its tools the ordinary way, at the top level.
 *
 *  Separate from `isCodeModeCapableProvider` on purpose: carrying an `exec` tool and speaking Codex's
 *  request dialect are two different capabilities, and only the ChatGPT account has both. */
export function usesCodexRequestShape(entry: Pick<BrainProviderEntry, 'type'>): boolean {
  return entry.type === 'oauth-openai-codex';
}

/** Could this provider entry EVER run code mode — ignoring the operator switch?
 *
 *  `exec` is declared through pi-ai's `constrainedSampling`, and only the Responses wires serialise that
 *  as an OpenAI custom tool: `openai-codex-responses`, `openai-responses` and `azure-openai-responses`
 *  each read `model.compat.supportsOpenAIGrammarTools`, while Chat Completions has no such concept and
 *  would silently drop the grammar. The ChatGPT account is matched by its OAuth entry type rather than by
 *  the wire, because `BrainProviderApi` covers only the two key-based OpenAI wires; that account's
 *  Responses endpoint is reached exclusively through the entry type.
 *
 *  Exported because the settings surface decides from the SAME answer whether to offer a switch, which is
 *  what keeps the browser from restating this arithmetic. */
export function isCodeModeCapableProvider(entry: Pick<BrainProviderEntry, 'type' | 'api' | 'baseUrl'>): boolean {
  if (entry.type === 'oauth-openai-codex') return true;
  return entry.type === 'openai' && openAiApiFor(entry) === 'openai-responses';
}

/** The visibility narrowing for a code-mode session, in the shape the per-turn pass already consumes.
 *
 *  Everything except the code-mode pair and the always-visible interaction tools is listed as withheld:
 *  registered, callable from a script, absent from the prompt. `activated` is empty and stays empty — a
 *  code-mode tool is reached from inside a script, never fetched into the prompt the way ToolSearch
 *  fetches a deferred one. */
export function codeModeVisibilityFor(
  allToolNames: readonly string[],
  codeModeToolNames: readonly string[],
): { deferred: Set<string>; activated: Set<string> } {
  const visible = new Set<string>([...codeModeToolNames, ...CODE_MODE_ALWAYS_VISIBLE_TOOLS]);
  return {
    deferred: new Set(allToolNames.filter((name) => !visible.has(name))),
    activated: new Set<string>(),
  };
}

/** Whether this turn composes its tools in CODE MODE: one `exec` tool taking raw JavaScript, with every
 *  other tool hidden from the model but still callable from inside a script.
 *
 *  Two gates, both required, and NEITHER of them is the model. The operator switch is opt-in and absent by
 *  default, so an installation that does nothing keeps its current tool surface byte for byte. The provider
 *  gate keeps it to the wires that can carry the tool at all.
 *
 *  There is deliberately no model gate. `exec` degrades on its own where a model cannot drive it: pi-ai
 *  serialises it as a grammar tool only for a model whose catalog entry claims `supportsOpenAIGrammarTools`
 *  and otherwise as an ordinary function tool taking the script as a string (`constrained-sampling.js`), and
 *  a model that ignores the tool simply answers directly. Which models are worth running this way is a
 *  measurement, not an invariant — a live probe of `qwen3.8-flash` on 2026-09-15 batched seven nested calls
 *  into one script — so the operator decides it per provider entry instead of the code guessing from an id. */
export function codeModeApplies(entry: BrainProviderEntry | undefined): boolean {
  if (entry === undefined) return false;
  if (entry.codeModeEnabled !== true) return false;
  return isCodeModeCapableProvider(entry);
}
