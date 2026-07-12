import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import { APP_IDENTITY_HEADERS } from '../inference/appIdentity.js';
import { installOpenRouterMeter } from './openrouterMeter.js';
import type { BrainProviderType, BrainProviderApi } from '../store/configStore.js';
import { descriptorCapabilities } from './modelCapabilities.js';

/** One brain model provider, daemon-side (API key included). `openai`/`anthropic` register a custom
 *  endpoint; `oauth-*` rely on pi-ai's built-in providers + an OAuth credential in the AuthStorage. */
export interface BrainProviderEntry {
  id: string;
  label: string;
  type: BrainProviderType;
  baseUrl: string;
  models: string[];
  apiKey: string | null;
  /** Wire-API override for `openai`-type entries (Responses vs Chat Completions). Absent → auto,
   *  see {@link openAiApiFor}. */
  api?: BrainProviderApi;
  /** How this entry authenticates — drives the picker's provenance badge (OAuth account vs API key vs
   *  the autopilot relay fallback). Set by `brainConfigFromElowen`; absent reads as 'api-key'. */
  origin?: 'api-key' | 'oauth' | 'relay';
}

export interface BrainRuntimeConfig {
  providers: BrainProviderEntry[];
  /** Operator-set max context window per model, keyed `providerId/model`. Overrides the 200k placeholder
   *  in `modelEntry` so context-usage % and (auto-)compaction use the real window for endpoints that
   *  don't report one. Absent/0 for a model → the default placeholder. */
  contextWindows?: Record<string, number>;
}

/** Which built-in pi-ai provider an OAuth entry maps onto (models + streaming come from the built-in
 *  catalog; the credential comes from AuthStorage after a successful login). */
export const OAUTH_BUILTIN: Record<string, string> = {
  'oauth-anthropic': 'anthropic',
  'oauth-github-copilot': 'github-copilot',
  'oauth-openai-codex': 'openai-codex',
};

/** Models exposed by the ChatGPT/OpenAI OAuth account. PI ships the stable core catalog; Elowen adds
 *  newly enabled account models here until they land in the pinned PI release. Registration preserves
 *  PI's exact descriptors for existing models and derives safe descriptors for the additions. */
const OPENAI_CODEX_OAUTH_MODELS = [
  'gpt-5.3-codex-spark',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
] as const;

function extendOpenAiCodexCatalog(registry: ModelRegistry): void {
  const provider = 'openai-codex';
  const builtins = registry.getAll().filter((model) => model.provider === provider);
  const template = builtins.find((model) => model.id === 'gpt-5.5') ?? builtins[0];
  const builtinOauth = registry.authStorage.getOAuthProviders().find((entry) => entry.id === provider);
  if (!template || !builtinOauth) return;
  const existing = new Set(builtins.map((model) => model.id));
  const models = builtins.map((model) => ({
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
  }));
  for (const id of OPENAI_CODEX_OAUTH_MODELS) {
    if (existing.has(id)) continue;
    const capabilities = descriptorCapabilities(provider, id);
    models.push({
      id,
      name: id,
      api: template.api,
      baseUrl: template.baseUrl,
      reasoning: capabilities.reasoning,
      thinkingLevelMap: capabilities.thinkingLevelMap,
      input: ['text', 'image'],
      cost: template.cost,
      contextWindow: template.contextWindow,
      maxTokens: template.maxTokens,
      compat: template.compat,
    });
  }
  registry.registerProvider(provider, {
    name: 'OpenAI Codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    oauth: builtinOauth,
    models,
  });
}

/** pi-ai's openai-completions client appends `/chat/completions` to the model's baseUrl, so the base
 *  must already include the API version segment (e.g. `.../v1`). We only trim a trailing slash — we do
 *  NOT strip `/v1` (doing so 404s against proxies whose route is `/v1/chat/completions`). */
const normOpenAiBase = (base: string) => base.replace(/\/$/, '');

/** The wire API an `openai`-type entry registers with: an explicit per-provider choice wins, else the
 *  OFFICIAL OpenAI endpoint defaults to the Responses API (server-side prompt caching, reasoning
 *  summaries) while every other OpenAI-compatible endpoint keeps Chat Completions — the lowest common
 *  denominator proxies/relays reliably implement. */
