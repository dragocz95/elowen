#!/usr/bin/node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, chownSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, fsyncSync,
  lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';

const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } = constants;
import { dirname, join, normalize } from 'node:path';

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
const NOT_FOUND_BODY = '<!doctype html><meta charset="utf-8"><title>Not found</title><p>This address does not lead anywhere.</p>';

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

/** Exact site names win before this regex. Any other valid hostname under the published-sites base ends
 *  here with the same concealed document the Sites handler returns for an unknown or forbidden site. The
 *  first issued certificate only completes TLS for that unknown SNI name; it grants no route to that site. */
function unknownSiteBlock(deployment, certificateSlug) {
  const certs = certPathsFor(deployment, certificateSlug);
  return [
    'server {',
    '    listen 443 ssl;',
    '    listen [::]:443 ssl;',
    `    server_name ${wildcardServerName(deployment)};`,
    `    ssl_certificate ${certs.fullchain};`,
    `    ssl_certificate_key ${certs.privkey};`,
    '    default_type text/html;',
    '    charset utf-8;',
    '    add_header Cache-Control "no-store" always;',
    '    add_header X-Content-Type-Options "nosniff" always;',
    '    add_header Referrer-Policy "no-referrer" always;',
    '    add_header Content-Security-Policy "default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\' https:; img-src \'self\' data: blob: https:; font-src \'self\' data: https:; media-src \'self\' blob: https:; connect-src \'self\' https: wss:; object-src \'none\'; base-uri \'self\'; frame-ancestors \'none\'" always;',
    '    add_header X-Robots-Tag "noindex, nofollow" always;',
    `    return 404 '${NOT_FOUND_BODY}';`,
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
  if (ordered.length > 0) blocks.push('', ...unknownSiteBlock(deployment, ordered[0]));
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

/** How long a privileged command may take. The default bounds a command that has hung; a package
 *  transaction and a pass over a whole environment root filesystem are bounded by the work they do
 *  instead. Measured on a 1.4 GB Project tree: an fsync pass over a freshly copied tree does not finish
 *  within the default at all, while the same pass over a warm tree takes eight seconds — so the default
 *  turned every first start into a failure the retry then rescued. The disk budget matches the one the
 *  runtime already applies to these operations on its own side. */
const COMMAND_TIMEOUT_MS = 30_000;
const APT_TIMEOUT_MS = 5 * 60_000;
export const DISK_TREE_TIMEOUT_MS = 15 * 60_000;

/** What a failed command has to say for itself. `stderr` is the answer whenever there is one, and often
 *  there is not: a command killed by its own timeout is terminated before it writes a byte, and a command
 *  that simply exits non-zero need not print anything either. The empty string used to travel all the way
 *  into the caller's message and leave it ending in a colon, naming a failure with no cause at all. */
export function commandErrorText(error, timeoutMs = COMMAND_TIMEOUT_MS) {
  if (!error || typeof error !== 'object') return 'the command failed without reporting an error';
  const stderr = 'stderr' in error ? String(error.stderr || '').trim() : '';
  if (stderr) return stderr.slice(-1_000);
  if (error.code === 'ETIMEDOUT') return `the command printed nothing and was killed after its ${Math.round(timeoutMs / 1000)}s budget`;
  if (Number.isInteger(error.status)) return `the command printed nothing and exited with status ${error.status}`;
  if (error.signal) return `the command printed nothing and was killed by ${error.signal}`;
  return `the command printed nothing: ${String(error.message || 'no error message')}`.slice(0, 1_000);
}

export function commandOptionsFor(file, _args = [], timeoutMs = COMMAND_TIMEOUT_MS) {
  const apt = file === '/usr/bin/apt-get';
  return {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: apt ? APT_TIMEOUT_MS : timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      PATH: SYSTEM_PATH,
      ...(apt ? { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' } : {}),
    },
  };
}

export function defaultCommandRunner(file, args, { timeoutMs } = {}) {
  const options = commandOptionsFor(file, args, timeoutMs);
  try {
    const stdout = execFileSync(file, args, options);
    return { ok: true, stdout: String(stdout) };
  } catch (error) {
    return { ok: false, stderr: commandErrorText(error, options.timeout) };
  }
}

export function helperRequestFields(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('request is invalid');
  // `domain` is the transport discriminator, not an operation argument: the daemon sends it on every
  // request, and it has already been validated before dispatch.
  const fields = Object.keys(request).filter((field) => field !== 'domain');
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

/** A named account as passwd has it, resolved through getent and validated whole. */
function passwdUser(runner, name) {
  if (!SAFE_USER.test(name) || name === 'root') fail('the invoking service user cannot be determined');
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
  return { name, uid, gid, home };
}

function serviceUser(runner, env) {
  const name = typeof env.SUDO_USER === 'string' ? env.SUDO_USER : '';
  if (!SAFE_USER.test(name) || name === 'root') fail('the invoking service user cannot be determined');
  const sudoUid = sudoId(env.SUDO_UID, 'user id');
  const sudoGid = sudoId(env.SUDO_GID, 'group id');
  const user = passwdUser(runner, name);
  if (sudoUid !== user.uid) fail('the invoking service user id does not match sudo');
  if (sudoGid !== user.gid) fail('the invoking service group id does not match sudo');
  return user;
}

/** Whether sudo is reporting root's OWN invocation rather than the service account's. The service user
 *  reaches this executable only through the sudoers-pinned command, and sudo sets these variables itself
 *  after clearing the environment, so it cannot present itself as root here. `root` therefore means an
 *  operator ran the command from a root shell. */
const invokedByRoot = (env) => env.SUDO_USER === 'root' && env.SUDO_UID === '0';

/** The account the machine runtime is provisioned FOR, which is not always the account that invoked this
 *  process. The daemon invokes it as the service user and sudo names that account, which is the only
 *  source the trusted storage roots are ever derived from and is left exactly as it was.
 *
 *  An operator running `elowen install` or `elowen update` reaches the helper through their own root
 *  shell, so the inner sudo can only report `root` and the derivation above has nothing to work with — the
 *  documented operator path provisioned nothing at all and said the service user could not be determined.
 *  A root caller may therefore name the account, because the two artefacts this decides — a polkit rule
 *  scoped to that account and the readiness rows describing it — are files root already owns outright, and
 *  the name is still resolved through passwd rather than believed. Nothing else accepts a named account,
 *  and no operation that reads a storage root is reachable this way. */
function machineServiceUser(runner, env, request) {
  const named = request.user;
  if (named !== undefined && typeof named !== 'string') fail('the machine runtime service user is invalid');
  if (!invokedByRoot(env)) {
    const user = serviceUser(runner, env);
    if (named !== undefined && named !== user.name) fail('the machine runtime service user does not match the invoking account');
    return user;
  }
  if (named === undefined) fail('running this as root requires naming the service account the environments belong to');
  return passwdUser(runner, named);
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

/** Who owns a path on the host. Injected like `readMode` beside it, because a test cannot give a file
 *  away to the uid range a machine actually runs on. */
function defaultReadOwner(path) {
  return lstatSync(path).uid;
}

/** Give an already-opened directory away, through the descriptor it was opened on. Injected beside
 *  `readOwner` for the same reason: only root can hand a file to another account, so a test cannot. */
function defaultSetOwner(fd, uid, gid) {
  fchownSync(fd, uid, gid);
}

/** The permission bits of a managed artefact, or -1 when it is not there at all. Content alone does not
 *  settle whether a root-owned artefact is intact: a polkit rule left group-writable is a rule anyone in
 *  that group can rewrite, so provisioning treats the mode as part of the artefact. */
function defaultReadMode(path) {
  try { return statSync(path).mode & 0o7777; } catch { return -1; }
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

/* ===========================================================================
 * nspawn domain
 *
 * One executable, one sudoers line, two typed domains. Every request carries `domain`; the dispatch
 * tables, the validation and the readiness rows below are separate from the Sites ones above and share
 * nothing but the transport and the root-owned deployment record.
 *
 * The boundary guarded here is the HOST: which operation runs, which Elowen machine it targets, which
 * host paths it derives, and that nothing escapes into the host. Everything on the guest side of that
 * line is intended capability — running an arbitrary command inside a managed environment is what the
 * environment is for, so `exec` treats the guest argv as opaque payload.
 * =========================================================================== */

/** A machine name is `<namespace>-<kind>-<id>-g<generation>`, already the container name the runtime
 *  uses. The pattern admits only lowercase letters, digits and dashes, so the value is a single safe
 *  filename component for the per-machine `.nspawn` file and unit drop-in — it is never used to derive
 *  a DISK path, which always comes from the trusted storage roots plus a validated resource and disk id. */
const NSPAWN_MACHINE = /^elowen-(project|site)-[a-z0-9-]{1,64}-g[0-9]{1,9}$/;
/** The guest unit `systemd-run` creates inside the machine; bounded so it cannot be read as an option. */
const NSPAWN_EXECUTION_UNIT = /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,190}\.service$/;
const SAFE_RESOURCE_TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_SHA256 = /^[a-f0-9]{64}$/;
const SAFE_GUEST_SEGMENT = /^[a-z0-9.][a-z0-9._-]{0,63}$/;

/** A bind's target INSIDE the machine: one or two lowercase path segments. A dot is legitimate at any
 *  position, including the first — every Site binds a read-only git stub over `/workspace/.git` — so what
 *  is refused is `.` and `..` themselves, which is what keeps a target from climbing out of its mount
 *  point. The bind SOURCE is a host path and is validated separately against the trusted storage roots. */
export function safeGuestMountTarget(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 130) return false;
  const segments = value.slice(1).split('/');
  if (segments.length > 2) return false;
  return segments.every((segment) => segment !== '.' && segment !== '..' && SAFE_GUEST_SEGMENT.test(segment));
}

export const NSPAWN_PACKAGE = 'systemd-container';
export const MACHINE_UNIT_PATH = '/etc/systemd/system/elowen-machine@.service';
export const POLKIT_RULE_PATH = '/etc/polkit-1/rules.d/49-elowen-nspawn.rules';
const NSPAWN_SETTINGS_ROOT = '/etc/systemd/nspawn';
const NSPAWN_UID_STATE_PATH = '/var/lib/elowen/nspawn-uid-ranges.json';
const PYTHON = '/usr/bin/python3';

/** Each environment owns a FIXED host uid range, allocated once and recorded in the disk identity. A
 *  per-boot range would re-chown the whole rootfs every time a tree is cloned; a fixed one makes the
 *  ownership pass one-time and boots deterministic. The base is far above every real host account. */
export const UID_RANGE_BASE = 1_073_741_824;
const UID_RANGE_SIZE = 65_536;
const UID_RANGE_SLOTS = 4_096;

const EXEC_ARGUMENT_LIMIT = 256;
const EXEC_ARGUMENT_BYTES = 64 * 1024;
const EXEC_OUTPUT_LIMIT = 16 * 1024 * 1024;
const EXEC_MAX_SECONDS = 15 * 60;
/** Grace over `RuntimeMaxSec` so systemd's own stop (TimeoutStopSec=5s) is what ends a timed-out
 *  execution; this backstop only covers a `systemd-run` that never returns at all. */
const EXEC_GRACE_SECONDS = 10;

/** Denied to the guest on top of nspawn's default bound. Every one of these is also denied by rootless
 *  Podman's default set, so this is the capability parity the Podman runtime already provides.
 *
 *  This set, `DevicePolicy=closed` in the unit template, `PrivateUsers` shifting and the read-only binds
 *  are what stands in for Podman's `containers-default` AppArmor profile, and no profile ships alongside
 *  them. That is a deliberate, measured gap rather than an oversight:
 *
 *    - systemd-nspawn 255.4 has no AppArmor integration at all. It exposes `-Z` and `-L` for SELinux
 *      contexts and nothing equivalent for AppArmor, and `systemd.nspawn(5)` has no AppArmor setting, so
 *      there is no hook through which a profile could be applied to the guest payload the way Podman
 *      applies `containers-default` to a container process.
 *    - AppArmor 4.0.1 ships no nspawn profile to start from. The profiles present for comparable tools
 *      are either LXC's, which confine a different supervisor, or the Ubuntu 24.04 `flags=(unconfined)`
 *      shells around `crun` and `bwrap`, which grant `userns` and confine nothing.
 *    - A profile attached to `/usr/bin/systemd-nspawn` is inherited by everything the supervisor execs,
 *      including the guest's init and every process under it, because nspawn performs no profile
 *      transition and AppArmor does not reset a profile at a mount-namespace boundary. A machine here is
 *      a general-purpose development environment running arbitrary commands, so any profile tight enough
 *      to constrain the supervisor also constrains the payload it exists to run.
 *
 *  Closing the gap would mean a complain-mode learning pass against a booting guest and a profile whose
 *  failure mode is every machine refusing to boot. Until that can be done against a real machine, the
 *  honest position is the documented delta rather than a profile that only renames `unconfined`. */
const NSPAWN_DROP_CAPABILITIES = Object.freeze([
  'CAP_AUDIT_CONTROL', 'CAP_AUDIT_READ', 'CAP_SYS_PTRACE', 'CAP_SYS_TTY_CONFIG', 'CAP_LEASE',
  'CAP_LINUX_IMMUTABLE', 'CAP_IPC_LOCK', 'CAP_IPC_OWNER', 'CAP_BLOCK_SUSPEND', 'CAP_WAKE_ALARM',
  'CAP_SYSLOG', 'CAP_MAC_ADMIN', 'CAP_MAC_OVERRIDE', 'CAP_SYS_MODULE', 'CAP_SYS_RAWIO',
  'CAP_SYS_TIME', 'CAP_SYS_PACCT',
]);

/** The shipped `systemd-nspawn@.service` hardcodes `/var/lib/machines/%i`, which the disk layout does
 *  not use, so the envelope is our own template: the same unit with the directory taken from the
 *  per-machine drop-in, no journal link into the host, and `--settings=override` so the `.nspawn` file
 *  wins over the unit's own command line. */
export const MACHINE_UNIT_TEMPLATE = `# Managed by Elowen. Do not edit: the root-owned helper rewrites this file.
[Unit]
Description=Elowen machine %i
Documentation=man:systemd-nspawn(1)
Wants=modprobe@tun.service modprobe@loop.service modprobe@dm_mod.service
PartOf=machines.target
Before=machines.target
After=network.target modprobe@tun.service modprobe@loop.service modprobe@dm_mod.service

[Service]
ExecStart=systemd-nspawn --quiet --keep-unit --boot --link-journal=no --settings=override --directory=\${ELOWEN_MACHINE_DIRECTORY} --machine=%i
KillMode=mixed
Type=notify
RestartForceExitStatus=133
SuccessExitStatus=133
Slice=machine.slice
Delegate=yes
DelegateSubgroup=supervisor
TasksMax=16384
WatchdogSec=3min
DevicePolicy=closed
DeviceAllow=char-pts rw
DeviceAllow=/dev/net/tun rwm
`;

/** The lifecycle runs as the service user with no sudo, over this rule. It is scoped to units named
 *  `elowen-machine@elowen-*` and to the three verbs the runtime actually issues — start, stop and
 *  set-property; a restart is a stop and a start, and nothing asks for one. Every other unit and verb
 *  falls through to the system default, so restarting an unrelated service stays refused. */
export function renderPolkitRule(user) {
  if (!SAFE_USER.test(user) || user === 'root') fail('the invoking service user cannot be determined');
  return `// Managed by Elowen. Do not edit: the root-owned helper rewrites this file.
polkit.addRule(function(action, subject) {
    if (subject.user !== "${user}") return polkit.Result.NOT_HANDLED;
    if (action.id !== "org.freedesktop.systemd1.manage-units") return polkit.Result.NOT_HANDLED;
    var unit = action.lookup("unit");
    var verb = action.lookup("verb");
    if (!unit || unit.indexOf("elowen-machine@elowen-") !== 0) return polkit.Result.NOT_HANDLED;
    if (verb === "start" || verb === "stop" || verb === "set-property") {
        return polkit.Result.YES;
    }
    return polkit.Result.NOT_HANDLED;
});
`;
}

/** nspawn names the host side of the link `ve-<machine>` and truncates it to the interface name limit, so
 *  a per-machine rule is not expressible and every rule below is written against the whole family. */
const MACHINE_INTERFACE = 've-+';

/** veth is off by default: a veth machine can address the host directly, which the Podman runtime's
 *  `allow_host_loopback=false` does not expose. These rules are the condition for enabling it. They are
 *  reported and never applied — the daemon does not mutate the firewall, it refuses until they exist.
 *
 *  The guard rules sit in INPUT rather than FORWARD, which is where the plan first placed them. A packet
 *  from a machine to an address the host itself holds is delivered locally, so the routing decision sends
 *  it to INPUT and it never reaches FORWARD; a FORWARD rule would have matched nothing and the isolation
 *  it promised would have been imaginary. The DHCP exception has to precede the guard, because the host
 *  runs the address server for the link.
 *
 *  Forwarding needs both directions named. Measured on a Docker host against a bare IP: with the outbound
 *  accept alone the request left and the connection timed out after ten seconds, and with the return-path
 *  rule beside it the same request answered 200. A reply arrives as `-i eth0 -o ve-+`, which matches
 *  neither the outbound accept nor anything in Docker's own chains, and falls through to the FORWARD DROP
 *  policy Docker installs. A machine that can send and never receive looks like a name-resolution fault
 *  and is not one. The two DOCKER-USER rules do not overlap, so their order relative to each other is
 *  free; the DHCP exception still has to precede the INPUT guard.
 *
 *  IPv6 needs only the guard, and that is a statement about this host rather than about IPv6. Measured:
 *  the host carries no global IPv6 address, the `ip6tables` FORWARD policy is ACCEPT, and a guest gets
 *  nothing but a link-local address on its side of the link. There is no v6 path off the box to keep
 *  open, and the one v6 reach that does exist is the guest to the host's link-local address, which the
 *  guard closes. If the host ever gains IPv6 connectivity this needs measuring again, because a global
 *  address would put v6 forwarding in play and the set above would no longer be complete. */
export const NSPAWN_FIREWALL_RULES = Object.freeze([
  Object.freeze({
    id: 'firewall:forward-out',
    label: 'Machine forwarding',
    binary: '/usr/sbin/iptables',
    chain: 'DOCKER-USER',
    insert: true,
    spec: Object.freeze(['-i', MACHINE_INTERFACE, '-j', 'ACCEPT']),
    why: 'Docker sets the FORWARD policy to DROP, so without it a machine reaches nothing',
  }),
  Object.freeze({
    id: 'firewall:forward-back',
    label: 'Machine return path',
    binary: '/usr/sbin/iptables',
    chain: 'DOCKER-USER',
    insert: true,
    spec: Object.freeze(['-o', MACHINE_INTERFACE, '-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'ACCEPT']),
    why: 'a reply comes back the other way round and matches neither the rule above nor any chain Docker owns, so a machine sends and never receives',
  }),
  Object.freeze({
    id: 'firewall:machine-dhcp',
    label: 'Machine address lease',
    binary: '/usr/sbin/iptables',
    chain: 'INPUT',
    insert: true,
    spec: Object.freeze(['-i', MACHINE_INTERFACE, '-p', 'udp', '--dport', '67', '-j', 'ACCEPT']),
    why: 'the host runs the address server for the link, so the guard below must not cover it',
  }),
  Object.freeze({
    id: 'firewall:host-guard',
    label: 'Machine-to-host guard',
    binary: '/usr/sbin/iptables',
    insert: false,
    chain: 'INPUT',
    spec: Object.freeze(['-i', MACHINE_INTERFACE, '-j', 'DROP']),
    why: 'everything else a machine addresses to the host arrives here, not on FORWARD',
  }),
  Object.freeze({
    id: 'firewall:host-guard6',
    label: 'Machine-to-host guard (IPv6)',
    binary: '/usr/sbin/ip6tables',
    chain: 'INPUT',
    insert: false,
    spec: Object.freeze(['-i', MACHINE_INTERFACE, '-j', 'DROP']),
    why: 'the link carries IPv6 link-local addressing, which the IPv4 table does not see',
  }),
]);

/** The exact command an operator runs, in the order the rules are listed: the lease exception is inserted
 *  at the head of INPUT and the guard is appended, so the guard cannot shadow it. */
export function firewallRuleCommand(rule) {
  return `${rule.binary} ${rule.insert ? `-I ${rule.chain} 1` : `-A ${rule.chain}`} ${rule.spec.join(' ')}`;
}

export const MACHINE_FIREWALL_UNIT_NAME = 'elowen-machine-firewall.service';
export const MACHINE_FIREWALL_UNIT_PATH = `/etc/systemd/system/${MACHINE_FIREWALL_UNIT_NAME}`;

/** The rules above, applied by the host itself at every boot.
 *
 *  A packet filter keeps nothing across a reboot on its own, and this host has no persistence package
 *  installed. Leaving that to the operator meant that after any restart no environment could be created
 *  until somebody remembered five commands, and reporting it loudly does not make the host less broken.
 *
 *  Ordering is the whole design. Docker rebuilds its chains when it starts, so a unit that ran before it
 *  would leave the guard missing while machines are running; this one is ordered after `docker.service`
 *  and is also pulled in BY it, so a Docker restart re-applies the rules rather than silently dropping
 *  them. Each line checks before it acts, which is what makes a second boot, a re-run and a hand-applied
 *  rule all end in the same state. The condition keeps a host without a packet filter from failing the
 *  unit: the readiness rows then report the rules as missing, which is the truth. */
export const MACHINE_FIREWALL_UNIT = `# Managed by Elowen. Do not edit: the root-owned helper rewrites this file.
[Unit]
Description=Elowen machine firewall rules
Documentation=man:iptables(8)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecCondition=/usr/bin/test -x /usr/sbin/iptables -a -x /usr/sbin/ip6tables
${NSPAWN_FIREWALL_RULES.map((rule) => `ExecStart=/bin/sh -c '${rule.binary} -C ${rule.chain} ${rule.spec.join(' ')} 2>/dev/null || ${firewallRuleCommand(rule)}'`).join('\n')}

[Install]
WantedBy=multi-user.target docker.service
`;

export function machineUnitFor(machine) {
  if (typeof machine !== 'string' || !NSPAWN_MACHINE.test(machine)) fail('the machine name is invalid');
  return `elowen-machine@${machine}.service`;
}

function trustedStorageRoot(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || normalize(value) !== value || value.endsWith('/')
    || /[\0\r\n,:]/.test(value) || value.split('/').length < 3) fail('a trusted storage root is invalid');
  return value;
}

/** The storage roots every machine path is held against, COMPUTED HERE from the passwd home of the
 *  account sudo says invoked this helper, and read from nowhere.
 *
 *  They used to be read out of the deployment record, and that was a hole rather than a shortcut. The
 *  record is installed through a sudoers-pinned command whose source path is fixed and writable by the
 *  service user, and a sudoers grant binds to a USER, not to the code path that was meant to use it. So
 *  anything running as the service account could stage a record naming `/etc/systemd` as a storage root,
 *  run the pinned install, and from the very next request every path check in this file would agree that
 *  `/etc/systemd` is a legitimate place to unpack a tar as root or to delete a tree. The roots decide what
 *  root will touch, so they cannot come from anything the caller can reach.
 *
 *  `serviceUser` already resolves the name sudo reports through getent and refuses unless the passwd uid
 *  and gid match `SUDO_UID` and `SUDO_GID`, so the home below is the home of the account that actually
 *  invoked this process. `src/shared/siteGateway.ts` makes the same derivation for the installer; the two
 *  are held together by `tests/contract/nspawnHelper.test.ts`. */
export function storageRootsFor(home) {
  if (typeof home !== 'string' || !home.startsWith('/')) fail('the invoking service user has no home directory');
  const pluginData = join(home, '.config', 'elowen', 'plugins-data');
  return Object.freeze({
    sandboxDataDir: trustedStorageRoot(join(pluginData, 'sandbox')),
    sitesDataDir: trustedStorageRoot(join(pluginData, 'sites')),
  });
}

function readStorageRoots(options) {
  return storageRootsFor(serviceUser(options.runner ?? defaultCommandRunner, options.env ?? process.env).home);
}

/** Every root a machine path may resolve under. The first two are the service account's own storage; the
 *  third is the Sites ingress directory this helper already owns and binds into a machine. */
function trustedRoots(storage) {
  return [storage.sandboxDataDir, storage.sitesDataDir, RUNTIME_SOCKET_ROOT];
}

/** Re-validate a path the request names. The runtime derives paths this helper cannot re-derive from an
 *  id alone — a snapshot tree, a `.pending` staging directory, an export archive — so they arrive whole
 *  and are held against the trusted roots here instead: normalized, strictly inside a root, and with no
 *  symlink in any component. The directories under those roots are written by the service user and by
 *  guests, so a symlink planted anywhere along the path would redirect a root-owned copy or removal.
 *
 *  Nothing is CREATED here. The daemon makes its own staging and snapshot directories with the ownership
 *  and mode it then has to read back; a directory created by root at 0700 would be one the daemon could
 *  no longer traverse. */
export function trustedPath(storage, value, { file = false, allowMissing = false } = {}) {
  if (typeof value !== 'string' || !value.startsWith('/') || normalize(value) !== value || value.endsWith('/')
    || /[\0\r\n]/.test(value)) fail('the requested path is invalid');
  if (!trustedRoots(storage).some((root) => value.startsWith(`${root}/`))) {
    fail('the requested path is outside the trusted storage roots');
  }
  const parts = value.slice(1).split('/');
  let current = '';
  for (let index = 0; index < parts.length; index++) {
    current += `/${parts[index]}`;
    const last = index === parts.length - 1;
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      if (last && allowMissing) return value;
      fail('the requested path does not exist');
    }
    if (stat.isSymbolicLink()) fail('a symlink appears in a trusted storage path');
    if (last && file ? !stat.isFile() : !stat.isDirectory()) fail('the requested path is not of the expected kind');
  }
  return value;
}

/** Mirrors `createEnvironmentDiskSpec` in the Sandbox plugin, which is the single owner of this layout;
 *  a standalone root helper cannot import it, and `tests/contract/nspawnHelper.test.ts` keeps the two in
 *  step. This is the ONE derivation left, and it is the one that matters: the machine's root filesystem
 *  and its identity record come from the trusted roots plus a validated resource and disk id, never from
 *  a path the request names. */
export function nspawnDiskPaths(storage, request) {
  const kind = request?.kind;
  const resource = request?.resource;
  if (kind !== 'project' && kind !== 'site') fail('the resource kind is invalid');
  // The runtime addresses a resource by its string form, which is also the path segment the disk layout
  // uses. A project id is decimal; a Site id is a resource token.
  if (typeof resource !== 'string'
    || (kind === 'project' ? !/^[1-9][0-9]{0,15}$/.test(resource) : !SAFE_RESOURCE_TOKEN.test(resource))) {
    fail('the resource id is invalid');
  }
  if (typeof request.diskId !== 'string' || !SAFE_RESOURCE_TOKEN.test(request.diskId)) fail('the disk id is invalid');
  const storageRoot = kind === 'project'
    ? join(storage.sandboxDataDir, 'projects', resource)
    : join(storage.sitesDataDir, resource, 'environment');
  const directory = join(storageRoot, 'disks', request.diskId);
  return Object.freeze({
    kind,
    resource,
    diskId: request.diskId,
    storageRoot,
    directory,
    rootfs: join(directory, 'rootfs'),
    identity: join(directory, '.elowen', 'identity.json'),
  });
}

/** The `systemd-run` command line, built here and never taken from the request. The guest argv is opaque
 *  payload: it is placed after `--`, where it can no longer be read as an option, and passed through
 *  untouched. The bounds below are transport hygiene — they protect the command line and the pipe, not
 *  the guest — and are the same ones the Podman runtime applies today.
 *
 *  `--expand-environment=no` is what makes "untouched" true. A transient unit's command line is a systemd
 *  command line, and by default the manager substitutes `${VAR}` and `$VAR` in it at exec time. Measured
 *  on this host: `-f=${Status}` arrives as `-f=`, `$HOME` disappears as a whole argument because an unset
 *  `$VAR` word-splits into nothing, and `$$` collapses to `$`. Any guest command carrying a variable
 *  reference — a build script, a make invocation, anything a person types with `$HOME` in it — would run
 *  as something other than what was asked for, with no error anywhere. The flag sets the command through
 *  the property that carries the no-expansion flag, and all six probe cases then arrive byte for byte.
 *  Percent specifiers were measured to pass through untouched either way: they are resolved when a unit
 *  FILE is parsed, and a transient unit has none. */
export function nspawnExecArgs(request) {
  const machine = typeof request.machine === 'string' && NSPAWN_MACHINE.test(request.machine) ? request.machine : fail('the machine name is invalid');
  const unit = typeof request.unit === 'string' && NSPAWN_EXECUTION_UNIT.test(request.unit) ? request.unit : fail('the execution unit name is invalid');
  const argv = request.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > EXEC_ARGUMENT_LIMIT
    || argv.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
    || argv.reduce((bytes, argument) => bytes + Buffer.byteLength(argument), 0) > EXEC_ARGUMENT_BYTES
    || !argv[0].startsWith('/')) {
    fail('the guest command arguments are invalid');
  }
  const cwd = request.cwd;
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || /[\0\r\n]/.test(cwd) || cwd.length > 4096) {
    fail('the guest working directory is invalid');
  }
  const seconds = request.timeoutSeconds;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > EXEC_MAX_SECONDS) fail('the execution timeout is invalid');
  if (request.detached !== undefined && typeof request.detached !== 'boolean') fail('the execution mode is invalid');
  if (request.raw !== undefined && typeof request.raw !== 'boolean') fail('the execution mode is invalid');
  if (request.detached === true && request.raw === true) fail('a detached execution has no streams to pass through');
  // A DETACHED unit outlives the call that started it — a preview server, a publication forwarder — so it
  // drops the three options that make `systemd-run` wait for an exit: there is no exit to wait for.
  const detached = request.detached === true;
  return [
    '-M', machine, '--quiet', ...(detached ? [] : ['--pipe', '--wait']), '--collect', `--unit=${unit}`,
    '--service-type=exec', '--expand-environment=no', '--property=KillMode=control-group',
    '--property=TimeoutStopSec=5s', '--property=TasksMax=infinity',
    ...(detached ? [] : [`--property=RuntimeMaxSec=${seconds}s`]),
    `--working-directory=${cwd}`, '--', ...argv,
  ];
}

/** Three execution modes over one command line.
 *
 *  The default answers with a JSON verdict: stdout and stderr come back separately and base64-encoded,
 *  because the verdict itself travels on stdout.
 *
 *  `raw` is the LAUNCHED path, where the daemon spawns this helper itself and streams the result to a
 *  terminal. There the verdict is not what the caller wants, so nothing is encoded and nothing is
 *  printed: the child's streams are inherited straight through and the helper exits with the child's own
 *  status, which is exactly how `podman exec` behaves today.
 *
 *  `detached` starts a unit and returns as soon as it is up, with the confirmation that it IS up — a
 *  caller that got a bare acknowledgement would have no way to tell a started server from one that
 *  failed before its first line.
 *
 *  In every mode stdin is INHERITED, never buffered: the entry point read the request header with exact
 *  byte counts and left the remainder of the pipe untouched, so the guest receives its own input. */
function nspawnExec(request, options) {
  const args = nspawnExecArgs(request);
  const run = options.spawn ?? spawnSync;
  const raw = request.raw === true;
  const detached = request.detached === true;
  const result = run('/usr/bin/systemd-run', args, {
    stdio: raw ? ['inherit', 'inherit', 'inherit'] : ['inherit', 'pipe', 'pipe'],
    timeout: (request.timeoutSeconds + EXEC_GRACE_SECONDS) * 1000,
    killSignal: 'SIGKILL',
    ...(raw ? {} : { maxBuffer: EXEC_OUTPUT_LIMIT }),
    env: { PATH: SYSTEM_PATH },
  });
  const code = result.error && typeof result.error === 'object' ? result.error.code : undefined;
  const truncated = code === 'ENOBUFS';
  const timedOut = code === 'ETIMEDOUT';
  if (code !== undefined && !truncated && !timedOut) fail(`the machine execution could not start: ${result.error.message}`);
  const status = Number.isSafeInteger(result.status) ? result.status : null;
  // `raw` is the one answer that is not a verdict: the caller reads the guest's bytes, so the only thing
  // left to report is the status, and it is reported as this process's own exit code.
  if (raw) return { raw: true, exitCode: status === null ? 1 : status };
  if (detached) {
    if (status !== 0) fail(`the guest unit did not start: ${String(result.stderr ?? '').trim().slice(-400)}`);
    const runner = options.runner ?? defaultCommandRunner;
    const active = runner('/usr/bin/systemctl', ['-M', request.machine, 'is-active', request.unit]);
    const state = String(active.stdout || '').trim();
    if (state !== 'active' && state !== 'activating') fail(`the guest unit is not active after starting it (${state || 'no state reported'})`);
    return { ok: true, detached: true, unit: request.unit, machine: request.machine, state, exitCode: 0 };
  }
  const encode = (value) => Buffer.from(value ?? '').toString('base64');
  return {
    ok: true,
    exitCode: status,
    signal: result.signal ?? null,
    timedOut,
    truncated,
    stdout: encode(result.stdout),
    stderr: encode(result.stderr),
  };
}

function readUidRanges(readText) {
  try {
    const value = JSON.parse(readText(NSPAWN_UID_STATE_PATH));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Allocate the ENVIRONMENT's fixed range once and record it. The registry is the single owner of the
 *  allocation: deriving a range from the disk id instead would let two disks collide, and a collision
 *  means one machine's files are owned by another machine's guest root.
 *
 *  The key is the environment and not the disk it currently runs on. A restore mints a new disk id and
 *  copies the trees across byte for byte, ownership included, so a range keyed on the disk handed the
 *  restored generation a range its own files do not carry: the machine came up with a root filesystem its
 *  own root could not write, while the `:rootidmap` binds stayed writable and hid it. One environment,
 *  one range, which is also what keeps the ownership pass one-time.
 *
 *  A disk allocated under the earlier per-disk key keeps the range its files are already chowned to; it
 *  is adopted under the environment key the first time the environment asks. */
function uidRangeFor(paths, readText, writeAtomic) {
  const key = `${paths.kind}:${paths.resource}`;
  const ranges = readUidRanges(readText);
  const recorded = Number.isSafeInteger(ranges[key]) ? ranges[key] : ranges[`${key}:${paths.diskId}`];
  if (Number.isSafeInteger(recorded)) {
    if (ranges[key] !== recorded) {
      ranges[key] = recorded;
      writeAtomic(NSPAWN_UID_STATE_PATH, Buffer.from(`${JSON.stringify(ranges, null, 2)}\n`), 0o600);
    }
    return recorded;
  }
  const taken = new Set(Object.values(ranges).filter((value) => Number.isSafeInteger(value)));
  for (let slot = 0; slot < UID_RANGE_SLOTS; slot++) {
    const base = UID_RANGE_BASE + slot * UID_RANGE_SIZE;
    if (taken.has(base)) continue;
    ranges[key] = base;
    writeAtomic(NSPAWN_UID_STATE_PATH, Buffer.from(`${JSON.stringify(ranges, null, 2)}\n`), 0o600);
    return base;
  }
  return fail('no machine uid range is available');
}

/** Move a tree between the two ownership schemes, in place and in either direction.
 *
 *  `nspawn` is the machine's own fixed range: guest id g appears on the host as base+g. `podman` is what
 *  a tree extracted inside `podman unshare` carries: guest root is the service account itself and guest
 *  id g>0 is subStart+g-1. The reverse direction is not optional — a migration candidate that will not
 *  boot has to go back up on Podman, and rootless Podman cannot read a tree that has been chowned into
 *  the machine's range.
 *
 *  Every mode also ACCEPTS an id that already carries the destination scheme and leaves it alone, so an
 *  interrupted pass, which has no receipt and therefore cannot be reversed, is simply re-run. */
const OWNERSHIP_SHIFT_PY = `import json,os,sys
spec=json.loads(sys.argv[1]); root=sys.argv[2]
base=spec['base']; size=spec['size']; service=spec['serviceId']; previous=spec['previousBase']
def machine(uid):
 return base<=uid<base+size
def podman(uid):
 return uid==service or previous<=uid<previous+size-1
def to_machine(uid):
 if machine(uid): return uid
 if spec['mode']=='offset':
  if 0<=uid<size: return base+uid
 elif podman(uid): return base+(0 if uid==service else uid-previous+1)
 raise SystemExit('id %d belongs to no known mapping' % uid)
def to_podman(uid):
 if podman(uid): return uid
 if machine(uid):
  guest=uid-base
  return service if guest==0 else previous+guest-1
 raise SystemExit('id %d belongs to no known mapping' % uid)
convert=to_podman if spec['target']=='podman' else to_machine
shifted=0
for directory,names,files in os.walk(root,topdown=True,followlinks=False):
 for name in [os.curdir]+names+files:
  path=os.path.join(directory,name); st=os.lstat(path)
  uid=convert(st.st_uid); gid=convert(st.st_gid)
  if uid!=st.st_uid or gid!=st.st_gid: os.lchown(path,uid,gid); shifted+=1
print(json.dumps({'entries':shifted}))`;

function shiftOwnership(runner, root, spec) {
  const result = runner(PYTHON, ['-c', OWNERSHIP_SHIFT_PY, JSON.stringify(spec), root], { timeoutMs: DISK_TREE_TIMEOUT_MS });
  if (!result.ok) fail(`the machine ownership pass failed: ${String(result.stderr || '').slice(-400)}`);
  return JSON.parse(String(result.stdout || '{}'));
}

/** The service user's own mapping, which a tree extracted inside `podman unshare` carries. */
function subordinateRangeFor(readText, user) {
  const entry = subidEntries(readText, '/etc/subuid').find((row) => row.name === user.name);
  if (!entry) fail('the service user has no subordinate id range');
  return { serviceId: user.uid, subStart: entry.start };
}

function nspawnIdentity(paths, storage) {
  try {
    const value = JSON.parse(readFileSync(trustedPath(storage, paths.identity, { file: true }), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** The group the daemon runs as, so it can READ what only root may write. */
function serviceGroupId(env) {
  const gid = Number.parseInt(env.SUDO_GID || '', 10);
  if (!Number.isInteger(gid) || gid < 0) fail('the invoking service group cannot be determined');
  return gid;
}

/** The disk's record of which environment, generation and uid range it belongs to.
 *
 *  Written root-owned and readable by the service group: the daemon reads it on every ownership check,
 *  which is on the execution path, and a privileged round trip there would cost more than the entire
 *  state poll this runtime exists to make cheap. Its authority is its LOCATION — the disk directory,
 *  outside the root filesystem, where the guest has no path to it at all — not its mode. It holds a
 *  specification hash and a uid range and no secret, and only root can write it. */
function writeIdentity(paths, storage, fields, options) {
  const writeAtomic = options.writeAtomic ?? atomicWrite;
  // The disk directory belongs to the service user, so the directory root is about to write INTO is held
  // against the trusted roots exactly like every other path here. Without it, `.elowen` planted as a
  // symlink pointing out of the storage roots would have root create directories and a file at the other
  // end of it — the atomic write creates missing parents.
  const directory = trustedPath(storage, paths.directory);
  // The chown is skipped exactly where the write is faked: a test seam runs unprivileged and cannot give
  // a file away, and the two must not disagree about who owns the record.
  const privileged = options.writeAtomic === undefined;
  const gid = privileged ? serviceGroupId(options.env ?? process.env) : -1;
  ensureIdentityDirectory(join(directory, '.elowen'), gid);
  // Written whole, never merged over what is already there. The record is composed from fields this
  // helper derived and validated itself, and a previous file is the service user's to replace: merging
  // would carry whatever keys it planted into a root-owned record, and the day something reads a key it
  // did not put there, that is where it came from.
  const identity = { ...fields, updatedAt: new Date().toISOString() };
  writeAtomic(paths.identity, Buffer.from(`${JSON.stringify(identity, null, 2)}\n`), 0o640);
  // Safe by containment rather than by descriptor: `.elowen` is root-owned and not group-writable, so the
  // account that owns the disk directory around it cannot unlink this file and put a link in its place.
  if (privileged) chownSync(paths.identity, 0, gid);
  return identity;
}

/** Create the identity directory explicitly rather than letting a recursive mkdir do it: an existing
 *  entry has to BE a directory and must not be a symlink, and that is a question a recursive mkdir never
 *  asks.
 *
 *  It gets the same root-owned, service-group treatment as the record inside it. A group that cannot
 *  traverse the directory cannot open the file, so a root:root directory made every ownership check fail
 *  with EACCES and left the whole runtime unusable even though the record itself was readable. 0750 grants
 *  the traverse and nothing else: the group still cannot create, remove or replace anything here.
 *
 *  An existing directory is converged rather than trusted, because the directories the earlier helper
 *  created are all root:root and would otherwise stay broken until their disk was rebuilt. */
function ensureIdentityDirectory(path, gid) {
  // The disk directory around this one belongs to the service user, so both the existence check and the
  // repair happen through one descriptor rather than through the name twice. `O_DIRECTORY|O_NOFOLLOW`
  // refuses a symlink and cannot open a regular file, which is the same refusal the lstat made, done in
  // the only way that leaves no gap for the entry to be swapped underneath it.
  let fd;
  try {
    fd = openDirectory(path);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      if (error && (error.code === 'ELOOP' || error.code === 'ENOTDIR')) fail('the disk identity directory is not a directory');
      throw error;
    }
    mkdirSync(path, { mode: 0o750 });
    fd = openDirectory(path);
  }
  try {
    const stat = fstatSync(fd);
    fchmodSync(fd, 0o750);
    // Converged rather than trusted: every directory an earlier helper made is root:root, which left the
    // service group without the traverse permission the record inside it depends on.
    if (gid >= 0 && (stat.uid !== 0 || stat.gid !== gid)) fchownSync(fd, 0, gid);
  } finally {
    closeSync(fd);
  }
}

/** A directory opened as itself: never a symlink, never a regular file, and the same object for every
 *  operation that follows on the descriptor. */
function openDirectory(path) {
  return openSync(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
}

/** The identity fields the runtime holds against its own specification, field by field, on every
 *  ownership check. They are written by exactly the two operations that establish a disk. */
function identityFields(request, paths, uidBase) {
  const namespace = typeof request.namespace === 'string' && SAFE_RESOURCE_TOKEN.test(request.namespace) ? request.namespace : fail('the namespace is invalid');
  const machine = nspawnMachineName(request.machine);
  const generation = request.generation;
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 1_000_000_000) fail('the generation is invalid');
  if (typeof request.specHash !== 'string' || !SAFE_SHA256.test(request.specHash)) fail('the specification hash is invalid');
  // The machine name IS the environment identity, so a request whose name does not spell out the
  // resource it claims is refused rather than silently recorded.
  if (machine !== `${namespace}-${paths.kind}-${paths.resource}-g${generation}`) fail('the machine name does not match the resource it names');
  return {
    namespace,
    kind: paths.kind,
    resource: paths.resource,
    generation,
    diskId: paths.diskId,
    machine,
    runtime: 'nspawn',
    specHash: request.specHash,
    uidBase,
    uidSize: UID_RANGE_SIZE,
  };
}

function nspawnMachineName(value) {
  if (typeof value !== 'string' || !NSPAWN_MACHINE.test(value)) fail('the machine name is invalid');
  return value;
}

/** Extract a captured export into a tree the machine's uid range owns. Both paths arrive whole and are
 *  re-validated against the trusted roots: the archive lives beside its receipt under the environment's
 *  own storage, and the target is the staging directory the daemon created and will rename into place. */
function nspawnMaterialize(request, storage, options) {
  const runner = options.runner ?? defaultCommandRunner;
  const readText = options.readText ?? defaultReadText;
  const env = options.env ?? process.env;
  const paths = nspawnDiskPaths(storage, request);
  const archive = trustedPath(storage, request.archivePath, { file: true });
  const target = trustedPath(storage, request.targetPath);
  if (readdirSync(target).length > 0) fail('the extraction target is not empty');
  const extracted = runner('/usr/bin/tar', [
    '--extract', '--file', archive, '--directory', target, '--numeric-owner', '--preserve-permissions', '--same-owner',
  ], { timeoutMs: DISK_TREE_TIMEOUT_MS });
  if (!extracted.ok) fail(`the root filesystem could not be extracted: ${String(extracted.stderr || '').slice(-400)}`);
  // The machine's `/` has to be traversable by every process in the guest, not only by its root, and this
  // is the operation that establishes the tree, so this is where that is made true.
  //
  // Two things can leave it otherwise. The caller creates the directory and may create it narrow. And an
  // archive that carries its own root member rewrites the mode of the directory it is extracted into:
  // measured with exactly the flags above, an archive whose `./` entry is 0700 turns a 0755 target into
  // 0700, while an archive without a root member leaves it alone. So a tree exported from a disk whose
  // root was once narrow reproduces that mode here on every restore, for as long as the archive exists.
  //
  // What that costs inside the machine is worth stating, because nothing about it looks like a permission
  // problem: root traverses anyway, so the boot gets far. dbus-daemon starts as root, opens its socket,
  // drops to `messagebus`, and from then on cannot resolve a single path. Its readiness notification never
  // arrives, the unit times out after 90 seconds with a live process and a live socket the whole time, and
  // it restarts forever. Every image ships `/` at 0755 and nothing about a machine root wants less.
  // Through a descriptor, and one that can only ever be this directory: the tree was just unpacked into a
  // place the service user owns, so a chmod by name could be pointed at something else between the check
  // and the call.
  //
  // The same directory also has to present as the GUEST's root before the ownership pass below, and for
  // the same reason it does not already: the daemon created it, so it carries the service account's ids,
  // and `tar` chowns what it unpacks rather than the directory it unpacks into. The pass runs in `offset`
  // mode, where guest id g becomes base+g, so the service account's uid 33 lands on base+33 while `/etc`
  // and everything else lands on base+0. The machine's own root would then own every file in its root
  // filesystem except the root directory itself, which is exactly what `write-envelope` refuses.
  const rootfsFd = openDirectory(target);
  try {
    fchmodSync(rootfsFd, 0o755);
    (options.setOwner ?? defaultSetOwner)(rootfsFd, 0, 0);
  } finally { closeSync(rootfsFd); }
  // A machine id copied from the template would make every machine built from it the same host to
  // systemd, journald and D-Bus. Truncated, systemd generates one on first boot.
  const etc = join(target, 'etc');
  if (existsSync(etc)) {
    const machineIdPath = join(trustedPath(storage, etc), 'machine-id');
    if (existsSync(machineIdPath)) writeFileSync(machineIdPath, '');
  }
  const base = uidRangeFor(paths, readText, options.writeAtomic ?? atomicWrite);
  const user = serviceUser(runner, env);
  const podman = subordinateRangeFor(readText, user);
  const shifted = shiftOwnership(runner, target, {
    mode: 'offset', target: 'nspawn', base, size: UID_RANGE_SIZE, serviceId: podman.serviceId, previousBase: podman.subStart,
  });
  const identity = writeIdentity(paths, storage, identityFields(request, paths, base), options);
  return { ok: true, targetPath: target, uidBase: base, uidSize: UID_RANGE_SIZE, entries: shifted.entries, identity };
}

/** The ownership pass, in whichever direction the caller names, with the receipt a rollback needs. It is
 *  idempotent by construction: ids already carrying the destination scheme are left alone, so an
 *  interrupted pass — which produced no receipt and therefore cannot be reversed — is re-run instead. */
function nspawnShiftOwnership(request, storage, options) {
  const runner = options.runner ?? defaultCommandRunner;
  const readText = options.readText ?? defaultReadText;
  const env = options.env ?? process.env;
  const target = request.target;
  if (target !== 'nspawn' && target !== 'podman') fail('the ownership shift target is invalid');
  const paths = nspawnDiskPaths(storage, request);
  const rootfs = trustedPath(storage, paths.rootfs);
  const user = serviceUser(runner, env);
  const podman = subordinateRangeFor(readText, user);
  const recorded = nspawnIdentity(paths, storage);
  let base;
  if (target === 'podman') {
    // Reversing is only ever asked for with the range the forward pass reported, and it must be the range
    // this disk actually holds: a reversal against the wrong base would rewrite every id in the tree.
    if (!Number.isSafeInteger(request.uidBase) || request.uidBase < 1) fail('reversing an ownership shift requires the recorded range');
    base = Number.isSafeInteger(recorded?.uidBase) ? recorded.uidBase : fail('the disk has no recorded uid range to reverse');
    if (request.uidBase !== podman.subStart) fail('the ownership shift receipt does not name this host\'s subordinate range');
  } else {
    base = uidRangeFor(paths, readText, options.writeAtomic ?? atomicWrite);
  }
  const shifted = shiftOwnership(runner, rootfs, {
    mode: 'subid', target, base, size: UID_RANGE_SIZE, serviceId: podman.serviceId, previousBase: podman.subStart,
  });
  writeIdentity(paths, storage, {
    ...identityFields(request, paths, base),
    ownershipTarget: target,
    previousUidBase: podman.subStart,
  }, options);
  return {
    ok: true,
    rootfsPath: rootfs,
    uidBase: base,
    uidSize: UID_RANGE_SIZE,
    previousUidBase: podman.subStart,
    entries: shifted.entries,
  };
}

function nspawnLimits(raw) {
  if (!raw || typeof raw !== 'object') fail('the machine limits are invalid');
  const { cpus, memoryMb, pidsLimit } = raw;
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 1024 || !Number.isSafeInteger(cpus * 1e6)) fail('the machine limits are invalid');
  for (const value of [memoryMb, pidsLimit]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 30) fail('the machine limits are invalid');
  }
  return { cpus, memoryMb, pidsLimit };
}

/** Bind sources arrive whole — a workspace, a HOME, a Site's own source tree, the ingress directory —
 *  and are re-validated against the trusted roots here. A bind source that is a FILE is legitimate: the
 *  Sites envelope binds a read-only git stub over one path inside the workspace. */
function nspawnBinds(storage, raw) {
  if (!Array.isArray(raw) || raw.length > 8) fail('the machine binds are invalid');
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') fail('the machine binds are invalid');
    if (!safeGuestMountTarget(entry.target)) fail('the machine binds are invalid');
    if (entry.readOnly !== undefined && typeof entry.readOnly !== 'boolean') fail('the machine binds are invalid');
    if (typeof entry.source !== 'string') fail('the machine binds are invalid');
    const file = !existsSync(entry.source) ? false : lstatSync(entry.source).isFile();
    return {
      source: trustedPath(storage, entry.source, { file }),
      target: entry.target,
      readOnly: entry.readOnly === true,
      file,
    };
  });
}

/** nspawn applies the binds parent first, so by the time it reaches `/workspace/.git` that path already
 *  resolves INTO the source of the `/workspace` bind rather than into the root filesystem. When the parent
 *  bind is read-only — which every Site's workspace bind is — nspawn cannot create the mount point there
 *  and the machine never boots, with `Failed to create mount point <rootfs>/workspace/.git: Read-only file
 *  system`. The mount point therefore has to exist where the path actually lands: in the parent bind's
 *  source. Placing an empty file in the root filesystem instead was measured against a real machine and
 *  changes nothing, because the parent bind covers it.
 *
 *  A top-level target needs nothing: it lands in the root filesystem, which is writable, and nspawn
 *  creates it itself. The mount point matches the kind of what is bound over it and is then invisible,
 *  because a mount covers it for the whole life of the machine. It is created once and survives every
 *  later envelope, which is what the root filesystem outliving the envelope requires. */
function ensureNestedMountPoints(binds, privileged) {
  for (const bind of binds) {
    const segments = bind.target.slice(1).split('/');
    if (segments.length < 2) continue;
    const parent = binds.find((candidate) => candidate.target === `/${segments[0]}`);
    if (!parent) continue;
    ensureMountPoint(join(parent.source, segments[1]), bind.file, privileged);
  }
}

/** The mount point is created inside a directory the service user owns, and it is created by root. That
 *  makes the gap between naming the entry and changing it the whole problem: the owner of the surrounding
 *  directory can unlink what root just made and put a link to a system file in its place, and a chown by
 *  PATH would then hand that file to the service account. `write-envelope` can be called as often as the
 *  caller likes, so the window can be spun until it is hit.
 *
 *  So nothing here touches the entry by name twice. The file is created and chowned through the same
 *  descriptor `openSync` returns, which is the entry that was created and can be no other. The directory
 *  is reopened with `O_DIRECTORY|O_NOFOLLOW`, which refuses a symlink outright and cannot resolve to a
 *  regular file at all, and is changed through that descriptor. */
function ensureMountPoint(path, wantFile, privileged) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    // It carries the ownership of the directory it sits in rather than root's. While the machine runs the
    // mount hides it either way; what this buys is that a bind dropped from a later specification does not
    // leave a root-owned entry behind in a tree its owner has to be able to clean up.
    const owner = privileged ? statSync(dirname(path)) : null;
    if (!wantFile) mkdirSync(path, { mode: 0o755 });
    const fd = wantFile ? openSync(path, 'wx', 0o644) : openDirectory(path);
    try {
      if (owner) fchownSync(fd, owner.uid, owner.gid);
    } finally {
      closeSync(fd);
    }
    return;
  }
  // Whatever is already there is used as it is, but it has to be a plain entry of the right kind: a
  // symlink would move the mount somewhere else, and a real directory under a file bind fails the mount
  // with a message that says nothing. Neither is something to overwrite — both hold someone's data.
  if (stat.isSymbolicLink()) fail(`a machine bind mount point is a symbolic link: ${path}`);
  if (wantFile ? !stat.isFile() : !stat.isDirectory()) fail(`a machine bind mount point is of the wrong kind: ${path}`);
}

