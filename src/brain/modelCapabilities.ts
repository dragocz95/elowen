import type { Model, Api, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { fromRegistryProvider } from '../shared/execs.js';
import { MODEL_CAPABILITY_CATALOG, MODEL_COST_CATALOG, MODEL_VISION_CATALOG, type CatalogCapability, type CatalogCost } from './modelCapabilityData.js';

/**
 * Elowen's one model-capability vocabulary. PI keeps the canonical values stable while providers are
 * free to call the strongest level `xhigh`, `max`, or something else on the wire. User interfaces read
 * the labels from here instead of copying provider-specific guesses into every transport.
 */
export interface ModelCapabilityView {
  reasoning: boolean;
  levels: ModelThinkingLevel[];
  labels: Partial<Record<ModelThinkingLevel, string>>;
}

/** Session request profile for provider-specific payload transforms other than route-owned Fast mode. */
export interface ProviderRequestProfile {
  /** The provider entry's configured sampling temperature, or absent to send no temperature at all.
   *  Absent is the default and must stay that way: a model that accepts only its own default (Kimi K3,
   *  Claude Opus 4.7+) rejects the request outright rather than clamping. */
  temperature?: number;
  /** Rewrite OpenAI's `reasoning_effort` into DashScope's `enable_thinking` + `thinking_budget`, the
   *  documented reasoning knobs of Alibaba's compatible-mode endpoints for Qwen thinking models. Set by
   *  the spawner via {@link qwenThinkingWire}; the payload carries the CURRENT effort each round-trip, so
   *  a live /think change needs no extra plumbing. */
  qwenThinking?: boolean;
}

/** Effort → DashScope `thinking_budget` (max reasoning tokens). The figures are pi-ai's own
 *  effort→budget ladder (`adjustMaxTokensForThinking`), so "medium" buys the same thinking budget on a
 *  Qwen model as it does on a budget-based Claude. Only the levels the Qwen ladder offers appear here;
 *  anything else leaves the payload untouched rather than inventing a budget. */
const QWEN_THINKING_BUDGETS: Readonly<Partial<Record<string, number>>> = { low: 2048, medium: 8192, high: 16384 };

/** Answer allowance assumed when the payload carries no completion cap to lift — pi-ai's own default
 *  `maxTokens` for these models, so the lifted cap matches what pi would have computed itself. */
const QWEN_DEFAULT_ANSWER_TOKENS = 8192;

/** Whether requests for this (endpoint, model) must carry Qwen's DashScope thinking params. Alibaba's
 *  OpenAI compatible-mode (dashscope[-intl].aliyuncs.com, the token-plan endpoints) DOES parse a raw
 *  `reasoning_effort`, but maps it to undocumented server-side budgets (probed 2026-07 on qwen3.7-max:
 *  low→8192, medium→32768, high→unbudgeted) that trip the same `cap > thinking_budget` validation — with
 *  pi-ai's default 8192 cap, native low and medium 400 outright. The documented, deterministic knobs are
 *  `enable_thinking` + `thinking_budget`, so we rewrite onto those instead of passing the effort through.
 *  Other transports keep their own dialects: OpenRouter's `reasoning` object already maps effort onto a
 *  budget for Qwen. */
export function qwenThinkingWire(baseUrl: string, model: string): boolean {
  return /aliyuncs\.com|dashscope/i.test(baseUrl) && /(?:^|\/)(?:qwen|qwq)/i.test(model);
}

/** Pure payload projection used by the provider request hook (kept exportable for a no-network contract
 *  test). Returns the SAME object when nothing applies, so the caller can skip patching entirely. */
export function applyProviderRequestProfile(payload: Record<string, unknown>, profile: ProviderRequestProfile): Record<string, unknown> {
  const withTemperature = profile.temperature !== undefined ? { ...payload, temperature: profile.temperature } : payload;
  const budget = profile.qwenThinking && typeof withTemperature.reasoning_effort === 'string'
    ? QWEN_THINKING_BUDGETS[withTemperature.reasoning_effort]
    : undefined;
  // No effort selected → add nothing: the endpoint's own default thinking behavior stays (an explicit
  // `enable_thinking: false` would 400 on thinking-only models).
  if (budget === undefined) return withTemperature;
  const rewritten: Record<string, unknown> = { ...withTemperature, enable_thinking: true, thinking_budget: budget };
  delete rewritten.reasoning_effort;
  // DashScope requires the completion cap to be STRICTLY greater than `thinking_budget` (else 400:
  // "max_completion_tokens must be greater than thinking_budget"), and pi-ai sized the cap for the
  // answer alone. Mirror pi-ai's own `adjustMaxTokensForThinking`: cap = answer allowance + budget,
  // lifted on whichever cap field pi-ai put on the wire (`compat.maxTokensField` picks exactly one).
  const capField = 'max_completion_tokens' in rewritten ? 'max_completion_tokens'
    : 'max_tokens' in rewritten ? 'max_tokens'
    : 'max_completion_tokens';
  const cap = rewritten[capField];
  const base = typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : QWEN_DEFAULT_ANSWER_TOKENS;
  rewritten[capField] = base + budget;
  return rewritten;
}

type DescriptorPatch = {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  labels?: Partial<Record<ModelThinkingLevel, string>>;
};

export const CANONICAL_THINKING_LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function isCanonicalThinkingLevel(value: string): value is ModelThinkingLevel {
  return (CANONICAL_THINKING_LEVELS as readonly string[]).includes(value);
}

const NON_REASONING = /(?:^|[-_/])(image|embedding|embed|whisper|tts|dall-e|moderation)(?:[-_/]|$)/i;
// OpenRouter and similar catalogs namespace ids (`openai/gpt-5.6-sol`), while direct endpoints use the
// bare id. Match the actual family segment in both forms rather than keying capability to one relay.
const OPENAI_REASONING = /(?:^|\/)(?:gpt-5|o[134](?:-|$))/i;
const CLAUDE_REASONING = /(?:^|\/)claude-(?:opus|sonnet|haiku)-(?:4|5)(?:[.-]|$)/i;
const GEMINI_REASONING = /(?:^|\/)gemini-(?:2\.5|3|3\.1|3\.5)(?:-|$)/i;
// The Qwen generation right after the family name: `qwen3.7-max`, `qwen/qwen3.6-flash`, `qwen3.5:397b`.
// Deliberately not matching `qwen-plus`-style ids — those carry no generation to reason about.
const QWEN_GENERATION = /(?:^|\/)qwen-?(\d+(?:\.\d+)?)/i;
const OTHER_REASONING = /(?:deepseek[-_/]?r1|qwq|reasoning)/i;

/** Catalog keys for endpoints whose name differs from the published one. Ollama Cloud ships as
 *  `ollama-cloud` (a self-hosted Ollama serves the same model families, so it reads the same rows),
 *  Z.AI is published unhyphenated while relays namespace it `z-ai/…`, and Moonshot's two endpoints are
 *  published under names of their own: the generic API as `moonshotai` and the Kimi Code subscription
 *  (PI's `kimi-coding` provider) as `kimi-for-coding`, which serves its own model ids. */
const CATALOG_ALIAS: Readonly<Record<string, string>> = {
  ollama: 'ollama-cloud',
  'ollama-local': 'ollama-cloud',
  'z-ai': 'zai',
  zhipuai: 'zai',
  moonshot: 'moonshotai',
  'kimi-coding': 'kimi-for-coding',
};

const catalogName = (key: string): string => CATALOG_ALIAS[key] ?? key;

/** The row for `<catalog>/<model>`, retried without a tag the catalog does not publish (`glm-5.2:latest`
 *  is still glm-5.2 — the capability is the model's, not the pull's). */
function catalogRow(catalog: string, model: string) {
  const row = MODEL_CAPABILITY_CATALOG[`${catalog}/${model}`];
  if (row !== undefined) return row;
  const untagged = model.includes(':') ? model.slice(0, model.indexOf(':')) : undefined;
  return untagged ? MODEL_CAPABILITY_CATALOG[`${catalog}/${untagged}`] : undefined;
}

/** Every effort ladder the catalog publishes for one bare model name, keyed by that name. Built once,
 *  lazily — a private endpoint is the only reader and most sessions never need it. */
let namedModels: Map<string, CatalogCapability[]> | undefined;
function catalogByName(): Map<string, CatalogCapability[]> {
  if (namedModels) return namedModels;
  namedModels = new Map();
  for (const [key, capability] of Object.entries(MODEL_CAPABILITY_CATALOG)) {
    // The name is the last segment (`openrouter/z-ai/glm-5.2` → `glm-5.2`), minus any pull tag.
    const tail = key.slice(key.lastIndexOf('/') + 1);
    const name = tail.includes(':') ? tail.slice(0, tail.indexOf(':')) : tail;
    const rows = namedModels.get(name);
    if (rows) rows.push(capability); else namedModels.set(name, [capability]);
  }
  return namedModels;
}

/** What every endpoint serving this model agrees on. The same model takes high/max on Z.AI but
 *  high/xhigh through OpenRouter, so with the endpoint unknown only the efforts common to all of them
 *  are safe to offer — anything outside that is a 400 somewhere. Endpoints that publish no ladder at all
 *  cannot narrow one, so they only decide the answer when nobody publishes one. Disagreement about
 *  whether the model reasons at all yields nothing, and the name heuristics get their say instead. */
function agreedCapability(rows: CatalogCapability[]): CatalogCapability | undefined {
  if (rows.some((row) => row === false)) return rows.every((row) => row === false) ? false : undefined;
  const ladders = rows.filter((row): row is readonly ModelThinkingLevel[] => Array.isArray(row));
  if (ladders.length === 0) return true; // reasons everywhere, effort settable nowhere
  return ladders[0]!.filter((level) => ladders.every((ladder) => ladder.includes(level)));
}

/** Find a catalog model name inside an endpoint's own id (`glm-5.2-fp8`, `custom-glm-5.2`). Longest name
 *  wins, and the match may not cut a version short: `gpt-5` inside `gpt-5.3-chat` is a different model,
 *  while a quantisation or vendor suffix is the same one. */
function nameWithin(model: string): CatalogCapability | undefined {
  const id = model.toLowerCase();
  let best: string | undefined;
  for (const name of catalogByName().keys()) {
    if (name.length < 4 || (best && name.length <= best.length)) continue;
    const at = id.indexOf(name);
    if (at < 0) continue;
    const before = at === 0 ? '' : id[at - 1]!;
    const after = id[at + name.length] ?? '';
    if (/[a-z0-9]/.test(before) || /[0-9.]/.test(after)) continue;
    best = name;
  }
  return best ? agreedCapability(catalogByName().get(best)!) : undefined;
}

/** The model's row in the models.dev catalog, or undefined when it lists no such model.
 *  Custom endpoints register under `elowen-<id>`, where `<id>` is the operator's provider key. */
function catalogCapability(provider: string, model: string) {
  const key = fromRegistryProvider(provider);
  const row = catalogRow(catalogName(key), model);
  if (row !== undefined) return row;

  // A private relay is in no catalog under its own name, but it says which upstream it is proxying by
  // namespacing the model (`ollama/glm-5.2`, `z-ai/glm-5.2`) — the same shape OpenRouter publishes. The
  // ladder belongs to the upstream model, so read the upstream's row. Only reached when the relay itself
  // has no row, so a catalog provider (OpenRouter's own `z-ai/glm-5.2`) always keeps its own answer.
  const slash = model.indexOf('/');
  const upstream = slash > 0 ? catalogRow(catalogName(model.slice(0, slash)), model.slice(slash + 1)) : undefined;
  if (upstream !== undefined) return upstream;

  // Neither the endpoint nor an upstream namespace is known: recognise the model by name inside whatever
  // the endpoint chose to call it, and offer only what every endpoint serving it accepts.
  return nameWithin(model);
}

/** A model descriptor's per-token USD rates, in pi-ai's `Model['cost']` shape. */
export interface ModelCost { input: number; output: number; cacheRead: number; cacheWrite: number }

const toCost = (t: CatalogCost): ModelCost => ({ input: t[0], output: t[1], cacheRead: t[2], cacheWrite: t[3] });
const sameCost = (a: CatalogCost, b: CatalogCost): boolean => a.every((n, i) => n === b[i]);

/** The price row for `<catalog>/<model>`, retried without a pull tag the catalog does not carry — the
 *  cost twin of `catalogRow`. */
function costRow(catalog: string, model: string): CatalogCost | undefined {
  const row = MODEL_COST_CATALOG[`${catalog}/${model}`];
  if (row !== undefined) return row;
  const untagged = model.includes(':') ? model.slice(0, model.indexOf(':')) : undefined;
  return untagged ? MODEL_COST_CATALOG[`${catalog}/${untagged}`] : undefined;
}

let costNamedModels: Map<string, CatalogCost[]> | undefined;
function costByName(): Map<string, CatalogCost[]> {
  if (costNamedModels) return costNamedModels;
  costNamedModels = new Map();
  for (const [key, cost] of Object.entries(MODEL_COST_CATALOG)) {
    const tail = key.slice(key.lastIndexOf('/') + 1);
    const name = tail.includes(':') ? tail.slice(0, tail.indexOf(':')) : tail;
    const rows = costNamedModels.get(name);
    if (rows) rows.push(cost); else costNamedModels.set(name, [cost]);
  }
  return costNamedModels;
}

/** The price to attribute to a bare model name matched only by `nameWithin`. Unlike a reasoning ladder,
 *  a price has no safe intersection: providers charge different amounts for the same model, and the
 *  endpoint fronting it here (a proxy of unknown billing) may match none of them. So a name-only match
 *  yields a price ONLY when every catalogued endpoint agrees on it exactly — then the figure is reliable
 *  whichever one the proxy really uses. Any disagreement leaves the model unpriced rather than guessed. */
function costWithin(model: string): CatalogCost | undefined {
  const id = model.toLowerCase();
  let best: string | undefined;
  for (const name of costByName().keys()) {
    if (name.length < 4 || (best && name.length <= best.length)) continue;
    const at = id.indexOf(name);
    if (at < 0) continue;
    const before = at === 0 ? '' : id[at - 1]!;
    const after = id[at + name.length] ?? '';
    if (/[a-z0-9]/.test(before) || /[0-9.]/.test(after)) continue;
    best = name;
  }
  if (!best) return undefined;
  const rows = costByName().get(best)!;
  // An all-zero row is the catalog's way of recording a flat-rate subscription, not a rival per-token
  // price, so it must not veto a figure the metered endpoints agree on: NVIDIA listing kimi-k3 at zero
  // would otherwise unprice a model three paid endpoints publish identically — leaving exactly the $0
  // this function exists to avoid. Zero rows only decide the answer when every endpoint is flat-rate.
  const metered = rows.filter((row) => row.some((rate) => rate > 0));
  const agreed = metered.length > 0 ? metered : rows;
  return agreed.every((row) => sameCost(row, agreed[0]!)) ? agreed[0] : undefined;
}

/** The estimated per-token cost for a (provider, model) from the models.dev catalog, or undefined when it
 *  lists no matching price. The cost twin of `catalogCapability`, resolved through the identical three
 *  tiers (exact endpoint row → upstream namespace → agreed name match) so a proxy model is priced exactly
 *  where its capability is recognised. Only an ESTIMATE: a provider-reported cost (the OpenRouter meter)
 *  overrides it downstream, and a miss leaves pi-ai's own $0, never inventing a figure. */
export function catalogModelCost(provider: string, model: string): ModelCost | undefined {
  if (provider === 'openai-codex') return undefined; // ChatGPT's own catalog, not models.dev
  const key = fromRegistryProvider(provider);
  const direct = costRow(catalogName(key), model);
  if (direct !== undefined) return toCost(direct);
  const slash = model.indexOf('/');
  const upstream = slash > 0 ? costRow(catalogName(model.slice(0, slash)), model.slice(slash + 1)) : undefined;
  if (upstream !== undefined) return toCost(upstream);
  const named = costWithin(model);
  return named !== undefined ? toCost(named) : undefined;
}

/** The vision row for `<catalog>/<model>`, retried without a pull tag — the vision twin of `costRow`. */
function visionRow(catalog: string, model: string): boolean | undefined {
  const row = MODEL_VISION_CATALOG[`${catalog}/${model}`];
  if (row !== undefined) return row;
  const untagged = model.includes(':') ? model.slice(0, model.indexOf(':')) : undefined;
  return untagged ? MODEL_VISION_CATALOG[`${catalog}/${untagged}`] : undefined;
}

let visionNamedModels: Map<string, boolean[]> | undefined;
function visionByName(): Map<string, boolean[]> {
  if (visionNamedModels) return visionNamedModels;
  visionNamedModels = new Map();
  for (const [key, vision] of Object.entries(MODEL_VISION_CATALOG)) {
    const tail = key.slice(key.lastIndexOf('/') + 1);
    const name = tail.includes(':') ? tail.slice(0, tail.indexOf(':')) : tail;
    const rows = visionNamedModels.get(name);
    if (rows) rows.push(vision); else visionNamedModels.set(name, [vision]);
  }
  return visionNamedModels;
}

/** Vision for a bare model name matched only by `nameWithin` — yielded ONLY when every catalogued endpoint
 *  agrees, so a proxy of unknown provenance is never told a model is text-only on a split vote. */
function visionWithin(model: string): boolean | undefined {
  const id = model.toLowerCase();
  let best: string | undefined;
  for (const name of visionByName().keys()) {
    if (name.length < 4 || (best && name.length <= best.length)) continue;
    const at = id.indexOf(name);
    if (at < 0) continue;
    const before = at === 0 ? '' : id[at - 1]!;
    const after = id[at + name.length] ?? '';
    if (/[a-z0-9]/.test(before) || /[0-9.]/.test(after)) continue;
    best = name;
  }
  if (!best) return undefined;
  const rows = visionByName().get(best)!;
  return rows.every((v) => v === rows[0]) ? rows[0] : undefined;
}

/** Whether the catalog KNOWS this (provider, model) accepts image input: `true` (vision), `false`
 *  (text-only), or `undefined` (not catalogued). Resolved through the same three tiers as cost/capability
 *  (exact endpoint row → upstream namespace → agreed name match). The vision twin of `catalogModelCost`. */
export function catalogModelVision(provider: string, model: string): boolean | undefined {
  if (provider === 'openai-codex') return undefined; // ChatGPT's own catalog, not models.dev
  const key = fromRegistryProvider(provider);
  const direct = visionRow(catalogName(key), model);
  if (direct !== undefined) return direct;
  const slash = model.indexOf('/');
  const upstream = slash > 0 ? visionRow(catalogName(model.slice(0, slash)), model.slice(slash + 1)) : undefined;
  if (upstream !== undefined) return upstream;
  return visionWithin(model);
}

/** Turn an accepted effort ladder into PI's map: a level the endpoint does not accept is `null`
 *  (unsupported), and `off` is never an effort — a reasoning model always thinks. */
function ladderToMap(levels: readonly ModelThinkingLevel[]): ThinkingLevelMap {
  const map: ThinkingLevelMap = {
    off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
  };
  for (const level of levels) map[level] = level;
  return map;
}

/**
 * Capability rules for descriptors Elowen creates itself (custom OpenAI-compatible endpoints and
 * OAuth catalog additions). Built-in PI descriptors remain authoritative; these rules prevent the old
 * blanket "every model supports every effort" declaration for unknown/image models.
 *
 * The families below (Codex, OpenAI, Claude, Gemini, Qwen) keep their hand-written rules: they encode
 * decisions the catalog does not model, such as normalizing `minimal` onto the wire's `low` or mapping the
 * effort onto Qwen's `thinking_budget`, and the endpoints behind them are the ones we exercise daily.
 * Everything else — GLM, MiniMax, Kimi, gpt-oss and the
 * rest — is answered from the models.dev catalog, because which efforts an endpoint accepts is per-endpoint
 * data, not a property of the name: `glm-5.2` takes high/max on Z.AI but high/xhigh through OpenRouter, so
 * a name pattern could only guess, and over-advertising an effort is a request-breaking 400. A model the
 * catalog explicitly says does not reason (a chat or speech variant whose name apes its reasoning sibling)
 * overrules every pattern, and an id nobody recognises is still refused rather than guessed.
 */
export function descriptorCapabilities(provider: string, model: string): DescriptorPatch {
  // Codex OAuth is not a models.dev endpoint (its catalog is ChatGPT's own), so it never consults it.
  const catalog = provider === 'openai-codex' ? undefined : catalogCapability(provider, model);
  if (catalog === false) return { reasoning: false };
  // The name check only decides what the catalog cannot: a modality in the name is a good guess that the
  // model does not reason, but it is only a guess — a catalogued vision model that reasons keeps its answer.
  if (catalog === undefined && NON_REASONING.test(model)) return { reasoning: false };

  if (provider === 'openai-codex' || OPENAI_REASONING.test(model)) {
    const supportsMax = /(?:^|\/)gpt-5\.6(?:-|$)/i.test(model);
    return {
      reasoning: true,
      // ChatGPT Codex accepts low/medium/high/xhigh; GPT-5.6 adds the distinct `max` level. `minimal`
      // is normalized to low by the upstream catalog. The UI calls xhigh "ultra" while PI retains its
      // stable canonical id internally, leaving the stronger 5.6 level visibly named "max".
      thinkingLevelMap: {
        off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh',
        max: supportsMax ? 'max' : null,
      },
      labels: { xhigh: 'ultra' },
    };
  }

  if (CLAUDE_REASONING.test(model)) {
    // Anthropic's 4.6 tier adds `max`; 4.7+ (and generation 5) additionally expose xhigh. Keep the
    // two distinct instead of assuming every model with max also accepts xhigh.
    const supportsMax = /-(?:4[.-][678]|5)(?:[.-]|$)/i.test(model);
    const supportsXhigh = /-(?:4[.-][78]|5)(?:[.-]|$)/i.test(model);
    return {
      reasoning: true,
      thinkingLevelMap: {
        off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high',
        xhigh: supportsXhigh ? 'xhigh' : null,
        max: supportsMax ? 'max' : null,
      },
    };
  }

  if (GEMINI_REASONING.test(model)) {
    return {
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    };
  }

  // Qwen's thinking models publish no effort ladder in models.dev — their wire knob is DashScope's
  // `thinking_budget` (or OpenRouter's `reasoning` object), never `reasoning_effort` — so the catalog can
  // only say "reasons, effort not settable" (`true`). Elowen DOES make the effort settable: the request
  // layer maps low/medium/high onto the wire the endpoint honors (see applyProviderRequestProfile), so a
  // Qwen model the catalog says reasons gets that ladder, and an id too new for the catalog
  // (qwen3.8-max-preview) is recognised by generation — every 3.5+ release reasons. A catalogued
  // non-reasoning Qwen (a coder/instruct sibling, `catalog === false`) was already refused above, and an
  // endpoint that publishes an explicit ladder keeps its own answer.
  //
  // `catalog` may have been matched by NAME against a different endpoint (`nameWithin`), and a ladder
  // is not portable that way: OpenRouter publishes minimal/xhigh for qwen3.8-max because its own
  // `reasoning` object accepts them, while the same efforts on DashScope have no `thinking_budget` to
  // map onto and would ride out as a raw `reasoning_effort` the endpoint never documented. Only a
  // ladder on THIS endpoint's own row may override the family one.
  const ownRow = catalogRow(catalogName(fromRegistryProvider(provider)), model);
  const qwen = QWEN_GENERATION.exec(model);
  const qwenReasons = catalog === true || Array.isArray(catalog) || (catalog === undefined && Number(qwen?.[1]) >= 3.5);
  if (qwen && !Array.isArray(ownRow) && qwenReasons) {
    return {
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    };
  }

  if (catalog !== undefined) {
    return {
      reasoning: true,
      // `true` means the model reasons but exposes no effort knob (a bare on/off toggle): every level is
      // unsupported, so no UI offers one and no request carries a `reasoning_effort` it would reject.
      thinkingLevelMap: ladderToMap(catalog === true ? [] : catalog),
    };
  }

  // Last resort for an id nothing recognises but whose name still announces a reasoning model.
  if (OTHER_REASONING.test(model)) {
    return {
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    };
  }

  // Unknown custom endpoints are conservative: advertising reasoning_effort to a plain chat model is a
  // request-breaking 400. Operators still get native metadata for every built-in OAuth model.
  return { reasoning: false };
}

/** Capability view when a custom endpoint advertised a model through `/models` but it has not been
 *  registered in PI's in-memory catalog. This keeps dynamically discovered known families useful while
 *  preserving the conservative non-reasoning result for an unknown id. */
export function inferredModelCapabilities(provider: string, model: string): ModelCapabilityView {
  const rule = descriptorCapabilities(provider, model);
  const levels = rule.reasoning
    ? CANONICAL_THINKING_LEVELS.filter((level) => {
        const mapped = rule.thinkingLevelMap?.[level];
        if (mapped === null) return false;
        return level === 'xhigh' || level === 'max' ? mapped !== undefined : true;
      })
    : [];
  return { reasoning: rule.reasoning, levels, labels: rule.labels ?? {} };
}

/** Read-only capability view for a fully resolved model descriptor. */
export function modelCapabilities(model: Model<Api>): ModelCapabilityView {
  const inferred = inferredModelCapabilities(model.provider, model.id);
  const reasoning = !!model.reasoning;
  return {
    reasoning,
    levels: reasoning ? getSupportedThinkingLevels(model) : [],
    labels: inferred.labels,
  };
}

/** Accept provider-facing aliases without leaking them into PI's canonical session state. */
export function canonicalThinkingLevel(model: Model<Api>, value: string): string {
  const normalized = value.trim().toLowerCase();
  const caps = modelCapabilities(model);
  for (const level of caps.levels) {
    if ((caps.labels[level] ?? level).toLowerCase() === normalized) return level;
  }
  return normalized;
}