export function openAiApiFor(p: Pick<BrainProviderEntry, 'api' | 'baseUrl'>): BrainProviderApi {
  if (p.api) return p.api;
  return /(^|\/\/)api\.openai\.com(\/|$)/.test(p.baseUrl || 'https://api.openai.com/v1') ? 'openai-responses' : 'openai-completions';
}

/** Reasonable descriptor defaults — the brain is a chat agent, exact cost/window are not load-bearing
 *  here (usage accounting lives elsewhere), so we ship safe placeholders the model list requires.
 *  `input` is declared multimodal: pi-ai DOWNGRADES image blocks to a "(image omitted…)" placeholder
 *  whenever the model descriptor's `input` lacks 'image' (see pi-ai transform-messages
 *  downgradeUnsupportedImages), which silently strips vision even from models that support it. We can't
 *  probe per-model capability for inline providers (OpenRouter, custom relays), so we declare vision and
 *  let the endpoint decide: a genuinely multimodal model gets the image, a text-only one returns a clean
 *  400 ("does not support image input") instead of a confusing text-only answer. */
/** Default context window when the operator hasn't pinned one and the endpoint doesn't report a reliable
 *  max — a safe placeholder the model list requires. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
function modelEntry(provider: string, id: string, contextWindow?: number) {
  const capabilities = descriptorCapabilities(provider, id);
  return {
    id, name: id, reasoning: capabilities.reasoning, input: ['text', 'image'] as ('text' | 'image')[],
    // Per-provider/model reasoning support lives in modelCapabilities.ts. In particular, an unknown
    // custom chat model is not sent a speculative reasoning_effort that would turn a healthy request
    // into a 400; known reasoning families expose only their real canonical levels.
    thinkingLevelMap: capabilities.thinkingLevelMap,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW, maxTokens: 8_192,
  };
}

/** The pinned context window for one provider entry's model, or undefined to use the default. */
const windowFor = (cfg: BrainRuntimeConfig, providerId: string, model: string): number | undefined =>
  cfg.contextWindows?.[`${providerId}/${model}`];

/** The registry provider name a config entry registers/reads under. Custom endpoints get a stable
 *  `elowen-<id>` namespace; OAuth entries resolve to the built-in provider. */
export function registryProviderName(p: BrainProviderEntry): string {
  return OAUTH_BUILTIN[p.type] ?? `elowen-${p.id}`;
}

/** Build the brain's ModelRegistry from the configured providers. Custom endpoints are registered with
 *  inline API keys; OAuth entries need no registration (built-in catalog + AuthStorage credential). */
export function buildBrainRegistry(cfg: BrainRuntimeConfig, authStorage: AuthStorage = AuthStorage.inMemory()): ModelRegistry {
  // pi-ai's openai client discards OpenRouter's reported `usage.cost`; this fetch-layer meter recovers it.
  // Idempotent, and co-located with provider setup so it's always active before the first brain request.
  installOpenRouterMeter();
  const registry = ModelRegistry.inMemory(authStorage);
  extendOpenAiCodexCatalog(registry);
  for (const p of cfg.providers) {
    if (p.type === 'openai') {
      registry.registerProvider(registryProviderName(p), {
        name: p.label,
        api: openAiApiFor(p),
        baseUrl: normOpenAiBase(p.baseUrl || 'https://api.openai.com/v1'),
        apiKey: p.apiKey ?? undefined,
        headers: { ...APP_IDENTITY_HEADERS },
        models: p.models.map((m) => modelEntry(registryProviderName(p), m, windowFor(cfg, p.id, m))),
      });
    } else if (p.type === 'anthropic') {
      registry.registerProvider(registryProviderName(p), {
        name: p.label,
        api: 'anthropic-messages',
        baseUrl: p.baseUrl || 'https://api.anthropic.com',
        apiKey: p.apiKey ?? undefined,
        headers: { ...APP_IDENTITY_HEADERS },
        models: p.models.map((m) => modelEntry(registryProviderName(p), m, windowFor(cfg, p.id, m))),
      });
    }
    // oauth-* types: built-in providers already carry their model catalogs; auth comes from AuthStorage.
  }
  return registry;
}

/** What a user (or a channel) selected: a provider entry id + a model id, both optional — absent parts
 *  fall back to the first configured provider / its first model. */
export interface BrainModelSelection { provider?: string; model?: string }

