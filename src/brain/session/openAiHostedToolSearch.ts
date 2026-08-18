import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { stripLocalToolActivations } from './hostedToolSearch.js';

/** The narrow model shape that decides whether the ChatGPT account backend gets server-side tool search. */
export interface OpenAIHostedToolSearchModel {
  id: string;
  provider: string;
  api?: string;
}

interface ProviderPayload {
  model?: unknown;
  input?: unknown;
  tools?: unknown;
  [key: string]: unknown;
}

interface ProviderTool {
  type?: unknown;
  name?: unknown;
  defer_loading?: unknown;
  [key: string]: unknown;
}

const GPT_FAMILY = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/;
const LOCAL_TOOL_SEARCH = 'ToolSearch';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** OpenAI documents hosted tool search for GPT-5.4 onward. Keep the family parser independent of catalog
 *  compat flags: pi 0.84.2 does not advertise or implement the hosted mode, while the ChatGPT OAuth backend
 *  itself does (verified against `/backend-api/codex/responses`). */
export function isGpt54OrLater(modelId: string): boolean {
  const match = GPT_FAMILY.exec(modelId);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 4);
}

/** Exact product boundary: the private ChatGPT-account Responses adapter, never OpenAI API-key/Azure
 *  Responses or a compatible relay that happens to use the same model id. */
export function supportsOpenAIHostedToolSearch(
  model: OpenAIHostedToolSearchModel,
  providerType: string | undefined,
): boolean {
  return providerType === 'oauth-openai-codex'
    && model.provider === 'openai-codex'
    && model.api === 'openai-codex-responses'
    && isGpt54OrLater(model.id);
}

/** Project pi-ai's already-built, PER-TURN SENDER-VISIBLE tool list onto OpenAI hosted search.
 *
 *  The payload is the single source of truth: `applyToolVisibility` has already narrowed the Agent's active
 *  tools for the acting sender (shared-role allow-list + user disabled tools) before pi-ai builds it.
 *  Reconstructing from `getAllTools()` here would leak names/schemas a shared-channel sender cannot use.
 *  Granular permission rules and plan-mode denials deliberately remain execute-time gates — the same cache-
 *  stable contract as the immediate path — so "visible" must not be overstated as "allowed to execute".
 *  Every function stays registered and active inside PI
 *  (so its returned function_call can execute), but only its deferred definition reaches the provider.
 *
 *  OpenAI's hosted search currently accepts function/namespace/MCP definitions. PI may emit a `custom`
 *  grammar tool for a future tool definition; leave such non-function entries immediate instead of
 *  guessing that the server can defer them. The built-in hosted search tool is the only thing appended.
 *  No function tools means no search tool — compaction and text-only requests remain byte-identical. */
export function projectOpenAIHostedToolSearchPayload(
  payload: unknown,
  expectedModelId: string,
): ProviderPayload | undefined {
  if (!isRecord(payload) || payload.model !== expectedModelId
    || !Array.isArray(payload.input) || !Array.isArray(payload.tools)) return undefined;

  const projected: ProviderTool[] = [];
  let deferredFunctions = 0;
  for (const raw of payload.tools) {
    if (!isRecord(raw)) continue;
    const tool = raw as ProviderTool;
    if (tool.type === 'tool_search') continue; // idempotence / defensive dedupe
    if (tool.type === 'function' && tool.name === LOCAL_TOOL_SEARCH) continue;
    if (tool.type === 'function') {
      projected.push({ ...tool, defer_loading: true });
      deferredFunctions++;
    } else {
      projected.push(tool);
    }
  }
  if (deferredFunctions === 0) return undefined;
  projected.push({ type: 'tool_search' });
  return { ...payload, tools: projected };
}

/** One provider-owned extension: scrub legacy local activations before pi-ai splits tools, then replace its
 *  final Responses payload after it has applied sender visibility and model-specific schema conversion. */
export function installOpenAIHostedToolSearch(pi: ExtensionAPI, expectedModelId: string): void {
  pi.on('context', (event) => {
    const messages = stripLocalToolActivations(event.messages);
    return messages.some((message, index) => message !== event.messages[index]) ? { messages } : undefined;
  });
  pi.on('before_provider_request', (event) => projectOpenAIHostedToolSearchPayload(event.payload, expectedModelId));
}
