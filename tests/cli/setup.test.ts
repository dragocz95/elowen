import { describe, it, expect } from 'vitest';
import { isFirstRun, buildSetupPlan, applySetup, type SetupAnswers } from '../../src/cli/setup.js';

const answers: SetupAnswers = {
  username: 'admin', password: 'sekret',
  llm: { apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' },
};

describe('cli/setup.buildSetupPlan', () => {
  it('maps wizard answers to the user body and a BRAIN provider — the assistant\'s own model access', () => {
    const plan = buildSetupPlan(answers);
    expect(plan.user).toEqual({ username: 'admin', password: 'sekret' });
    // It used to write `autopilot` (the mission relay): on an install that ships no mission subsystem
    // that configured nothing and left the assistant itself with no provider to answer from.
    expect(plan.config).toEqual({
      brain: { providers: [{ id: 'default', label: 'Default', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini'], apiKey: 'sk-test' }] },
    });
    expect(plan.config).not.toHaveProperty('autopilot');
  });

  it('omits the apiKey from the patch when left blank (a keyless local endpoint stays keyless)', () => {
    const plan = buildSetupPlan({ ...answers, llm: { ...answers.llm!, apiKey: '' } });
    expect(plan.config.brain?.providers[0]).not.toHaveProperty('apiKey');
    expect(plan.config.brain?.providers[0]?.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('writes no config at all when the install named no provider', () => {
    const plan = buildSetupPlan({ username: 'admin', password: 'sekret' });
    expect(plan.config).toEqual({});
  });
});

describe('cli/setup.isFirstRun', () => {
  it('is true when the daemon reports needsSetup', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ needsSetup: true }), { status: 200 });
    expect(await isFirstRun(fetchFn, 'http://x')).toBe(true);
  });
  it('is false otherwise', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ needsSetup: false }), { status: 200 });
    expect(await isFirstRun(fetchFn, 'http://x')).toBe(false);
  });
});

describe('cli/setup.applySetup', () => {
  const fakeFetch = (calls: { url: string; method: string; auth?: string; body?: unknown }[]) => (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', auth: (init?.headers as Record<string, string>)?.authorization, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith('/users')) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    if (url.endsWith('/auth/login')) return new Response(JSON.stringify({ token: 'TKN' }), { status: 200 });
    if (url.endsWith('/config')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;

  it('creates the admin, logs in, and PUTs config with the bearer token', async () => {
    const calls: { url: string; method: string; auth?: string; body?: unknown }[] = [];
    await applySetup(fakeFetch(calls), 'http://x', buildSetupPlan(answers));

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://x/users', 'POST http://x/auth/login', 'PUT http://x/config',
    ]);
    const cfg = calls[2]!;
    expect(cfg.auth).toBe('Bearer TKN');
    expect(cfg.body).toEqual({ brain: { providers: [{ id: 'default', label: 'Default', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini'], apiKey: 'sk-test' }] } });
  });

  it('creates the admin and stops there when there is nothing to configure (no empty PUT)', async () => {
    const calls: { url: string; method: string }[] = [];
    await applySetup(fakeFetch(calls), 'http://x', buildSetupPlan({ username: 'admin', password: 'sekret' }));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST http://x/users', 'POST http://x/auth/login']);
  });
});
