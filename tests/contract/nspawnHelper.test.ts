import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// The installed root helper is standalone ESM — after sudo it cannot import service-user-owned package
// code — so the contract is pinned against the bytes that are actually shipped and installed.
// @ts-expect-error the standalone privileged helper intentionally has no TypeScript declaration file
import {
  DISK_TREE_SCRIPTS,
  DISK_TREE_TIMEOUT_MS,
  commandOptionsFor,
  defaultCommandRunner,
  MACHINE_UNIT_PATH,
  MACHINE_FIREWALL_UNIT,
  MACHINE_FIREWALL_UNIT_NAME,
  MACHINE_FIREWALL_UNIT_PATH,
  MACHINE_SYSCTL_CONTENT,
  MACHINE_SYSCTL_PATH,
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
  readUidRangeRegistry,
  renderPolkitRule,
  safeGuestMountTarget,
  SITE_DATA_ARCHIVE_BYTES,
  SITE_DATA_ARCHIVE_MEMBERS,
  SITE_DATA_INDEX_PY,
  storageRootsFor,
  supportedEnvironmentOs,
  trustedPath,
  UID_RANGE_BASE,
} from '../../scripts/elowen-site-gateway.mjs';
// @ts-expect-error the bundled Sandbox plugin is plain ESM without declarations
import { createBoundSiteSpec, createEnvironmentDiskSpec } from '../../plugins/sandbox/lib/containerSpec.mjs';
// @ts-expect-error the bundled machine runtime is plain ESM without declarations
import { HELPER_PATH as PLUGIN_HELPER_PATH, MACHINE_PATTERN as PLUGIN_MACHINE_PATTERN, helperRequest } from '../../plugins/sandbox/lib/nspawn.mjs';
// @ts-expect-error the bundled Sandbox storage owner is plain ESM without declarations
import { SNAPSHOT_TREE_FORMAT } from '../../plugins/sandbox/lib/containerStorage.mjs';
import {
  siteGatewayStorageRoots,
  encodeHelperRequest, HELPER_FRAME_HEADER_BYTES, SITE_GATEWAY_HELPER_ARGV, SITE_GATEWAY_HELPER_PATH,
} from '../../src/shared/siteGateway.js';