/** At least the capabilities this helper knows to drop, plus any further ones the runtime names. A
 *  request can only ever narrow the guest's authority here, never widen it. */
function nspawnDropCapabilities(raw) {
  const requested = raw === undefined ? [] : raw;
  if (!Array.isArray(requested) || requested.length > 64
    || requested.some((value) => typeof value !== 'string' || !/^CAP_[A-Z0-9_]{1,40}$/.test(value))) {
    fail('the dropped capability list is invalid');
  }
  return [...new Set([...NSPAWN_DROP_CAPABILITIES, ...requested])];
}

/** `:rootidmap` gives the guest's root the identity of the directory's host owner, which is the same
 *  semantics rootless Podman provides today: a file the guest writes appears on the host as the service
 *  user, and a service-user file appears inside the machine as root. */
export function renderMachineSettings(binds, { privateNetwork = true, uidBase, dropCapabilities = NSPAWN_DROP_CAPABILITIES }) {
  if (!Number.isSafeInteger(uidBase) || uidBase < UID_RANGE_BASE) fail('the machine uid range is invalid');
  const lines = [
    '# Managed by Elowen. Do not edit: the root-owned helper rewrites this file.',
    '[Exec]',
    `PrivateUsers=${uidBase}:${UID_RANGE_SIZE}`,
    'NoNewPrivileges=yes',
    `DropCapability=${[...dropCapabilities].join(' ')}`,
    'LinkJournal=no',
    '',
    '[Files]',
    // Ownership was applied once when the disk was materialized, so the boot must not repeat a chown over
    // the whole tree. 255.4 reads this key in [Files]; in [Exec] it parses as an unknown name, logs that
    // it is ignoring it and leaves the intent resting on nspawn's default instead of stating it.
    'PrivateUsersOwnership=off',
  ];
  for (const bind of binds) {
    lines.push(`${bind.readOnly ? 'BindReadOnly' : 'Bind'}=${bind.source}:${bind.target}:rootidmap`);
  }
  // Both keys are always written. `VirtualEthernet=` implies a private network namespace on its own, but
  // the failure mode of relying on that implication is a machine sharing the host's namespace outright,
  // so the namespace is stated rather than inferred.
  lines.push('', '[Network]', 'Private=yes', `VirtualEthernet=${privateNetwork ? 'no' : 'yes'}`);
  return `${lines.join('\n')}\n`;
}

