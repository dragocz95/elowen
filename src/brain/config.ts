import type { ConfigStore } from '../store/configStore.js';
import type { BrainRuntimeConfig, BrainProviderEntry } from './providers.js';
import { OAUTH_BUILTIN } from './providers.js';
import type { BrainCredentialAccess } from './providerUsage.js';
import type { BrainProviderModels } from '../shared/execs.js';

const OAUTH_LABELS: Record<string, string> = {
  'oauth-anthropic': 'Claude account',
  'oauth-github-copilot': 'GitHub Copilot',
  'oauth-openai-codex': 'ChatGPT account',
  'oauth-kimi': 'Kimi account',
};

/** Derive the brain's provider set from Elowen config + connected OAuth accounts. Precedence:
 *  1. dedicated `brain.providers` entries,
 *  2. synthetic entries for connected OAuth accounts that have no explicit entry (connecting an
 *     account in Settings → Brain is enough — its models appear without extra configuration),
 *  3. with neither, the autopilot relay endpoint as a synthetic OpenAI-compatible provider.
 *  Returns null when nothing usable is configured — the brain routes degrade to 503. */
export function brainConfigFromElowen(config: ConfigStore, creds?: BrainCredentialAccess): BrainRuntimeConfig | null {
  // An `oauth-*` entry carries only the account's MODEL SELECTION: buildBrainRegistry registers no
  // provider for those types, because the built-in catalog supplies the models and the stored credential
  // supplies the auth. Disconnecting an account removes just that credential, and the settings grid hides
  // oauth entries by design (the account cards own them) — so without this the entry outlives the account
  // as an unreachable ghost group whose every model 401s. Filter on READ rather than pruning at
  // disconnect: the entry stays available to restore the selection on reconnect, and installs already
  // carrying a stale one heal themselves. With no credential access there is nothing to check against, so
  // the entry passes through unjudged.
  const connected = (p: BrainProviderEntry): boolean =>
    !p.type.startsWith('oauth-') || !creds || !!creds.get(OAUTH_BUILTIN[p.type] ?? '');
  // Stamp each entry's provenance so downstream lists can tell OAuth accounts from API-key endpoints.
  const providers: BrainProviderEntry[] = config.brainProviders().filter(connected).map((p) => ({
    ...p, origin: p.type.startsWith('oauth-') ? 'oauth' as const : 'api-key' as const,
  }));

  if (creds) {
    for (const [type, builtin] of Object.entries(OAUTH_BUILTIN)) {
      if (!creds.get(builtin)) continue;
      if (providers.some((p) => p.type === type)) continue; // an explicit entry wins
      providers.push({
        id: builtin, label: OAUTH_LABELS[type] ?? builtin, type: type as BrainProviderEntry['type'],
        baseUrl: '', models: [], apiKey: null, origin: 'oauth',
      });
    }
  }

  if (providers.length === 0) {
    const s = config.get();
    const apiKey = config.apiKey();
    if (!apiKey || !s.autopilot.apiUrl || !s.autopilot.model) return null;
    providers.push({ id: 'relay', label: 'Relay', type: 'openai', baseUrl: s.autopilot.apiUrl, models: [s.autopilot.model], apiKey, origin: 'relay' });
  }
  return { providers, contextWindows: config.get().brain.modelContextWindows };
}

/**
 * Every brain provider this installation is configured to reach, each with the operator's manual model
 * list — the registry a stored model reference is judged against, and the reason a deleted provider (or a
 * model removed from a surviving provider) stops existing everywhere at once instead of having to be
 * hunted down row by row.
 *
 * Deliberately WIDER than `brain.providers` alone and deliberately narrower than "whatever answered last":
 *  - an explicit entry always counts, even while its OAuth credential is missing or its endpoint is down.
 *    A provider that fails to LOAD is not a provider that was DELETED, and only the second may cost anyone
 *    their configuration. This is the one distinction the whole design rests on, so it is made here rather
 *    than left to each caller.
 *  - a connected OAuth account with NO explicit entry counts too: brainConfigFromElowen serves its models
 *    under that synthetic id, so a picker offers them and the gate has to recognise them or fail closed on
 *    a perfectly valid setup.
 *  - the relay fallback counts on the same grounds.
 *
 * The MODEL list travels with the id for the same reason the id survives a missing credential: an entry
 * whose account is disconnected keeps the list that bounds it, so an outage cannot silently widen the bound
 * to "any model on that provider". An empty list is not "no models" — see `isOfferableBrainModel`.
 *
 * Feed this to `isOfferableExec` / `isExecAllowedForUser` / `isModelVisibleForUser` so the offered set and
 * the enforced set are computed from one source and cannot drift apart.
 */
export function configuredBrainProviders(config: ConfigStore, creds?: BrainCredentialAccess): BrainProviderModels[] {
  const explicit = config.brainProviders().map((p) => ({ id: p.id, models: p.models }));
  const reachable = brainConfigFromElowen(config, creds)?.providers.map((p) => ({ id: p.id, models: p.models })) ?? [];
  const byId = new Map<string, BrainProviderModels>();
  // Explicit entries first and never overwritten: a synthetic OAuth/relay entry only ever ADDS an id that
  // `brain.providers` does not carry, and would otherwise replace a curated list with the full catalogue.
  for (const entry of [...explicit, ...reachable]) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  return [...byId.values()];
}
