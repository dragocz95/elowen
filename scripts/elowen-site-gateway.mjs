#!/usr/bin/node
import { execFileSync } from 'node:child_process';
import {
  chmodSync, chownSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const DEPLOYMENT_PATH = '/etc/elowen/site-gateway.json';
export const NGINX_PATH = '/etc/nginx/conf.d/elowen-sites-gateway.conf';
export const STATE_PATH = '/var/lib/elowen/site-gateway.json';
const LOCK_PATH = '/var/lib/elowen/site-gateway.lock';
const RUNTIME_SOCKET_ROOT = '/var/lib/elowen/site-runtime-sockets';
const ACME_ROOT = '/var/lib/elowen/site-acme';
const ACME_CONFIG = join(ACME_ROOT, 'config');
const ACME_WORK = join(ACME_ROOT, 'work');
const ACME_LOGS = join(ACME_ROOT, 'logs');
const ACME_WEBROOT = join(ACME_ROOT, 'webroot');

const MAX_INPUT_BYTES = 8 * 1024;
const SAFE_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SAFE_EMAIL = /^[^\s@]{1,64}@[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/i;

function fail(message) {
  throw new Error(message);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deploymentFrom(raw) {
  if (!raw || typeof raw !== 'object') fail('deployment record is not an object');
  const appHost = typeof raw.appHost === 'string' ? raw.appHost.trim().toLowerCase() : '';
  const daemonPort = Number(raw.daemonPort);
  if (!SAFE_HOST.test(appHost) || !appHost.includes('.') || appHost.startsWith('sites.')) fail('deployment appHost is invalid');
  if (!Number.isInteger(daemonPort) || daemonPort < 1024 || daemonPort > 65535) fail('deployment daemonPort is invalid');
  return { appHost, daemonPort, hostnameBase: `sites.${appHost}` };
}

const MANAGED_HEADER = '# Managed by Elowen. Do not edit: the root-owned site gateway helper rewrites this file.';

function wildcardServerName(deployment) {
  return `~^[a-z0-9][a-z0-9-]{1,63}\\.${escapeRegex(deployment.hostnameBase)}$`;
}

export function lineageFor(deployment, slug) {
  if (!SAFE_SLUG.test(slug)) fail('site slug is invalid');
  return `${slug}.${deployment.hostnameBase}`;
}

function certPathsFor(deployment, slug) {
  const lineage = lineageFor(deployment, slug);
  return {
    lineage,
    fullchain: join(ACME_CONFIG, 'live', lineage, 'fullchain.pem'),
    privkey: join(ACME_CONFIG, 'live', lineage, 'privkey.pem'),
  };
}

/** The one block that must exist before any certificate does: HTTP-01 answers here, so it is what
 *  makes issuance possible at all. It covers the whole wildcard rather than one site, because a
 *  challenge arrives for a name whose certificate does not exist yet. */
function challengeBlock(deployment) {
  return [
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${wildcardServerName(deployment)};`,
    '',
    '    location /.well-known/acme-challenge/ {',
    `        root ${ACME_WEBROOT};`,
    '    }',
    '',
    '    location / {',
    '        return 308 https://$host$request_uri;',
    '    }',
    '}',
  ];
}

/** One published site = one server block with its OWN certificate. There is no wildcard certificate
 *  here on purpose: a wildcard can only be issued through DNS-01, which needs write access to the
 *  zone, and requiring registrar credentials for every deployment is exactly what this design avoids.
 *  Per-name HTTP-01 needs nothing but the wildcard A/CNAME record the operator already added. */
function siteBlock(deployment, slug, gatewayToken) {
  const certs = certPathsFor(deployment, slug);
  return [
    'server {',
    '    listen 443 ssl;',
    '    listen [::]:443 ssl;',
    `    server_name ${certs.lineage};`,
    `    ssl_certificate ${certs.fullchain};`,
    `    ssl_certificate_key ${certs.privkey};`,
    '',
    '    location / {',
    `        proxy_pass http://127.0.0.1:${deployment.daemonPort}/hooks/sites/s/${slug}$request_uri;`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    `        proxy_set_header X-Elowen-Site-Gateway "${gatewayToken}";`,
    '        proxy_set_header Authorization "";',
    // The daemon's hook transport is ordinary buffered HTTP today. Do not advertise a WebSocket path
    // that does not exist; the transport work can add the two upgrade headers together with real support.
    '        proxy_set_header Connection "";',
    '        proxy_buffering off;',
    '        proxy_read_timeout 3600s;',
    '        client_max_body_size 64m;',
    '    }',
    '}',
  ];
}

/** The tombstone left behind at uninstall. It answers on port 80 only: without a certificate there is
 *  nothing honest to say on 443, and borrowing some other site's certificate to say it would be worse
 *  than the TLS error a stale DNS record deserves. */
export function renderDenyConfig(deployment) {
  return `${[
    MANAGED_HEADER,
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${wildcardServerName(deployment)};`,
    '    return 410;',
    '}',
  ].join('\n')}\n`;
}

export function renderActiveConfig(deployment, gatewayToken, slugs) {
  if (!SAFE_TOKEN.test(gatewayToken)) fail('gateway token is invalid');
  const ordered = [...new Set(slugs)].sort();
  const blocks = [MANAGED_HEADER, ...challengeBlock(deployment)];
  for (const slug of ordered) blocks.push('', ...siteBlock(deployment, slug, gatewayToken));
  return `${blocks.join('\n')}\n`;
}

function readDeployment() {
  return deploymentFrom(JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8')));
}

function readMaybe(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function fileEquals(path, value) {
  const current = readMaybe(path);
  const expected = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return current !== null && current.equals(expected);
}

function atomicWrite(path, bytes, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temp, 'wx', mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, mode);
  renameSync(temp, path);
}

function restore(path, previous, mode) {
  if (previous === null) rmSync(path, { force: true });
  else atomicWrite(path, previous, mode);
}

function nginxTest() {
  execFileSync('/usr/sbin/nginx', ['-t'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20_000 });
}

function nginxReload() {
  execFileSync('/usr/bin/systemctl', ['reload', 'nginx'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20_000 });
}

function writeState(deployment, active, detail) {
  atomicWrite(STATE_PATH, Buffer.from(`${JSON.stringify({
    active,
    hostnameBase: deployment.hostnameBase,
    updatedAt: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  }, null, 2)}\n`), 0o600);
}

function mutate(deployment, nextConfig, active, detail) {
  const previous = { nginx: readMaybe(NGINX_PATH), state: readMaybe(STATE_PATH) };
  try {
    atomicWrite(NGINX_PATH, Buffer.from(nextConfig), 0o600);
    nginxTest();
    nginxReload();
    writeState(deployment, active, detail);
  } catch (error) {
    restore(NGINX_PATH, previous.nginx, 0o600);
    restore(STATE_PATH, previous.state, 0o600);
    try { nginxTest(); nginxReload(); } catch { /* the original failure is the actionable one */ }
    throw error;
  }
}

/** Which sites this gateway is currently serving, derived from the certificates that actually exist
 *  rather than from a list this helper would have to keep in step with them. A lineage directory IS
 *  the fact that a site can be served, so there is nothing to drift. */
function issuedSlugs(deployment) {
  const live = join(ACME_CONFIG, 'live');
  const suffix = `.${deployment.hostnameBase}`;
  let entries;
  try { entries = readdirSync(live, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix))
    .map((entry) => entry.name.slice(0, -suffix.length))
    .filter((slug) => SAFE_SLUG.test(slug)
      && existsSync(join(live, `${slug}${suffix}`, 'fullchain.pem'))
      && existsSync(join(live, `${slug}${suffix}`, 'privkey.pem')));
}

/** Publish the config that matches the certificates on disk. Called before issuance too, because the
 *  HTTP-01 challenge needs the port-80 block to already be live. */
function syncConfig(deployment, gatewayToken, detail) {
  const slugs = issuedSlugs(deployment);
  const desired = renderActiveConfig(deployment, gatewayToken, slugs);
  if (fileEquals(NGINX_PATH, desired)) writeState(deployment, true, detail);
  else mutate(deployment, desired, true, detail);
  return slugs;
}

function certbot(args) {
  try {
    execFileSync('/usr/bin/certbot', [
      ...args,
      '--non-interactive',
      '--config-dir', ACME_CONFIG,
      '--work-dir', ACME_WORK,
      '--logs-dir', ACME_LOGS,
    ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5 * 60_000, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim().slice(-600) : '';
    fail(`certbot failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function ensureSite(request, deployment) {
  const slug = typeof request.slug === 'string' ? request.slug : '';
  if (!SAFE_SLUG.test(slug)) fail('site slug is invalid');
  if (typeof request.gatewayToken !== 'string' || !SAFE_TOKEN.test(request.gatewayToken)) fail('gateway token is invalid');
  if (typeof request.email !== 'string' || !SAFE_EMAIL.test(request.email) || request.email.length > 254) {
    fail('a contact email is required for certificate issuance');
  }
  const certs = certPathsFor(deployment, slug);

  // The challenge block has to be serving before the CA calls back, so publish the config first.
  mkdirSync(ACME_WEBROOT, { recursive: true, mode: 0o755 });
  syncConfig(deployment, request.gatewayToken);

  if (!existsSync(certs.fullchain) || !existsSync(certs.privkey)) {
    certbot([
      'certonly', '--webroot', '--webroot-path', ACME_WEBROOT,
      '--cert-name', certs.lineage, '-d', certs.lineage,
      '--agree-tos', '--email', request.email, '--keep-until-expiring',
    ]);
    if (!existsSync(certs.fullchain) || !existsSync(certs.privkey)) fail('certbot reported success but issued no certificate');
  }

  const slugs = syncConfig(deployment, request.gatewayToken);
  return { ok: true, active: true, hostnameBase: deployment.hostnameBase, slugs };
}

/** Bring nginx in line with the certificates that exist, and report which sites those are. This is what
 *  makes the gateway live on an instance with no sites yet: the port-80 challenge block must be serving
 *  before the first certificate can be issued at all. */
function syncSites(request, deployment) {
  if (typeof request.gatewayToken !== 'string' || !SAFE_TOKEN.test(request.gatewayToken)) fail('gateway token is invalid');
  mkdirSync(ACME_WEBROOT, { recursive: true, mode: 0o755 });
  const slugs = syncConfig(deployment, request.gatewayToken);
  return { ok: true, active: true, hostnameBase: deployment.hostnameBase, slugs };
}

function removeSite(request, deployment) {
  const slug = typeof request.slug === 'string' ? request.slug : '';
  if (!SAFE_SLUG.test(slug)) fail('site slug is invalid');
  if (typeof request.gatewayToken !== 'string' || !SAFE_TOKEN.test(request.gatewayToken)) fail('gateway token is invalid');
  const certs = certPathsFor(deployment, slug);
  // Drop the block BEFORE the certificate: nginx refuses to start with an ssl_certificate it cannot read,
  // so deleting the lineage first would leave the whole gateway unable to reload.
  const remaining = issuedSlugs(deployment).filter((name) => name !== slug);
  const desired = renderActiveConfig(deployment, request.gatewayToken, remaining);
  if (!fileEquals(NGINX_PATH, desired)) mutate(deployment, desired, true);
  if (existsSync(join(ACME_CONFIG, 'live', certs.lineage))) certbot(['delete', '--cert-name', certs.lineage]);
  return { ok: true, active: true, hostnameBase: deployment.hostnameBase, slugs: remaining };
}

const SAFE_SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function runtimeSocketPathFor(siteId) {
  if (typeof siteId !== 'string' || !SAFE_SITE_ID.test(siteId)) fail('site id is invalid');
  return join(RUNTIME_SOCKET_ROOT, siteId, 'app.sock');
}

function runtimeSocketRequest(request) {
  const socketPath = runtimeSocketPathFor(request.siteId);
  const socketDir = dirname(socketPath);
  if (request.op === 'prepare-runtime-socket') {
    const gid = Number.parseInt(process.env.SUDO_GID || '', 10);
    if (!Number.isInteger(gid) || gid < 0) fail('the invoking service group cannot be determined');
    mkdirSync(RUNTIME_SOCKET_ROOT, { recursive: true, mode: 0o755 });
    rmSync(socketDir, { recursive: true, force: true });
    mkdirSync(socketDir, { mode: 0o730 });
    chownSync(socketDir, 0, gid);
    chmodSync(socketDir, 0o730);
    return { ok: true, socketPath };
  }
  if (request.op === 'seal-runtime-socket') {
    // Remove directory write permission BEFORE inspecting the entry. The confined process can no longer
    // replace the socket with a symlink between validation and the daemon's first connection.
    chmodSync(socketDir, 0o510);
    if (!lstatSync(socketPath).isSocket()) fail('the runtime endpoint is not a Unix socket');
    return { ok: true, socketPath };
  }
  if (request.op === 'remove-runtime-socket') {
    rmSync(socketDir, { recursive: true, force: true });
    return { ok: true, socketPath };
  }
  fail('runtime socket operation is not supported');
}

export async function applyRequest(request, deployment) {
  if (!request || typeof request !== 'object' || typeof request.op !== 'string') fail('request is invalid');
  if (request.op === 'prepare-runtime-socket' || request.op === 'seal-runtime-socket' || request.op === 'remove-runtime-socket') {
    return runtimeSocketRequest(request);
  }
  if (request.op === 'status') {
    let active = false;
    let detail;
    try {
      const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      active = state.active === true && state.hostnameBase === deployment.hostnameBase;
      if (typeof state.detail === 'string') detail = state.detail;
    } catch {
      detail = 'the gateway has not been provisioned';
    }
    return { ok: true, active, hostnameBase: deployment.hostnameBase, ...(detail ? { detail } : {}) };
  }

  if (request.op === 'sync-sites') return syncSites(request, deployment);
  if (request.op === 'ensure-site') return ensureSite(request, deployment);
  if (request.op === 'remove-site') return removeSite(request, deployment);

  if (request.op === 'deny') {
    const desired = renderDenyConfig(deployment);
    if (!fileEquals(NGINX_PATH, desired)) mutate(deployment, desired, false);
    else writeState(deployment, false);
    return { ok: true, active: false, hostnameBase: deployment.hostnameBase };
  }

  fail('operation is not supported');
}

const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function acquireMutationLock() {
  mkdirSync(dirname(LOCK_PATH), { recursive: true, mode: 0o755 });
  const deadline = Date.now() + 9 * 60_000;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(LOCK_PATH, 'wx', 0o600);
      try { writeFileSync(fd, `${process.pid}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      return () => rmSync(LOCK_PATH, { force: true });
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
      let owner = 0;
      try { owner = Number.parseInt(readFileSync(LOCK_PATH, 'utf8'), 10); } catch { /* stale or partial */ }
      if (!processAlive(owner)) { rmSync(LOCK_PATH, { force: true }); continue; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  fail('another site gateway mutation did not finish in time');
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) fail('request is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('request is not valid JSON');
  }
}

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) fail('helper must run as root');
  // No command-line modes at all: HTTP-01 needs no auth hook, so the sudoers rule can pin the empty
  // argument vector and there is no argv surface left to reach.
  if (process.argv.length > 2) fail('helper accepts no command-line arguments');
  const request = await readStdin();
  if (request?.op === 'status'
    || request?.op === 'prepare-runtime-socket'
    || request?.op === 'seal-runtime-socket'
    || request?.op === 'remove-runtime-socket') {
    const response = await applyRequest(request, readDeployment());
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }
  const release = await acquireMutationLock();
  try {
    const response = await applyRequest(request, readDeployment());
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } finally {
    release();
  }
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