export function renderMachineDropIn(rootfsRealPath, limits, uidBase) {
  return `# Managed by Elowen. Do not edit: the root-owned helper rewrites this file.
[Service]
Environment=ELOWEN_MACHINE_DIRECTORY=${rootfsRealPath}
Environment=ELOWEN_MACHINE_UID_BASE=${uidBase}
CPUQuota=${Math.round(limits.cpus * 100)}%
MemoryMax=${limits.memoryMb}M
TasksMax=${limits.pidsLimit}
`;
}

/** Write the machine's two configuration files and its identity record. This is what CREATES an nspawn
 *  environment: the runtime writes the envelope and then proves ownership over it, so the uid range is
 *  allocated here when the disk does not carry one yet. */
function nspawnWriteEnvelope(request, storage, options) {
  const runner = options.runner ?? defaultCommandRunner;
  const readText = options.readText ?? defaultReadText;
  const writeAtomic = options.writeAtomic ?? atomicWrite;
  const machine = nspawnMachineName(request.machine);
  const paths = nspawnDiskPaths(storage, request);
  const rootfs = realpathSync(trustedPath(storage, paths.rootfs));
  if (typeof request.privateNetwork !== 'boolean') fail('the machine network request is invalid');
  // The envelope is what turns veth on, so this is where the gate belongs: a machine cannot be started
  // with a link the host is not ready to isolate, and no client can skip the check by not asking for it.
  if (request.privateNetwork === false) {
    const unmet = vethReadiness(runner, readText).filter((item) => !item.ok);
    if (unmet.length > 0) fail(`the host is not ready for machine networking — ${unmet.map((item) => item.detail).join('; ')}`);
  }
  const limits = nspawnLimits(request.limits);
  const binds = nspawnBinds(storage, request.binds ?? []);
  ensureNestedMountPoints(binds, options.writeAtomic === undefined);
  const dropCapabilities = nspawnDropCapabilities(request.dropCapabilities);
  const uidBase = uidRangeFor(paths, readText, writeAtomic);
  // The envelope DECLARES a range and never establishes one: `PrivateUsersOwnership=off` is deliberate,
  // so nothing at boot chowns the tree into the range written here. A tree that carries a different range
  // therefore boots into a machine whose own root owns none of it — `/etc` reads back as `nobody:nogroup`
  // and every write into the root filesystem is refused — while the `:rootidmap` binds stay writable and
  // hide it behind a machine that reports `running`. The guest's root owns the machine root, so proving
  // the two agree is one lstat, and it is exact.
  const owner = (options.readOwner ?? defaultReadOwner)(rootfs);
  if (owner !== uidBase) fail(`the root filesystem is owned by ${owner} and this envelope declares the range at ${uidBase}`);
  const settings = renderMachineSettings(binds, { privateNetwork: request.privateNetwork, uidBase, dropCapabilities });
  const dropIn = renderMachineDropIn(rootfs, limits, uidBase);
  const settingsPath = join(NSPAWN_SETTINGS_ROOT, `${machine}.nspawn`);
  const dropInPath = join('/etc/systemd/system', `elowen-machine@${machine}.service.d`, '10-elowen.conf');
  writeAtomic(settingsPath, Buffer.from(settings), 0o644);
  writeAtomic(dropInPath, Buffer.from(dropIn), 0o644);
  runRequired(runner, '/usr/bin/systemctl', ['daemon-reload'], 'systemd daemon reload failed');
  writeIdentity(paths, storage, identityFields(request, paths, uidBase), options);
  return { ok: true, machine, unit: machineUnitFor(machine), settingsPath, dropInPath, uidBase, uidSize: UID_RANGE_SIZE };
}

