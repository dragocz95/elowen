import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// The installed root helper is standalone ESM — after sudo it cannot import service-user-owned package
// code — so the contract is pinned against the bytes that are actually shipped and installed.
// @ts-expect-error the standalone privileged helper intentionally has no TypeScript declaration file
import {
  DISK_TREE_SCRIPTS,
  MACHINE_UNIT_PATH,
  MACHINE_FIREWALL_UNIT,
  MACHINE_FIREWALL_UNIT_NAME,
  MACHINE_FIREWALL_UNIT_PATH,
  MACHINE_UNIT_TEMPLATE,
  firewallRuleCommand,
  NSPAWN_FIREWALL_RULES,
  POLKIT_RULE_PATH,
  applyNspawnRequest,
  applyRequest,
  handleRequest,
  helperRequestNeedsDeployment,
  helperRequestNeedsMutationLock,
  machineUnitFor,
  nspawnDiskPaths,
  nspawnExecArgs,
  renderMachineDropIn,
  renderMachineSettings,
  renderPolkitRule,
  safeGuestMountTarget,
  storageRootsFor,
  trustedPath,
} from '../../scripts/elowen-site-gateway.mjs';
// @ts-expect-error the bundled Sandbox plugin is plain ESM without declarations
import { createBoundSiteSpec, createEnvironmentDiskSpec } from '../../plugins/sandbox/lib/containerSpec.mjs';
// @ts-expect-error the bundled machine runtime is plain ESM without declarations
import { HELPER_PATH as PLUGIN_HELPER_PATH, MACHINE_PATTERN as PLUGIN_MACHINE_PATTERN, helperRequest } from '../../plugins/sandbox/lib/nspawn.mjs';
import {
  siteGatewayStorageRoots,
  encodeHelperRequest, HELPER_FRAME_HEADER_BYTES, SITE_GATEWAY_HELPER_ARGV, SITE_GATEWAY_HELPER_PATH,
} from '../../src/shared/siteGateway.js';

const HELPER_SOURCE = fileURLToPath(new URL('../../scripts/elowen-site-gateway.mjs', import.meta.url));
const PODMAN_SOURCE = fileURLToPath(new URL('../../plugins/sandbox/lib/podman.mjs', import.meta.url));
const PLUGIN_RUNTIME = fileURLToPath(new URL('../../plugins/sandbox/lib/nspawn.mjs', import.meta.url));

const MACHINE = 'elowen-project-54-g3';
const UNIT = `elowen-exec-g3-${'a'.repeat(32)}.service`;
const environment = { SUDO_USER: 'azureuser', SUDO_UID: '1000', SUDO_GID: '1000' };
const scratch = mkdtempSync(join(tmpdir(), 'elowen-nspawn-contract-'));
// Exactly as the helper derives them in production: from the passwd home of the account sudo reports,
// and from nothing a caller can reach.
const storage = storageRootsFor(scratch);
/** How the runtime names an environment on the wire: the resource kind and its id in the string form
 *  the disk layout uses as a path segment. */
const diskRef = {
  namespace: 'elowen',
  kind: 'project',
  resource: '54',
  generation: 3,
  diskId: 'a'.repeat(32),
  machine: MACHINE,
  specHash: 'd'.repeat(64),
};

afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

type Call = { file: string; args: string[] };

/** A host model rather than a stub: the artefacts have content AND permission bits, the manager remembers
 *  whether it has read the unit template, and the network prerequisites can be moved one at a time. That
 *  is what makes a convergence claim testable — provisioning is run twice against the same host. */
function runnerFixture(options: {
  installed?: boolean; polkit?: string; polkitMode?: number; unit?: string; unitMode?: number;
  unitLoaded?: boolean; firewall?: boolean; forwarding?: boolean; networkd?: boolean; deployment?: string;
  firewallUnit?: string; firewallEnabled?: boolean;
} = {}) {
  const calls: Call[] = [];
  const writes: { path: string; content: string; mode: number }[] = [];
  const state = {
    installed: options.installed ?? true,
    polkit: options.polkit ?? '',
    polkitMode: options.polkitMode ?? 0o644,
    unit: options.unit ?? '',
    unitMode: options.unitMode ?? 0o644,
    unitLoaded: options.unitLoaded ?? false,
    firewall: options.firewall ?? false,
    firewallUnit: options.firewallUnit ?? '',
    firewallUnitMode: 0o644,
    firewallEnabled: options.firewallEnabled ?? false,
    forwarding: options.forwarding ?? true,
    networkd: options.networkd ?? true,
    deployment: options.deployment ?? JSON.stringify({ storage: { sandboxDataDir: '/srv/sandbox', sitesDataDir: '/srv/sites' } }),
  };
  const readText = (path: string) => {
    if (path === '/etc/elowen/site-gateway.json') return state.deployment;
    if (path === '/etc/os-release') return 'ID=ubuntu\n';
    if (path === POLKIT_RULE_PATH) return state.polkit;
    if (path === MACHINE_UNIT_PATH) return state.unit;
    if (path === MACHINE_FIREWALL_UNIT_PATH) return state.firewallUnit;
    if (path === '/proc/sys/net/ipv4/ip_forward') return state.forwarding ? '1\n' : '0\n';
    return '';
  };
  const readMode = (path: string) => {
    if (path === POLKIT_RULE_PATH) return state.polkit === '' ? -1 : state.polkitMode;
    if (path === MACHINE_UNIT_PATH) return state.unit === '' ? -1 : state.unitMode;
    if (path === MACHINE_FIREWALL_UNIT_PATH) return state.firewallUnit === '' ? -1 : state.firewallUnitMode;
    return -1;
  };
  const writeAtomic = (path: string, content: Buffer, mode: number) => {
    const value = content.toString('utf8');
    writes.push({ path, content: value, mode });
    if (path === POLKIT_RULE_PATH) { state.polkit = value; state.polkitMode = mode; }
    // A file the manager has never read is exactly what a fresh write leaves behind.
    if (path === MACHINE_UNIT_PATH) { state.unit = value; state.unitMode = mode; state.unitLoaded = false; }
    if (path === MACHINE_FIREWALL_UNIT_PATH) { state.firewallUnit = value; state.firewallUnitMode = mode; }
  };
  const runner = (file: string, args: string[]) => {
    calls.push({ file, args: [...args] });
    if (file === '/usr/bin/getent') return { ok: true, stdout: 'azureuser:x:1000:1000::/home/azureuser:/bin/bash\n' };
    if (file === '/usr/bin/dpkg-query') return state.installed ? { ok: true, stdout: 'install ok installed\n' } : { ok: false, stderr: 'not installed' };
    if (file === '/usr/sbin/iptables' || file === '/usr/sbin/ip6tables') {
      return state.firewall ? { ok: true, stdout: '' } : { ok: false, stderr: 'No chain/target/match by that name' };
    }
    if (file === '/usr/bin/apt-get') { state.installed = true; return { ok: true, stdout: '' }; }
    if (file === '/usr/bin/systemctl') {
      if (args[0] === 'show') return { ok: true, stdout: `${state.unitLoaded ? 'loaded' : 'not-found'}\n` };
      if (args[0] === 'daemon-reload') { state.unitLoaded = state.unit !== ''; return { ok: true, stdout: '' }; }
      if (args[0] === 'enable') {
        // What the unit does when it runs: every rule checked, then applied when it is not there.
        state.firewallEnabled = true;
        state.firewall = true;
        return { ok: true, stdout: '' };
      }
      if (args[0] === 'is-enabled' && args[1] === MACHINE_FIREWALL_UNIT_NAME) {
        return state.firewallEnabled ? { ok: true, stdout: 'enabled\n' } : { ok: false, stderr: 'disabled' };
      }
      if (args[0] === 'is-active' || args[0] === 'is-enabled') {
        return state.networkd ? { ok: true, stdout: 'active\n' } : { ok: false, stderr: 'inactive' };
      }
    }
    return { ok: false, stderr: `unexpected command: ${file} ${args.join(' ')}` };
  };
  return { calls, writes, state, runner, readText, readMode, writeAtomic, options: { runner, readText, readMode, writeAtomic, env: environment } };
}

function reloads(calls: Call[]) {
  return calls.filter((call) => call.file === '/usr/bin/systemctl' && call.args[0] === 'daemon-reload').length;
}

type Row = { id: string; label: string; ok: boolean; detail: string };
type Readiness = { ready: boolean; items: Row[] };
const rowFor = (readiness: Readiness, id: string) => readiness.items.find((item) => item.id === id)!;

describe('privileged helper: two typed domains, one executable', () => {
  it('keeps an absent domain meaning sites, so an older daemon still reaches the gateway', async () => {
    // The helper is installed independently of the daemon that invokes it, so a helper carrying the
    // discriminator can meet a daemon that predates it. The daemon side always sends it explicitly.
    expect(helperRequestNeedsDeployment({ op: 'status' })).toBe(true);
    expect(helperRequestNeedsDeployment({ domain: 'sites', op: 'status' })).toBe(true);
    await expect(applyRequest({ domain: 'sites', op: 'environment-support-status' }, undefined)).rejects.toThrow(/not supported/);
    await expect(applyRequest({ domain: 'machines', op: 'status' }, undefined)).rejects.toThrow(/domain is invalid/);
  });

  it('never asks for the Sites domain record on behalf of a machine operation', () => {
    for (const op of ['status', 'provision', 'exec', 'freeze', 'thaw', 'materialize', 'tree-copy', 'destroy']) {
      expect(helperRequestNeedsDeployment({ domain: 'nspawn', op })).toBe(false);
    }
  });

  it('refuses an unknown machine operation rather than falling through to the sites table', async () => {
    await expect(applyRequest({ domain: 'nspawn', op: 'deny' }, undefined)).rejects.toThrow(/machine operation is not supported/);
    await expect(applyRequest({ domain: 'nspawn', op: 'ensure-site' }, undefined)).rejects.toThrow(/machine operation is not supported/);
  });
});

