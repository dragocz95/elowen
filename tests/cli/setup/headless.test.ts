import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { parseFlags, resolveModel, flagValue, runHeadlessSetup } from '../../../src/cli/setup/headless.js';
import { PREFERRED_DEFAULT } from '../../../src/brain/providers.js';
import { RECOMMENDED_EMBEDDING_MODEL, OPENROUTER_BASE, OPENAI_BASE } from '../../../src/cli/setup/constants.js';
import type { WizardCtx } from '../../../src/cli/setup/types.js';

const ctxWith = (fetchFn: typeof fetch): WizardCtx => ({ base: 'http://x', fetchFn, answers: {} });

interface RecCall { method: string; path: string; body: Record<string, unknown> | undefined }
/** A stateful daemon stub: GET /config returns the current provider list; PUT /config that carries
 *  brain.providers replaces it. Records every call so a test can assert exactly what the wizard did. */
function fakeDaemon(initial: Record<string, unknown>[] = []): { calls: RecCall[]; providers: () => Record<string, unknown>[] } {
  let providers = initial;
  const calls: RecCall[] = [];
  const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status });
  vi.stubGlobal('fetch', (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path, body });
    if (path === '/setup') return json({ needsSetup: false });
    if (path === '/auth/login') return json({ token: 't' });
    if (path === '/config' && method === 'GET') return json({ brain: { providers } });
    if (path === '/config' && method === 'PUT') {
      const bp = (body?.brain as { providers?: Record<string, unknown>[] } | undefined)?.providers;
      if (bp) providers = bp.map((p) => ({ ...p, apiKeySet: p.apiKeySet ?? ('apiKey' in p) }));
      return json({ ok: true });
    }
    return json({ ok: true });
  }) as unknown as typeof fetch);
  return { calls, providers: () => providers };
}

afterEach(() => vi.unstubAllGlobals());

describe('cli/setup/headless.parseFlags', () => {
  it('applies defaults', () => {
    const o = parseFlags(['--non-interactive'], {});
    expect(o.adminUser).toBe('admin');
    expect(o.memory).toBe('skip');
    expect(o.embeddingModel).toBe(RECOMMENDED_EMBEDDING_MODEL);
    expect(o.project).toBeUndefined(); // project registration is opt-in (--project), never a cwd default
    expect(o.skipTest).toBe(false);
  });

  it('project is opt-in via --project (no cwd default)', () => {
    expect(parseFlags([], {}).project).toBeUndefined();
    expect(parseFlags(['--project', '/repo/x'], {}).project).toBe('/repo/x');
  });

  it('a flag whose value is another flag reads as absent (never eats the next flag)', () => {
    expect(flagValue(['--admin-password', '--provider', 'openai'], '--admin-password')).toBeUndefined();
    expect(flagValue(['--admin-password', 'secret'], '--admin-password')).toBe('secret');
    // …so a forgotten password value doesn't silently become "--provider"
    expect(parseFlags(['--admin-password', '--provider', 'openai'], {}).adminPassword).toBeUndefined();
  });

  it('prefers a flag over the env var, falls back to env otherwise', () => {
    const env = { ELOWEN_ADMIN_USER: 'envuser', ELOWEN_API_KEY: 'env-key' } as NodeJS.ProcessEnv;
    const o = parseFlags(['--admin-user', 'flaguser'], env);
    expect(o.adminUser).toBe('flaguser'); // flag wins
    expect(o.apiKey).toBe('env-key');     // env fallback
  });

  it('--no-project clears the default project', () => {
    expect(parseFlags(['--no-project'], {}).project).toBeUndefined();
  });

  it('normalizes an invalid --memory to skip', () => {
    expect(parseFlags(['--memory', 'bogus'], {}).memory).toBe('skip');
    expect(parseFlags(['--memory', 'openrouter'], {}).memory).toBe('openrouter');
  });

  it('--lsp opts into the language-server install (off by default)', () => {
    expect(parseFlags([], {}).lsp).toBe(false);
    expect(parseFlags(['--lsp'], {}).lsp).toBe(true);
  });
});

describe('cli/setup/headless.resolveModel', () => {
  const noFetch = (async () => { throw new Error('should not fetch'); }) as unknown as typeof fetch;

  it('returns an explicit model as-is (no probe)', async () => {
    expect(await resolveModel(ctxWith(noFetch), 'openai', 'http://x/v1', 'k', 'gpt-5.5')).toBe('gpt-5.5');
  });

  it('defaults an Anthropic provider to its flagship', async () => {
    expect(await resolveModel(ctxWith(noFetch), 'anthropic', 'http://x', undefined, undefined)).toBe(PREFERRED_DEFAULT.anthropic);
  });

  it('probes /models for an openai endpoint with a key and picks the first', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ models: ['a-model', 'b-model'] }), { status: 200 })) as unknown as typeof fetch;
    expect(await resolveModel(ctxWith(fetchFn), 'openai', 'http://x/v1', 'k', undefined)).toBe('a-model');
  });

  it('skips embedding/non-chat models when auto-picking from a probe', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ models: ['text-embedding-3-small', 'whisper-1', 'gpt-5.5'] }), { status: 200 })) as unknown as typeof fetch;
    expect(await resolveModel(ctxWith(fetchFn), 'openai', 'http://x/v1', 'k', undefined)).toBe('gpt-5.5');
  });

  it('returns null when the endpoint yields no models', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ models: [] }), { status: 200 })) as unknown as typeof fetch;
    expect(await resolveModel(ctxWith(fetchFn), 'openai', 'http://x/v1', 'k', undefined)).toBeNull();
  });

  it('returns "" (keyless save) for an openai provider with no key and no explicit model', async () => {
    // Matches the interactive wizard's "connect later": save the endpoint keyless rather than hard-failing.
    expect(await resolveModel(ctxWith(noFetch), 'openai', 'http://x/v1', undefined, undefined)).toBe('');
  });
});

describe('cli/setup/headless.runHeadlessSetup — provider reuse (regression guards)', () => {
  it('keyless re-run keeps the existing model list instead of wiping it', async () => {
    const d = fakeDaemon([{ id: 'openai', label: 'OpenAI', type: 'openai', baseUrl: OPENAI_BASE, models: ['gpt-5.5'], apiKeySet: true }]);
    await runHeadlessSetup('http://x', { HOME: tmpdir() } as NodeJS.ProcessEnv, ['--admin-password', 'pw', '--provider', 'openai', '--skip-test']);
    const put = d.calls.find((c) => c.method === 'PUT' && c.path === '/config' && (c.body?.brain as { providers?: unknown })?.providers);
    const saved = ((put?.body?.brain as { providers: Record<string, unknown>[] }).providers).find((p) => p.id === 'openai');
    expect(saved?.models).toEqual(['gpt-5.5']); // NOT []
  });

  it('memory openrouter reuses the keyless entry the AI step wrote — no openrouter-2 duplicate', async () => {
    const d = fakeDaemon([]);
    await runHeadlessSetup('http://x', { HOME: tmpdir() } as NodeJS.ProcessEnv, [
      '--admin-password', 'pw', '--provider', 'openrouter', '--memory', 'openrouter', '--memory-key', 'K', '--skip-test',
    ]);
    const ors = d.providers().filter((p) => p.baseUrl === OPENROUTER_BASE);
    expect(ors).toHaveLength(1); // one, not a keyless one + an openrouter-2
    const embed = d.calls.find((c) => c.method === 'PUT' && c.path === '/memory/embedding');
    expect(embed?.body?.providerId).toBe('openrouter'); // embeddings point at the reused id
  });
});