const HELPER_SOURCE = fileURLToPath(new URL('../../scripts/elowen-site-gateway.mjs', import.meta.url));
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
  firewallUnit?: string; firewallEnabled?: boolean; sysctl?: string; networkdEnabled?: boolean;
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
    // Forwarding has two halves: what the kernel is running now, and the file that restores it at the
    // next boot. A host prepared by provisioning has both; a host somebody fixed with `sysctl -w` has
    // only the first, and the fixture can hold those apart.
    sysctl: options.sysctl ?? MACHINE_SYSCTL_CONTENT,
    networkd: options.networkd ?? true,
    networkdEnabled: options.networkdEnabled ?? options.networkd ?? true,
    deployment: options.deployment ?? JSON.stringify({ storage: { sandboxDataDir: '/srv/sandbox', sitesDataDir: '/srv/sites' } }),
  };
  const readText = (path: string) => {
    if (path === '/etc/elowen/site-gateway.json') return state.deployment;
    if (path === '/etc/os-release') return 'ID=ubuntu\n';
    if (path === POLKIT_RULE_PATH) return state.polkit;
    if (path === MACHINE_UNIT_PATH) return state.unit;
    if (path === MACHINE_FIREWALL_UNIT_PATH) return state.firewallUnit;
    if (path === '/proc/sys/net/ipv4/ip_forward') return state.forwarding ? '1\n' : '0\n';
    if (path === MACHINE_SYSCTL_PATH) return state.sysctl;
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
    // Writing the file does NOT enable forwarding: only applying it does, which is what `sysctl --system`
    // below models. A provisioning run that wrote the file and never applied it must still read as unmet.
    if (path === MACHINE_SYSCTL_PATH) state.sysctl = value;
  };
  const runner = (file: string, args: string[]) => {
    calls.push({ file, args: [...args] });
    if (file === '/usr/bin/getent') return { ok: true, stdout: 'azureuser:x:1000:1000::/home/azureuser:/bin/bash\n' };
    if (file === '/usr/bin/dpkg-query') return state.installed ? { ok: true, stdout: 'install ok installed\n' } : { ok: false, stderr: 'not installed' };
    if (file === '/usr/sbin/iptables' || file === '/usr/sbin/ip6tables') {
      return state.firewall ? { ok: true, stdout: '' } : { ok: false, stderr: 'No chain/target/match by that name' };
    }
    if (file === '/usr/bin/apt-get') { state.installed = true; return { ok: true, stdout: '' }; }
    // Applies exactly the file it is pointed at. `--system` would reload the whole search path and revert
    // unrelated live settings, so being given one `-p <path>` is part of what this models: a call without
    // it, or with another path, applies nothing here and the forwarding row stays unmet.
    if (file === '/usr/sbin/sysctl') {
      if (args[0] === '-p' && args[1] === MACHINE_SYSCTL_PATH && state.sysctl.includes('net.ipv4.ip_forward=1')) {
        state.forwarding = true;
      }
      return { ok: true, stdout: '' };
    }
    if (file === '/usr/bin/systemctl') {
      if (args[0] === 'show') return { ok: true, stdout: `${state.unitLoaded ? 'loaded' : 'not-found'}\n` };
      if (args[0] === 'daemon-reload') { state.unitLoaded = state.unit !== ''; return { ok: true, stdout: '' }; }
      if (args[0] === 'enable' && args.includes('systemd-networkd')) {
        state.networkd = true;
        state.networkdEnabled = true;
        return { ok: true, stdout: '' };
      }
      if (args[0] === 'enable') {
        // What the unit does when it runs: every rule checked, then applied when it is not there.
        state.firewallEnabled = true;
        state.firewall = true;
        return { ok: true, stdout: '' };
      }
      if (args[0] === 'is-enabled' && args[1] === MACHINE_FIREWALL_UNIT_NAME) {
        return state.firewallEnabled ? { ok: true, stdout: 'enabled\n' } : { ok: false, stderr: 'disabled' };
      }
      if (args[1] === 'systemd-networkd') {
        const up = args[0] === 'is-active' ? state.networkd : state.networkdEnabled;
        return up ? { ok: true, stdout: 'active\n' } : { ok: false, stderr: 'inactive' };
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
    // becomes the helper's own exit code, which is how a guest exec has always behaved here.
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
    for (const op of ['provision', 'materialize', 'write-envelope', 'shift-ownership', 'site-data-archive',
      'tree-copy', 'tree-sync', 'tree-remove', 'destroy']) {
      expect(helperRequestNeedsMutationLock({ domain: 'nspawn', op })).toBe(true);
    }
    // The Sites classification is unchanged for the operations that remain: a read never takes the lock.
    for (const op of ['status', 'prepare-runtime-socket', 'seal-runtime-socket', 'remove-runtime-socket']) {
      expect(helperRequestNeedsMutationLock({ op })).toBe(false);
    }
    for (const op of ['sync-sites', 'ensure-site', 'remove-site', 'deny']) {
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
    const settings = renderMachineSettings(binds, { uidBase: 1_073_741_824, environment: { ELOWEN_SITE_SLUG: 'demo', ELOWEN_SITE_URL: 'https://demo.example/path?a=1&b=2' } });
    expect(settings).toContain('PrivateUsers=1073741824:65536');
    expect(settings).toContain('Environment="ELOWEN_SITE_SLUG=demo"');
    expect(settings).toContain('Environment="ELOWEN_SITE_URL=https://demo.example/path?a=1&b=2"');
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

  it('provisions only on a distribution its apt commands are written for', async () => {
    expect(supportedEnvironmentOs('ID=debian\n')).toEqual({ ok: true, detail: 'Debian is supported' });
    expect(supportedEnvironmentOs('NAME="Ubuntu"\nID="ubuntu"\n')).toEqual({ ok: true, detail: 'Ubuntu is supported' });
    expect(supportedEnvironmentOs('ID=fedora\n')).toEqual({ ok: false, detail: 'only Debian and Ubuntu are supported' });
    expect(supportedEnvironmentOs('NAME Ubuntu\n')).toEqual({ ok: false, detail: 'operating system information is malformed' });
    expect(supportedEnvironmentOs('')).toEqual({ ok: false, detail: 'operating system information is unavailable' });

    // Status REPORTS an unsupported host; provisioning refuses before it reaches apt or writes anything.
    for (const osRelease of ['ID=fedora\n', 'NAME Ubuntu\n']) {
      const fixture = runnerFixture({ installed: false });
      const readText = (path: string) => (path === '/etc/os-release' ? osRelease : fixture.readText(path));
      const options = { ...fixture.options, readText };
      const status = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, options) as Readiness;
      expect(rowFor(status, 'os:supported').ok).toBe(false);
      await expect(applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, options))
        .rejects.toThrow(/supported|malformed/);
      expect(fixture.calls.some(({ file }) => file === '/usr/bin/apt-get')).toBe(false);
      expect(fixture.writes).toEqual([]);
    }
  });

  it('refuses a sudo identity or a passwd record that does not hold together', async () => {
    // Every storage root and the polkit grant are derived from this account, so a request whose sudo
    // variables disagree with passwd is refused rather than resolved to whatever passwd happens to say.
    const fixture = runnerFixture();
    for (const [field, message] of [['SUDO_UID', /user id is invalid/], ['SUDO_GID', /group id is invalid/]] as const) {
      for (const bad of ['1000oops', '-1', '01000', '4294967296', '']) {
        await expect(applyRequest({ domain: 'nspawn', op: 'status' }, undefined,
          { ...fixture.options, env: { ...environment, [field]: bad } })).rejects.toThrow(message);
      }
    }
    await expect(applyRequest({ domain: 'nspawn', op: 'status' }, undefined,
      { ...fixture.options, env: { ...environment, SUDO_UID: '1001' } })).rejects.toThrow(/does not match sudo/);

    for (const passwd of [
      'other:x:1000:1000:Other:/home/other:/bin/bash\n',
      'azureuser:x:1000oops:1000:Azure:/home/azureuser:/bin/bash\n',
      'azureuser:x:1000:1000:Azure:relative:/bin/bash\n',
      'azureuser:x:1000:1000:Azure:/home/azureuser:/bin/bash\nextra:x:1001:1001::/home/extra:/bin/bash\n',
    ]) {
      const malformed = runnerFixture();
      const runner = (file: string, args: string[]) => (file === '/usr/bin/getent'
        ? { ok: true, stdout: passwd }
        : malformed.runner(file, args));
      await expect(applyRequest({ domain: 'nspawn', op: 'status' }, undefined, { ...malformed.options, runner }))
        .rejects.toThrow(/record is invalid/);
    }
  });

  it('provisions from an operator root shell for the account it is told, and from nowhere else', async () => {
    // `sudo elowen update` is the documented operator path. It reaches this executable from a root shell,
    // where the inner sudo reports root as the invoking account: the service user could not be derived at
    // all, so the command printed that it could not be determined and provisioned nothing.
    const rootShell = { SUDO_USER: 'root', SUDO_UID: '0', SUDO_GID: '0' };
    const fixture = runnerFixture({ installed: false });
    const provisioned = await applyRequest({ domain: 'nspawn', op: 'provision', user: 'azureuser' }, undefined,
      { ...fixture.options, env: rootShell }) as Readiness;

    expect(provisioned.ready).toBe(true);
    expect(fixture.writes.map((write) => write.path)).toEqual([MACHINE_UNIT_PATH, MACHINE_FIREWALL_UNIT_PATH, POLKIT_RULE_PATH]);
    expect(rowFor(provisioned, 'polkit:machines').detail).toBe('scoped to elowen-machine units for azureuser');

    // Root still has to say which account it means; nothing is guessed from the host.
    await expect(applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, { ...fixture.options, env: rootShell }))
      .rejects.toThrow(/requires naming the service account/);
    // The service account may not name one: sudo already says who it is, and the rule this writes is a
    // grant over machine units that it must not be able to hand to another account.
    await expect(applyRequest({ domain: 'nspawn', op: 'status', user: 'somebody-else' }, undefined, fixture.options))
      .rejects.toThrow(/does not match the invoking account/);
    // And the storage roots keep coming from the account sudo reports, from nothing a request carries.
    expect(helperRequestNeedsDeployment({ domain: 'nspawn', op: 'provision', user: 'azureuser' })).toBe(false);
    expect(storageRootsFor('/home/azureuser')).toEqual(siteGatewayStorageRoots('/home/azureuser'));
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

  it('prepares a fresh host end to end, and the second run changes nothing', async () => {
    // Everything a supported Ubuntu host can be short of at once: no package, no artefacts, no firewall,
    // no forwarding, no link service. One provisioning request is the whole answer.
    const fixture = runnerFixture({
      installed: false, firewall: false, firewallEnabled: false,
      forwarding: false, sysctl: '', networkd: false, networkdEnabled: false,
    });
    const before = await applyRequest({ domain: 'nspawn', op: 'status', veth: true }, undefined, fixture.options) as Readiness;
    expect(before.ready).toBe(false);

    const after = await applyRequest({ domain: 'nspawn', op: 'provision', veth: true }, undefined, fixture.options) as Readiness;
    expect(after.ready, after.items.filter((item) => !item.ok).map((item) => `${item.id}: ${item.detail}`).join('; ')).toBe(true);
    expect(rowFor(after, 'net:ip-forward')).toMatchObject({ ok: true, detail: 'enabled and recorded' });
    expect(rowFor(after, 'service:systemd-networkd')).toMatchObject({ ok: true, detail: 'active and enabled' });
    expect(fixture.writes.map((write) => write.path)).toContain(MACHINE_SYSCTL_PATH);

    // Convergence is the claim, so it is measured rather than asserted: a second run against the host it
    // just produced writes no file, installs no package and reloads nothing.
    const writesBefore = fixture.writes.length;
    const reloadsBefore = reloads(fixture.calls);
    const again = await applyRequest({ domain: 'nspawn', op: 'provision', veth: true }, undefined, fixture.options) as Readiness;
    expect(again.ready).toBe(true);
    expect(fixture.writes).toHaveLength(writesBefore);
    expect(reloads(fixture.calls)).toBe(reloadsBefore);
    expect(fixture.calls.filter((call) => call.file === '/usr/bin/apt-get')).toHaveLength(2);
  });

  it('records forwarding that was only ever set live, so a reboot does not take it away', async () => {
    // `sysctl -w` by hand leaves the kernel right and the host one restart away from refusing every
    // environment. It is not grounds to refuse the host today, but provisioning should fix it.
    const fixture = runnerFixture({ forwarding: true, sysctl: '' });
    const provisioned = await applyRequest({ domain: 'nspawn', op: 'provision', veth: true }, undefined, fixture.options) as Readiness;
    expect(rowFor(provisioned, 'net:ip-forward')).toMatchObject({ ok: true, detail: 'enabled and recorded' });
    expect(fixture.writes.find((write) => write.path === MACHINE_SYSCTL_PATH))
      .toMatchObject({ content: MACHINE_SYSCTL_CONTENT, mode: 0o644 });
  });

  it('asks the running kernel rather than the file it wrote', async () => {
    // The file being present is not the fact that matters; a recorded setting nobody applied leaves a
    // machine unable to route exactly as if the file were absent.
    const fixture = runnerFixture({ forwarding: false, sysctl: MACHINE_SYSCTL_CONTENT });
    const status = await applyRequest({ domain: 'nspawn', op: 'status', veth: true }, undefined, fixture.options) as Readiness;
    const row = rowFor(status, 'net:ip-forward');
    expect(row.ok).toBe(false);
    expect(row.detail).toContain('cannot route without it');
  });

  it('does not newly refuse a host whose forwarding somebody else turned on', async () => {
    // This row gates every veth envelope write, so making it demand this helper's own file would refuse
    // creation, envelope re-creation and snapshot restore on hosts that have been running fine — Docker
    // enables forwarding, and so does any other file under /etc/sysctl.d. The persistence question is
    // real and is answered in the detail, where it blocks nothing.
    const fixture = runnerFixture({ forwarding: true, sysctl: '' });
    const status = await applyRequest({ domain: 'nspawn', op: 'status', veth: true }, undefined, fixture.options) as Readiness;
    const row = rowFor(status, 'net:ip-forward');
    expect(row.ok).toBe(true);
    expect(row.detail).toContain('no record of it');
  });

  it('applies only its own file, never the whole sysctl search path', async () => {
    // `--system` reloads kernel hardening, ptrace scope, magic-sysrq and apparmor along with it, and
    // would silently revert anything an operator had changed live. Preparing a machine runtime is not
    // licence to restate the rest of the host's settings.
    const fixture = runnerFixture({ forwarding: false, sysctl: '' });
    await applyRequest({ domain: 'nspawn', op: 'provision', veth: true }, undefined, fixture.options);
    const applied = fixture.calls.filter((call) => call.file === '/usr/sbin/sysctl');
    expect(applied).toHaveLength(1);
    expect(applied[0]!.args).toEqual(['-p', MACHINE_SYSCTL_PATH]);
  });

  it('enables a link service that is running but would not come back', async () => {
    const fixture = runnerFixture({ networkd: true, networkdEnabled: false });
    const status = await applyRequest({ domain: 'nspawn', op: 'status', veth: true }, undefined, fixture.options) as Readiness;
    expect(rowFor(status, 'service:systemd-networkd').ok).toBe(false);
    expect(rowFor(status, 'service:systemd-networkd').detail).toContain('running, but it would not come back');

    await applyRequest({ domain: 'nspawn', op: 'provision', veth: true }, undefined, fixture.options);
    expect(fixture.calls.some((call) => call.file === '/usr/bin/systemctl'
      && call.args[0] === 'enable' && call.args.includes('systemd-networkd'))).toBe(true);
  });

  it('leaves the host network alone when the request does not ask for veth', async () => {
    // The network rows belong to veth. A caller that does not want one must not have its packet filter,
    // its sysctls or its services changed as a side effect of preparing the runtime.
    const fixture = runnerFixture({ forwarding: false, sysctl: '', networkd: false, networkdEnabled: false });
    await applyRequest({ domain: 'nspawn', op: 'provision', veth: false }, undefined, fixture.options);
    expect(fixture.writes.map((write) => write.path)).not.toContain(MACHINE_SYSCTL_PATH);
    expect(fixture.calls.some((call) => call.file === '/usr/sbin/sysctl')).toBe(false);
    expect(fixture.calls.some((call) => call.file === '/usr/bin/systemctl'
      && call.args[0] === 'enable' && call.args.includes('systemd-networkd'))).toBe(false);
  });

  it('refuses to modify a host whose operating system it does not support', async () => {
    // Not a warning and not a partial run: an unsupported host is left exactly as it was found.
    const fixture = runnerFixture({ installed: false, sysctl: '', forwarding: false });
    const options = { ...fixture.options, readText: (path: string) => (path === '/etc/os-release' ? 'ID=arch\n' : fixture.readText(path)) };
    await expect(applyRequest({ domain: 'nspawn', op: 'provision', veth: true }, undefined, options)).rejects.toThrow();
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.calls.filter((call) => call.file === '/usr/bin/apt-get')).toHaveLength(0);
  });
});

