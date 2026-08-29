#!/usr/bin/node
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { resolve4, resolveTxt } from 'node:dns/promises';
import { isIP } from 'node:net';
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
const SELF_PATH = '/usr/local/libexec/elowen-site-gateway';
const ACME_ROOT = '/var/lib/elowen/site-acme';
const ACME_CONFIG = join(ACME_ROOT, 'config');
const ACME_WORK = join(ACME_ROOT, 'work');
const ACME_LOGS = join(ACME_ROOT, 'logs');
const NAMECHEAP_API = 'https://api.namecheap.com/xml.response';

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

function xmlDecode(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function xmlAttributes(raw) {
  const out = {};
  for (const match of raw.matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)) out[match[1]] = xmlDecode(match[2]);
  return out;
}

function namecheapError(xml) {
  const match = /<Error\b[^>]*>([\s\S]*?)<\/Error>/i.exec(xml);
  return match ? xmlDecode(match[1].replace(/<[^>]+>/g, '').trim()).slice(0, 300) : 'Namecheap refused the request';
}

function assertNamecheapOk(xml) {
  const response = /<ApiResponse\b([^>]*)>/i.exec(xml);
  if (!response || xmlAttributes(response[1]).Status !== 'OK') fail(namecheapError(xml));
}

export function zoneFor(deployment) {
  const labels = deployment.appHost.split('.');
  if (labels.length < 3) fail('the app hostname has no Namecheap-managed parent zone');
  const tld = labels.pop();
  const sld = labels.pop();
  const appPrefix = labels.join('.');
  if (!/^[a-z0-9-]+$/.test(sld) || !/^[a-z0-9.-]+$/.test(tld) || !appPrefix) fail('the Namecheap zone cannot be derived');
  return {
    sld,
    tld,
    wildcardName: `*.sites.${appPrefix}`,
    challengeName: `_acme-challenge.sites.${appPrefix}`,
    challengeFqdn: `_acme-challenge.${deployment.hostnameBase}`,
  };
}

function credentialsFrom(value) {
  const credentials = {
    apiUser: String(value.apiUser || ''),
    apiKey: String(value.apiKey || ''),
    username: String(value.username || ''),
    clientIp: String(value.clientIp || ''),
  };
  if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(credentials.apiUser)
    || !/^[A-Za-z0-9_.@-]{1,64}$/.test(credentials.username)
    || !/^\S{16,128}$/.test(credentials.apiKey)
    || isIP(credentials.clientIp) !== 4) fail('Namecheap credentials are malformed');
  return credentials;
}

async function namecheapRequest(command, credentials, params) {
  const query = new URLSearchParams({
    ApiUser: credentials.apiUser,
    ApiKey: credentials.apiKey,
    UserName: credentials.username,
    ClientIp: credentials.clientIp,
    Command: command,
    ...params,
  });
  let response;
  try {
    response = await fetch(`${NAMECHEAP_API}?${query}`, { signal: AbortSignal.timeout(30_000) });
  } catch {
    fail('Namecheap API could not be reached');
  }
  const xml = await response.text();
  if (!response.ok || xml.length > 2 * 1024 * 1024) fail('Namecheap API returned an invalid response');
  assertNamecheapOk(xml);
  return xml;
}

export function parseHosts(xml) {
  const result = /<DomainDNSGetHostsResult\b([^>]*)>/i.exec(xml);
  if (!result || xmlAttributes(result[1]).IsUsingOurDNS !== 'true') fail('the domain is not using Namecheap DNS');
  const records = [];
  for (const match of xml.matchAll(/<host\b([^>]*)\/?\s*>/gi)) {
    const attr = xmlAttributes(match[1]);
    if (!attr.Name || !attr.Type || attr.Address === undefined) fail('Namecheap returned an incomplete DNS record');
    records.push({
      name: attr.Name,
      type: attr.Type.toUpperCase(),
      address: attr.Address,
      mxPref: attr.MXPref || '10',
      ttl: attr.TTL || '1800',
    });
  }
  if (records.length === 0 || records.length > 150) fail('Namecheap returned an implausible DNS zone');
  return records;
}

async function getHosts(deployment, credentials) {
  const zone = zoneFor(deployment);
  const xml = await namecheapRequest('namecheap.domains.dns.getHosts', credentials, { SLD: zone.sld, TLD: zone.tld });
  return { zone, records: parseHosts(xml) };
}

function canonicalRecords(records) {
  return JSON.stringify(records.map((record) => [record.name, record.type, record.address, record.mxPref, record.ttl]));
}

export function setHostsParams(zone, records) {
  if (records.length === 0 || records.length > 150) fail('refusing to replace an empty or oversized DNS zone');
  const params = { SLD: zone.sld, TLD: zone.tld };
  records.forEach((record, index) => {
    const n = String(index + 1);
    params[`HostName${n}`] = record.name;
    params[`RecordType${n}`] = record.type;
    params[`Address${n}`] = record.address;
    params[`MXPref${n}`] = record.mxPref;
    params[`TTL${n}`] = record.ttl;
  });
  return params;
}

async function setHosts(zone, records, credentials) {
  const params = setHostsParams(zone, records);
  const xml = await namecheapRequest('namecheap.domains.dns.setHosts', credentials, params);
  const result = /<DomainDNSSetHostsResult\b([^>]*)>/i.exec(xml);
  if (!result || xmlAttributes(result[1]).IsSuccess !== 'true') fail('Namecheap did not confirm the DNS update');
}

