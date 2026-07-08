import { describe, it, expect, beforeEach } from 'vitest';
import { daemonUrl, sessionCookie, clearCookie, isSameOrigin, isHttps, forwardHeaders, tokenFromCookie, jsonError, requireSameOrigin, COOKIE_NAME } from '../../lib/proxy';

describe('proxy helpers', () => {
  beforeEach(() => { delete process.env.ELOWEN_DAEMON_URL; });

  it('daemonUrl falls back to localhost:4400', () => {
    expect(daemonUrl()).toBe('http://localhost:4400');
    process.env.ELOWEN_DAEMON_URL = 'http://localhost:9999';
    expect(daemonUrl()).toBe('http://localhost:9999');
  });

  it('sessionCookie is httpOnly + lax, persisted via Max-Age, and Secure only over HTTPS', () => {
    const secure = sessionCookie('tok123', true, 30 * 86400);
    expect(secure).toContain(`${COOKIE_NAME}=tok123`);
    expect(secure).toMatch(/HttpOnly/);
    expect(secure).toMatch(/Secure/);
    expect(secure).toMatch(/SameSite=Lax/);
    // Persisted for the token's TTL, not a session cookie the browser drops on close/suspend.
    expect(secure).toMatch(/Max-Age=2592000/);
    // Over plain HTTP the cookie must NOT be Secure, or the browser drops it (→ 401 after login).
    const insecure = sessionCookie('tok123', false, 7 * 86400);
    expect(insecure).toMatch(/HttpOnly/);
    expect(insecure).not.toMatch(/Secure/);
    expect(insecure).toMatch(/Max-Age=604800/);
  });

  it('clearCookie expires the cookie and matches the Secure attr', () => {
    expect(clearCookie(true)).toMatch(/Max-Age=0/);
    expect(clearCookie(true)).toContain(`${COOKIE_NAME}=;`);
    expect(clearCookie(true)).toMatch(/Secure/);
    expect(clearCookie(false)).not.toMatch(/Secure/);
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

  it('forwardHeaders drops client-supplied auth and forwarded-for headers (no smuggling/IP spoofing)', () => {
    const h = forwardHeaders(new Request('https://web.example/api/x', {
      headers: {
        authorization: 'Bearer attacker-token',
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '1.2.3.4',
        forwarded: 'for=1.2.3.4',
        'x-forwarded-host': 'evil.example',
        accept: 'application/json',
      },
    }));
    expect(h.get('authorization')).toBeNull();
    expect(h.get('x-forwarded-for')).toBeNull();
    expect(h.get('x-real-ip')).toBeNull();
    expect(h.get('forwarded')).toBeNull();
    expect(h.get('x-forwarded-host')).toBeNull();
    // Legitimate content-negotiation headers still pass through.
    expect(h.get('accept')).toBe('application/json');
    // accept-encoding is not forwarded: daemon<->proxy runs over localhost so compression buys
    // nothing, and keeping it out avoids any gzip/SSE streaming edge case.
    const enc = forwardHeaders(new Request('https://web.example/api/x', { headers: { 'accept-encoding': 'gzip, br' } }));
    expect(enc.get('accept-encoding')).toBeNull();
  });

  it('tokenFromCookie reads the session token from the cookie header, or null', () => {
    const withTok = new Request('https://web.example/api/x', { headers: { cookie: `other=1; ${COOKIE_NAME}=abc123; x=2` } });
    expect(tokenFromCookie(withTok)).toBe('abc123');
    expect(tokenFromCookie(new Request('https://web.example/api/x'))).toBeNull();
    expect(tokenFromCookie(new Request('https://web.example/api/x', { headers: { cookie: 'other=1' } }))).toBeNull();
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
