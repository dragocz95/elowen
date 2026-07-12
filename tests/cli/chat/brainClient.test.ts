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
const deferredResponse = (): { promise: Promise<Response>; resolve: (response: Response) => void } => {
  let resolve!: (response: Response) => void;
  return { promise: new Promise<Response>((r) => { resolve = r; }), resolve };
};

describe('BrainClient', () => {
  it('start posts to /brain/start and returns the sessionId', async () => {
    const f = vi.fn(async () => j(201, { sessionId: 'brain-1' })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
    expect((await c.start()).sessionId).toBe('brain-1');
    expect(f).toHaveBeenCalledWith('http://x/brain/start', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ cwd: process.cwd(), client: 'cli-a', generation: 1 }),
    }));
  });

  it('does not let an older concurrent start response overwrite the latest bound session', async () => {
    const a = deferredResponse();
    const b = deferredResponse();
    const generations: number[] = [];
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { session?: string; generation: number };
      generations.push(body.generation);
      return body.session === 'A' ? a.promise : b.promise;
    }) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
    const startA = c.start({ session: 'A' });
    const startB = c.start({ session: 'B' });
    b.resolve(j(201, { sessionId: 'B' }));
    await startB;
    a.resolve(j(201, { sessionId: 'A' }));
    await startA;
    expect(c.boundSession).toBe('B');
    expect(generations).toEqual([1, 2]);
  });

  it('stop fences the highest issued start generation even while its response is still pending', async () => {
    const pending = deferredResponse();
    const bodies: Record<string, unknown>[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (url.endsWith('/brain/start') && body.generation === 2) return pending.promise;
      if (url.endsWith('/brain/start')) return j(201, { sessionId: 'A' });
      return j(200, { stopped: true });
    }) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
    await c.start({ session: 'A' });
    const switching = c.start({ session: 'B' });
    await c.stopSession();

    expect(bodies.at(-1)).toEqual({ session: 'A', client: 'cli-a', generation: 2 });
    pending.resolve(j(409, { error: 'client request is no longer current' }));
    await expect(switching).rejects.toThrow('client request is no longer current');
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

  it('bound commands, fast mode and session stop carry the exact conversation id', async () => {
    const f = vi.fn(async () => j(201, { sessionId: 'brain-7' })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
    await c.start();

    f.mockImplementation(async () => j(200, { message: 'ok' }) as Response);
    await c.command('restart');
    expect(f).toHaveBeenLastCalledWith('http://x/brain/command', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'restart', session: 'brain-7' }),
    }));

    f.mockImplementation(async () => j(200, { fast: true, fastAvailable: true }) as Response);
    expect(await c.setFast(true)).toEqual({ fast: true, fastAvailable: true });
    expect(f).toHaveBeenLastCalledWith('http://x/brain/fast', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ on: true, session: 'brain-7' }),
    }));

    f.mockImplementation(async () => j(200, { ok: true }) as Response);
    await c.send('bound turn');
    expect(f).toHaveBeenLastCalledWith('http://x/brain/send', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ text: 'bound turn', cwd: process.cwd(), session: 'brain-7', client: 'cli-a', generation: 1 }),
    }));

    f.mockImplementation(async () => j(200, { stopped: true }) as Response);
    await c.stopSession();
    expect(f).toHaveBeenLastCalledWith('http://x/brain/session/stop', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ session: 'brain-7', client: 'cli-a', generation: 1 }),
    }));
  });

  it('carries one stable client id on the bound stream and its cancellable stop request', async () => {
    const streamBody = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(': connected\n\n'));
        ctrl.close();
      },
    });
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/brain/start')) return j(201, { sessionId: 'brain-7' });
      if (url.includes('/brain/stream')) return new Response(streamBody, { status: 200 });
      if (url.endsWith('/brain/session/stop')) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return j(200, {});
    }) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
    await c.start();
    const streamAc = new AbortController();
    const stream = c.stream(() => {}, streamAc.signal, 5, () => streamAc.abort());
    await stream;
    expect(f).toHaveBeenCalledWith(
      'http://x/brain/stream?session=brain-7&client=cli-a&generation=1',
      expect.objectContaining({ signal: streamAc.signal }),
    );

    const stopAc = new AbortController();
    const stop = c.stopSession(stopAc.signal);
    stopAc.abort(new Error('quit timeout'));
    await expect(stop).rejects.toThrow('quit timeout');
    expect(f).toHaveBeenLastCalledWith('http://x/brain/session/stop', expect.objectContaining({
      body: JSON.stringify({ session: 'brain-7', client: 'cli-a', generation: 1 }), signal: stopAc.signal,
    }));
  });

  it('uses the application lifetime for ordinary fetches but keeps the detached quit stop signal', async () => {
    const calls: Array<{ url: string; signal?: AbortSignal | null }> = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, signal: init?.signal });
      if (url.endsWith('/brain/session/stop')) return j(200, { stopped: true });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
      });
    }) as unknown as typeof fetch;
    const client = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-life' });
    const application = new AbortController();
    client.bindLifetime(application.signal);

    const pending = client.models();
    application.abort(new Error('application stopped'));
    await expect(pending).rejects.toThrow('application stopped');
    expect(calls[0]).toEqual({ url: 'http://x/brain/models', signal: application.signal });

    const detachedStop = new AbortController();
    await client.stopSession(detachedStop.signal);
    expect(calls.at(-1)).toEqual({ url: 'http://x/brain/session/stop', signal: detachedStop.signal });
    expect(detachedStop.signal.aborted).toBe(false);
  });

  it('reads optional rate-limit windows for the bound conversation', async () => {
    const f = vi.fn(async () => j(201, { sessionId: 'brain-9' })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await c.start();
    const limits = {
      provider: 'openai-codex', planType: 'team', fetchedAt: 123, stale: false,
      primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 1_900_000_000 },
      secondary: { usedPercent: 60, windowMinutes: 10_080, resetsAt: 1_900_500_000 },
    };
    f.mockImplementation(async () => j(200, limits) as Response);
    expect(await c.rateLimits()).toEqual(limits);
    expect(f).toHaveBeenLastCalledWith('http://x/brain/rate-limits?session=brain-9', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer t' }),
    }));
  });

  it('renameSession PATCHes the selected title', async () => {
    const f = vi.fn(async () => j(200, { id: 'brain-2', title: 'New title' })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    expect(await c.renameSession('brain-2', 'New title')).toEqual({ id: 'brain-2', title: 'New title' });
    expect(f).toHaveBeenCalledWith('http://x/brain/sessions/brain-2', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ title: 'New title' }),
    }));
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

  it('requests and parses an opt-in sub-agent snapshot without changing normal streams', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('event: snapshot\nid: 9\ndata: {"type":"snapshot","cursor":9,"history":[{"role":"user","text":"stored"}],"events":[{"type":"text","delta":"live"}]}\n\n'));
        ctrl.close();
      },
    });
    const f = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    const ac = new AbortController();
    const seen: unknown[] = [];
    await c.stream((event) => { seen.push(event); ac.abort(); }, ac.signal, 5, undefined, 'brain-ch-subagent-a', true);
    expect(f).toHaveBeenCalledWith(
      'http://x/brain/stream?session=brain-ch-subagent-a&snapshot=1',
      expect.objectContaining({ signal: ac.signal }),
    );
    expect(seen).toEqual([{
      type: 'snapshot', cursor: 9,
      history: [{ role: 'user', text: 'stored' }],
      events: [{ type: 'text', delta: 'live' }],
    }]);
  });

  it('requests a snapshot again when a bound stream reconnects', async () => {
    let attempts = 0;
    const f = vi.fn(async (url: string) => {
      if (url.endsWith('/brain/start')) return j(201, { sessionId: 'brain-7' });
      attempts++;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          if (attempts === 2) {
            ctrl.enqueue(new TextEncoder().encode('event: snapshot\ndata: {"type":"snapshot","cursor":2,"history":[],"events":[]}\n\n'));
          }
          ctrl.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
    await c.start();
    const ac = new AbortController();
    const seen: unknown[] = [];
    await c.stream((frame) => { seen.push(frame); ac.abort(); }, ac.signal, 1, undefined, undefined, true);

    const urls = (f as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([url]) => url)
      .filter((url) => url.includes('/brain/stream'));
    expect(urls).toEqual([
      'http://x/brain/stream?session=brain-7&client=cli-a&generation=1&snapshot=1',
      'http://x/brain/stream?session=brain-7&client=cli-a&generation=1&snapshot=1',
    ]);
    expect(seen).toEqual([{ type: 'snapshot', cursor: 2, history: [], events: [] }]);
  });

  it('rebinds a missed idle-rollover snapshot before the following reconnect URL', async () => {
    let attempts = 0;
    const f = vi.fn(async (url: string) => {
      if (url.endsWith('/brain/start')) return j(201, { sessionId: 'brain-old' });
      attempts++;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          if (attempts === 2) {
            ctrl.enqueue(new TextEncoder().encode('event: snapshot\ndata: {"type":"snapshot","sessionId":"brain-fresh","cursor":5,"history":[],"events":[]}\n\n'));
          }
          if (attempts === 3) {
            ctrl.enqueue(new TextEncoder().encode('event: text\ndata: {"type":"text","delta":"fresh reply"}\n\n'));
          }
          ctrl.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
    await c.start();
    const ac = new AbortController();
    await c.stream((frame) => { if (frame.type === 'text') ac.abort(); }, ac.signal, 1, undefined, undefined, true);

    const urls = (f as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([url]) => url)
      .filter((url) => url.includes('/brain/stream'));
    expect(urls).toEqual([
      'http://x/brain/stream?session=brain-old&client=cli-a&generation=1&snapshot=1',
      'http://x/brain/stream?session=brain-old&client=cli-a&generation=1&snapshot=1',
      'http://x/brain/stream?session=brain-fresh&client=cli-a&generation=1&snapshot=1',
    ]);
    expect(c.boundSession).toBe('brain-fresh');
  });

  it('cancels reconnect backoff immediately on lifecycle abort without leaving a timer', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), { status: 200 })) as unknown as typeof fetch;
      const client = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
      const lifecycle = new AbortController();
      const streaming = client.stream(() => {}, lifecycle.signal, 30_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);

      lifecycle.abort();
      await streaming;
      expect(vi.getTimerCount()).toBe(0);
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
