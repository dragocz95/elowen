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

  it('send posts the text with the CLI working directory', async () => {
    const f = vi.fn(async () => j(200, { ok: true })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await c.send('hi');
    expect(f).toHaveBeenCalledWith('http://x/brain/send', expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'hi', cwd: process.cwd() }) }));
  });

  it('send can pass the work mode', async () => {
    const f = vi.fn(async () => j(200, { ok: true })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await c.send('outline this first', 'plan');
    expect(f).toHaveBeenCalledWith('http://x/brain/send', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ text: 'outline this first', cwd: process.cwd(), mode: 'plan' }),
    }));
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

  it('commands GETs the caller-filtered CLI slash catalog', async () => {
    const f = vi.fn(async () => j(200, { commands: [{ name: 'help', description: 'Help', kind: 'info' }] })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    expect(await c.commands()).toEqual([{ name: 'help', description: 'Help', kind: 'info' }]);
    expect(f).toHaveBeenCalledWith('http://x/brain/commands?surface=cli', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer t' }),
    }));
  });

  it('queueRemove DELETEs /brain/queue/:id (no session suffix before start binds one)', async () => {
    const f = vi.fn(async () => j(200, { removed: true })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await c.queueRemove('q-42');
    expect(f).toHaveBeenCalledWith('http://x/brain/queue/q-42', expect.objectContaining({ method: 'DELETE' }));
  });

  it('queueRemove appends the bound session id once start() resolved one', async () => {
    const f = vi.fn(async () => j(201, { sessionId: 'brain-7' })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await c.start();
    f.mockImplementation(async () => j(200, { removed: false }) as Response);
    await c.queueRemove('q-9');
    expect(f).toHaveBeenCalledWith('http://x/brain/queue/q-9?session=brain-7', expect.objectContaining({ method: 'DELETE' }));
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

  it('getTddMode reads autopilot.tddMode from the public config', async () => {
    const f = vi.fn(async () => j(200, { autopilot: { tddMode: true } })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    expect(await c.getTddMode()).toBe(true);
    expect(f).toHaveBeenCalledWith('http://x/config', expect.objectContaining({ headers: expect.anything() }));
  });

  it('getTddMode defaults to false when the flag is absent', async () => {
    const f = vi.fn(async () => j(200, { autopilot: {} })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    expect(await c.getTddMode()).toBe(false);
  });

  it('setTddMode PUTs the autopilot.tddMode patch', async () => {
    const f = vi.fn(async () => j(200, { autopilot: { tddMode: true } })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await c.setTddMode(true);
    expect(f).toHaveBeenCalledWith('http://x/config', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ autopilot: { tddMode: true } }),
    }));
  });

  it('setTddMode surfaces a 403 as an admin-only error', async () => {
    const f = vi.fn(async () => j(403, { error: 'forbidden' })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await expect(c.setTddMode(true)).rejects.toThrow(/admin/i);
  });

  it('setTddMode surfaces a 401 as Unauthorized', async () => {
    const f = vi.fn(async () => j(401, {})) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await expect(c.setTddMode(false)).rejects.toBeInstanceOf(Unauthorized);
  });
});
