import { record, finite, type ProviderUsage, type UsageAuth, type UsageSource, type UsageWindow } from './providerUsage.js';

const PROVIDER_ID = 'openai-codex';
const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** Parse one `/wham/usage` window into the unified shape. `resetsAt` is the provider's Unix seconds. */
function rateLimitWindow(value: unknown): UsageWindow | null {
  const raw = record(value);
  if (!raw) return null;
  const used = finite(raw.used_percent);
  if (used === null) return null;
  const seconds = finite(raw.limit_window_seconds);
  const reset = finite(raw.reset_at) ?? finite(raw.resets_at);
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMinutes: seconds !== null && seconds > 0 ? seconds / 60 : null,
    resetsAt: reset !== null && reset > 0 ? reset : null,
  };
}

/** Parse only the documented WHAM fields into the shared projection. OpenAI calls the short window
 *  `primary` and the long one `secondary`; the rail orders windows shortest-first regardless (duration is
 *  the stronger invariant than field position). A partial response keeps the window that actually arrived. */
function normalizeCodexUsage(value: unknown, fetchedAt: number): ProviderUsage | null {
  const raw = record(value);
  const limits = record(raw?.rate_limit);
  if (!raw || !limits) return null;
  // UsageService orders windows shortest-first centrally, so this only needs to collect the present ones.
  const windows = [rateLimitWindow(limits.primary_window), rateLimitWindow(limits.secondary_window)]
    .filter((window): window is UsageWindow => window !== null);
  const plan = typeof raw.plan_type === 'string' ? raw.plan_type.trim().slice(0, 80) : '';
  return { provider: PROVIDER_ID, planType: plan || null, windows, fetchedAt, stale: false };
}

/** Usage source for the connected OpenAI Codex OAuth account — its ChatGPT subscription rate limits.
 *  Fetched via the generic {@link UsageService}; this only supplies the endpoint, headers and parsing. */
export const codexUsageSource: UsageSource = {
  provider: PROVIDER_ID,
  authKey: PROVIDER_ID,
  cacheKey(auth: UsageAuth): string | null {
    const credential = auth.get(PROVIDER_ID);
    if (credential?.type !== 'oauth') return null;
    const id = (credential as { accountId?: unknown }).accountId;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  },
  request(accessToken: string, accountId: string) {
    return {
      url: WHAM_USAGE_URL,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
      },
    };
  },
  normalize: normalizeCodexUsage,
};
