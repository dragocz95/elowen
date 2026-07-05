import type { AuthStorage } from '@earendil-works/pi-coding-agent';
import type { ConfigStore } from '../store/configStore.js';
import type { BrainRuntimeConfig, BrainProviderEntry } from './providers.js';
import { OAUTH_BUILTIN } from './providers.js';

const OAUTH_LABELS: Record<string, string> = {
  'oauth-anthropic': 'Claude account',
  'oauth-github-copilot': 'GitHub Copilot',
  'oauth-openai-codex': 'ChatGPT account',
};

/** Derive the brain's provider set from Orca config + connected OAuth accounts. Precedence:
 *  1. dedicated `brain.providers` entries,
 *  2. synthetic entries for connected OAuth accounts that have no explicit entry (connecting an
 *     account in Settings → Brain is enough — its models appear without extra configuration),
 *  3. with neither, the autopilot relay endpoint as a synthetic OpenAI-compatible provider.
 *  Returns null when nothing usable is configured — the brain routes degrade to 503. */
export function brainConfigFromOrca(config: ConfigStore, authStorage?: AuthStorage): BrainRuntimeConfig | null {
  // Stamp each entry's provenance so downstream lists can tell OAuth accounts from API-key endpoints.
  const providers: BrainProviderEntry[] = config.brainProviders().map((p) => ({
    ...p, origin: p.type.startsWith('oauth-') ? 'oauth' as const : 'api-key' as const,
  }));

  if (authStorage) {
    for (const [type, builtin] of Object.entries(OAUTH_BUILTIN)) {
      if (!authStorage.get(builtin)) continue;
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
