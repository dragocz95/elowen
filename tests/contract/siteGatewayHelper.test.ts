import { describe, expect, it } from 'vitest';
// The installed root helper is deliberately standalone ESM: it cannot import service-user-owned package
// code after sudo. This contract test imports its pure renderer directly and exercises the bytes shipped.
// @ts-expect-error the standalone deployment helper intentionally has no TypeScript declaration file
import {
  deploymentFrom, lineageFor, renderActiveConfig, renderDenyConfig, runtimeSocketPathFor,
} from '../../scripts/elowen-site-gateway.mjs';

const deployment = deploymentFrom({ appHost: 'agent.chetty.ai', daemonPort: 4400 });
const TOKEN = 'a'.repeat(43);

describe('root-owned published-sites gateway helper', () => {
  it('derives one fixed wildcard from the app host', () => {
    expect(deployment).toEqual({
      appHost: 'agent.chetty.ai',
      daemonPort: 4400,
      hostnameBase: 'sites.agent.chetty.ai',
    });
    expect(() => deploymentFrom({ appHost: 'sites.evil.test', daemonPort: 4400 })).toThrow();
    expect(() => deploymentFrom({ appHost: 'agent.chetty.ai', daemonPort: 80 })).toThrow();
  });

  it('derives a certificate lineage only from a safe slug', () => {
    expect(lineageFor(deployment, 'dashboard-abc123')).toBe('dashboard-abc123.sites.agent.chetty.ai');
    for (const bad of ['../etc', 'UPPER', 'a', 'has space', 'dot.dot', '']) {
      expect(() => lineageFor(deployment, bad)).toThrow(/slug/);
    }
  });

  it('derives runtime socket paths only from UUID site ids', () => {
    expect(runtimeSocketPathFor('123e4567-e89b-12d3-a456-426614174000'))
      .toBe('/var/lib/elowen/site-runtime-sockets/123e4567-e89b-12d3-a456-426614174000/app.sock');
    expect(() => runtimeSocketPathFor('../../run/daemon.sock')).toThrow(/site id/);
  });

  it('always serves the HTTP-01 challenge, so a first certificate can be issued at all', () => {
    // The challenge block covers the whole wildcard rather than one site: the CA calls back for a name
    // whose certificate does not exist yet, so a per-site block could not answer it.
    const empty = renderActiveConfig(deployment, TOKEN, []);
    expect(empty).toContain('server_name ~^[a-z0-9][a-z0-9-]{1,63}\\.sites\\.agent\\.chetty\\.ai$');
    expect(empty).toContain('location /.well-known/acme-challenge/');
    expect(empty).toContain('root /var/lib/elowen/site-acme/webroot;');
    expect(empty).toContain('return 308 https://$host$request_uri;');
    expect(empty).not.toContain('proxy_pass');
    expect(empty).not.toContain('listen 443 ssl;');
  });

  it('gives every site its own server block, certificate and fixed upstream slug', () => {
    const config = renderActiveConfig(deployment, TOKEN, ['beta', 'alpha']);

    // Sorted and de-duplicated, so the same set of sites always renders the same bytes and a no-op
    // sync does not churn nginx.
    expect(config.indexOf('server_name alpha.')).toBeLessThan(config.indexOf('server_name beta.'));
    expect(renderActiveConfig(deployment, TOKEN, ['alpha', 'beta', 'alpha'])).toBe(config);

    for (const slug of ['alpha', 'beta']) {
      expect(config).toContain(`server_name ${slug}.sites.agent.chetty.ai;`);
      expect(config).toContain(`ssl_certificate /var/lib/elowen/site-acme/config/live/${slug}.sites.agent.chetty.ai/fullchain.pem;`);
      // The slug is baked into the upstream rather than captured from Host: nginx already proved which
      // certificate matched, so there is no request-derived value left to trust here.
      expect(config).toContain(`proxy_pass http://127.0.0.1:4400/hooks/sites/s/${slug}$request_uri;`);
    }
    expect(config).toContain('proxy_set_header X-Elowen-Site-Gateway "');
    expect(config).toContain('proxy_set_header Authorization "";');
    expect(config).not.toContain('$elowen_site_slug');
    expect(() => renderActiveConfig(deployment, TOKEN, ['../etc'])).toThrow(/slug/);
    expect(() => renderActiveConfig(deployment, 'short', ['alpha'])).toThrow(/token/);
  });

  it('keeps a deny tombstone instead of letting old hostnames fall into another vhost', () => {
    const tombstone = renderDenyConfig(deployment);
    expect(tombstone).toContain('listen 80;');
    expect(tombstone).toContain('return 410;');
    expect(tombstone).not.toContain('proxy_pass');
    // Nothing on 443: without a certificate there is nothing honest to answer with, and borrowing some
    // other site's certificate to say 410 would be worse than the TLS error a stale record deserves.
    expect(tombstone).not.toContain('listen 443 ssl;');
  });
});
