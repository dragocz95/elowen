import * as p from '../ui/prompts.js';
import type { Runner } from '../install/runner.js';
import { detectProxy, nginxVhost, apacheVhost, certbotCommand, type ProxyKind } from '../install/proxy.js';
import { aptInstall, must, step } from './exec.js';

/** The reverse-proxy / deployment question-set and its executors, shared by BOTH `elowen install` (its
 *  provisioning phase) and `elowen setup` (an optional deployment step on an already-installed box), so the
 *  two flows collect the same answers and drive the same nginx/TLS mutations — single source of truth. */

/** How the web UI is reached. Drives the reverse proxy, the web's bind interface and the canonical URL.
 *   - domain:    nginx/apache vhost + (optional) Let's Encrypt; web bound to 127.0.0.1.
 *   - ip:        no reverse proxy — the web binds 0.0.0.0 and the browser hits http://<host>:<webPort>.
 *   - localhost: no reverse proxy, web bound to 127.0.0.1, reachable only on the box. */
type DeployMode = 'domain' | 'ip' | 'localhost';

export interface Deployment {
  mode: DeployMode;
  /** Host shown in the public URL: the domain, the server's public IP, or 'localhost'. */
  host: string;
  /** Domain to certify/proxy — set only in 'domain' mode. */
  domain: string | null;
  proxyPreference: ProxyKind;
  /** Intended TLS (domain mode only); the effective result is returned by provisionProxy(). */
  tls: boolean;
  email: string | null;
  /** Interface the web server binds: 0.0.0.0 for 'ip', 127.0.0.1 otherwise. */
  webHost: string;
}

/** The daemon + web ports a deployment proxies to. Passed in so install and setup keep one port source. */
export interface DeployPorts { web: number; daemon: number }

export const localhostDeploy = (): Deployment => ({ mode: 'localhost', host: 'localhost', domain: null, proxyPreference: 'nginx', tls: false, email: null, webHost: '127.0.0.1' });
export const ipDeploy = (host: string): Deployment => ({ mode: 'ip', host, domain: null, proxyPreference: 'nginx', tls: false, email: null, webHost: '0.0.0.0' });

/** True for a bare IPv4/IPv6 host. Let's Encrypt only issues for registered domain names, so we never
 *  offer (or attempt) HTTPS for an IP — certbot would fail every time. */
export function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** Canonical public URL for a deployment, given whether TLS actually came up. */
export function publicUrl(d: Deployment, tlsOk: boolean, webPort: number): string {
  if (d.mode === 'domain') return `${tlsOk ? 'https' : 'http'}://${d.host}`;
  if (d.mode === 'ip') return `http://${d.host}:${webPort}`;
  return `http://localhost:${webPort}`;
}

/** Best-effort public IPv4 of this box, used as the default for the direct-port mode. Prefers the first
 *  global address from `hostname -I`; empty string when none can be determined. */
async function detectPublicIp(r: Runner): Promise<string> {
  const res = await r.exec('hostname', ['-I']);
  const first = res.stdout.trim().split(/\s+/).find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith('127.'));
  return first ?? '';
}

/** Interactive deployment question-set. Returns the resolved Deployment, or null when the operator cancels
 *  a prompt (esc/ctrl+c) — the caller decides whether that aborts (install) or backs out (setup). */
