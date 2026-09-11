import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBoundSiteSpec, createEnvironmentDiskSpec } from '../../plugins/sandbox/lib/containerSpec.mjs';
import { PROJECT_BASE_IMAGE_TAG } from '../../plugins/sandbox/lib/containerBaseImage.mjs';
import { PodmanClient } from '../../plugins/sandbox/lib/podman.mjs';
import { EXPECTED_CAPABILITY_BOUND, EXPECTED_SECCOMP_FILTERS, EXPECTED_SECCOMP_MODE, envelopePaths,
  HELPER_PATH, NspawnClient, unitFor } from '../../plugins/sandbox/lib/nspawn.mjs';

/** The real thing, on a real host, or nothing. Every fact this file asserts is a property of a running
 *  machine — its capability bound, its seccomp mode, what its binds do to file ownership, what its cgroup
 *  actually holds — and none of them can be established against a fake. So the suite refuses to run
 *  rather than to pretend, and says why. */
const POLKIT_RULE_PATH = '/etc/polkit-1/rules.d/49-elowen-nspawn.rules';
const blockers: string[] = [];
if (process.platform !== 'linux') blockers.push('the host is not Linux');
if (!existsSync('/usr/bin/systemd-nspawn')) blockers.push('systemd-container is not installed');
if (!existsSync(HELPER_PATH)) blockers.push('the privileged helper is not installed');
if (!existsSync(POLKIT_RULE_PATH)) blockers.push('the polkit rule is not present');
if (!blockers.length) {
  // The machine is built from the same image every environment is, so an unbuilt one is a reason to
  // skip rather than a fifteen-minute build inside a test.
  try { execFileSync('/usr/bin/podman', ['image', 'exists', PROJECT_BASE_IMAGE_TAG], { timeout: 60_000 }); }
  catch { blockers.push('the project base image is not built'); }
}
if (blockers.length) console.log(`nspawn machine proof skipped: ${blockers.join('; ')}`);

const cleanup: (() => void)[] = [];
afterAll(() => { for (const step of cleanup.splice(0)) step(); });

const podmanRun = (args: string[], timeout = 15 * 60_000) => execFileSync('/usr/bin/podman', args, { encoding: 'utf8', timeout });
const systemctlShow = (unit: string, property: string) =>
  execFileSync('/usr/bin/systemctl', ['show', unit, '-p', property, '--value'], { encoding: 'utf8', timeout: 30_000 }).trim();
const machineList = () => execFileSync('/usr/bin/machinectl', ['list', '--no-legend', '--no-pager'], { encoding: 'utf8', timeout: 30_000 });