/* The tree primitives keep the Python implementations the Podman runtime already uses; only the process
 * that runs them moves from `podman unshare` to this helper, because the rootfs is owned by the
 * machine's uid range and the service user cannot read it. `tests/contract/nspawnHelper.test.ts`
 * compares the inventory source with the runtime's own copy so the two cannot drift apart. */
const DISK_TREE_INVENTORY_PY = `def inventory(root):
 rows=[]; links={}
 for directory,names,files in os.walk(root,topdown=True,followlinks=False):
  names.sort(); files.sort()
  for name in names+files:
   path=os.path.join(directory,name); st=os.lstat(path); rel=os.path.relpath(path,root)
   hardlink=''
   if stat.S_ISREG(st.st_mode) and st.st_nlink>1:
    key=(st.st_dev,st.st_ino)
    if key not in links: links[key]=len(links)
    hardlink=links[key]
   attrs=[[key,os.getxattr(path,key,follow_symlinks=False).hex()] for key in sorted(os.listxattr(path,follow_symlinks=False))]
   rows.append([rel,stat.S_IFMT(st.st_mode),st.st_size if stat.S_ISREG(st.st_mode) else 0,st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode),st.st_mtime_ns,hardlink,attrs,os.readlink(path) if stat.S_ISLNK(st.st_mode) else ''])
 return rows`;

