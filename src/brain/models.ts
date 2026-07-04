import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { APP_IDENTITY_HEADERS } from '../inference/appIdentity.js';
import type { BrainProviderEntry, BrainRuntimeConfig } from './providers.js';
import { buildBrainRegistry, registryProviderName, OAUTH_BUILTIN } from './providers.js';

/** One pickable model for the account UI dropdown, grouped by the provider entry it runs through.
 *  `source` marks how the provider authenticates (OAuth account / API key / relay fallback). */
export interface BrainModelOption { provider: string; providerLabel: string; model: string; source: 'api-key' | 'oauth' | 'relay' }

const FETCH_TTL_MS = 60_000;
const cache = new Map<string, { at: number; models: string[] }>();

/** Models advertised by an OpenAI-compatible endpoint (GET {base}/models), cached briefly so the
 *  account page doesn't hammer the upstream. Failures degrade to the manually configured list. */
export async function fetchOpenAiModels(p: BrainProviderEntry, fetchImpl: typeof fetch): Promise<string[]> {
  const base = (p.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  // Key by endpoint AND credential — two providers sharing a baseUrl with different keys (or a key
  // change within the TTL) must not serve each other's cached catalog.
  const key = `${base}\u0000${p.apiKey ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FETCH_TTL_MS) return hit.models;
  try {
    const res = await fetchImpl(`${base}/models`, { headers: { ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}), ...APP_IDENTITY_HEADERS } });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').sort();
    cache.set(key, { at: Date.now(), models });
    return models;
  } catch { return []; }
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
    let models = p.models;
    if (models.length === 0 && p.type === 'openai') models = await fetchOpenAiModels(p, fetchImpl);
    if (models.length === 0 && p.type in OAUTH_BUILTIN) {
      const builtin = registryProviderName(p);
      models = registry.getAll().filter((m) => m.provider === builtin).map((m) => m.id);
    }
    out.push(...models.map((model) => ({ provider: p.id, providerLabel: p.label, model, source: p.origin ?? 'api-key' as const })));
  }
  return out;
}
