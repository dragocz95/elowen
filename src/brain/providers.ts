import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { APP_IDENTITY_HEADERS } from '../inference/appIdentity.js';
import { BRAIN_REGISTRY_PROVIDER_PREFIX, toRegistryProvider } from '../shared/execs.js';
import { trimTrailingSlash } from '../shared/url.js';
import { installOpenRouterMeter } from './openrouterMeter.js';
import { DEFAULT_OPENAI_COMPATIBILITY, type BrainProviderType, type BrainProviderApi } from '../store/configStore.js';
import type { BrainProviderCompatibility } from '../shared/wireContract.js';
import { catalogModelCost, catalogModelVision, descriptorCapabilities } from './modelCapabilities.js';

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
  /** Explicit Chat Completions capabilities. Custom endpoints default to the conservative block; the
   *  runtime maps these product-level controls onto pi-ai's provider compatibility descriptor. */
  compatibility?: BrainProviderCompatibility;
  /** How this entry authenticates — drives the picker's provenance badge (OAuth account vs API key vs
   *  relay endpoint). Set by `brainConfigFromElowen`; absent reads as 'api-key'. */
  origin?: 'api-key' | 'oauth' | 'relay';
  /** Sampling temperature for this endpoint; absent sends none. Per-provider rather than global because
   *  some models accept only their own default and 400 on anything else. */
  temperature?: number;
  /** Operator switch for this provider's NATIVE (hosted) tool search. Typed as the literal `false` on
   *  purpose: the only thing an operator may state here is "off". Absent — the default, and the only other
   *  value the config can hold — leaves today's behaviour, where the route is granted solely by the
   *  provider/model gates and, for Azure, a stored positive probe. So the flag can subtract a route and
   *  never add one, which is what keeps it safe to carry through the generic config PATCH. */
  hostedToolSearchEnabled?: false;
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
  // PI 0.82.0 ships `kimi-coding` with its own device-code OAuth alongside the API key (KIMI_API_KEY), so
  // the same built-in catalog serves both a Kimi Code login and a pasted key with nothing to attach.
  'oauth-kimi': 'kimi-coding',
};

/** One built-in descriptor restated as a registration input. Registering an extension config REPLACES the
 *  provider's model list rather than merging into it (pi-coding-agent's provider composer builds the new
 *  list from the definitions alone), so every built-in has to be copied forward field by field or it
 *  disappears from the account's catalog together with the metadata PI maintains for it. */
function catalogDefinition(model: Model<Api>, configured?: Pick<Model<Api>, 'samplingParams' | 'headers'>) {
  return {
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
    // Provider composition keeps configured model headers outside the public descriptor and resolves them
    // only at request time. A later copy-forward (notably pinned OAuth windows) must therefore carry the
    // previous registration input explicitly or it silently drops per-model request identity.
    samplingParams: configured?.samplingParams ?? model.samplingParams,
    headers: configured?.headers ?? model.headers,
    compat: model.compat,
  };
}

/** ChatGPT-account text models accepted by the OAuth endpoint but absent from the pinned PI catalog.
 *  Inherit one native descriptor as a unit rather than guessing transport, limits, pricing or capabilities
 *  field by field. PI's own descriptor wins automatically once it ships the exact id. */
const OPENAI_CODEX_OAUTH_TEXT_MODELS = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', clonedFrom: 'gpt-5.6-sol' },
] as const;

/** Image models the ChatGPT/OpenAI OAuth account exposes for the GenerateImage tool but that the pinned PI
 *  release does not list in the openai-codex catalog. */
const OPENAI_CODEX_OAUTH_IMAGE_MODELS = ['gpt-image-1.5', 'gpt-image-2'] as const;

