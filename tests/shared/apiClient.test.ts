import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { callElowenApi } from '../../src/shared/apiClient.js';

function fakeFetch(captured: { url?: string; init?: RequestInit }, res: () => Response): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    captured.url = url; captured.init = init;
    return res();
  }) as unknown as typeof fetch;
}

/** The client has no fetch seam any more: it either uses the global fetch or, for `noTimeout`, undici's
 *  own — which is the whole point of deciding the timeout HERE rather than at each call site. So the
 *  ordinary path is exercised against a stubbed global. */
function stubFetch(captured: { url?: string; init?: RequestInit }, res: () => Response) {
  vi.stubGlobal('fetch', fakeFetch(captured, res));
}

describe('callElowenApi', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('forwards method, path, bearer token and JSON body', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    stubFetch(cap, () => new Response(JSON.stringify({ ok: true, items: [1] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await callElowenApi('POST', '/projects', { title: 'x' }, { url: 'http://d:4400', token: 'tok' });
    expect(cap.url).toBe('http://d:4400/projects');
    expect(cap.init?.method).toBe('POST');
    expect((cap.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((cap.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(cap.init?.body).toBe(JSON.stringify({ title: 'x' }));
    expect(res.data).toEqual({ ok: true, items: [1] });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
  });

  it('omits body and content-type on GET', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    stubFetch(cap, () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    await callElowenApi('GET', '/projects', undefined, { url: 'http://d:4400', token: 't' });
    expect(cap.init?.body).toBeUndefined();
    expect((cap.init?.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('prefixes a leading slash when the path lacks one', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    stubFetch(cap, () => new Response('{}', { status: 200 }));
    await callElowenApi('GET', 'health', undefined, { url: 'http://d:4400', token: 't' });
    expect(cap.url).toBe('http://d:4400/health');
  });

  it('returns non-ok status without throwing; non-JSON body falls back to text', async () => {
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch);
    const res = await callElowenApi('GET', '/x', undefined, { url: 'http://d:4400', token: 't' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.data).toBeUndefined();
    expect(res.text).toBe('boom');
  });

  it('an ordinary call goes through the global fetch, with no dispatcher on it', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    stubFetch(cap, () => new Response('{}', { status: 200 }));
    await callElowenApi('GET', '/projects', undefined, { url: 'http://d', token: 't' });
    expect(cap.init && 'dispatcher' in cap.init).toBe(false);
  });

  // The no-timeout path does NOT use the global fetch — it dynamically imports undici and rides an
  // agent with the timeouts at 0. Nothing in the process can stub that, so it is exercised for real
  // against a local server: a global fetch that is stubbed to throw proves the request never took it.
  describe('noTimeout', () => {
    let server: Server | undefined;
    afterEach(async () => {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    });

    it('reaches the daemon through undici rather than the global fetch', async () => {
      const seen: { method?: string; auth?: string; body?: string }[] = [];
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          seen.push({ method: req.method, auth: req.headers.authorization, body });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ compacted: true }));
        });
      });
      const port = await new Promise<number>((resolve) => server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port);
      }));
      vi.stubGlobal('fetch', (() => { throw new Error('the no-timeout path must not use the global fetch'); }) as unknown as typeof fetch);

      const res = await callElowenApi('POST', '/brain/compact', { instruction: 'x' }, {
        url: `http://127.0.0.1:${port}`, token: 'tok', noTimeout: true,
      });
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ compacted: true });
      expect(seen[0]).toEqual({ method: 'POST', auth: 'Bearer tok', body: JSON.stringify({ instruction: 'x' }) });
    });
  });
});