const DISK_TREE_COPY_SH = `set -eu
source=$1; target=$2
cp -a --reflink=auto --sparse=always -- "$source"/. "$target"/
${PYTHON} - "$source" "$target" <<'PY'
import os,stat,sys
${DISK_TREE_INVENTORY_PY}
source_rows=inventory(sys.argv[1]); target_rows=inventory(sys.argv[2])
if source_rows != target_rows:
 print('Copied disk tree metadata inventory differs from source',file=sys.stderr); sys.exit(1)
PY
`;

const DISK_TREE_FINGERPRINT_PY = `import hashlib,json,os,stat,sys
root=sys.argv[1]
h=hashlib.sha256(); logical=0; allocated=0; links={}
for directory,names,files in os.walk(root,topdown=True,followlinks=False):
 names.sort(); files.sort()
 for name in names+files:
  path=os.path.join(directory,name); rel=os.path.relpath(path,root); st=os.lstat(path)
  logical+=st.st_size; allocated+=st.st_blocks*512; hardlink=''
  if stat.S_ISREG(st.st_mode) and st.st_nlink>1:
   key=(st.st_dev,st.st_ino)
   if key not in links: links[key]=len(links)
   hardlink=links[key]
  attrs=[[key,os.getxattr(path,key,follow_symlinks=False).hex()] for key in sorted(os.listxattr(path,follow_symlinks=False))]
  row=[rel,stat.S_IFMT(st.st_mode),st.st_size,st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode),st.st_mtime_ns,hardlink,attrs,os.readlink(path) if stat.S_ISLNK(st.st_mode) else '']
  h.update(json.dumps(row,separators=(',',':')).encode()); h.update(b'\\n')
print(json.dumps({'logicalBytes':logical,'allocatedBytes':allocated,'digest':h.hexdigest()}))`;

