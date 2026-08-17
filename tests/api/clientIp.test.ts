import { describe, it, expect } from 'vitest';
import { clientOrigin, platformOrigin, INTERNAL_ORIGIN } from '../../src/api/clientIp.js';

/** A minimal stand-in for the Hono context the rule reads: just the headers. */
const ctx = (headers: Record<string, string>) => ({
  req: { header: (name: string) => headers[name.toLowerCase()] },
});

describe('clientOrigin', () => {
  it('prefers x-real-ip over x-forwarded-for', () => {
    // Our nginx overwrites x-real-ip with the real peer; x-forwarded-for is whatever the client typed.
    // Reading the client's header first would let anyone rewrite their own attribution.
    const o = clientOrigin(ctx({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.44, 10.0.0.1' }), true);
    expect(o).toEqual({ value: '203.0.113.7', kind: 'ip', trusted: true });
  });

  it('falls back to the first x-forwarded-for hop, always untrusted', () => {
    const o = clientOrigin(ctx({ 'x-forwarded-for': '198.51.100.44, 10.0.0.1' }), true);
    expect(o.value).toBe('198.51.100.44');
    expect(o.kind).toBe('ip');
    // Untrusted even with trustProxy on: the BFF refuses to forward this header, so anything that
    // arrives in it came from a client talking to the daemon directly.
    expect(o.trusted).toBe(false);
  });

  it('degrades x-real-ip to untrusted when trustProxy is off', () => {
    const o = clientOrigin(ctx({ 'x-real-ip': '203.0.113.7' }), false);
    expect(o.value).toBe('203.0.113.7');
    expect(o.trusted).toBe(false);
  });

  it('reports a loopback client with no forwarding header as local', () => {
    expect(clientOrigin(ctx({}), true)).toEqual({ value: 'local', kind: 'local', trusted: true });
    // A header present but empty is not an origin claim.
    expect(clientOrigin(ctx({ 'x-real-ip': '   ' }), true).kind).toBe('local');
  });

  it('names non-HTTP origins without inventing an IP', () => {
    expect(INTERNAL_ORIGIN).toEqual({ value: 'internal', kind: 'internal', trusted: true });
    expect(platformOrigin('discord')).toEqual({ value: 'platform:discord', kind: 'platform', trusted: true });
  });
});
