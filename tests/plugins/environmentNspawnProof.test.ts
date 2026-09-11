import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoundSiteSpec, createContainerSpec, createEnvironmentDiskSpec, publicationUnit } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { PROJECT_BASE_IMAGE_TAG } from '../../plugins/sandbox/lib/containerBaseImage.mjs';
import { cleanPodmanEnv, PodmanClient } from '../../plugins/sandbox/lib/podman.mjs';
import { EXPECTED_CAPABILITY_BOUND, EXPECTED_SECCOMP_FILTERS, EXPECTED_SECCOMP_MODE, envelopePaths,
  HELPER_PATH, NspawnClient, UID_RANGE_SIZE, unitFor } from '../../plugins/sandbox/lib/nspawn.mjs';

/** The real thing, on a real host, or nothing. Every fact this file asserts is a property of a running
 *  machine — its capability bound, its seccomp mode, what its binds do to file ownership, what its cgroup
 *  actually holds, how long a command really takes — and none of them can be established against a fake.
 *  So the suite refuses to run rather than to pretend, and says why.
 *
 *  `tests/plugins/nspawnProofHost.mjs` prepares a host for it and takes the preparation away again;
 *  `docs/TESTING.md` has the invocation. */
const MACHINE_UNIT_TEMPLATE = '/etc/systemd/system/elowen-machine@.service';
/** Which privileged helper this run talks to. Unset, it is the installed one, and the suite proves the
 *  deployed runtime. Set, it is an isolated one a harness put there: a root-owned wrapper around the
 *  helper in the working tree plus a sudoers line naming it, so a branch can be proved on a host whose
 *  installed helper is serving production and must not be replaced. The argv is the same either way —
 *  the path moves, the invocation the sudoers drop-in pins does not. */
const PROOF_HELPER = process.env.ELOWEN_TEST_NSPAWN_HELPER || HELPER_PATH;

const blockers: string[] = [];
if (process.platform !== 'linux') blockers.push('the host is not Linux');
if (!existsSync('/usr/bin/systemd-nspawn')) blockers.push('systemd-container is not installed');
if (!existsSync(PROOF_HELPER)) blockers.push(`the privileged helper is not present at ${PROOF_HELPER}`);
// The unit template is what says the machine runtime has been provisioned at all: the helper writes it,
// the polkit rule is scoped to it, and it sits where the service account can read it. The polkit rule
// itself is deliberately NOT checked as a path — `/etc/polkit-1/rules.d` is root-only, so a permission
// denial and a missing file are the same answer from this account, and treating that as a skip would
// hide the runtime being unusable. A rule that is absent surfaces as an access denial on the first
// `systemctl start`, which this suite then reports as the failure it is.
if (!existsSync(MACHINE_UNIT_TEMPLATE)) blockers.push('the machine unit template is not installed');
// An ordinary environment now comes up with a virtual ethernet, and the privileged side refuses to write
// an envelope carrying one until the host can isolate it. Without these the suite cannot create anything
// at all, so it says which rule is missing rather than failing thirteen times over.
const FIREWALL_RULE_IDS = ['firewall:forward-out', 'firewall:forward-back', 'firewall:machine-dhcp',
  'firewall:host-guard', 'firewall:host-guard6'];
if (!blockers.length) {
  // Asked of the privileged side, not of `iptables`. The service account cannot read the tables at all,
  // so checking them from here would report every rule absent on a host where all five are installed —
  // and the readiness report is the answer that actually gates `write-envelope` anyway.
  try {
    const probe = new NspawnClient({ images: new PodmanClient({ outputLimitBytes: 1024 * 1024 }), helperPath: PROOF_HELPER, namespace: 'elowen' });
    const readiness = await probe.hostReadiness();
    // Absent rows count as unmet, not as nothing to check: a report that carries no firewall rows at all
    // would otherwise read as a clean bill of health.
    const unmet = FIREWALL_RULE_IDS.filter((id) => !readiness.items.some((item: any) => item.id === id && item.ok));
    if (unmet.length) blockers.push(`the host guard for machine networking is not installed: ${unmet.join(', ')}`);
  } catch (error) {
    blockers.push(`the machine runtime readiness could not be read: ${(error as Error).message}`);
  }
}
/** Where the helper is willing to touch at all. Every path this suite uses has to be inside them, and
 *  they are DERIVED, never read: the helper computes them from the passwd home of the account sudo says
 *  invoked it, because a root that decides what to unpack and what to delete cannot take that decision
 *  from anything the caller can write. The same derivation is made here so the suite builds its disks
 *  where the privileged side will agree they belong; `tests/contract/nspawnHelper.test.ts` is what holds
 *  the two in step. */
