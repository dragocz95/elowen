import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { APP_IDENTITY_HEADERS } from '../inference/appIdentity.js';
import type { BrainProviderEntry, BrainRuntimeConfig } from './providers.js';
import { buildBrainRegistry, registryProviderName, OAUTH_BUILTIN, DEFAULT_CONTEXT_WINDOW } from './providers.js';

/** One pickable model for the account UI dropdown, grouped by the provider entry it runs through.
 *  `source` marks how the provider authenticates (OAuth account / API key / relay fallback).
 *  `contextWindow` is the effective max context (operator override for `providerId/model`, else the
 *  default placeholder); `contextWindowSet` tells the UI whether it's a pinned value or the fallback. */
export interface BrainModelOption { provider: string; providerLabel: string; model: string; source: 'api-key' | 'oauth' | 'relay'; contextWindow: number; contextWindowSet: boolean }

const FETCH_TTL_MS = 60_000;
/** One model advertised by an endpoint's /models — its id plus the context window when the provider
 *  reports one (OpenRouter's `context_length`, or `context_window`/`max_context_window` variants). */
interface FetchedModel { id: string; contextWindow?: number }
const cache = new Map<string, { at: number; models: FetchedModel[] }>();

/** Extract a provider-reported context window from a /models entry, trying the common field names.
 *  Returns undefined when the endpoint doesn't advertise one (the OpenAI standard doesn't). */
function reportedContextWindow(m: Record<string, unknown>): number | undefined {
  const top = m.top_provider as Record<string, unknown> | undefined;
  for (const c of [m.context_length, m.context_window, m.max_context_window, m.max_context_length, top?.context_length]) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

/** Model entries advertised by an OpenAI-compatible endpoint (GET {base}/models), each with its
 *  provider-reported context window when present. Cached briefly so the account page doesn't hammer the
 *  upstream. Failures degrade to an empty list (→ the manually configured models). */
async function fetchOpenAiModelEntries(p: BrainProviderEntry, fetchImpl: typeof fetch): Promise<FetchedModel[]> {
  const base = (p.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  // Key by endpoint AND credential — two providers sharing a baseUrl with different keys (or a key
  // change within the TTL) must not serve each other's cached catalog.
  const key = `${base}\u0000${p.apiKey ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FETCH_TTL_MS) return hit.models;
  try {
    const res = await fetchImpl(`${base}/models`, { headers: { ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}), ...APP_IDENTITY_HEADERS } });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Record<string, unknown>[] };
    const models = (body.data ?? [])
      .filter((m) => typeof m.id === 'string' && m.id)
      .map((m) => ({ id: m.id as string, contextWindow: reportedContextWindow(m) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    cache.set(key, { at: Date.now(), models });
    return models;
  } catch { return []; }
}

/** Model ids advertised by an OpenAI-compatible endpoint (drives the provider-add pills + probe). */
export async function fetchOpenAiModels(p: BrainProviderEntry, fetchImpl: typeof fetch): Promise<string[]> {
  return (await fetchOpenAiModelEntries(p, fetchImpl)).map((m) => m.id);
}

/** Clear the /models fetch cache (tests). */
export function clearModelsCache(): void { cache.clear(); }

/** The full built-in pi-ai catalog for one OAuth provider type (e.g. 'oauth-anthropic') — what the
 *  account COULD serve, regardless of any manual selection. Feeds the settings model picker. */
export function oauthBuiltinCatalog(type: string): string[] {
  const builtin = OAUTH_BUILTIN[type];
  if (!builtin) return [];
  const registry = buildBrainRegistry({ providers: [] }, AuthStorage.inMemory());
  return registry.getAll().filter((m) => m.provider === builtin).map((m) => m.id);
}

/** Aggregate the pickable models across every configured provider: manual lists first; `openai`
 *  providers fall back to a live /models fetch when no manual list is set; `oauth-*` providers list
 *  the built-in pi-ai catalog for their upstream. */
export async function listBrainModels(cfg: BrainRuntimeConfig, fetchImpl: typeof fetch = fetch): Promise<BrainModelOption[]> {
  const out: BrainModelOption[] = [];
  // One registry just to read the built-in catalogs for OAuth providers (no auth needed to list).
  const registry = buildBrainRegistry({ providers: [] }, AuthStorage.inMemory());
  for (const p of cfg.providers) {
    // Prefer the endpoint's own /models (it may report per-model context windows) — for BOTH an empty
    // manual list AND a manually-listed openai provider (so a hand-picked model still gets its reported
    // window). The manual list wins on which models appear; the fetch only enriches with context windows.
    let entries: FetchedModel[] = p.models.map((id) => ({ id }));
    if (p.type === 'openai') {
      const fetched = await fetchOpenAiModelEntries(p, fetchImpl);
      if (entries.length === 0) entries = fetched;
      else {
        const ctxById = new Map(fetched.map((f) => [f.id, f.contextWindow]));
        entries = entries.map((e) => ({ id: e.id, contextWindow: ctxById.get(e.id) }));
      }
    } else if (entries.length === 0 && p.type in OAUTH_BUILTIN) {
      const builtin = registryProviderName(p);
      entries = registry.getAll().filter((m) => m.provider === builtin).map((m) => ({ id: m.id }));
    }
    out.push(...entries.map((e) => {
      const pinned = cfg.contextWindows?.[`${p.id}/${e.id}`];
      // Effective context window precedence: operator override → provider-reported → default placeholder.
      const effective = pinned && pinned > 0 ? pinned : (e.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
      return { provider: p.id, providerLabel: p.label, model: e.id, source: p.origin ?? 'api-key' as const, contextWindow: effective, contextWindowSet: !!(pinned && pinned > 0) };
    }));
  }
  return out;
}
