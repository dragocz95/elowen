import { describe, it, expect } from 'vitest';
import { parseFlags, resolveModel, flagValue } from '../../../src/cli/setup/headless.js';
import { PREFERRED_DEFAULT } from '../../../src/brain/providers.js';
import { RECOMMENDED_EMBEDDING_MODEL } from '../../../src/cli/setup/constants.js';
import type { WizardCtx } from '../../../src/cli/setup/types.js';

const ctxWith = (fetchFn: typeof fetch): WizardCtx => ({ base: 'http://x', isTTY: false, debug: false, fetchFn, answers: {} });

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
    const env = { ORCA_ADMIN_USER: 'envuser', ORCA_API_KEY: 'env-key' } as NodeJS.ProcessEnv;
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
