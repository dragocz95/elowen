import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { activeExecutionLeases, createExecutionLease, withRepoLease } from './db.mjs';

const BWRAP = '/usr/bin/bwrap';
const CMD_VAR = 'ELOWEN_SANDBOX_CMD';
const EPHEMERAL_HOME = '/tmp/elowen-home';
const GENERATION_FILE = '.home-generation';
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ'];
const ETC_ALLOWLIST = [
  'hosts', 'host.conf', 'nsswitch.conf', 'gai.conf', 'passwd', 'group',
  'ssl', 'pki', 'ca-certificates', 'ca-certificates.conf', 'localtime', 'timezone',
  'alternatives', 'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'gitconfig',
  'gitattributes', 'npmrc', 'python3', 'terminfo',
];

let probeCache = null;

export function bubblewrapProbe() {
  if (probeCache) return probeCache;
  try {
    realpathSync(BWRAP);
    const probe = spawnSync(BWRAP, [
      '--ro-bind', '/usr', '/usr',
      '--symlink', 'usr/bin', '/bin',
      '--symlink', 'usr/lib', '/lib',
      '--symlink', 'usr/lib64', '/lib64',
      '--dev', '/dev',
      '--', '/usr/bin/true',
    ], { encoding: 'utf8', timeout: 5_000 });
    probeCache = probe.status === 0
      ? { available: true, reason: null }
      : { available: false, reason: (probe.stderr || probe.stdout || `bubblewrap exited ${probe.status}`).trim() };
  } catch (error) {
    probeCache = { available: false, reason: error?.code === 'ENOENT' ? 'bubblewrap is not installed' : String(error?.message ?? error) };
  }
  return probeCache;
}

export function resetBubblewrapProbe() { probeCache = null; }

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export function userRoot(dataDir, userId) { return join(dataDir, 'users', String(userId)); }
export function userHome(dataDir, userId) { return join(userRoot(dataDir, userId), 'home'); }
export function userWorkspacesRoot(dataDir, userId) { return join(userRoot(dataDir, userId), 'workspaces'); }

function generationPath(dataDir, userId) { return join(userRoot(dataDir, userId), GENERATION_FILE); }

export function homeGeneration(dataDir, userId) {
  ensurePrivateDir(userRoot(dataDir, userId));
  const file = generationPath(dataDir, userId);
  let generation = 1;
  try {
    const parsed = Number(readFileSync(file, 'utf8').trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) generation = parsed;
  } catch { writeFileSync(file, '1\n', { mode: 0o600 }); }
  return generation;
}

export function ensureUserHome(dataDir, userId) {
  const root = ensurePrivateDir(userRoot(dataDir, userId));
  ensurePrivateDir(join(root, 'workspaces'));
  const home = ensurePrivateDir(join(root, 'home'));
  const generation = homeGeneration(dataDir, userId);
  return { home, generation };
}

export function migrateLegacyHomes(dataDir) {
  const pluginDataRoot = dirname(dataDir);
  const legacyRoot = join(pluginDataRoot, 'terminal', 'sandbox-home');
  const collisions = [];
  let migrated = 0;
  const retainedSessions = [];
  if (!existsSync(legacyRoot)) return { collisions, migrated, retainedSessions };
  for (const entry of readdirSync(legacyRoot)) {
    const source = join(legacyRoot, entry);
    if (!lstatSync(source).isDirectory()) continue;
    const match = /^user-(\d+)$/.exec(entry);
    if (match) {
      const userId = Number(match[1]);
      const target = userHome(dataDir, userId);
      ensurePrivateDir(userRoot(dataDir, userId));
      ensurePrivateDir(userWorkspacesRoot(dataDir, userId));
      if (existsSync(target)) { collisions.push({ userId, source, target }); continue; }
      renameSync(source, target);
      chmodSync(target, 0o700);
      homeGeneration(dataDir, userId);
      migrated += 1;
      continue;
    }
    if (/^session-[a-f0-9]{16}$/.test(entry)) retainedSessions.push(source);
  }
  try { if (readdirSync(legacyRoot).length === 0) rmSync(legacyRoot, { recursive: true, force: true }); } catch { /* collision or retained session HOME remains */ }
  return { collisions, migrated, retainedSessions };
}

