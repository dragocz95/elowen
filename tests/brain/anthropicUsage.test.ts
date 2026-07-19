import { describe, expect, it, vi } from 'vitest';
import { UsageService, type UsageAuth } from '../../src/brain/providerUsage.js';
import { anthropicUsageSource } from '../../src/brain/anthropicUsage.js';

const service = (deps: { auth: UsageAuth; fetchImpl?: typeof fetch; now?: () => number }) =>
  new UsageService(anthropicUsageSource, deps.auth, { fetchImpl: deps.fetchImpl, now: deps.now });

// The Anthropic OAuth credential carries no account/device id — just the oauth token.
const oauth = (access = 'anthropic-secret'): UsageAuth => ({
  get: () => ({ type: 'oauth' as const, access, refresh: 'refresh-secret', expires: Date.now() + 3_600_000 }) as ReturnType<UsageAuth['get']>,
  getApiKey: async () => access,
});

// The live shape of GET /api/oauth/usage: five_hour + seven_day utilization buckets (percent already 0-100).
const body = () => ({
  five_hour: { utilization: 5, resets_at: '2026-07-18T12:30:00.435733+00:00', limit_dollars: null },
  seven_day: { utilization: 20, resets_at: '2026-07-21T00:00:00.435755+00:00', limit_dollars: null },
  limits: [{ kind: 'session', group: 'session', percent: 5 }],
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});

const fiveHour = Math.floor(Date.parse('2026-07-18T12:30:00.435733+00:00') / 1_000);
const weekly = Math.floor(Date.parse('2026-07-21T00:00:00.435755+00:00') / 1_000);

describe('anthropicUsageSource via UsageService', () => {
  it('sends the oauth bearer + beta header and maps the 5h + weekly windows shortest-first', async () => {
    const auth = oauth();
    const fetchImpl = vi.fn(async () => json(body())) as unknown as typeof fetch;
    const usage = await service({ auth, fetchImpl, now: () => 1234 }).getUsage();

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(init?.method).toBe('GET');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer anthropic-secret');
    expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20');

    expect(usage).toEqual({
      provider: 'anthropic', planType: null, fetchedAt: 1234, stale: false,
      windows: [
        { usedPercent: 5, windowMinutes: 300, resetsAt: fiveHour },
        { usedPercent: 20, windowMinutes: 10_080, resetsAt: weekly },
      ],
    });
    // The projection never leaks the token.
    expect(JSON.stringify(usage)).not.toContain('anthropic-secret');
  });

  it('returns null for a non-OAuth credential without making a request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const apiKeyAuth: UsageAuth = { get: () => ({ type: 'api_key' as const, key: 'not-oauth' }), getApiKey: async () => 'not-oauth' };
    await expect(service({ auth: apiKeyAuth, fetchImpl }).getUsage()).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps whichever window is present when the other is missing', async () => {
    const auth = oauth();
    const fetchImpl = vi.fn(async () => json({ seven_day: { utilization: 42, resets_at: '2026-07-21T00:00:00Z' } })) as unknown as typeof fetch;
    const usage = await service({ auth, fetchImpl, now: () => 7 }).getUsage();
    expect(usage).toEqual({
      provider: 'anthropic', planType: null, fetchedAt: 7, stale: false,
      windows: [{ usedPercent: 42, windowMinutes: 10_080, resetsAt: Math.floor(Date.parse('2026-07-21T00:00:00Z') / 1_000) }],
    });
  });

  it('clamps utilization into 0-100 and tolerates a missing reset', async () => {
    const auth = oauth();
    const fetchImpl = vi.fn(async () => json({ five_hour: { utilization: 130 }, seven_day: { utilization: -4 } })) as unknown as typeof fetch;
    const usage = await service({ auth, fetchImpl, now: () => 1 }).getUsage();
    expect(usage?.windows).toEqual([
      { usedPercent: 100, windowMinutes: 300, resetsAt: null },
      { usedPercent: 0, windowMinutes: 10_080, resetsAt: null },
    ]);
  });
});
