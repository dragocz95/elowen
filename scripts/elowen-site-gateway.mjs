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
const SAFE_USER = /^[a-z_][a-z0-9_-]{0,31}$/i;
export const ENVIRONMENT_PACKAGES = Object.freeze([
  'podman', 'crun', 'uidmap', 'dbus-user-session', 'passt', 'slirp4netns',
]);
const OPTIONAL_OVERLAY_PACKAGE = 'fuse-overlayfs';
export const ENVIRONMENT_DELEGATION_DROP_IN = '/etc/systemd/system/user@.service.d/elowen-sites-environments.conf';
export const ENVIRONMENT_DELEGATION_CONTENT = '[Service]\nDelegate=cpu memory pids\n';
const SYSTEM_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';
const PACKAGE_LABELS = Object.freeze({
  podman: 'Podman',
  crun: 'crun',
  uidmap: 'UID mapping tools',
  'dbus-user-session': 'D-Bus user session',
  passt: 'passt network backend',
  slirp4netns: 'slirp4netns network backend',
  'fuse-overlayfs': 'FUSE overlay storage',
});

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

/** Quoted, and it has to be: the slug length bound makes this regex contain `{`, which nginx reads as the
 *  start of a block unless the value is a quoted string. Unquoted, the whole gateway config is rejected by
 *  `nginx -t` with `directive "server_name" is not terminated by ";"`, the mutation is rolled back, and the
 *  gateway silently never activates however correct the DNS is. */
