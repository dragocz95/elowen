#!/usr/bin/node
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const DEPLOYMENT_PATH = '/etc/elowen/site-gateway.json';
export const NGINX_PATH = '/etc/nginx/conf.d/elowen-sites-gateway.conf';
export const TLS_DIR = '/etc/elowen/sites-tls';
export const CERT_PATH = join(TLS_DIR, 'fullchain.pem');
export const KEY_PATH = join(TLS_DIR, 'privkey.pem');
export const STATE_PATH = '/var/lib/elowen/site-gateway.json';

const MAX_INPUT_BYTES = 384 * 1024;
const SAFE_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

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

function commonServerNames(deployment) {
  return `~^(?<elowen_site_slug>[a-z0-9][a-z0-9-]{1,63})\\.${escapeRegex(deployment.hostnameBase)}$`;
}

function tlsLines() {
  return [
    '    listen 443 ssl;',
    '    listen [::]:443 ssl;',
    `    ssl_certificate ${CERT_PATH};`,
    `    ssl_certificate_key ${KEY_PATH};`,
  ];
}

export function renderDenyConfig(deployment, hasCertificate) {
  const names = commonServerNames(deployment);
  const blocks = [
    '# Managed by Elowen. Do not edit: the root-owned site gateway helper rewrites this file.',
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${names};`,
    '    return 410;',
    '}',
  ];
  if (hasCertificate) {
    blocks.push(
      '',
      'server {',
      ...tlsLines(),
      `    server_name ${names};`,
      '    return 410;',
      '}',
    );
  }
  return `${blocks.join('\n')}\n`;
}

export function renderActiveConfig(deployment, gatewayToken) {
  if (!SAFE_TOKEN.test(gatewayToken)) fail('gateway token is invalid');
  const names = commonServerNames(deployment);
  return [
    '# Managed by Elowen. Do not edit: the root-owned site gateway helper rewrites this file.',
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${names};`,
    '    return 308 https://$host$request_uri;',
    '}',
    '',
    'server {',
    ...tlsLines(),
    `    server_name ${names};`,
    '',
    '    location / {',
    `        proxy_pass http://127.0.0.1:${deployment.daemonPort}/hooks/sites/s/$elowen_site_slug$request_uri;`,
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
    '',
  ].join('\n');
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

function validateCertificate(certificatePem, privateKeyPem, hostnameBase) {
  let certificate;
  let privateKey;
  try {
    certificate = new X509Certificate(certificatePem);
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    fail('certificate or private key is not valid PEM');
  }
  if (!certificate.checkHost(`probe.${hostnameBase}`)) fail('certificate does not cover the published-sites wildcard');
  if (Date.parse(certificate.validTo) <= Date.now() + 24 * 3600_000) fail('certificate expires too soon');
  const fromCertificate = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const fromPrivateKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (fromCertificate.length !== fromPrivateKey.length || !timingSafeEqual(fromCertificate, fromPrivateKey)) {
    fail('certificate and private key do not match');
  }
}

function writeState(deployment, active, detail) {
  atomicWrite(STATE_PATH, Buffer.from(`${JSON.stringify({
    active,
    hostnameBase: deployment.hostnameBase,
    updatedAt: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  }, null, 2)}\n`), 0o600);
}

function mutate(deployment, nextConfig, certificatePem, privateKeyPem, active) {
  const previous = {
    nginx: readMaybe(NGINX_PATH),
    cert: readMaybe(CERT_PATH),
    key: readMaybe(KEY_PATH),
    state: readMaybe(STATE_PATH),
  };
  try {
    if (certificatePem !== undefined && privateKeyPem !== undefined) {
      atomicWrite(CERT_PATH, Buffer.from(certificatePem), 0o644);
      atomicWrite(KEY_PATH, Buffer.from(privateKeyPem), 0o600);
    }
    atomicWrite(NGINX_PATH, Buffer.from(nextConfig), 0o600);
    nginxTest();
    nginxReload();
    writeState(deployment, active);
  } catch (error) {
    restore(NGINX_PATH, previous.nginx, 0o600);
    restore(CERT_PATH, previous.cert, 0o644);
    restore(KEY_PATH, previous.key, 0o600);
    restore(STATE_PATH, previous.state, 0o600);
    try { nginxTest(); nginxReload(); } catch { /* the original failure is the actionable one */ }
    throw error;
  }
}

export function applyRequest(request, deployment) {
  if (!request || typeof request !== 'object' || typeof request.op !== 'string') fail('request is invalid');
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

  if (request.op === 'deny') {
    const hasCertificate = existsSync(CERT_PATH) && existsSync(KEY_PATH);
    const desired = renderDenyConfig(deployment, hasCertificate);
    if (!fileEquals(NGINX_PATH, desired)) mutate(deployment, desired, undefined, undefined, false);
    else writeState(deployment, false);
    return { ok: true, active: false, hostnameBase: deployment.hostnameBase };
  }

  if (request.op === 'apply') {
    if (typeof request.certificatePem !== 'string' || typeof request.privateKeyPem !== 'string') fail('certificate material is missing');
    if (typeof request.gatewayToken !== 'string' || !SAFE_TOKEN.test(request.gatewayToken)) fail('gateway token is invalid');
    validateCertificate(request.certificatePem, request.privateKeyPem, deployment.hostnameBase);
    const desired = renderActiveConfig(deployment, request.gatewayToken);
    const unchanged = fileEquals(NGINX_PATH, desired)
      && fileEquals(CERT_PATH, request.certificatePem)
      && fileEquals(KEY_PATH, request.privateKeyPem);
    if (!unchanged) mutate(deployment, desired, request.certificatePem, request.privateKeyPem, true);
    else writeState(deployment, true);
    return { ok: true, active: true, hostnameBase: deployment.hostnameBase };
  }

  fail('operation is not supported');
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
  const request = await readStdin();
  const response = applyRequest(request, readDeployment());
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