describe('privileged helper: machine identity', () => {
  it('accepts only a runtime-shaped machine name and always derives the unit from it', () => {
    expect(machineUnitFor(MACHINE)).toBe(`elowen-machine@${MACHINE}.service`);
    expect(machineUnitFor('elowen-site-1e5b2c-g12')).toBe('elowen-machine@elowen-site-1e5b2c-g12.service');
    for (const bad of ['../etc/passwd', 'elowen-project-54', 'other-project-54-g1', 'elowen-project-54-g3/x',
      'elowen-project-54-g3.service', 'elowen-project-UPPER-g1', `elowen-project-${'a'.repeat(65)}-g1`]) {
      expect(() => machineUnitFor(bad)).toThrow(/machine name is invalid/);
      // The bundled runtime refuses the same names before it ever reaches sudo; the two patterns live in
      // files that cannot import each other, so they are held together here.
      expect(PLUGIN_MACHINE_PATTERN.test(bad), bad).toBe(false);
    }
    expect(PLUGIN_MACHINE_PATTERN.test(MACHINE)).toBe(true);
  });
});

describe('privileged helper: execution', () => {
  it('builds the systemd-run option list itself and appends the guest argv after the separator', () => {
    const args = nspawnExecArgs({ machine: MACHINE, unit: UNIT, argv: ['/bin/sh', '-c', 'echo hi'], cwd: '/workspace', timeoutSeconds: 120 });
    expect(args).toEqual([
      '-M', MACHINE, '--quiet', '--pipe', '--wait', '--collect', `--unit=${UNIT}`,
      '--service-type=exec', '--expand-environment=no', '--property=KillMode=control-group',
      '--property=TimeoutStopSec=5s', '--property=TasksMax=infinity', '--property=RuntimeMaxSec=120s',
      '--working-directory=/workspace', '--', '/bin/sh', '-c', 'echo hi',
    ]);
  });

  it('delivers the guest argv byte for byte, without systemd rewriting a variable reference out of it', () => {
    // A transient unit's command line is a systemd command line, and the manager substitutes into it at
    // exec time unless told not to. Measured against systemd 255.4 on this host, with the flag absent:
    //   `-f=${Status}` arrives as `-f=`            an unset ${VAR} becomes the empty string
    //   `$HOME` arrives as nothing at all           an unset $VAR word-splits into zero arguments
    //   `$$` arrives as `$`                         the escape is consumed
    // So `dpkg-query -W -f=${Status} <pkg>` ran as `dpkg-query -W -f= <pkg>` and failed on a format it was
    // never given. Anything a person types with a variable in it was quietly turned into something else.
    // Percent specifiers were measured to pass through untouched either way: they are resolved when a unit
    // FILE is parsed, and there is no file here. They are pinned anyway, because the day that changes the
    // failure is silent again.
    const argv = ['/usr/bin/dpkg-query', '-W', '-f=${Status}', '$HOME', '$$', '%H', '%%', 'a${X}b', 'PATH=$PATH:/opt'];
    const args = nspawnExecArgs({ machine: MACHINE, unit: UNIT, argv, cwd: '/workspace', timeoutSeconds: 30 });
    const separator = args.indexOf('--');
    expect(args.slice(separator + 1)).toEqual(argv);
    expect(args).toContain('--expand-environment=no');
    // Before the separator, or systemd-run would read it as part of the guest command.
    expect(args.indexOf('--expand-environment=no')).toBeLessThan(separator);
  });

  it('treats the guest command as opaque payload that can never be read as an option', () => {
    // Running an arbitrary command inside a managed environment, as root or through sudo, is what the
    // environment is FOR. The helper does not inspect, allow-list or rewrite it. What it enforces is
    // placement: everything the caller sends lands after `--`, where systemd-run stops parsing options.
    const hostile = ['/usr/bin/sudo', '--property=ExecStart=/bin/false', '-M', 'other-machine', '--pipe', '-H', 'root@elsewhere'];
    const args = nspawnExecArgs({ machine: MACHINE, unit: UNIT, argv: hostile, cwd: '/root', timeoutSeconds: 5 });
    const separator = args.indexOf('--');
    expect(args.slice(separator + 1)).toEqual(hostile);
    expect(args.slice(0, separator).filter((value: string) => value === '-M')).toHaveLength(1);
    expect(args[separator - 1]).toBe('--working-directory=/root');
  });

  it('keeps only the transport hygiene the container runtime already applies', () => {
    const base = { machine: MACHINE, unit: UNIT, cwd: '/workspace', timeoutSeconds: 60 };
    expect(() => nspawnExecArgs({ ...base, argv: [] })).toThrow(/command arguments are invalid/);
    expect(() => nspawnExecArgs({ ...base, argv: ['sh'] })).toThrow(/command arguments are invalid/);
    expect(() => nspawnExecArgs({ ...base, argv: ['/bin/sh', 'a\0b'] })).toThrow(/command arguments are invalid/);
    expect(() => nspawnExecArgs({ ...base, argv: new Array(257).fill('/bin/true') })).toThrow(/command arguments are invalid/);
    expect(() => nspawnExecArgs({ ...base, argv: ['/bin/sh', 'x'.repeat(64 * 1024 + 1)] })).toThrow(/command arguments are invalid/);
    // A guest path, not a host path: only absolute and free of NUL and newline, exactly as today.
    expect(() => nspawnExecArgs({ ...base, argv: ['/bin/sh'], cwd: 'relative' })).toThrow(/working directory is invalid/);
    expect(() => nspawnExecArgs({ ...base, argv: ['/bin/sh'], cwd: '/tmp\nx' })).toThrow(/working directory is invalid/);
    expect(nspawnExecArgs({ ...base, argv: ['/bin/sh'], cwd: '/var/lib/../lib' })).toContain('--working-directory=/var/lib/../lib');
    expect(() => nspawnExecArgs({ ...base, argv: ['/bin/sh'], timeoutSeconds: 0 })).toThrow(/timeout is invalid/);
    expect(() => nspawnExecArgs({ ...base, argv: ['/bin/sh'], timeoutSeconds: 901 })).toThrow(/timeout is invalid/);
    expect(() => nspawnExecArgs({ ...base, argv: ['/bin/sh'], unit: '--property=X' })).toThrow(/unit name is invalid/);
  });

  it('propagates the child status and keeps stdout and stderr separate', () => {
    const captured: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
    const response = applyNspawnRequest({
      domain: 'nspawn', op: 'exec', machine: MACHINE, unit: UNIT, argv: ['/bin/sh', '-c', 'exit 42'], cwd: '/workspace', timeoutSeconds: 30,
    }, {
      spawn: (file: string, args: string[], options: Record<string, unknown>) => {
        captured.push({ file, args, options });
        return { status: 42, signal: null, stdout: Buffer.from('out'), stderr: Buffer.from('err') };
      },
    });
    expect(response).toMatchObject({ ok: true, exitCode: 42, timedOut: false, truncated: false });
    expect(Buffer.from(response.stdout, 'base64').toString()).toBe('out');
    expect(Buffer.from(response.stderr, 'base64').toString()).toBe('err');
    // stdin is INHERITED: the entry point left the remainder of the pipe for the child, so the guest
    // reads its own input directly instead of the helper buffering it.
    expect(captured[0].file).toBe('/usr/bin/systemd-run');
    expect(captured[0].options.stdio).toEqual(['inherit', 'pipe', 'pipe']);
    expect(captured[0].options.killSignal).toBe('SIGKILL');
    expect(captured[0].options.timeout).toBe(40_000);
  });

  it('passes the guest streams straight through in raw mode and never prints a verdict', () => {
    // The LAUNCHED path: the daemon spawns this helper itself and streams the result to a terminal, so a
    // JSON verdict is exactly what must not appear. The child's streams are inherited and its status
    // becomes the helper's own exit code, which is how `podman exec` behaves today.
    const captured: Record<string, unknown>[] = [];
    const response = applyNspawnRequest({
      domain: 'nspawn', op: 'exec', raw: true, machine: MACHINE, unit: UNIT,
      argv: ['/bin/bash', '-s'], cwd: '/workspace', timeoutSeconds: 30,
    }, {
      spawn: (_file: string, _args: string[], options: Record<string, unknown>) => {
        captured.push(options);
        return { status: 7, signal: null, stdout: null, stderr: null };
      },
    });
    expect(response).toEqual({ raw: true, exitCode: 7 });
    expect(response.ok).toBeUndefined();
    expect(response.stdout).toBeUndefined();
    expect(captured[0].stdio).toEqual(['inherit', 'inherit', 'inherit']);
  });

  it('starts a detached unit without waiting for it, and confirms it came up', () => {
    // A publication forwarder and a preview server never exit, so `--pipe`, `--wait` and the runtime
    // deadline are dropped. A bare acknowledgement would leave the caller unable to tell a started server
    // from one that failed on its first line, so the verdict carries the unit's own state.
    const calls: Call[] = [];
    const options = {
      spawn: () => ({ status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
      runner: (file: string, args: string[]) => {
        calls.push({ file, args });
        return { ok: true, stdout: 'active\n' };
      },
    };
    const request = {
      domain: 'nspawn', op: 'exec', detached: true, machine: MACHINE, unit: UNIT,
      argv: ['/usr/bin/node', 'server.js'], cwd: '/workspace', timeoutSeconds: 30,
    };
    const args = nspawnExecArgs(request);
    expect(args).not.toContain('--pipe');
    expect(args).not.toContain('--wait');
    expect(args.some((value: string) => value.startsWith('--property=RuntimeMaxSec='))).toBe(false);
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['/usr/bin/node', 'server.js']);

    expect(applyNspawnRequest(request, options)).toMatchObject({ ok: true, detached: true, unit: UNIT, state: 'active' });
    expect(calls).toEqual([{ file: '/usr/bin/systemctl', args: ['-M', MACHINE, 'is-active', UNIT] }]);

    expect(() => applyNspawnRequest(request, { ...options, runner: () => ({ ok: false, stdout: 'failed\n' }) }))
      .toThrow(/not active after starting it/);
    expect(() => nspawnExecArgs({ ...request, raw: true })).toThrow(/no streams to pass through/);
  });

  it('reports a timeout as a timeout instead of a failed start', () => {
    const response = applyNspawnRequest({
      domain: 'nspawn', op: 'exec', machine: MACHINE, unit: UNIT, argv: ['/bin/sleep', '600'], cwd: '/workspace', timeoutSeconds: 1,
    }, {
      spawn: () => ({ status: null, signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }),
    });
    expect(response).toMatchObject({ ok: true, exitCode: null, signal: 'SIGKILL', timedOut: true });
  });
});

describe('privileged helper: host path derivation', () => {
  it('derives the root filesystem and the identity record, and mirrors the runtime disk layout', () => {
    const paths = nspawnDiskPaths(storage, diskRef);
    const spec = createEnvironmentDiskSpec(
      { resource: { kind: 'project', id: Number(diskRef.resource) }, image: 'localhost/elowen-project-base:1', runtime: 'nspawn' },
      { sandboxDataDir: storage.sandboxDataDir, namespace: 'elowen' },
      diskRef.diskId,
    );
    expect(paths.rootfs).toBe(spec.rootfsPath);
    // The identity sits in the disk directory, OUTSIDE the root filesystem. A marker inside the tree
    // would prove nothing: the guest is root over that tree.
    expect(paths.identity).toBe(join(spec.rootfsPath, '..', '.elowen', 'identity.json').replace('/rootfs/..', ''));
    expect(paths.identity.startsWith(`${paths.directory}/`)).toBe(true);
  });

  it('derives a site disk under the sites root', () => {
    const siteId = randomUUID();
    const paths = nspawnDiskPaths(storage, { kind: 'site', resource: siteId, diskId: 'b'.repeat(32) });
    expect(paths.rootfs).toBe(join(storage.sitesDataDir, siteId, 'environment', 'disks', 'b'.repeat(32), 'rootfs'));
  });

  it('derives the storage roots from the invoking account, so a planted record cannot move them', async () => {
    // They used to be read out of the deployment record, and that was a hole. The record is installed
    // through a sudoers-pinned command whose source path is fixed and writable by the service user, and a
    // sudoers grant binds to a USER, not to the code path it was written for. Anything running as the
    // service account could therefore stage a record naming `/etc/systemd` as a storage root, run the
    // pinned install, and every path check here would agree from the next request onwards — which is a
    // tar unpacked as root, or a tree deleted as root, anywhere it liked.
    const home = join(scratch, 'derived-home');
    const derived = storageRootsFor(home);
    expect(derived).toEqual({
      sandboxDataDir: `${home}/.config/elowen/plugins-data/sandbox`,
      sitesDataDir: `${home}/.config/elowen/plugins-data/sites`,
    });
    // The installer makes the same derivation for its own purposes, in a file that cannot import this one.
    expect(derived).toEqual(siteGatewayStorageRoots(home));

    // End to end, with no storage handed in: the roots follow the passwd home sudo reports and nothing
    // else, and a path a record might have blessed is still refused.
    const runner = (file: string) => (file === '/usr/bin/getent'
      ? { ok: true, stdout: `azureuser:x:1000:1000::${home}:/bin/bash\n` }
      : { ok: true, stdout: '' });
    const doomed = join(derived.sandboxDataDir, 'projects', '54', 'stale');
    mkdirSync(doomed, { recursive: true });
    await applyRequest({ domain: 'nspawn', op: 'tree-remove', path: doomed }, undefined, { runner, env: environment });
    expect(existsSync(doomed)).toBe(false);
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-remove', path: '/etc/systemd/nspawn' }, undefined, { runner, env: environment }))
      .rejects.toThrow(/outside the trusted storage roots/);
  });

  it('changes a mount point it just created through the descriptor, never through the name again', () => {
    // The mount point is created by root inside a directory the service user owns, so between naming the
    // entry and changing it the owner can unlink it and leave a link to a system file in its place. A
    // chown by path would then hand that file over, and `write-envelope` can be called until the window
    // is hit. `O_DIRECTORY|O_NOFOLLOW` refuses a symlink and cannot resolve to a regular file at all.
    const source = readFileSync(HELPER_SOURCE, 'utf8');
    for (const [name, end] of [
      ['function ensureMountPoint', 'function nspawnDropCapabilities'],
      ['function ensureIdentityDirectory', 'function openDirectory'],
    ]) {
      const body = source.slice(source.indexOf(name), source.indexOf(end));
      expect(body, name).toMatch(/fchownSync|fchmodSync/);
      expect(body, name).not.toMatch(/\bchownSync\(|\bchmodSync\(/);
    }
    expect(source).toContain('O_RDONLY | O_DIRECTORY | O_NOFOLLOW');
  });

  it('refuses a request that tries to name a root or an id of its own', () => {
    expect(() => storageRootsFor('relative')).toThrow(/no home directory/);
    expect(() => storageRootsFor(undefined)).toThrow(/no home directory/);
    // A home a passwd record could still spell that the path rules refuse, so the derivation is checked
    // rather than assumed once it leaves getent.
    expect(() => storageRootsFor('/home/colon:in:name')).toThrow(/storage root is invalid/);
    expect(() => nspawnDiskPaths(storage, { ...diskRef, diskId: '../../etc' })).toThrow(/disk id is invalid/);
    expect(() => nspawnDiskPaths(storage, { ...diskRef, resource: '54; rm' })).toThrow(/resource id is invalid/);
    expect(() => nspawnDiskPaths(storage, { ...diskRef, resource: '../etc' })).toThrow(/resource id is invalid/);
    expect(() => nspawnDiskPaths(storage, { ...diskRef, kind: 'machine' })).toThrow(/resource kind is invalid/);
    // The machine's own root filesystem is never taken from the request, whatever it claims to carry.
    const paths = nspawnDiskPaths(storage, { ...diskRef, rootfsPath: '/etc', directory: '/etc' });
    expect(paths.rootfs.startsWith(`${storage.sandboxDataDir}/`)).toBe(true);
  });

  // The runtime derives snapshot trees, `.pending` staging directories and migration archives itself,
  // and names them whole; describing them as components instead would mean naming something other than
  // the path actually used. So they are re-validated here against the trusted roots.
  it('accepts an absolute path only inside a trusted root, with no symlink in any component', () => {
    const inside = join(storage.sandboxDataDir, 'projects', '54', 'snapshots', 'snap1', 'rootfs');
    mkdirSync(inside, { recursive: true });
    expect(trustedPath(storage, inside)).toBe(inside);
    expect(trustedPath(storage, `${inside}.pending`, { allowMissing: true })).toBe(`${inside}.pending`);

    for (const outside of ['/etc/shadow', '/var/lib/elowen/site-gateway.json', scratch, storage.sandboxDataDir]) {
      expect(() => trustedPath(storage, outside)).toThrow(/outside the trusted storage roots/);
    }
    expect(() => trustedPath(storage, `${storage.sandboxDataDir}/projects/../../etc`)).toThrow(/path is invalid/);
    expect(() => trustedPath(storage, 'projects/54')).toThrow(/path is invalid/);
    expect(() => trustedPath(storage, `${inside}/missing`)).toThrow(/does not exist/);
  });

  it('refuses a symlink anywhere along a requested path, and leaves its target alone', async () => {
    const paths = nspawnDiskPaths(storage, diskRef);
    mkdirSync(join(scratch, 'elsewhere'), { recursive: true });
    mkdirSync(paths.directory, { recursive: true });
    const planted = join(paths.directory, 'data');
    symlinkSync(join(scratch, 'elsewhere'), planted);
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-remove', path: planted }, undefined, { storage }))
      .rejects.toThrow(/symlink appears in a trusted storage path/);
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-remove', path: join(planted, 'inner') }, undefined, { storage }))
      .rejects.toThrow(/symlink appears in a trusted storage path/);
    expect(existsSync(join(scratch, 'elsewhere'))).toBe(true);
    rmSync(planted, { force: true });
  });
});

describe('privileged helper: the four merge constraints', () => {
  it('classifies execution, freeze, thaw and the read-only tree operations as lock-free', () => {
    // The reads join the named set for the same reason: a fifteen-minute walk over a multi-gigabyte tree
    // holding the global mutation lock would block a certificate renewal, and be blocked by one.
    for (const op of ['exec', 'freeze', 'thaw', 'tree-fingerprint', 'tree-preflight', 'tree-verify', 'status']) {
      expect(helperRequestNeedsMutationLock({ domain: 'nspawn', op })).toBe(false);
    }
    for (const op of ['provision', 'materialize', 'write-envelope', 'shift-ownership', 'tree-copy', 'tree-sync', 'tree-remove', 'destroy']) {
      expect(helperRequestNeedsMutationLock({ domain: 'nspawn', op })).toBe(true);
    }
    // The Sites classification is unchanged: the same five read-only operations as before.
    for (const op of ['status', 'environments-status', 'prepare-runtime-socket', 'seal-runtime-socket', 'remove-runtime-socket']) {
      expect(helperRequestNeedsMutationLock({ op })).toBe(false);
    }
    for (const op of ['sync-sites', 'ensure-site', 'remove-site', 'deny', 'environments-provision']) {
      expect(helperRequestNeedsMutationLock({ op })).toBe(true);
    }
  });

  it('runs an execution while the global mutation lock is held, and still serializes a mutation', async () => {
    // Without this, every Bash tool call in every environment would block behind a certificate renewal:
    // issuance is budgeted six minutes and the apt transaction twelve, against a nine-minute lock wait.
    const lockPath = join(scratch, 'mutation.lock');
    writeFileSync(lockPath, `${process.pid}\n`);
    const started = Date.now();
    const executed = await handleRequest({
      domain: 'nspawn', op: 'exec', machine: MACHINE, unit: UNIT, argv: ['/bin/true'], cwd: '/workspace', timeoutSeconds: 30,
    }, { lockPath, spawn: () => ({ status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) });
    expect(executed).toMatchObject({ ok: true, exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(1_000);

    const removable = join(nspawnDiskPaths(storage, diskRef).directory, 'data');
    mkdirSync(removable, { recursive: true });
    let settled = false;
    const pending = handleRequest({ domain: 'nspawn', op: 'tree-remove', path: removable }, { lockPath, storage })
      .then((value: unknown) => { settled = true; return value; });
    await new Promise((resolve) => { setTimeout(resolve, 350); });
    expect(settled).toBe(false);
    expect(existsSync(removable)).toBe(true);
    rmSync(lockPath, { force: true });
    expect(await pending).toMatchObject({ ok: true });
    expect(existsSync(removable)).toBe(false);
  });

  it('reads the request with exact byte counts and leaves the guest stdin in the pipe', async () => {
    // Reading fd 0 through the stream would buffer past the header and silently truncate an execution's
    // input, so this runs the SHIPPED entry point over a real pipe with a megabyte of guest stdin.
    const payload = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
    const request = {
      domain: 'nspawn', op: 'exec', machine: MACHINE, unit: UNIT, argv: ['/bin/cat'], cwd: '/workspace', timeoutSeconds: 30,
    };
    const script = `import { readFramedRequest } from ${JSON.stringify(HELPER_SOURCE)};
import { readSync } from 'node:fs';
import { createHash } from 'node:crypto';
const parsed = readFramedRequest(0);
const hash = createHash('sha256');
const buffer = Buffer.allocUnsafe(65536);
let bytes = 0;
for (;;) {
  const read = readSync(0, buffer, 0, buffer.length, null);
  if (read === 0) break;
  bytes += read;
  hash.update(buffer.subarray(0, read));
}
process.stdout.write(JSON.stringify({ parsed, bytes, digest: hash.digest('hex') }));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    const frame = encodeHelperRequest(request);
    expect(frame.subarray(0, HELPER_FRAME_HEADER_BYTES).toString()).toMatch(/^[0-9]{8}\n$/);
    child.stdin.write(frame);
    child.stdin.end(payload);
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
    expect(Buffer.concat(err).toString()).toBe('');
    expect(code).toBe(0);
    const result = JSON.parse(Buffer.concat(out).toString());
    expect(result.parsed).toEqual(request);
    expect(result.bytes).toBe(payload.length);
    expect(result.digest).toBe(createHash('sha256').update(payload).digest('hex'));
  }, 30_000);

  it('keeps the sites path working over the same framing, and still accepts an unframed request', async () => {
    const readWith = async (input: Buffer) => {
      const script = `import { readFramedRequest } from ${JSON.stringify(HELPER_SOURCE)};
process.stdout.write(JSON.stringify(readFramedRequest(0)));`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stdin.end(input);
      await new Promise((resolve) => child.once('close', resolve));
      return JSON.parse(Buffer.concat(out).toString());
    };
    const framed = { domain: 'sites', op: 'ensure-site', slug: 'alpha', email: 'ops@example.com', gatewayToken: 'a'.repeat(43) };
    expect(await readWith(encodeHelperRequest(framed))).toEqual(framed);
    // A daemon that predates the framing sends a bare JSON object and carries no guest stdin.
    expect(await readWith(Buffer.from(JSON.stringify({ op: 'status' })))).toEqual({ op: 'status' });
  }, 30_000);

  it('keeps the sudoers grant a single pinned line for one executable', () => {
    // Two helpers would buy no isolation — both would be granted to the same service user — while the
    // sudoers surface, the install path and the digest check would each have to exist twice.
    const sudoers = readFileSync(fileURLToPath(new URL('../../src/cli/install/systemdUnits.ts', import.meta.url)), 'utf8');
    const grants = sudoers.split('\n').filter((line) => line.includes('SITE_GATEWAY_HELPER_PATH}') && line.includes('NOPASSWD'));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('${SITE_GATEWAY_HELPER_PATH} ""');
    expect(SITE_GATEWAY_HELPER_PATH).toBe('/usr/local/libexec/elowen-site-gateway');
  });
});

describe('privileged helper: host artefacts and readiness', () => {
  it('owns the polkit rule and the unit template as repository content', () => {
    const rule = renderPolkitRule('azureuser');
    expect(rule).toContain('subject.user !== "azureuser"');
    expect(rule).toContain('action.id !== "org.freedesktop.systemd1.manage-units"');
    expect(rule).toContain('unit.indexOf("elowen-machine@elowen-") !== 0');
    // Exactly the three verbs the runtime issues. A restart is a stop and a start, and nothing asks for
    // one, so granting it would widen the rule past its own privilege model.
    for (const verb of ['start', 'stop', 'set-property']) expect(rule).toContain(`verb === "${verb}"`);
    expect(rule).not.toContain('"restart"');
    // Everything else falls through to the system default, so an unrelated unit stays refused.
    expect(rule).toContain('return polkit.Result.NOT_HANDLED;');
    expect(rule).not.toMatch(/daemon-reload|nginx|cron/);
    expect(() => renderPolkitRule('root')).toThrow();
    expect(() => renderPolkitRule('bad name')).toThrow();

    // The shipped systemd-nspawn@.service hardcodes /var/lib/machines/%i, which the disk layout does
    // not use, so the envelope is our own template with the directory taken from the per-machine drop-in.
    expect(MACHINE_UNIT_TEMPLATE).toContain('--directory=${ELOWEN_MACHINE_DIRECTORY}');
    expect(MACHINE_UNIT_TEMPLATE).toContain('--link-journal=no');
    expect(MACHINE_UNIT_TEMPLATE).toContain('--settings=override');
    expect(MACHINE_UNIT_TEMPLATE).toContain('Slice=machine.slice');
    expect(MACHINE_UNIT_TEMPLATE).toContain('DevicePolicy=closed');
    expect(MACHINE_UNIT_TEMPLATE).not.toContain('/var/lib/machines');
  });

  it('renders the machine envelope from validated fields only', () => {
    const binds = [
      { source: '/srv/sandbox/projects/54/disks/x/workspace', target: '/demo', readOnly: false },
      { source: '/srv/sandbox/projects/54/disks/x/home', target: '/root', readOnly: true },
    ];
    const settings = renderMachineSettings(binds, { uidBase: 1_073_741_824 });
    expect(settings).toContain('PrivateUsers=1073741824:65536');
    expect(settings).toContain('PrivateUsersOwnership=off');
    expect(settings).toContain('NoNewPrivileges=yes');
    expect(settings).toContain('CAP_SYS_PTRACE');
    expect(settings).toContain('Bind=/srv/sandbox/projects/54/disks/x/workspace:/demo:rootidmap');
    expect(settings).toContain('BindReadOnly=/srv/sandbox/projects/54/disks/x/home:/root:rootidmap');
    // The namespace is stated in both shapes rather than inferred from VirtualEthernet=, because the
    // failure mode of a lost implication is a machine sharing the host's network namespace outright.
    expect(settings).toContain('[Network]\nPrivate=yes\nVirtualEthernet=no');
    expect(renderMachineSettings([], { uidBase: 1_073_741_824, privateNetwork: false }))
      .toContain('[Network]\nPrivate=yes\nVirtualEthernet=yes');
    expect(() => renderMachineSettings([], { uidBase: 1000 })).toThrow(/uid range is invalid/);

    const dropIn = renderMachineDropIn('/srv/sandbox/projects/54/disks/x/rootfs', { cpus: 0.75, memoryMb: 384, pidsLimit: 300 }, 1_073_741_824);
    expect(dropIn).toContain('Environment=ELOWEN_MACHINE_DIRECTORY=/srv/sandbox/projects/54/disks/x/rootfs');
    expect(dropIn).toContain('CPUQuota=75%');
    expect(dropIn).toContain('MemoryMax=384M');
    expect(dropIn).toContain('TasksMax=300');
  });

  it('installs every host artefact on a bare host and converges to a no-op on the next run', async () => {
    const fixture = runnerFixture({ installed: false });
    const missing = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, fixture.options) as Readiness;
    expect(missing.ready).toBe(false);
    expect(missing.items.map((item) => item.id))
      .toEqual(['os:supported', 'package:systemd-container', 'apparmor:machine-profile',
        'unit:elowen-machine', 'unit:elowen-machine-firewall', 'polkit:machines']);
    expect(rowFor(missing, 'unit:elowen-machine').detail).toBe('missing — run environment provisioning to restore it');
    // Status only ever reads.
    expect(fixture.writes).toEqual([]);

    const provisioned = await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options) as Readiness;
    expect(provisioned.ready).toBe(true);
    expect(fixture.writes.map((write) => write.path)).toEqual([MACHINE_UNIT_PATH, MACHINE_FIREWALL_UNIT_PATH, POLKIT_RULE_PATH]);
    expect(fixture.writes.every((write) => write.mode === 0o644)).toBe(true);
    expect(fixture.calls).toContainEqual({ file: '/usr/bin/apt-get', args: ['update'] });
    expect(fixture.calls).toContainEqual({ file: '/usr/bin/apt-get', args: ['install', '--yes', '--no-install-recommends', 'systemd-container'] });
    // One reload for the unit template and one for the firewall unit written after it: a reload that ran
    // before a file existed cannot have read it.
    expect(reloads(fixture.calls)).toBe(2);
    expect(rowFor(provisioned, 'unit:elowen-machine').detail).toBe('installed and loaded');
    expect(rowFor(provisioned, 'polkit:machines').detail).toBe('scoped to elowen-machine units for azureuser');

    // Converging means the second run is not a cheaper version of the first, it is nothing at all: no
    // write, no package install, no reload.
    const before = { writes: fixture.writes.length, calls: fixture.calls.length };
    const again = await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options) as Readiness;
    expect(again.ready).toBe(true);
    expect(fixture.writes).toHaveLength(before.writes);
    expect(reloads(fixture.calls)).toBe(2);
    expect(fixture.calls.slice(before.calls).some((call) => call.file === '/usr/bin/apt-get')).toBe(false);
  });

  it('restores the one artefact that drifted, and reloads only when the reload is what makes it take effect', async () => {
    const fixture = runnerFixture();
    await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options);
    const baseline = reloads(fixture.calls);

    // Someone edits the polkit rule by hand. polkitd watches its own rules directory, so restoring the
    // file is the whole repair; asking systemd to reload would be theatre.
    fixture.state.polkit = `${fixture.state.polkit}// widened by hand\n`;
    const edited = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, fixture.options) as Readiness;
    expect(rowFor(edited, 'polkit:machines')).toMatchObject({ ok: false, detail: 'differs from the managed content — run environment provisioning to restore it' });
    expect(rowFor(edited, 'unit:elowen-machine').ok).toBe(true);

    let repaired = await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options) as Readiness;
    expect(repaired.ready).toBe(true);
    expect(fixture.state.polkit).toBe(renderPolkitRule('azureuser'));
    expect(reloads(fixture.calls)).toBe(baseline);

    // An upgrade over an older unit template is the same path, and this one does need the manager told.
    fixture.state.unit = '[Unit]\nDescription=Elowen machine %i\n[Service]\nExecStart=systemd-nspawn --boot\n';
    repaired = await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options) as Readiness;
    expect(repaired.ready).toBe(true);
    expect(fixture.state.unit).toBe(MACHINE_UNIT_TEMPLATE);
    expect(reloads(fixture.calls)).toBe(baseline + 1);
  });

  it('treats the permission bits as part of the artefact, not as decoration', async () => {
    const fixture = runnerFixture();
    await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options);
    // A group-writable polkit rule is a rule that whole group can rewrite, and its content still matches.
    fixture.state.polkitMode = 0o664;
    const loose = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, fixture.options) as Readiness;
    expect(rowFor(loose, 'polkit:machines')).toMatchObject({ ok: false, detail: 'mode is 0664 where 0644 is required — run environment provisioning to restore it' });

    const repaired = await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options) as Readiness;
    expect(repaired.ready).toBe(true);
    expect(fixture.state.polkitMode).toBe(0o644);
  });

  it('reloads a unit template the manager has never read, even when the file on disk is already right', async () => {
    // The state a provisioning run interrupted between the write and the reload leaves behind, and the
    // state a restored backup leaves behind. The file compares equal, and the machine still cannot start.
    const fixture = runnerFixture({
      unit: MACHINE_UNIT_TEMPLATE, unitLoaded: false, polkit: renderPolkitRule('azureuser'),
      firewallUnit: MACHINE_FIREWALL_UNIT, firewallEnabled: true, firewall: true,
    });
    const stale = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, fixture.options) as Readiness;
    expect(rowFor(stale, 'unit:elowen-machine')).toMatchObject({ ok: false, detail: 'on disk but the manager has not read it — run: systemctl daemon-reload' });

    const repaired = await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options) as Readiness;
    expect(repaired.ready).toBe(true);
    expect(fixture.writes).toEqual([]);
    expect(reloads(fixture.calls)).toBe(1);
  });

  it('reports the veth rules while serving, and applies them from provisioning', async () => {
    const fixture = runnerFixture({ firewall: false, networkd: false, forwarding: false });
    const without = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, fixture.options) as Readiness;
    expect(without.items.some((item) => item.id.startsWith('firewall:') || item.id.startsWith('net:'))).toBe(false);

    const reported = await applyRequest({ domain: 'nspawn', op: 'status', veth: true }, undefined, fixture.options) as Readiness;
    expect(reported.ready).toBe(false);
    expect(reported.items.map((item) => item.id)).toEqual([
      'os:supported', 'package:systemd-container', 'apparmor:machine-profile',
      'unit:elowen-machine', 'unit:elowen-machine-firewall', 'polkit:machines',
      'net:ip-forward', 'service:systemd-networkd', ...NSPAWN_FIREWALL_RULES.map((rule: { id: string }) => rule.id),
    ]);

    // Every detail has to carry the command, because nobody reading a false row has the rule memorized.
    expect(rowFor(reported, 'net:ip-forward').detail).toContain('sysctl -w net.ipv4.ip_forward=1');
    expect(rowFor(reported, 'service:systemd-networkd').detail).toContain('systemctl enable --now systemd-networkd');
    expect(rowFor(reported, 'firewall:forward-out').detail).toContain('/usr/sbin/iptables -I DOCKER-USER 1 -i ve-+ -j ACCEPT');
    expect(rowFor(reported, 'firewall:forward-back').detail)
      .toContain('/usr/sbin/iptables -I DOCKER-USER 1 -o ve-+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT');
    expect(rowFor(reported, 'firewall:machine-dhcp').detail).toContain('/usr/sbin/iptables -I INPUT 1 -i ve-+ -p udp --dport 67 -j ACCEPT');
    expect(rowFor(reported, 'firewall:host-guard').detail).toContain('/usr/sbin/iptables -A INPUT -i ve-+ -j DROP');
    expect(rowFor(reported, 'firewall:host-guard6').detail).toContain('/usr/sbin/ip6tables -A INPUT -i ve-+ -j DROP');

    // Serving a request never mutates the packet filter: every call into either table is an existence
    // check, whatever the answer turns out to be.
    const served = fixture.calls.filter((call) => call.file.endsWith('tables'));
    expect(served.length).toBeGreaterThan(0);
    expect(served.every((call) => call.args[0] === '-C')).toBe(true);

    // Provisioning is the operator-invoked path, and it does act: the unit is installed, enabled so the
    // rules come back after a reboot, and started so they are in place now. It still touches the tables
    // only through that unit.
    const applied = await applyRequest({ domain: 'nspawn', op: 'provision', veth: true }, undefined, fixture.options) as Readiness;
    expect(fixture.state.firewallUnit).toBe(MACHINE_FIREWALL_UNIT);
    expect(fixture.calls).toContainEqual({ file: '/usr/bin/systemctl', args: ['enable', '--now', MACHINE_FIREWALL_UNIT_NAME] });
    expect(fixture.calls.filter((call) => call.file.endsWith('tables')).every((call) => call.args[0] === '-C')).toBe(true);
    for (const rule of NSPAWN_FIREWALL_RULES) expect(rowFor(applied, rule.id).ok, rule.id).toBe(true);
    expect(rowFor(applied, 'unit:elowen-machine-firewall')).toMatchObject({ ok: true, detail: 'installed, enabled and applied' });

    // Someone flushes the chains. Re-provisioning puts them back rather than reporting them.
    fixture.state.firewall = false;
    const repaired = await applyRequest({ domain: 'nspawn', op: 'provision', veth: true }, undefined, fixture.options) as Readiness;
    expect(rowFor(repaired, 'unit:elowen-machine-firewall').ok).toBe(true);
    for (const rule of NSPAWN_FIREWALL_RULES) expect(rowFor(repaired, rule.id).ok, rule.id).toBe(true);
    // And nothing was rewritten to do it: the unit on disk was already right.
    expect(fixture.writes.filter((write) => write.path === MACHINE_FIREWALL_UNIT_PATH)).toHaveLength(1);
  });

  it('says out loud that the machine AppArmor profile is a known gap', async () => {
    // A delta recorded only in a plan document is not documented for the person deploying. It is reported
    // as met because there is nothing to install and nothing an operator can act on, and the detail is
    // what carries the truth.
    const fixture = runnerFixture();
    const status = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, fixture.options) as Readiness;
    const row = rowFor(status, 'apparmor:machine-profile');
    expect(row.ok).toBe(true);
    expect(row.detail).toContain('known gap, nothing to install');
    expect(row.detail).toContain('inherited by the guest payload');
    expect(row.detail).toContain('dropped capability set');
  });


  it('names both directions of forwarding, because a machine that only sends looks like a DNS fault', () => {
    // Measured on a Docker host against a bare IP: with the outbound accept alone the connection timed
    // out after ten seconds; with the return-path rule beside it the same request answered 200. A reply
    // arrives as `-i eth0 -o ve-+`, matches neither the outbound accept nor any chain Docker owns, and
    // dies on the FORWARD DROP policy Docker installs.
    const forwarding = NSPAWN_FIREWALL_RULES.filter((rule: { chain: string }) => rule.chain === 'DOCKER-USER');
    expect(forwarding.map((rule: { id: string }) => rule.id)).toEqual(['firewall:forward-out', 'firewall:forward-back']);
    expect(forwarding.map((rule) => firewallRuleCommand(rule))).toEqual([
      '/usr/sbin/iptables -I DOCKER-USER 1 -i ve-+ -j ACCEPT',
      '/usr/sbin/iptables -I DOCKER-USER 1 -o ve-+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    ]);
    // The return path is conntrack-scoped, so it opens nothing a machine did not ask for first.
    expect(forwarding[1]!.spec).toContain('RELATED,ESTABLISHED');
  });

  it('puts the host guard where a machine-to-host packet actually arrives', () => {
    // The plan first placed this guard in FORWARD. A packet a machine sends to an address the host holds
    // is delivered locally, so the routing decision hands it to INPUT and a FORWARD rule never sees it.
    //
    // IPv6 gets the guard and nothing else, and that is a fact about this host rather than about IPv6:
    // measured, it carries no global IPv6 address and the ip6tables FORWARD policy is ACCEPT, so there is
    // no v6 path off the box to hold open. It needs measuring again if the host ever gains v6 reach.
    const guards = NSPAWN_FIREWALL_RULES.filter((rule: { spec: string[] }) => rule.spec.includes('DROP'));
    expect(guards).toHaveLength(2);
    expect(guards.every((rule: { chain: string }) => rule.chain === 'INPUT')).toBe(true);
    expect(guards.map((rule: { binary: string }) => rule.binary)).toEqual(['/usr/sbin/iptables', '/usr/sbin/ip6tables']);
    // The lease exception is inserted at the head, the guard is appended, so the guard cannot shadow it.
    const lease = NSPAWN_FIREWALL_RULES.find((rule: { id: string }) => rule.id === 'firewall:machine-dhcp')!;
    expect(firewallRuleCommand(lease)).toContain('-I INPUT 1');
    expect(guards.every((rule) => firewallRuleCommand(rule).includes('-A INPUT'))).toBe(true);
  });
});

