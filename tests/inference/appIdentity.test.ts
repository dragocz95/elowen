import { describe, it, expect, vi, afterEach } from 'vitest';

// APP_URL/APP_TITLE are resolved at module load from env, so env-override cases re-import a fresh module.
async function loadFresh(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }
  return import('../../src/inference/appIdentity.js');
}

afterEach(() => vi.unstubAllEnvs());

describe('appIdentity', () => {
  it('defaults to the public elowen.dragocz.dev referer + "Elowen" title', async () => {
    const m = await loadFresh({ ELOWEN_APP_URL: undefined, ELOWEN_APP_TITLE: undefined });
    expect(m.APP_URL).toBe('https://elowen.dragocz.dev');
    expect(m.APP_TITLE).toBe('Elowen');
    // OpenRouter reads the canonical title header; x-title stays as a compatibility alias.
    expect(Object.keys(m.APP_IDENTITY_HEADERS).sort()).toEqual(['http-referer', 'x-openrouter-title', 'x-title']);
    expect(m.APP_IDENTITY_HEADERS['http-referer']).toBe('https://elowen.dragocz.dev');
    expect(m.APP_IDENTITY_HEADERS['x-openrouter-title']).toBe('Elowen');
    expect(m.APP_IDENTITY_HEADERS['x-title']).toBe('Elowen');
  });

  it('lets a deployment override the public URL + title via env (prod vs dev)', async () => {
    const m = await loadFresh({ ELOWEN_APP_URL: 'https://my-elowen.example.com/', ELOWEN_APP_TITLE: 'Elowen' });
    // Trailing slash trimmed so `${APP_URL}/favicon.ico` stays clean.
    expect(m.APP_URL).toBe('https://my-elowen.example.com');
    expect(m.APP_IDENTITY_HEADERS['http-referer']).toBe('https://my-elowen.example.com');
    expect(m.APP_IDENTITY_HEADERS['x-openrouter-title']).toBe('Elowen');
    expect(m.APP_IDENTITY_HEADERS['x-title']).toBe('Elowen');
  });

  it('falls back to the default when the env var is blank/whitespace', async () => {
    const m = await loadFresh({ ELOWEN_APP_URL: '   ', ELOWEN_APP_TITLE: '' });
    expect(m.APP_URL).toBe('https://elowen.dragocz.dev');
    expect(m.APP_TITLE).toBe('Elowen');
  });
});
