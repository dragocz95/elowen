import { describe, expect, it, vi } from 'vitest';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { OpenAiCodexUsageService } from '../../src/brain/openaiCodexUsage.js';

const oauth = (accountId = 'acct-1', access = 'oauth-secret') => AuthStorage.inMemory({
  'openai-codex': {
    type: 'oauth', access, refresh: 'refresh-secret', expires: Date.now() + 3_600_000, accountId,
  },
});

const body = (overrides: Record<string, unknown> = {}) => ({
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 1_900_000_000 },
    secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_at: 1_900_500_000 },
  },
  ...overrides,
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});

describe('OpenAiCodexUsageService', () => {
  it('refreshes through AuthStorage, sends the official headers, and normalizes windows by duration', async () => {
    const auth = oauth();
    const key = vi.spyOn(auth, 'getApiKey');
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({
      plan_type: 'team',
      // Deliberately reversed: duration, not the provider field position, determines short vs long.
      rate_limit: {
        primary_window: { used_percent: 140, limit_window_seconds: 604_800, reset_at: 1_900_500_000 },
        secondary_window: { used_percent: -4, limit_window_seconds: 18_000, reset_at: 1_900_000_000 },
      },
      secret_server_field: 'must-not-escape',
    })) as unknown as typeof fetch;
    const service = new OpenAiCodexUsageService({ auth, fetchImpl, now: () => 1234 });

    const usage = await service.getUsage();

    expect(key).toHaveBeenCalledWith('openai-codex', { includeFallback: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(init?.method).toBe('GET');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer oauth-secret');
    expect(headers.get('chatgpt-account-id')).toBe('acct-1');
    expect(usage).toEqual({
      provider: 'openai-codex', planType: 'team', fetchedAt: 1234, stale: false,
      primary: { usedPercent: 0, windowMinutes: 300, resetsAt: 1_900_000_000 },
      secondary: { usedPercent: 100, windowMinutes: 10_080, resetsAt: 1_900_500_000 },
    });
    const safe = JSON.stringify(usage);
    expect(safe).not.toContain('oauth-secret');
    expect(safe).not.toContain('acct-1');
    expect(safe).not.toContain('must-not-escape');
  });

  it('re-reads the account id after getApiKey refreshes the credential', async () => {
    let accountId = 'old-account';
    const auth = {
      get: vi.fn(() => ({
        type: 'oauth' as const, access: 'old', refresh: 'refresh', expires: 0, accountId,
      })),
      getApiKey: vi.fn(async () => { accountId = 'new-account'; return 'refreshed-secret'; }),
    };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(body())) as unknown as typeof fetch;
    const service = new OpenAiCodexUsageService({ auth, fetchImpl });

    await expect(service.getUsage()).resolves.toMatchObject({ stale: false });
    const headers = new Headers(vi.mocked(fetchImpl).mock.calls[0]![1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer refreshed-secret');
    expect(headers.get('chatgpt-account-id')).toBe('new-account');
  });

  it('single-flights an account and serves its successful snapshot from the 60s cache', async () => {
    let now = 1_000;
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(async () => {
      if (vi.mocked(fetchImpl).mock.calls.length === 1) return new Promise<Response>((resolve) => { release = resolve; });
      return json(body());
    }) as unknown as typeof fetch;
    const service = new OpenAiCodexUsageService({ auth: oauth(), fetchImpl, now: () => now });

    const first = service.getUsage();
    const joined = service.getUsage();
    // getApiKey is awaited before the network call, so let that refresh microtask settle first.
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    release(json(body()));
    await expect(Promise.all([first, joined])).resolves.toEqual([
      expect.objectContaining({ fetchedAt: 1_000, stale: false }),
      expect.objectContaining({ fetchedAt: 1_000, stale: false }),
    ]);

    await service.getUsage();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 60_001;
    await service.getUsage();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keys cached data by account id', async () => {
    const auth = oauth('account-a');
    const fetchImpl = vi.fn(async () => json(body())) as unknown as typeof fetch;
    const service = new OpenAiCodexUsageService({ auth, fetchImpl });
    await service.getUsage();
    auth.set('openai-codex', {
      type: 'oauth', access: 'token-b', refresh: 'refresh-b', expires: Date.now() + 3_600_000, accountId: 'account-b',
    });
    await service.getUsage();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondHeaders = new Headers(vi.mocked(fetchImpl).mock.calls[1]![1]?.headers);
    expect(secondHeaders.get('chatgpt-account-id')).toBe('account-b');
  });

  it('returns explicitly stale cached data on transient failure but drops it on auth failure', async () => {
    let now = 10;
    const fetchImpl = vi.fn(async () => json(body())) as unknown as typeof fetch;
    const service = new OpenAiCodexUsageService({ auth: oauth(), fetchImpl, now: () => now, ttlMs: 60_000 });
    const fresh = await service.getUsage();

    now += 60_001;
    vi.mocked(fetchImpl).mockResolvedValueOnce(new Response('', { status: 503 }));
    const stale = await service.getUsage();
    expect(stale).toEqual({ ...fresh, stale: true });

    vi.mocked(fetchImpl).mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(service.getUsage()).resolves.toBeNull();
    vi.mocked(fetchImpl).mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(service.getUsage()).resolves.toBeNull();
  });

  it('accepts a partial window and rejects non-OAuth credentials without making a request', async () => {
    const partialFetch = vi.fn(async () => json({
      plan_type: 'plus',
      rate_limit: { secondary_window: { used_percent: 12.5, limit_window_seconds: 604_800 } },
    })) as unknown as typeof fetch;
    const partial = new OpenAiCodexUsageService({ auth: oauth(), fetchImpl: partialFetch });
    await expect(partial.getUsage()).resolves.toMatchObject({
      primary: null,
      secondary: { usedPercent: 12.5, windowMinutes: 10_080, resetsAt: null },
    });

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const apiKeyAuth = AuthStorage.inMemory({ 'openai-codex': { type: 'api_key', key: 'not-oauth' } });
    const unavailable = new OpenAiCodexUsageService({ auth: apiKeyAuth, fetchImpl });
    await expect(unavailable.getUsage()).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('times out a hung request and falls back to null when no stale snapshot exists', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    const service = new OpenAiCodexUsageService({ auth: oauth(), fetchImpl, timeoutMs: 5 });
    await expect(service.getUsage()).resolves.toBeNull();
  });
});
