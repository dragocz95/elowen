import { createHash } from 'node:crypto';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { BrainProviderEntry } from '../providers.js';
import {
  HOSTED_TOOL_SEARCH_PROTOCOL,
  type HostedToolSearchCapabilities,
} from '../../shared/wireContract.js';
export { HOSTED_TOOL_SEARCH_PROTOCOL } from '../../shared/wireContract.js';
export type { HostedToolSearchCapabilities, HostedToolSearchCapability } from '../../shared/wireContract.js';

export type HostedToolSearchProvider = 'openai' | 'anthropic';
export type HostedToolSearchSource = 'oauth' | 'official' | 'azure-probe';
export interface HostedToolSearchRoute {
  provider: HostedToolSearchProvider;
  source: HostedToolSearchSource;
  modelId: string;
}

export interface HostedToolSearchRuntime {
  toolDeferralEnabled: boolean;
  hostedToolSearch: HostedToolSearchCapabilities;
}

const GPT_FAMILY = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/;

export function isGpt54OrLater(modelId: string): boolean {
  const match = GPT_FAMILY.exec(modelId);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 4);
}

export function isAnthropicHostedToolSearchModelId(modelId: string): boolean {
  if (/^claude-(?:fable|mythos)-5(?:-|$)/.test(modelId)) return true;
  const match = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-|$)/.exec(modelId);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 5);
}

interface EndpointIdentity {
  host: string;
  path: string;
}

const normalizedEndpoint = (entry: Pick<BrainProviderEntry, 'type' | 'baseUrl'>): EndpointIdentity | undefined => {
  const raw = entry.baseUrl.trim() || (entry.type === 'anthropic'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1');
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return { host: url.hostname.toLowerCase(), path };
  } catch {
    return undefined;
  }
};

const isOfficialOpenAI = (endpoint: EndpointIdentity | undefined): boolean =>
  endpoint?.host === 'api.openai.com' && (endpoint.path === '/' || endpoint.path === '/v1');

const isOfficialAnthropic = (endpoint: EndpointIdentity | undefined): boolean =>
  endpoint?.host === 'api.anthropic.com' && endpoint.path === '/';

function isAzureOpenAIResponsesEndpoint(endpoint: EndpointIdentity | undefined): boolean {
  return !!endpoint
    && endpoint.host !== 'openai.azure.com'
    && endpoint.host.endsWith('.openai.azure.com')
    && endpoint.path === '/openai/v1';
}

export function isAzureOpenAIResponsesProvider(
  entry: Pick<BrainProviderEntry, 'type' | 'api' | 'baseUrl'>,
): boolean {
  return entry.type === 'openai'
    && entry.api === 'openai-responses'
    && isAzureOpenAIResponsesEndpoint(normalizedEndpoint(entry));
}

export function hostedToolSearchFingerprint(
  entry: Pick<BrainProviderEntry, 'id' | 'type' | 'api' | 'baseUrl'>,
  modelId: string,
): string {
  const endpoint = normalizedEndpoint(entry);
  const material = JSON.stringify({
    protocol: HOSTED_TOOL_SEARCH_PROTOCOL,
    providerId: entry.id,
    type: entry.type,
    api: entry.api ?? '',
    endpoint: endpoint ? `${endpoint.host}${endpoint.path}` : 'invalid',
    modelId,
  });
  return createHash('sha256').update(material).digest('hex');
}

/** One source of truth for chat sessions and embedded workers. Missing/invalid/unsupported routes stay on
 *  each caller's established non-hosted path; this function never guesses from a compatible URL. */
export function resolveHostedToolSearchRoute(
  entry: BrainProviderEntry,
  model: Model<Api>,
  runtime: HostedToolSearchRuntime,
): HostedToolSearchRoute | undefined {
  if (!runtime.toolDeferralEnabled) return undefined;

  if (entry.type === 'oauth-openai-codex') {
    return model.provider === 'openai-codex'
      && model.api === 'openai-codex-responses'
      && isGpt54OrLater(model.id)
      ? { provider: 'openai', source: 'oauth', modelId: model.id }
      : undefined;
  }
  if (entry.type === 'oauth-anthropic') {
    return model.provider === 'anthropic'
      && model.api === 'anthropic-messages'
      && isAnthropicHostedToolSearchModelId(model.id)
      ? { provider: 'anthropic', source: 'oauth', modelId: model.id }
      : undefined;
  }

  const endpoint = normalizedEndpoint(entry);
  if (entry.type === 'openai' && entry.api === 'openai-responses' && model.api === 'openai-responses') {
    if (isOfficialOpenAI(endpoint) && isGpt54OrLater(model.id)) {
      return { provider: 'openai', source: 'official', modelId: model.id };
    }
    if (isAzureOpenAIResponsesProvider(entry)) {
      const capability = runtime.hostedToolSearch[entry.id]?.[model.id];
      const fingerprint = hostedToolSearchFingerprint(entry, model.id);
      if (capability?.status === 'supported'
        && capability.protocol === HOSTED_TOOL_SEARCH_PROTOCOL
        && capability.fingerprint === fingerprint) {
        return { provider: 'openai', source: 'azure-probe', modelId: model.id };
      }
    }
    return undefined;
  }

  if (entry.type === 'anthropic' && model.api === 'anthropic-messages'
    && isOfficialAnthropic(endpoint) && isAnthropicHostedToolSearchModelId(model.id)) {
    return { provider: 'anthropic', source: 'official', modelId: model.id };
  }
  return undefined;
}

/** Remove local deferred-activation metadata from one provider request view.
 *
 *  Hosted-search providers receive the full sender-visible catalog on every request, so pi's
 *  `addedToolNames` replay (`additional_tools`, client tool-search or Anthropic tool_reference) would be a
 *  second, conflicting loader. PI's context hook clones the request view: persisted history remains intact
 *  for a later switch back to a model/provider that still uses Elowen's local ToolSearch. */
export function stripLocalToolActivations<T>(messages: readonly T[]): T[] {
  let changed = false;
  const next = messages.map((message) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return message;
    const record = message as Record<string, unknown>;
    if (record.role !== 'toolResult' || !('addedToolNames' in record)) return message;
    const { addedToolNames: _addedToolNames, ...rest } = record;
    changed = true;
    return rest as T;
  });
  return changed ? next : [...messages];
}