export async function chooseDeployment(r: Runner, webPort: number): Promise<Deployment | null> {
  const mode = await p.select({
    message: 'How will you reach the ELOWEN web UI?',
    options: [
      { value: 'domain', label: 'A domain name', hint: 'nginx + free HTTPS (Let’s Encrypt)' },
      { value: 'ip', label: 'This server’s IP, on a port', hint: `http://<ip>:${webPort} — no reverse proxy` },
      { value: 'localhost', label: 'Localhost only', hint: `http://localhost:${webPort}` },
    ],
  });
  if (p.isCancel(mode)) return null;

  if (mode === 'localhost') return localhostDeploy();

  if (mode === 'ip') {
    const guess = await detectPublicIp(r);
    const host = await p.text({ message: 'Public IP / hostname to advertise', initialValue: guess, validate: (v) => ((v ?? '').trim() ? undefined : 'Required') });
    if (p.isCancel(host)) return null;
    p.log.info(`The web UI will listen on 0.0.0.0:${webPort} — make sure port ${webPort} is open in any firewall.`);
    return ipDeploy(host.trim());
  }

  // domain
  const domain = await p.text({ message: 'Domain name', placeholder: 'elowen.example.com', validate: (v) => {
    const t = (v ?? '').trim();
    if (!t) return 'Required';
    if (isIpAddress(t)) return 'That’s an IP — pick the IP option instead (Let’s Encrypt needs a domain name)';
    return undefined;
  } });
  if (p.isCancel(domain)) return null;

  let proxyPreference: ProxyKind = 'nginx';
  if (!(await detectProxy(r))) {
    const which = await p.select({
      message: 'No reverse proxy found. Install one?',
      options: [{ value: 'nginx', label: 'nginx', hint: 'recommended' }, { value: 'apache', label: 'apache2' }],
    });
    if (p.isCancel(which)) return null;
    proxyPreference = which as ProxyKind;
  }

  const wantTls = await p.confirm({ message: `Obtain a free HTTPS certificate for ${domain.trim()} via Let's Encrypt?` });
  if (p.isCancel(wantTls)) return null;
  if (!wantTls) return { mode: 'domain', host: domain.trim(), domain: domain.trim(), proxyPreference, tls: false, email: null, webHost: '127.0.0.1' };
  const email = await p.text({ message: 'Email for renewal notices (blank to register without email)', placeholder: 'you@example.com' });
  if (p.isCancel(email)) return null;
  return { mode: 'domain', host: domain.trim(), domain: domain.trim(), proxyPreference, tls: true, email: email.trim() || null, webHost: '127.0.0.1' };
}

// ── executors (system mutations) ─────────────────────────────────────────────

/** Detect the installed reverse proxy, installing the preferred one when none is present. */
async function resolveProxy(r: Runner, preference: ProxyKind): Promise<ProxyKind> {
  const existing = await detectProxy(r);
  if (existing) return existing;
  await aptInstall(r, preference === 'nginx' ? 'nginx' : 'apache2');
  return preference;
}

/** Render the vhost for the domain and make the proxy serve it. */
async function configureVhost(r: Runner, kind: ProxyKind, domain: string, ports: DeployPorts): Promise<void> {
  if (kind === 'nginx') {
    await r.writeFile('/etc/nginx/sites-available/elowen.conf', nginxVhost(domain, ports.web, ports.daemon));
    await must(r, 'ln', ['-sf', '/etc/nginx/sites-available/elowen.conf', '/etc/nginx/sites-enabled/elowen.conf']);
    await must(r, 'nginx', ['-t']);
    await must(r, 'systemctl', ['reload', 'nginx']);
  } else {
    await r.writeFile('/etc/apache2/sites-available/elowen.conf', apacheVhost(domain, ports.web, ports.daemon));
    await must(r, 'a2enmod', ['proxy', 'proxy_http']);
    await must(r, 'a2ensite', ['elowen']);
    await must(r, 'systemctl', ['reload', 'apache2']);
  }
}

/** Install certbot if needed and obtain + install a Let's Encrypt certificate. */
async function obtainTls(r: Runner, kind: ProxyKind, domain: string, email: string | null): Promise<void> {
  if (!(await r.which('certbot'))) {
    await aptInstall(r, 'certbot', kind === 'nginx' ? 'python3-certbot-nginx' : 'python3-certbot-apache');
  }
  const { cmd, args } = certbotCommand(kind, domain, email ?? undefined);
  await must(r, cmd, args);
}

/** Provision the reverse proxy + TLS for a deployment. Only domain mode configures a proxy (ip/localhost
 *  need none). TLS is the last, optional, most failure-prone step (DNS not pointed yet, rate limits): a
 *  failure there must NOT abort — the site already serves over HTTP — so we warn and return tls:false.
 *  Returns whether TLS was obtained, so the caller can build the final URL. */
export async function provisionProxy(r: Runner, deploy: Deployment, ports: DeployPorts): Promise<{ tls: boolean }> {
  if (deploy.mode !== 'domain' || !deploy.domain) return { tls: false };
  const kind = await step('Configuring reverse proxy', async () => {
    const k = await resolveProxy(r, deploy.proxyPreference);
    await configureVhost(r, k, deploy.domain!, ports);
    return k;
  });
  if (!deploy.tls) return { tls: false };
  try {
    await step('Requesting HTTPS certificate', () => obtainTls(r, kind, deploy.domain!, deploy.email));
    return { tls: true };
  } catch (e) {
    p.log.warn(`HTTPS setup failed: ${(e as Error).message}\nThe site is up over HTTP — re-run certbot once the domain's DNS points here.`);
    return { tls: false };
  }
}