describe('privileged helper: the disk identity record', () => {
  function diskFixture(ref: typeof diskRef = diskRef) {
    const paths = nspawnDiskPaths(storage, ref);
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
        // The tree a real machine runs on belongs to its own uid range, which a test cannot give a file
        // away to. An empty range registry allocates the first slot, so this is the range every envelope
        // written through this fixture declares.
        readOwner: () => UID_RANGE_BASE,
        // The other half of the same limitation: a test cannot give a directory away either, so the
        // handover the extraction performs is recorded rather than made.
        setOwner: () => {},
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

  it('materializes a tree the machine root owns whole, including the directory that becomes its /', async () => {
    // Measured on the deployed build: every freshly created environment failed its first start with
    // `the root filesystem is owned by 1076953121 and this envelope declares the range at 1076953088`,
    // 33 apart. The extraction target is a directory the SERVICE ACCOUNT created, and tar chowns what it
    // unpacks rather than the directory it unpacks into, so the root directory entered the `offset` pass
    // carrying uid 33 and came out at base+33 while `/etc` and the rest came out at base+0. The envelope
    // guard is right to refuse that tree; what has to change is the tree.
    const ref = { ...diskRef, generation: 5, diskId: 'c'.repeat(32), machine: 'elowen-project-54-g5' };
    const fixture = diskFixture(ref);
    const archive = join(fixture.paths.directory, 'image.tar');
    writeFileSync(archive, '');
    // The host, modelled: who owns the machine's root directory, and what each step does to that owner.
    const SERVICE_UID = 33;
    let rootOwner = SERVICE_UID;
    fixture.options.setOwner = (_fd: number, uid: number) => { rootOwner = uid; };
    fixture.options.readOwner = () => rootOwner;
    fixture.options.runner = (file: string, args: string[]) => {
      if (file === '/usr/bin/getent') return { ok: true, stdout: 'azureuser:x:1000:1000::/home/azureuser:/bin/bash\n' };
      if (file === '/usr/bin/python3') {
        // Exactly what the shipped ownership script does to an id: guest id g becomes base+g.
        const shift = JSON.parse(args[2]!);
        if (rootOwner < shift.size) rootOwner = shift.base + rootOwner;
        return { ok: true, stdout: JSON.stringify({ entries: 4242 }) };
      }
      return { ok: true, stdout: '' };
    };

    const materialized = await applyRequest({
      domain: 'nspawn',
      op: 'materialize',
      ...ref,
      archivePath: archive,
      targetPath: fixture.paths.rootfs,
    }, undefined, fixture.options) as { uidBase: number };

    expect(rootOwner).toBe(materialized.uidBase);
    // Which is the whole point of it: the envelope the very next lifecycle step writes goes through on
    // the first attempt, with nothing left for a retry to repair.
    await expect(applyRequest({
      domain: 'nspawn',
      op: 'write-envelope',
      ...ref,
      limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 },
      binds: [],
      dropCapabilities: [],
      privateNetwork: true,
    }, undefined, fixture.options)).resolves.toMatchObject({ ok: true, uidBase: materialized.uidBase });
    rmSync(archive, { force: true });
  });

  it('materializes a fresh disk without a subordinate id range on the host', async () => {
    // The pass maps guest id g to base+g and reads no other mapping, so a disk needs nothing from
    // /etc/subuid. Asking for it anyway made creating ANY environment depend on provisioning that existed
    // only to serve the container runtime, and failed outright on a host that had never run it.
    const fixture = diskFixture();
    fixture.options.readText = (path: string) => (path === '/etc/subuid' ? '' : '');
    const archive = join(fixture.paths.directory, 'image.tar');
    writeFileSync(archive, '');

    const response = await applyRequest({
      domain: 'nspawn', op: 'materialize', ...diskRef,
      archivePath: archive, targetPath: fixture.paths.rootfs,
    }, undefined, fixture.options) as { ok: boolean; uidBase: number };

    expect(response.ok).toBe(true);
    expect(response.uidBase).toBeGreaterThanOrEqual(UID_RANGE_BASE);
    // And the pass it ran carried no subordinate-range arguments at all, rather than carrying unused ones.
    const pass = fixture.calls.find((call) => call.file === '/usr/bin/python3'
      && String(call.args[1] ?? '').includes('to_machine'));
    const spec = JSON.parse(pass!.args[2]!);
    expect(spec).toMatchObject({ base: response.uidBase });
    expect(spec).not.toHaveProperty('serviceId');
    expect(spec).not.toHaveProperty('previousBase');
    rmSync(archive, { force: true });
  });

  it('shifts an existing disk on a host that has no subordinate range either', async () => {
    // The standalone pass reads the same registry-held range the disk already carries, so it asks the
    // host for nothing a container runtime would have had to provision.
    const fixture = diskFixture();
    fixture.options.readText = () => '';
    const receipt = await applyRequest({
      domain: 'nspawn', op: 'shift-ownership', ...diskRef,
    }, undefined, fixture.options) as { ok: boolean; uidBase: number; entries: number };
    expect(receipt).toMatchObject({ ok: true, entries: 4242 });
    expect(receipt.uidBase).toBeGreaterThanOrEqual(UID_RANGE_BASE);
    const spec = JSON.parse(fixture.calls.find((call) => call.file === '/usr/bin/python3')!.args[2]!);
    expect(spec).toEqual({ base: receipt.uidBase, size: 65_536 });
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
      .rejects.toThrow(/not ready for machine networking.*ip_forward=1/s);
    expect(unready.writes).toEqual([]);

    const ready = diskFixture();
    // Forwarding is two facts now — running and recorded — and this test is about the veth gate, not
    // about either of them, so the host model satisfies both and the refusal that remains is the one
    // being measured.
    ready.options.readText = (path: string) => {
      if (path === '/proc/sys/net/ipv4/ip_forward') return '1\n';
      if (path === MACHINE_SYSCTL_PATH) return MACHINE_SYSCTL_CONTENT;
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

  it('keeps one uid range per environment, so a restored disk declares the range its files carry', async () => {
    // A restore mints a new disk id and copies the trees across byte for byte, ownership included. Keyed
    // on the disk, the restored generation was handed a range of its own and booted with a root filesystem
    // its own root could not write, while /data stayed writable through its :rootidmap bind and hid it.
    const RANGES = '/var/lib/elowen/nspawn-uid-ranges.json';
    // The range this environment's files already carry, recorded the way the earlier per-disk key wrote it.
    const registry: Record<string, number> = { [`project:54:${diskRef.diskId}`]: UID_RANGE_BASE + 7 * 65_536 };
    const restored = { ...diskRef, diskId: 'b'.repeat(32), generation: 4, machine: 'elowen-project-54-g4' };
    const envelope = async (ref: typeof diskRef) => {
      mkdirSync(nspawnDiskPaths(storage, ref).rootfs, { recursive: true });
      return await applyRequest({
        domain: 'nspawn',
        op: 'write-envelope',
        ...ref,
        limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 },
        binds: [],
        dropCapabilities: [],
        privateNetwork: true,
      }, undefined, {
        storage,
        env: environment,
        readOwner: () => registry['project:54'] ?? registry[`project:54:${diskRef.diskId}`],
        readText: (path: string) => path === '/etc/subuid' ? 'azureuser:100000:65536\n' : '',
        readUidRanges: () => ({ ...registry }),
        writeAtomic: (path: string, content: Buffer, mode: number) => {
          if (path === RANGES) {
            for (const key of Object.keys(registry)) delete registry[key];
            Object.assign(registry, JSON.parse(content.toString('utf8')));
          } else if (path.startsWith(scratch)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, { mode }); }
        },
        runner: (file: string) => (file === '/usr/bin/getent'
          ? { ok: true, stdout: 'azureuser:x:1000:1000::/home/azureuser:/bin/bash\n' }
          : { ok: true, stdout: '' }),
      }) as { uidBase: number };
    };

    const original = await envelope(diskRef);
    const next = await envelope(restored);

    expect(original.uidBase).toBe(UID_RANGE_BASE + 7 * 65_536);
    expect(next.uidBase).toBe(original.uidBase);
    // Adopted under the environment key, so the disk id it was allocated against stops deciding anything.
    expect(registry['project:54']).toBe(original.uidBase);
    expect(registry[`project:54:${diskRef.diskId}`]).toBeUndefined();
  });

  it('treats only a missing uid registry as empty and never overwrites a damaged one', async () => {
    const registryPath = join(scratch, `uid-registry-${randomUUID()}.json`);
    expect(readUidRangeRegistry(registryPath)).toEqual({});
    writeFileSync(registryPath, `${JSON.stringify({ 'project:54': UID_RANGE_BASE })}\n`, { mode: 0o600 });
    expect(readUidRangeRegistry(registryPath)).toEqual({ 'project:54': UID_RANGE_BASE });

    const broken = [
      '{"project:54":',
      '[]',
      JSON.stringify({ 'project:54': UID_RANGE_BASE, 'project:55': UID_RANGE_BASE }),
      JSON.stringify({ 'project:54': UID_RANGE_BASE + 1 }),
    ];
    for (const content of broken) {
      writeFileSync(registryPath, content, { mode: 0o600 });
      const fixture = diskFixture();
      const before = fixture.writes.length;
      await expect(applyRequest({
        domain: 'nspawn', op: 'write-envelope', ...diskRef,
        limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 }, binds: [], dropCapabilities: [], privateNetwork: true,
      }, undefined, { ...fixture.options, readUidRanges: () => readUidRangeRegistry(registryPath) })).rejects.toThrow(/uid range registry/);
      expect(fixture.writes).toHaveLength(before);
      expect(readFileSync(registryPath, 'utf8')).toBe(content);
    }

    const target = `${registryPath}.target`;
    writeFileSync(target, '{}', { mode: 0o600 });
    rmSync(registryPath, { force: true });
    symlinkSync(target, registryPath);
    expect(() => readUidRangeRegistry(registryPath)).toThrow(/cannot be opened/);
  });

  it('refuses an envelope over a root filesystem some other range owns', async () => {
    // Nothing at boot chowns the tree: PrivateUsersOwnership is off on purpose. An envelope written over a
    // tree of another range therefore reports a running machine whose own root owns none of its files, so
    // the disagreement has to stop the operation that would otherwise succeed.
    const fixture = diskFixture();
    fixture.options.readOwner = () => UID_RANGE_BASE + 3 * 65_536;
    await expect(applyRequest({
      domain: 'nspawn',
      op: 'write-envelope',
      ...diskRef,
      limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 },
      binds: [],
      dropCapabilities: [],
      privateNetwork: true,
    }, undefined, fixture.options)).rejects.toThrow(/root filesystem is owned by 1073938432 and this envelope declares the range at 1073741824/);
    // No envelope and no identity record: the refusal comes before anything a machine could be started from.
    expect(fixture.writes.map((write) => write.path).filter((path) => path.endsWith('.nspawn')
      || path.endsWith('10-elowen.conf') || path === fixture.paths.identity)).toEqual([]);
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
      readOwner: () => UID_RANGE_BASE,
      readUidRanges: () => ({}),
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
    }, undefined, { storage, env: environment, readOwner: () => UID_RANGE_BASE, readUidRanges: () => ({ [`site:${siteId}`]: UID_RANGE_BASE }), writeAtomic: () => {}, runner: () => ({ ok: true, stdout: '' }) })).resolves.toMatchObject({ ok: true });

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
    }, undefined, { storage, env: environment, readOwner: () => UID_RANGE_BASE, writeAtomic: () => {}, runner: () => ({ ok: true, stdout: '' }) }))
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

  it('shifts an existing disk onto the range the registry already holds for it', async () => {
    const fixture = diskFixture();
    const receipt = await applyRequest({ domain: 'nspawn', op: 'shift-ownership', ...diskRef },
      undefined, fixture.options) as { uidBase: number; uidSize: number; entries: number };
    expect(receipt).toMatchObject({ uidSize: 65_536, entries: 4242 });
    expect(receipt.uidBase).toBeGreaterThanOrEqual(1_073_741_824);

    const spec = JSON.parse(fixture.calls.find((call) => call.file === '/usr/bin/python3')!.args[2]);
    expect(spec).toEqual({ base: receipt.uidBase, size: 65_536 });

    // The range is the environment's, so asking twice is the same answer and not a second allocation.
    fixture.calls.length = 0;
    const again = await applyRequest({ domain: 'nspawn', op: 'shift-ownership', ...diskRef },
      undefined, fixture.options) as { uidBase: number };
    expect(again.uidBase).toBe(receipt.uidBase);
  });

  it('leaves an id that already carries the machine range alone, so an interrupted pass is re-run', () => {
    // An interrupted shift left part of a tree converted and part of it not, so the pass has to be safe
    // to repeat. The mapping accepts both schemes on the way in and only writes what actually changes.
    const script = readFileSync(HELPER_SOURCE, 'utf8');
    const body = script.slice(script.indexOf('const OWNERSHIP_SHIFT_PY'), script.indexOf('function shiftOwnership'));
    expect(body).toContain('if machine(uid): return uid');
    expect(body).toContain('if 0<=uid<size: return base+uid');
    expect(body).toContain('if uid!=st.st_uid or gid!=st.st_gid: os.lchown');
    // No second direction and nothing it would need: a tree is only ever moved ONTO the machine range.
    expect(body).not.toMatch(/to_podman|previousBase|serviceId/);
  });
});