function bindableRoots(roots) {
  const out = [];
  for (const root of roots) {
    try {
      const real = realpathSync(root);
      if (!out.includes(real)) out.push(real);
    } catch { /* stale project/workspace path */ }
  }
  return out;
}

const within = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}${sep}`);

function etcBinds() {
  const args = [];
  try { args.push('--ro-bind-try', realpathSync('/etc/resolv.conf'), '/etc/resolv.conf'); }
  catch { /* DNS fails honestly when the host has no resolver config */ }
  for (const entry of ETC_ALLOWLIST) args.push('--ro-bind-try', `/etc/${entry}`, `/etc/${entry}`);
  return args;
}

function cleanHostEnv(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'));
  if (home) env.HOME = home;
  return env;
}

function confinedEnv(home) {
  const env = { HOME: home ?? EPHEMERAL_HOME };
  for (const key of ENV_ALLOWLIST) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  return env;
}

function shellWord(word) {
  const value = String(word);
  if (/^[A-Za-z0-9_/.:=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function buildBubblewrap(command, cwd, roots, home) {
  const binds = bindableRoots(roots);
  if (binds.length === 0) throw new Error('no accessible project directory is available for confined execution');
  const args = [
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
    '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/sbin', '/sbin',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    ...etcBinds(),
  ];
  for (const root of binds) args.push('--bind', root, root);
  if (home) {
    if (!binds.includes(realpathSync(home))) args.push('--bind', home, home);
    args.push('--setenv', 'HOME', home);
  } else {
    args.push('--dir', EPHEMERAL_HOME, '--setenv', 'HOME', EPHEMERAL_HOME);
  }
  args.push('--chdir', cwd, '--');

  const env = confinedEnv(home);
  if (command.type === 'shell') {
    env[CMD_VAR] = command.command;
    const full = [...args, '/bin/bash', '-c'];
    return { type: 'shell', command: `exec ${BWRAP} ${full.map(shellWord).join(' ')} "$${CMD_VAR}"`, env };
  }
  return { type: 'argv', file: BWRAP, args: [...args, command.file, ...command.args], env };
}

function workspaceForCwd(workspaces, accountUserId, cwd) {
  if (accountUserId === null) return null;
  const real = resolve(cwd);
  return workspaces
    .filter((workspace) => workspace.userId === accountUserId && workspace.lifecycle === 'active')
    .find((workspace) => within(real, resolve(workspace.path))) ?? null;
}

export function createExecutionService({ ctx, db, dataDir, listWorkspaces }) {
  const prepare = async (input, options = {}) => {
    const access = ctx.currentAccess();
    const accountUserId = options.accountUserId !== undefined
      ? options.accountUserId
      : ctx.currentContributionUserId() ?? ctx.currentIdentity()?.elowenUserId ?? null;
    const owner = options.owner !== undefined ? options.owner === true : access.owner === true;
    const configuredRoots = options.roots ?? ctx.allowedRoots();
    const roots = bindableRoots([...new Set(configuredRoots.map(String))]);
    const cwd = realpathSync(input.cwd);
    if (!owner && !roots.some((root) => within(cwd, root))) {
      throw new Error('execution cwd is outside the current account’s accessible project and workspace roots');
    }
    const workspace = workspaceForCwd(listWorkspaces(), accountUserId, cwd);

    let home = process.env.HOME || '/';
    let generation = null;
    if (accountUserId !== null) {
      const state = ensureUserHome(dataDir, accountUserId);
      home = state.home;
      generation = state.generation;
    } else if (!owner) {
      home = EPHEMERAL_HOME;
    }

    let mode;
    let launch;
    if (owner || (accountUserId !== null && ctx.config.confineNonOperators === false)) {
      mode = 'direct';
      launch = input.command.type === 'shell'
        ? { type: 'shell', command: input.command.command, env: cleanHostEnv(home) }
        : { type: 'argv', file: input.command.file, args: input.command.args, env: cleanHostEnv(home) };
    } else {
      if (roots.length === 0) throw new Error('confined execution is unavailable because no safe project root can be verified');
      const probe = bubblewrapProbe();
      if (!probe.available) throw new Error(`confined execution is unavailable: ${probe.reason || 'bubblewrap probe failed'}`);
      mode = 'confined';
      launch = buildBubblewrap(input.command, cwd, roots, accountUserId === null ? null : home);
    }

    const mintLease = () => createExecutionLease(db, {
      accountUserId,
      workspaceId: workspace?.id ?? null,
      homeGeneration: generation,
      kind: input.leaseKind,
    });
    // HOME reset and process launch share this short cross-process lock. The lease is inserted before the
    // lock is released, so reset cannot pass its final active-process check while a launch is being minted.
    const lease = accountUserId === null || options.skipHomeLock === true
      ? mintLease()
      : await withRepoLease(db, `home:${accountUserId}`, async () => {
          generation = homeGeneration(dataDir, accountUserId);
          return mintLease();
        });
    return {
      mode,
      cwd,
      home,
      roots,
      launch,
      workspace: workspace ? {
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        path: workspace.path,
        label: workspace.label,
        branch: workspace.branch,
        baseRef: workspace.baseRef,
      } : null,
      lease,
    };
  };
  return { prepare };
}

export async function runPrepared(prepared, opts = {}) {
  const cap = opts.outputCap ?? 2_000_000;
  let output = '';
  let settled = false;
  const heartbeat = setInterval(() => { void prepared.lease.heartbeat(); }, 5_000);
  heartbeat.unref?.();
  try {
    const child = prepared.launch.type === 'argv'
      ? spawn(prepared.launch.file, prepared.launch.args, { cwd: prepared.cwd, env: prepared.launch.env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(prepared.launch.command, { cwd: prepared.cwd, env: prepared.launch.env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > cap) output = output.slice(output.length - cap);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const result = await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveResult({ code: code ?? -1, signal, output }));
    });
    settled = true;
    if (result.code !== 0 && opts.allowFailure !== true) {
      const error = new Error(result.output.trim() || `command exited ${result.code}`);
      error.code = result.code;
      throw error;
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    await prepared.lease.release();
    if (!settled) { /* release above covers spawn failures too */ }
  }
}

export function directorySize(path, limits = {}) {
  const maxEntries = limits.maxEntries ?? 20_000;
  let entries = 0;
  let bytes = 0;
  const stack = existsSync(path) ? [path] : [];
  while (stack.length && entries < maxEntries) {
    const current = stack.pop();
    let children;
    try { children = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      entries += 1;
      const full = join(current, child.name);
      try {
        if (child.isDirectory()) stack.push(full);
        else if (child.isFile()) bytes += statSync(full).size;
      } catch { /* raced with cleanup */ }
      if (entries >= maxEntries) break;
    }
  }
  return { bytes, entries, truncated: stack.length > 0 || entries >= maxEntries };
}

export function resetUserHome({ db, dataDir, userId, expectedGeneration }) {
  const current = ensureUserHome(dataDir, userId);
  if (current.generation !== expectedGeneration) throw Object.assign(new Error('HOME changed since the preview was created'), { status: 409, code: 'home_changed' });
  const active = activeExecutionLeases(db, { accountUserId: userId, homeGeneration: current.generation });
  if (active.length > 0) throw Object.assign(new Error('HOME is in use by an active process'), { status: 409, code: 'home_in_use' });

  const nextGeneration = current.generation + 1;
  const retired = join(userRoot(dataDir, userId), `retired-home-g${current.generation}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  renameSync(current.home, retired);
  ensurePrivateDir(current.home);
  writeFileSync(generationPath(dataDir, userId), `${nextGeneration}\n`, { mode: 0o600 });
  rmSync(retired, { recursive: true, force: true });
  return { generation: nextGeneration };
}

export function removeUserData(dataDir, userId) {
  rmSync(userRoot(dataDir, userId), { recursive: true, force: true });
}

export function assertRelativePath(value) {
  const normalized = String(value).trim().replaceAll('\\', '/');
  if (!normalized || isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`invalid workspace-relative path: ${value}`);
  }
  return normalized.replace(/^\.\//, '');
}

export function relativeInside(root, absolute) {
  const rel = relative(realpathSync(root), realpathSync(absolute));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path is outside the workspace');
  return rel.split(sep).join('/');
}
