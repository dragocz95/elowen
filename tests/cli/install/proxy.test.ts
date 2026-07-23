import { describe, it, expect } from 'vitest';
import { detectProxy, nginxVhost, apacheVhost, certbotCommand } from '../../../src/cli/install/proxy.js';
import type { Runner } from '../../../src/cli/install/runner.js';

function fakeRunner(present: string[]): Runner {
  return {
    which: async (cmd: string) => (present.includes(cmd) ? `/usr/sbin/${cmd}` : null),
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    writeFile: async () => {},
    exists: async () => false,
  };
}

describe('install/proxy.detectProxy', () => {
  it('prefers nginx when present', async () => {
    expect(await detectProxy(fakeRunner(['nginx']))).toBe('nginx');
  });
  it('detects apache (apache2)', async () => {
    expect(await detectProxy(fakeRunner(['apache2']))).toBe('apache');
  });
  it('returns null when neither is installed', async () => {
    expect(await detectProxy(fakeRunner([]))).toBeNull();
  });
});

describe('install/proxy vhost renderers', () => {
  it('nginx vhost proxies the domain to the web port and disables buffering for SSE', () => {
    const v = nginxVhost('elowen.example.com', 4500, 4400);
    expect(v).toContain('server_name elowen.example.com;');
    expect(v).toContain('proxy_pass http://127.0.0.1:4500;');
    expect(v).toMatch(/proxy_buffering off;/);
    expect(v).toMatch(/listen 80;/);
  });
  it('nginx vhost adds a /ws/ location upgrading to the daemon for the terminal stream', () => {
    const v = nginxVhost('elowen.example.com', 4500, 4400);
    expect(v).toContain('location /ws/ {');
    expect(v).toContain('proxy_pass http://127.0.0.1:4400;'); // daemon, not web
    expect(v).toContain('proxy_set_header Connection "upgrade";');
    // /ws/ must be declared before the catch-all / so nginx prefix-matches it first.
    expect(v.indexOf('location /ws/ {')).toBeLessThan(v.indexOf('location / {'));
  });
  it('nginx vhost forces no-cache on /sw.js (exact match) so the service worker never goes stale', () => {
    const v = nginxVhost('elowen.example.com', 4500, 4400);
    expect(v).toContain('location = /sw.js {');
    expect(v).toMatch(/Cache-Control "no-cache, no-store, must-revalidate"/);
    // The exact /sw.js match must precede the catch-all / so it wins.
    expect(v.indexOf('location = /sw.js {')).toBeLessThan(v.indexOf('location / {'));
  });
  it('apache vhost reverse-proxies with preserved host', () => {
    const v = apacheVhost('elowen.example.com', 4500, 4400);
    expect(v).toContain('ServerName elowen.example.com');
    expect(v).toContain('ProxyPass / http://127.0.0.1:4500/');
    expect(v).toContain('ProxyPreserveHost On');
  });
  it('both vhosts route /hooks/ plugin webhooks to the daemon before the catch-all', () => {
    const n = nginxVhost('elowen.example.com', 4500, 4400);
    expect(n).toContain('location /hooks/ {');
    expect(n).toMatch(/location \/hooks\/ \{\n\s+proxy_pass http:\/\/127\.0\.0\.1:4400;/);
    expect(n.indexOf('location /hooks/ {')).toBeLessThan(n.indexOf('location / {'));
    const a = apacheVhost('elowen.example.com', 4500, 4400);
    expect(a).toContain('ProxyPass /hooks/ http://127.0.0.1:4400/hooks/');
    expect(a.indexOf('ProxyPass /hooks/')).toBeLessThan(a.indexOf('ProxyPass / '));
  });
});

describe('install/proxy.certbotCommand', () => {
  it('uses the nginx plugin with redirect and a registered email', () => {
    const { cmd, args } = certbotCommand('nginx', 'elowen.example.com', 'me@x.com');
    expect(cmd).toBe('certbot');
    expect(args).toEqual(expect.arrayContaining(['--nginx', '-d', 'elowen.example.com', '--redirect', '-m', 'me@x.com', '--agree-tos', '--non-interactive']));
  });
  it('falls back to no-email registration when none is given', () => {
    const { args } = certbotCommand('apache', 'elowen.example.com');
    expect(args).toContain('--apache');
    expect(args).toContain('--register-unsafely-without-email');
  });
});