function extendOpenAiCodexCatalog(registry: ModelRegistry): void {
  const provider = 'openai-codex';
  const builtins = registry.getAll().filter((model) => model.provider === provider);
  const template = builtins.find((model) => model.id === 'gpt-5.5') ?? builtins[0];
  if (!template) return; // PI dropped the provider — nothing to extend.
  const existing = new Set(builtins.map((model) => model.id));
  const models = builtins.map((model) => catalogDefinition(model));
  for (const addition of OPENAI_CODEX_OAUTH_TEXT_MODELS) {
    if (existing.has(addition.id)) continue;
    const inherited = builtins.find((model) => model.id === addition.clonedFrom);
    if (!inherited) continue; // Nothing to clone from; no entry beats one guessed from scratch.
    models.push({ ...catalogDefinition(inherited), id: addition.id, name: addition.name });
    existing.add(addition.id);
  }
  for (const id of OPENAI_CODEX_OAUTH_IMAGE_MODELS) {
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
      samplingParams: template.samplingParams,
      headers: template.headers,
      compat: template.compat,
    });
  }
  // No `oauth` here: registering an extension config over a built-in provider composes onto it, so the
  // provider's native OAuth is preserved (the composition falls back to the base when the extension omits
  // it). Re-supplying it would only be needed for a provider PI ships without one.
  registry.registerProvider(provider, {
    name: 'OpenAI Codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    models,
  });
}

/** Claude-account models verified live but absent from the pinned PI catalog. Metadata is inherited from
 *  the immediate same-tier predecessor so context, output limit, pricing, vision, reasoning and compatibility
 *  remain one tested descriptor rather than a second hand-maintained copy. PI's native entry wins once it
 *  ships the id. */
const ANTHROPIC_OAUTH_MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', clonedFrom: 'claude-opus-4-8', headers: undefined },
  // A 2026-09-01 OAuth probe accepted this exact id, but rejected PI's claude-cli/2.1.75 identity with an
  // authoritative minimum of 2.1.251. The adapter merges model headers after its default, so the override is
  // scoped to this account model rather than changing Anthropic API-key providers or unrelated Claude tiers.
  {
    id: 'claude-fable-5-1', name: 'Claude Fable 5.1', clonedFrom: 'claude-fable-5',
    headers: { 'user-agent': 'claude-cli/2.1.251' },
  },
] as const;

function extendAnthropicCatalog(registry: ModelRegistry): void {
  const provider = 'anthropic';
  const builtins = registry.getAll().filter((model) => model.provider === provider);
  const existing = new Set(builtins.map((model) => model.id));
  const models = builtins.map((model) => catalogDefinition(model));
  for (const addition of ANTHROPIC_OAUTH_MODELS) {
    // Already listed — either PI ships it now and its own descriptor wins, or this runtime was extended by an
    // earlier build. Both want the same thing: leave that model alone.
    if (existing.has(addition.id)) continue;
    const template = builtins.find((model) => model.id === addition.clonedFrom);
    if (!template) continue; // Nothing to clone from; no entry beats one guessed from scratch.
    models.push({
      ...catalogDefinition(template),
      id: addition.id,
      name: addition.name,
      ...(addition.headers ? { headers: { ...template.headers, ...addition.headers } } : {}),
    });
    existing.add(addition.id);
  }
  if (models.length === builtins.length) return;
  // Sorted so the catalog stays alphabetical, which is what PREFERRED_DEFAULT's fallback assumes. Provider
  // name/API/baseUrl/OAuth are omitted: composition falls back to the built-in for each instead of copying.
  registry.registerProvider(provider, { models: models.sort((a, b) => a.id.localeCompare(b.id)) });
}

/** pi-ai's openai-completions client appends `/chat/completions` to the model's baseUrl, so the base
 *  must already include the API version segment (e.g. `.../v1`). We only trim a trailing slash — we do
 *  NOT strip `/v1` (doing so 404s against proxies whose route is `/v1/chat/completions`). */
const normOpenAiBase = (base: string) => trimTrailingSlash(base);

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
 *  `input` gates pi-ai's downgradeUnsupportedImages (transform-messages): when the descriptor's `input`
 *  lacks 'image', pi-ai replaces image blocks with a "(image omitted…)" placeholder and PI's Read tool
 *  appends a "model does not support images" note — a clean text answer instead of a request that errors.
 *  A model the catalog KNOWS is text-only therefore gets `['text']` so that graceful path fires; a genuine
 *  vision model, OR one the catalog does not cover (an unprobeable relay), keeps `['text', 'image']` so its
 *  vision is never silently stripped — there the endpoint still decides (a 400 for a text-only relay model).
 *  This is what stops a tool-read image on a text-only model from 400-ing every turn and killing the chat. */
