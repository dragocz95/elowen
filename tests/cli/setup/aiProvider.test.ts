import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { runAiStep, shouldWireAutopilot } from '../../../src/cli/setup/steps/aiProvider.js';
import { keepProvider, type PublicProvider } from '../../../src/cli/setup/steps/shared.js';
import type { WizardCtx } from '../../../src/cli/setup/types.js';

// The wizard's steps drive Orca's prompt adapter for interactive input. The wiring test below only exercises
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

describe('cli/setup.shouldWireAutopilot', () => {
  it('wires only an openai-type provider that has a key (the relay trap guard)', () => {
    expect(shouldWireAutopilot('openai', true)).toBe(true);
    expect(shouldWireAutopilot('openai', false)).toBe(false); // no key → relay unusable
    expect(shouldWireAutopilot('anthropic', true)).toBe(false); // relay is OpenAI-only
    expect(shouldWireAutopilot('oauth-anthropic', true)).toBe(false);
    expect(shouldWireAutopilot('oauth-openai-codex', true)).toBe(false); // no stored key
  });
});

describe('cli/setup.keepProvider', () => {
  it('re-sends an existing provider WITHOUT its key (keyless round-trip keeps the stored secret)', () => {
    const pub: PublicProvider = { id: 'p1', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.5'], apiKeySet: true };
    const kept = keepProvider(pub);
    expect(kept).toEqual({ id: 'p1', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.5'] });
    expect(kept).not.toHaveProperty('apiKey');
    expect(kept).not.toHaveProperty('apiKeySet');
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
  it('after reusing a saved provider: embeds defaults.exec as orca:<provider>/<model> and runs the smoke test', async () => {
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

    // autopilot relay wiring (openai + key) + the embedded task exec both PUT /config. The exec PUT sends
    // ONLY { defaults: { exec } } — the config store merges defaults per-field, so autonomy/maxSessions are
    // preserved without a read-then-write race.
    const puts = calls.filter((c) => c.method === 'PUT' && c.path === '/config');
    expect(puts).toContainEqual({ method: 'PUT', path: '/config', body: { autopilot: { providerId: 'relay', model: 'm1' } } });
    expect(puts).toContainEqual({ method: 'PUT', path: '/config', body: { defaults: { exec: 'orca:relay/m1' } } });

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
    expect(defaultsPut?.body).toEqual({ defaults: { exec: 'orca:relay/m1' } });
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/brain/test')).toHaveLength(1); // no retry loop taken
  });
});