const DISK_TREE_PREFLIGHT_PY = `import json,os,sys
sources=json.loads(sys.argv[1]); destination=sys.argv[2]; required=0
for root in sources:
 for directory,names,files in os.walk(root,topdown=True,followlinks=False):
  for name in names+files: required+=os.lstat(os.path.join(directory,name)).st_size
margin=max(64*1024*1024,required//10); fs=os.statvfs(destination); free=fs.f_bavail*fs.f_frsize
if free < required+margin:
 print(f'Insufficient free space for disk copy: need {required+margin} bytes including margin, have {free}',file=sys.stderr); sys.exit(1)
print(json.dumps({'requiredBytes':required,'marginBytes':margin,'freeBytes':free}))`;

const DISK_TREE_SYNC_PY = `import os,stat,sys
root=sys.argv[1]
for directory,names,files in os.walk(root,topdown=False,followlinks=False):
 for name in files:
  path=os.path.join(directory,name); st=os.lstat(path)
  if stat.S_ISREG(st.st_mode):
   fd=os.open(path,os.O_RDONLY); os.fsync(fd); os.close(fd)
 fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY); os.fsync(fd); os.close(fd)`;

const DISK_TREE_VERIFY_PY = `import json,os,stat,sys,tarfile
archive,target=sys.argv[1],sys.argv[2]
failures=[]; seen=set()
with tarfile.open(archive,'r|') as tar:
 for member in tar:
  rel=os.path.normpath(member.name).lstrip('/')
  if rel in ('.',''): continue
  seen.add(rel); path=os.path.join(target,rel)
  try: st=os.lstat(path)
  except FileNotFoundError: failures.append('missing '+rel); continue
  if member.isdir(): expected=stat.S_IFDIR
  elif member.issym(): expected=stat.S_IFLNK
  elif member.ischr(): expected=stat.S_IFCHR
  elif member.isblk(): expected=stat.S_IFBLK
  elif member.isfifo(): expected=stat.S_IFIFO
  elif member.isreg() or member.islnk(): expected=stat.S_IFREG
  else: failures.append('unsupported member type '+rel); continue
  if stat.S_IFMT(st.st_mode)!=expected: failures.append('type '+rel)
  elif member.issym():
   if os.readlink(path)!=member.linkname: failures.append('symlink target '+rel)
  else:
   if stat.S_IMODE(st.st_mode)!=stat.S_IMODE(member.mode): failures.append('mode '+rel)
   if member.islnk():
    link=os.path.join(target,os.path.normpath(member.linkname).lstrip('/'))
    try: other=os.lstat(link)
    except FileNotFoundError: other=None
    if other is None or (other.st_dev,other.st_ino)!=(st.st_dev,st.st_ino): failures.append('hardlink '+rel)
   elif member.isreg() and st.st_size!=member.size: failures.append('size '+rel)
   for key,value in member.pax_headers.items():
    if not key.startswith('SCHILY.xattr.user.'): continue
    name=key[len('SCHILY.xattr.'):]
    try: actual=os.getxattr(path,name,follow_symlinks=False).decode('latin-1')
    except OSError: actual=None
    if actual!=value: failures.append('xattr '+name+' '+rel)
  if len(failures)>20: break
if not failures:
 extra=[]
 for directory,names,files in os.walk(target,topdown=True,followlinks=False):
  for name in names+files:
   rel=os.path.relpath(os.path.join(directory,name),target)
   if rel not in seen: extra.append(rel)
 if extra: failures.append('unexpected entries '+','.join(sorted(extra)[:20]))
if failures:
 print(('Migrated rootfs differs from its export archive: '+'; '.join(failures[:20]))[:2000],file=sys.stderr); sys.exit(1)
print(json.dumps({'members':len(seen)}))`;

export const DISK_TREE_SCRIPTS = Object.freeze({
  inventory: DISK_TREE_INVENTORY_PY,
  fingerprint: DISK_TREE_FINGERPRINT_PY,
  preflight: DISK_TREE_PREFLIGHT_PY,
  sync: DISK_TREE_SYNC_PY,
  verify: DISK_TREE_VERIFY_PY,
});

/* Every tree operation below takes the path whole and re-validates it. The runtime derives shapes this
 * helper cannot re-derive from an id — a snapshot's `snapshots/<id>/<component>`, a staging `.pending`
 * directory, a migration archive — and teaching it to describe them as components instead would mean
 * teaching it to name something other than the path it actually uses. */

/** Every operation below walks or syncs a whole environment root filesystem, so all of them run on the
 *  disk budget rather than on the default command timeout. */
function treeRunner(options) {
  const runner = options.runner ?? defaultCommandRunner;
  return (file, args) => runner(file, args, { timeoutMs: DISK_TREE_TIMEOUT_MS });
}