let storageRoots: { sandboxDataDir: string; sitesDataDir: string } | null = null;
if (!blockers.length) {
  const passwd = execFileSync('/usr/bin/getent', ['passwd', String(process.getuid!())], { encoding: 'utf8', timeout: 30_000 }).trim().split(':');
  const home = passwd[5] ?? '';
  if (!home.startsWith('/')) blockers.push('the service account running this suite has no home directory');
  else {
    const pluginData = join(home, '.config', 'elowen', 'plugins-data');
    storageRoots = { sandboxDataDir: join(pluginData, 'sandbox'), sitesDataDir: join(pluginData, 'sites') };
    for (const root of [storageRoots.sandboxDataDir, storageRoots.sitesDataDir]) {
      if (!existsSync(root)) blockers.push(`the trusted storage root ${root} does not exist`);
    }
  }
}
if (!blockers.length) {
  // The machine is built from the same image every environment is, so an unbuilt one is a reason to skip
  // rather than a fifteen-minute build inside a test. The store is the SERVICE account's rootless one,
  // reachable only with that account's own environment.
  try { execFileSync('/usr/bin/podman', ['image', 'exists', PROJECT_BASE_IMAGE_TAG], { timeout: 60_000, env: cleanPodmanEnv() }); }
  catch { blockers.push('the project base image is not built'); }
}
if (blockers.length) console.log(`nspawn machine proof skipped: ${blockers.join('; ')}`);

const podmanEnv = () => cleanPodmanEnv();
const systemctlShow = (unit: string, property: string) =>
  execFileSync('/usr/bin/systemctl', ['show', unit, '-p', property, '--value'], { encoding: 'utf8', timeout: 30_000 }).trim();
const machineList = () => execFileSync('/usr/bin/machinectl', ['list', '--no-legend', '--no-pager'], { encoding: 'utf8', timeout: 30_000 });

/** Everything this suite owns carries this marker, so a run interrupted halfway leaves resources a person
 *  can find and remove without guessing. The project id is far outside the range a real project reaches. */
const SUFFIX = randomBytes(4).toString('hex');
const PROJECT_ID = 990_000_000 + Number(BigInt(`0x${SUFFIX}`) % 1_000_000n);
const SITE_ID = `nsproof-${SUFFIX}`;

