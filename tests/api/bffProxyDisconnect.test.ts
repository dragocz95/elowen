import { describe, it, expect, vi, afterEach } from 'vitest';
import { GET, POST } from '../../web/app/api/[...path]/route.js';

/** The catch-all BFF proxy is the single path every browser REST and SSE call takes to the daemon.
 *
 *  It is also the only place that knows the browser hung up: the daemon's SSE handlers wait on the
 *  request signal, and that signal can only fire if this proxy stops holding the upstream socket. When
 *  the disconnect was not forwarded, an abandoned live view left a socket on both sides and a streaming
 *  generator in the daemon with nothing to reclaim them — which is how a single stuck browser card ends
 *  up exhausting the browser's per-origin connection budget and the web process's file descriptors. */
const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });
const streamPath = ['plugins', 'browser', 'api', 'stream'];

afterEach(() => { vi.unstubAllGlobals(); });

describe('BFF catch-all proxy disconnect handling', () => {
  it('forwards the client abort signal to the daemon', async () => {
    const controller = new AbortController();
    let forwarded: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      forwarded = init.signal;
      return new Response('frame', { status: 200 });
    });

    const req = new Request('http://localhost:4500/api/plugins/browser/api/stream?sessionId=s1', {
      signal: controller.signal,
    });
    const res = await GET(req, ctx(streamPath));

    // Request wraps the signal it is given, so identity is the wrong assertion: what matters is that
    // the daemon call is tied to THIS request and actually observes the client going away.
    expect(forwarded).toBe(req.signal);
    expect(forwarded!.aborted).toBe(false);
    controller.abort();
    expect(forwarded!.aborted).toBe(true);
    expect(res.status).toBe(200);
  });

  it('answers a hung-up request as a client disconnect, not a server fault', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', async () => { throw new DOMException('The operation was aborted.', 'AbortError'); });

    const req = new Request('http://localhost:4500/api/plugins/browser/api/stream?sessionId=s1', {
      signal: controller.signal,
    });
    const res = await GET(req, ctx(streamPath));

    // 499 rather than 500: nothing failed server-side, and a closed tab must not log an error.
    expect(res.status).toBe(499);
  });

  it('still reports a genuine upstream failure', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('daemon unreachable'); });
    const req = new Request('http://localhost:4500/api/plugins/browser/api/session', { method: 'GET' });
    await expect(GET(req, ctx(['plugins', 'browser', 'api', 'session']))).rejects.toThrow(/daemon unreachable/);
  });

  it('forwards the signal on mutating routes too, so a takeover cannot outlive its caller', async () => {
    const controller = new AbortController();
    let forwarded: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      forwarded = init.signal;
      return new Response('{}', { status: 200 });
    });

    const req = new Request('http://localhost:4500/api/plugins/browser/api/takeover?sessionId=s1', {
      method: 'POST',
      headers: { origin: 'http://localhost:4500', host: 'localhost:4500' },
      signal: controller.signal,
    });
    const res = await POST(req, ctx(['plugins', 'browser', 'api', 'takeover']));

    expect(forwarded).toBe(req.signal);
    controller.abort();
    expect(forwarded!.aborted).toBe(true);
    expect(res.status).toBe(200);
  });
});