function nspawnTreeCopy(request, storage, options) {
  const source = trustedPath(storage, request.sourcePath);
  // The destination exists already: the daemon creates it with the mode and ownership it then has to
  // read back, and a directory created by root at 0700 is one it could no longer traverse.
  const target = trustedPath(storage, request.targetPath);
  const copied = treeRunner(options)('/bin/bash', ['-c', DISK_TREE_COPY_SH, 'elowen-copy-tree', source, target]);
  if (!copied.ok) fail(`the disk tree copy failed: ${String(copied.stderr || '').slice(-400)}`);
  return { ok: true, sourcePath: source, targetPath: target };
}

function nspawnTreeFingerprint(request, storage, options) {
  const path = trustedPath(storage, request.path);
  const result = treeRunner(options)(PYTHON, ['-c', DISK_TREE_FINGERPRINT_PY, path]);
  if (!result.ok) fail(`the disk tree fingerprint failed: ${String(result.stderr || '').slice(-400)}`);
  const value = JSON.parse(String(result.stdout || '{}'));
  if (!Number.isSafeInteger(value.logicalBytes) || !Number.isSafeInteger(value.allocatedBytes) || !SAFE_SHA256.test(String(value.digest))) {
    fail('the disk tree fingerprint is invalid');
  }
  return { ok: true, path, ...value };
}

/** How much space a copy needs and whether the destination has it. Deliberately separate from the
 *  fingerprint: this answers a free-space question, and answering it by hashing gigabytes would cost the
 *  whole snapshot twice. */
function nspawnTreePreflight(request, storage, options) {
  const sources = request.sourcePaths;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 32) fail('the disk copy preflight requires source trees');
  const paths = sources.map((path) => trustedPath(storage, path));
  const destination = trustedPath(storage, request.destinationPath);
  const result = treeRunner(options)(PYTHON, ['-c', DISK_TREE_PREFLIGHT_PY, JSON.stringify(paths), destination]);
  if (!result.ok) fail(`the disk copy preflight refused the copy: ${String(result.stderr || '').slice(-400)}`);
  const value = JSON.parse(String(result.stdout || '{}'));
  if (!Number.isSafeInteger(value.requiredBytes) || !Number.isSafeInteger(value.marginBytes) || !Number.isSafeInteger(value.freeBytes)) {
    fail('the disk copy preflight is invalid');
  }
  return { ok: true, ...value };
}

/** Hold an extracted tree against the archive's own member list, so an activation can only ever publish
 *  the bytes the export proved. Ownership is deliberately NOT compared: the tree has been shifted onto
 *  the machine's uid range since extraction, which is the one difference from the archive that is meant
 *  to be there. */
function nspawnTreeVerify(request, storage, options) {
  const archive = trustedPath(storage, request.archivePath, { file: true });
  const target = trustedPath(storage, request.targetPath);
  const result = treeRunner(options)(PYTHON, ['-c', DISK_TREE_VERIFY_PY, archive, target]);
  if (!result.ok) fail(`the extracted root filesystem could not be verified: ${String(result.stderr || '').slice(-400)}`);
  const value = JSON.parse(String(result.stdout || '{}'));
  if (!Number.isSafeInteger(value.members) || value.members < 1) fail('the migration export archive named no members');
  return { ok: true, members: value.members };
}

function nspawnTreeSync(request, storage, options) {
  const path = trustedPath(storage, request.path);
  const result = treeRunner(options)(PYTHON, ['-c', DISK_TREE_SYNC_PY, path]);
  if (!result.ok) fail(`the disk tree sync failed: ${String(result.stderr || '').slice(-400)}`);
  return { ok: true, path };
}

/** Removal is the one tree operation whose target may already be gone: the runtime clears a staging
 *  directory before it recreates one, and asks for the removal without looking first. */
function nspawnTreeRemove(request, storage) {
  const path = trustedPath(storage, request.path, { allowMissing: true });
  rmSync(path, { recursive: true, force: true });
  return { ok: true, path };
}

/** The envelope, and only the envelope. The disk outlives it: a repair removes an envelope whose
 *  specification changed and writes a new one over the same root filesystem, and storage removal is a
 *  separate operation with its own ownership proof on the runtime side. */
function nspawnDestroy(request, options) {
  const runner = options.runner ?? defaultCommandRunner;
  const machine = nspawnMachineName(request.machine);
  // Stop before the envelope goes: a running machine holds the configuration this removes.
  runner('/usr/bin/systemctl', ['stop', machineUnitFor(machine)]);
  rmSync(join(NSPAWN_SETTINGS_ROOT, `${machine}.nspawn`), { force: true });
  rmSync(join('/etc/systemd/system', `elowen-machine@${machine}.service.d`), { recursive: true, force: true });
  runRequired(runner, '/usr/bin/systemctl', ['daemon-reload'], 'systemd daemon reload failed');
  return { ok: true, machine, unit: machineUnitFor(machine) };
}

function firewallRulePresent(runner, rule) {
  return runner(rule.binary, ['-C', rule.chain, ...rule.spec]).ok;
}

/** systemd cannot be asked about a template by its own name, only through an instance of it, so the
 *  question "has the manager picked this file up" is asked about an instance that will never be started.
 *  `show` does not start, enable or reference anything; an unreferenced unit is collected again. */
const UNIT_LOAD_PROBE = 'elowen-machine@elowen-project-readiness-probe-g0.service';

/** Enabled, so it runs at the next boot, AND every rule actually in place, so a flushed chain is repaired
 *  rather than reported. Provisioning is the operator-invoked path and the only one that may act on the
 *  packet filter; serving a request still only ever reports it. */
function firewallUnitApplied(runner) {
  if (!runner('/usr/bin/systemctl', ['is-enabled', MACHINE_FIREWALL_UNIT_NAME]).ok) return false;
  return NSPAWN_FIREWALL_RULES.every((rule) => firewallRulePresent(runner, rule));
}

function unitTemplateLoaded(runner) {
  const result = runner('/usr/bin/systemctl', ['show', '-p', 'LoadState', '--value', UNIT_LOAD_PROBE]);
  return result.ok && String(result.stdout || '').trim() === 'loaded';
}

/** Every root-owned file the machine runtime needs, each with the content that defines it and the reload
 *  that makes it take effect. Provisioning walks this list and writes a file only when what is on disk
 *  differs, so a run against a converged host writes nothing and reloads nothing, and a run against a
 *  hand-edited host restores exactly the artefact that drifted.
 *
 *  The polkit rule carries no reload because polkitd watches its rules directories and reloads a changed
 *  rule by itself; there is no reload command to run and so nothing to check afterwards. The unit
 *  template carries one, because systemd reads unit files only when it is told to. */
function nspawnArtefacts(user) {
  return [
    {
      id: 'unit:elowen-machine',
      label: 'Machine unit template',
      path: MACHINE_UNIT_PATH,
      mode: 0o644,
      content: MACHINE_UNIT_TEMPLATE,
      ready: 'installed and loaded',
      effect: {
        loaded: unitTemplateLoaded,
        detail: 'on disk but the manager has not read it — run: systemctl daemon-reload',
        reload: [['/usr/bin/systemctl', ['daemon-reload'], 'systemd daemon reload failed']],
      },
    },
    {
      id: 'unit:elowen-machine-firewall',
      label: 'Machine firewall rules',
      path: MACHINE_FIREWALL_UNIT_PATH,
      mode: 0o644,
      content: MACHINE_FIREWALL_UNIT,
      ready: 'installed, enabled and applied',
      effect: {
        // Applied is asked of the packet filter, not of the unit: a oneshot that has already run is
        // inactive either way, and a rule someone flushed by hand is exactly the state worth repairing.
        loaded: firewallUnitApplied,
        detail: `installed but the rules are not all in place — run: systemctl enable --now ${MACHINE_FIREWALL_UNIT_NAME}`,
        reload: [
          ['/usr/bin/systemctl', ['daemon-reload'], 'systemd daemon reload failed'],
          ['/usr/bin/systemctl', ['enable', '--now', MACHINE_FIREWALL_UNIT_NAME], 'the machine firewall rules could not be applied'],
        ],
      },
    },
    {
      id: 'polkit:machines',
      label: 'Machine lifecycle authorization',
      path: POLKIT_RULE_PATH,
      mode: 0o644,
      content: renderPolkitRule(user.name),
      ready: `scoped to elowen-machine units for ${user.name}`,
      effect: null,
    },
  ];
}

function artefactRow(artefact, runner, readText, readMode) {
  const mode = readMode(artefact.path);
  const provision = 'run environment provisioning to restore it';
  if (mode < 0) return { id: artefact.id, label: artefact.label, ok: false, detail: `missing — ${provision}` };
  if (readText(artefact.path) !== artefact.content) {
    return { id: artefact.id, label: artefact.label, ok: false, detail: `differs from the managed content — ${provision}` };
  }
  if (mode !== artefact.mode) {
    return {
      id: artefact.id,
      label: artefact.label,
      ok: false,
      detail: `mode is 0${mode.toString(8)} where 0${artefact.mode.toString(8)} is required — ${provision}`,
    };
  }
  if (artefact.effect && !artefact.effect.loaded(runner)) {
    return { id: artefact.id, label: artefact.label, ok: false, detail: artefact.effect.detail };
  }
  return { id: artefact.id, label: artefact.label, ok: true, detail: artefact.ready };
}

/** What a veth machine needs beyond its own settings file. Every row here is the operator's to satisfy:
 *  the helper reports the exact command and refuses veth until the answer is yes.
 *
 *  None of the firewall rules survive a reboot on their own. That is deliberate rather than unfortunate:
 *  the check runs before every envelope, so a rebooted host fails loudly and refuses veth instead of
 *  quietly running a machine with the guard gone. */
function vethReadiness(runner, readText) {
  const items = [];
  const forwarding = readText('/proc/sys/net/ipv4/ip_forward').trim() === '1';
  items.push({
    id: 'net:ip-forward',
    label: 'IPv4 forwarding',
    ok: forwarding,
    detail: forwarding ? 'enabled' : 'a machine cannot route without it — run: sysctl -w net.ipv4.ip_forward=1, and record it under /etc/sysctl.d to survive a reboot',
  });
  const active = runner('/usr/bin/systemctl', ['is-active', 'systemd-networkd']).ok;
  const enabled = runner('/usr/bin/systemctl', ['is-enabled', 'systemd-networkd']).ok;
  items.push({
    id: 'service:systemd-networkd',
    label: 'Machine link configuration',
    ok: active && enabled,
    detail: active && enabled
      ? 'active and enabled'
      : `it configures the host side of the link, leases the machine its address and masquerades the traffic — run: systemctl enable --now systemd-networkd${active ? ' (running, but it would not come back after a reboot)' : ''}`,
  });
  for (const rule of NSPAWN_FIREWALL_RULES) {
    const ok = firewallRulePresent(runner, rule);
    items.push({
      id: rule.id,
      label: rule.label,
      ok,
      detail: ok ? `present in ${rule.chain}` : `${rule.why} — run: ${firewallRuleCommand(rule)}`,
    });
  }
  return items;
}

/** The one accepted regression against the Podman runtime's `containers-default`, said out loud where the
 *  person deploying will see it rather than only in a plan document. It is reported as met because there
 *  is nothing to install and nothing an operator can do about it, and the detail says plainly that the
 *  profile is absent and what stands in its place. See the comment on the dropped capability set for the
 *  measurements behind it. */
