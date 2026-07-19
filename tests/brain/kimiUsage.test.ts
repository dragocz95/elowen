import { describe, expect, it, vi } from 'vitest';
import { UsageService, type UsageAuth } from '../../src/brain/providerUsage.js';
import { kimiUsageSource } from '../../src/brain/kimiUsage.js';

const service = (deps: { auth: UsageAuth; fetchImpl?: typeof fetch; now?: () => number }) =>
  new UsageService(kimiUsageSource, deps.auth, { fetchImpl: deps.fetchImpl, now: deps.now });

// Hand-rolled auth: AuthStorage.inMemory has no getApiKey path for the kimi-coding provider, so drive the
// token directly. The credential carries `deviceId` the way Kimi round-trips it.
const oauth = (deviceId = 'device-1', access = 'kimi-secret'): UsageAuth => ({
  get: () => ({ type: 'oauth' as const, access, refresh: 'refresh-secret', expires: Date.now() + 3_600_000, deviceId }) as ReturnType<UsageAuth['get']>,
  getApiKey: async () => access,
});

// The live shape of GET /coding/v1/usages: a weekly `usage` bucket plus a 5-hour window in `limits[]`.
const body = () => ({
  user: { userId: 'u1', membership: { level: 'LEVEL_INTERMEDIATE' } },
  usage: { limit: '100', used: '22', remaining: '78', resetTime: '2026-07-23T16:57:02.493970Z' },
  limits: [{
    window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { limit: '100', used: '49', remaining: '51', resetTime: '2026-07-17T17:57:02.493970Z' },
  }],
  subType: 'TYPE_PURCHASE',
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});

const weekly = Math.floor(Date.parse('2026-07-23T16:57:02.493970Z') / 1_000);
const fiveHour = Math.floor(Date.parse('2026-07-17T17:57:02.493970Z') / 1_000);

describe('kimiUsageSource via UsageService', () => {
  it('sends only the bearer token and maps the weekly + 5h windows shortest-first', async () => {
    const auth = oauth();
    const fetchImpl = vi.fn(async () => json(body())) as unknown as typeof fetch;
    const usage = await service({ auth, fetchImpl, now: () => 1234 }).getUsage();

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe('https://api.kimi.com/coding/v1/usages');
    expect(init?.method).toBe('GET');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer kimi-secret');
    // Kimi's usage endpoint takes no account header — just the token.
    expect(headers.has('chatgpt-account-id')).toBe(false);

    expect(usage).toEqual({
      provider: 'kimi-coding', planType: 'intermediate', fetchedAt: 1234, stale: false,
      windows: [
        // 5h window first (shorter): 49/100 consumed.
        { usedPercent: 49, windowMinutes: 300, resetsAt: fiveHour },
        // weekly window: 22/100 consumed.
        { usedPercent: 22, windowMinutes: 10_080, resetsAt: weekly },
      ],
    });
    // The projection never leaks the token or raw identifiers.
    const safe = JSON.stringify(usage);
    expect(safe).not.toContain('kimi-secret');
    expect(safe).not.toContain('device-1');
  });

  it('returns null for a non-OAuth credential without making a request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const apiKeyAuth: UsageAuth = { get: () => ({ type: 'api_key' as const, key: 'not-oauth' }), getApiKey: async () => 'not-oauth' };
    await expect(service({ auth: apiKeyAuth, fetchImpl }).getUsage()).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drops a window with no usable limit but keeps the rest', async () => {
    const auth = oauth();
    const fetchImpl = vi.fn(async () => json({
      usage: { limit: '0', used: '0' }, // unusable weekly bucket → dropped
      limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '10' } }],
    })) as unknown as typeof fetch;
    const usage = await service({ auth, fetchImpl, now: () => 7 }).getUsage();
    expect(usage).toEqual({
      provider: 'kimi-coding', planType: null, fetchedAt: 7, stale: false,
      windows: [{ usedPercent: 10, windowMinutes: 300, resetsAt: null }],
    });
  });

  it('derives used from remaining when Kimi omits `used` (the 5h window at 0 %)', async () => {
    const auth = oauth();
    // Kimi's live 5h bucket carries only { limit, remaining, resetTime } — no `used` — when untouched.
    const fetchImpl = vi.fn(async () => json({
      usage: { limit: '100', used: '34', remaining: '66', resetTime: '2026-07-23T16:57:02.493970Z' },
      limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '100', resetTime: '2026-07-18T13:57:02.493970Z' } }],
    })) as unknown as typeof fetch;
    const usage = await service({ auth, fetchImpl, now: () => 9 }).getUsage();
    // The 5h window must still appear, at 0 % (100 limit − 100 remaining), not vanish.
    expect(usage?.windows[0]).toEqual({ usedPercent: 0, windowMinutes: 300, resetsAt: Math.floor(Date.parse('2026-07-18T13:57:02.493970Z') / 1_000) });
    expect(usage?.windows[1]?.windowMinutes).toBe(10_080);
  });

  it('caches by device id across refreshes and marks a transient failure stale', async () => {
    let now = 100;
    const fetchImpl = vi.fn(async () => json(body())) as unknown as typeof fetch;
    const svc = service({ auth: oauth(), fetchImpl, now: () => now });
    const fresh = await svc.getUsage();
    await svc.getUsage(); // served from cache, no second fetch
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 60_001;
    vi.mocked(fetchImpl).mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(svc.getUsage()).resolves.toEqual({ ...fresh, stale: true });
  });
});