describe('privileged helper: the disk identity record', () => {
  function diskFixture() {
    const paths = nspawnDiskPaths(storage, diskRef);
    mkdirSync(paths.rootfs, { recursive: true });
    const writes: { path: string; content: string; mode: number }[] = [];
    const calls: Call[] = [];
    return {
      paths,
      writes,
      calls,
      options: {
        storage,
        env: environment,
        readText: (path: string) => (path === '/etc/subuid' ? 'azureuser:100000:65536\n' : ''),
        writeAtomic: (path: string, content: Buffer, mode: number) => {
          writes.push({ path, content: content.toString('utf8'), mode });
          // The identity record is read back by the next operation, so the fixture has to persist what
          // lands inside the disk directory; only the system paths are merely recorded.
          if (path.startsWith(scratch)) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, content, { mode });
          }
        },
        runner: (file: string, args: string[]) => {
          calls.push({ file, args });
          if (file === '/usr/bin/getent') return { ok: true, stdout: 'azureuser:x:1000:1000::/home/azureuser:/bin/bash\n' };
          if (file === '/usr/bin/python3') return { ok: true, stdout: JSON.stringify({ entries: 4242 }) };
          return { ok: true, stdout: '' };
        },
      },
    };
  }

  it('leaves the machine root traversable, whatever mode the caller or the archive asked for', async () => {
    // Root traverses a 0700 directory it does not own, so a narrow machine root looks like a healthy boot
    // right up to the point where dbus-daemon drops from root to `messagebus` and can no longer resolve a
    // path. Its readiness never arrives, the unit times out after 90 seconds with a live process and a
    // live socket, and it restarts forever. Nothing in that picture looks like a permission problem.
    //
    // Two ways in, and both are closed here rather than at either source. The caller creates the
    // directory, as it is created at 0700 below. And an archive carrying its own root member rewrites the
    // mode of the directory it is extracted into: measured with the flags this operation uses, a `./`
    // entry at 0700 turns a 0755 target into 0700, so a tree exported from a disk that was once narrow
    // carries the fault forward into every later restore.
    const fixture = diskFixture();
    const archive = join(fixture.paths.directory, 'image.tar');
    writeFileSync(archive, '');
    chmodSync(fixture.paths.rootfs, 0o700);
    const response = await applyRequest({
      domain: 'nspawn',
      op: 'materialize',
      ...diskRef,
      archivePath: archive,
      targetPath: fixture.paths.rootfs,
    }, undefined, fixture.options) as { ok: boolean; uidBase: number };

    expect(response.ok).toBe(true);
    expect(statSync(fixture.paths.rootfs).mode & 0o7777).toBe(0o755);
    // The ownership pass that follows the extraction only ever chowns, so the mode it finds is the mode it
    // leaves; the tree walk is what moves the ids onto the machine's range.
    const shift = fixture.calls.find((call) => call.file === '/usr/bin/python3');
    expect(shift?.args[1]).toContain('os.lchown');
    expect(shift?.args[1]).not.toContain('chmod');
    rmSync(archive, { force: true });
  });

  it('refuses to write a veth envelope until the host can isolate the link', async () => {
    // The envelope is what turns veth on, so the gate lives here rather than in a status row a client is
    // free not to read. Nothing is written and no uid range is allocated on the way to the refusal.
    const request = {
      domain: 'nspawn',
      op: 'write-envelope',
      ...diskRef,
      limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 },
      binds: [],
      dropCapabilities: [],
      privateNetwork: false,
    };
    const unready = diskFixture();
    await expect(applyRequest(request, undefined, unready.options))
      .rejects.toThrow(/not ready for machine networking.*sysctl -w net\.ipv4\.ip_forward=1/s);
    expect(unready.writes).toEqual([]);

    const ready = diskFixture();
    ready.options.readText = (path: string) => {
      if (path === '/proc/sys/net/ipv4/ip_forward') return '1\n';
      return path === '/etc/subuid' ? 'azureuser:100000:65536\n' : '';
    };
    await applyRequest(request, undefined, ready.options);
    const settings = ready.writes.find((write) => write.path.endsWith('.nspawn'))!.content;
    expect(settings).toContain('[Network]\nPrivate=yes\nVirtualEthernet=yes');
  });

  it('writes the record the runtime reads on every ownership check, root-owned and group-readable', async () => {
    const fixture = diskFixture();
    const response = await applyRequest({
      domain: 'nspawn',
      op: 'write-envelope',
      ...diskRef,
      limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 },
      binds: [],
      dropCapabilities: ['CAP_SYS_PTRACE'],
      privateNetwork: true,
    }, undefined, fixture.options) as { unit: string; uidBase: number };

    expect(response.unit).toBe(`elowen-machine@${MACHINE}.service`);
    const identityWrite = fixture.writes.find((write) => write.path === fixture.paths.identity);
    // 0640 root:<service group>. The daemon READS this on the execution path — a privileged round trip
    // there would cost more than the state poll this runtime exists to make cheap — and only root writes
    // it. Its authority is its location, outside the root filesystem, where the guest cannot reach it.
    expect(identityWrite?.mode).toBe(0o640);
    // The directory has to carry the group too. A group-readable record inside a root:root directory is a
    // record nobody can open: without the traverse permission every ownership check failed with EACCES and
    // the whole runtime was unusable. 0750 grants exactly the traverse and nothing more — the group still
    // cannot create, remove or replace anything here.
    expect(statSync(dirname(fixture.paths.identity)).mode & 0o7777).toBe(0o750);
    expect(JSON.parse(identityWrite!.content)).toMatchObject({
      namespace: 'elowen',
      kind: 'project',
      resource: '54',
      generation: 3,
      diskId: diskRef.diskId,
      machine: MACHINE,
      runtime: 'nspawn',
      specHash: diskRef.specHash,
      uidBase: response.uidBase,
      uidSize: 65_536,
    });
  });

  it('refuses a machine name that does not spell out the resource it claims', async () => {
    const fixture = diskFixture();
    await expect(applyRequest({
      domain: 'nspawn',
      op: 'write-envelope',
      ...diskRef,
      machine: 'elowen-project-99-g3',
      limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 },
      binds: [],
      dropCapabilities: [],
      privateNetwork: true,
    }, undefined, fixture.options)).rejects.toThrow(/does not match the resource it names/);
  });

  it('can only ever narrow the guest, never widen it, through the requested capability list', async () => {
    const fixture = diskFixture();
    await applyRequest({
      domain: 'nspawn',
      op: 'write-envelope',
      ...diskRef,
      limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 },
      binds: [],
      dropCapabilities: ['CAP_NET_RAW'],
      privateNetwork: true,
    }, undefined, fixture.options);
    const settings = fixture.writes.find((write) => write.path.endsWith('.nspawn'))!.content;
    expect(settings).toContain('CAP_NET_RAW');
    // An empty or partial list does not give a capability back: the helper's own set is always applied.
    expect(settings).toContain('CAP_SYS_PTRACE');
    expect(settings).toContain('CAP_SYS_MODULE');
  });

  it('re-validates a bind source against the trusted roots instead of trusting the request', async () => {
    const fixture = diskFixture();
    const workspace = join(fixture.paths.directory, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const request = {
      domain: 'nspawn',
      op: 'write-envelope',
      ...diskRef,
      limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 },
      dropCapabilities: [],
      privateNetwork: true,
    };
    await applyRequest({ ...request, binds: [{ source: workspace, target: '/demo', readOnly: false }] }, undefined, fixture.options);
    expect(fixture.writes.find((write) => write.path.endsWith('.nspawn'))!.content)
      .toContain(`Bind=${workspace}:/demo:rootidmap`);

    await expect(applyRequest({ ...request, binds: [{ source: '/etc', target: '/demo' }] }, undefined, fixture.options))
      .rejects.toThrow(/outside the trusted storage roots/);
    await expect(applyRequest({ ...request, binds: [{ source: workspace, target: '../escape' }] }, undefined, fixture.options))
      .rejects.toThrow(/binds are invalid/);
  });

  // Built from the specification builder itself rather than from hand-written targets, because a
  // hand-written `/demo` is exactly what let this through: every Site binds a read-only git stub over
  // `/workspace/.git`, the helper refused the whole envelope, and the migration rolled back by
  // reverse-chowning the rootfs it had just shifted. Half the feature was dead and nothing caught it.
  it('accepts the bind set a real Site specification produces, git stub and all', async () => {
    const siteId = randomUUID();
    const image = 'localhost/elowen-site-base:1';
    const disk = createEnvironmentDiskSpec(
      { resource: { kind: 'site', id: siteId }, image, runtime: 'nspawn' },
      { sitesDataDir: storage.sitesDataDir, namespace: 'elowen' },
      'e'.repeat(32),
    );
    const binding = {
      namespace: 'elowen',
      sitesDataDir: storage.sitesDataDir,
      sourcePath: join(storage.sitesDataDir, siteId, 'source'),
      brokerDir: join(storage.sitesDataDir, siteId, 'brokers', siteId),
    };
    const spec = createBoundSiteSpec({
      resource: { kind: 'site', id: siteId },
      generation: 4,
      image,
      disk,
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 256 },
    }, binding);

    const binds = spec.mounts.filter((mount: { type: string }) => mount.type === 'bind')
      .map((mount: { source: string; target: string; readOnly: boolean }) => ({ source: mount.source, target: mount.target, readOnly: mount.readOnly === true }));
    expect(binds.map((bind: { target: string }) => bind.target)).toContain('/workspace/.git');
    for (const bind of binds) {
      // The git stub is a FILE bound over one path inside the workspace; everything else is a directory.
      if (bind.target === '/workspace/.git') {
        mkdirSync(dirname(bind.source), { recursive: true });
        writeFileSync(bind.source, '');
      } else {
        mkdirSync(bind.source, { recursive: true });
      }
    }
    mkdirSync(join(storage.sitesDataDir, siteId, 'environment', 'disks', 'e'.repeat(32), 'rootfs'), { recursive: true });

    const writes: { path: string; content: string; mode: number }[] = [];
    await applyRequest({
      domain: 'nspawn',
      op: 'write-envelope',
      namespace: 'elowen',
      kind: 'site',
      resource: siteId,
      generation: 4,
      diskId: 'e'.repeat(32),
      machine: spec.name,
      specHash: spec.labels['io.elowen.spec'],
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 256 },
      binds,
      dropCapabilities: [],
      privateNetwork: true,
    }, undefined, {
      storage,
      env: environment,
      writeAtomic: (path: string, content: Buffer, mode: number) => {
        writes.push({ path, content: content.toString('utf8'), mode });
        if (path.startsWith(scratch)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, { mode }); }
      },
      runner: () => ({ ok: true, stdout: '' }),
    });

    const settings = writes.find((write) => write.path.endsWith('.nspawn'))!.content;
    for (const bind of binds) {
      expect(settings).toContain(`${bind.readOnly ? 'BindReadOnly' : 'Bind'}=${bind.source}:${bind.target}:rootidmap`);
    }

    // The mount point for the nested bind has to exist in the SOURCE of the bind above it. nspawn applies
    // the binds parent first, so by the time it reaches /workspace/.git the path already resolves into the
    // workspace source; the workspace bind is read-only, and nspawn cannot create anything there. Measured
    // against a real machine: without this the boot fails with
    // `Failed to create mount point <rootfs>/workspace/.git: Read-only file system`, and an empty file put
    // in the root filesystem instead changes nothing, because the parent bind covers it.
    const workspace = binds.find((bind: { target: string }) => bind.target === '/workspace')!;
    const stub = join(workspace.source, '.git');
    expect(lstatSync(stub).isFile(), 'the git stub mount point must be a file, matching what is bound over it').toBe(true);
    expect(statSync(stub).size).toBe(0);

    // It is created once and outlives the envelope, so a second write is content with what is there.
    await expect(applyRequest({
      domain: 'nspawn',
      op: 'write-envelope',
      namespace: 'elowen',
      kind: 'site',
      resource: siteId,
      generation: 4,
      diskId: 'e'.repeat(32),
      machine: spec.name,
      specHash: spec.labels['io.elowen.spec'],
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 256 },
      binds,
      dropCapabilities: [],
      privateNetwork: true,
    }, undefined, { storage, env: environment, writeAtomic: () => {}, runner: () => ({ ok: true, stdout: '' }) })).resolves.toMatchObject({ ok: true });

    // A real repository already at that path is data, not a mount point to overwrite, and a file bound
    // over a directory fails the mount with a message that explains nothing.
    rmSync(stub);
    mkdirSync(stub);
    await expect(applyRequest({
      domain: 'nspawn',
      op: 'write-envelope',
      namespace: 'elowen',
      kind: 'site',
      resource: siteId,
      generation: 4,
      diskId: 'e'.repeat(32),
      machine: spec.name,
      specHash: spec.labels['io.elowen.spec'],
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 256 },
      binds,
      dropCapabilities: [],
      privateNetwork: true,
    }, undefined, { storage, env: environment, writeAtomic: () => {}, runner: () => ({ ok: true, stdout: '' }) }))
      .rejects.toThrow(/mount point is of the wrong kind/);
  });

  it('still refuses a target that would climb out of its mount point', () => {
    expect(safeGuestMountTarget('/workspace/.git')).toBe(true);
    expect(safeGuestMountTarget('/run/elowen')).toBe(true);
    expect(safeGuestMountTarget('/workspace')).toBe(true);
    for (const bad of ['workspace', '/..', '/workspace/..', '/./etc', '/workspace/.git/objects', '/Workspace', '/work space', '/etc\u0000']) {
      expect(safeGuestMountTarget(bad), bad).toBe(false);
    }
  });

  it('refuses to write the identity through a planted symlink', async () => {
    const fixture = diskFixture();
    const outside = join(scratch, 'outside-the-roots');
    mkdirSync(outside, { recursive: true });
    rmSync(join(fixture.paths.directory, '.elowen'), { recursive: true, force: true });
    symlinkSync(outside, join(fixture.paths.directory, '.elowen'));
    // The service user owns the disk directory. Without the explicit check, the atomic write's recursive
    // mkdir would have root create directories and a file at the far end of this link.
    await expect(applyRequest({
      domain: 'nspawn',
      op: 'write-envelope',
      ...diskRef,
      limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 },
      binds: [],
      dropCapabilities: [],
      privateNetwork: true,
    }, undefined, fixture.options)).rejects.toThrow(/identity directory is not a directory/);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(fixture.paths.directory, '.elowen'), { force: true });
  });

  it('shifts ownership in both directions and reports the receipt a rollback reverses with', async () => {
    const fixture = diskFixture();
    const forward = await applyRequest({ domain: 'nspawn', op: 'shift-ownership', ...diskRef, target: 'nspawn', uidBase: null },
      undefined, fixture.options) as { uidBase: number; uidSize: number; previousUidBase: number; entries: number };
    // A candidate that will not boot has to go back up on Podman, and rootless Podman cannot read a tree
    // chowned into the machine's range — so the forward pass has to say what to reverse to.
    expect(forward).toMatchObject({ uidSize: 65_536, previousUidBase: 100_000, entries: 4242 });
    expect(forward.uidBase).toBeGreaterThanOrEqual(1_073_741_824);

    const forwardSpec = JSON.parse(fixture.calls.find((call) => call.file === '/usr/bin/python3')!.args[2]);
    expect(forwardSpec).toMatchObject({ target: 'nspawn', base: forward.uidBase, serviceId: 1000, previousBase: 100_000 });

    fixture.calls.length = 0;
    const back = await applyRequest({ domain: 'nspawn', op: 'shift-ownership', ...diskRef, target: 'podman', uidBase: forward.previousUidBase },
      undefined, fixture.options);
    expect(back).toMatchObject({ ok: true, previousUidBase: 100_000 });
    expect(JSON.parse(fixture.calls.find((call) => call.file === '/usr/bin/python3')!.args[2])).toMatchObject({ target: 'podman' });

    await expect(applyRequest({ domain: 'nspawn', op: 'shift-ownership', ...diskRef, target: 'elsewhere', uidBase: null }, undefined, fixture.options))
      .rejects.toThrow(/shift target is invalid/);
    await expect(applyRequest({ domain: 'nspawn', op: 'shift-ownership', ...diskRef, target: 'podman', uidBase: null }, undefined, fixture.options))
      .rejects.toThrow(/requires the recorded range/);
  });

  it('leaves an id that already carries the destination scheme alone, so an interrupted pass is re-run', () => {
    // An interrupted shift produced no receipt and therefore cannot be reversed; it has to be safe to
    // repeat. The mapping accepts both schemes on the way in and only writes what actually changes.
    const script = readFileSync(HELPER_SOURCE, 'utf8');
    const body = script.slice(script.indexOf('const OWNERSHIP_SHIFT_PY'), script.indexOf('function shiftOwnership'));
    expect(body).toContain('if machine(uid): return uid');
    expect(body).toContain('if podman(uid): return uid');
    expect(body).toContain('if uid!=st.st_uid or gid!=st.st_gid: os.lchown');
  });
});

