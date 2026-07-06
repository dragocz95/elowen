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
  it('defaults to the public orca.dragocz.dev referer + "Orca" title', async () => {
    const m = await loadFresh({ ORCA_APP_URL: undefined, ORCA_APP_TITLE: undefined });
    expect(m.APP_URL).toBe('https://orca.dragocz.dev');
    expect(m.APP_TITLE).toBe('Orca');
    // OpenRouter reads the canonical title header; x-title stays as a compatibility alias.
    expect(Object.keys(m.APP_IDENTITY_HEADERS).sort()).toEqual(['http-referer', 'x-openrouter-title', 'x-title']);
    expect(m.APP_IDENTITY_HEADERS['http-referer']).toBe('https://orca.dragocz.dev');
    expect(m.APP_IDENTITY_HEADERS['x-openrouter-title']).toBe('Orca');
    expect(m.APP_IDENTITY_HEADERS['x-title']).toBe('Orca');
  });

  it('lets a deployment override the public URL + title via env (prod vs dev)', async () => {
    const m = await loadFresh({ ORCA_APP_URL: 'https://my-orca.example.com/', ORCA_APP_TITLE: 'Orcasynth' });
    // Trailing slash trimmed so `${APP_URL}/favicon.ico` stays clean.
    expect(m.APP_URL).toBe('https://my-orca.example.com');
    expect(m.APP_IDENTITY_HEADERS['http-referer']).toBe('https://my-orca.example.com');
    expect(m.APP_IDENTITY_HEADERS['x-openrouter-title']).toBe('Orcasynth');
    expect(m.APP_IDENTITY_HEADERS['x-title']).toBe('Orcasynth');
  });

  it('falls back to the default when the env var is blank/whitespace', async () => {
    const m = await loadFresh({ ORCA_APP_URL: '   ', ORCA_APP_TITLE: '' });
    expect(m.APP_URL).toBe('https://orca.dragocz.dev');
    expect(m.APP_TITLE).toBe('Orca');
  });
});
