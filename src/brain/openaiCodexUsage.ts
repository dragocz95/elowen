import type { AuthStorage } from '@earendil-works/pi-coding-agent';

const PROVIDER_ID = 'openai-codex';
const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/** One OpenAI subscription limit window. `resetsAt` is the provider's Unix timestamp in seconds. */
interface OpenAiCodexRateLimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

/** Safe, deliberately small projection of `/wham/usage`. It never contains OAuth credentials,
 *  account ids, raw response bodies, or request errors. A stale snapshot is explicitly marked. */
export interface OpenAiCodexUsage {
  provider: 'openai-codex';
  planType: string | null;
  primary: OpenAiCodexRateLimitWindow | null;
  secondary: OpenAiCodexRateLimitWindow | null;
  fetchedAt: number;
  stale: boolean;
}

type UsageAuth = Pick<AuthStorage, 'get' | 'getApiKey'>;

export interface OpenAiCodexUsageDeps {
  auth: UsageAuth;
  fetchImpl?: typeof fetch;
  /** Successful snapshots are fresh for 60 seconds by default. */
  ttlMs?: number;
  /** Hard cap for the WHAM request; defaults to five seconds. */
  timeoutMs?: number;
  /** Clock injection for deterministic cache tests. */
  now?: () => number;
}

interface CacheEntry { at: number; value: OpenAiCodexUsage }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rateLimitWindow(value: unknown): OpenAiCodexRateLimitWindow | null {
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

/** Parse only the documented WHAM fields. OpenAI currently calls the short window `primary` and the
 *  long window `secondary`; if both arrive reversed, duration is the stronger invariant, so normalize
 *  the shorter one to primary. A partial response retains the field that actually arrived. */
function normalizeUsage(value: unknown, fetchedAt: number): OpenAiCodexUsage | null {
  const raw = record(value);
  const limits = record(raw?.rate_limit);
  if (!raw || !limits) return null;
  let primary = rateLimitWindow(limits.primary_window);
  let secondary = rateLimitWindow(limits.secondary_window);
  if (
    primary?.windowMinutes !== null && primary?.windowMinutes !== undefined
    && secondary?.windowMinutes !== null && secondary?.windowMinutes !== undefined
    && primary.windowMinutes > secondary.windowMinutes
  ) {
    [primary, secondary] = [secondary, primary];
  }
  const plan = typeof raw.plan_type === 'string' ? raw.plan_type.trim().slice(0, 80) : '';
  return {
    provider: PROVIDER_ID,
    planType: plan || null,
    primary,
    secondary,
    fetchedAt,
    stale: false,
  };
}

function copySnapshot(value: OpenAiCodexUsage, stale = value.stale): OpenAiCodexUsage {
  return {
    ...value,
    primary: value.primary ? { ...value.primary } : null,
    secondary: value.secondary ? { ...value.secondary } : null,
    stale,
  };
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Fetches ChatGPT subscription rate limits for the currently connected OpenAI Codex OAuth account.
 *  Callers remain responsible for checking that the active model/provider is OAuth-backed before
 *  invoking this service; the service itself additionally refuses non-OAuth credentials. */
export class OpenAiCodexUsageService {
  private readonly auth: UsageAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<OpenAiCodexUsage | null>>();

  constructor(deps: OpenAiCodexUsageDeps) {
    this.auth = deps.auth;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.ttlMs = Math.max(0, deps.ttlMs ?? DEFAULT_TTL_MS);
    this.timeoutMs = Math.max(1, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.now = deps.now ?? Date.now;
  }

  /** Return a fresh/cached usage snapshot, or null when no usable OAuth account/response exists. */
  async getUsage(): Promise<OpenAiCodexUsage | null> {
    const accountId = this.accountId();
    if (!accountId) return null;
    const cached = this.cache.get(accountId);
    if (cached && this.now() - cached.at < this.ttlMs) return copySnapshot(cached.value);
    const active = this.inFlight.get(accountId);
    if (active) return active;

    const request = this.request(accountId).finally(() => {
      if (this.inFlight.get(accountId) === request) this.inFlight.delete(accountId);
    });
    this.inFlight.set(accountId, request);
    return request;
  }

  private accountId(): string | null {
    const credential = this.auth.get(PROVIDER_ID);
    if (credential?.type !== 'oauth') return null;
    const id = credential.accountId;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  }

  private stale(accountId: string): OpenAiCodexUsage | null {
    const cached = this.cache.get(accountId);
    return cached ? copySnapshot(cached.value, true) : null;
  }

  private async request(expectedAccountId: string): Promise<OpenAiCodexUsage | null> {
    let accountId = expectedAccountId;
    try {
      // PI owns refresh locking and persistence. Re-read the credential afterwards because a refresh
      // can update both the access token and its decoded ChatGPT account id.
      const accessToken = await this.auth.getApiKey(PROVIDER_ID, { includeFallback: false });
      accountId = this.accountId() ?? '';
      if (!accessToken || !accountId) return null;

      // A refresh can switch accounts. Never reuse the old account's cache for the new header.
      if (accountId !== expectedAccountId) {
        const current = this.cache.get(accountId);
        if (current && this.now() - current.at < this.ttlMs) return copySnapshot(current.value);
      }

      const response = await this.fetchImpl(WHAM_USAGE_URL, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'chatgpt-account-id': accountId,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        if (transientStatus(response.status)) return this.stale(accountId);
        // An authorization failure means the old snapshot is no longer trustworthy for this account.
        if (response.status === 401 || response.status === 403) this.cache.delete(accountId);
        return null;
      }

      const normalized = normalizeUsage(await response.json(), this.now());
      if (!normalized) return this.stale(accountId);
      this.cache.set(accountId, { at: normalized.fetchedAt, value: normalized });
      return copySnapshot(normalized);
    } catch {
      // Fetch/timeout/token-refresh failures are intentionally opaque: callers get an explicitly stale
      // safe projection when possible, never a raw error that might contain credentials or a body dump.
      return this.stale(accountId || expectedAccountId);
    }
  }
}