describe.skipIf(blockers.length > 0)('systemd-nspawn machine, proved against a real host', () => {
  const paths = { sandboxDataDir: storageRoots?.sandboxDataDir ?? '/nonexistent', namespace: 'elowen' };
  const resource = { kind: 'project' as const, id: PROJECT_ID };
  const disk = createEnvironmentDiskSpec({ resource, image: PROJECT_BASE_IMAGE_TAG, runtime: 'nspawn' },
    paths, randomBytes(16).toString('hex'));
  const spec: any = createContainerSpec({ resource, workspaceTarget: '/nsproof', generation: 1,
    image: PROJECT_BASE_IMAGE_TAG, disk, previewBroker: true,
    limits: { cpus: 0.75, memoryMb: 384, pidsLimit: 300 } }, paths);
  const unit = unitFor(spec.name);
  const envelope = envelopePaths(spec.name);
  const diskDirectory = dirname(spec.disk.rootfsPath);

  const images = new PodmanClient({ outputLimitBytes: 16 * 1024 * 1024 });
  const client = new NspawnClient({ images, outputLimitBytes: 16 * 1024 * 1024, helperPath: PROOF_HELPER, namespace: 'elowen' });
  /** The verdict shape the runtime client answers with. It is stated here because the client is JavaScript
   *  and its inferred return is optional, which would make every field below need a guard that says
   *  nothing about the machine. */
  type Verdict = { code: number; stdout: string; stderr: string; truncated: boolean };
  const guest = (argv: string[], options: Record<string, unknown> = {}): Promise<Verdict> =>
    client.exec(spec, randomBytes(16).toString('hex'), argv, { timeoutMs: 60_000, persistent: true, ...options }) as Promise<Verdict>;
  const boot = async () => {
    if (!await client.containerExists(spec)) await client.create(spec);
    if ((await client.inspect(spec))?.state !== 'running') await client.start(spec);
    await client.waitForSystemBus(spec, { timeoutMs: 180_000 });
  };
  const cgroup = (name: string) => readFileSync(join('/sys/fs/cgroup/machine.slice', unit, name), 'utf8').trim();
  const identity = () => JSON.parse(readFileSync(join(diskDirectory, '.elowen', 'identity.json'), 'utf8'));
  const measured: string[] = [];

  beforeAll(async () => {
    // The disk comes from the image the way a real environment's does: the rootless export is done by the
    // client that has an image store, the extraction and the one-time ownership pass by the helper.
    mkdirSync(spec.disk.rootfsPath, { recursive: true, mode: 0o755 });
    for (const component of spec.disk.components) mkdirSync(component.path, { recursive: true, mode: 0o700 });
    mkdirSync(join(spec.storageRoot, 'broker'), { recursive: true, mode: 0o700 });
    const started = Date.now();
    const imageId = await client.materializeRootfs(spec, spec.disk.rootfsPath);
    measured.push(`materialize from ${PROJECT_BASE_IMAGE_TAG}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    expect(imageId).toMatch(/^(sha256:)?[a-f0-9]{64}$/);
  }, 30 * 60_000);

  afterAll(async () => {
    try { execFileSync('/usr/bin/systemctl', ['stop', unit], { timeout: 120_000, stdio: 'ignore' }); } catch { /* already down */ }
    try { if (await client.containerExists(spec)) await client.removeByName(spec); } catch { /* gone */ }
    for (const path of [spec.storageRoot, join(storageRoots?.sitesDataDir ?? '/nonexistent', SITE_ID)]) {
      try { if (existsSync(path)) await client.removeDiskPath(path); } catch { /* gone */ }
    }
    for (const line of measured) console.log(`nspawn proof: ${line}`);
  }, 15 * 60_000);

  it('materializes a disk from the real image and shifts the whole tree into the machine uid range', () => {
    // The ownership pass is what makes the tree a machine's rather than a container's, and it is the one
    // step a config file cannot undo. The identity record is its receipt.
    const record = identity();
    expect(record).toMatchObject({ namespace: 'elowen', kind: 'project', resource: String(PROJECT_ID),
      diskId: spec.disk.id, machine: spec.name, runtime: 'nspawn', uidSize: UID_RANGE_SIZE });
    expect(record.uidBase).toBeGreaterThanOrEqual(1073741824);
    // The image's own root-owned files now belong to the base of that range on the host, and no longer
    // to the service account.
    const etc = lstatSync(join(spec.disk.rootfsPath, 'etc'));
    expect(etc.uid).toBe(record.uidBase);
    expect(etc.uid).not.toBe(process.getuid!());
    // The tree's ROOT, which the ownership pass also touches and whose mode the unpacked archive decides.
    // Nothing but the guest's own root traverses a 0700 root, and every service that drops privileges —
    // `dbus-daemon` to `messagebus` first among them — stalls behind it without ever failing outright.
    const root = lstatSync(spec.disk.rootfsPath);
    // The owner is the service account carried into the range like every other uid, because the service
    // account is what created the directory; the shift maps owners and never modes. So the fact that
    // matters is the MODE, and it has to survive the unpack: the archive carries its own root member.
    expect(root.uid).toBeGreaterThanOrEqual(record.uidBase);
    expect(root.uid).toBeLessThan(record.uidBase + UID_RANGE_SIZE);
    expect(root.mode & 0o777).toBe(0o755);
    const identityStat = lstatSync(join(diskDirectory, '.elowen', 'identity.json'));
    expect(identityStat.uid).toBe(0);
    expect(identityStat.mode & 0o022).toBe(0);
    measured.push(`disk uid base ${record.uidBase}, range ${record.uidSize}`);
  });

  it('boots the envelope and confines it: capabilities, seccomp, volatility, binds and limits', async () => {
    const started = Date.now();
    await client.create(spec);
    await client.start(spec);
    await client.waitForSystemBus(spec, { timeoutMs: 180_000 });
    measured.push(`boot to a usable system bus: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    expect(['running', 'degraded']).toContain(await client.systemRunning(spec, { timeoutMs: 180_000 }));
    expect((await client.inspect(spec))!.state).toBe('running');
    expect(machineList()).toContain(spec.name);

    const status = await guest(['/bin/cat', '/proc/self/status']);
    const field = (name: string) => /^(\S+)/.exec(new RegExp(`^${name}:\\s+(.*)$`, 'm').exec(status.stdout)?.[1] ?? '')?.[1] ?? '';
    expect(BigInt(`0x${field('CapBnd')}`)).toBe(EXPECTED_CAPABILITY_BOUND);
    expect(Number(field('Seccomp'))).toBe(EXPECTED_SECCOMP_MODE);
    expect(Number(field('Seccomp_filters'))).toBe(EXPECTED_SECCOMP_FILTERS);
    expect((await guest(['/usr/bin/id', '-u'])).stdout.trim()).toBe('0');
    measured.push(`capability bound 0x${field('CapBnd')}, seccomp mode ${field('Seccomp')} with ${field('Seccomp_filters')} filters`);

    // /tmp and /run are volatile, and the root filesystem is a real directory rather than an overlay.
    const filesystems = await guest(['/bin/sh', '-c', 'stat -f -c %T /tmp; stat -f -c %T /run; stat -f -c %T /']);
    const [tmpFs, runFs, rootFs] = filesystems.stdout.trim().split('\n');
    expect(tmpFs).toBe('tmpfs');
    expect(runFs).toBe('tmpfs');
    expect(rootFs).not.toBe('overlayfs');

    // Nothing of the host filesystem is reachable, and the service account's own tree least of all.
    expect((await guest(['/bin/sh', '-c', 'ls /var/www 2>&1; true'])).stdout).toContain('No such file');

    // A bind maps the guest's root onto the HOST owner of the bind source, which is the rootless-Podman
    // semantics every existing environment already depends on.
    await guest(['/bin/sh', '-c', 'printf bound >/data/ownership-proof']);
    const dataPath = join(spec.disk.components.find((entry: any) => entry.component === 'data')!.path, 'ownership-proof');
    expect(readFileSync(dataPath, 'utf8')).toBe('bound');
    expect(lstatSync(dataPath).uid).toBe(process.getuid!());

    // The limits the envelope declared are the ones the cgroup holds.
    expect(cgroup('cpu.max')).toBe('75000 100000');
    expect(cgroup('memory.max')).toBe(String(384 * 1024 * 1024));
    expect(cgroup('pids.max')).toBe('300');
  }, 20 * 60_000);

  it('gives the guest a working network and still keeps it off the host', async () => {
    // The environment under test was created the ordinary way, so this is the networking a deployed guest
    // actually gets — not a settings file edited by hand. Without it a machine has its own loopback and
    // nothing else, and a user's first package install fails.
    // The link is leased rather than configured at boot, so it arrives a moment after the system bus does.
    // Bounded, because a link that never comes up is the failure this case exists to catch.
    let link = { stdout: '' } as Verdict;
    let gateway: string | undefined;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && gateway === undefined;) {
      link = await guest(['/bin/sh', '-c', 'ip -4 -o addr show host0 2>&1; ip -4 route show default 2>&1']);
      gateway = (link.stdout.match(/default via (\d+\.\d+\.\d+\.\d+)/) ?? [])[1];
      if (gateway === undefined) await new Promise((resolve) => { setTimeout(resolve, 2000); });
    }
    expect(gateway, `the guest has no default route within 60s: ${link.stdout}`).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    // A name, resolved by the guest's own resolver, and then bytes from off the box.
    const resolved = await guest(['/usr/bin/getent', 'hosts', 'deb.debian.org'], { timeoutMs: 60_000 });
    expect(resolved.code, resolved.stderr).toBe(0);
    const fetched = await guest(['/usr/bin/curl', '-sS', '-m', '20', '-o', '/dev/null', '-w', '%{http_code}', 'http://deb.debian.org/'], { timeoutMs: 90_000 });
    expect(fetched.stdout.trim(), fetched.stderr).toBe('200');
    measured.push(`guest network: gateway ${gateway}, DNS ok, outbound http ${fetched.stdout.trim()}`);

    // And the half that matters more: the link does not become a way into the host. The listener is put on
    // the host's OWN address on that link, which is the address the guest can route to and therefore the
    // only honest target — a check against 127.0.0.1 would pass with the guard removed and prove nothing.
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(4499, gateway, resolve); });
    try {
      const reachableFromHost = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: gateway, port: 4499 });
        socket.setTimeout(3000);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
      });
      expect(reachableFromHost, 'the listener must be open from the host for this check to prove anything').toBe(true);
      const blocked = await guest(['/usr/bin/python3', '-c',
        `import socket,sys;s=socket.socket();s.settimeout(5);sys.exit(0 if s.connect_ex(('${gateway}',4499))==0 else 1)`], { timeoutMs: 60_000 });
      expect(blocked.code, 'the guest reached a host port over its link').not.toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10 * 60_000);

  it('runs the execution matrix: streams, exit codes, stdin, a large output, a timeout and a cancellation', async () => {
    const separated = await guest(['/bin/sh', '-c', 'printf out; printf err >&2; exit 42']);
    expect(separated).toMatchObject({ code: 42, stdout: 'out', stderr: 'err', truncated: false });

    const piped = await guest(['/bin/cat'], { input: 'bytes over stdin\n' });
    expect(piped).toMatchObject({ code: 0, stdout: 'bytes over stdin\n' });

    // A guest that writes more than a terminal ever would still comes back whole, because the verdict
    // carries the bytes and this client's bound is the caller's figure over the decoded stream.
    const large = await guest(['/bin/sh', '-c', 'head -c 4194304 /dev/zero | tr "\\0" "x"']);
    expect(large.code).toBe(0);
    expect(Buffer.byteLength(large.stdout)).toBe(4 * 1024 * 1024);
    expect(large.truncated).toBe(false);

    // A command that outlives its deadline is reported as a timeout, not as a transport error.
    await expect(guest(['/bin/sleep', '30'], { timeoutMs: 3000 })).rejects.toThrow(/timed out/i);

    // A cancellation ends the execution: it settles well inside its own deadline, it does not settle as
    // a success, and nothing of it is left running in the guest.
    const executionId = randomBytes(16).toString('hex');
    const running = client.exec(spec, executionId, ['/bin/sleep', '120'], { timeoutMs: 300_000, persistent: true });
    const settled = running.then((value: any) => `code ${value.code}`, (error: Error) => `error ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await client.cancelExecution(spec, executionId, { persistent: true })).toMatchObject({ terminated: true });
    const outcome = await settled;
    // The bracket keeps `pgrep -f` from matching the very shell that runs it, which reports every such
    // process as alive whatever happened to the one being asked about.
    expect((await guest(['/bin/sh', '-c', 'pgrep -f "[s]leep 120" >/dev/null 2>&1 && echo alive || echo gone'])).stdout.trim()).toBe('gone');
    measured.push(`cancelled execution settled as: ${outcome}`);
    // The process is gone AND the caller is told so. A launcher whose unit is stopped still exits zero,
    // so without this the caller reads a killed command as a success with no output.
    expect(outcome).toMatch(/^error .*cancelled/i);
    expect(outcome).not.toBe('code 0');

    // The round trip, end to end and through the privileged helper. The design estimated this from two
    // separate measurements; this is the figure that replaces the estimate.
    const samples: number[] = [];
    for (let run = 0; run < 20; run++) {
      const started = process.hrtime.bigint();
      await guest(['/bin/true']);
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    measured.push(`exec round trip: median ${median.toFixed(0)} ms, range ${samples[0]!.toFixed(0)}-${samples.at(-1)!.toFixed(0)} ms over ${samples.length} runs`);
    // Podman's measured median on this shape is 856 ms with a 225-1187 ms spread. The point of this
    // runtime is that it is not that, so the bound is the bottom of Podman's own range.
    expect(median).toBeLessThan(500);
  }, 20 * 60_000);

  it('carries a guest argv through every production path byte for byte', async () => {
    // A transient unit's command line is a systemd command line, and the manager substitutes `${VAR}` and
    // `$VAR` in it at exec time unless told not to. Unnoticed, that rewrites what a caller asked for with
    // no error anywhere: a `${...}` becomes empty, an unset `$VAR` word-splits away as a whole argument.
    // There are three ways a guest command reaches the machine in production and each one is proved here,
    // because the flag that prevents this is only worth something if systemd honours it end to end.
    const payload = ['${Status}', '$HOME', '$$', '100%', '%n', '$PATH'];
    const expected = payload.join(' ');

    // The ordinary execution, which is also the transport the client's own control commands travel on.
    expect((await guest(['/bin/echo', ...payload])).stdout.trimEnd()).toBe(expected);

    // The LAUNCHED path: the descriptor the daemon spawns and streams itself, run here the way it does.
    const prepared: any = await client.prepareExecution(spec, randomBytes(16).toString('hex'), ['/bin/echo', ...payload]);
    const streamed = execFileSync(prepared.launch.file, prepared.launch.args,
      { input: prepared.stdin, env: prepared.launch.env, timeout: 60_000, encoding: 'utf8' });
    await prepared.settle({});
    expect(streamed.trimEnd()).toBe(expected);

    // The DETACHED path, read back from what the kernel actually exec'd rather than from what was asked.
    const previewId = randomBytes(16).toString('hex');
    await client.startPreview(spec, previewId, ['/bin/sh', '-c', 'sleep 120', ...payload]);
    try {
      const scan = await guest(['/bin/sh', '-c',
        'for p in /proc/[0-9]*; do tr "\\0" " " <$p/cmdline 2>/dev/null | grep -q "sleep 120" && tr "\\0" "\\n" <$p/cmdline && break; done']);
      expect(scan.stdout.trimEnd().split('\n').slice(3).join(' ')).toBe(expected);
    } finally {
      await client.cancelExecution(spec, previewId, { persistent: true }).catch(() => { /* already gone */ });
    }
  }, 10 * 60_000);

  it('runs a long-lived guest service and stops it', async () => {
    const publicationId = randomBytes(16).toString('hex');
    await client.startPublication(spec, publicationId, ['/bin/sleep', '600']);
    expect(await client.activePublications(spec, [publicationId])).toEqual([publicationId]);
    // The unit name comes from the specification, not from this test: an invented one reports `inactive`
    // for a unit that does not exist and looks exactly like a service that failed to start.
    expect((await guest(['/bin/sh', '-c', `systemctl is-active ${publicationUnit(publicationId)}`])).stdout.trim()).toBe('active');

    await client.stopPublication(spec, publicationId);
    expect(await client.activePublications(spec, [publicationId])).toEqual([]);
    expect((await guest(['/bin/sh', '-c', 'pgrep -f "[s]leep 600" >/dev/null 2>&1 && echo alive || echo gone'])).stdout.trim()).toBe('gone');
  }, 10 * 60_000);

  it('applies a live limit change that the cgroup actually takes', async () => {
    expect(cgroup('memory.max')).toBe(String(384 * 1024 * 1024));
    const updated = await client.update(spec, { cpus: 1.5, memoryMb: 512, pidsLimit: 400 });
    expect(updated.limits).toMatchObject({ cpus: 1.5, memoryMb: 512, pidsLimit: 400 });
    // Read from the kernel, not from systemd's own record of what it was asked for.
    expect(cgroup('memory.max')).toBe(String(512 * 1024 * 1024));
    expect(cgroup('pids.max')).toBe('400');
    expect(cgroup('cpu.max')).toBe('150000 100000');
    // The specification the change RETURNED is the one that now describes the envelope, and the old one
    // no longer does: the ownership proof reads the effective limits, so handing back the stale
    // specification is refused rather than silently accepted.
    await expect(client.inspect(spec)).rejects.toThrow(/mismatch: memory, pidsLimit, cpus/);
    await client.update(updated, { cpus: 0.75, memoryMb: 384, pidsLimit: 300 });
    expect(cgroup('memory.max')).toBe(String(384 * 1024 * 1024));
    expect((await client.inspect(spec))!.state).toBe('running');
  }, 10 * 60_000);

  it('carries a really installed package and an /etc change across envelope recreation', async () => {
    // A real dpkg transaction, built and installed inside the guest: the machine has no network, so the
    // package is made there rather than fetched, and `dpkg` is what installs it and what is asked about
    // afterwards. Querying the package database is the difference between proving a package survives and
    // proving a file does.
    const build = await guest(['/bin/sh', '-c', [
      'set -e', 'rm -rf /tmp/pkg', 'mkdir -p /tmp/pkg/DEBIAN /tmp/pkg/usr/bin',
      'printf "Package: elowen-proof-marker\\nVersion: 1.0\\nArchitecture: all\\nMaintainer: proof <proof@localhost>\\nDescription: proof of package persistence\\n" >/tmp/pkg/DEBIAN/control',
      'printf "#!/bin/sh\\necho proof\\n" >/tmp/pkg/usr/bin/elowen-proof-marker',
      'chmod 755 /tmp/pkg/usr/bin/elowen-proof-marker',
      'dpkg-deb --build /tmp/pkg /tmp/elowen-proof-marker.deb >/dev/null',
      'dpkg -i /tmp/elowen-proof-marker.deb >/dev/null',
    ].join('\n')], { timeoutMs: 120_000 });
    expect(build.code, build.stderr).toBe(0);
    // The literal form, with the `${...}` a unit command line would otherwise expand away. The privileged
    // side asks systemd not to expand it, and this is where that is worth something: the query is the one
    // a person writes, and it has to answer about the package rather than about an empty format string.
    const queried = await guest(['/usr/bin/dpkg-query', '-W', '-f=${Status}', 'elowen-proof-marker'], { allowFailure: true });
    expect(queried.stdout, queried.stderr).toBe('install ok installed');
    await guest(['/bin/sh', '-c', 'printf "tuned by the proof\\n" >/etc/elowen-proof.conf']);
    await guest(['/bin/sh', '-c', 'printf volatile >/tmp/should-not-survive']);

    // The envelope is thrown away completely: unit stopped, settings file and drop-in gone.
    await client.stop(spec);
    expect(systemctlShow(unit, 'Result')).toBe('success');
    expect((await client.inspect(spec))!.state).toBe('stopped');
    await client.remove(spec);
    expect(await client.containerExists(spec)).toBe(false);
    expect(existsSync(envelope.nspawn)).toBe(false);
    expect(existsSync(envelope.dropIn)).toBe(false);

    await boot();
    // Both survive, and the package survives AS a package: dpkg's own database came back with the disk.
    const afterRecreate = await guest(['/usr/bin/dpkg-query', '-W', '-f=${Status}', 'elowen-proof-marker'], { allowFailure: true });
    expect(afterRecreate.stdout, afterRecreate.stderr).toBe('install ok installed');
    // The file the package owns, checked directly: a package database that survived is only worth
    // anything if what it recorded survived with it.
    expect((await guest(['/usr/bin/elowen-proof-marker'])).stdout.trim()).toBe('proof');
    expect((await guest(['/bin/cat', '/etc/elowen-proof.conf'])).stdout).toBe('tuned by the proof\n');
    expect((await guest(['/bin/cat', '/data/ownership-proof'])).stdout).toBe('bound');
    // The other half of the same claim: a tmpfs does not survive.
    expect((await guest(['/bin/sh', '-c', 'ls /tmp/should-not-survive 2>&1; true'])).stdout).toContain('No such file');
  }, 20 * 60_000);

  it('snapshots the disk and restores it over a tree that has moved on', async () => {
    const snapshotPath = join(spec.storageRoot, 'snapshots', `proof-${SUFFIX}`, 'rootfs');
    // The destination directory itself, not just its parent: the privileged copy validates the target as
    // an existing trusted path and creates nothing.
    mkdirSync(snapshotPath, { recursive: true, mode: 0o700 });
    await guest(['/bin/sh', '-c', 'printf before >/etc/elowen-snapshot-marker']);
    await client.stop(spec);

    const captured = Date.now();
    await client.copyDiskTree(spec.disk.rootfsPath, snapshotPath);
    // The archive carries its own root member, and the flags `materialize` unpacks with let that member
    // overwrite the mode of the directory it unpacks into. So the root mode is a property of the tree, not
    // an accident of who created the directory, and a snapshot that captured a 0700 root would carry that
    // fault into every restore made from it. A guest root nothing but uid 0 can traverse is a machine
    // whose `dbus-daemon` starts, opens its socket and then never reports ready.
    const snapshotRoot = lstatSync(snapshotPath);
    expect(snapshotRoot.mode & 0o777).toBe(0o755);
    expect(snapshotRoot.uid).toBeGreaterThanOrEqual(identity().uidBase);
    const fingerprint = await client.fingerprintDiskTree(snapshotPath);
    expect(fingerprint.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint.logicalBytes).toBeGreaterThan(100 * 1024 * 1024);
    measured.push(`snapshot copy of ${(fingerprint.logicalBytes / 1024 ** 3).toFixed(2)} GiB: ${((Date.now() - captured) / 1000).toFixed(1)} s`);

    await boot();
    await guest(['/bin/sh', '-c', 'printf after >/etc/elowen-snapshot-marker']);
    expect((await guest(['/bin/cat', '/etc/elowen-snapshot-marker'])).stdout).toBe('after');

    // Restore: the moved-on tree goes, the snapshot takes its place, and the machine boots on it.
    await client.stop(spec);
    await client.remove(spec);
    await client.removeDiskPath(spec.disk.rootfsPath);
    // The copy refuses a destination that is not empty, and it creates nothing: the restore path owes it
    // an empty directory, which is exactly what removing and recreating the tree leaves.
    mkdirSync(spec.disk.rootfsPath, { recursive: true, mode: 0o755 });
    await client.copyDiskTree(snapshotPath, spec.disk.rootfsPath);
    await boot();
    expect((await guest(['/bin/cat', '/etc/elowen-snapshot-marker'])).stdout).toBe('before');
    // The restored tree is still the machine's, so the copy preserved the shifted ownership. And its root
    // is traversable, which is what makes the restored disk usable rather than merely present: the boot
    // above would have hung on dbus otherwise.
    expect(lstatSync(join(spec.disk.rootfsPath, 'etc')).uid).toBe(identity().uidBase);
    const restoredRoot = lstatSync(spec.disk.rootfsPath);
    expect(restoredRoot.mode & 0o777).toBe(0o755);
    expect(restoredRoot.uid).toBeGreaterThanOrEqual(identity().uidBase);
    await client.removeDiskPath(dirname(snapshotPath));
    expect(existsSync(snapshotPath)).toBe(false);
  }, 30 * 60_000);

  it('reverses the ownership shift the way a failed runtime migration has to', async () => {
    // The rollback half of `migrate-runtime`. Its failure is the one that leaves a tree neither runtime
    // can read, so the reversal is proved on a real tree rather than argued from a receipt.
    await client.stop(spec);
    await client.remove(spec);
    const base = identity().uidBase;
    expect(lstatSync(join(spec.disk.rootfsPath, 'etc')).uid).toBe(base);

    // What the reverse pass needs is the range the tree came FROM, which only the forward pass reports.
    // `migrate-runtime` keeps it in its checkpoint as `previousUidBase` for exactly this reason; passing
    // the machine's own base instead is refused by the privileged side.
    const receipt = await client.shiftOwnership(spec, { target: 'nspawn' });
    expect(receipt.uidBase).toBe(base);
    const reversed = await client.shiftOwnership(spec, { target: 'podman', uidBase: receipt.previousUidBase });
    expect(reversed.uidBase).toEqual(expect.any(Number));
    const afterReverse = lstatSync(join(spec.disk.rootfsPath, 'etc')).uid;
    expect(afterReverse).not.toBe(base);
    measured.push(`ownership reversal: uid ${base} -> ${afterReverse}`);

    // And forward again, which is what a retry does, ending exactly where it started.
    const forward = await client.shiftOwnership(spec, { target: 'nspawn' });
    expect(forward.uidSize).toBe(UID_RANGE_SIZE);
    expect(lstatSync(join(spec.disk.rootfsPath, 'etc')).uid).toBe(forward.uidBase);
    await boot();
    expect((await guest(['/bin/cat', '/etc/elowen-proof.conf'])).stdout).toBe('tuned by the proof\n');
  }, 30 * 60_000);

  it('reports the host guard through the readiness the daemon shows a person', async () => {
    // The same answer the settings page reads, taken from the privileged side rather than from the tables
    // directly. It has to agree with what this suite has already proved works, because a readiness row
    // that says a machine can have a link when it cannot is what puts a guest on the host's network.
    const readiness = await client.hostReadiness();
    const rules = readiness.items.filter((item: any) => item.id.startsWith('firewall:'));
    expect(rules.map((item: any) => item.id).sort()).toEqual([...FIREWALL_RULE_IDS].sort());
    expect(rules.every((item: any) => item.ok), JSON.stringify(rules)).toBe(true);
    measured.push(`host readiness: ${readiness.ready ? 'ready' : 'NOT ready'}, ${rules.length} firewall rows all present`);
  }, 5 * 60_000);

  it('writes a real Site envelope, with the git stub as a file and the ingress socket on the host side', async () => {
    const siteResource = { kind: 'site' as const, id: SITE_ID };
    const sitesDataDir = storageRoots!.sitesDataDir;
    const sourcePath = join(sitesDataDir, SITE_ID, 'source');
    const brokerDir = join(sitesDataDir, SITE_ID, 'broker');
    const siteDisk = createEnvironmentDiskSpec({ resource: siteResource, image: PROJECT_BASE_IMAGE_TAG, runtime: 'nspawn' },
      { sitesDataDir, namespace: 'elowen' }, randomBytes(16).toString('hex'));
    const siteSpec: any = createBoundSiteSpec({ resource: siteResource, generation: 1, image: PROJECT_BASE_IMAGE_TAG,
      disk: siteDisk, workspaceReadOnly: true, limits: { cpus: 0.5, memoryMb: 320, pidsLimit: 200 } },
    { namespace: 'elowen', sitesDataDir, sourcePath, brokerDir });
    const siteUnit = unitFor(siteSpec.name);
    expect(siteSpec.name).toBe(`elowen-site-${SITE_ID}-g1`);

    const gitStub = siteSpec.mounts.find((mount: any) => mount.target === '/workspace/.git')!.source;
    for (const path of [sourcePath, brokerDir, dirname(gitStub)]) mkdirSync(path, { recursive: true, mode: 0o700 });
    // The machine's ROOT directory, and 0755 is not cosmetic: every guest process that is not the guest's
    // own root has to traverse it, and a 0700 root leaves `dbus-daemon` unable to finish starting after it
    // drops to `messagebus`. The daemon then never gets its readiness notification and the whole boot
    // hangs on a unit whose process is alive. A project's rootfs is created the same way.
    mkdirSync(siteSpec.disk.rootfsPath, { recursive: true, mode: 0o755 });
    for (const component of siteSpec.disk.components) mkdirSync(component.path, { recursive: true, mode: 0o700 });
    // A FILE, which is what a Site's git stub is. A directory here passes a hand-written test and fails
    // against the real client, which validates this bind as a file.
    writeFileSync(gitStub, 'gitdir: /dev/null\n', { mode: 0o600 });
    writeFileSync(join(sourcePath, 'index.html'), '<!doctype html>site source\n', { mode: 0o600 });
    expect(lstatSync(gitStub).isFile()).toBe(true);

    const siteClient = new NspawnClient({ images, outputLimitBytes: 16 * 1024 * 1024, helperPath: PROOF_HELPER, namespace: 'elowen' });
    const siteGuest = (argv: string[], options: Record<string, unknown> = {}): Promise<Verdict> =>
      siteClient.exec(siteSpec, randomBytes(16).toString('hex'), argv, { timeoutMs: 60_000, persistent: true, ...options }) as Promise<Verdict>;
    try {
      await siteClient.materializeRootfs(siteSpec, siteSpec.disk.rootfsPath);
      await siteClient.create(siteSpec);
      await siteClient.start(siteSpec);
      await siteClient.waitForSystemBus(siteSpec, { timeoutMs: 180_000 });

      // Every bind arrived with the semantics the specification declared.
      expect((await siteGuest(['/bin/cat', '/workspace/index.html'])).stdout).toBe('<!doctype html>site source\n');
      expect((await siteGuest(['/bin/sh', '-c', 'test -f /workspace/.git && echo file || echo other'])).stdout.trim()).toBe('file');
      expect((await siteGuest(['/bin/cat', '/workspace/.git'])).stdout).toBe('gitdir: /dev/null\n');
      // Read-only means read-only in the kernel, not just in the settings file.
      expect((await siteGuest(['/bin/sh', '-c', 'touch /workspace/should-fail 2>&1; true'])).stdout).toMatch(/Read-only file system/);

      // The ingress socket a publication binds inside the guest appears on the HOST side of the broker
      // mount, which is the only way the daemon's forwarder reaches it at all.
      // Not through `startPublication`: that transport is a project's in both runtimes and refuses a Site
      // by design. A Site's server is a unit inside its own guest, so this is one, written and started the
      // way the Site's image would, and it outlives the execution that started it.
      const publicationId = randomBytes(16).toString('hex');
      const service = `[Unit]\nDescription=proof ingress\n[Service]\nType=simple\nExecStart=/usr/bin/python3 -c "import socket,time; s=socket.socket(socket.AF_UNIX); s.bind('/run/elowen/${publicationId}.sock'); s.listen(1); time.sleep(600)"\n`;
      const unitName = `elowen-proof-ingress-${publicationId.slice(0, 12)}.service`;
      const wrote = await siteGuest(['/bin/sh', '-c',
        `cat >/etc/systemd/system/${unitName} <<'UNIT'\n${service}UNIT\nsystemctl daemon-reload && systemctl start ${unitName}`]);
      expect(wrote.code, wrote.stderr).toBe(0);
      const hostSocket = join(brokerDir, `${publicationId}.sock`);
      for (let attempt = 0; attempt < 50 && !existsSync(hostSocket); attempt++) await new Promise((resolve) => setTimeout(resolve, 200));
      expect(existsSync(hostSocket), `the ingress socket did not appear at ${hostSocket}`).toBe(true);
      expect(lstatSync(hostSocket).isSocket()).toBe(true);
      // Written by guest root through a rootidmap bind, so on the host it belongs to the service account.
      expect(lstatSync(hostSocket).uid).toBe(process.getuid!());
      measured.push(`site ingress socket appeared on the host side of the broker mount as ${hostSocket.split('/').pop()}`);
      const stopped = await siteGuest(['/bin/sh', '-c', `systemctl stop ${unitName} && systemctl is-active ${unitName} || true`]);
      expect(stopped.stdout.trim()).not.toBe('active');
    } finally {
      try { execFileSync('/usr/bin/systemctl', ['stop', siteUnit], { timeout: 120_000, stdio: 'ignore' }); } catch { /* already down */ }
      try { if (await siteClient.containerExists(siteSpec)) await siteClient.removeByName(siteSpec); } catch { /* gone */ }
    }
    const siteEnvelope = envelopePaths(siteSpec.name);
    expect(existsSync(siteEnvelope.nspawn)).toBe(false);
    expect(existsSync(siteEnvelope.dropIn)).toBe(false);
  }, 40 * 60_000);

  it('leaves the host with nothing of its own behind', async () => {
    try { await client.stop(spec); } catch { /* already down */ }
    try { if (await client.containerExists(spec)) await client.removeByName(spec); } catch { /* gone */ }
    await client.removeDiskPath(spec.storageRoot);
    if (existsSync(join(storageRoots!.sitesDataDir, SITE_ID))) await client.removeDiskPath(join(storageRoots!.sitesDataDir, SITE_ID));

    expect(machineList()).not.toContain(spec.name);
    expect(machineList()).not.toContain(SITE_ID);
    expect(existsSync(envelope.nspawn)).toBe(false);
    expect(existsSync(envelope.dropIn)).toBe(false);
    expect(existsSync(spec.storageRoot)).toBe(false);
    expect(existsSync(join(storageRoots!.sitesDataDir, SITE_ID))).toBe(false);
    // And nothing that was not this suite's went with it.
    expect(existsSync(storageRoots!.sandboxDataDir)).toBe(true);
    expect(existsSync(storageRoots!.sitesDataDir)).toBe(true);
    expect(podmanEnv().HOME).toBeTruthy();
  }, 15 * 60_000);
});
