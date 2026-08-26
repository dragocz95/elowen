import { describe, it, expect } from 'vitest';
import { callElowenApi } from '../../src/shared/apiClient.js';

function fakeFetch(captured: { url?: string; init?: RequestInit }, res: () => Response): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    captured.url = url; captured.init = init;
    return res();
  }) as unknown as typeof fetch;
}

describe('callElowenApi', () => {
  it('forwards method, path, bearer token and JSON body', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const res = await callElowenApi('POST', '/projects', { title: 'x' }, {
      url: 'http://d:4400', token: 'tok',
      fetchImpl: fakeFetch(cap, () => new Response(JSON.stringify({ ok: true, items: [1] }), { status: 200, headers: { 'content-type': 'application/json' } })),
    });
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
    await callElowenApi('GET', '/projects', undefined, {
      url: 'http://d:4400', token: 't',
      fetchImpl: fakeFetch(cap, () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })),
    });
    expect(cap.init?.body).toBeUndefined();
    expect((cap.init?.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('prefixes a leading slash when the path lacks one', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    await callElowenApi('GET', 'health', undefined, {
      url: 'http://d:4400', token: 't',
      fetchImpl: fakeFetch(cap, () => new Response('{}', { status: 200 })),
    });
    expect(cap.url).toBe('http://d:4400/health');
  });

  it('returns non-ok status without throwing; non-JSON body falls back to text', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const res = await callElowenApi('GET', '/x', undefined, { url: 'http://d:4400', token: 't', fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.data).toBeUndefined();
    expect(res.text).toBe('boom');
  });
});
