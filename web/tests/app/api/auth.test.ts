import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST as login } from '../../../app/api/auth/login/route';
import { POST as logout } from '../../../app/api/auth/logout/route';
import { POST as impersonate } from '../../../app/api/auth/impersonate/route';
import { POST as stopImpersonating } from '../../../app/api/auth/stop-impersonate/route';

const fetchMock = vi.fn();
beforeEach(() => { process.env.ELOWEN_DAEMON_URL = 'http://daemon.test'; vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

function post(url: string, body: unknown) {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://web.test' }, body: JSON.stringify(body) });
}

describe('auth login route', () => {
  it('sets a host-locked httpOnly session cookie over HTTPS and returns no token in the body', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 'secret-tok' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const req = post('https://web.test/api/auth/login', { username: 'admin', password: 'x' });
    req.headers.set('x-forwarded-proto', 'https');
    const res = await login(req);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-elowen_session=secret-tok');
    expect(setCookie).toMatch(/HttpOnly/);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain('secret-tok');
  });

  it('persists the cookie for the daemon-reported token TTL (not a session cookie)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 't', tokenTtlDays: 7 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const setCookie = (await login(post('https://web.test/api/auth/login', { username: 'admin', password: 'x' }))).headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/Max-Age=604800/); // 7 days in seconds
  });

  it('falls back to a 30-day cookie when an older daemon omits the TTL', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 't' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const setCookie = (await login(post('https://web.test/api/auth/login', { username: 'admin', password: 'x' }))).headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/Max-Age=2592000/); // 30 days in seconds
  });

  it('marks the cookie Secure behind HTTPS but not over plain HTTP (IP:4500 / localhost)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 't' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const httpsReq = new Request('http://web.test/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://web.test', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ username: 'admin', password: 'x' }),
    });
    expect((await login(httpsReq)).headers.get('set-cookie') ?? '').toMatch(/Secure/);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 't' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const httpReq = new Request('http://web.test/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test' },
      body: JSON.stringify({ username: 'admin', password: 'x' }),
    });
    expect((await login(httpReq)).headers.get('set-cookie') ?? '').not.toMatch(/Secure/);
  });

  it('propagates a daemon auth failure without setting a cookie', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'bad credentials' }), { status: 401 }));
    const res = await login(post('https://web.test/api/auth/login', { username: 'admin', password: 'wrong' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a cross-origin login (login CSRF) without calling the daemon', async () => {
    const req = new Request('https://web.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
      body: JSON.stringify({ username: 'admin', password: 'x' }),
    });
    const res = await login(req);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the trusted x-real-ip to the daemon so its login rate-limit keys per-source', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 't' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const req = new Request('https://web.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://web.test', 'x-real-ip': '203.0.113.7' },
      body: JSON.stringify({ username: 'admin', password: 'x' }),
    });
    await login(req);
    // Built by the shared forwardHeaders allow-list now, so this asserts the guarantee through the one
    // helper every proxied request goes through rather than through a hand-built header record.
    const init = fetchMock.mock.calls[0][1] as { headers: Headers };
    expect(init.headers.get('x-real-ip')).toBe('203.0.113.7');
    expect(init.headers.get('content-type')).toBe('application/json');
  });

  it('returns 502 (not a crash) when the daemon returns a non-JSON 200', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }));
    const res = await login(post('https://web.test/api/auth/login', { username: 'admin', password: 'x' }));
    expect(res.status).toBe(502);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('auth logout route', () => {
  it('expires the cookie', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const req = new Request('https://web.test/api/auth/logout', { method: 'POST', headers: { origin: 'https://web.test', cookie: 'elowen_session=secret-tok' } });
    const res = await logout(req);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('cancels an impersonation proof before clearing cookies', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const req = new Request('https://web.test/api/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://web.test',
        cookie: 'elowen_session=target-token; elowen_return=opaque-return-proof; elowen_as=target',
      },
    });
    const res = await logout(req);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://daemon.test/auth/impersonation/cancel');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer target-token');
    expect(JSON.parse(String(init.body))).toEqual({ returnCode: 'opaque-return-proof' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.headers.getSetCookie().filter((cookie) => /Max-Age=0/.test(cookie))).toHaveLength(3);
  });

  it('rejects a cross-origin logout (logout CSRF)', async () => {
    const req = new Request('https://web.test/api/auth/logout', { method: 'POST', headers: { origin: 'https://evil.test', cookie: 'elowen_session=secret-tok' } });
    const res = await logout(req);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('auth impersonation routes', () => {
  it('stores only the daemon-issued opaque return proof in the browser', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      token: 'target-token',
      returnCode: 'opaque-return-proof',
      tokenTtlDays: 7,
      user: { username: 'target' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const req = post('https://web.test/api/auth/impersonate', { userId: 2 });
    req.headers.set('x-forwarded-proto', 'https');
    req.headers.set('cookie', '__Host-elowen_session=admin-token');

    const res = await impersonate(req);
    const cookies = res.headers.getSetCookie();
    expect(res.status).toBe(200);
    expect(cookies).toHaveLength(3);
    expect(cookies.find((cookie) => cookie.startsWith('__Host-elowen_session='))).toContain('target-token');
    expect(cookies.find((cookie) => cookie.startsWith('__Host-elowen_return='))).toContain('opaque-return-proof');
    expect(cookies.join('\n')).not.toContain('admin-token');
    expect(cookies.every((cookie) => /SameSite=Lax/.test(cookie) && /Path=\//.test(cookie) && /Secure/.test(cookie))).toBe(true);
  });

  it('leaves the current session untouched when the daemon refuses the transition', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const req = post('https://web.test/api/auth/impersonate', { userId: 2 });
    req.headers.set('cookie', 'elowen_session=admin-token');
    const res = await impersonate(req);
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('exchanges the active target session and opaque proof for a fresh admin session', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 'fresh-admin-token', tokenTtlDays: 9, user: { username: 'admin' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const req = new Request('https://web.test/api/auth/stop-impersonate', {
      method: 'POST',
      headers: {
        origin: 'https://web.test',
        cookie: 'elowen_session=target-token; elowen_return=opaque-return-proof; elowen_as=target',
      },
    });

    const res = await stopImpersonating(req);
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://daemon.test/auth/impersonation/stop');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer target-token');
    expect(JSON.parse(String(init.body))).toEqual({ returnCode: 'opaque-return-proof' });
    const cookies = res.headers.getSetCookie();
    expect(cookies.find((cookie) => cookie.startsWith('elowen_session='))).toContain('fresh-admin-token');
    expect(cookies.filter((cookie) => /Max-Age=0/.test(cookie))).toHaveLength(2);
  });
});