describe('privileged helper: disk tree primitives', () => {
  it('runs the container runtime\'s own Python implementations rather than new semantics', () => {
    const helper = readFileSync(HELPER_SOURCE, 'utf8');
    const podman = readFileSync(PODMAN_SOURCE, 'utf8');
    const slice = (source: string, anchor: string): string => {
      const start = source.indexOf(anchor);
      expect(start).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf('`', start));
    };
    const anchors = {
      inventory: 'def inventory(root):',
      fingerprint: 'import hashlib,json,os,stat,sys\nroot=sys.argv[1]',
      preflight: 'import json,os,sys\nsources=json.loads',
      sync: 'import os,stat,sys\nroot=sys.argv[1]\nfor directory,names,files in os.walk(root,topdown=False',
    };
    for (const [name, anchor] of Object.entries(anchors)) {
      expect(slice(helper, anchor), `${name} drifted from the container runtime`).toBe(slice(podman, anchor));
    }
    // The copy primitive differs only in how the interpreter path is spelled, so compare the behaviour.
    expect(DISK_TREE_SCRIPTS.inventory).toContain('os.getxattr');
    expect(helper).toContain('cp -a --reflink=auto --sparse=always -- "$source"/. "$target"/');
    expect(podman).toContain('cp -a --reflink=auto --sparse=always -- "$source"/. "$target"/');

    // The archive verification carries ONE deliberate difference: the tree has been shifted onto the
    // machine's uid range since it was extracted, so comparing ownership against the archive would fail
    // on every file. Everything else — types, modes, sizes, symlinks, hardlinks, xattrs and unexpected
    // entries — is the container runtime's own check, byte for byte.
    const verifyAnchor = 'import json,os,stat,sys,tarfile';
    const ownerCheck = '   if st.st_uid!=member.uid or st.st_gid!=member.gid: failures.append(\'owner \'+rel)\n';
    expect(slice(podman, verifyAnchor)).toContain(ownerCheck);
    expect(slice(helper, verifyAnchor)).toBe(slice(podman, verifyAnchor).replace(ownerCheck, ''));
  });

  it('copies between two paths it re-validates, without a second full size walk', async () => {
    const source = join(nspawnDiskPaths(storage, diskRef).directory, 'workspace');
    const destination = join(nspawnDiskPaths(storage, diskRef).storageRoot, 'snapshots', 'snap2', 'workspace');
    mkdirSync(source, { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(source, 'file.txt'), 'content');
    const calls: Call[] = [];
    const result = await applyRequest({
      domain: 'nspawn', op: 'tree-copy', sourcePath: source, targetPath: destination,
    }, undefined, {
      storage,
      runner: (file: string, args: string[]) => { calls.push({ file, args }); return { ok: true, stdout: '' }; },
    }) as { sourcePath: string; targetPath: string };
    expect(result).toMatchObject({ sourcePath: source, targetPath: destination });
    // Exactly the copy, and nothing else: the free-space question is its own operation, and answering it
    // here would walk every tree twice per snapshot.
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('/bin/bash');
    expect(calls[0].args.slice(2)).toEqual(['elowen-copy-tree', source, destination]);
  });

  it('answers the free-space question without hashing a byte', async () => {
    const first = join(nspawnDiskPaths(storage, diskRef).directory, 'workspace');
    const second = join(nspawnDiskPaths(storage, diskRef).directory, 'home');
    const destination = join(nspawnDiskPaths(storage, diskRef).storageRoot, 'snapshots');
    for (const path of [first, second, destination]) mkdirSync(path, { recursive: true });
    const calls: Call[] = [];
    const result = await applyRequest({
      domain: 'nspawn', op: 'tree-preflight', sourcePaths: [first, second], destinationPath: destination,
    }, undefined, {
      storage,
      runner: (file: string, args: string[]) => {
        calls.push({ file, args });
        return { ok: true, stdout: JSON.stringify({ requiredBytes: 7, marginBytes: 67_108_864, freeBytes: 1 << 30 }) };
      },
    });
    expect(result).toMatchObject({ ok: true, requiredBytes: 7, marginBytes: 67_108_864 });
    expect(calls[0].file).toBe('/usr/bin/python3');
    expect(calls[0].args[2]).toBe(JSON.stringify([first, second]));
    expect(calls[0].args[3]).toBe(destination);
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-preflight', sourcePaths: [], destinationPath: destination }, undefined, { storage }))
      .rejects.toThrow(/requires source trees/);
  });

  it('verifies an extracted tree against the archive that produced it', async () => {
    const target = join(nspawnDiskPaths(storage, diskRef).directory, 'rootfs.pending');
    const archive = join(nspawnDiskPaths(storage, diskRef).storageRoot, 'migrations', 'm1', 'rootfs.tar');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(archive, '..'), { recursive: true });
    writeFileSync(archive, 'tar bytes');
    const runner = () => ({ ok: true, stdout: JSON.stringify({ members: 1234 }) });
    expect(await applyRequest({ domain: 'nspawn', op: 'tree-verify', archivePath: archive, targetPath: target }, undefined, { storage, runner }))
      .toEqual({ ok: true, members: 1234 });
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-verify', archivePath: archive, targetPath: target }, undefined, {
      storage, runner: () => ({ ok: true, stdout: JSON.stringify({ members: 0 }) }),
    })).rejects.toThrow(/named no members/);
    // The archive is a file and the target a directory; neither may stand in for the other.
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-verify', archivePath: target, targetPath: target }, undefined, { storage, runner }))
      .rejects.toThrow(/not of the expected kind/);
  });

  it('validates the fingerprint a root process reports back', async () => {
    const path = join(nspawnDiskPaths(storage, diskRef).directory, 'home');
    mkdirSync(path, { recursive: true });
    const digest = 'f'.repeat(64);
    const runner = () => ({ ok: true, stdout: JSON.stringify({ logicalBytes: 10, allocatedBytes: 4096, digest }) });
    expect(await applyRequest({ domain: 'nspawn', op: 'tree-fingerprint', path }, undefined, { storage, runner }))
      .toMatchObject({ ok: true, path, digest, logicalBytes: 10, allocatedBytes: 4096 });
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-fingerprint', path }, undefined, {
      storage, runner: () => ({ ok: true, stdout: JSON.stringify({ logicalBytes: 10, allocatedBytes: 4096, digest: 'nope' }) }),
    })).rejects.toThrow(/fingerprint is invalid/);
  });
});