function wildcardServerName(deployment) {
  return `"~^[a-z0-9][a-z0-9-]{1,63}\\.${escapeRegex(deployment.hostnameBase)}$"`;
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
    '        client_max_body_size 1m;',
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

/** nginx builds ONE exact-name hash for every server_name on the machine, and refuses the whole
 *  configuration when they do not fit, with `could not build server_names_hash`. The bucket defaults to
 *  the CPU cache line (64 bytes here), and a site hostname is a slug of up to 64 characters plus the
 *  base, so ordinary slugs overflow it — which is exactly how this shipped: the sites were issued
 *  certificates and then rolled straight back out of nginx.
 *
 *  The size cannot be derived exactly, because the names that share the hash include every OTHER vhost
 *  on the host, which this helper does not own and must not parse. So it is a floor, not a fit: 128 is
 *  the value nginx's own documentation reaches for, and it still grows if a long base ever needs more.
 *  The stock nginx.conf ships this directive commented out, so setting it here does not collide. */
function serverNamesHashBucketSize(lineages) {
  const longest = lineages.reduce((max, name) => Math.max(max, name.length), 0);
  let size = 128;
  while (size < longest * 2) size *= 2;
  return size;
}

export function renderActiveConfig(deployment, gatewayToken, slugs) {
  if (!SAFE_TOKEN.test(gatewayToken)) fail('gateway token is invalid');
  const ordered = [...new Set(slugs)].sort();
  const blocks = [MANAGED_HEADER];
  if (ordered.length > 0) {
    const lineages = ordered.map((slug) => lineageFor(deployment, slug));
    blocks.push(`server_names_hash_bucket_size ${serverNamesHashBucketSize(lineages)};`, '');
  }
  blocks.push(...challengeBlock(deployment));
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

  // Unconditionally, because this is the RENEWAL path as well as the issuance one. These lineages live
  // under our own --config-dir, so the system certbot timer never sees them and nothing else will ever
  // renew them; running only when the files are missing would issue each certificate once and let it
  // expire 90 days later. `--keep-until-expiring` makes the call a no-op until one is actually due.
  certbot([
    'certonly', '--webroot', '--webroot-path', ACME_WEBROOT,
    '--cert-name', certs.lineage, '-d', certs.lineage,
    '--agree-tos', '--email', request.email, '--keep-until-expiring',
  ]);
  if (!existsSync(certs.fullchain) || !existsSync(certs.privkey)) fail('certbot reported success but issued no certificate');

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

function commandErrorText(error) {
  if (!error || typeof error !== 'object') return '';
  const stderr = 'stderr' in error ? String(error.stderr || '').trim() : '';
  return stderr.slice(-1_000);
}

export function commandOptionsFor(file, _args = []) {
  const apt = file === '/usr/bin/apt-get';
  return {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: apt ? 5 * 60_000 : 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      PATH: SYSTEM_PATH,
      ...(apt ? { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' } : {}),
    },
  };
}

function defaultCommandRunner(file, args) {
  try {
    const stdout = execFileSync(file, args, commandOptionsFor(file, args));
    return { ok: true, stdout: String(stdout) };
  } catch (error) {
    return { ok: false, stderr: commandErrorText(error) };
  }
}

export function helperRequestFields(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('request is invalid');
  const fields = Object.keys(request);
  if (request.op !== 'environments-status' && request.op !== 'environments-provision') {
    fail('environment operation is invalid');
  }
  if (fields.length !== 1 || fields[0] !== 'op') fail('environment request has extra fields');
  return fields;
}

function sudoId(raw, label) {
  if (typeof raw !== 'string' || !/^(?:0|[1-9]\d*)$/.test(raw)) fail(`the invoking service ${label} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail(`the invoking service ${label} is invalid`);
  }
  return value;
}

function serviceUser(runner, env) {
  const name = typeof env.SUDO_USER === 'string' ? env.SUDO_USER : '';
  if (!SAFE_USER.test(name) || name === 'root') fail('the invoking service user cannot be determined');
  const sudoUid = sudoId(env.SUDO_UID, 'user id');
  const sudoGid = sudoId(env.SUDO_GID, 'group id');
  const result = runner('/usr/bin/getent', ['passwd', name]);
  if (!result.ok) fail('the invoking service user does not exist');
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  const fields = lines.length === 1 ? lines[0].split(':') : [];
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  const home = fields[5] || '';
  if (fields.length !== 7 || fields[0] !== name
    || !/^(?:0|[1-9]\d*)$/.test(fields[2] || '') || !/^(?:0|[1-9]\d*)$/.test(fields[3] || '')
    || !Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffff_ffff
    || !Number.isSafeInteger(gid) || gid < 0 || gid > 0xffff_ffff
    || !home.startsWith('/') || home.includes('\0')) {
    fail('the invoking service user record is invalid');
  }
  if (sudoUid !== uid) fail('the invoking service user id does not match sudo');
  if (sudoGid !== gid) fail('the invoking service group id does not match sudo');
  return { name, uid, gid, home };
}

function runAsServiceUser(runner, user, command, args) {
  return runner('/usr/sbin/runuser', [
    '-u', user.name, '--', '/usr/bin/env', '-i',
    `HOME=${user.home}`,
    `USER=${user.name}`,
    `LOGNAME=${user.name}`,
    `PATH=${SYSTEM_PATH}`,
    `XDG_RUNTIME_DIR=/run/user/${user.uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${user.uid}/bus`,
    command, ...args,
  ]);
}

function packageInstalled(runner, name) {
  const result = runner('/usr/bin/dpkg-query', ['-W', '-f=${Status}', name]);
  return result.ok && String(result.stdout || '').trim() === 'install ok installed';
}

function defaultReadText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

export function supportedEnvironmentOs(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, detail: 'operating system information is unavailable' };
  const values = new Map();
  for (const sourceLine of raw.split('\n')) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) return { ok: false, detail: 'operating system information is malformed' };
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.length < 2 || !value.endsWith(quote)) return { ok: false, detail: 'operating system information is malformed' };
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  if (!values.has('ID') || !values.get('ID')) return { ok: false, detail: 'operating system information is malformed' };
  const id = String(values.get('ID')).toLowerCase();
  if (id === 'debian') return { ok: true, detail: 'Debian is supported' };
  if (id === 'ubuntu') return { ok: true, detail: 'Ubuntu is supported' };
  return { ok: false, detail: 'only Debian and Ubuntu are supported' };
}

function subidEntries(readText, path) {
  const entries = [];
  for (const sourceLine of String(readText(path) || '').split('\n')) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length !== 3 || !/^[^\s:\0]+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) {
      fail(`${path} contains an invalid subordinate id entry`);
    }
    const start = Number(parts[1]);
    const count = Number(parts[2]);
    const end = start + count - 1;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count <= 0
      || !Number.isSafeInteger(end) || end > 0xffff_ffff) {
      fail(`${path} contains an invalid subordinate id entry`);
    }
    entries.push({ name: parts[0], start, end });
  }
  return entries;
}

function subidPresent(readText, path, user) {
  return subidEntries(readText, path).some((entry) => entry.name === user.name);
}

function nextSubidRange(readText) {
  const used = [
    ...subidEntries(readText, '/etc/subuid'),
    ...subidEntries(readText, '/etc/subgid'),
  ];
  for (let start = 100000; start <= 2_000_000_000; start += 65536) {
    const end = start + 65535;
    if (used.every((entry) => end < entry.start || start > entry.end)) return `${start}-${end}`;
  }
  fail('no subordinate id range is available');
}

function lingerEnabled(runner, user) {
  const result = runner('/usr/bin/loginctl', ['show-user', user.name, '--property=Linger', '--value']);
  return result.ok && String(result.stdout || '').trim() === 'yes';
}

function userDelegation(runner, user) {
  const result = runner('/usr/bin/systemctl', [
    'show', `user@${user.uid}.service`, '--property=Delegate', '--property=DelegateControllers', '--value',
  ]);
  const lines = String(result.stdout || '').trim().split('\n');
  return {
    enabled: result.ok && lines[0] === 'yes',
    controllers: new Set((lines[1] || '').trim().split(/\s+/).filter(Boolean)),
  };
}

function ensureDelegationDropIn(runner, readText, writeAtomic) {
  if (readText(ENVIRONMENT_DELEGATION_DROP_IN) !== ENVIRONMENT_DELEGATION_CONTENT) {
    writeAtomic(ENVIRONMENT_DELEGATION_DROP_IN, Buffer.from(ENVIRONMENT_DELEGATION_CONTENT), 0o644);
  }
  // Repeat daemon-reload while the live user manager still lacks delegation. It is idempotent, and this
  // also recovers when a previous call wrote the file but daemon-reload itself failed.
  runRequired(runner, '/usr/bin/systemctl', ['daemon-reload'], 'systemd daemon reload failed');
}

function podmanInfo(runner, user) {
  const result = runAsServiceUser(runner, user, '/usr/bin/podman', ['info', '--format', 'json']);
  if (!result.ok) {
    const stderr = String(result.stderr || '');
    return {
      ok: false,
      detail: /overlay|fuse-overlayfs|mount_program/i.test(stderr)
        ? 'rootless overlay storage is unavailable'
        : 'rootless podman info failed',
    };
  }
  try {
    const info = JSON.parse(String(result.stdout || ''));
    const rootless = info?.host?.security?.rootless === true;
    const manager = typeof info?.host?.cgroupManager === 'string' ? info.host.cgroupManager : 'unknown';
    const version = typeof info?.host?.cgroupVersion === 'string' ? info.host.cgroupVersion : String(info?.host?.cgroupVersion ?? 'unknown');
    const storage = typeof info?.store?.graphDriverName === 'string' ? info.store.graphDriverName : 'unknown';
    const compatible = rootless && manager === 'systemd' && (version === 'v2' || version === '2');
    return {
      ok: compatible,
      detail: rootless
        ? `rootless; storage ${storage}; cgroup manager ${manager}; cgroup ${version}`
        : 'podman info did not report rootless mode',
    };
  } catch {
    return { ok: false, detail: 'podman info returned invalid JSON' };
  }
}

function environmentStatus(options = {}) {
  const runner = options.runner ?? defaultCommandRunner;
  const readText = options.readText ?? defaultReadText;
  const env = options.env ?? process.env;
  const os = supportedEnvironmentOs(readText('/etc/os-release'));
  const user = serviceUser(runner, env);
  const packageState = new Map(ENVIRONMENT_PACKAGES.map((name) => [name, packageInstalled(runner, name)]));
  const podman = packageState.get('podman') ? podmanInfo(runner, user) : { ok: false, detail: 'podman is not installed' };
  const fuseInstalled = packageInstalled(runner, OPTIONAL_OVERLAY_PACKAGE);
  const overlayRequired = !podman.ok && /overlay|fuse-overlayfs|mount_program/i.test(podman.detail);
  const delegation = userDelegation(runner, user);
  const bus = runAsServiceUser(runner, user, '/usr/bin/systemctl', ['--user', 'show-environment']);
  const items = [{ id: 'os:supported', label: 'Supported operating system', ok: os.ok, detail: os.detail }];
  items.push(...ENVIRONMENT_PACKAGES.map((name) => ({
    id: `package:${name}`,
    label: PACKAGE_LABELS[name],
    ok: packageState.get(name) === true,
    detail: packageState.get(name) ? 'installed' : 'not installed',
  })));
  items.push({
    id: `package:${OPTIONAL_OVERLAY_PACKAGE}`,
    label: PACKAGE_LABELS[OPTIONAL_OVERLAY_PACKAGE],
    ok: fuseInstalled || !overlayRequired,
    detail: fuseInstalled ? 'installed' : overlayRequired ? 'required by rootless overlay storage' : 'not required',
  });
  const hasSubuid = subidPresent(readText, '/etc/subuid', user);
  const hasSubgid = subidPresent(readText, '/etc/subgid', user);
  items.push(
    { id: 'subuid', label: 'Subordinate user IDs', ok: hasSubuid, detail: hasSubuid ? `configured for ${user.name}` : 'not configured' },
    { id: 'subgid', label: 'Subordinate group IDs', ok: hasSubgid, detail: hasSubgid ? `configured for ${user.name}` : 'not configured' },
    { id: 'linger', label: 'Persistent user manager', ok: lingerEnabled(runner, user), detail: 'systemd linger' },
    { id: 'user-bus', label: 'User D-Bus', ok: bus.ok, detail: bus.ok ? 'reachable' : 'not reachable' },
  );
  for (const controller of ['cpu', 'memory', 'pids']) {
    const ok = delegation.enabled && delegation.controllers.has(controller);
    items.push({
      id: `cgroup:${controller}`,
      label: `${controller} cgroup delegation`,
      ok,
      detail: ok ? 'delegated through cgroup v2' : 'not delegated to the user manager',
    });
  }
  items.push({ id: 'podman-rootless', label: 'Rootless Podman', ok: podman.ok, detail: podman.detail });
  return { ok: true, ready: items.every((item) => item.ok), items };
}

function runRequired(runner, file, args, failure) {
  const result = runner(file, args);
  if (!result.ok) fail(failure);
}

function provisionEnvironments(options = {}) {
  const runner = options.runner ?? defaultCommandRunner;
  const readText = options.readText ?? defaultReadText;
  const writeAtomic = options.writeAtomic ?? atomicWrite;
  const env = options.env ?? process.env;
  const os = supportedEnvironmentOs(readText('/etc/os-release'));
  if (!os.ok) fail(os.detail);
  const user = serviceUser(runner, env);
  const missing = ENVIRONMENT_PACKAGES.filter((name) => !packageInstalled(runner, name));
  let aptUpdated = false;
  if (missing.length > 0) {
    runRequired(runner, '/usr/bin/apt-get', ['update'], 'apt package metadata update failed');
    aptUpdated = true;
    runRequired(runner, '/usr/bin/apt-get', ['install', '--yes', '--no-install-recommends', ...missing], 'environment package installation failed');
  }
  const hasSubuid = subidPresent(readText, '/etc/subuid', user);
  const hasSubgid = subidPresent(readText, '/etc/subgid', user);
  const range = hasSubuid && hasSubgid ? null : nextSubidRange(readText);
  if (!hasSubuid) {
    runRequired(runner, '/usr/sbin/usermod', ['--add-subuids', range, user.name], 'subordinate user id configuration failed');
  }
  if (!hasSubgid) {
    runRequired(runner, '/usr/sbin/usermod', ['--add-subgids', range, user.name], 'subordinate group id configuration failed');
  }
  if (!lingerEnabled(runner, user)) {
    runRequired(runner, '/usr/bin/loginctl', ['enable-linger', user.name], 'systemd linger enablement failed');
  }
  let status = environmentStatus({ runner, readText, env });
  const delegationMissing = status.items.some((item) => item.id.startsWith('cgroup:') && !item.ok);
  if (delegationMissing) ensureDelegationDropIn(runner, readText, writeAtomic);
  const fuse = status.items.find((item) => item.id === `package:${OPTIONAL_OVERLAY_PACKAGE}`);
  if (fuse && !fuse.ok && fuse.detail === 'required by rootless overlay storage') {
    if (!aptUpdated) runRequired(runner, '/usr/bin/apt-get', ['update'], 'apt package metadata update failed');
    runRequired(
      runner,
      '/usr/bin/apt-get',
      ['install', '--yes', '--no-install-recommends', OPTIONAL_OVERLAY_PACKAGE],
      'rootless overlay storage package installation failed',
    );
    status = environmentStatus({ runner, readText, env });
  }
  const delegationPending = status.items.some((item) => item.id.startsWith('cgroup:') && !item.ok)
    && readText(ENVIRONMENT_DELEGATION_DROP_IN) === ENVIRONMENT_DELEGATION_CONTENT;
  return {
    ...status,
    ...(status.ready ? {} : {
      detail: delegationPending
        ? 'systemd delegation is configured; a reboot or user-manager restart is required'
        : 'environment support remains incomplete',
    }),
  };
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

export async function applyRequest(request, deployment, options = {}) {
  if (!request || typeof request !== 'object' || typeof request.op !== 'string') fail('request is invalid');
  if (request.op === 'environments-status' || request.op === 'environments-provision') {
    helperRequestFields(request);
    return request.op === 'environments-status' ? environmentStatus(options) : provisionEnvironments(options);
  }
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
  if (request?.op === 'environments-status') {
    const response = await applyRequest(request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }
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
    const response = request?.op === 'environments-provision'
      ? await applyRequest(request)
      : await applyRequest(request, readDeployment());
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