async function mutateHosts(deployment, credentials, mutateRecords) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await getHosts(deployment, credentials);
    const next = mutateRecords(before.zone, before.records.map((record) => ({ ...record })));
    if (canonicalRecords(next) === canonicalRecords(before.records)) return;
    const current = await getHosts(deployment, credentials);
    if (canonicalRecords(current.records) !== canonicalRecords(before.records)) continue;
    await setHosts(before.zone, next, credentials);
    return;
  }
  fail('the DNS zone changed concurrently; no records were replaced');
}

async function setChallenge(deployment, credentials, validation, present) {
  await mutateHosts(deployment, credentials, (zone, records) => {
    if (present) {
      if (!records.some((record) => record.name === zone.challengeName && record.type === 'TXT' && record.address === validation)) {
        records.push({ name: zone.challengeName, type: 'TXT', address: validation, mxPref: '10', ttl: '60' });
      }
      return records;
    }
    return records.filter((record) => !(record.name === zone.challengeName && record.type === 'TXT' && record.address === validation));
  });
}

async function waitForChallenge(fqdn, validation) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const values = (await resolveTxt(fqdn)).map((parts) => parts.join(''));
      if (values.includes(validation)) return;
    } catch { /* DNS has not propagated yet */ }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  fail('the ACME DNS challenge did not propagate within three minutes');
}

async function acmeHook(present) {
  const deployment = readDeployment();
  const credentials = credentialsFrom({
    apiUser: process.env.ELOWEN_NC_API_USER,
    apiKey: process.env.ELOWEN_NC_API_KEY,
    username: process.env.ELOWEN_NC_USERNAME,
    clientIp: process.env.ELOWEN_NC_CLIENT_IP,
  });
  const validation = process.env.CERTBOT_VALIDATION || '';
  if (!validation || process.env.CERTBOT_DOMAIN !== `*.${deployment.hostnameBase}`) fail('certbot challenge context is invalid');
  await setChallenge(deployment, credentials, validation, present);
  if (present) await waitForChallenge(zoneFor(deployment).challengeFqdn, validation);
}

async function ensureWildcardAddress(deployment, credentials) {
  const addresses = await resolve4(deployment.appHost);
  if (addresses.length === 0) fail('the app hostname has no public IPv4 address');
  const target = [...addresses].sort()[0];
  await mutateHosts(deployment, credentials, (zone, records) => {
    const sameName = records.filter((record) => record.name === zone.wildcardName);
    const conflicting = sameName.find((record) => record.type === 'CNAME' || (record.type === 'A' && record.address !== target));
    if (conflicting) fail('the wildcard site hostname already points somewhere else');
    if (!sameName.some((record) => record.type === 'A' && record.address === target)) {
      records.push({ name: zone.wildcardName, type: 'A', address: target, mxPref: '10', ttl: '300' });
    }
    return records;
  });
}

async function provisionNamecheap(request, deployment) {
  const credentials = credentialsFrom(request);
  if (!/^\S+@\S+\.\S+$/.test(request.email || '') || String(request.email).length > 254) fail('ACME contact email is malformed');
  if (!SAFE_TOKEN.test(request.gatewayToken || '')) fail('gateway token is invalid');
  if (!existsSync('/usr/bin/certbot')) fail('certbot is not installed');

  mkdirSync(ACME_CONFIG, { recursive: true, mode: 0o700 });
  mkdirSync(ACME_WORK, { recursive: true, mode: 0o700 });
  mkdirSync(ACME_LOGS, { recursive: true, mode: 0o700 });
  const certName = `elowen-${deployment.hostnameBase.replaceAll('.', '-')}`;
  const env = {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    ELOWEN_NC_API_USER: credentials.apiUser,
    ELOWEN_NC_API_KEY: credentials.apiKey,
    ELOWEN_NC_USERNAME: credentials.username,
    ELOWEN_NC_CLIENT_IP: credentials.clientIp,
  };
  try {
    execFileSync('/usr/bin/certbot', [
      'certonly', '--manual', '--preferred-challenges', 'dns',
      '--manual-auth-hook', `${SELF_PATH} acme-auth`,
      '--manual-cleanup-hook', `${SELF_PATH} acme-cleanup`,
      '--non-interactive', '--agree-tos',
      '--email', request.email, '--keep-until-expiring', '--cert-name', certName,
      '--config-dir', ACME_CONFIG, '--work-dir', ACME_WORK, '--logs-dir', ACME_LOGS,
      '-d', `*.${deployment.hostnameBase}`,
    ], { env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 8 * 60_000, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim().slice(-800) : '';
    fail(`certbot could not issue the wildcard certificate${stderr ? `: ${stderr}` : ''}`);
  }

  const lineage = join(ACME_CONFIG, 'live', certName);
  const certificatePem = readFileSync(join(lineage, 'fullchain.pem'), 'utf8');
  const privateKeyPem = readFileSync(join(lineage, 'privkey.pem'), 'utf8');
  validateCertificate(certificatePem, privateKeyPem, deployment.hostnameBase);
  await ensureWildcardAddress(deployment, credentials);
  mutate(deployment, renderActiveConfig(deployment, request.gatewayToken), certificatePem, privateKeyPem, true);
  return { ok: true, active: true, hostnameBase: deployment.hostnameBase };
}

export async function applyRequest(request, deployment) {
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

  if (request.op === 'provision-namecheap') return await provisionNamecheap(request, deployment);

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
  if (process.argv[2] === 'acme-auth' || process.argv[2] === 'acme-cleanup') {
    await acmeHook(process.argv[2] === 'acme-auth');
    return;
  }
  if (process.argv.length > 2) fail('helper accepts no command-line arguments');
  const request = await readStdin();
  const response = await applyRequest(request, readDeployment());
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