describe('privileged helper: the invocation the sudoers drop-in pins', () => {
  // sudo matches arguments positionally, so the argv the bundled runtime spawns, the argv the shared
  // constant states and the argv the drop-in pins have to be one thing. They live in three files that
  // cannot import each other, which is exactly why this pin exists.
  it('holds the bundled runtime, the shared constant and the sudoers line to the same argv', () => {
    const sudoers = readFileSync(fileURLToPath(new URL('../../src/cli/install/systemdUnits.ts', import.meta.url)), 'utf8');
    const grant = sudoers.split('\n').filter((line) => line.includes('SITE_GATEWAY_HELPER_PATH}') && line.includes('NOPASSWD'));
    expect(grant).toHaveLength(1);
    expect(grant[0]).toContain('${SITE_GATEWAY_HELPER_PATH} ""');

    expect(SITE_GATEWAY_HELPER_ARGV).toEqual(['-n', SITE_GATEWAY_HELPER_PATH, '']);
    expect(PLUGIN_HELPER_PATH).toBe(SITE_GATEWAY_HELPER_PATH);
    expect(readFileSync(PLUGIN_RUNTIME, 'utf8'), 'the bundled machine runtime must spawn the pinned argv')
      .toContain("['-n', this.#helperPath, '']");
    expect(readFileSync(fileURLToPath(new URL('../../src/privileged/publishedSitesGateway.ts', import.meta.url)), 'utf8'),
      'the published-sites invoker must spawn the pinned argv rather than composing its own')
      .toContain("spawn('sudo', [...SITE_GATEWAY_HELPER_ARGV]");
  });

  it('accepts the pinned empty argument and nothing else on its own command line', async () => {
    const run = async (args: string[]) => {
      const child = spawn(process.execPath, [HELPER_SOURCE, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      const err: Buffer[] = [];
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.stdin.end(encodeHelperRequest({ domain: 'nspawn', op: 'status' }));
      const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
      return { code, stderr: Buffer.concat(err).toString() };
    };
    // Not root here, so the uid guard is what answers — which is proof the argv guard let it through.
    for (const args of [[], ['']]) {
      expect((await run(args)).stderr).toMatch(/must run as root/);
    }
    expect((await run(['status'])).stderr).toMatch(/accepts no command-line arguments/);
  }, 30_000);

  it('states the request contract the bundled machine runtime must satisfy', () => {
    expect(SITE_GATEWAY_HELPER_PATH).toBe('/usr/local/libexec/elowen-site-gateway');
    expect(HELPER_FRAME_HEADER_BYTES).toBe(9);
    expect(encodeHelperRequest({ domain: 'nspawn', op: 'status' }).toString())
      .toBe('00000033\n{"domain":"nspawn","op":"status"}');
    // Every operation the bundled runtime can name is one this helper answers.
    for (const op of ['materialize', 'write-envelope', 'shift-ownership', 'exec', 'freeze', 'thaw',
      'tree-copy', 'tree-fingerprint', 'tree-preflight', 'tree-remove', 'tree-sync', 'tree-verify', 'destroy']) {
      expect(helperRequest(op, {})).toEqual({ domain: 'nspawn', op });
      let refusal = '';
      try { applyNspawnRequest({ domain: 'nspawn', op }, { storage }); } catch (error) { refusal = String(error); }
      expect(refusal, `${op} must be answered by the machine domain`).not.toMatch(/operation is not supported/);
    }
  });
});