/** One authoritative provider/model route for a live PI session. `model` is always the user's exact
 * selection (or the provider default). `compactionFallback`, when present, is the same configured
 * provider's distinct default model and is used for ChatGPT OAuth compaction only. It never replaces
 * the chat/session model or causes a reactive retry. */
export interface BrainModelRoute {
  providerId: string;
  model: Model<Api>;
  compactionFallback?: Model<Api>;
}

/** Resolve the Model to run on. For custom endpoints an unknown model id is registered on the fly
 *  (OpenAI-compatible proxies accept arbitrary ids — the picker list is advisory, not exhaustive). */
/** Sensible default for a provider with no explicitly configured models (a bare connected OAuth
 *  account): the catalog is alphabetical, so "first" would be the OLDEST model. Prefer a known-good
 *  current model; fall back to the first catalog entry if it ever disappears. */
export const PREFERRED_DEFAULT: Record<string, string> = {
  anthropic: 'claude-opus-4-8',
  'openai-codex': 'gpt-5.5',
  'github-copilot': 'claude-opus-4.8',
};
function defaultCatalogModel(registry: ModelRegistry, providerName: string): string | undefined {
  const models = registry.getAll().filter((m) => m.provider === providerName);
  const preferred = PREFERRED_DEFAULT[providerName];
  return (preferred && models.some((m) => m.id === preferred) ? preferred : models[0]?.id);
}

function resolveEntryModel(
  registry: ModelRegistry,
  cfg: BrainRuntimeConfig,
  entry: BrainProviderEntry,
  modelId: string,
): Model<Api> {
  const providerName = registryProviderName(entry);
  const model = registry.find(providerName, modelId);
  if (model) return model;
  if (entry.type === 'openai' || entry.type === 'anthropic') {
    // Not in the advertised list — register it ad hoc so a hand-typed model id still works.
    registry.registerProvider(providerName, {
      name: entry.label,
      api: entry.type === 'openai' ? openAiApiFor(entry) : 'anthropic-messages',
      baseUrl: entry.type === 'openai' ? normOpenAiBase(entry.baseUrl || 'https://api.openai.com/v1') : (entry.baseUrl || 'https://api.anthropic.com'),
      apiKey: entry.apiKey ?? undefined,
      headers: { ...APP_IDENTITY_HEADERS },
      models: [...new Set([...entry.models, modelId])].map((m) => modelEntry(providerName, m, windowFor(cfg, entry.id, m))),
    });
    const added = registry.find(providerName, modelId);
    if (added) return added;
  }
  throw new Error(`brain model '${modelId}' not found for provider '${entry.id}'`);
}

export function resolveBrainModelRoute(
  registry: ModelRegistry, cfg: BrainRuntimeConfig, sel?: BrainModelSelection,
): BrainModelRoute {
  const entry = (sel?.provider ? cfg.providers.find((p) => p.id === sel.provider) : undefined) ?? cfg.providers[0];
  if (!entry) throw new Error('no brain provider configured');
  const providerName = registryProviderName(entry);
  const defaultId = entry.models[0] || defaultCatalogModel(registry, providerName);
  const modelId = sel?.model || defaultId;
  if (!modelId) throw new Error(`brain provider '${entry.id}' has no models configured`);
  const model = resolveEntryModel(registry, cfg, entry, modelId);

  // ChatGPT OAuth's configured provider default is the stable model for context summarization. Resolve
  // that route before the session starts so compaction never depends on parsing a provider error or
  // issuing a second request; custom proxies and every other provider keep PI's selected model.
  let compactionFallback: Model<Api> | undefined;
  if (model.provider === 'openai-codex' && defaultId && defaultId !== model.id) {
    // Routing is optional: a stale configured default must never make a valid explicit chat selection
    // unstartable. If it is absent from the live OAuth catalog, native PI compaction uses the selected
    // descriptor and surfaces its own provider result.
    const candidate = registry.find(providerName, defaultId);
    if (candidate?.provider === model.provider) compactionFallback = candidate;
  }
  return { providerId: entry.id, model, ...(compactionFallback ? { compactionFallback } : {}) };
}

export function resolveBrainModel(
  registry: ModelRegistry, cfg: BrainRuntimeConfig, sel?: BrainModelSelection,
): Model<Api> {
  return resolveBrainModelRoute(registry, cfg, sel).model;
}