describe.skipIf(blockers.length > 0)('systemd-nspawn machine, proved against a real host', () => {
  it('boots a throwaway machine and proves its persistence, isolation, limits and execution cost', async () => {
    const suffix = randomBytes(4).toString('hex');
    const siteId = `ns-test-${suffix}`;
    const root = mkdtempSync(join(tmpdir(), 'elowen-nspawn-proof-'));
    const sitesDataDir = join(root, 'sites');
    const sourcePath = join(root, 'sources', siteId);
    const brokerDir = join(root, 'brokers', siteId);
    for (const path of [sitesDataDir, sourcePath, brokerDir]) mkdirSync(path, { recursive: true });
    mkdirSync(join(sitesDataDir, siteId, 'environment', 'git-stub'), { recursive: true });
    const resource = { kind: 'site' as const, id: siteId };
    // The machine name is the specification name, which the polkit rule and the helper are both scoped
    // to. A throwaway still has to look like a real environment, so it is a site whose id carries the
    // marker this suite sweeps for.
    const disk = createEnvironmentDiskSpec({ resource, image: PROJECT_BASE_IMAGE_TAG, runtime: 'nspawn' },
      { sitesDataDir, namespace: 'elowen' }, randomBytes(16).toString('hex'));
    const spec: any = createBoundSiteSpec({ resource, generation: 1, image: PROJECT_BASE_IMAGE_TAG, disk,
      limits: { cpus: 0.75, memoryMb: 384, pidsLimit: 300 } }, { namespace: 'elowen', sitesDataDir, sourcePath, brokerDir });
    expect(spec.name).toBe(`elowen-site-${siteId}-g1`);
    const unit = unitFor(spec.name);
    const envelope = envelopePaths(spec.name);
    const images = new PodmanClient({ outputLimitBytes: 16 * 1024 * 1024 });
    const client = new NspawnClient({ images, outputLimitBytes: 16 * 1024 * 1024 });
    const guest = async (argv: string[]) => await client.exec(spec, randomBytes(16).toString('hex'), argv, { timeoutMs: 60_000, persistent: true });

    let removed = false;
    const destroy = () => {
      if (removed) return;
      removed = true;
      try { execFileSync('/usr/bin/systemctl', ['stop', unit], { timeout: 60_000 }); } catch { /* already down */ }
      for (const step of [
        async () => { if (await client.containerExists(spec)) await client.removeByName(spec); },
        async () => { await client.removeDiskPath(dirname(spec.disk.rootfsPath)); },
      ]) void step();
    };
    cleanup.push(() => { destroy(); rmSync(root, { recursive: true, force: true }); });

    try {
      // A machine needs a root filesystem, and the image is still the template one is made from. The
      // export is rootless; the helper is what extracts it as real root so the image's own uids land.
      const seed = `elowen-nsproof-${suffix}`;
      const archive = join(root, 'rootfs.tar');
      podmanRun(['create', '--name', seed, PROJECT_BASE_IMAGE_TAG]);
      try { podmanRun(['export', '--output', archive, seed]); } finally { podmanRun(['rm', '--force', seed]); }
      const pending = join(dirname(spec.disk.rootfsPath), 'rootfs');
      mkdirSync(pending, { recursive: true, mode: 0o755 });
      for (const component of spec.disk.components) mkdirSync(component.path, { recursive: true, mode: 0o700 });
      await client.extractRootfsArchive(spec, archive, pending);

      await client.create(spec);
      expect(await client.containerExists(spec)).toBe(true);
      await client.start(spec);
      await client.waitForSystemBus(spec, { timeoutMs: 120_000 });
      expect(['running', 'degraded']).toContain(await client.systemRunning(spec, { timeoutMs: 120_000 }));
      expect((await client.inspect(spec))!.state).toBe('running');
      expect(machineList()).toContain(spec.name);

      // Isolation. The guest is its own root over an unprivileged host range, it reaches no host
      // loopback service, and it can see nothing of the host filesystem.
      const status = await guest(['/bin/cat', '/proc/self/status']);
      const field = (name: string) => /^(\S+)/.exec(new RegExp(`^${name}:\\s+(.*)$`, 'm').exec(status.stdout)?.[1] ?? '')?.[1] ?? '';
      expect(BigInt(`0x${field('CapBnd')}`)).toBe(EXPECTED_CAPABILITY_BOUND);
      expect(Number(field('Seccomp'))).toBe(EXPECTED_SECCOMP_MODE);
      expect(Number(field('Seccomp_filters'))).toBe(EXPECTED_SECCOMP_FILTERS);
      expect((await guest(['/usr/bin/id', '-u'])).stdout.trim()).toBe('0');
      const loopback = await client.exec(spec, randomBytes(16).toString('hex'),
        ['/usr/bin/python3', '-c', "import socket,sys;s=socket.socket();s.settimeout(2);sys.exit(0 if s.connect_ex(('127.0.0.1',4400))==0 else 1)"],
        { timeoutMs: 30_000, persistent: true });
      expect(loopback.code).not.toBe(0);
      expect((await guest(['/bin/sh', '-c', 'ls /var/www 2>&1; true'])).stdout).toContain('No such file');

      // /tmp and /run are volatile, and the root filesystem is not an overlay.
      const filesystems = await guest(['/bin/sh', '-c', 'stat -f -c %T /tmp; stat -f -c %T /run; stat -f -c %T /']);
      const [tmpFs, runFs, rootFs] = filesystems.stdout.trim().split('\n');
      expect(tmpFs).toBe('tmpfs');
      expect(runFs).toBe('tmpfs');
      expect(rootFs).not.toBe('overlayfs');

      // A bind maps the guest's root onto the host owner of the source, which is the rootless-Podman
      // semantics every existing environment already depends on.
      await guest(['/bin/sh', '-c', 'printf bound >/data/ownership-proof']);
      const dataPath = join(spec.disk.components.find((entry: any) => entry.component === 'data')!.path, 'ownership-proof');
      expect(lstatSync(dataPath).uid).toBe(process.getuid!());

      // The limits the envelope declares are the ones the cgroup holds.
      const cgroup = join('/sys/fs/cgroup/machine.slice', `${unit}`);
      const read = (name: string) => execFileSync('/bin/cat', [join(cgroup, name)], { encoding: 'utf8', timeout: 15_000 }).trim();
      expect(read('cpu.max')).toBe('75000 100000');
      expect(read('memory.max')).toBe(String(384 * 1024 * 1024));
      expect(read('pids.max')).toBe('300');

      // The execution round trip, end to end and through the privileged helper: the design estimated it
      // from two separate measurements, so this is the figure that replaces the estimate.
      const samples: number[] = [];
      for (let run = 0; run < 20; run++) {
        const started = process.hrtime.bigint();
        await guest(['/bin/true']);
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)]!;
      console.log(`nspawn execution round trip: median ${median.toFixed(1)} ms, range ${samples[0]!.toFixed(1)}-${samples.at(-1)!.toFixed(1)} ms over ${samples.length} runs`);
      // Podman's measured median on this shape is 856 ms with a 225-1187 ms spread. The point of the
      // runtime is that this is not that, so the bound is the bottom of Podman's own range.
      expect(median).toBeLessThan(225);

      // Persistence: the disk outlives the envelope, which is disposable by design.
      await guest(['/bin/sh', '-c', 'printf kept >/etc/elowen-proof-marker']);
      await client.stop(spec);
      expect(systemctlShow(unit, 'Result')).toBe('success');
      expect(systemctlShow(unit, 'ExecMainStatus')).toBe('0');
      expect((await client.inspect(spec))!.state).toBe('stopped');
      await client.remove(spec);
      expect(await client.containerExists(spec)).toBe(false);

      await client.create(spec);
      await client.start(spec);
      await client.waitForSystemBus(spec, { timeoutMs: 120_000 });
      expect((await guest(['/bin/cat', '/etc/elowen-proof-marker'])).stdout).toBe('kept');
      expect((await guest(['/bin/cat', '/data/ownership-proof'])).stdout).toBe('bound');
      // A tmpfs does not survive, which is the other half of the same claim.
      expect((await guest(['/bin/sh', '-c', 'ls /tmp/ownership-proof 2>&1; true'])).stdout).toContain('No such file');

      await client.stop(spec);
      await client.remove(spec);
      await client.removeDiskPath(dirname(spec.disk.rootfsPath));
      removed = true;
    } finally {
      destroy();
    }

    // Everything this test created is gone: no machine, no unit envelope, no disk.
    expect(machineList()).not.toContain(spec.name);
    expect(existsSync(envelope.nspawn)).toBe(false);
    expect(existsSync(envelope.dropIn)).toBe(false);
    expect(existsSync(dirname(spec.disk.rootfsPath))).toBe(false);
  }, 20 * 60_000);
});
