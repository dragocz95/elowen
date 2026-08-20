// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeCursor, DelegatedGraphClient, DelegatedGraphError, encodeCursor } from '../plugins/msteams/lib/delegatedGraph.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('delegated Microsoft Graph client', () => {
  it('keeps requests on Graph v1.0 and rejects escaped paths', async () => {
    const fetch = vi.fn(async () => response(200, { id: 'me' }));
    const graph = new DelegatedGraphClient('secret-token', { fetch });

    await expect(graph.json('GET', '/me')).resolves.toEqual({ id: 'me' });
    expect(fetch).toHaveBeenCalledWith('https://graph.microsoft.com/v1.0/me', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer secret-token' }),
    }));
    await expect(graph.json('GET', 'https://evil.example/me')).rejects.toThrow('relative');
    await expect(graph.json('GET', '/../beta/me')).rejects.toThrow('v1.0');
  });

  it('accepts only Graph pagination cursors for the expected collection', () => {
    const cursor = encodeCursor('https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc');
    expect(decodeCursor(cursor, '/me/messages')).toBe('/me/messages?$skiptoken=abc');
    expect(() => decodeCursor(cursor, '/me/events')).toThrow('different Microsoft resource');
    expect(() => encodeCursor('https://evil.example/v1.0/me/messages')).toThrow('unsafe pagination');
  });

  it('retries transient reads but never retries writes', async () => {
    const readFetch = vi.fn()
      .mockResolvedValueOnce(response(429, { error: { code: 'TooManyRequests', message: 'slow down' } }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(response(200, { value: [] }));
    const graph = new DelegatedGraphClient('token', { fetch: readFetch });
    await expect(graph.json('GET', '/me/messages')).resolves.toEqual({ value: [] });
    expect(readFetch).toHaveBeenCalledTimes(2);

    const writeFetch = vi.fn(async () => response(429, { error: { code: 'TooManyRequests', message: 'slow down' } }, { 'request-id': 'req-1' }));
    const writer = new DelegatedGraphClient('token', { fetch: writeFetch });
    await expect(writer.json('POST', '/me/sendMail', { body: {} })).rejects.toMatchObject({
      status: 429, code: 'TooManyRequests', requestId: 'req-1', name: 'DelegatedGraphError',
    } satisfies Partial<DelegatedGraphError>);
    expect(writeFetch).toHaveBeenCalledTimes(1);
  });

  it('caps binary bodies even when content-length is absent', async () => {
    const graph = new DelegatedGraphClient('token', {
      fetch: vi.fn(async () => new Response(new Uint8Array(10), { status: 200, headers: { 'content-type': 'application/octet-stream' } })),
    });
    await expect(graph.binary('/me/drive/root/content', { maxBytes: 5 })).rejects.toThrow('transfer limit');
  });
});
