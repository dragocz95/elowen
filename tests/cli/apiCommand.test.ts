import { describe, it, expect } from 'vitest';
import { runApiCommand } from '../../src/cli/commands.js';
import { callElowenApi, type CallResult } from '../../src/shared/apiClient.js';
import { noTimeoutDispatcher, noTimeoutFetch } from '../../src/cli/noTimeoutDispatcher.js';

const okData = (data: unknown): CallResult => ({ status: 200, ok: true, data, text: '' });

describe('runApiCommand', () => {
  it('GET forwards env url+token and prints JSON', async () => {
    const lines: string[] = [];
    let seen: { method: string; path: string; url: string; token: string } | undefined;
    const code = await runApiCommand(['GET', '/projects'], { ELOWEN_URL: 'http://d:4400', ELOWEN_TOKEN: 'tk' } as NodeJS.ProcessEnv, {
      call: async (method, path, _body, opts) => { seen = { method, path, url: opts.url, token: opts.token }; return okData([{ id: 't1' }]); },
      out: (s) => lines.push(s), err: () => {},
    });
    expect(code).toBe(0);
    expect(seen).toEqual({ method: 'GET', path: '/projects', url: 'http://d:4400', token: 'tk' });
    expect(JSON.parse(lines.join('\n'))).toEqual([{ id: 't1' }]);
  });

  it('POST parses the JSON body argument', async () => {
    let seen: unknown;
    const code = await runApiCommand(['POST', '/projects', '{"title":"x"}'], { ELOWEN_URL: 'http://d', ELOWEN_TOKEN: 't' } as NodeJS.ProcessEnv, {
      call: async (_m, _p, body) => { seen = body; return { status: 201, ok: true, data: {}, text: '' }; },
      out: () => {}, err: () => {},
    });
    expect(code).toBe(0);
    expect(seen).toEqual({ title: 'x' });
  });

  it('defaults url to localhost:4400 when ELOWEN_URL is unset', async () => {
    let seenUrl = '';
    await runApiCommand(['GET', '/health'], {} as NodeJS.ProcessEnv, {
      call: async (_m, _p, _b, opts) => { seenUrl = opts.url; return okData({}); },
      out: () => {}, err: () => {},
    });
    expect(seenUrl).toBe('http://localhost:4400');
  });

  it('non-ok status exits 1', async () => {
    const code = await runApiCommand(['GET', '/x'], { ELOWEN_URL: 'http://d', ELOWEN_TOKEN: 't' } as NodeJS.ProcessEnv, {
      call: async () => ({ status: 403, ok: false, data: { error: 'forbidden' }, text: 'forbidden' }),
      out: () => {}, err: () => {},
    });
    expect(code).toBe(1);
  });

  it('missing method/path exits 2', async () => {
    const code = await runApiCommand(['GET'], {} as NodeJS.ProcessEnv, { call: async () => okData({}), out: () => {}, err: () => {} });
    expect(code).toBe(2);
  });

  it('invalid JSON body exits 2 without calling the API', async () => {
    let called = false;
    const code = await runApiCommand(['POST', '/projects', '{bad'], {} as NodeJS.ProcessEnv, {
      call: async () => { called = true; return okData({}); }, out: () => {}, err: () => {},
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  // Regression: `elowen api POST /brain/compact` died with `fetch failed` after undici's default
  // 300 s headersTimeout/bodyTimeout, while the daemon answered the request successfully.
  it('fetches through undici with a no-timeout dispatcher so long routes are not aborted', async () => {
    let seen: { fetchImpl?: unknown; dispatcher?: unknown } | undefined;
    await runApiCommand(['POST', '/brain/compact'], { ELOWEN_URL: 'http://d', ELOWEN_TOKEN: 't' } as NodeJS.ProcessEnv, {
      call: async (_m, _p, _b, opts) => { seen = opts; return okData({}); },
      out: () => {}, err: () => {},
    });
    // Node's global fetch ignores a dispatcher from the npm undici package, so the api verb must
    // fetch through undici's own fetch — the only one that honours init.dispatcher.
    expect(seen?.fetchImpl).toBe(noTimeoutFetch);
    expect(seen?.dispatcher).toBe(noTimeoutDispatcher());
    const options = Object.getOwnPropertySymbols(seen?.dispatcher as object)
      .map((s) => ((seen?.dispatcher ?? {}) as Record<symbol, unknown>)[s])
      .find((v): v is { headersTimeout: number; bodyTimeout: number } => !!v && typeof v === 'object' && 'headersTimeout' in v);
    expect(options?.headersTimeout).toBe(0);
    expect(options?.bodyTimeout).toBe(0);
  });

  it('an ordinary API call keeps the default timeouts (no dispatcher on fetch)', async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_u: string, i?: RequestInit) => { init = i; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    await callElowenApi('GET', '/projects', undefined, { url: 'http://d', token: 't', fetchImpl });
    expect(init && 'dispatcher' in init).toBe(false);
  });
});