/** Default context window when the operator hasn't pinned one and the endpoint doesn't report a reliable
 *  max — a safe placeholder the model list requires. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** `developer` is OpenAI's own rename of the `system` role, and pi-ai sends it in place of `system` for
 *  any REASONING model whose endpoint its compat detection doesn't recognise as non-standard — absent a
 *  known provider id or baseUrl (deepseek.com, api.z.ai, openrouter.ai, …) it assumes OpenAI semantics.
 *
 *  A relay is precisely the endpoint it cannot recognise: it fronts DeepSeek/Anthropic/… under its OWN
 *  URL, so nothing on the wire reveals the model family behind it. One that implements only the classic
 *  roles then answers a perfectly healthy request with a 400 — `unknown variant 'developer', expected one
 *  of system, user, assistant, tool` — and only for reasoning models, which is what makes it look random.
 *
 *  `system` is the lowest common denominator every OpenAI-compatible endpoint implements (OpenAI itself
 *  still accepts it), so Chat-Completions entries pin it rather than gamble. Same conservatism as
 *  `openAiApiFor` keeping relays on Chat Completions, and `modelCapabilities` withholding a speculative
 *  `reasoning_effort`. The official OpenAI endpoint is unaffected: it registers as `openai-responses`. */
/** Compatibility is explicit for every custom Chat Completions endpoint. The safe baseline avoids
 *  provider-specific OpenAI extensions; an operator may opt into each documented capability in Settings.
 *  Responses and Anthropic use their own wire contracts and keep pi-ai's native compatibility handling. */
function openAiCompatibilityFor(
  entry: Pick<BrainProviderEntry, 'type' | 'api' | 'baseUrl' | 'compatibility'>,
): Model<Api>['compat'] | undefined {
  if (entry.type !== 'openai' || openAiApiFor(entry) !== 'openai-completions') return undefined;
  return { ...DEFAULT_OPENAI_COMPATIBILITY, ...entry.compatibility };
}

function modelEntry(provider: string, id: string, contextWindow?: number, compat?: Model<Api>['compat']) {
  const capabilities = descriptorCapabilities(provider, id);
  // Declare vision unless the catalog KNOWS this model is text-only (see the descriptor-defaults note above).
  const input: ('text' | 'image')[] = catalogModelVision(provider, id) === false ? ['text'] : ['text', 'image'];
  return {
    id, name: id, reasoning: capabilities.reasoning, input,
    // Per-provider/model reasoning support lives in modelCapabilities.ts. In particular, an unknown
    // custom chat model is not sent a speculative reasoning_effort that would turn a healthy request
    // into a 400; known reasoning families expose only their real canonical levels.
    thinkingLevelMap: capabilities.thinkingLevelMap,
    ...(compat ? { compat } : {}),
    // Estimated from the models.dev catalog so a proxied model (`kimi-k3` through a relay) reports real
    // spend instead of $0. A provider-reported cost (the OpenRouter meter, persistence.ts) still overrides
    // this per turn; a catalog miss keeps $0 rather than inventing a figure.
    cost: catalogModelCost(provider, id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW, maxTokens: 8_192,
  };
}

/** The pinned context window for one provider entry's model, or undefined to use the default. */
const windowFor = (cfg: BrainRuntimeConfig, providerId: string, model: string): number | undefined =>
  cfg.contextWindows?.[`${providerId}/${model}`];

/** The registry provider name a config entry registers/reads under. Custom endpoints get a stable
 *  `elowen-<id>` namespace; OAuth entries resolve to the built-in provider. */
export function registryProviderName(p: BrainProviderEntry): string {
  return OAUTH_BUILTIN[p.type] ?? toRegistryProvider(p.id);
}

/** A credential-less ModelRuntime for reading the built-in catalog and Elowen's descriptor profiles —
 *  no auth.json, so it never touches or resolves an operator credential. Used to inspect what a provider
 *  COULD serve (settings pickers, catalog listing) and by tests that build a throwaway registry. */
export function inMemoryModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
}

