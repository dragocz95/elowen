import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET, POST } from '../../../app/api/[...path]/route';

const fetchMock = vi.fn();
beforeEach(() => { process.env.ELOWEN_DAEMON_URL = 'http://daemon.test'; vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

describe('proxy catch-all', () => {
  it('forwards GET with bearer injected from the cookie', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([{ id: 't1' }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const req = new Request('https://web.test/api/tasks?project_id=2', { headers: { cookie: 'elowen_session=tok' } });
    const res = await GET(req, ctx(['tasks']));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://daemon.test/tasks?project_id=2');
    expect((init.headers as Headers).get('authorization')).toBe('Bearer tok');
    expect((init.headers as Headers).get('cookie')).toBeNull();
  });

  it('returns 401 without calling the daemon when the cookie is missing', async () => {
    const req = new Request('https://web.test/api/tasks');
    const res = await GET(req, ctx(['tasks']));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a mutating request from a foreign origin with 403', async () => {
    const req = new Request('https://web.test/api/tasks', { method: 'POST', headers: { cookie: 'elowen_session=tok', origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' });
    const res = await POST(req, ctx(['tasks']));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the cookie when the daemon answers 401', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    const req = new Request('https://web.test/api/tasks', { headers: { cookie: 'elowen_session=stale' } });
    const res = await GET(req, ctx(['tasks']));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('forwards a mutating body as raw bytes (binary-safe avatar upload, not UTF-8 mangled)', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    // Bytes that are NOT valid UTF-8 — exactly what a JPEG contains. Decoding via req.text() would
    // replace them with U+FFFD and inflate the body; arrayBuffer() must preserve them exactly.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x80, 0xfe, 0x42]);
    const req = new Request('https://web.test/api/auth/me/avatar', {
      method: 'POST',
      headers: { cookie: 'elowen_session=tok', origin: 'https://web.test', 'content-type': 'multipart/form-data; boundary=x' },
      body: bytes,
    });
    const res = await POST(req, ctx(['auth', 'me', 'avatar']));
    expect(res.status).toBe(200);
    const sent = new Uint8Array(fetchMock.mock.calls[0][1].body as ArrayBuffer);
    expect(Array.from(sent)).toEqual(Array.from(bytes));
  });

  it('rejects a path-traversal segment with 400 without calling the daemon', async () => {
    const req = new Request('https://web.test/api/tasks', { headers: { cookie: 'elowen_session=tok' } });
    const res = await GET(req, ctx(['..', '..', 'admin']));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never echoes an upstream Set-Cookie back to the browser', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'set-cookie': 'daemon_sess=leak; Path=/' } }));
    const req = new Request('https://web.test/api/tasks', { headers: { cookie: 'elowen_session=tok' } });
    const res = await GET(req, ctx(['tasks']));
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
