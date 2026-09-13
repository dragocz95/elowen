import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  RESOURCE_USAGE_TIMEOUT_MS,
  commandOptionsFor,
  defaultCommandRunner,
  MACHINE_UNIT_PATH,
  MACHINE_STORAGE_RECEIPT_PATH,
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
  storageRootsFor,
  supportedEnvironmentOs,
  trustedPath,
  UID_RANGE_BASE,
} from '../../scripts/elowen-site-gateway.mjs';
// @ts-expect-error the bundled Sandbox plugin is plain ESM without declarations
import { createEnvironmentDiskSpec } from '../../plugins/sandbox/lib/containerSpec.mjs';
// @ts-expect-error the bundled machine runtime is plain ESM without declarations
import { HELPER_PATH as PLUGIN_HELPER_PATH, MACHINE_PATTERN as PLUGIN_MACHINE_PATTERN, helperRequest } from '../../plugins/sandbox/lib/nspawn.mjs';
// @ts-expect-error the bundled Sandbox storage owner is plain ESM without declarations
import { SNAPSHOT_TREE_FORMAT } from '../../plugins/sandbox/lib/containerStorage.mjs';
import {
  MACHINE_STORAGE_RECEIPT_PATH as SHARED_MACHINE_STORAGE_RECEIPT_PATH,
  siteGatewayPluginDataDir,
  encodeHelperRequest, HELPER_FRAME_HEADER_BYTES, SITE_GATEWAY_HELPER_ARGV, SITE_GATEWAY_HELPER_PATH,
} from '../../src/shared/siteGateway.js';

const HELPER_SOURCE = fileURLToPath(new URL('../../scripts/elowen-site-gateway.mjs', import.meta.url));
const PLUGIN_RUNTIME = fileURLToPath(new URL('../../plugins/sandbox/lib/nspawn.mjs', import.meta.url));

