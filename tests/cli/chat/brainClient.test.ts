import { describe, it, expect, vi } from 'vitest';
import { BRAIN_STREAM_SILENCE_LIMIT_MS, BrainClient, parseSse, Unauthorized, usageProviderOf } from '../../../src/cli/chat/brainClient.js';

describe('usageProviderOf — the subscription-rail key across daemon versions', () => {
  it('takes the explicit field a current daemon sends', () => {
    expect(usageProviderOf({ provider: 'claude-account', usageProvider: 'anthropic' })).toBe('anthropic');
  });

  // An older daemon has no such field and put the pi provider in `provider` itself. Reading it there is
  // exactly the rail that release drew; without it a CLI ahead of its daemon loses the limits section.
  it('falls back to `provider` when the daemon predates the public/internal split', () => {
    expect(usageProviderOf({ provider: 'openai-codex' })).toBe('openai-codex');
  });

  // A CURRENT daemon sends '' for a conversation with no live session. That is an answer — "nothing is
  // running, so no rail" — and must not collapse into the public config id, which names no pi provider.
  // Mutation: spell the fallback with `||` and this returns `ollama`, keying the rail on a config id.
  it('keeps an explicit empty string rather than falling back to the public id', () => {
    expect(usageProviderOf({ provider: 'ollama', usageProvider: '' })).toBe('');
    expect(usageProviderOf({})).toBe('');
  });
});

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

  it('joins multiple data: lines in one frame with newlines (SSE spec), not by concatenation', () => {
    const { frames } = parseSse('data: line1\ndata: line2\n\n');
    expect(frames).toEqual([{ event: undefined, data: 'line1\nline2' }]);
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

  // `surface: 'cli'` is what lets the daemon's activity feed tell a CLI turn from a web one: the two
  // post an otherwise identical body, so the client states which it is instead of the server sniffing
  // a header the client controls.
  it('send posts the text with the CLI working directory', async () => {
    const f = vi.fn(async () => j(200, { ok: true })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await c.send('hi');
    expect(f).toHaveBeenCalledWith('http://x/brain/send', expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'hi', cwd: process.cwd(), surface: 'cli' }) }));
  });

  it('send can pass the work mode', async () => {
    const f = vi.fn(async () => j(200, { ok: true })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await c.send('outline this first', 'plan');
    expect(f).toHaveBeenCalledWith('http://x/brain/send', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ text: 'outline this first', cwd: process.cwd(), surface: 'cli', mode: 'plan' }),
    }));
  });

  it('returns the daemon matched flag when answering a parked question', async () => {
    const f = vi.fn(async () => j(200, { ok: true, matched: false })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });

    await expect(c.answer('ask-1', [{ header: 'Choice', selected: ['A'] }])).resolves.toBe(false);
    expect(f).toHaveBeenCalledWith('http://x/brain/answer', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ id: 'ask-1', answers: [{ header: 'Choice', selected: ['A'] }] }),
    }));
  });

  it('interruptQueued binds the interrupt to the current CLI generation', async () => {
    const f = vi.fn(async (url: string) => url.endsWith('/brain/start')
      ? j(201, { sessionId: 'brain-1' })
      : j(200, { interrupted: true, injected: true })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
    await c.start({ session: 'brain-1' });

    await expect(c.interruptQueued()).resolves.toEqual({ interrupted: true, injected: true });
    expect(f).toHaveBeenLastCalledWith('http://x/brain/interrupt-queued', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ session: 'brain-1', client: 'cli-a', generation: 1 }),
    }));
  });

  it('backgrounds foreground sub-agents with the current CLI generation', async () => {
    const f = vi.fn(async (url: string) => url.endsWith('/brain/start')
      ? j(201, { sessionId: 'brain-1' })
      : j(200, { detached: 1 })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
    await c.start({ session: 'brain-1' });

    await expect(c.backgroundSubagents()).resolves.toEqual({ detached: 1 });
    expect(f).toHaveBeenLastCalledWith('http://x/brain/subagents/background', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ session: 'brain-1', client: 'cli-a', generation: 1 }),
    }));
  });

  it('backgrounds a foreground command with the current CLI generation', async () => {
    const f = vi.fn(async (url: string) => url.endsWith('/brain/start')
      ? j(201, { sessionId: 'brain-1' })
      : j(200, { detached: 1 })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
    await c.start({ session: 'brain-1' });

    await expect(c.backgroundCommands()).resolves.toEqual({ detached: 1 });
    expect(f).toHaveBeenLastCalledWith('http://x/brain/commands/background', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ session: 'brain-1', client: 'cli-a', generation: 1 }),
    }));
  });

  it('kills foreground commands with the current CLI generation, and unfenced after a stop', async () => {
    const f = vi.fn(async (url: string) => url.endsWith('/brain/start')
      ? j(201, { sessionId: 'brain-1' })
      : j(200, { killed: 1 })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
    await c.start({ session: 'brain-1' });

    // The Esc escalation: the client is still attached, so the generation fence rides along.
    await expect(c.killCommands()).resolves.toEqual({ killed: 1 });
    expect(f).toHaveBeenLastCalledWith('http://x/brain/commands/kill', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ session: 'brain-1', client: 'cli-a', generation: 1 }),
    }));

    // The Ctrl+C escalation: stopSession already tombstoned this client's binding — a fenced request
    // would be rejected as stale, so the kill goes out with the session alone.
    await expect(c.killCommands({ afterStop: true })).resolves.toEqual({ killed: 1 });
    expect(f).toHaveBeenLastCalledWith('http://x/brain/commands/kill', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ session: 'brain-1' }),
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
      body: JSON.stringify({ text: 'bound turn', cwd: process.cwd(), surface: 'cli', session: 'brain-7', client: 'cli-a', generation: 1 }),
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
    let streamSignal: AbortSignal | null | undefined;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/brain/start')) return j(201, { sessionId: 'brain-7' });
      if (url.includes('/brain/stream')) {
        streamSignal = init?.signal;
        return new Response(streamBody, { status: 200 });
      }
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(streamSignal).not.toBe(streamAc.signal);
    expect(streamSignal?.aborted).toBe(true);

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
      windows: [
        { usedPercent: 25, windowMinutes: 300, resetsAt: 1_900_000_000 },
        { usedPercent: 60, windowMinutes: 10_080, resetsAt: 1_900_500_000 },
      ],
    };
    f.mockImplementation(async () => j(200, limits) as Response);
    expect(await c.rateLimits()).toEqual(limits);
    expect(f).toHaveBeenLastCalledWith('http://x/brain/rate-limits?session=brain-9', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer t' }),
    }));
  });

  it('reads rate-limit windows for every provider without binding them to the parent session', async () => {
    const f = vi.fn(async () => j(200, {
      'openai-codex': { provider: 'openai-codex', planType: 'team', fetchedAt: 123, stale: false, windows: [] },
      anthropic: { provider: 'anthropic', planType: 'max', fetchedAt: 124, stale: false, windows: [] },
    })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });

    await expect(c.rateLimitsAll()).resolves.toEqual(expect.objectContaining({
      'openai-codex': expect.objectContaining({ planType: 'team' }),
      anthropic: expect.objectContaining({ planType: 'max' }),
    }));
    expect(f).toHaveBeenLastCalledWith('http://x/brain/rate-limits/all', expect.objectContaining({
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

  it('updateSessionTask PATCHes a bare status exactly as it always did, and a patch object whole', async () => {
    const f = vi.fn(async () => j(201, { sessionId: 'brain-9' })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await c.start();
    f.mockImplementation(async () => j(200, { task: { id: '4' }, tasks: [] }) as Response);

    await c.updateSessionTask('4', 'completed');
    expect(f).toHaveBeenLastCalledWith('http://x/plugins/todo/api/task?session=brain-9', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ taskId: '4', status: 'completed' }),
    }));

    await c.updateSessionTask('4', { subject: 'Ship it', owner: null });
    expect(f).toHaveBeenLastCalledWith('http://x/plugins/todo/api/task?session=brain-9', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ taskId: '4', subject: 'Ship it', owner: null }),
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

  it('queueRecall POSTs /brain/queue/recall and returns the popped text (no session suffix before start)', async () => {
    const f = vi.fn(async () => j(200, { text: 'the recalled message' })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    const out = await c.queueRecall();
    expect(out).toEqual({ text: 'the recalled message' });
    expect(f).toHaveBeenCalledWith('http://x/brain/queue/recall', expect.objectContaining({ method: 'POST' }));
  });

  it('queueRecall appends the bound session id once start() resolved one', async () => {
    const f = vi.fn(async () => j(201, { sessionId: 'brain-7' })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    await c.start();
    f.mockImplementation(async () => j(200, { text: null }) as Response);
    await c.queueRecall();
    expect(f).toHaveBeenCalledWith('http://x/brain/queue/recall?session=brain-7', expect.objectContaining({ method: 'POST' }));
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
    let streamSignal: AbortSignal | null | undefined;
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      streamSignal = init?.signal;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    const ac = new AbortController();
    const seen: unknown[] = [];
    await c.stream((event) => { seen.push(event); ac.abort(); }, ac.signal, 5, undefined, 'brain-ch-subagent-a', true);
    expect(f).toHaveBeenCalledWith(
      'http://x/brain/stream?session=brain-ch-subagent-a&snapshot=1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(streamSignal).not.toBe(ac.signal);
    expect(streamSignal?.aborted).toBe(true);
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

  it('reconnects a half-open bound stream, rebinds from its snapshot, and aborts the recovered session', async () => {
    vi.useFakeTimers();
    try {
      let streamAttempts = 0;
      let abortBody: Record<string, unknown> | undefined;
      let aborting: Promise<void> | undefined;
      const encoder = new TextEncoder();
      const f = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/brain/start')) return j(201, { sessionId: 'brain-old' });
        if (url.endsWith('/brain/abort')) {
          abortBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return j(200, { ok: true });
        }
        streamAttempts++;
        const attempt = streamAttempts;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (attempt === 1) {
              // The dead TCP path never closes or emits another byte. Only aborting this attempt can release
              // reader.read(), which is exactly the production half-open connection this test reproduces.
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason ?? new Error('aborted')), { once: true });
              return;
            }
            controller.enqueue(encoder.encode('event: snapshot\ndata: {"type":"snapshot","sessionId":"brain-fresh","cursor":8,"history":[{"role":"assistant","text":"finished while disconnected"}],"events":[{"type":"idle"}],"control":{"streaming":false,"pendingAsk":null}}\n\n'));
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch;
      const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f, clientId: 'cli-a' });
      await c.start();
      const lifecycle = new AbortController();
      const streaming = c.stream((frame) => {
        if (frame.type !== 'snapshot') return;
        aborting = c.abort();
        lifecycle.abort();
      }, lifecycle.signal, 1, undefined, undefined, true);

      await vi.advanceTimersByTimeAsync(BRAIN_STREAM_SILENCE_LIMIT_MS + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(streamAttempts).toBe(2);
      await streaming.catch(() => {});
      await aborting;

      expect(c.boundSession).toBe('brain-fresh');
      expect(abortBody).toEqual({ session: 'brain-fresh' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one stream alive through more than ten minutes of a silent model request when heartbeats arrive', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const f = vi.fn(async (_url: string, init?: RequestInit) => {
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': connected\n\n'));
            heartbeat = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 30_000);
            init?.signal?.addEventListener('abort', () => {
              if (heartbeat) clearInterval(heartbeat);
              controller.error(init.signal?.reason ?? new Error('aborted'));
            }, { once: true });
          },
        });
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch;
      const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
      const lifecycle = new AbortController();
      const streaming = c.stream(() => {}, lifecycle.signal, 1);
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      expect(f).toHaveBeenCalledTimes(1);

      lifecycle.abort();
      await streaming.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
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

});

// The brand payload comes over the wire from a possibly foreign daemon and lands in raw terminal
// output (TopRule, notices, ask-dock titles) — every pin below guards the CLI-side boundary, because
// the daemon's own sanitization must not be TRUSTED from here.
describe('publicBrand', () => {
  const brandResponse = (over: Record<string, unknown> = {}) =>
    j(200, { brand: { agentName: 'Acme Bot', productName: 'Acme' }, v: 'a'.repeat(16), ...over });

  it('parses a themed payload and derives themed from the PRODUCT actually being rebranded', async () => {
    const f = vi.fn(async () => brandResponse()) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    expect(await c.publicBrand()).toEqual({ agentName: 'Acme Bot', productName: 'Acme', themed: true, mascotArt: null });
  });

  it('a colors-only theme (brand left at Elowen) must NOT suppress the mascot', async () => {
    // `v` says a theme is active, but the product is still Elowen — keying `themed` off `v` here would
    // hide the flame and permanently disable /maskot for an install that only changed colors.
    const f = vi.fn(async () => brandResponse({ brand: { agentName: 'Elowen', productName: 'Elowen' } })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    expect((await c.publicBrand()).themed).toBe(false);
  });

  it('strips control characters (terminal OSC injection) and caps length by code points', async () => {
    const f = vi.fn(async () => brandResponse({
      brand: { agentName: 'A\u001b]0;pwn\u0007cme', productName: '🦊'.repeat(90) },
    })) as unknown as typeof fetch;
    const c = new BrainClient({ base: 'http://x', token: 't', fetchImpl: f });
    const brand = await c.publicBrand();
    expect(brand.agentName).toBe('A]0;pwncme');
    // 80 code points, and no LONE surrogate anywhere (String#slice would halve the emoji at the cut —
    // spread yields a halved pair as a single-unit surrogate "character", a whole pair as two units).
    const points = [...brand.productName];
    expect(points).toHaveLength(80);
    expect(points.every((ch) => !/^[\uD800-\uDFFF]$/.test(ch))).toBe(true);
  });

  it('falls back to the built-in brand on a non-OK answer and on a network failure', async () => {
    const notFound = vi.fn(async () => j(404, {})) as unknown as typeof fetch;
    expect(await new BrainClient({ base: 'http://x', token: 't', fetchImpl: notFound }).publicBrand())
      .toEqual({ agentName: 'Elowen', productName: 'Elowen', themed: false, mascotArt: null });
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await new BrainClient({ base: 'http://x', token: 't', fetchImpl: down }).publicBrand())
      .toEqual({ agentName: 'Elowen', productName: 'Elowen', themed: false, mascotArt: null });
  });

  // The CLI art travels on the same boot budget as the brand and is the one payload field that lands in
  // the terminal as commands rather than as text, so both its fetch and its rejection are pinned here.
  describe('mascot art', () => {
    const ART = '\x1b[38;2;1;2;3m▀\x1b[0m';
    const artUrl = `/public/theme/assets/mascot.ans?v=${'a'.repeat(16)}`;
    const serving = (assets: Record<string, unknown>, art = ART) => vi.fn(async (url: unknown) =>
      String(url).includes('mascot.ans')
        ? new Response(art, { status: 200 })
        : brandResponse({ assets })) as unknown as typeof fetch;

    it('fetches and parses the art a themed instance advertises', async () => {
      const f = serving({ cliMascot: artUrl });
      const brand = await new BrainClient({ base: 'http://x', token: 't', fetchImpl: f }).publicBrand();
      expect(brand.mascotArt).toHaveLength(1);
      expect(brand.mascotArt![0]).toContain('▀');
    });

    it('ignores a payload path pointing anywhere but the art asset', async () => {
      // The payload must not be able to steer this fetch at another daemon route.
      for (const path of ['/config', `/public/theme/assets/icon.png?v=${'a'.repeat(16)}`, 'http://evil/x.ans', artUrl.replace('?v=aaaaaaaaaaaaaaaa', '')]) {
        const f = serving({ cliMascot: path });
        expect((await new BrainClient({ base: 'http://x', token: 't', fetchImpl: f }).publicBrand()).mascotArt).toBeNull();
      }
    });

    it('drops art that violates the grammar instead of writing it to the terminal', async () => {
      const f = serving({ cliMascot: artUrl }, '\x1b]52;c;cHduZWQ=\x07');
      expect((await new BrainClient({ base: 'http://x', token: 't', fetchImpl: f }).publicBrand()).mascotArt).toBeNull();
    });

    it('survives an art fetch that fails, keeping the brand it already resolved', async () => {
      const f = vi.fn(async (url: unknown) => {
        if (String(url).includes('mascot.ans')) throw new Error('ECONNRESET');
        return brandResponse({ assets: { cliMascot: artUrl } });
      }) as unknown as typeof fetch;
      const brand = await new BrainClient({ base: 'http://x', token: 't', fetchImpl: f }).publicBrand();
      expect(brand.productName).toBe('Acme');
      expect(brand.mascotArt).toBeNull();
    });
  });

  it('carries a hard timeout so a hanging daemon cannot hold the boot batch', async () => {
    let signal: AbortSignal | undefined;
    const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return brandResponse();
    }) as unknown as typeof fetch;
    await new BrainClient({ base: 'http://x', token: 't', fetchImpl: f }).publicBrand();
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
