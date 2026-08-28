import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, FetchFunction, Model, ProviderHeaders } from '@earendil-works/pi-ai';
import type { BrainProviderEntry } from './providers.js';
import { trimAllTrailingSlashes } from '../shared/url.js';

type FastModeModel = Pick<Model<Api>, 'id' | 'provider' | 'api'>;

export type FastModeRoute =
  | {
      provider: 'openai';
      source: 'openai-codex-oauth' | 'openai-api' | 'azure-openai';
      serviceTier: 'priority';
    }
  | {
      provider: 'anthropic';
      source: 'anthropic-api';
      speed: 'fast';
      beta: 'fast-mode-2026-02-01';
    };

interface EndpointIdentity {
  host: string;
  port: string;
  path: string;
}

const normalizedEndpoint = (entry: Pick<BrainProviderEntry, 'type' | 'baseUrl'>): EndpointIdentity | undefined => {
  const raw = entry.baseUrl.trim() || (entry.type === 'anthropic'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1');
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return { host: url.hostname.toLowerCase(), port: url.port, path: trimAllTrailingSlashes(url.pathname) || '/' };
  } catch {
    return undefined;
  }
};

const isOfficialOpenAI = (endpoint: EndpointIdentity | undefined): boolean =>
  endpoint?.host === 'api.openai.com' && endpoint.port === '' && (endpoint.path === '/' || endpoint.path === '/v1');

const isAzureOpenAIResponses = (endpoint: EndpointIdentity | undefined): boolean =>
  !!endpoint
  && endpoint.port === ''
  && endpoint.host !== 'openai.azure.com'
  && endpoint.host.endsWith('.openai.azure.com')
  && endpoint.path === '/openai/v1';

const isOfficialAnthropic = (endpoint: EndpointIdentity | undefined): boolean =>
  endpoint?.host === 'api.anthropic.com' && endpoint.port === '' && endpoint.path === '/';

const CODEX_FAST_MODEL = /^gpt-5\.(?:4|5|6)(?:-|$)/;
const OPENAI_FAST_MODEL = /^(?:gpt-5\.6-(?:sol|terra|luna)(?:-|$)|gpt-5\.3-codex(?:-\d{4}-\d{2}-\d{2})?$)/;
const AZURE_FAST_MODEL = /^(?:gpt-5\.6-(?:terra|sol)|gpt-5\.5|gpt-5\.4-mini|gpt-5\.4|gpt-5\.2|gpt-5\.1|gpt-4\.1)(?:-\d{4}-\d{2}-\d{2})?$/;
const ANTHROPIC_FAST_MODEL = /^claude-opus-(?:5|4-8)(?:-|$)/;

/**
 * The single owner of Fast capability. It classifies the configured route, wire API and exact request model;
 * credential provenance alone never grants support to a compatible relay.
 */
export function resolveFastModeRoute(entry: BrainProviderEntry, model: FastModeModel): FastModeRoute | undefined {
  if (entry.type === 'oauth-openai-codex') {
    return model.provider === 'openai-codex'
      && model.api === 'openai-codex-responses'
      && CODEX_FAST_MODEL.test(model.id)
      && !/spark|image/i.test(model.id)
      ? { provider: 'openai', source: 'openai-codex-oauth', serviceTier: 'priority' }
      : undefined;
  }

  const endpoint = normalizedEndpoint(entry);
  if (entry.type === 'openai') {
    if (isOfficialOpenAI(endpoint)
      && (model.api === 'openai-responses' || model.api === 'openai-completions')
      && OPENAI_FAST_MODEL.test(model.id)) {
      return { provider: 'openai', source: 'openai-api', serviceTier: 'priority' };
    }
    if (entry.api === 'openai-responses'
      && model.api === 'openai-responses'
      && isAzureOpenAIResponses(endpoint)
      && AZURE_FAST_MODEL.test(model.id)) {
      return { provider: 'openai', source: 'azure-openai', serviceTier: 'priority' };
    }
    return undefined;
  }

  if (entry.type === 'anthropic'
    && model.api === 'anthropic-messages'
    && isOfficialAnthropic(endpoint)
    && ANTHROPIC_FAST_MODEL.test(model.id)) {
    return { provider: 'anthropic', source: 'anthropic-api', speed: 'fast', beta: 'fast-mode-2026-02-01' };
  }
  return undefined;
}

export function applyFastModePayload(payload: Record<string, unknown>, route: FastModeRoute): Record<string, unknown> {
  return route.provider === 'openai'
    ? { ...payload, service_tier: route.serviceTier }
    : { ...payload, speed: route.speed };
}

export function fastModeHeaders(route: FastModeRoute): ProviderHeaders {
  return route.provider === 'anthropic' ? { 'anthropic-beta': route.beta } : {};
}

/** Anthropic Fast prices Opus 5/4.8 at exactly 2× their standard token rates. */
export function fastModeCostModel(model: Model<Api>, route: FastModeRoute): Model<Api> {
  if (route.provider !== 'anthropic') return model;
  return {
    ...model,
    cost: {
      input: model.cost.input * 2,
      output: model.cost.output * 2,
      cacheRead: model.cost.cacheRead * 2,
      cacheWrite: model.cost.cacheWrite * 2,
    },
  };
}

function fastModeFetch(current: FetchFunction | undefined, route: FastModeRoute): FetchFunction | undefined {
  if (route.provider !== 'anthropic') return current;
  const fetchImpl = current ?? globalThis.fetch;
  return async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const existing = headers.get('anthropic-beta')?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
    if (!existing.includes(route.beta)) existing.push(route.beta);
    headers.set('anthropic-beta', existing.join(','));
    return fetchImpl(input, { ...init, headers });
  };
}

/** Build the request options for one actual provider call. The account getter is sampled here, not at spawn. */
export function fastModeRequestOptions(
  options: Parameters<ModelRuntime['streamSimple']>[2],
  model: Model<Api>,
  enabled: () => boolean,
  routeFor: (model: Model<Api>) => FastModeRoute | undefined,
): Parameters<ModelRuntime['streamSimple']>[2] {
  if (!enabled()) return options;
  const route = routeFor(model);
  if (!route) return options;
  const originalPayload = options?.onPayload;
  return {
    ...options,
    fetch: fastModeFetch(options?.fetch, route),
    onPayload: async (payload: unknown, requestModel: Model<Api>) => {
      const transformed = await originalPayload?.(payload, requestModel);
      const finalPayload = transformed === undefined ? payload : transformed;
      if (!finalPayload || typeof finalPayload !== 'object' || Array.isArray(finalPayload)) return finalPayload;
      return applyFastModePayload(finalPayload as Record<string, unknown>, route);
    },
  };
}

/** Session-scoped runtime wrapper that evaluates Fast against the actual model of every chat/compaction call. */
export function wrapFastModeRuntime(
  runtime: ModelRuntime,
  enabled: () => boolean,
  routeFor: (model: Model<Api>) => FastModeRoute | undefined,
): ModelRuntime {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property === 'streamSimple') {
        return (
          model: Model<Api>,
          context: Parameters<ModelRuntime['streamSimple']>[1],
          options: Parameters<ModelRuntime['streamSimple']>[2],
        ) => {
          const route = enabled() ? routeFor(model) : undefined;
          return target.streamSimple(
            route ? fastModeCostModel(model, route) : model,
            context,
            route ? fastModeRequestOptions(options, model, () => true, () => route) : options,
          );
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
