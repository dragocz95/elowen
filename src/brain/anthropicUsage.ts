import { record, finite, type ProviderUsage, type UsageAuth, type UsageSource, type UsageWindow } from './providerUsage.js';

const PROVIDER_ID = 'anthropic';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;

/** ISO-8601 timestamp → Unix seconds, or null. Anthropic sends e.g. "2026-07-18T12:30:00.435733+00:00". */
function resetSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1_000) : null;
}

/** One `{ utilization, resets_at }` bucket → unified window. `utilization` is already a 0-100 percent of
 *  the window consumed, so it maps straight onto `usedPercent` (matching the OpenAI/Kimi rails). */
function windowFrom(detail: Record<string, unknown> | null, minutes: number): UsageWindow | null {
  const used = finite(detail?.utilization);
  if (used === null) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMinutes: minutes,
    resetsAt: resetSeconds(detail?.resets_at),
  };
}

/** Parse `GET /api/oauth/usage` into the shared projection: the 5-hour and 7-day (weekly) subscription
 *  windows Anthropic reports for a connected Claude OAuth account. Order (shortest-first) is enforced
 *  centrally by UsageService; a partial response keeps whichever window actually arrived. */
function normalizeAnthropicUsage(value: unknown, fetchedAt: number): ProviderUsage | null {
  const raw = record(value);
  if (!raw) return null;
  const windows = [
    windowFrom(record(raw.five_hour), FIVE_HOUR_MINUTES),
    windowFrom(record(raw.seven_day), WEEKLY_MINUTES),
  ].filter((window): window is UsageWindow => window !== null);
  if (windows.length === 0) return null;
  return { provider: PROVIDER_ID, planType: null, windows, fetchedAt, stale: false };
}

/** Usage source for the connected Claude (Anthropic) OAuth account — its subscription 5h/weekly limits.
 *  The credential carries no account or device id, so the constant provider id is the stable cache key
 *  (one Claude login per daemon). Fetched via the generic {@link UsageService}. */
export const anthropicUsageSource: UsageSource = {
  provider: PROVIDER_ID,
  authKey: PROVIDER_ID,
  cacheKey(auth: UsageAuth): string | null {
    return auth.get(PROVIDER_ID)?.type === 'oauth' ? PROVIDER_ID : null;
  },
  request(accessToken: string) {
    return {
      url: USAGE_URL,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    };
  },
  normalize: normalizeAnthropicUsage,
};
