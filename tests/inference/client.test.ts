import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeInference, RelayClient } from '../../src/inference/client.js';

afterEach(() => vi.restoreAllMocks());

describe('FakeInference', () => {
  it('returns the scripted decision', async () => {
    const f = new FakeInference('APPROVE');
    expect((await f.decide('any')).text).toBe('APPROVE');
  });
});

describe('RelayClient', () => {
  it('posts to /v1/chat/completions and returns the message content', async () => {
    let calledUrl = '';
    global.fetch = vi.fn(async (url: any) => { calledUrl = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }); }) as any;
    const c = new RelayClient({ baseUrl: 'https://relay.example/v1', apiKey: 'k', model: 'm' });
    expect((await c.decide('q')).text).toBe('hi');
    // Trailing /v1 is normalized — no double /v1, exactly one /v1/chat/completions.
    expect(calledUrl).toBe('https://relay.example/v1/chat/completions');
  });

  it('throws a clear error on a 200 non-JSON (proxy HTML) response instead of a raw SyntaxError', async () => {
    global.fetch = vi.fn(async () => new Response('<html>502</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    const c = new RelayClient({ baseUrl: 'https://relay.example', apiKey: 'k', model: 'm' });
    await expect(c.decide('q')).rejects.toThrow(/non-JSON/);
  });

  it('throws on a non-ok status', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as any;
    const c = new RelayClient({ baseUrl: 'https://relay.example', apiKey: 'k', model: 'm' });
    await expect(c.decide('q')).rejects.toThrow(/relay HTTP 500/);
  });
});
