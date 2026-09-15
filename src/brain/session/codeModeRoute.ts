import type { BrainProviderEntry } from '../providers.js';

/** The tools that stay DIRECTLY visible to the model under code mode, on top of `exec` and `wait`.
 *
 *  Only one, and it is a safety choice rather than a convenience: asking the user a question is how an
 *  agent stops and checks, and a script is the wrong place for it — the question would be buried inside a
 *  running cell whose result the model has not seen yet. Codex keeps the same tool visible for the same
 *  reason (its `ToolExposure::DirectModelOnly`). Provider-hosted tools such as web search are not composed
 *  ToolDefinitions at all, so they are never hidden by this and need no entry here. */
export const CODE_MODE_ALWAYS_VISIBLE_TOOLS: readonly string[] = ['AskUserQuestion'];

/** The oldest model family trained on the single-`exec` tool surface. */
const MIN_CODE_MODE_MAJOR = 5;
const MIN_CODE_MODE_MINOR = 6;

/** Whether a model id names a GPT release at or after gpt-5.6.
 *
 *  Matched on the family prefix rather than a fixed list so a later release works without a code change,
 *  which is deliberate: the tool surface is a training-time property of the family, and every gpt-5.6 and
 *  gpt-6 variant in the Codex catalog carries it. Anything that is not a `gpt-<major>[.<minor>]` id — a
 *  Claude model, a local model, an unrecognised alias — reads as unsupported. */
export function isCodeModeCapableModel(modelId: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?/.exec(modelId);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  if (major > MIN_CODE_MODE_MAJOR) return true;
  return major === MIN_CODE_MODE_MAJOR && minor >= MIN_CODE_MODE_MINOR;
}

/** Whether this provider serves the ChatGPT Codex endpoint, the only one code mode is enabled for today.
 *  Identified by the OAuth entry type rather than by the wire api, because `BrainProviderApi` covers only
 *  the two key-based OpenAI wires; the Codex responses api is reached exclusively through this entry. */
function isCodexProvider(entry: BrainProviderEntry): boolean {
  return entry.type === 'oauth-openai-codex';
}

/** Whether this turn composes its tools in CODE MODE: one `exec` tool taking raw JavaScript, with every
 *  other tool hidden from the model but still callable from inside a script.
 *
 *  Three independent gates, all required. The operator switch is opt-in and absent by default, so an
 *  installation that does nothing keeps its current tool surface byte for byte. The provider gate keeps it
 *  to the endpoint whose models were trained on this surface. The model gate does the same within that
 *  endpoint, because an older model on the same account would see a tool it cannot drive. */
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

export function codeModeApplies(entry: BrainProviderEntry | undefined, modelId: string): boolean {
  if (entry === undefined) return false;
  if (entry.codeModeEnabled !== true) return false;
  if (!isCodexProvider(entry)) return false;
  return isCodeModeCapableModel(modelId);
}
