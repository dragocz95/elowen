import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  nspawnComponentPath,
  nspawnDiskPaths,
  nspawnExecArgs,
  renderMachineDropIn,
  renderMachineSettings,
  renderPolkitRule,
  storageRootsFrom,
} from '../../scripts/elowen-site-gateway.mjs';
// @ts-expect-error the bundled Sandbox plugin is plain ESM without declarations
import { createEnvironmentDiskSpec } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { NSPAWN_HELPER_PATH, NSPAWN_MACHINE_PATTERN, nspawnMachineUnit } from '../../src/shared/nspawnRuntime.js';
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
const diskRef = { resource: { kind: 'project', id: 54 }, diskId: 'a'.repeat(32) };

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
  it('derives every path from the trusted roots and mirrors the runtime disk layout', () => {
    const paths = nspawnDiskPaths(storage, diskRef);
    const spec = createEnvironmentDiskSpec(
      { resource: diskRef.resource, image: 'localhost/elowen-project-base:1' },
      { sandboxDataDir: storage.sandboxDataDir, namespace: 'elowen' },
      diskRef.diskId,
    );
    expect(paths.rootfs).toBe(spec.rootfsPath);
    for (const component of spec.components) {
      expect(nspawnComponentPath(paths, component.component)).toBe(component.path);
    }
    const migrated = nspawnDiskPaths(storage, { ...diskRef, componentGeneration: 7 });
    const migratedSpec = createEnvironmentDiskSpec(
      { resource: diskRef.resource, image: 'localhost/elowen-project-base:1' },
      { sandboxDataDir: storage.sandboxDataDir, namespace: 'elowen' },
      diskRef.diskId,
      7,
    );
    expect(migrated.rootfs).toBe(migratedSpec.rootfsPath);
    expect(nspawnComponentPath(migrated, 'workspace')).toBe(migratedSpec.components[0].path);
  });

  it('derives a site disk under the sites root and brokers through the helper-owned socket root', () => {
    const siteId = randomUUID();
    const paths = nspawnDiskPaths(storage, { resource: { kind: 'site', id: siteId }, diskId: 'b'.repeat(32) });
    expect(paths.rootfs).toBe(join(storage.sitesDataDir, siteId, 'environment', 'disks', 'b'.repeat(32), 'rootfs'));
    expect(nspawnComponentPath(paths, 'broker')).toBe(`/var/lib/elowen/site-runtime-sockets/${siteId}`);
    expect(() => nspawnComponentPath(paths, 'workspace')).toThrow(/component is invalid/);
  });

  it('refuses a request that tries to name a path, a root or an id of its own', () => {
    expect(() => storageRootsFrom({ appHost: 'agent.example.com' })).toThrow(/no trusted storage roots/);
    expect(() => storageRootsFrom({ storage: { sandboxDataDir: 'relative', sitesDataDir: '/srv/sites' } })).toThrow(/storage root is invalid/);
    expect(() => storageRootsFrom({ storage: { sandboxDataDir: '/srv/../etc', sitesDataDir: '/srv/sites' } })).toThrow(/storage root is invalid/);
    expect(() => nspawnDiskPaths(storage, { resource: { kind: 'project', id: 54 }, diskId: '../../etc' })).toThrow(/disk id is invalid/);
    expect(() => nspawnDiskPaths(storage, { resource: { kind: 'project', id: '54; rm' }, diskId: 'a' })).toThrow(/resource id is invalid/);
    expect(() => nspawnDiskPaths(storage, { resource: { kind: 'machine', id: 1 }, diskId: 'a' })).toThrow(/resource kind is invalid/);
    // Nothing in the request names a host path, so there is no path field to smuggle one through.
    const paths = nspawnDiskPaths(storage, { ...diskRef, rootfsPath: '/etc', directory: '/etc' });
    expect(paths.rootfs.startsWith(storage.sandboxDataDir)).toBe(true);
  });

  it('refuses a symlink anywhere along a derived storage path', async () => {
    const paths = nspawnDiskPaths(storage, diskRef);
    mkdirSync(join(scratch, 'elsewhere'), { recursive: true });
    mkdirSync(join(paths.directory), { recursive: true });
    symlinkSync(join(scratch, 'elsewhere'), join(paths.directory, 'data'));
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-remove', ...diskRef, component: 'data' }, undefined, { storage }))
      .rejects.toThrow(/symlink appears in a trusted storage path/);
    expect(existsSync(join(scratch, 'elsewhere'))).toBe(true);
    rmSync(join(paths.directory, 'data'), { force: true });
  });
});

