import type { AuthStorage } from '@earendil-works/pi-coding-agent';

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/** One subscription limit window in a provider-agnostic shape. `resetsAt` is a Unix timestamp in seconds;
 *  `windowMinutes` drives the rail's duration label (e.g. 300 → "5h", 10080 → "weekly"). */
export interface UsageWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

/** Safe, deliberately small projection of a provider's usage endpoint. It never contains OAuth
 *  credentials, account/device ids, raw response bodies, or request errors. Windows are ordered
 *  shortest-first; a stale snapshot (served after a transient fetch failure) is explicitly marked. */
export interface ProviderUsage {
  provider: string;
  planType: string | null;
  windows: UsageWindow[];
  fetchedAt: number;
  stale: boolean;
}

export type UsageAuth = Pick<AuthStorage, 'get' | 'getApiKey'>;

/** A per-provider adapter: how to key the cache, build the request, and parse the response. The generic
 *  {@link UsageService} owns everything else — TTL cache, single-flight, timeout, and stale-on-error. */
export interface UsageSource {
  /** The pi provider id the active model reports (e.g. 'openai-codex', 'kimi-coding'). */
  readonly provider: string;
  /** AuthStorage credential key this provider's token is stored under. */
  readonly authKey: string;
  /** Stable cache key from the CURRENT credential (account/device id), or null when the provider is not
   *  connected via a usable OAuth credential. Re-read after a refresh so a switched account never reuses
   *  the previous account's cached snapshot. */
  cacheKey(auth: UsageAuth): string | null;
  /** The usage endpoint + request headers for this credential. */
  request(accessToken: string, cacheKey: string): { url: string; headers: Record<string, string> };
  /** Parse the provider's JSON into the unified projection, or null when unusable / entirely empty. */
  normalize(raw: unknown, fetchedAt: number): ProviderUsage | null;
}

export interface UsageServiceDeps {
  fetchImpl?: typeof fetch;
  /** Successful snapshots are fresh for 60 seconds by default. */
  ttlMs?: number;
  /** Hard cap for the usage request; defaults to five seconds. */
  timeoutMs?: number;
  /** Clock injection for deterministic cache tests. */
  now?: () => number;
}

interface CacheEntry { at: number; value: ProviderUsage }

/** True for a value that is a plain (non-array) object. */
export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A finite number, else null — covers both real numbers and providers that send numeric strings. */
export function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) { const n = Number(value); return Number.isFinite(n) ? n : null; }
  return null;
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function copySnapshot(value: ProviderUsage, stale = value.stale): ProviderUsage {
  return { ...value, windows: value.windows.map((w) => ({ ...w })), stale };
}

/** Generic poller for a provider's subscription usage/limits. One instance per provider; the injected
 *  {@link UsageSource} supplies the endpoint, headers and parsing. Callers remain responsible for
 *  checking that the active model actually uses this provider before invoking the service. */
export class UsageService {
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ProviderUsage | null>>();

  constructor(private readonly source: UsageSource, private readonly auth: UsageAuth, deps: UsageServiceDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.ttlMs = Math.max(0, deps.ttlMs ?? DEFAULT_TTL_MS);
    this.timeoutMs = Math.max(1, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.now = deps.now ?? Date.now;
  }

  /** Return a fresh/cached usage snapshot, or null when no usable OAuth account/response exists. */
  async getUsage(): Promise<ProviderUsage | null> {
    const key = this.source.cacheKey(this.auth);
    if (!key) return null;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.ttlMs) return copySnapshot(cached.value);
    const active = this.inFlight.get(key);
    if (active) return active;
    const request = this.request(key).finally(() => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private stale(key: string): ProviderUsage | null {
    const cached = this.cache.get(key);
    return cached ? copySnapshot(cached.value, true) : null;
  }

  private async request(expectedKey: string): Promise<ProviderUsage | null> {
    let key = expectedKey;
    try {
      // PI owns refresh locking and persistence. Re-read the cache key afterwards because a refresh can
      // update both the access token and its decoded account/device id.
      const accessToken = await this.auth.getApiKey(this.source.authKey, { includeFallback: false });
      key = this.source.cacheKey(this.auth) ?? '';
      if (!accessToken || !key) return null;

      // A refresh can switch accounts. Never reuse the old key's cache for the new request.
      if (key !== expectedKey) {
        const current = this.cache.get(key);
        if (current && this.now() - current.at < this.ttlMs) return copySnapshot(current.value);
      }

      const { url, headers } = this.source.request(accessToken, key);
      const response = await this.fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) {
        if (transientStatus(response.status)) return this.stale(key);
        // An authorization failure means the old snapshot is no longer trustworthy for this account.
        if (response.status === 401 || response.status === 403) this.cache.delete(key);
        return null;
      }

      const normalized = this.source.normalize(await response.json(), this.now());
      if (!normalized) return this.stale(key);
      // Enforce the documented shortest-first window order centrally, so a source needn't repeat it.
      normalized.windows.sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity));
      this.cache.set(key, { at: normalized.fetchedAt, value: normalized });
      return copySnapshot(normalized);
    } catch {
      // Fetch/timeout/token-refresh failures are intentionally opaque: callers get an explicitly stale
      // safe projection when possible, never a raw error that might contain credentials or a body dump.
      return this.stale(key || expectedKey);
    }
  }
}