describe('privileged helper: disk tree primitives', () => {
  it('keeps one definition of what a tree IS, shared by the copy that checks itself', () => {
    const helper = readFileSync(HELPER_SOURCE, 'utf8');
    // A copy is only trustworthy if it is compared with the same metadata the fingerprint hashes, so the
    // inventory is defined once and embedded into the copy script rather than restated beside it.
    expect(DISK_TREE_SCRIPTS.inventory).toContain('os.getxattr');
    expect(DISK_TREE_SCRIPTS.inventory).toContain('st.st_uid,st.st_gid');
    expect(helper).toContain('cp -a --reflink=auto --sparse=always -- "$source"/. "$target"/');
    expect(helper.indexOf(DISK_TREE_SCRIPTS.inventory), 'the copy script must embed the one inventory')
      .toBeGreaterThan(-1);
    expect(helper.split(DISK_TREE_SCRIPTS.inventory).length - 1,
      'the inventory is defined once and referenced, never copied').toBe(1);

    // The archive verification carries ONE deliberate omission: the tree has been shifted onto the
    // machine's uid range since it was extracted, so comparing ownership against the archive would fail
    // on every file. Everything else — types, modes, sizes, symlinks, hardlinks, xattrs and unexpected
    // entries — is still checked.
    expect(DISK_TREE_SCRIPTS.verify).not.toContain('st.st_uid!=member.uid');
    for (const check of ['missing', 'type', 'mode', 'size', 'symlink target', 'hardlink', 'xattr',
      'unsupported member type', 'unexpected entries']) {
      expect(DISK_TREE_SCRIPTS.verify, `the archive verification must still report ${check}`)
        .toContain(`failures.append('${check} `);
    }
  });

  /** The helper produces the inventory; `containerStorage.mjs` writes what that inventory WAS into every
   *  snapshot manifest as `treeFormat`, and refuses a manifest whose format it does not recognise. That
   *  string is therefore the manifest's own claim about which metadata its digests were taken over, and
   *  the two live in different processes with root in between — the helper cannot import plugin code.
   *  Holding them in step here is what stops a field being added, reordered or dropped on one side only,
   *  which would silently change what an already-stored fingerprint means without invalidating it. */
  it('emits exactly the fields, in the order, that a snapshot manifest says it was fingerprinted over', () => {
    const [version, fields] = String(SNAPSHOT_TREE_FORMAT).split(':');
    expect(version).toBe('inventory-v1');
    const declared = fields.split(',');
    expect(declared).toEqual(['path', 'type', 'size', 'uid', 'gid', 'mode', 'mtimeNs', 'hardlink', 'xattrs', 'linkTarget']);

    // The Python expression that builds one row, taken from the helper's single inventory definition.
    const row = DISK_TREE_SCRIPTS.inventory.slice(DISK_TREE_SCRIPTS.inventory.indexOf('rows.append(['));
    /** Which fragment of that expression produces each declared field. */
    const producedBy: Record<string, string> = {
      path: 'rel', type: 'stat.S_IFMT(st.st_mode)', size: 'st.st_size', uid: 'st.st_uid', gid: 'st.st_gid',
      mode: 'stat.S_IMODE(st.st_mode)', mtimeNs: 'st.st_mtime_ns', hardlink: 'hardlink', xattrs: 'attrs',
      linkTarget: 'os.readlink(path)',
    };
    expect(Object.keys(producedBy)).toEqual(declared);
    let previous = -1;
    for (const field of declared) {
      const at = row.indexOf(producedBy[field]);
      expect(at, `the inventory does not produce the declared field ${field}`).toBeGreaterThan(-1);
      expect(at, `the inventory produces ${field} out of the order the manifest declares`).toBeGreaterThan(previous);
      previous = at;
    }
    // Arity, so a field appended to the row without being declared is caught too. The split is depth
    // aware: an element is free to contain a call with its own commas.
    const elements: string[] = [];
    let depth = 0;
    let current = '';
    for (const character of row.slice(row.indexOf('[') + 1)) {
      if (character === ']' && depth === 0) break;
      if ('([{'.includes(character)) depth += 1;
      if (')]}'.includes(character)) depth -= 1;
      if (character === ',' && depth === 0) { elements.push(current); current = ''; continue; }
      current += character;
    }
    elements.push(current);
    expect(elements).toHaveLength(declared.length);
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

  it('runs a whole-tree pass on the disk budget rather than the default command timeout', async () => {
    // Measured on a 1.4 GB Project tree: the fsync pass over a freshly copied tree does not finish inside
    // the 30s default, while the same pass over a warm tree takes eight seconds. Under the default every
    // first start of a new environment failed and only the automatic retry rescued it.
    const path = join(nspawnDiskPaths(storage, diskRef).directory, 'home');
    mkdirSync(path, { recursive: true });
    const budgets: (number | undefined)[] = [];
    const runner = (_file: string, _args: string[], options: { timeoutMs?: number } = {}) => {
      budgets.push(options.timeoutMs);
      return { ok: true, stdout: JSON.stringify({ logicalBytes: 10, allocatedBytes: 4096, digest: 'f'.repeat(64) }) };
    };
    await applyRequest({ domain: 'nspawn', op: 'tree-sync', path }, undefined, { storage, runner });
    await applyRequest({ domain: 'nspawn', op: 'tree-fingerprint', path }, undefined, { storage, runner });

    expect(budgets).toEqual([DISK_TREE_TIMEOUT_MS, DISK_TREE_TIMEOUT_MS]);
    expect(DISK_TREE_TIMEOUT_MS).toBe(15 * 60_000);
    expect(commandOptionsFor('/usr/bin/python3', ['-c', ''], DISK_TREE_TIMEOUT_MS).timeout).toBe(DISK_TREE_TIMEOUT_MS);
    // Everything that is not tree work keeps the short bound that catches a command which has hung.
    expect(commandOptionsFor('/usr/bin/systemctl', ['daemon-reload']).timeout).toBe(30_000);

    // apt is the one command that may take minutes and the one that may try to restart services. It gets
    // its own budget and an environment that keeps it non-interactive and stops needrestart acting.
    const install = commandOptionsFor('/usr/bin/apt-get', ['install', '--yes', '--no-install-recommends', 'systemd-container']);
    expect(commandOptionsFor('/usr/bin/apt-get', ['update']).timeout).toBe(5 * 60_000);
    expect(install.env).toEqual({
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l',
    });
    expect(commandOptionsFor('/usr/bin/systemctl', ['daemon-reload']).env).toEqual({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin' });
  });

  it('carries the cause of a command that printed nothing, instead of a message ending in a colon', () => {
    // A command killed for outrunning its budget is terminated before it writes a byte, so `stderr` is
    // empty and the caller's message used to read `the disk tree sync failed:` with nothing after it.
    expect(defaultCommandRunner('/bin/sh', ['-c', 'sleep 30'], { timeoutMs: 1_000 }))
      .toEqual({ ok: false, stderr: 'the command printed nothing and was killed after its 1s budget' });
    expect(defaultCommandRunner('/bin/sh', ['-c', 'exit 3']))
      .toEqual({ ok: false, stderr: 'the command printed nothing and exited with status 3' });
    // A command that did say something still speaks for itself.
    expect(defaultCommandRunner('/bin/sh', ['-c', 'echo refused >&2; exit 1']))
      .toEqual({ ok: false, stderr: 'refused' });
  });
});

/** A Site's `data` directory is a plain tree the machine's uid range owns, so seeding and capturing it
 *  both run here: nothing else on the host can read or write it. These exercise the REAL tar and the real
 *  tree scripts against real files; only the ownership pass is stubbed, because an unprivileged test
 *  cannot give a file away — the same limitation `diskFixture` above records. */
describe('privileged helper: the Site data archive', () => {
  const siteRef = { kind: 'site', resource: 'shop', diskId: 'e'.repeat(32) };

  /** Metadata a filename listing would never notice: a hard link pair, a symlink, an extended attribute,
   *  a narrow mode and a modification time with nanoseconds in it. Every one of them is a field the tree
   *  fingerprint hashes, which is what makes the round trip below a real comparison. */
  function seedDataTree(root: string) {
    writeFileSync(join(root, 'app.conf'), 'key=value\n', { mode: 0o640 });
    linkSync(join(root, 'app.conf'), join(root, 'app.conf.bak'));
    mkdirSync(join(root, 'uploads'), { mode: 0o750 });
    writeFileSync(join(root, 'uploads', 'photo.bin'), Buffer.from([0, 1, 2, 3, 4, 5]), { mode: 0o600 });
    symlinkSync('../app.conf', join(root, 'uploads', 'config'));
    // Node cannot set an extended attribute and cannot set a modification time to the nanosecond, and
    // both are fields the fingerprint compares — so the fixture sets them the way the helper reads them.
    execFileSync('/usr/bin/python3', ['-c', `import os,sys
root=sys.argv[1]
os.setxattr(os.path.join(root,'app.conf'),'user.elowen.demo',b'retained')
os.utime(os.path.join(root,'app.conf'),ns=(1709528767123456789,1709528767123456789))
os.utime(os.path.join(root,'uploads','photo.bin'),ns=(1698765432987654321,1698765432987654321))
os.utime(os.path.join(root,'uploads'),ns=(1687654321246813579,1687654321246813579))`, root]);
  }

  function dataFixture(ref: typeof siteRef = siteRef) {
    const paths = nspawnDiskPaths(storage, ref);
    const data = join(paths.directory, 'data');
    const artifacts = join(paths.storageRoot, 'artifacts');
    rmSync(paths.storageRoot, { recursive: true, force: true });
    mkdirSync(data, { recursive: true, mode: 0o700 });
    mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    const shifts: { spec: { base: number; size: number }; root: string }[] = [];
    const owners: { uid: number; gid: number }[] = [];
    const calls: Call[] = [];
    /** Which command the fixture intercepts instead of running, by the script or flag that identifies it. */
    const intercept: Record<string, (args: string[]) => { ok: boolean; stdout?: string; stderr?: string }> = {};
    const options: any = {
      storage,
      env: environment,
      setOwner: (_fd: number, uid: number, gid: number) => { owners.push({ uid, gid }); },
      readText: () => '',
      writeAtomic: (path: string, content: Buffer, mode: number) => {
        if (path.startsWith(scratch)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, { mode }); }
      },
      runner: (file: string, args: string[], runOptions: { timeoutMs?: number } = {}) => {
        calls.push({ file, args });
        if (file === '/usr/bin/getent') return { ok: true, stdout: 'azureuser:x:1000:1000::/home/azureuser:/bin/bash\n' };
        // The ownership pass is the one command that is faked rather than run: it chowns, and no
        // unprivileged process can. What it was asked to do is recorded instead.
        if (file === '/usr/bin/python3' && String(args[1] ?? '').includes('to_machine')) {
          shifts.push({ spec: JSON.parse(args[2]!), root: args[3]! });
          return { ok: true, stdout: JSON.stringify({ entries: 9 }) };
        }
        for (const [marker, answer] of Object.entries(intercept)) {
          if (args.some((argument) => String(argument).includes(marker))) return answer(args);
        }
        // systemd is faked for the same reason the ownership pass is: the alternative is the REAL manager
        // on whatever host this runs, which would answer about its own machines, differ between a
        // developer's box and CI, and is not there at all in a container. "Nothing is up" is the state
        // these tests are about; the ones that are about the check install their own answer above.
        if (file === '/usr/bin/systemctl') return { ok: true, stdout: '' };
        return defaultCommandRunner(file, args, runOptions);
      },
    };
    const fingerprint = async (path: string) => await applyRequest(
      { domain: 'nspawn', op: 'tree-fingerprint', path }, undefined, options,
    ) as { digest: string; logicalBytes: number };
    const archiveOf = (name: string) => join(artifacts, name);
    return { paths, data, artifacts, shifts, owners, calls, intercept, options, fingerprint, archiveOf };
  }

  const exportRequest = (fixture: ReturnType<typeof dataFixture>, archivePath: string, ref: typeof siteRef = siteRef) =>
    ({ domain: 'nspawn', op: 'site-data-archive', ...ref, operation: 'export', dataPath: fixture.data, archivePath });
  const importRequest = (fixture: ReturnType<typeof dataFixture>, archivePath: string, ref: typeof siteRef = siteRef) =>
    ({ domain: 'nspawn', op: 'site-data-archive', ...ref, operation: 'import', dataPath: fixture.data, archivePath });

  it('round trips a data tree byte for byte, metadata included', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const before = await fixture.fingerprint(fixture.data);
    const mode = statSync(fixture.data).mode & 0o7777;
    const archive = fixture.archiveOf('data.tar');

    await expect(applyRequest(exportRequest(fixture, archive), undefined, fixture.options))
      .resolves.toMatchObject({ ok: true, operation: 'export', archivePath: archive });
    expect(existsSync(archive)).toBe(true);

    // Imported into an EMPTY tree, so nothing that survives could have survived by being left alone.
    for (const name of readdirSync(fixture.data)) rmSync(join(fixture.data, name), { recursive: true, force: true });
    expect(readdirSync(fixture.data)).toEqual([]);

    await expect(applyRequest(importRequest(fixture, archive), undefined, fixture.options))
      .resolves.toMatchObject({ ok: true, operation: 'import' });

    const after = await fixture.fingerprint(fixture.data);
    expect(after.digest).toBe(before.digest);
    expect(after.logicalBytes).toBe(before.logicalBytes);
    expect(statSync(fixture.data).mode & 0o7777).toBe(mode);
    // And the entries themselves, so a fingerprint that silently agreed on two empty trees cannot pass.
    expect(readdirSync(fixture.data).sort()).toEqual(['app.conf', 'app.conf.bak', 'uploads']);
  }, 60_000);

  it('leaves no staging tree or retired tree behind once an import has swapped', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const archive = fixture.archiveOf('data.tar');
    await applyRequest(exportRequest(fixture, archive), undefined, fixture.options);
    await applyRequest(importRequest(fixture, archive), undefined, fixture.options);
    expect(readdirSync(fixture.paths.directory).sort()).toEqual(['data']);
  }, 60_000);

  it('refuses an import whose archive is not there, and an export onto a destination that is', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    await expect(applyRequest(importRequest(fixture, fixture.archiveOf('absent.tar')), undefined, fixture.options))
      .rejects.toThrow(/does not exist/);

    const occupied = fixture.archiveOf('taken.tar');
    writeFileSync(occupied, 'someone else wrote this');
    await expect(applyRequest(exportRequest(fixture, occupied), undefined, fixture.options))
      .rejects.toThrow(/destination already exists/);
    // Refused, not overwritten: the bytes that were there are the bytes that are there.
    expect(readFileSync(occupied, 'utf8')).toBe('someone else wrote this');
  }, 60_000);

  it('leaves the data directory untouched when an import fails part way through', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const archive = fixture.archiveOf('data.tar');
    await applyRequest(exportRequest(fixture, archive), undefined, fixture.options);

    // The tree MOVES ON after the capture, which is what makes this measurable: the archive and the live
    // directory now differ, so an extraction that touched the live tree would show up as a tree that had
    // been rolled back rather than left alone.
    writeFileSync(join(fixture.data, 'app.conf'), 'key=changed-since-the-capture\n', { mode: 0o640 });
    writeFileSync(join(fixture.data, 'written-later.log'), 'the Site has been serving\n', { mode: 0o644 });
    rmSync(join(fixture.data, 'uploads', 'photo.bin'));
    const before = await fixture.fingerprint(fixture.data);

    // After the extraction and before the swap: the staging tree is full and the target is still the old
    // one, which is precisely the moment a half-replaced directory would become observable.
    fixture.intercept['Migrated rootfs differs'] = () => ({ ok: false, stderr: 'injected verification failure' });
    await expect(applyRequest(importRequest(fixture, archive), undefined, fixture.options))
      .rejects.toThrow(/injected verification failure/);
    delete fixture.intercept['Migrated rootfs differs'];

    const after = await fixture.fingerprint(fixture.data);
    expect(after.digest).toBe(before.digest);
    expect(readFileSync(join(fixture.data, 'app.conf'), 'utf8')).toBe('key=changed-since-the-capture\n');
    expect(existsSync(join(fixture.data, 'uploads', 'photo.bin'))).toBe(false);
    expect(readdirSync(fixture.paths.directory).sort()).toEqual(['data']);
  }, 60_000);

  it('refuses an oversized archive in both directions before it writes anything', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    expect(SITE_DATA_ARCHIVE_BYTES).toBe(16 * 1024 ** 3);

    // An export is refused on what the data tree weighs, so no partial archive is ever created.
    fixture.intercept['Insufficient free space'] = () => ({ ok: true,
      stdout: JSON.stringify({ requiredBytes: SITE_DATA_ARCHIVE_BYTES + 1, marginBytes: 0, freeBytes: 2 ** 50 }) });
    const refused = fixture.archiveOf('too-big.tar');
    await expect(applyRequest(exportRequest(fixture, refused), undefined, fixture.options))
      .rejects.toThrow(/bound/);
    expect(existsSync(refused)).toBe(false);
    expect(existsSync(`${refused}.exporting`)).toBe(false);
    delete fixture.intercept['Insufficient free space'];

    // An import is refused on the archive's own weight, without reading it. A real archive padded out to
    // the bound, rather than a file of zeros: an implementation that skipped this check would then go on
    // to import it quickly and be caught by the assertion instead of running until the suite gave up.
    const huge = fixture.archiveOf('huge.tar');
    execFileSync('/usr/bin/tar', ['--create', '--file', huge, '-C', fixture.data, '--', '.']);
    execFileSync('/usr/bin/truncate', ['-s', String(SITE_DATA_ARCHIVE_BYTES + 1), huge]);
    await expect(applyRequest(importRequest(fixture, huge), undefined, fixture.options))
      .rejects.toThrow(/bound/);
    rmSync(huge, { force: true });

    // And on what it would UNPACK to, which a sparse member states in its header without carrying it:
    // this archive is a few kilobytes and declares more than the bound.
    const sparseRoot = join(fixture.paths.storageRoot, 'sparse');
    mkdirSync(sparseRoot, { recursive: true });
    execFileSync('/usr/bin/truncate', ['-s', String(SITE_DATA_ARCHIVE_BYTES + 1), join(sparseRoot, 'blob.bin')]);
    const sparse = fixture.archiveOf('sparse.tar');
    execFileSync('/usr/bin/tar', ['--create', '--file', sparse, '--sparse', '-C', sparseRoot, '--', '.']);
    expect(statSync(sparse).size).toBeLessThan(SITE_DATA_ARCHIVE_BYTES);
    await expect(applyRequest(importRequest(fixture, sparse), undefined, fixture.options))
      .rejects.toThrow(/unpack/);
    expect(readdirSync(fixture.paths.directory).sort()).toEqual(['data']);
  }, 120_000);

  it('puts the imported tree on the machine uid range, through the one ownership pass', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const archive = fixture.archiveOf('data.tar');
    await applyRequest(exportRequest(fixture, archive), undefined, fixture.options);
    fixture.shifts.length = 0;
    fixture.owners.length = 0;

    await applyRequest(importRequest(fixture, archive), undefined, fixture.options);

    // Exactly one pass, over the STAGING tree, with the range the registry holds for this environment —
    // the same call `materialize` makes, and made before the tree is swapped into place.
    expect(fixture.shifts).toHaveLength(1);
    expect(fixture.shifts[0].spec).toEqual({ base: UID_RANGE_BASE, size: 65_536 });
    expect(fixture.shifts[0].root).toBe(`${fixture.data}.importing`);
    // tar chowns what it unpacks, never the directory it unpacks into, so the staging root enters that
    // pass as the guest's own root rather than as the service account it was created by.
    expect(fixture.owners).toContainEqual({ uid: 0, gid: 0 });
  }, 60_000);

  it('leaves no partial archive behind when an export fails', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const archive = fixture.archiveOf('data.tar');
    // A failing archiver that has already written bytes, which is the state a retry must not mistake for
    // a finished export.
    fixture.intercept['--create'] = (args: string[]) => {
      writeFileSync(args[args.indexOf('--file') + 1]!, 'half an archive');
      return { ok: false, stderr: 'injected archiver failure' };
    };
    await expect(applyRequest(exportRequest(fixture, archive), undefined, fixture.options))
      .rejects.toThrow(/injected archiver failure/);
    expect(readdirSync(fixture.artifacts)).toEqual([]);
  }, 60_000);

  it('refuses a data path that does not belong to the environment the request names', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const archive = fixture.archiveOf('data.tar');
    const other = nspawnDiskPaths(storage, { ...siteRef, resource: 'other' });
    mkdirSync(join(other.directory, 'data'), { recursive: true });
    await expect(applyRequest({ ...exportRequest(fixture, archive), dataPath: join(other.directory, 'data') }, undefined, fixture.options))
      .rejects.toThrow(/does not belong to the environment/);
    // And the root filesystem is not a data tree, however validly it sits under the same storage root.
    mkdirSync(fixture.paths.rootfs, { recursive: true });
    await expect(applyRequest({ ...exportRequest(fixture, archive), dataPath: fixture.paths.rootfs }, undefined, fixture.options))
      .rejects.toThrow(/does not belong to the environment/);
    expect(existsSync(archive)).toBe(false);
  }, 60_000);

  it('refuses a SNAPSHOT data tree, which is the one thing the recovery depends on', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const archive = fixture.archiveOf('data.tar');
    await applyRequest(exportRequest(fixture, archive), undefined, fixture.options);

    // A snapshot's data tree sits under the same storage root and is called `data`, so a check that
    // accepted the name accepted this. Overwriting it destroys the restore the runtime documents as the
    // recovery for a data tree that went missing — and an import is exactly how that recovery is asked for.
    const snapshot = join(fixture.paths.storageRoot, 'snapshots', 'f'.repeat(32), 'data');
    mkdirSync(snapshot, { recursive: true, mode: 0o700 });
    writeFileSync(join(snapshot, 'kept.conf'), 'the snapshot the operator restores from\n', { mode: 0o600 });

    await expect(applyRequest({ ...importRequest(fixture, archive), dataPath: snapshot }, undefined, fixture.options))
      .rejects.toThrow(/does not belong to the environment/);
    await expect(applyRequest({ ...exportRequest(fixture, fixture.archiveOf('snap.tar')), dataPath: snapshot }, undefined, fixture.options))
      .rejects.toThrow(/does not belong to the environment/);
    // Untouched: not renamed aside, not staged over, not emptied.
    expect(readdirSync(snapshot)).toEqual(['kept.conf']);
    expect(readFileSync(join(snapshot, 'kept.conf'), 'utf8')).toBe('the snapshot the operator restores from\n');
  }, 60_000);

  it('accepts the migrated component tree only at the generation the request states', async () => {
    // An environment migrated onto trees an earlier generation created keeps its data under
    // `storage/<generation>`, which the helper derives from the number on the request rather than
    // recognising by shape.
    const fixture = dataFixture();
    const migrated = join(fixture.paths.storageRoot, 'storage', '4', 'data');
    mkdirSync(migrated, { recursive: true, mode: 0o700 });
    seedDataTree(migrated);
    const archive = fixture.archiveOf('migrated.tar');

    await expect(applyRequest({ ...exportRequest(fixture, archive), dataPath: migrated, componentGeneration: 4 },
      undefined, fixture.options)).resolves.toMatchObject({ ok: true, dataPath: migrated });
    // The same tree named under a different generation is not this component.
    await expect(applyRequest({ ...exportRequest(fixture, fixture.archiveOf('wrong.tar')), dataPath: migrated, componentGeneration: 5 },
      undefined, fixture.options)).rejects.toThrow(/does not belong to the environment/);
    await expect(applyRequest({ ...exportRequest(fixture, fixture.archiveOf('bad.tar')), dataPath: migrated, componentGeneration: 0 },
      undefined, fixture.options)).rejects.toThrow(/component generation is invalid/);
  }, 60_000);

  it('captures the tree it verified when the data directory is swapped for a symlink underneath it', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const archive = fixture.archiveOf('data.tar');

    // The host directory root would reach through a symlink, standing in for /root. The service account
    // owns the directory the data tree sits in, so it can replace that entry at any moment — and the gap
    // between the path check and the archiver was a gap it could spin an export against until it hit.
    const elsewhere = join(scratch, 'not-under-the-storage-roots');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'id_rsa'), 'a private key the caller must never receive\n', { mode: 0o600 });

    // Swapped after every path check has passed and before a byte is archived, which is the whole window.
    // A rename and a symlink, which is what the owner of the surrounding directory can actually do — the
    // real tree is still there under another name, so what the archive holds says which one was read.
    fixture.intercept['Insufficient free space'] = () => {
      renameSync(fixture.data, `${fixture.data}.moved-aside`);
      symlinkSync(elsewhere, fixture.data);
      return { ok: true, stdout: JSON.stringify({ requiredBytes: 4096, marginBytes: 0, freeBytes: 2 ** 50 }) };
    };
    await applyRequest(exportRequest(fixture, archive), undefined, fixture.options);
    delete fixture.intercept['Insufficient free space'];

    const members = execFileSync('/usr/bin/tar', ['--list', '--file', archive], { encoding: 'utf8' })
      .split('\n').map((line) => line.replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean).sort();
    expect(members, 'the export must not have followed the symlink').not.toContain('id_rsa');
    expect(members).toEqual(['app.conf', 'app.conf.bak', 'uploads', 'uploads/config', 'uploads/photo.bin']);
    expect(readFileSync(join(elsewhere, 'id_rsa'), 'utf8')).toBe('a private key the caller must never receive\n');
  }, 60_000);

  it('refuses to open a data directory that is already a symlink when it is asked for', async () => {
    const fixture = dataFixture();
    rmSync(fixture.data, { recursive: true, force: true });
    symlinkSync(scratch, fixture.data);
    await expect(applyRequest(exportRequest(fixture, fixture.archiveOf('linked.tar')), undefined, fixture.options))
      .rejects.toThrow(/symlink|not a directory/i);
  }, 60_000);

  it('refuses an import while any generation of the environment machine is still up', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const archive = fixture.archiveOf('data.tar');
    await applyRequest(exportRequest(fixture, archive), undefined, fixture.options);
    const before = await fixture.fingerprint(fixture.data);

    // The runtime asks the same question before it sends the request. This is the helper being asked to
    // rename the tree a live guest has bind-mounted and then delete what it replaced, by a caller that
    // did not ask or did not wait for the answer.
    fixture.intercept['list-units'] = () => ({ ok: true,
      stdout: 'elowen-machine@elowen-site-shop-g7.service loaded active running Elowen machine elowen-site-shop-g7\n' });
    await expect(applyRequest(importRequest(fixture, archive), undefined, fixture.options))
      .rejects.toThrow(/stop the environment before importing its data/i);
    // Refused before anything moved: no staging tree, no retired tree, the same bytes.
    expect(readdirSync(fixture.paths.directory).sort()).toEqual(['data']);
    expect((await fixture.fingerprint(fixture.data)).digest).toBe(before.digest);

    // A machine of ANOTHER environment whose unit happens to come back in the listing is not this one.
    fixture.intercept['list-units'] = () => ({ ok: true,
      stdout: 'elowen-machine@elowen-site-other-g1.service loaded active running Elowen machine elowen-site-other-g1\n' });
    await expect(applyRequest(importRequest(fixture, archive), undefined, fixture.options)).resolves.toMatchObject({ ok: true });

    // And a manager that will not answer refuses the import rather than passing it: an unreadable state
    // is not an absent machine, and the alternative to asking is destroying live data.
    fixture.intercept['list-units'] = () => ({ ok: false, stderr: 'Failed to connect to bus' });
    await expect(applyRequest(importRequest(fixture, archive), undefined, fixture.options))
      .rejects.toThrow(/machine state could not be established/);
    delete fixture.intercept['list-units'];

    // An export is not gated on it: capturing a running Site's data reads the tree and changes nothing.
    fixture.intercept['list-units'] = () => ({ ok: true,
      stdout: 'elowen-machine@elowen-site-shop-g7.service loaded active running Elowen machine elowen-site-shop-g7\n' });
    await expect(applyRequest(exportRequest(fixture, fixture.archiveOf('while-up.tar')), undefined, fixture.options))
      .resolves.toMatchObject({ ok: true, operation: 'export' });
    delete fixture.intercept['list-units'];
  }, 120_000);

  it('asks systemd about every generation of this environment and nothing else', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const archive = fixture.archiveOf('data.tar');
    await applyRequest(exportRequest(fixture, archive), undefined, fixture.options);
    fixture.calls.length = 0;
    await applyRequest(importRequest(fixture, archive), undefined, fixture.options);

    const asked = fixture.calls.find((call) => call.args[0] === 'list-units');
    expect(asked?.file).toBe('/usr/bin/systemctl');
    expect(asked?.args).toContain('elowen-machine@elowen-site-shop-g*.service');
    expect(asked?.args).toContain('--state=activating,active,deactivating,reloading');
  }, 60_000);

  it('refuses an archive that names more members than it may, however little it weighs', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const archive = fixture.archiveOf('data.tar');
    await applyRequest(exportRequest(fixture, archive), undefined, fixture.options);
    expect(SITE_DATA_ARCHIVE_MEMBERS).toBe(2_000_000);

    // Empty members cost a header each and nothing else, so a byte bound does not bound them at all: this
    // archive is a few kilobytes and every entry it names becomes an inode that is created, verified,
    // chowned and fsynced. The count is intercepted rather than actually written out, because producing
    // two million real entries in a test costs more than the defect it demonstrates.
    fixture.intercept['members>entries'] = (args: string[]) => {
      const limit = Number(args[args.length - 1]);
      expect(limit).toBe(SITE_DATA_ARCHIVE_MEMBERS);
      return { ok: false, stderr: `the archive names more than ${limit} members` };
    };
    await expect(applyRequest(importRequest(fixture, archive), undefined, fixture.options))
      .rejects.toThrow(/names more than 2000000 members/);
    delete fixture.intercept['members>entries'];
    expect(readdirSync(fixture.paths.directory).sort()).toEqual(['data']);
  }, 60_000);

  it('bounds the member count in the index script itself, on the member that crosses the line', async () => {
    // The bound run for real against a real archive, at a size a test can produce: proof that the script
    // refuses rather than that the constant exists.
    const fixture = dataFixture();
    const many = join(fixture.paths.storageRoot, 'many');
    mkdirSync(many, { recursive: true });
    for (let at = 0; at < 40; at += 1) writeFileSync(join(many, `entry-${at}`), '');
    const archive = fixture.archiveOf('many.tar');
    execFileSync('/usr/bin/tar', ['--create', '--file', archive, '-C', many, '--', '.']);
    expect(statSync(archive).size).toBeLessThan(SITE_DATA_ARCHIVE_BYTES);

    const indexed = defaultCommandRunner('/usr/bin/python3', ['-c', SITE_DATA_INDEX_PY, archive,
      String(SITE_DATA_ARCHIVE_BYTES), '10']);
    expect(indexed.ok).toBe(false);
    expect(indexed.stderr).toMatch(/names more than 10 members/);
    // And the same archive under a bound it fits inside is indexed rather than refused.
    const allowed = defaultCommandRunner('/usr/bin/python3', ['-c', SITE_DATA_INDEX_PY, archive,
      String(SITE_DATA_ARCHIVE_BYTES), String(SITE_DATA_ARCHIVE_MEMBERS)]);
    expect(allowed.ok).toBe(true);
    expect(JSON.parse(allowed.stdout).members).toBe(41);
  }, 60_000);

  it('refuses an import the filesystem has no room for, before it extracts anything', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    const archive = fixture.archiveOf('data.tar');
    await applyRequest(exportRequest(fixture, archive), undefined, fixture.options);
    const before = await fixture.fingerprint(fixture.data);

    // The export side has asked this since it was written; the import side wrote into the filesystem every
    // other environment on the host runs from and never asked at all. The archive's headers already state
    // what it unpacks to, so the preflight is given that figure rather than a tree to walk.
    let asked: string[] | null = null;
    fixture.intercept['Insufficient free space'] = (args: string[]) => {
      // An empty source list is what identifies the import's call: it has no tree to walk and hands over
      // the figure the archive's own headers stated instead.
      if (args[2] !== '[]') return { ok: true, stdout: JSON.stringify({ requiredBytes: 4096, marginBytes: 0, freeBytes: 2 ** 50 }) };
      asked = args;
      return { ok: false, stderr: 'Insufficient free space for disk copy: need 8796093022208 bytes including margin, have 12' };
    };
    await expect(applyRequest(importRequest(fixture, archive), undefined, fixture.options))
      .rejects.toThrow(/Insufficient free space/);
    delete fixture.intercept['Insufficient free space'];

    expect(asked, 'the import must run the preflight against the directory it stages into').not.toBeNull();
    // Nothing extracted, nothing swapped, nothing left behind.
    expect(readdirSync(fixture.paths.directory).sort()).toEqual(['data']);
    expect((await fixture.fingerprint(fixture.data)).digest).toBe(before.digest);
  }, 60_000);

  it('refuses the operation for anything that is not a Site', async () => {
    const fixture = dataFixture();
    seedDataTree(fixture.data);
    await expect(applyRequest({
      ...exportRequest(fixture, fixture.archiveOf('data.tar')), kind: 'project', resource: '54',
    }, undefined, fixture.options)).rejects.toThrow(/site/i);
    await expect(applyRequest({ ...exportRequest(fixture, fixture.archiveOf('data.tar')), operation: 'move' },
      undefined, fixture.options)).rejects.toThrow(/operation is invalid/);
  }, 60_000);

  it('serializes a data archive behind the global mutation lock, like every other write', () => {
    expect(helperRequestNeedsMutationLock({ domain: 'nspawn', op: 'site-data-archive' })).toBe(true);
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
      'site-data-archive', 'tree-copy', 'tree-fingerprint', 'tree-preflight', 'tree-remove', 'tree-sync',
      'tree-verify', 'destroy']) {
      expect(helperRequest(op, {})).toEqual({ domain: 'nspawn', op });
      let refusal = '';
      try { applyNspawnRequest({ domain: 'nspawn', op }, { storage }); } catch (error) { refusal = String(error); }
      expect(refusal, `${op} must be answered by the machine domain`).not.toMatch(/operation is not supported/);
    }
  });
});