function apparmorRow(readText) {
  const enabled = readText('/sys/module/apparmor/parameters/enabled').trim() === 'Y';
  return {
    id: 'apparmor:machine-profile',
    label: 'Machine AppArmor profile',
    ok: true,
    detail: `known gap, nothing to install: systemd-nspawn has no AppArmor integration, and a profile on the supervisor is inherited by the guest payload, so the dropped capability set, DevicePolicy=closed and the uid shift stand in for it — AppArmor itself is ${enabled ? 'enabled on this host and confines other services as usual' : 'not enabled on this host'}`,
  };
}

/** The same readiness shape the Podman environment rows use, reported through the same item contract.
 *  The veth rows appear only when veth is requested, and they are only ever REPORTED: the daemon never
 *  mutates the firewall, it names the rule and refuses. */
function nspawnStatus(request, options = {}) {
  const runner = options.runner ?? defaultCommandRunner;
  const readText = options.readText ?? defaultReadText;
  const readMode = options.readMode ?? defaultReadMode;
  const env = options.env ?? process.env;
  if (request.veth !== undefined && typeof request.veth !== 'boolean') fail('the machine network request is invalid');
  const user = machineServiceUser(runner, env, request);
  const os = supportedEnvironmentOs(readText('/etc/os-release'));
  const installed = packageInstalled(runner, NSPAWN_PACKAGE);
  const items = [
    { id: 'os:supported', label: 'Supported operating system', ok: os.ok, detail: os.detail },
    {
      id: `package:${NSPAWN_PACKAGE}`,
      label: 'systemd container tools',
      ok: installed,
      detail: installed ? 'installed' : 'not installed — run environment provisioning to install it',
    },
    apparmorRow(readText),
    ...nspawnArtefacts(user).map((artefact) => artefactRow(artefact, runner, readText, readMode)),
  ];
  if (request.veth === true) items.push(...vethReadiness(runner, readText));
  return { ok: true, ready: items.every((item) => item.ok), items };
}

/** Convergent by construction: every step asks the host what it already has and acts only on the answer,
 *  so provisioning a fresh host, re-provisioning a finished one and repairing a half-done or hand-edited
 *  one are the same code path. Nothing here is a veth prerequisite: those belong to the operator and
 *  provisioning reports them without touching them. */
function nspawnProvision(request, options = {}) {
  const runner = options.runner ?? defaultCommandRunner;
  const readText = options.readText ?? defaultReadText;
  const readMode = options.readMode ?? defaultReadMode;
  const writeAtomic = options.writeAtomic ?? atomicWrite;
  const env = options.env ?? process.env;
  const os = supportedEnvironmentOs(readText('/etc/os-release'));
  if (!os.ok) fail(os.detail);
  const user = machineServiceUser(runner, env, request);
  if (!packageInstalled(runner, NSPAWN_PACKAGE)) {
    runRequired(runner, '/usr/bin/apt-get', ['update'], 'apt package metadata update failed');
    runRequired(runner, '/usr/bin/apt-get', ['install', '--yes', '--no-install-recommends', NSPAWN_PACKAGE], 'machine runtime package installation failed');
  }
  for (const artefact of nspawnArtefacts(user)) {
    if (readText(artefact.path) !== artefact.content || readMode(artefact.path) !== artefact.mode) {
      writeAtomic(artefact.path, Buffer.from(artefact.content), artefact.mode);
    }
    // Asked after the write rather than derived from it: a file that was already correct but had never
    // been read by the manager is exactly the state a half-finished provisioning leaves behind.
    if (artefact.effect && !artefact.effect.loaded(runner)) {
      for (const command of artefact.effect.reload) runRequired(runner, ...command);
    }
  }
  const status = nspawnStatus(request, { runner, readText, readMode, env });
  return {
    ...status,
    ...(status.ready ? {} : { detail: 'machine runtime support remains incomplete' }),
  };
}

const NSPAWN_OPERATIONS = Object.freeze({
  status: (request, _storage, options) => nspawnStatus(request, options),
  provision: (request, _storage, options) => nspawnProvision(request, options),
  materialize: nspawnMaterialize,
  'write-envelope': nspawnWriteEnvelope,
  'shift-ownership': nspawnShiftOwnership,
  exec: (request, _storage, options) => nspawnExec(request, options),
  freeze: (request, _storage, options) => nspawnMachineState(request, 'freeze', options),
  thaw: (request, _storage, options) => nspawnMachineState(request, 'thaw', options),
  'tree-copy': nspawnTreeCopy,
  'tree-fingerprint': nspawnTreeFingerprint,
  'tree-preflight': nspawnTreePreflight,
  'tree-sync': nspawnTreeSync,
  'tree-remove': (request, storage) => nspawnTreeRemove(request, storage),
  'tree-verify': nspawnTreeVerify,
  destroy: (request, _storage, options) => nspawnDestroy(request, options),
});

/** The operations that need no trusted storage root at all, so they never read the deployment record.
 *  `destroy` is one of them: it removes the machine's own configuration files, whose paths come from the
 *  validated machine name, and never touches the disk. */
const NSPAWN_RECORD_FREE_OPERATIONS = Object.freeze(['status', 'provision', 'exec', 'freeze', 'thaw', 'destroy']);

function nspawnMachineState(request, verb, options) {
  const runner = options.runner ?? defaultCommandRunner;
  const unit = machineUnitFor(request.machine);
  runRequired(runner, '/usr/bin/systemctl', [verb, unit], `the machine could not be ${verb === 'freeze' ? 'frozen' : 'thawed'}`);
  return { ok: true, machine: request.machine, unit };
}

export function applyNspawnRequest(request, options = {}) {
  const handler = Object.hasOwn(NSPAWN_OPERATIONS, request.op) ? NSPAWN_OPERATIONS[request.op] : null;
  if (!handler) fail('machine operation is not supported');
  const storage = NSPAWN_RECORD_FREE_OPERATIONS.includes(request.op)
    ? null
    : options.storage ?? readStorageRoots(options);
  return handler(request, storage, options);
}

export async function applyRequest(request, deployment, options = {}) {
  if (!request || typeof request !== 'object' || typeof request.op !== 'string') fail('request is invalid');
  // An absent `domain` means `sites`. The helper is installed independently of the daemon that invokes
  // it, so a helper carrying this change can meet a daemon that predates the discriminator; the daemon
  // side always sends it explicitly. There is no such compatibility direction for `nspawn`, which no
  // older daemon can ask for.
  if (request.domain !== undefined && request.domain !== 'sites' && request.domain !== 'nspawn') fail('request domain is invalid');
  if (request.domain === 'nspawn') return applyNspawnRequest(request, options);
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

async function acquireMutationLock(lockPath = LOCK_PATH) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o755 });
  const deadline = Date.now() + 9 * 60_000;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeFileSync(fd, `${process.pid}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      return () => rmSync(lockPath, { force: true });
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
      let owner = 0;
      try { owner = Number.parseInt(readFileSync(lockPath, 'utf8'), 10); } catch { /* stale or partial */ }
      if (!processAlive(owner)) { rmSync(lockPath, { force: true }); continue; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return fail('another site gateway mutation did not finish in time');
}

export const HELPER_FRAME_HEADER_BYTES = 9;
const MAX_FRAMED_REQUEST_BYTES = 256 * 1024;

/** The header is exactly eight decimal digits and a newline, naming the byte length of the JSON request
 *  that follows it. */
export function parseFrameHeader(header) {
  if (!Buffer.isBuffer(header) || header.length !== HELPER_FRAME_HEADER_BYTES || !/^[0-9]{8}\n$/.test(header.toString('latin1'))) {
    fail('request framing is invalid');
  }
  const length = Number(header.toString('latin1').slice(0, 8));
  if (length < 1 || length > MAX_FRAMED_REQUEST_BYTES) fail('request is too large');
  return length;
}

function readExact(fd, length) {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, null);
    if (read === 0) fail('the request ended before its declared length');
    filled += read;
  }
  return buffer;
}

function parseRequest(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail('request is not valid JSON');
  }
}

/** Read the request WITHOUT consuming the rest of the pipe. A guest execution carries up to 1 MB of its
 *  own stdin behind the header, and the child inherits fd 0 to read it; a buffered read would take that
 *  input into this process and silently truncate what the guest receives. So the header and the request
 *  body are read with exact `readSync` byte counts and nothing beyond them is touched. */
export function readFramedRequest(fd = 0) {
  const first = readExact(fd, 1);
  // Compatibility: a daemon that predates the framing sends a bare JSON object and no guest stdin. The
  // helper is installed independently of the daemon invoking it, so both directions of that skew exist.
  if (first[0] === 0x7b) {
    const chunks = [first];
    let size = 1;
    for (;;) {
      const buffer = Buffer.allocUnsafe(8192);
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      size += read;
      if (size > MAX_INPUT_BYTES) fail('request is too large');
      chunks.push(buffer.subarray(0, read));
    }
    return parseRequest(Buffer.concat(chunks));
  }
  const length = parseFrameHeader(Buffer.concat([first, readExact(fd, HELPER_FRAME_HEADER_BYTES - 1)]));
  return parseRequest(readExact(fd, length));
}

export function helperRequestNeedsDeployment(request) {
  if (request?.domain === 'nspawn') return false;
  return request?.op === 'status'
    || request?.op === 'sync-sites'
    || request?.op === 'ensure-site'
    || request?.op === 'remove-site'
    || request?.op === 'deny';
}

/** The global mutation lock serializes host-changing work and waits up to nine minutes, which is what a
 *  certificate issuance or an apt transaction needs. Execution, freeze/thaw, the fingerprint read and
 *  the status-shaped operations must NOT take it: they are on the hot path of every command run in every
 *  environment, and blocking them behind a certbot renewal would stall the whole instance. */
const SITES_LOCK_FREE_OPERATIONS = Object.freeze([
  'environments-status', 'status', 'prepare-runtime-socket', 'seal-runtime-socket', 'remove-runtime-socket',
]);
const NSPAWN_LOCK_FREE_OPERATIONS = Object.freeze([
  'status', 'exec', 'freeze', 'thaw', 'tree-fingerprint', 'tree-preflight', 'tree-verify',
]);

export function helperRequestNeedsMutationLock(request) {
  return request?.domain === 'nspawn'
    ? !NSPAWN_LOCK_FREE_OPERATIONS.includes(request?.op)
    : !SITES_LOCK_FREE_OPERATIONS.includes(request?.op);
}

export async function handleRequest(request, options = {}) {
  const run = async () => (helperRequestNeedsDeployment(request)
    ? await applyRequest(request, options.deployment ?? readDeployment(), options)
    : await applyRequest(request, undefined, options));
  if (!helperRequestNeedsMutationLock(request)) return await run();
  const release = await acquireMutationLock(options.lockPath ?? LOCK_PATH);
  try {
    return await run();
  } finally {
    release();
  }
}

async function main() {
  // No command-line modes at all: the operation arrives on stdin, and the only argument tolerated is the
  // empty one the sudoers drop-in pins as `<helper> ""`. Sudo accepts that pin both as no argument and
  // as one empty argument, so the helper accepts exactly the same two and nothing else. Checked before
  // the uid guard, so a refusal names the argument rather than the caller.
  if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== '')) {
    fail('helper accepts no command-line arguments');
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) fail('helper must run as root');
  const response = await handleRequest(readFramedRequest(0));
  // A raw execution has already written the guest's own bytes to this process's stdout and stderr. The
  // only thing left to report is the child's status, and it is reported as this process's exit code —
  // printing a verdict here is what would put a JSON blob in the caller's terminal.
  if (response?.raw === true) {
    process.exitCode = response.exitCode;
    return;
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