/** Build the brain's ModelRegistry from the configured providers, over a shared ModelRuntime (the credential
 *  store + built-in catalog). Custom endpoints are registered with inline API keys; OAuth entries need no
 *  registration (built-in catalog + the runtime's stored credential). */
export function buildBrainRegistry(cfg: BrainRuntimeConfig, runtime: ModelRuntime): ModelRegistry {
  // pi-ai's openai client discards OpenRouter's reported `usage.cost`; this fetch-layer meter recovers it.
  // Idempotent, and co-located with provider setup so it's always active before the first brain request.
  installOpenRouterMeter();
  const registry = new ModelRegistry(runtime);
  // The runtime is shared across sessions, so a custom endpoint deleted from config would otherwise linger
  // registered — with its API key — until a daemon restart. Drop any `elowen-*` provider not in the current
  // config before (re-)registering, so the registry reflects exactly today's custom endpoints.
  const wanted = new Set(cfg.providers.map(registryProviderName));
  for (const id of registry.getRegisteredProviderIds()) {
    if (id.startsWith(BRAIN_REGISTRY_PROVIDER_PREFIX) && !wanted.has(id)) registry.unregisterProvider(id);
  }
  extendOpenAiCodexCatalog(registry);
  extendAnthropicCatalog(registry);
  for (const p of cfg.providers) {
    if (p.type === 'openai') {
      const api = openAiApiFor(p);
      const compat = openAiCompatibilityFor(p);
      registry.registerProvider(registryProviderName(p), {
        name: p.label,
        api,
        baseUrl: normOpenAiBase(p.baseUrl || 'https://api.openai.com/v1'),
        apiKey: p.apiKey ?? undefined,
        headers: { ...APP_IDENTITY_HEADERS },
        models: p.models.map((m) => modelEntry(registryProviderName(p), m, windowFor(cfg, p.id, m), compat)),
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
    // Their PINNED context windows still have to be applied — see applyPinnedWindows below.
  }
  applyPinnedWindows(registry, cfg);
  return registry;
}

/** Apply operator-pinned context windows to the OAUTH built-in providers.
 *
 *  A custom endpoint carries its pin in through `modelEntry`, but an OAuth entry registers no provider at
 *  all — PI owns its catalog and its auth — so the pin had nowhere to land and the runtime kept the
 *  catalog's own number. The settings list applies the pin when it RENDERS (models.ts), which made the
 *  mismatch invisible: the picker showed the operator's value while every session ran on the catalog's,
 *  and the chat meter kept reporting the old window no matter how often it was set.
 *
 *  Re-registering an extension config over a built-in COMPOSES onto it, and each model definition carries
 *  its own `api`/`baseUrl`, so passing models alone preserves the provider's name, endpoint and native
 *  OAuth. Providers with no pin are left untouched rather than re-registered for nothing. */
function applyPinnedWindows(registry: ModelRegistry, cfg: BrainRuntimeConfig): void {
  for (const p of cfg.providers) {
    if (!(p.type in OAUTH_BUILTIN)) continue;
    const providerName = registryProviderName(p);
    const models = registry.getAll().filter((m) => m.provider === providerName);
    const configured = new Map(
      registry.getRegisteredProviderConfig(providerName)?.models?.map((definition) => [definition.id, definition]) ?? [],
    );
    const pinned = models.map((m) => ({
      def: catalogDefinition(m, configured.get(m.id)), window: windowFor(cfg, p.id, m.id),
    }));
    if (!pinned.some((m) => m.window && m.window > 0)) continue;
    registry.registerProvider(providerName, {
      models: pinned.map(({ def, window }) => (window && window > 0 ? { ...def, contextWindow: window } : def)),
    });
  }
}

/** What a user (or a channel) selected: a provider entry id + a model id, both optional — absent parts
 *  fall back to the first configured provider / its first model. */
export interface BrainModelSelection { provider?: string; model?: string }

/** One authoritative provider/model route for a live PI session. `model` is always the user's exact
 * selection (or the provider default). `compactionFallback`, when present, is a DISTINCT model used only
 * for PI-owned compaction requests — the user's chosen compaction model (which may be on a different
 * provider) or, absent that, ChatGPT OAuth's configured default. It never replaces the chat/session model
 * or causes a reactive retry. */
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
  anthropic: 'claude-opus-5',
  'openai-codex': 'gpt-5.5',
  'github-copilot': 'claude-opus-4.8',
  'kimi-coding': 'k3',
};
function defaultCatalogModel(registry: ModelRegistry, providerName: string): string | undefined {
  const models = registry.getAll().filter((m) => m.provider === providerName);
  const preferred = PREFERRED_DEFAULT[providerName];
  return (preferred && models.some((m) => m.id === preferred) ? preferred : models[0]?.id);
}

/** The model id one provider entry runs when nothing was selected: its first manually listed model, else
 *  the provider catalog's own default. THE rule — `resolveBrainModelRoute` below calls this, so a surface
 *  that has to DISPLAY the answer cannot drift from the one the spawn path computes. Re-deriving it as
 *  `entry.models[0]` is what made `serverDefault` disagree for a provider with an empty manual list. */
function entryDefaultModelId(registry: ModelRegistry, entry: BrainProviderEntry): string | undefined {
  return entry.models[0] || defaultCatalogModel(registry, registryProviderName(entry));
}

/** WHERE A CONVERSATION STARTS when the account has expressed no preference: the first configured
 *  provider and {@link entryDefaultModelId} on it. Display-only — it answers "what does empty resolve
 *  to", carries the provider's label for a picker summary, and deliberately knows nothing about any
 *  caller's allow-list, because the instance default is admin-controlled and applies to a member whose
 *  own catalog does not list it. Undefined when no provider is configured at all. */
export function brainDefaultSelection(
  registry: ModelRegistry, cfg: BrainRuntimeConfig,
): { provider: string; providerLabel: string; model: string } | undefined {
  const entry = cfg.providers[0];
  if (!entry) return undefined;
  const model = entryDefaultModelId(registry, entry);
  return model ? { provider: entry.id, providerLabel: entry.label, model } : undefined;
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
    // Not in the advertised list — register it ad hoc so a hand-typed model id still works. The compat
    // comes from the same helper buildBrainRegistry uses, so the two registration paths cannot decide it
    // differently (the shared registry makes a mismatch affect every session on this provider).
    const compat = openAiCompatibilityFor(entry);
    registry.registerProvider(providerName, {
      name: entry.label,
      api: entry.type === 'openai' ? openAiApiFor(entry) : 'anthropic-messages',
      baseUrl: entry.type === 'openai' ? normOpenAiBase(entry.baseUrl || 'https://api.openai.com/v1') : (entry.baseUrl || 'https://api.anthropic.com'),
      apiKey: entry.apiKey ?? undefined,
      headers: { ...APP_IDENTITY_HEADERS },
      models: [...new Set([...entry.models, modelId])].map((m) => modelEntry(providerName, m, windowFor(cfg, entry.id, m), compat)),
    });
    const added = registry.find(providerName, modelId);
    if (added) return added;
  }
  throw new Error(`brain model '${modelId}' not found for provider '${entry.id}'`);
}

/** Claude's OAuth / claude-code endpoint buffers a tool call's input and delivers every `input_json_delta`
 *  in a single burst at the END unless the `fine-grained-tool-streaming` beta is on — and pi-ai only sends
 *  that beta when eager tool streaming is marked UNSUPPORTED (getAnthropicCompat →
 *  shouldUseFineGrainedToolStreamingBeta in the anthropic-messages adapter). With the default (eager = true)
 *  the arguments arrive too late for the authoring spinner, so the model-authored `reason` never shows.
 *  Force eager off for every anthropic-messages model so tool arguments stream incrementally during
 *  authoring. Returns a shallow clone — never mutates the shared registry model. */
function withIncrementalToolStreaming(model: Model<Api>): Model<Api> {
  if (model.api !== 'anthropic-messages') return model;
  // `api === 'anthropic-messages'` doesn't narrow the compat UNION for TS, so read the one flag structurally.
  const compat = model.compat as { supportsEagerToolInputStreaming?: boolean } | undefined;
  if (compat?.supportsEagerToolInputStreaming === false) return model;
  return { ...model, compat: { ...compat, supportsEagerToolInputStreaming: false } } as Model<Api>;
}

export function resolveBrainModelRoute(
  registry: ModelRegistry, cfg: BrainRuntimeConfig, sel?: BrainModelSelection, compactSel?: BrainModelSelection,
): BrainModelRoute {
  // A selection that NAMES a provider is an instruction, not a hint. When that provider is gone — deleted
  // in Settings, absent from a restored backup, or never present in this deployment — the old `?? providers[0]`
  // quietly re-pointed the run at whatever happened to be first in list order, running the dead provider's
  // model id under a different account's credentials and billing. That is unobservable from the outside and
  // surfaces as a surprising invoice, so it fails loudly instead. An ABSENT provider is the other fact —
  // "no preference" — and still resolves to the default below.
  if (sel?.provider && !cfg.providers.some((p) => p.id === sel.provider)) {
    throw new Error(`brain provider '${sel.provider}' is not configured — pick a model that still exists in Settings → Brain`);
  }
  const entry = (sel?.provider ? cfg.providers.find((p) => p.id === sel.provider) : undefined) ?? cfg.providers[0];
  if (!entry) throw new Error('no brain provider configured');
  const providerName = registryProviderName(entry);
  const defaultId = entryDefaultModelId(registry, entry);
  const modelId = sel?.model || defaultId;
  if (!modelId) throw new Error(`brain provider '${entry.id}' has no models configured`);
  const model = withIncrementalToolStreaming(resolveEntryModel(registry, cfg, entry, modelId));
  const compactionFallback = resolveCompactionFallback(registry, cfg, model, providerName, defaultId, compactSel);
  return { providerId: entry.id, model, ...(compactionFallback ? { compactionFallback } : {}) };
}

/** The DISTINCT model that runs PI-owned compaction, or undefined to compact on the chat model itself.
 *  Precedence: (1) the user's chosen compaction model (Account → Auto-compact) wins and may sit on a
 *  DIFFERENT provider — the route's stream wrapper swaps in that provider's own auth; an explicit pick
 *  equal to the chat model routes nothing. (2) Absent a user pick, ChatGPT OAuth still routes compaction
 *  to its configured default model, so summarization never runs on a preview/alias chat descriptor; every
 *  other provider compacts on the selected model. Resolved before the session starts so compaction never
 *  depends on parsing a provider error. Routing is optional AT RESOLUTION: a stale/removed pick or default
 *  must never make a valid chat selection unstartable, so a start-time resolve failure leaves compaction on
 *  the session model. (A fallback that resolves but whose auth fails at compaction time still surfaces PI's
 *  "Summarization failed" — the same failure class as chatting on that provider — it is not caught here.) */
function resolveCompactionFallback(
  registry: ModelRegistry, cfg: BrainRuntimeConfig, model: Model<Api>,
  providerName: string, defaultId: string | undefined, compactSel?: BrainModelSelection,
): Model<Api> | undefined {
  if (compactSel?.provider && compactSel.model) {
    const entry = cfg.providers.find((p) => p.id === compactSel.provider);
    if (entry) {
      try {
        const picked = resolveEntryModel(registry, cfg, entry, compactSel.model);
        return picked.provider === model.provider && picked.id === model.id ? undefined : picked;
      } catch { /* stale pick (provider/model gone) — fall through to the provider default below */ }
    }
  }
  if (model.provider === 'openai-codex' && defaultId && defaultId !== model.id) {
    const candidate = registry.find(providerName, defaultId);
    if (candidate?.provider === model.provider) return candidate;
  }
  return undefined;
}

export function resolveBrainModel(
  registry: ModelRegistry, cfg: BrainRuntimeConfig, sel?: BrainModelSelection,
): Model<Api> {
  return resolveBrainModelRoute(registry, cfg, sel).model;
}
