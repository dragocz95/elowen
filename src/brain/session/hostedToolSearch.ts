import { createHash } from 'node:crypto';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { BrainProviderEntry } from '../providers.js';
import { HOSTED_TOOL_SEARCH_PROTOCOL } from '../../shared/hostedToolSearchProtocol.js';
import { trimAllTrailingSlashes } from '../../shared/url.js';
import type { HostedToolSearchCapabilities } from '../../shared/wireContract.js';
export { HOSTED_TOOL_SEARCH_PROTOCOL } from '../../shared/hostedToolSearchProtocol.js';
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
    const path = trimAllTrailingSlashes(url.pathname) || '/';
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

/** Could this provider entry EVER carry a hosted route — ignoring the operator switch, the per-model gate
 *  and (for Azure) the stored probe? It answers "does the native tool search apply to this provider at
 *  all", which is what decides whether the settings surface offers a switch for it and what the status
 *  endpoint reports on. Kept beside the route resolver so the two cannot drift: every branch below has a
 *  counterpart in `resolveHostedToolSearchRoute`. */
export function isHostedToolSearchCapableProvider(
  entry: Pick<BrainProviderEntry, 'type' | 'api' | 'baseUrl'>,
): boolean {
  if (entry.type === 'oauth-openai-codex' || entry.type === 'oauth-anthropic') return true;
  const endpoint = normalizedEndpoint(entry);
  if (entry.type === 'openai' && entry.api === 'openai-responses') {
    return isOfficialOpenAI(endpoint) || isAzureOpenAIResponsesProvider(entry);
  }
  return entry.type === 'anthropic' && isOfficialAnthropic(endpoint);
}

/** Whether a hosted route on this provider still has to be PROVED by the Azure probe before it is taken.
 *  Every other capable provider is decided by the gates alone. */
export function requiresHostedToolSearchProbe(
  entry: Pick<BrainProviderEntry, 'type' | 'api' | 'baseUrl'>,
): boolean {
  return isAzureOpenAIResponsesProvider(entry);
}

/** Whether this model id passes the provider's own hosted-search model gate — the same family arithmetic
 *  the route resolver applies, exposed so the settings surface reports a model's eligibility without
 *  restating it in the browser. Presumes a capable entry, and says nothing about the operator switch.
 *
 *  An Azure deployment has an arbitrary NAME (`production-luna` fronting a GPT-5.x deployment), which is
 *  exactly why that branch of the resolver reads a stored probe instead of the model id — so there is no
 *  family gate to report here, and the probe status answers for those models instead. */
export function passesHostedToolSearchModelGate(
  entry: Pick<BrainProviderEntry, 'type' | 'api' | 'baseUrl'>,
  modelId: string,
): boolean {
  if (isAzureOpenAIResponsesProvider(entry)) return true;
  return entry.type === 'oauth-anthropic' || entry.type === 'anthropic'
    ? isAnthropicHostedToolSearchModelId(modelId)
    : isGpt54OrLater(modelId);
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
  // The operator turned this provider's native search off in Settings → Brain. Subtractive only: there is
  // no value of this field that GRANTS a route, so a forged config patch cannot promote an unprobed Azure
  // deployment — every positive branch below still has to earn itself. Falling through here lands the
  // session on Elowen's local ToolSearch, which is the same path a non-hosted provider takes.
  if (entry.hostedToolSearchEnabled === false) return undefined;

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
