import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isAnthropicHostedToolSearchModelId, stripLocalToolActivations } from './hostedToolSearch.js';
export { isAnthropicHostedToolSearchModelId } from './hostedToolSearch.js';

export interface AnthropicHostedToolSearchModel {
  id: string;
  provider: string;
  api?: string;
}

interface AnthropicPayload {
  messages?: unknown;
  tools?: unknown;
  [key: string]: unknown;
}

interface AnthropicTool {
  type?: unknown;
  name?: unknown;
  input_schema?: unknown;
  cache_control?: unknown;
  defer_loading?: unknown;
  [key: string]: unknown;
}

export const ANTHROPIC_HOSTED_TOOL_SEARCH_TYPE = 'tool_search_tool_bm25_20251119';
const ANTHROPIC_HOSTED_TOOL_SEARCH_NAME = 'tool_search_tool_bm25';
const LOCAL_TOOL_SEARCH = 'ToolSearch';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Exact OAuth boundary. Custom API-key Anthropic providers use an `elowen-*` registry provider name and
 *  intentionally keep the established local path until they are tested independently. */
export function supportsAnthropicHostedToolSearch(
  model: AnthropicHostedToolSearchModel,
  providerType: string | undefined,
): boolean {
  return providerType === 'oauth-anthropic'
    && model.provider === 'anthropic'
    && model.api === 'anthropic-messages'
    && isAnthropicHostedToolSearchModelId(model.id);
}

/** Replace pi's already sender-visible Messages tool list with Anthropic server-side BM25 search.
 *
 *  Normal Anthropic function definitions have no `type` and carry `input_schema`; provider/server tools do
 *  carry a type. Defer every normal function, remove the obsolete local ToolSearch, preserve unrelated
 *  server tools immediate, and prepend the one non-deferred search tool Anthropic requires.
 *
 *  PI may put a cache breakpoint on the last immediate tool. Anthropic rejects `cache_control` together
 *  with `defer_loading`, so the marker MUST be stripped from every function moved to the deferred catalog.
 *  The API excludes those definitions from the system-prompt prefix itself, preserving prompt caching even
 *  though all definitions are still sent in the HTTP request. */
export function projectAnthropicHostedToolSearchPayload(
  payload: unknown,
  expectedModelId: string,
): AnthropicPayload | undefined {
  if (!isRecord(payload) || payload.model !== expectedModelId
    || !Array.isArray(payload.messages) || !Array.isArray(payload.tools)) return undefined;

  const deferred: AnthropicTool[] = [];
  const immediate: AnthropicTool[] = [];
  for (const raw of payload.tools) {
    if (!isRecord(raw)) continue;
    const tool = raw as AnthropicTool;
    if (tool.type === ANTHROPIC_HOSTED_TOOL_SEARCH_TYPE) continue; // idempotence / defensive dedupe
    const applicationFunction = typeof tool.name === 'string' && isRecord(tool.input_schema) && tool.type === undefined;
    if (!applicationFunction) {
      immediate.push(tool);
      continue;
    }
    if (tool.name === LOCAL_TOOL_SEARCH) continue;
    const { cache_control: _cacheControl, ...definition } = tool;
    deferred.push({ ...definition, defer_loading: true });
  }
  if (deferred.length === 0) return undefined;

  return {
    ...payload,
    tools: [
      { type: ANTHROPIC_HOSTED_TOOL_SEARCH_TYPE, name: ANTHROPIC_HOSTED_TOOL_SEARCH_NAME },
      ...immediate,
      ...deferred,
    ],
  };
}

export function installAnthropicHostedToolSearch(pi: ExtensionAPI, expectedModelId: string): void {
  pi.on('context', (event) => {
    const messages = stripLocalToolActivations(event.messages);
    return messages.some((message, index) => message !== event.messages[index]) ? { messages } : undefined;
  });
  pi.on('before_provider_request', (event) => projectAnthropicHostedToolSearchPayload(event.payload, expectedModelId));
}
