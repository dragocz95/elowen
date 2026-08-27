import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET, POST } from '../../../app/api/[...path]/route';

const fetchMock = vi.fn();
beforeEach(() => { process.env.ELOWEN_DAEMON_URL = 'http://daemon.test'; vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

describe('proxy catch-all', () => {
  it('forwards GET with bearer injected from the cookie', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([{ id: 't1' }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const req = new Request('https://web.test/api/projects?project_id=2', { headers: { cookie: 'elowen_session=tok' } });
    const res = await GET(req, ctx(['projects']));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://daemon.test/projects?project_id=2');
    expect((init.headers as Headers).get('authorization')).toBe('Bearer tok');
    expect((init.headers as Headers).get('cookie')).toBeNull();
  });

  it('forwards a tokenless request WITHOUT an Authorization header, letting the daemon guard decide', async () => {
    // No cookie → no bearer injected. The daemon is the sole auth guard (open in fresh-install setup mode,
    // 401 thereafter), so the proxy must forward rather than short-circuit — this is what keeps first-run
    // onboarding (GET /setup, first-admin POST /users) reachable before any session cookie exists.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ needsSetup: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const req = new Request('https://web.test/api/setup');
    const res = await GET(req, ctx(['setup']));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://daemon.test/setup');
    expect((init.headers as Headers).get('authorization')).toBeNull();
  });

  it('does not manufacture a cookie-clear on a tokenless 401 (there is no cookie to clear)', async () => {
    // A protected route on an already-set-up install answers 401 to a tokenless request; the clearCookie
    // path is gated on having had a token, so the pre-cookie onboarding window is not flipped to logout.
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    const req = new Request('https://web.test/api/projects');
    const res = await GET(req, ctx(['projects']));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a mutating request from a foreign origin with 403', async () => {
    const req = new Request('https://web.test/api/projects', { method: 'POST', headers: { cookie: 'elowen_session=tok', origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' });
    const res = await POST(req, ctx(['projects']));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the cookie when the daemon answers 401', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    const req = new Request('https://web.test/api/projects', { headers: { cookie: 'elowen_session=stale' } });
    const res = await GET(req, ctx(['projects']));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('streams a mutating body through, binary-exact and without buffering it', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    // Bytes that are NOT valid UTF-8 — exactly what a JPEG contains. Decoding via req.text() would
    // replace them with U+FFFD and inflate the body, so the transfer has to stay binary.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x80, 0xfe, 0x42]);
    const req = new Request('https://web.test/api/brain/uploads?name=x.jpg', {
      method: 'POST',
      headers: { cookie: 'elowen_session=tok', origin: 'https://web.test', 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    const res = await POST(req, ctx(['brain', 'uploads']));
    expect(res.status).toBe(200);

    const init = fetchMock.mock.calls[0][1] as { body: unknown; duplex?: string };
    // The body must travel as the request's own STREAM. Reading it into an ArrayBuffer first would hold
    // the whole upload in this process's heap, which is exactly the ceiling the upload path exists to
    // remove — and undici refuses a streamed body without `duplex: 'half'`.
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(init.duplex).toBe('half');

    // Still byte-for-byte what came in.
    const sent = new Uint8Array(await new Response(init.body as ReadableStream).arrayBuffer());
    expect(Array.from(sent)).toEqual(Array.from(bytes));
  });

  it('rejects a path-traversal segment with 400 without calling the daemon', async () => {
    const req = new Request('https://web.test/api/projects', { headers: { cookie: 'elowen_session=tok' } });
    const res = await GET(req, ctx(['..', '..', 'admin']));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-encodes a segment whose literal characters are URL syntax, so a Teams conversation id survives', async () => {
    // Next.js hands the segments over DECODED, and a Teams 1:1 conversation id ends in `#<n>`. Joining
    // them raw turned everything from the `#` into a fragment, which fetch never sends — the daemon got a
    // path missing both the tail of the id AND the route behind it, and answered 404. That is why
    // Settings → Data could not open the transcript of any Teams conversation.
    fetchMock.mockResolvedValue(new Response('{"items":[]}', { status: 200 }));
    const sessionId = 'brain-ch-msteams-a:1uAUssTAR-rJYOk6bvUIVuqo3uU#4';
    const req = new Request('https://web.test/api/brain/debug/sessions/x/legacy-transcript?limit=100', {
      headers: { cookie: 'elowen_session=tok' },
    });
    await GET(req, ctx(['brain', 'debug', 'sessions', sessionId, 'legacy-transcript']));
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.hash).toBe('');
    expect(url.pathname).toBe(`/brain/debug/sessions/${encodeURIComponent(sessionId)}/legacy-transcript`);
    // The daemon decodes the segment back to the id it stored, tail included.
    expect(decodeURIComponent(url.pathname.split('/')[4]!)).toBe(sessionId);
  });

  it('never echoes an upstream Set-Cookie back to the browser', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'set-cookie': 'daemon_sess=leak; Path=/' } }));
    const req = new Request('https://web.test/api/projects', { headers: { cookie: 'elowen_session=tok' } });
    const res = await GET(req, ctx(['projects']));
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
