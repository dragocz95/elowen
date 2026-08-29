import { describe, it, expect, beforeEach } from 'vitest';
import {
  COOKIE_NAME,
  SECURE_COOKIE_NAME,
  clearCookie,
  daemonUrl,
  forwardHeaders,
  isHttps,
  isSameOrigin,
  jsonError,
  namedCookie,
  readCookieHeader,
  readNamedCookie,
  requireSameOrigin,
  sessionCookie,
  tokenFromCookie,
} from '../../lib/proxy';

describe('proxy helpers', () => {
  beforeEach(() => { delete process.env.ELOWEN_DAEMON_URL; });

  it('daemonUrl falls back to localhost:4400', () => {
    expect(daemonUrl()).toBe('http://localhost:4400');
    process.env.ELOWEN_DAEMON_URL = 'http://localhost:9999';
    expect(daemonUrl()).toBe('http://localhost:9999');
  });

  it('sessionCookie is host-locked on HTTPS and remains usable on direct HTTP', () => {
    const secure = sessionCookie('tok123', true, 30 * 86400);
    expect(secure).toContain(`${SECURE_COOKIE_NAME}=tok123`);
    expect(secure).toMatch(/HttpOnly/);
    expect(secure).toMatch(/Secure/);
    expect(secure).toMatch(/SameSite=Lax/);
    expect(secure).toMatch(/Path=\//);
    expect(secure).not.toMatch(/Domain=/i);
    // Persisted for the token's TTL, not a session cookie the browser drops on close/suspend.
    expect(secure).toMatch(/Max-Age=2592000/);

    // `__Host-` requires Secure, so a localhost/IP deployment retains the legacy name and attributes.
    const insecure = sessionCookie('tok123', false, 7 * 86400);
    expect(insecure).toContain(`${COOKIE_NAME}=tok123`);
    expect(insecure).toMatch(/HttpOnly/);
    expect(insecure).not.toMatch(/Secure/);
    expect(insecure).toMatch(/Max-Age=604800/);
  });

  it('clearCookie expires the authoritative name for the current transport', () => {
    expect(clearCookie(true)).toContain(`${SECURE_COOKIE_NAME}=;`);
    expect(clearCookie(true)).toMatch(/Max-Age=0/);
    expect(clearCookie(true)).toMatch(/Secure/);
    expect(clearCookie(false)).toContain(`${COOKIE_NAME}=;`);
    expect(clearCookie(false)).not.toMatch(/Secure/);
  });

  it('named authority cookies are also host-locked on HTTPS', () => {
    expect(namedCookie('elowen_return', 'admin-token', true, 60)).toContain('__Host-elowen_return=admin-token');
    expect(namedCookie('elowen_return', 'admin-token', false, 60)).toContain('elowen_return=admin-token');
  });

  it('treats a malformed encoded cookie as absent instead of throwing from every BFF route', () => {
    expect(readCookieHeader('other=1; elowen_session=%E0%A4%A', 'elowen_session')).toBeNull();
  });

  it('isHttps reads X-Forwarded-Proto from the reverse proxy', () => {
    expect(isHttps(new Request('http://web/api/x', { headers: { 'x-forwarded-proto': 'https' } }))).toBe(true);
    expect(isHttps(new Request('http://web/api/x', { headers: { 'x-forwarded-proto': 'http' } }))).toBe(false);
    expect(isHttps(new Request('http://web/api/x'))).toBe(false);
    // Some proxies chain values ("https, http"); the client-facing (first) scheme wins.
    expect(isHttps(new Request('http://web/api/x', { headers: { 'x-forwarded-proto': 'https, http' } }))).toBe(true);
  });

  it('isSameOrigin: no Origin header is allowed', () => {
    expect(isSameOrigin(new Request('https://web.example/api/tasks'))).toBe(true);
  });

  it('isSameOrigin: matching Origin allowed, foreign rejected', () => {
    const ok = new Request('https://web.example/api/tasks', { headers: { Origin: 'https://web.example' } });
    const bad = new Request('https://web.example/api/tasks', { headers: { Origin: 'https://evil.example' } });
    expect(isSameOrigin(ok)).toBe(true);
    expect(isSameOrigin(bad)).toBe(false);
  });

  it('isSameOrigin: matches by host across scheme (behind a TLS-terminating proxy)', () => {
    // nginx terminates TLS and forwards to the app over plain http, so the app sees http://host
    // internally while the browser's Origin is https://host. The host must still match.
    const proxied = new Request('http://web.example/api/auth/login', { headers: { Origin: 'https://web.example' } });
    expect(isSameOrigin(proxied)).toBe(true);
    const foreign = new Request('http://web.example/api/auth/login', { headers: { Origin: 'https://evil.example' } });
    expect(isSameOrigin(foreign)).toBe(false);
  });

  it('forwardHeaders strips cookie/host/connection', () => {
    const h = forwardHeaders(new Request('https://web.example/api/x', {
      headers: { cookie: 'elowen_session=t', host: 'web.example', 'content-type': 'application/json' },
    }));
    expect(h.get('cookie')).toBeNull();
    expect(h.get('host')).toBeNull();
    expect(h.get('content-type')).toBe('application/json');
  });

  it('forwardHeaders drops client-supplied auth and forwarded-for headers, but carries the proxy x-real-ip', () => {
    const h = forwardHeaders(new Request('https://web.example/api/x', {
      headers: {
        authorization: 'Bearer attacker-token',
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '203.0.113.7',
        forwarded: 'for=1.2.3.4',
        'x-forwarded-host': 'evil.example',
        accept: 'application/json',
        range: 'bytes=1024-2047',
      },
    }));
    expect(h.get('authorization')).toBeNull();
    // The client writes these two itself, so forwarding them would hand anyone the ability to choose
    // the address the daemon rate-limits and attributes spend by.
    expect(h.get('x-forwarded-for')).toBeNull();
    expect(h.get('forwarded')).toBeNull();
    expect(h.get('x-forwarded-host')).toBeNull();
    // x-real-ip is the exception, and only because nginx OVERWRITES it with the real peer. Whether to
    // believe it is the daemon's call (security.trustProxy), not this layer's — but without forwarding
    // it the daemon sees no origin at all for anything that comes through the web app.
    expect(h.get('x-real-ip')).toBe('203.0.113.7');
    // Legitimate content-negotiation headers still pass through.
    expect(h.get('accept')).toBe('application/json');
    expect(h.get('range')).toBe('bytes=1024-2047');
    // accept-encoding is not forwarded: daemon<->proxy runs over localhost so compression buys
    // nothing, and keeping it out avoids any gzip/SSE streaming edge case.
    const enc = forwardHeaders(new Request('https://web.example/api/x', { headers: { 'accept-encoding': 'gzip, br' } }));
    expect(enc.get('accept-encoding')).toBeNull();
  });

  it('tokenFromCookie reads the name authoritative for the transport', () => {
    const directHttp = new Request('http://web.example/api/x', { headers: { cookie: `other=1; ${COOKIE_NAME}=abc123; x=2` } });
    expect(tokenFromCookie(directHttp)).toBe('abc123');

    const proxiedHttps = new Request('http://web.example/api/x', {
      headers: { 'x-forwarded-proto': 'https', cookie: `${COOKIE_NAME}=ATTACKER; ${SECURE_COOKIE_NAME}=real-secure` },
    });
    expect(tokenFromCookie(proxiedHttps)).toBe('real-secure');
    expect(tokenFromCookie(new Request('https://web.example/api/x'))).toBeNull();
  });

  it('HTTPS never falls back to a sibling-settable legacy session cookie', () => {
    const attackerOnly = new Request('http://web.example/api/x', {
      headers: { 'x-forwarded-proto': 'https', cookie: `${COOKIE_NAME}=ATTACKER` },
    });
    expect(tokenFromCookie(attackerOnly)).toBeNull();

    const named = new Request('http://web.example/api/x', {
      headers: { 'x-forwarded-proto': 'https', cookie: 'elowen_return=ATTACKER; __Host-elowen_return=REAL' },
    });
    expect(readNamedCookie(named, 'elowen_return')).toBe('REAL');
  });

  // A cookie whose name merely ENDS with ours must not win the match either.
  it('tokenFromCookie ignores a cookie whose name only ends with the direct-HTTP session name', () => {
    const shadowed = new Request('http://web.example/api/x', {
      headers: { cookie: `x${COOKIE_NAME}=ATTACKER; ${COOKIE_NAME}=REAL` },
    });
    expect(tokenFromCookie(shadowed)).toBe('REAL');

    const onlyShadow = new Request('http://web.example/api/x', { headers: { cookie: `x${COOKIE_NAME}=ATTACKER` } });
    expect(tokenFromCookie(onlyShadow)).toBeNull();
  });

  it('jsonError returns a JSON { error } body with the given status', async () => {
    const res = jsonError('forbidden', 403);
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('requireSameOrigin returns null same-origin and a 403 cross-origin', async () => {
    const same = new Request('https://web.example/api/x', { method: 'POST', headers: { origin: 'https://web.example', host: 'web.example' } });
    expect(requireSameOrigin(same)).toBeNull();
    const cross = new Request('https://web.example/api/x', { method: 'POST', headers: { origin: 'https://evil.example', host: 'web.example' } });
    const blocked = requireSameOrigin(cross);
    expect(blocked?.status).toBe(403);
    expect(await blocked!.json()).toEqual({ error: 'forbidden' });
  });
});
