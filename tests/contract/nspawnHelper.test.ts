import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  MACHINE_UNIT_TEMPLATE,
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
  storageRootsFrom,
  trustedPath,
} from '../../scripts/elowen-site-gateway.mjs';
// @ts-expect-error the bundled Sandbox plugin is plain ESM without declarations
import { createEnvironmentDiskSpec } from '../../plugins/sandbox/lib/containerSpec.mjs';
// @ts-expect-error the bundled machine runtime is plain ESM without declarations
import { HELPER_PATH as PLUGIN_HELPER_PATH, helperRequest } from '../../plugins/sandbox/lib/nspawn.mjs';
import { NSPAWN_HELPER_ARGV, NSPAWN_HELPER_PATH, NSPAWN_MACHINE_PATTERN, nspawnMachineUnit } from '../../src/shared/nspawnRuntime.js';
import { encodeHelperRequest, HELPER_FRAME_HEADER_BYTES } from '../../src/shared/siteGateway.js';

const HELPER_SOURCE = fileURLToPath(new URL('../../scripts/elowen-site-gateway.mjs', import.meta.url));
const PODMAN_SOURCE = fileURLToPath(new URL('../../plugins/sandbox/lib/podman.mjs', import.meta.url));
const PLUGIN_RUNTIME = fileURLToPath(new URL('../../plugins/sandbox/lib/nspawn.mjs', import.meta.url));

const MACHINE = 'elowen-project-54-g3';
const UNIT = `elowen-exec-g3-${'a'.repeat(32)}.service`;
const environment = { SUDO_USER: 'azureuser', SUDO_UID: '1000', SUDO_GID: '1000' };
const scratch = mkdtempSync(join(tmpdir(), 'elowen-nspawn-contract-'));
const storage = storageRootsFrom({
  storage: { sandboxDataDir: join(scratch, 'sandbox'), sitesDataDir: join(scratch, 'sites') },
});
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

