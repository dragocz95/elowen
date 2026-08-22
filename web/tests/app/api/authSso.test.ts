import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as start } from '../../../app/api/auth/sso/microsoft/start/route';
import { GET as callback } from '../../../app/api/auth/sso/microsoft/callback/route';
import { sessionCookie } from '../../../lib/proxy';

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.ELOWEN_DAEMON_URL = 'http://daemon.test';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

function request(path: string, cookie?: string): Request {
  return new Request(`https://web.test${path}`, {
    headers: {
      'x-forwarded-proto': 'https',
      ...(cookie ? { cookie } : {}),
    },
  });
}

function startResponse() {
  return new Response(JSON.stringify({
    flowId: 'flow-123',
    authorizationUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=abc',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function startBody(next: string): Promise<Record<string, unknown>> {
  fetchMock.mockResolvedValue(startResponse());
  await start(request(`/api/auth/sso/microsoft/start?next=${encodeURIComponent(next)}`));
  return JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
}

describe('Microsoft SSO start route', () => {
  it('rejects an absolute next URL', async () => {
    expect(await startBody('https://evil.tld')).toEqual({ next: '/' });
  });

  it('rejects a protocol-relative next URL', async () => {
    expect(await startBody('//evil.tld')).toEqual({ next: '/' });
  });

  it('rejects a backslash-normalized next URL', async () => {
    expect(await startBody('/\\evil.tld')).toEqual({ next: '/' });
  });

  it('keeps a safe relative path and stores the flow in a short-lived Lax cookie', async () => {
    fetchMock.mockResolvedValue(startResponse());
    const res = await start(request('/api/auth/sso/microsoft/start?next=%2Fdash%3Ftab%3Done'));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ next: '/dash?tab=one' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('login.microsoftonline.com');
    expect(res.headers.get('set-cookie')).toContain('elowen_sso=flow-123');
    expect(res.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=600');
  });
});

describe('Microsoft SSO callback route', () => {
  it('refuses to mint a session without the flow cookie', async () => {
    const res = await callback(request('/api/auth/sso/microsoft/callback?code=code&state=state'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?sso_error=state_expired');
    expect(res.headers.get('set-cookie')).toContain('elowen_sso=;');
    expect(res.headers.get('set-cookie')).not.toContain('elowen_session=');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints the same session cookie as password login, clears the flow cookie and restores daemon next', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      token: 'secret-token',
      tokenTtlDays: 7,
      next: '/dash?tab=one',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await callback(request(
      '/api/auth/sso/microsoft/callback?code=code&state=state',
      'elowen_sso=flow-123',
    ));
    const cookies = res.headers.get('set-cookie') ?? '';
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dash?tab=one');
    expect(cookies).toContain(sessionCookie('secret-token', true, 7 * 86400));
    expect(cookies).toContain('elowen_sso=; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=0');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      flowId: 'flow-123',
      state: 'state',
      code: 'code',
    });
  });

  it('turns a daemon 4xx into the matching error redirect without minting a session', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'already_linked' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }));

    const res = await callback(request(
      '/api/auth/sso/microsoft/callback?code=code&state=state',
      'elowen_sso=flow-123',
    ));
    const cookies = res.headers.get('set-cookie') ?? '';
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?sso_error=already_linked');
    expect(cookies).toContain('elowen_sso=;');
    expect(cookies).not.toContain('elowen_session=');
  });

  // Behind a reverse proxy Next resolves `req.url` to the server's own listen address, so an error
  // redirect built from it pointed the browser at `localhost:4500` — off the site, onto a host that
  // exists only inside the VM, and with the error code the login screen was meant to render lost on
  // the way. Every redirect this pair emits must therefore stay relative to the requested origin.
  it('keeps every error redirect relative so it lands on the host the user is actually on', async () => {
    const local = new Request('https://web.test/api/auth/sso/microsoft/callback?code=c&state=s', {
      headers: { 'x-forwarded-proto': 'https', host: 'localhost:4500' },
    });
    const fromCallback = await callback(local);
    expect(fromCallback.headers.get('location')).toBe('/?sso_error=state_expired');

    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    const fromStart = await start(request('/api/auth/sso/microsoft/start?next=%2F'));
    expect(fromStart.status).toBe(302);
    expect(fromStart.headers.get('location')).toBe('/?sso_error=sso_failed');
  });
});
