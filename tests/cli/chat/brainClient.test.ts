import { describe, it, expect, vi } from 'vitest';
import { BrainClient, parseSse, Unauthorized } from '../../../src/cli/chat/brainClient.js';

describe('parseSse', () => {
  it('splits complete frames and keeps the tail', () => {
    const { frames, rest } = parseSse('event: text\ndata: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
    expect(frames).toEqual([{ event: 'text', data: '{"a":1}' }, { event: undefined, data: '{"b":2}' }]);
    expect(rest).toBe('data: {"c"');
  });

  it('skips comment-only frames (: ping)', () => {
    const { frames } = parseSse(': ping\n\n');
    expect(frames).toHaveLength(0);
  });
});

const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('BrainClient', () => {
  it('start posts to /brain/start and returns the sessionId', async () => {
    const f = vi.fn(async () => j(201, { sessionId: 'brain-1' })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    expect((await c.start()).sessionId).toBe('brain-1');
    expect(f).toHaveBeenCalledWith('http://x/brain/start', expect.objectContaining({ method: 'POST' }));
  });

  it('send posts the text', async () => {
    const f = vi.fn(async () => j(200, { ok: true })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await c.send('hi');
    expect(f).toHaveBeenCalledWith('http://x/brain/send', expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'hi' }) }));
  });

  it('history GETs /brain/messages', async () => {
    const f = vi.fn(async () => j(200, [{ role: 'user', text: 'hi' }])) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    expect(await c.history()).toEqual([{ role: 'user', text: 'hi' }]);
  });

  it('status GETs /brain/status', async () => {
    const f = vi.fn(async () => j(200, { running: true, sessionId: 'brain-1', model: 'kimi' })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    expect((await c.status()).model).toBe('kimi');
  });

  it('maps a 401 to Unauthorized', async () => {
    const f = vi.fn(async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await expect(c.send('x')).rejects.toBeInstanceOf(Unauthorized);
  });

  it('stream parses SSE frames into BrainEvents and stops on abort', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('event: text\ndata: {"type":"text","delta":"hi"}\n\n'));
        ctrl.close();
      },
    });
    const f = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    const ac = new AbortController();
    const seen: unknown[] = [];
    await c.stream((e) => { seen.push(e); ac.abort(); }, ac.signal, 5);
    expect(seen).toEqual([{ type: 'text', delta: 'hi' }]);
  });
});
