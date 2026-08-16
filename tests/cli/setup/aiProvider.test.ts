import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { runAiStep } from '../../../src/cli/setup/steps/aiProvider.js';
import { keepProvider, type PublicProvider } from '../../../src/cli/setup/steps/shared.js';
import type { WizardCtx } from '../../../src/cli/setup/types.js';

// The wizard's steps drive Elowen's prompt adapter for interactive input. The wiring test below only exercises
// the "reuse an already-configured provider" path, which needs just `select` (the top-level provider
// choice, and — on a failed smoke test — the "What next?" follow-up); everything else is a silent stub.
vi.mock('../../../src/cli/ui/prompts.js', () => ({
  select: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  spinner: () => ({ start: () => {}, stop: () => {} }),
  log: { info: () => {}, success: () => {}, error: () => {}, warn: () => {}, step: () => {}, message: () => {} },
  note: () => {},
  intro: () => {},
  outro: () => {},
  cancel: () => {},
  isCancel: () => false,
}));

describe('cli/setup.keepProvider', () => {
  it('re-sends an existing provider WITHOUT its key (keyless round-trip keeps the stored secret)', () => {
    const pub: PublicProvider = { id: 'p1', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.5'], apiKeySet: true };
    const kept = keepProvider(pub);
    expect(kept).toEqual({ id: 'p1', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.5'] });
    expect(kept).not.toHaveProperty('apiKey');
    expect(kept).not.toHaveProperty('apiKeySet');
  });

  it('carries every operator-set field, so an unrelated wizard save cannot erase one', () => {
    // The store replaces brain.providers wholesale and merges back only the key, so a field this rebuild
    // omits is erased from an entry the operator never touched. Connecting a NEW account must not wipe the
    // temperature or wire-API pin set on an existing one.
    const pub: PublicProvider = {
      id: 'p1', label: 'Proxy', type: 'openai', baseUrl: 'https://ai.example/v1', models: ['m'],
      api: 'openai-completions', apiKeySet: true, temperature: 0.2,
    };
    expect(keepProvider(pub)).toEqual({
      id: 'p1', label: 'Proxy', type: 'openai', baseUrl: 'https://ai.example/v1', models: ['m'],
      api: 'openai-completions', temperature: 0.2,
    });
  });

  it('keeps an explicit 0 and omits an unset temperature', () => {
    const base: PublicProvider = { id: 'p1', label: 'P', type: 'openai', baseUrl: 'u', models: [], apiKeySet: false };
    // 0 is falsy but a real setting — a truthiness check here would silently drop it.
    expect(keepProvider({ ...base, temperature: 0 })).toHaveProperty('temperature', 0);
    // Unset must stay unset: an explicit `temperature: undefined` would still serialize the key.
    expect(keepProvider(base)).not.toHaveProperty('temperature');
  });
});

// ── wizard AI step wiring: reuse-provider path → embedded exec + smoke test ─────────────────────────
type Call = { method: string; path: string; body: unknown };

/** A tiny router-style fetch double: `routes` maps "METHOD path" to a canned JSON response; every call
 *  is recorded (method, path, parsed body) so the test can assert exactly what the wizard PUT. */
function routedFetch(routes: Record<string, unknown>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (!(key in routes)) throw new Error(`unmocked route: ${key}`);
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function promptSelect(): Promise<Mock> {
  const prompts = await import('../../../src/cli/ui/prompts.js');
  return prompts.select as unknown as Mock;
}

describe('cli/setup.runAiStep — reuse-provider wiring', () => {
  it('after reusing a saved provider: embeds defaults.exec as elowen:<provider>/<model> and runs the smoke test', async () => {
    const select = await promptSelect();
    select.mockResolvedValueOnce('reuse:relay'); // the top-level "Connect an AI provider" choice

    const { fetchFn, calls } = routedFetch({
      'GET /config': { brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x', models: ['m1'], apiKeySet: true }] }, defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 1 } },
      'GET /brain/oauth/status': {},
      'PUT /config': { ok: true },
      'POST /brain/test': { ok: true, model: 'm1', reply: 'OK' },
    });
    const ctx: WizardCtx = { base: 'http://x', fetchFn, token: 'admin-tok', answers: {} };

    const result = await runAiStep(ctx);

    expect(result).toEqual({ status: 'done' });
    expect(ctx.answers.ai).toEqual({ status: 'done', summary: 'Relay (m1)', providerId: 'relay', providerType: 'openai', model: 'm1', hasKey: true });

    // The AI step wires ONLY the embedded task exec now — it PUTs { defaults: { exec } } (the config store
    // merges defaults per-field, so autonomy/maxSessions survive without a read-then-write race). Autopilot
    // is no longer configured here: it's a separate, final, opt-in step, so the AI step must NOT touch the
    // autopilot config.
    const puts = calls.filter((c) => c.method === 'PUT' && c.path === '/config');
    expect(puts).toContainEqual({ method: 'PUT', path: '/config', body: { defaults: { exec: 'relay/m1' } } });
    expect(puts.some((c) => (c.body as { autopilot?: unknown }).autopilot !== undefined)).toBe(false);

    // the smoke test ran against the just-embedded provider/model
    const smoke = calls.find((c) => c.method === 'POST' && c.path === '/brain/test');
    expect(smoke?.body).toEqual({ providerId: 'relay', model: 'm1' });
  });

  it('keeps the exec wiring even when the smoke test fails and the user chooses "keep anyway"', async () => {
    const select = await promptSelect();
    select.mockResolvedValueOnce('reuse:relay'); // provider choice
    select.mockResolvedValueOnce('keep'); // "What next?" after a failed smoke test

    const { fetchFn, calls } = routedFetch({
      'GET /config': { brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x', models: ['m1'], apiKeySet: true }] }, defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 1 } },
      'GET /brain/oauth/status': {},
      'PUT /config': { ok: true },
      'POST /brain/test': { ok: false, error: 'connection refused' },
    });
    const ctx: WizardCtx = { base: 'http://x', fetchFn, token: 'admin-tok', answers: {} };

    const result = await runAiStep(ctx);

    expect(result).toEqual({ status: 'done' }); // "keep anyway" still completes the step
    const defaultsPut = calls.find((c) => c.method === 'PUT' && c.path === '/config' && (c.body as { defaults?: unknown }).defaults);
    expect(defaultsPut?.body).toEqual({ defaults: { exec: 'relay/m1' } });
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/brain/test')).toHaveLength(1); // no retry loop taken
  });
});
