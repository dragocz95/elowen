import { describe, it, expect } from 'vitest';
import { isFirstRun, buildSetupPlan, applySetup, defaultExecForCli, type SetupAnswers } from '../../src/cli/setup.js';

const answers: SetupAnswers = {
  username: 'admin', password: 'sekret',
  apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o-mini',
};

describe('cli/setup.buildSetupPlan', () => {
  it('maps wizard answers to the user body and the config patch', () => {
    const plan = buildSetupPlan(answers);
    expect(plan.user).toEqual({ username: 'admin', password: 'sekret' });
    expect(plan.config).toEqual({ autopilot: { model: 'gpt-4o-mini', apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' } });
  });
  it('omits the apiKey from the patch when left blank', () => {
    const plan = buildSetupPlan({ ...answers, apiKey: '' });
    expect(plan.config.autopilot).not.toHaveProperty('apiKey');
  });
  it('builds a CLI-engine patch (pilot + overseer exec, no API key) when pilotExec is set', () => {
    const plan = buildSetupPlan({ ...answers, pilotExec: 'codex:gpt-5.5' });
    // The CLI-engine execs are agents-plugin config since wave 2 — no autopilot patch at all.
    expect(plan.config).toEqual({ agents: { pilotExec: 'codex:gpt-5.5', overseerExec: 'codex:gpt-5.5' } });
    expect(plan.config).not.toHaveProperty('autopilot');
  });
});

describe('cli/setup.defaultExecForCli', () => {
  it('maps each agent CLI to a well-formed exec spec', () => {
    expect(defaultExecForCli('claude')).toBe('claude:sonnet');
    expect(defaultExecForCli('codex')).toBe('codex:gpt-5.5');
    expect(defaultExecForCli('opencode', 'ollama-cloud/glm-5.2')).toBe('opencode:ollama-cloud/glm-5.2');
  });
  it('falls back to the default opencode model and rejects unknown CLIs', () => {
    expect(defaultExecForCli('opencode')).toMatch(/^opencode:.+/);
    expect(defaultExecForCli('nope')).toBe('');
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
  it('creates the admin, logs in, and PUTs config with the bearer token', async () => {
    const calls: { url: string; method: string; auth?: string; body?: unknown }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', auth: (init?.headers as Record<string, string>)?.authorization, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith('/users')) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      if (url.endsWith('/auth/login')) return new Response(JSON.stringify({ token: 'TKN' }), { status: 200 });
      if (url.endsWith('/config')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    await applySetup(fetchFn, 'http://x', buildSetupPlan(answers));

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://x/users', 'POST http://x/auth/login', 'PUT http://x/config',
    ]);
    const cfg = calls[2]!;
    expect(cfg.auth).toBe('Bearer TKN');
    expect(cfg.body).toEqual({ autopilot: { model: 'gpt-4o-mini', apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' } });
  });
});
