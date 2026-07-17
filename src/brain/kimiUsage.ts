import { record, finite, type ProviderUsage, type UsageAuth, type UsageSource, type UsageWindow } from './providerUsage.js';

const PROVIDER_ID = 'kimi-coding';
const USAGE_URL = 'https://api.kimi.com/coding/v1/usages';
// Kimi For Coding's top-level `usage` object carries no window duration; it is the 7-day (weekly) bucket
// the vendor UI labels "Weekly limit". Stamping the minutes lets the rail derive the same "weekly" label
// and show a weekday on the reset, exactly like the OpenAI weekly window.
const WEEKLY_MINUTES = 10_080;

/** Minutes for a Kimi `{ duration, timeUnit }` window descriptor, or null when it is missing/unknown. */
function windowMinutes(win: Record<string, unknown> | null): number | null {
  const duration = finite(win?.duration);
  if (duration === null || duration <= 0) return null;
  switch (win?.timeUnit) {
    case 'TIME_UNIT_SECOND': return duration / 60;
    case 'TIME_UNIT_MINUTE': return duration;
    case 'TIME_UNIT_HOUR': return duration * 60;
    case 'TIME_UNIT_DAY': return duration * 1_440;
    default: return null;
  }
}

/** ISO-8601 timestamp → Unix seconds, or null. Kimi sends e.g. "2026-07-23T16:57:02.493970Z". */
function resetSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1_000) : null;
}

/** One Kimi limit bucket (`{ limit, used, remaining, resetTime }`, numbers as strings) → unified window.
 *  The rail shows how much has been CONSUMED, so `usedPercent = used / limit` (matching the OpenAI rail),
 *  not the remaining percentage the vendor UI happens to draw. */
function windowFrom(detail: Record<string, unknown> | null, minutes: number | null): UsageWindow | null {
  const limit = finite(detail?.limit);
  const used = finite(detail?.used);
  if (limit === null || limit <= 0 || used === null) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, (used / limit) * 100)),
    windowMinutes: minutes,
    resetsAt: resetSeconds(detail?.resetTime),
  };
}

/** Parse `GET /coding/v1/usages` into the shared projection: the weekly bucket (`usage`) plus every
 *  additional window in `limits[]` (e.g. the 5-hour one), ordered shortest-first. */
function normalizeKimiUsage(value: unknown, fetchedAt: number): ProviderUsage | null {
  const raw = record(value);
  if (!raw) return null;
  const windows: UsageWindow[] = [];
  const weekly = windowFrom(record(raw.usage), WEEKLY_MINUTES);
  if (weekly) windows.push(weekly);
  for (const entry of Array.isArray(raw.limits) ? raw.limits : []) {
    const bucket = record(entry);
    if (!bucket) continue;
    const window = windowFrom(record(bucket.detail), windowMinutes(record(bucket.window)));
    if (window) windows.push(window);
  }
  if (windows.length === 0) return null;
  // Window order (shortest-first) is enforced centrally in UsageService.
  const level = record(record(raw.user)?.membership)?.level;
  const planType = typeof level === 'string' && level.trim()
    ? level.replace(/^LEVEL_/, '').toLowerCase().slice(0, 80)
    : null;
  return { provider: PROVIDER_ID, planType, windows, fetchedAt, stale: false };
}

/** Usage source for the connected Kimi For Coding OAuth account. Kimi keeps one device id across token
 *  refreshes, so that id is the stable cache key (one login per daemon). */
export const kimiUsageSource: UsageSource = {
  provider: PROVIDER_ID,
  authKey: PROVIDER_ID,
  cacheKey(auth: UsageAuth): string | null {
    const credential = auth.get(PROVIDER_ID);
    if (credential?.type !== 'oauth') return null;
    const id = (credential as { deviceId?: unknown }).deviceId;
    return typeof id === 'string' && id.trim() ? id.trim() : PROVIDER_ID;
  },
  request(accessToken: string) {
    return {
      url: USAGE_URL,
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
    };
  },
  normalize: normalizeKimiUsage,
};