describe('privileged helper: the four merge constraints', () => {
  it('classifies execution, freeze, thaw, fingerprint and status as lock-free', () => {
    for (const op of ['exec', 'freeze', 'thaw', 'tree-fingerprint', 'status']) {
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

    const removable = nspawnComponentPath(nspawnDiskPaths(storage, diskRef), 'data');
    mkdirSync(removable, { recursive: true });
    let settled = false;
    const pending = handleRequest({ domain: 'nspawn', op: 'tree-remove', ...diskRef, component: 'data' }, { lockPath, storage })
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
    expect(renderMachineSettings([], { uidBase: 1_073_741_824, veth: true })).toContain('VirtualEthernet=yes');
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
  });

  it('derives both ends of a copy from the trusted roots and preflights the destination', async () => {
    const source = nspawnComponentPath(nspawnDiskPaths(storage, diskRef), 'workspace');
    const destination = nspawnComponentPath(nspawnDiskPaths(storage, { ...diskRef, diskId: 'c'.repeat(32) }), 'workspace');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'file.txt'), 'content');
    const calls: Call[] = [];
    const result = await applyRequest({
      domain: 'nspawn',
      op: 'tree-copy',
      source: { ...diskRef, component: 'workspace' },
      destination: { ...diskRef, diskId: 'c'.repeat(32), component: 'workspace' },
    }, undefined, {
      storage,
      runner: (file: string, args: string[]) => {
        calls.push({ file, args });
        return { ok: true, stdout: JSON.stringify({ requiredBytes: 7, marginBytes: 67108864, freeBytes: 1 << 30 }) };
      },
    }) as { sourcePath: string; targetPath: string };
    expect(result).toMatchObject({ sourcePath: source, targetPath: destination });
    expect(calls[0].file).toBe('/usr/bin/python3');
    expect(calls[0].args[2]).toBe(JSON.stringify([source]));
    expect(calls[1].file).toBe('/bin/bash');
    expect(calls[1].args.slice(2)).toEqual(['elowen-copy-tree', source, destination]);
  });

  it('validates the fingerprint a root process reports back', async () => {
    const path = nspawnComponentPath(nspawnDiskPaths(storage, diskRef), 'home');
    mkdirSync(path, { recursive: true });
    const digest = 'f'.repeat(64);
    const runner = (_file: string, _args: string[]) => ({ ok: true, stdout: JSON.stringify({ logicalBytes: 10, allocatedBytes: 4096, digest }) });
    expect(await applyRequest({ domain: 'nspawn', op: 'tree-fingerprint', ...diskRef, component: 'home' }, undefined, { storage, runner }))
      .toMatchObject({ ok: true, path, digest, logicalBytes: 10, allocatedBytes: 4096 });
    await expect(applyRequest({ domain: 'nspawn', op: 'tree-fingerprint', ...diskRef, component: 'home' }, undefined, {
      storage, runner: () => ({ ok: true, stdout: JSON.stringify({ logicalBytes: 10, allocatedBytes: 4096, digest: 'nope' }) }),
    })).rejects.toThrow(/fingerprint is invalid/);
  });
});

describe('privileged helper: the path the bundled runtime hardcodes', () => {
  // A bundled plugin is plain ESM and cannot import `src/` at runtime, so it hardcodes this path the
  // same way the container runtime hardcodes /usr/bin/podman. This is the pin that keeps the two ends of
  // that duplication from drifting apart.
  it.skipIf(!existsSync(PLUGIN_RUNTIME))('pins the helper path and request domain the bundled machine runtime uses', () => {
    const source = readFileSync(PLUGIN_RUNTIME, 'utf8');
    expect(source, `plugins/sandbox/lib/nspawn.mjs must hardcode HELPER_PATH = '${NSPAWN_HELPER_PATH}'`)
      .toContain(`const HELPER_PATH = '${NSPAWN_HELPER_PATH}'`);
    expect(source, "every request the bundled machine runtime builds must carry domain: 'nspawn'")
      .toContain("domain: 'nspawn'");
  });

  it('states the contract the bundled machine runtime must satisfy', () => {
    expect(NSPAWN_HELPER_PATH).toBe('/usr/local/libexec/elowen-site-gateway');
    expect(HELPER_FRAME_HEADER_BYTES).toBe(9);
    expect(encodeHelperRequest({ domain: 'nspawn', op: 'status' }).toString())
      .toBe('00000033\n{"domain":"nspawn","op":"status"}');
  });
});