function runnerFixture(options: { installed?: boolean; polkit?: string; unit?: string; firewall?: boolean } = {}) {
  const calls: Call[] = [];
  const writes: { path: string; content: string; mode: number }[] = [];
  const state = {
    installed: options.installed ?? true,
    polkit: options.polkit ?? '',
    unit: options.unit ?? '',
    firewall: options.firewall ?? false,
  };
  const readText = (path: string) => {
    if (path === '/etc/os-release') return 'ID=ubuntu\n';
    if (path === POLKIT_RULE_PATH) return state.polkit;
    if (path === MACHINE_UNIT_PATH) return state.unit;
    return '';
  };
  const writeAtomic = (path: string, content: Buffer, mode: number) => {
    const value = content.toString('utf8');
    writes.push({ path, content: value, mode });
    if (path === POLKIT_RULE_PATH) state.polkit = value;
    if (path === MACHINE_UNIT_PATH) state.unit = value;
  };
  const runner = (file: string, args: string[]) => {
    calls.push({ file, args: [...args] });
    if (file === '/usr/bin/getent') return { ok: true, stdout: 'azureuser:x:1000:1000::/home/azureuser:/bin/bash\n' };
    if (file === '/usr/bin/dpkg-query') return state.installed ? { ok: true, stdout: 'install ok installed\n' } : { ok: false, stderr: 'not installed' };
    if (file === '/usr/sbin/iptables') return state.firewall ? { ok: true, stdout: '' } : { ok: false, stderr: 'No chain/target/match' };
    if (file === '/usr/bin/apt-get') { state.installed = true; return { ok: true, stdout: '' }; }
    if (file === '/usr/bin/systemctl') return { ok: true, stdout: '' };
    return { ok: false, stderr: `unexpected command: ${file} ${args.join(' ')}` };
  };
  return { calls, writes, runner, readText, writeAtomic, options: { runner, readText, writeAtomic, env: environment } };
}

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
    expect(nspawnMachineUnit(MACHINE)).toBe(machineUnitFor(MACHINE));
    expect(machineUnitFor('elowen-site-1e5b2c-g12')).toBe('elowen-machine@elowen-site-1e5b2c-g12.service');
    for (const bad of ['../etc/passwd', 'elowen-project-54', 'other-project-54-g1', 'elowen-project-54-g3/x',
      'elowen-project-54-g3.service', 'elowen-project-UPPER-g1', `elowen-project-${'a'.repeat(65)}-g1`]) {
      expect(() => machineUnitFor(bad)).toThrow(/machine name is invalid/);
      expect(NSPAWN_MACHINE_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('privileged helper: execution', () => {
  it('builds the systemd-run option list itself and appends the guest argv after the separator', () => {
    const args = nspawnExecArgs({ machine: MACHINE, unit: UNIT, argv: ['/bin/sh', '-c', 'echo hi'], cwd: '/workspace', timeoutSeconds: 120 });
    expect(args).toEqual([
      '-M', MACHINE, '--quiet', '--pipe', '--wait', '--collect', `--unit=${UNIT}`,
      '--service-type=exec', '--property=KillMode=control-group', '--property=TimeoutStopSec=5s',
      '--property=TasksMax=infinity', '--property=RuntimeMaxSec=120s', '--working-directory=/workspace',
      '--', '/bin/sh', '-c', 'echo hi',
    ]);
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
      { resource: { kind: 'project', id: Number(diskRef.resource) }, image: 'localhost/elowen-project-base:1' },
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

  it('refuses a request that tries to name a root or an id of its own', () => {
    expect(() => storageRootsFrom({ appHost: 'agent.example.com' })).toThrow(/no trusted storage roots/);
    expect(() => storageRootsFrom({ storage: { sandboxDataDir: 'relative', sitesDataDir: '/srv/sites' } })).toThrow(/storage root is invalid/);
    expect(() => storageRootsFrom({ storage: { sandboxDataDir: '/srv/../etc', sitesDataDir: '/srv/sites' } })).toThrow(/storage root is invalid/);
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
    expect(NSPAWN_HELPER_PATH).toBe('/usr/local/libexec/elowen-site-gateway');
  });
});

describe('privileged helper: host artefacts and readiness', () => {
  it('owns the polkit rule and the unit template as repository content', () => {
    const rule = renderPolkitRule('azureuser');
    expect(rule).toContain('subject.user !== "azureuser"');
    expect(rule).toContain('action.id !== "org.freedesktop.systemd1.manage-units"');
    expect(rule).toContain('unit.indexOf("elowen-machine@elowen-") !== 0');
    for (const verb of ['start', 'stop', 'restart', 'set-property']) expect(rule).toContain(`verb === "${verb}"`);
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
    expect(settings).toContain('[Network]\nPrivate=yes');
    expect(renderMachineSettings([], { uidBase: 1_073_741_824, privateNetwork: false })).toContain('VirtualEthernet=yes');
    expect(() => renderMachineSettings([], { uidBase: 1000 })).toThrow(/uid range is invalid/);

    const dropIn = renderMachineDropIn('/srv/sandbox/projects/54/disks/x/rootfs', { cpus: 0.75, memoryMb: 384, pidsLimit: 300 }, 1_073_741_824);
    expect(dropIn).toContain('Environment=ELOWEN_MACHINE_DIRECTORY=/srv/sandbox/projects/54/disks/x/rootfs');
    expect(dropIn).toContain('CPUQuota=75%');
    expect(dropIn).toContain('MemoryMax=384M');
    expect(dropIn).toContain('TasksMax=300');
  });

  it('reports the host artefacts it installs, and reports the firewall without ever touching it', async () => {
    const fixture = runnerFixture({ installed: false });
    const missing = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, fixture.options) as { ready: boolean; items: { id: string; ok: boolean }[] };
    expect(missing.ready).toBe(false);
    expect(missing.items.map((item) => item.id)).toEqual(['os:supported', 'package:systemd-container', 'polkit:machines', 'unit:elowen-machine']);
    expect(fixture.writes).toEqual([]);

    const provisioned = await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options) as { ready: boolean };
    expect(provisioned.ready).toBe(true);
    expect(fixture.writes.map((write) => write.path)).toEqual([POLKIT_RULE_PATH, MACHINE_UNIT_PATH]);
    expect(fixture.calls).toContainEqual({ file: '/usr/bin/apt-get', args: ['install', '--yes', '--no-install-recommends', 'systemd-container'] });
    expect(fixture.calls).toContainEqual({ file: '/usr/bin/systemctl', args: ['daemon-reload'] });

    // Converges: a second provision writes nothing more.
    const writesBefore = fixture.writes.length;
    await applyRequest({ domain: 'nspawn', op: 'provision' }, undefined, fixture.options);
    expect(fixture.writes).toHaveLength(writesBefore);
  });

  it('adds the two named firewall rows only when veth is requested, and refuses rather than applying them', async () => {
    const fixture = runnerFixture({ firewall: false });
    const without = await applyRequest({ domain: 'nspawn', op: 'status' }, undefined, fixture.options) as { items: { id: string }[] };
    expect(without.items.some((item) => item.id.startsWith('firewall:'))).toBe(false);

    const withVeth = await applyRequest({ domain: 'nspawn', op: 'provision', veth: true }, undefined, fixture.options) as { ready: boolean; items: { id: string; ok: boolean; detail: string }[] };
    expect(withVeth.ready).toBe(false);
    expect(withVeth.items.filter((item) => item.id.startsWith('firewall:')).map((item) => item.id))
      .toEqual(NSPAWN_FIREWALL_RULES.map((rule: { id: string }) => rule.id));
    expect(withVeth.items.find((item) => item.id === 'firewall:docker-user')?.detail).toContain('iptables -I DOCKER-USER -i ve-+ -j ACCEPT');
    // The daemon never mutates the firewall: the only iptables calls are the `-C` existence checks.
    const iptables = fixture.calls.filter((call) => call.file === '/usr/sbin/iptables');
    expect(iptables.length).toBeGreaterThan(0);
    expect(iptables.every((call) => call.args[0] === '-C')).toBe(true);
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
  // sudo matches arguments positionally, so the argv the daemon spawns, the argv the bundled runtime
  // spawns and the argv the drop-in pins have to be one thing. They live in three files that cannot
  // import each other, which is exactly why this pin exists.
  it('holds the daemon, the bundled runtime and the sudoers line to the same argv', () => {
    const sudoers = readFileSync(fileURLToPath(new URL('../../src/cli/install/systemdUnits.ts', import.meta.url)), 'utf8');
    const grant = sudoers.split('\n').filter((line) => line.includes('SITE_GATEWAY_HELPER_PATH}') && line.includes('NOPASSWD'));
    expect(grant).toHaveLength(1);
    expect(grant[0]).toContain('${SITE_GATEWAY_HELPER_PATH} ""');

    expect(NSPAWN_HELPER_ARGV).toEqual(['-n', NSPAWN_HELPER_PATH, '']);
    expect(PLUGIN_HELPER_PATH).toBe(NSPAWN_HELPER_PATH);
    expect(readFileSync(PLUGIN_RUNTIME, 'utf8'), 'the bundled machine runtime must spawn the pinned argv')
      .toContain("['-n', this.#helperPath, '']");
    expect(readFileSync(fileURLToPath(new URL('../../src/privileged/nspawnRuntime.ts', import.meta.url)), 'utf8'),
      'the daemon-side control must spawn the pinned argv rather than composing its own')
      .toContain("spawn('sudo', [...NSPAWN_HELPER_ARGV]");
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
    expect(NSPAWN_HELPER_PATH).toBe('/usr/local/libexec/elowen-site-gateway');
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
