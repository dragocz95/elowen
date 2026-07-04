import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import { APP_IDENTITY_HEADERS } from '../inference/appIdentity.js';
import type { BrainProviderType } from '../store/configStore.js';

/** One brain model provider, daemon-side (API key included). `openai`/`anthropic` register a custom
 *  endpoint; `oauth-*` rely on pi-ai's built-in providers + an OAuth credential in the AuthStorage. */
export interface BrainProviderEntry {
  id: string;
  label: string;
  type: BrainProviderType;
  baseUrl: string;
  models: string[];
  apiKey: string | null;
  /** How this entry authenticates — drives the picker's provenance badge (OAuth account vs API key vs
   *  the autopilot relay fallback). Set by `brainConfigFromOrca`; absent reads as 'api-key'. */
  origin?: 'api-key' | 'oauth' | 'relay';
}

export interface BrainRuntimeConfig { providers: BrainProviderEntry[] }

/** Which built-in pi-ai provider an OAuth entry maps onto (models + streaming come from the built-in
 *  catalog; the credential comes from AuthStorage after a successful login). */
export const OAUTH_BUILTIN: Record<string, string> = {
  'oauth-anthropic': 'anthropic',
  'oauth-github-copilot': 'github-copilot',
  'oauth-openai-codex': 'openai-codex',
};

/** pi-ai's openai-completions client appends `/chat/completions` to the model's baseUrl, so the base
 *  must already include the API version segment (e.g. `.../v1`). We only trim a trailing slash — we do
 *  NOT strip `/v1` (doing so 404s against proxies whose route is `/v1/chat/completions`). */
const normOpenAiBase = (base: string) => base.replace(/\/$/, '');

/** Reasonable descriptor defaults — the brain is a chat agent, exact cost/window are not load-bearing
 *  here (usage accounting lives elsewhere), so we ship safe placeholders the model list requires. */
function modelEntry(id: string) {
  return {
    id, name: id, reasoning: true, input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000, maxTokens: 8_192,
  };
}

/** The registry provider name a config entry registers/reads under. Custom endpoints get a stable
 *  `orca-<id>` namespace; OAuth entries resolve to the built-in provider. */
export function registryProviderName(p: BrainProviderEntry): string {
  return OAUTH_BUILTIN[p.type] ?? `orca-${p.id}`;
}

/** Build the brain's ModelRegistry from the configured providers. Custom endpoints are registered with
 *  inline API keys; OAuth entries need no registration (built-in catalog + AuthStorage credential). */
export function buildBrainRegistry(cfg: BrainRuntimeConfig, authStorage: AuthStorage = AuthStorage.inMemory()): ModelRegistry {
  const registry = ModelRegistry.inMemory(authStorage);
  for (const p of cfg.providers) {
    if (p.type === 'openai') {
      registry.registerProvider(registryProviderName(p), {
        name: p.label,
        api: 'openai-completions',
        baseUrl: normOpenAiBase(p.baseUrl || 'https://api.openai.com/v1'),
        apiKey: p.apiKey ?? undefined,
        headers: { ...APP_IDENTITY_HEADERS },
        models: p.models.map(modelEntry),
      });
    } else if (p.type === 'anthropic') {
      registry.registerProvider(registryProviderName(p), {
        name: p.label,
        api: 'anthropic-messages',
        baseUrl: p.baseUrl || 'https://api.anthropic.com',
        apiKey: p.apiKey ?? undefined,
        headers: { ...APP_IDENTITY_HEADERS },
        models: p.models.map(modelEntry),
      });
    }
    // oauth-* types: built-in providers already carry their model catalogs; auth comes from AuthStorage.
  }
  return registry;
}

/** What a user (or a channel) selected: a provider entry id + a model id, both optional — absent parts
 *  fall back to the first configured provider / its first model. */
export interface BrainModelSelection { provider?: string; model?: string }

/** Resolve the Model to run on. For custom endpoints an unknown model id is registered on the fly
 *  (OpenAI-compatible proxies accept arbitrary ids — the picker list is advisory, not exhaustive). */
/** Sensible default for a provider with no explicitly configured models (a bare connected OAuth
 *  account): the catalog is alphabetical, so "first" would be the OLDEST model. Prefer a known-good
 *  current model; fall back to the first catalog entry if it ever disappears. */
const PREFERRED_DEFAULT: Record<string, string> = {
  anthropic: 'claude-opus-4-8',
  'openai-codex': 'gpt-5.5',
  'github-copilot': 'claude-opus-4.8',
};
function defaultCatalogModel(registry: ModelRegistry, providerName: string): string | undefined {
  const models = registry.getAll().filter((m) => m.provider === providerName);
  const preferred = PREFERRED_DEFAULT[providerName];
  return (preferred && models.some((m) => m.id === preferred) ? preferred : models[0]?.id);
}

export function resolveBrainModel(
  registry: ModelRegistry, cfg: BrainRuntimeConfig, sel?: BrainModelSelection,
): Model<Api> {
  const entry = (sel?.provider ? cfg.providers.find((p) => p.id === sel.provider) : undefined) ?? cfg.providers[0];
  if (!entry) throw new Error('no brain provider configured');
  const providerName = registryProviderName(entry);
  const modelId = sel?.model || entry.models[0] || defaultCatalogModel(registry, providerName);
  if (!modelId) throw new Error(`brain provider '${entry.id}' has no models configured`);
  const model = registry.find(providerName, modelId);
  if (model) return model;
  if (entry.type === 'openai' || entry.type === 'anthropic') {
    // Not in the advertised list — register it ad hoc so a hand-typed model id still works.
    registry.registerProvider(providerName, {
      name: entry.label,
      api: entry.type === 'openai' ? 'openai-completions' : 'anthropic-messages',
      baseUrl: entry.type === 'openai' ? normOpenAiBase(entry.baseUrl || 'https://api.openai.com/v1') : (entry.baseUrl || 'https://api.anthropic.com'),
      apiKey: entry.apiKey ?? undefined,
      headers: { ...APP_IDENTITY_HEADERS },
      models: [...new Set([...entry.models, modelId])].map(modelEntry),
    });
    const added = registry.find(providerName, modelId);
    if (added) return added;
  }
  throw new Error(`brain model '${modelId}' not found for provider '${entry.id}'`);
}