const MACHINE = 'elowen-project-54-g3';
const UNIT = `elowen-exec-g3-${'a'.repeat(32)}.service`;
const environment = { SUDO_USER: 'azureuser', SUDO_UID: '1000', SUDO_GID: '1000' };
const scratch = mkdtempSync(join(tmpdir(), 'elowen-nspawn-contract-'));
// The compatibility-default roots the helper derives from the passwd HOME when no root-owned custom
// storage receipt is installed. No runtime request can name or widen them.
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
  unitLoaded?: boolean; firewall?: boolean; dockerChain?: boolean; forwarding?: boolean; networkd?: boolean; deployment?: string;
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
    dockerChain: options.dockerChain ?? true,
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
    if (path === '/run/systemd/resolve/resolv.conf') return 'nameserver 192.0.2.53\n';
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
  const removeFile = (path: string) => {
    if (path !== POLKIT_RULE_PATH) throw new Error(`unexpected removal: ${path}`);
    state.polkit = '';
    state.polkitMode = -1;
  };
  const runner = (file: string, args: string[]) => {
    calls.push({ file, args: [...args] });
    if (file === '/usr/bin/getent') return { ok: true, stdout: 'azureuser:x:1000:1000::/home/azureuser:/bin/bash\n' };
    if (file === '/usr/bin/dpkg-query') return state.installed ? { ok: true, stdout: 'install ok installed\n' } : { ok: false, stderr: 'not installed' };
    if (file === '/usr/sbin/iptables' || file === '/usr/sbin/ip6tables') {
      if (!state.firewall) return { ok: false, stderr: 'No chain/target/match by that name' };
      if (args[0] === '-S') {
        const chain = args[1];
        if (file === '/usr/sbin/iptables' && chain === 'DOCKER-USER' && !state.dockerChain) {
          return { ok: false, stderr: 'No chain/target/match by that name' };
        }
        const stdout = NSPAWN_FIREWALL_RULES
          .filter((rule) => rule.binary === file && rule.chain === chain)
          .sort((left, right) => left.insertAt - right.insertAt)
          .map((rule) => `-A ${rule.chain} ${rule.spec.join(' ')}`)
          .join('\n');
        return { ok: true, stdout: `${stdout}\n` };
      }
      return { ok: true, stdout: '' };
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
  return { calls, writes, state, runner, readText, readMode, writeAtomic, removeFile, options: { runner, readText, readMode, writeAtomic, removeFile, env: environment } };
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
    for (const op of ['status', 'provision', 'exec', 'start', 'stop', 'set-limits', 'freeze', 'thaw', 'materialize', 'tree-copy', 'destroy', 'release-uid-range']) {
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
    for (const bad of ['../etc/passwd', 'elowen-site-1e5b2c-g12', 'elowen-project-54', 'other-project-54-g1', 'elowen-project-54-g3/x',
      'elowen-project-54-g3.service', 'elowen-project-UPPER-g1', `elowen-project-${'a'.repeat(65)}-g1`]) {
      expect(() => machineUnitFor(bad)).toThrow(/machine name is invalid/);
      // The bundled runtime refuses the same names before it ever reaches sudo; the two patterns live in
      // files that cannot import each other, so they are held together here.
      expect(PLUGIN_MACHINE_PATTERN.test(bad), bad).toBe(false);
    }
    expect(PLUGIN_MACHINE_PATTERN.test(MACHINE)).toBe(true);
  });

  it('builds machine lifecycle mutations from typed fields only', async () => {
    const calls: Call[] = [];
    const runner = (file: string, args: string[]) => { calls.push({ file, args }); return { ok: true, stdout: '' }; };
    await applyNspawnRequest({ domain: 'nspawn', op: 'start', machine: MACHINE }, { runner });
    await applyNspawnRequest({ domain: 'nspawn', op: 'stop', machine: MACHINE }, { runner });
    await applyNspawnRequest({ domain: 'nspawn', op: 'set-limits', machine: MACHINE,
      limits: { cpus: 0.75, memoryMb: 384, pidsLimit: 300 } }, { runner });
    expect(calls).toEqual([
      { file: '/usr/bin/systemctl', args: ['start', `elowen-machine@${MACHINE}.service`] },
      { file: '/usr/bin/systemctl', args: ['stop', `elowen-machine@${MACHINE}.service`] },
      { file: '/usr/bin/systemctl', args: ['set-property', `elowen-machine@${MACHINE}.service`, 'CPUQuota=75%', 'MemoryMax=384M', 'TasksMax=300'] },
    ]);
    expect(() => applyNspawnRequest({ domain: 'nspawn', op: 'set-limits', machine: MACHINE,
      limits: { cpus: 0, memoryMb: 384, pidsLimit: 300 } }, { runner })).toThrow(/limits are invalid/);
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

  it('passes the validated machine environment into every transient guest unit', () => {
    const args = nspawnExecArgs({ machine: MACHINE, unit: UNIT, argv: ['/usr/bin/printenv'], cwd: '/workspace',
      timeoutSeconds: 30, environment: { Z_LAST: 'two words', A_FIRST: 'literal$HOME' } });
    const separator = args.indexOf('--');
    expect(args.slice(0, separator).filter((value) => value.startsWith('--setenv='))).toEqual([
      '--setenv=A_FIRST=literal$HOME', '--setenv=Z_LAST=two words',
    ]);
    expect(() => nspawnExecArgs({ machine: MACHINE, unit: UNIT, argv: ['/bin/true'], cwd: '/', timeoutSeconds: 30,
      environment: { BROKEN: 'line one\nline two' } })).toThrow(/machine environment is invalid/);
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

  it('keeps the passwd HOME storage layout as the default', async () => {
    // An older install has no machine-storage receipt. Its path remains derived from the authenticated
    // service user's passwd HOME, and a runtime request still has no field that can move the root.
    const home = join(scratch, 'derived-home');
    const derived = storageRootsFor(home);
    const pluginDataDir = `${home}/.config/elowen/plugins-data`;
    expect(derived).toEqual({
      pluginDataDir,
      sandboxDataDir: `${pluginDataDir}/sandbox`,
      sitesDataDir: `${pluginDataDir}/sites`,
    });
    // The installer makes the same plugin-root derivation in code the standalone helper cannot import.
    expect(derived.pluginDataDir).toBe(siteGatewayPluginDataDir(home));

    expect(MACHINE_STORAGE_RECEIPT_PATH).toBe(SHARED_MACHINE_STORAGE_RECEIPT_PATH);

    // End to end, with no receipt or storage handed in: the roots follow the passwd home sudo reports and
    // nothing else, and an arbitrary host path is still refused.
    const runner = (file: string) => (file === '/usr/bin/getent'
      ? { ok: true, stdout: `azureuser:x:1000:1000::${home}:/bin/bash\n` }
      : { ok: true, stdout: '' });
    const doomed = join(derived.sandboxDataDir, 'projects', '54', 'stale');
    mkdirSync(doomed, { recursive: true });
    const noReceipt = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    await applyRequest({ domain: 'nspawn', op: 'tree-remove', path: doomed }, undefined, { runner, env: environment, lstat: noReceipt });
    expect(existsSync(doomed)).toBe(false);
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-remove', path: '/etc/systemd/nspawn' }, undefined, { runner, env: environment, lstat: noReceipt }))
      .rejects.toThrow(/outside the trusted storage roots/);
  });

  it('accepts a custom Sandbox root only from a root-provisioned machine storage receipt', async () => {
    const home = join(scratch, 'receipt-home');
    const pluginDataDir = join(scratch, 'custom-state', 'plugins-data');
    const sandboxDataDir = join(pluginDataDir, 'sandbox');
    const doomed = join(sandboxDataDir, 'projects', '54', 'stale');
    const siblingSite = join(pluginDataDir, 'sites', 'retained');
    mkdirSync(doomed, { recursive: true });
    mkdirSync(siblingSite, { recursive: true });
    const receiptPath = MACHINE_STORAGE_RECEIPT_PATH;
    const receipt = `${JSON.stringify({ pluginDataDir })}\n`;
    const runner = (file: string) => (file === '/usr/bin/getent'
      ? { ok: true, stdout: `azureuser:x:1000:1000::${home}:/bin/bash\n` }
      : { ok: true, stdout: '' });
    const lstat = (path: string) => ({
      uid: 0, gid: 0, mode: path === receiptPath ? 0o100644 : 0o040755,
      isSymbolicLink: () => false,
      isDirectory: () => path !== receiptPath,
      isFile: () => path === receiptPath,
    });

    const options = {
      runner, env: environment, lstat,
      readText: (path: string) => path === receiptPath ? receipt : '',
    };
    await applyRequest({ domain: 'nspawn', op: 'tree-remove', path: doomed }, undefined, options);

    expect(existsSync(doomed)).toBe(false);
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-remove', path: siblingSite }, undefined, options))
      .rejects.toThrow(/outside the trusted storage roots/);
    expect(existsSync(siblingSite)).toBe(true);
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-remove', path: '/etc/systemd/nspawn' }, undefined, options))
      .rejects.toThrow(/outside the trusted storage roots/);
  });

  it('fails closed on an unsafe or malformed machine storage receipt', async () => {
    const home = join(scratch, 'unsafe-receipt-home');
    const pluginDataDir = join(scratch, 'unsafe-receipt-state', 'plugins-data');
    const target = join(pluginDataDir, 'sandbox', 'projects', '54', 'stale');
    mkdirSync(target, { recursive: true });
    const runner = (file: string) => (file === '/usr/bin/getent'
      ? { ok: true, stdout: `azureuser:x:1000:1000::${home}:/bin/bash\n` }
      : { ok: true, stdout: '' });
    const attempt = (variant: 'owner' | 'mode' | 'symlink' | 'directory-symlink' | 'json') => applyRequest({
      domain: 'nspawn', op: 'tree-remove', path: target,
    }, undefined, {
      runner, env: environment,
      readText: () => variant === 'json' ? '{' : `${JSON.stringify({ pluginDataDir })}\n`,
      lstat: (path: string) => ({
        uid: variant === 'owner' && path === MACHINE_STORAGE_RECEIPT_PATH ? 1000 : 0,
        gid: 0,
        mode: path === MACHINE_STORAGE_RECEIPT_PATH
          ? (variant === 'mode' ? 0o100664 : 0o100644)
          : 0o040755,
        isSymbolicLink: () => variant === 'symlink' && path === MACHINE_STORAGE_RECEIPT_PATH
          || variant === 'directory-symlink' && path === dirname(MACHINE_STORAGE_RECEIPT_PATH),
        isDirectory: () => path !== MACHINE_STORAGE_RECEIPT_PATH,
        isFile: () => path === MACHINE_STORAGE_RECEIPT_PATH,
      }),
    });

    for (const variant of ['owner', 'mode', 'symlink', 'directory-symlink', 'json'] as const) {
      await expect(attempt(variant), variant).rejects.toThrow(/machine storage receipt/);
    }
    expect(existsSync(target)).toBe(true);
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
    for (const op of ['exec', 'freeze', 'thaw', 'tree-fingerprint', 'tree-preflight', 'tree-sizes', 'tree-verify', 'status']) {
      expect(helperRequestNeedsMutationLock({ domain: 'nspawn', op })).toBe(false);
    }
    for (const op of ['provision', 'materialize', 'write-envelope', 'shift-ownership', 'retire-legacy-site',
      'tree-copy', 'tree-sync', 'tree-remove', 'destroy', 'release-uid-range']) {
      expect(helperRequestNeedsMutationLock({ domain: 'nspawn', op })).toBe(true);
    }
    expect(helperRequestNeedsMutationLock({ op: 'status' })).toBe(false);
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
  it('recognizes the retired polkit grant and owns the machine unit template as repository content', () => {
    const retired = renderPolkitRule('azureuser');
    expect(retired).toContain('subject.user !== "azureuser"');
    expect(retired).toContain('verb === "start"');
    expect(() => renderPolkitRule('root')).toThrow();
    expect(() => renderPolkitRule('bad name')).toThrow();

    // The shipped systemd-nspawn@.service hardcodes /var/lib/machines/%i, which the disk layout does
    // not use, so the envelope is our own template with the directory taken from the per-machine drop-in.
    expect(MACHINE_UNIT_TEMPLATE).toContain('--directory=${ELOWEN_MACHINE_DIRECTORY}');
    expect(MACHINE_UNIT_TEMPLATE).toContain('--link-journal=no');
    expect(MACHINE_UNIT_TEMPLATE).toContain('--settings=trusted');
    // systemd 255 keeps the nspawn parent and container in this service unit. Port= is handled by nspawn's
    // own event loop and does not require a separate machine scope.
    expect(MACHINE_UNIT_TEMPLATE).toContain('--keep-unit');
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
    expect(settings).not.toContain('ResolvConf=');
    expect(renderMachineSettings([], { uidBase: 1_073_741_824, privateNetwork: false, resolverPath: '/run/systemd/resolve/resolv.conf' }))
      .toContain('BindReadOnly=/run/systemd/resolve/resolv.conf:/etc/resolv.conf');
    expect(settings).toContain('NoNewPrivileges=yes');
    expect(settings).toContain('CAP_SYS_PTRACE');
    expect(settings).toContain('Bind=/srv/sandbox/projects/54/disks/x/workspace:/demo:rootidmap');
    expect(settings).toContain('BindReadOnly=/srv/sandbox/projects/54/disks/x/home:/root:rootidmap');
    // The namespace is stated in both shapes rather than inferred from VirtualEthernet=, because the
    // failure mode of a lost implication is a machine sharing the host's network namespace outright.
    expect(settings).toContain('[Network]\nPrivate=yes\nVirtualEthernet=no');
    expect(renderMachineSettings([], { uidBase: 1_073_741_824, privateNetwork: false }))
      .toContain('[Network]\nPrivate=yes\nVirtualEthernet=yes');
    const published = renderMachineSettings([], { uidBase: 1_073_741_824, privateNetwork: false, ports: [
      { protocol: 'udp', hostPort: 5353, guestPort: 53 },
      { protocol: 'tcp', hostPort: 8080, guestPort: 3000 },
    ] });
    expect(published).toContain('Port=tcp:8080:3000\nPort=udp:5353:53');
    expect(() => renderMachineSettings([], { uidBase: 1_073_741_824, ports: [{ protocol: 'tcp', hostPort: 8080, guestPort: 3000 }] }))
      .toThrow(/loopback-only machine cannot publish/);
    expect(() => renderMachineSettings([], { uidBase: 1_073_741_824, privateNetwork: false, ports: [{ protocol: 'tcp', hostPort: 80, guestPort: 80 }] }))
      .toThrow(/inbound port is invalid/);
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
        'polkit:machines', 'unit:elowen-machine', 'unit:elowen-machine-firewall']);
    expect(rowFor(missing, 'unit:elowen-machine').detail).toBe('missing — run environment provisioning to restore it');
    // Status only ever reads.
    expect(fixture.writes).toEqual([]);

    const provisioned = await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options) as Readiness;
    expect(provisioned.ready).toBe(true);
    expect(fixture.writes.map((write) => write.path)).toEqual([MACHINE_UNIT_PATH, MACHINE_FIREWALL_UNIT_PATH]);
    expect(fixture.writes.every((write) => write.mode === 0o644)).toBe(true);
    expect(fixture.calls).toContainEqual({ file: '/usr/bin/apt-get', args: ['update'] });
    expect(fixture.calls).toContainEqual({ file: '/usr/bin/apt-get', args: ['install', '--yes', '--no-install-recommends', 'systemd-container'] });
    // One reload for the unit template and one for the firewall unit written after it: a reload that ran
    // before a file existed cannot have read it.
    expect(reloads(fixture.calls)).toBe(2);
    expect(rowFor(provisioned, 'unit:elowen-machine').detail).toBe('installed and loaded');
    expect(rowFor(provisioned, 'polkit:machines').detail).toContain('lifecycle mutations use the privileged helper');

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
    // Provisioning and trusted storage roots are bound to this account, so a request whose sudo variables
    // disagree with passwd is refused rather than resolved to whatever passwd happens to say.
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
    expect(fixture.writes.map((write) => write.path)).toEqual([MACHINE_UNIT_PATH, MACHINE_FIREWALL_UNIT_PATH]);
    expect(rowFor(provisioned, 'polkit:machines').detail).toContain('lifecycle mutations use the privileged helper');

    // Root still has to say which account it means; nothing is guessed from the host.
    await expect(applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, { ...fixture.options, env: rootShell }))
      .rejects.toThrow(/requires naming the service account/);
    // The service account may not name another account: sudo already states the provisioning owner.
    await expect(applyRequest({ domain: 'nspawn', op: 'status', user: 'somebody-else' }, undefined, fixture.options))
      .rejects.toThrow(/does not match the invoking account/);
    // And the default plugin root still comes from the account sudo reports, from nothing a request carries.
    expect(helperRequestNeedsDeployment({ domain: 'nspawn', op: 'provision', user: 'azureuser' })).toBe(false);
    expect(storageRootsFor('/home/azureuser').pluginDataDir).toBe(siteGatewayPluginDataDir('/home/azureuser'));
  });

  it('removes only the exact retired polkit grant and still repairs a drifted unit', async () => {
    const fixture = runnerFixture({ polkit: renderPolkitRule('azureuser') });
    const retired = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, fixture.options) as Readiness;
    expect(rowFor(retired, 'polkit:machines').detail).toContain('retired broad lifecycle rule');

    const provisioned = await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options) as Readiness;
    expect(provisioned.ready).toBe(true);
    expect(fixture.state.polkit).toBe('');
    const baseline = reloads(fixture.calls);

    const unmanaged = runnerFixture({ polkit: `${renderPolkitRule('azureuser')}// widened by hand\n` });
    const reported = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, unmanaged.options) as Readiness;
    expect(rowFor(reported, 'polkit:machines').detail).toContain('unmanaged file');
    await expect(applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, unmanaged.options))
      .rejects.toThrow(/unmanaged content/);
    expect(unmanaged.state.polkit).toContain('widened by hand');

    fixture.state.unit = '[Unit]\nDescription=Elowen machine %i\n[Service]\nExecStart=systemd-nspawn --boot\n';
    const repaired = await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options) as Readiness;
    expect(repaired.ready).toBe(true);
    expect(fixture.state.unit).toBe(MACHINE_UNIT_TEMPLATE);
    expect(reloads(fixture.calls)).toBe(baseline + 1);
  });

  it('treats the permission bits as part of a managed artefact', async () => {
    const fixture = runnerFixture();
    await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options);
    fixture.state.unitMode = 0o664;
    const loose = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, fixture.options) as Readiness;
    expect(rowFor(loose, 'unit:elowen-machine')).toMatchObject({ ok: false, detail: 'mode is 0664 where 0644 is required — run environment provisioning to restore it' });

    const repaired = await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options) as Readiness;
    expect(repaired.ready).toBe(true);
    expect(fixture.state.unitMode).toBe(0o644);
  });

  it('reloads a unit template the manager has never read, even when the file on disk is already right', async () => {
    // The state a provisioning run interrupted between the write and the reload leaves behind, and the
    // state a restored backup leaves behind. The file compares equal, and the machine still cannot start.
    const fixture = runnerFixture({
      unit: MACHINE_UNIT_TEMPLATE, unitLoaded: false,
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
      'polkit:machines', 'unit:elowen-machine', 'unit:elowen-machine-firewall',
      'net:ip-forward', 'service:systemd-networkd', 'resolver:uplink', ...NSPAWN_FIREWALL_RULES.map((rule: { id: string }) => rule.id),
    ]);

    // Every detail has to carry the command, because nobody reading a false row has the rule memorized.
    expect(rowFor(reported, 'net:ip-forward').detail).toContain('sysctl -w net.ipv4.ip_forward=1');
    expect(rowFor(reported, 'service:systemd-networkd').detail).toContain('systemctl enable --now systemd-networkd');
    for (const rule of NSPAWN_FIREWALL_RULES) {
      expect(rowFor(reported, rule.id).detail).toContain(firewallRuleCommand(rule));
    }

    // Serving a request never mutates the packet filter: it reads the ordered chain rules only.
    const served = fixture.calls.filter((call) => call.file.endsWith('tables'));
    expect(served.length).toBeGreaterThan(0);
    expect(served.every((call) => call.args[0] === '-S')).toBe(true);

    // Provisioning is the operator-invoked path, and it does act: the unit is installed, enabled so the
    // rules come back after a reboot, and started so they are in place now. It still touches the tables
    // only through that unit.
    const applied = await applyRequest({ domain: 'nspawn', op: 'provision', veth: true }, undefined, fixture.options) as Readiness;
    expect(fixture.state.firewallUnit).toBe(MACHINE_FIREWALL_UNIT);
    expect(fixture.calls).toContainEqual({ file: '/usr/bin/systemctl', args: ['enable', '--now', MACHINE_FIREWALL_UNIT_NAME] });
    expect(fixture.calls.filter((call) => call.file.endsWith('tables')).every((call) => call.args[0] === '-S')).toBe(true);
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


  it('provisions forwarding on a host where Docker and its private chain are absent', async () => {
    const fixture = runnerFixture({ firewall: false, firewallEnabled: false, dockerChain: false });

    const applied = await applyRequest({ domain: 'nspawn', op: 'provision', veth: true }, undefined, fixture.options) as Readiness;

    expect(applied.ready, applied.items.filter((item) => !item.ok).map((item) => `${item.id}: ${item.detail}`).join('; ')).toBe(true);
    const forwarding = NSPAWN_FIREWALL_RULES.filter((rule) => rule.id === 'firewall:forward-out' || rule.id === 'firewall:forward-back');
    expect(forwarding.map((rule) => rule.chain)).toEqual(['FORWARD', 'FORWARD']);
    expect(fixture.calls.filter((call) => call.file === '/usr/sbin/iptables' && call.args[0] === '-S')
      .every((call) => call.args[1] !== 'DOCKER-USER')).toBe(true);
    const retiredDockerCommands = MACHINE_FIREWALL_UNIT.split('\n').filter((line) => line.includes('DOCKER-USER'));
    expect(retiredDockerCommands).toHaveLength(4);
    expect(retiredDockerCommands.every((line) => line.includes(' -D DOCKER-USER ') && !line.includes(' -I DOCKER-USER '))).toBe(true);
  });

  it('names both directions of forwarding, because a machine that only sends looks like a DNS fault', () => {
    // A request leaves through the machine link and its reply returns to it. Both rules live directly in
    // the native chain so a host does not need Docker's private chain, and fixed leading positions keep a
    // framework jump or host DROP rule from intercepting either direction first.
    const forwarding = NSPAWN_FIREWALL_RULES.filter((rule: { chain: string }) => rule.chain === 'FORWARD');
    expect(forwarding.map((rule: { id: string }) => rule.id)).toEqual(['firewall:forward-out', 'firewall:forward-back']);
    expect(forwarding.map((rule) => rule.insertAt)).toEqual([1, 2]);
    expect(forwarding.map((rule) => firewallRuleCommand(rule)).every((command) => command.includes('--comment elowen-machine-'))).toBe(true);
    // The return path is conntrack-scoped, so it opens nothing a machine did not ask for first.
    expect(forwarding[1]!.spec).toContain('RELATED,ESTABLISHED');
  });

  it('puts the host guard where a machine-to-host packet actually arrives', () => {
    // The plan first placed this guard in FORWARD. A packet a machine sends to an address the host holds
    // is delivered locally, so the routing decision hands it to INPUT and a FORWARD rule never sees it.
    //
    // Native nspawn DNAT keeps its own nftables map, but replies to a host-originated connection return
    // from the machine link through INPUT. Admit only conntrack replies before the blanket host guard, so
    // the declared port works without opening SSH or any other NEW machine-to-host connection.
    const returns = NSPAWN_FIREWALL_RULES.filter((rule) => rule.id.startsWith('firewall:host-return'));
    expect(returns).toHaveLength(2);
    expect(returns.every((rule) => rule.chain === 'INPUT' && rule.spec.includes('RELATED,ESTABLISHED'))).toBe(true);
    expect(returns.map((rule) => rule.binary)).toEqual(['/usr/sbin/iptables', '/usr/sbin/ip6tables']);
    const guards = NSPAWN_FIREWALL_RULES.filter((rule) => rule.spec.includes('DROP'));
    expect(guards).toHaveLength(2);
    expect(guards.every((rule) => rule.chain === 'INPUT')).toBe(true);
    expect(guards.map((rule) => rule.binary)).toEqual(['/usr/sbin/iptables', '/usr/sbin/ip6tables']);
    // IPv4 DHCP is first, then the native-port return path and guard. IPv6 starts with return then guard.
    const lease = NSPAWN_FIREWALL_RULES.find((rule) => rule.id === 'firewall:machine-dhcp')!;
    expect(lease.spec.join(' ')).toContain('-p udp -m udp --dport 67');
    expect(lease.insertAt).toBe(1);
    expect(returns.map((rule) => rule.insertAt)).toEqual([2, 1]);
    expect(guards.map((rule) => rule.insertAt)).toEqual([3, 2]);
    expect([...returns, ...guards].every((rule) => firewallRuleCommand(rule).includes('-I INPUT'))).toBe(true);
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
          if ((file === '/usr/sbin/iptables' || file === '/usr/sbin/ip6tables') && args[0] === '-S') {
            const rules = NSPAWN_FIREWALL_RULES
              .filter((rule) => rule.binary === file && rule.chain === args[1])
              .sort((left, right) => left.insertAt - right.insertAt)
              .map((rule) => `-A ${rule.chain} ${rule.spec.join(' ')}`);
            return { ok: true, stdout: `${rules.join('\n')}\n` };
          }
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
      if (path === '/run/systemd/resolve/resolv.conf') return 'nameserver 192.0.2.53\n';
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

    // Site environments are dormant, but their historical allocations must keep parsing so one retained
    // entry cannot make the whole root-owned registry unreadable for active Project environments.
    const historicalSite = { 'site:retired-site': UID_RANGE_BASE, [`site:retired-site:${'a'.repeat(32)}`]: UID_RANGE_BASE };
    writeFileSync(registryPath, `${JSON.stringify(historicalSite)}\n`, { mode: 0o600 });
    expect(readUidRangeRegistry(registryPath)).toEqual(historicalSite);

    const broken = [
      '{"project:54":',
      '[]',
      JSON.stringify({ 'project:54': UID_RANGE_BASE, 'project:55': UID_RANGE_BASE }),
      JSON.stringify({ 'project:54': UID_RANGE_BASE, [`project:54:${'a'.repeat(32)}`]: UID_RANGE_BASE + 65_536 }),
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

  it('releases only a fully deleted environment range and all of its old disk aliases', async () => {
    const rangesPath = '/var/lib/elowen/nspawn-uid-ranges.json';
    const registry: Record<string, number> = {
      'project:61': UID_RANGE_BASE,
      [`project:61:${'a'.repeat(32)}`]: UID_RANGE_BASE,
      'project:62': UID_RANGE_BASE + 65_536,
    };
    const writeAtomic = (path: string, content: Buffer) => {
      expect(path).toBe(rangesPath);
      for (const key of Object.keys(registry)) delete registry[key];
      Object.assign(registry, JSON.parse(content.toString('utf8')));
    };
    const request = { domain: 'nspawn', op: 'release-uid-range', namespace: 'elowen', kind: 'project', resource: '61' };
    const options = { storage, readUidRanges: () => ({ ...registry }), writeAtomic, exists: () => false };

    await expect(applyRequest(request, undefined, { ...options,
      readDir: (path: string) => path === '/etc/systemd/nspawn' ? ['elowen-project-61-g4.nspawn'] : [],
    })).rejects.toThrow(/machine envelope still exists/);
    await expect(applyRequest(request, undefined, { ...options,
      readDir: (path: string) => path === '/etc/systemd/system' ? ['elowen-machine@elowen-project-61-g4.service.d'] : [],
    })).rejects.toThrow(/machine drop-in still exists/);
    expect(registry).toHaveProperty('project:61');

    await applyRequest(request, undefined, { ...options, readDir: () => [] });
    expect(registry).toEqual({ 'project:62': UID_RANGE_BASE + 65_536 });
    await expect(applyRequest(request, undefined, { ...options, readDir: () => [] })).resolves.toMatchObject({ ok: true });

    await expect(applyRequest({ ...request, resource: '62' }, undefined, {
      ...options, exists: (path: string) => path.endsWith('/projects/62'), readDir: () => [],
    })).rejects.toThrow(/storage still exists/);
    expect(registry).toEqual({ 'project:62': UID_RANGE_BASE + 65_536 });
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

  it('still refuses a target that would climb out of its mount point', () => {
    expect(safeGuestMountTarget('/workspace/.git')).toBe(true);
    expect(safeGuestMountTarget('/run/elowen')).toBe(true);
    expect(safeGuestMountTarget('/workspace')).toBe(true);
    for (const bad of ['workspace', '/..', '/workspace/..', '/./etc', '/workspace/.git/objects', '/Workspace', '/work space', '/etc\u0000']) {
      expect(safeGuestMountTarget(bad), bad).toBe(false);
    }
  });

  it('refuses to rewrite the envelope while its machine is active', async () => {
    const fixture = diskFixture();
    const runner = (file: string, args: string[]) => file === '/usr/bin/systemctl' && args[0] === 'show' && args.includes('ActiveState')
      ? { ok: true, stdout: 'active\n' }
      : fixture.options.runner(file, args);
    await expect(applyRequest({ domain: 'nspawn', op: 'write-envelope', ...diskRef,
      limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 }, binds: [], ports: [], dropCapabilities: [], privateNetwork: true,
    }, undefined, { ...fixture.options, runner })).rejects.toThrow(/must be stopped before its envelope is rewritten/);
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

describe('privileged helper: legacy Site retirement', () => {
  function legacySiteFixture(customPluginData = false) {
    const home = join(scratch, `legacy-site-${randomUUID()}`);
    const resource = 'retired-site';
    const generation = 4;
    const diskId = 'b'.repeat(32);
    const machine = `elowen-site-${resource}-g${generation}`;
    const unit = `elowen-machine@${machine}.service`;
    const pluginDataDir = customPluginData
      ? join(scratch, `legacy-custom-state-${randomUUID()}`, 'plugins-data')
      : join(home, '.config', 'elowen', 'plugins-data');
    const sitesDataDir = join(pluginDataDir, 'sites');
    const directory = join(sitesDataDir, resource, 'environment', 'disks', diskId);
    const rootfs = join(directory, 'rootfs');
    const identityPath = join(directory, '.elowen', 'identity.json');
    const snapshot = join(sitesDataDir, resource, 'environment', 'snapshots', 'kept', 'manifest.json');
    const backup = join(sitesDataDir, resource, 'backups', 'kept.tar');
    const nspawnSettingsRoot = join(home, 'nspawn');
    const systemdRoot = join(home, 'systemd');
    const machineUnitPath = join(home, 'elowen-machine@.service');
    const settingsPath = join(nspawnSettingsRoot, `${machine}.nspawn`);
    const dropInPath = join(systemdRoot, `elowen-machine@${machine}.service.d`, '10-elowen.conf');
    for (const path of [rootfs, dirname(identityPath), dirname(snapshot), dirname(backup), dirname(settingsPath), dirname(dropInPath)]) {
      mkdirSync(path, { recursive: true });
    }
    const settings = '[Exec]\nPrivateUsers=1073741824:65536\n';
    const dropIn = `[Service]\nEnvironment=ELOWEN_MACHINE_DIRECTORY=${rootfs}\n`;
    writeFileSync(settingsPath, settings, { mode: 0o644 });
    writeFileSync(dropInPath, dropIn, { mode: 0o644 });
    writeFileSync(snapshot, '{}');
    writeFileSync(backup, 'backup');
    writeFileSync(identityPath, JSON.stringify({ namespace: 'elowen', kind: 'site', resource, generation, diskId, machine,
      runtime: 'nspawn', specHash: 'd'.repeat(64), uidBase: UID_RANGE_BASE, uidSize: 65_536 }), { mode: 0o640 });
    const expectedId = createHash('sha256').update(JSON.stringify(['elowen', machine, diskId, rootfs, settings, dropIn])).digest('hex');
    const calls: Call[] = [];
    const runner = (file: string, args: string[]) => {
      calls.push({ file, args });
      if (file === '/usr/bin/getent') return { ok: true, stdout: `azureuser:x:1000:1000::${home}:/bin/bash\n` };
      if (file === '/usr/bin/machinectl') return { ok: true, stdout: `Unit=${unit}\nRootDirectory=${rootfs}\n` };
      if (file === '/usr/bin/systemctl' && args[0] === 'show') {
        if (!existsSync(settingsPath)) return { ok: true, stdout: 'LoadState=not-found\nActiveState=inactive\n' };
        return { ok: true, stdout: `LoadState=loaded\nFragmentPath=${machineUnitPath}\nDropInPaths=${dropInPath}\nEnvironment=ELOWEN_MACHINE_DIRECTORY=${rootfs}\nActiveState=active\n` };
      }
      return { ok: true, stdout: '' };
    };
    const request = { domain: 'nspawn', op: 'retire-legacy-site', resource, generation, diskId, expectedId };
    const options = { env: environment, runner, nspawnSettingsRoot, systemdRoot, machineUnitPath,
      readText: (path: string) => path === MACHINE_STORAGE_RECEIPT_PATH
        ? `${JSON.stringify({ pluginDataDir })}\n`
        : readFileSync(path, 'utf8'),
      lstat: (path: string) => {
        if (!customPluginData && path === MACHINE_STORAGE_RECEIPT_PATH) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { uid: 0, gid: 0, mode: path === MACHINE_STORAGE_RECEIPT_PATH ? 0o100644 : 0o040755,
          isSymbolicLink: () => false, isDirectory: () => path !== MACHINE_STORAGE_RECEIPT_PATH, isFile: () => path === MACHINE_STORAGE_RECEIPT_PATH };
      },
      readOwner: (path: string) => path === rootfs ? UID_RANGE_BASE : 0 };
    return { request, options, calls, settingsPath, dropInPath, rootfs, identityPath, snapshot, backup, machine, unit, home, pluginDataDir, sitesDataDir };
  }

  it('retires a legacy Site from the custom receipt sites root rather than passwd HOME', async () => {
    const fixture = legacySiteFixture(true);

    await expect(applyRequest(fixture.request, undefined, fixture.options)).resolves.toMatchObject({
      machine: fixture.machine, retired: true,
    });
    expect(fixture.rootfs.startsWith(`${fixture.pluginDataDir}/sites/`)).toBe(true);
    expect(fixture.rootfs.startsWith(`${fixture.home}/.config/elowen/plugins-data/sites/`)).toBe(false);
  });

  it('stops and retires one owned legacy Site envelope exactly once without touching retained data', async () => {
    const fixture = legacySiteFixture();

    await expect(applyRequest(fixture.request, undefined, fixture.options)).resolves.toMatchObject({
      machine: fixture.machine, unit: fixture.unit, retired: true, alreadyRetired: false,
    });
    expect(existsSync(fixture.settingsPath)).toBe(false);
    expect(existsSync(fixture.dropInPath)).toBe(false);
    for (const path of [fixture.rootfs, fixture.identityPath, fixture.snapshot, fixture.backup]) expect(existsSync(path), path).toBe(true);

    await expect(applyRequest(fixture.request, undefined, fixture.options)).resolves.toMatchObject({
      machine: fixture.machine, retired: false, alreadyRetired: true,
    });
    expect(fixture.calls.filter((call) => call.file === '/usr/bin/systemctl' && call.args[0] === 'stop')).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.file === '/usr/bin/systemctl' && call.args[0] === 'daemon-reload')).toHaveLength(1);
  });

  it('refuses to stop a legacy Site machine whose root-owned envelope does not match the persisted binding', async () => {
    const fixture = legacySiteFixture();
    await expect(applyRequest({ ...fixture.request, expectedId: 'f'.repeat(64) }, undefined, fixture.options))
      .rejects.toThrow(/envelope binding does not match/);
    expect(fixture.calls.some((call) => call.file === '/usr/bin/systemctl' && call.args[0] === 'stop')).toBe(false);
    expect(existsSync(fixture.settingsPath)).toBe(true);
    expect(existsSync(fixture.dropInPath)).toBe(true);
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

  it('measures a bounded disk batch with one short read-only command', async () => {
    const directory = nspawnDiskPaths(storage, diskRef).directory;
    const paths = [join(directory, 'rootfs'), join(directory, 'home')];
    for (const path of paths) mkdirSync(path, { recursive: true });
    const calls: { file: string; args: string[]; timeoutMs?: number }[] = [];
    const runner = (file: string, args: string[], options: { timeoutMs?: number } = {}) => {
      calls.push({ file, args, timeoutMs: options.timeoutMs });
      return { ok: true, stdout: `4096\t${paths[0]}\u00004096\t${paths[1]}\u0000`, stderr: '' };
    };
    expect(await applyRequest({ domain: 'nspawn', op: 'tree-sizes', paths }, undefined, { storage, runner })).toEqual({
      ok: true,
      usages: [{ path: paths[0], allocatedBytes: 4096 }, { path: paths[1], allocatedBytes: 4096 }],
    });
    expect(calls).toEqual([{
      file: '/usr/bin/du',
      args: ['--summarize', '--one-file-system', '--block-size=1', '--null', '--', ...paths],
      timeoutMs: RESOURCE_USAGE_TIMEOUT_MS,
    }]);
    expect(RESOURCE_USAGE_TIMEOUT_MS).toBe(15_000);
    const partial = await applyRequest({ domain: 'nspawn', op: 'tree-sizes', paths }, undefined, {
      storage,
      runner: () => ({ ok: false, stdout: `4096\t${paths[0]}\u0000`, stderr: 'second path disappeared' }),
    });
    expect(partial).toEqual({ ok: true, usages: [{ path: paths[0], allocatedBytes: 4096 }, { path: paths[1], error: 'unavailable' }] });
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-sizes', paths: Array.from({ length: 1001 }, () => paths[0]) }, undefined, { storage, runner }))
      .rejects.toThrow(/disk usage batch is invalid/);
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
      'tree-copy', 'tree-fingerprint', 'tree-preflight', 'tree-remove', 'tree-sizes', 'tree-sync',
      'tree-verify', 'destroy', 'release-uid-range', 'retire-legacy-site']) {
      expect(helperRequest(op, {})).toEqual({ domain: 'nspawn', op });
      let refusal = '';
      try { applyNspawnRequest({ domain: 'nspawn', op }, { storage }); } catch (error) { refusal = String(error); }
      expect(refusal, `${op} must be answered by the machine domain`).not.toMatch(/operation is not supported/);
    }
  });
});
