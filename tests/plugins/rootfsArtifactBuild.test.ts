import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
// The build script is standalone ESM with no declaration file, like the other scripts pinned by tests.
// @ts-expect-error the root filesystem build script intentionally has no TypeScript declaration file
import {
  BUILD_TOOLS, ensureBuildTools, installHint, inspectPack, assertPack, installedPackages,
  missingBuildTools, onPath, readTar, releasePathFor, resolveRecipe, snapshotEpoch, verifyArtifacts,
} from '../../scripts/build-rootfs-artifact.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'elowen-rootfs-build-'));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const EPOCH = snapshotEpoch();

/** The recipe the fixtures are built against. Deliberately tiny and local: the inspection's job is to
 *  hold an archive to whatever recipe it was built from, and a fixture that had to carry Debian's
 *  `important` set could not be built in a test at all. */
const RECIPE = {
  name: 'fixture',
  directories: ['/workspace', '/data'],
  masked: ['getty.target'],
  enabled: ['systemd-networkd.service'],
};

type Shape = {
  rootMode?: string;
  directories?: string[];
  machineId?: string | null;
  masked?: boolean;
  enabled?: boolean;
  filler?: number;
  escapingLink?: boolean;
  deepName?: boolean;
};

/** A root filesystem as far as the inspection is concerned, laid out on disk and packed by real `tar`.
 *  No root and no network: every shape below is one an unprivileged user can create. */
function fixture(name: string, shape: Shape = {}, packFlags: string[] = []) {
  const tree = join(scratch, name);
  mkdirSync(join(tree, 'etc/systemd/system'), { recursive: true });
  for (const directory of shape.directories ?? ['/workspace', '/data']) {
    mkdirSync(join(tree, directory), { recursive: true });
  }
  if (shape.machineId !== null) writeFileSync(join(tree, 'etc/machine-id'), shape.machineId ?? '');
  if (shape.masked !== false) symlinkSync('/dev/null', join(tree, 'etc/systemd/system/getty.target'));
  if (shape.enabled !== false) {
    mkdirSync(join(tree, 'etc/systemd/system/multi-user.target.wants'), { recursive: true });
    symlinkSync(
      '/lib/systemd/system/systemd-networkd.service',
      join(tree, 'etc/systemd/system/multi-user.target.wants/systemd-networkd.service'),
    );
  }
  if (shape.filler) writeFileSync(join(tree, 'filler'), Buffer.alloc(shape.filler, 0x61));
  if (shape.escapingLink) symlinkSync('../../../etc/shadow', join(tree, 'etc/escape'));
  if (shape.deepName) {
    const deep = join(tree, 'usr/share', 'a'.repeat(90), 'b'.repeat(90));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'c'.repeat(60)), 'long');
  }
  execFileSync('chmod', [shape.rootMode ?? '0755', tree]);

  const archive = join(scratch, `${name}.tar`);
  execFileSync('tar', [
    '--create', '--file', archive, '--directory', tree,
    '--format=gnu', '--sort=name', `--mtime=@${EPOCH}`, '--numeric-owner',
    '--no-acls', '--no-selinux', '--no-xattrs',
    ...packFlags, '.',
  ]);
  return archive;
}

async function entriesOf(archive: string) {
  const { entries } = await readTar(createReadStream(archive));
  return entries;
}

const codes = (report: { problems: { code: string }[] }) => report.problems.map((item) => item.code).sort();

describe('root filesystem pack inspection', () => {
  it('passes an archive that is actually a usable machine root', async () => {
    const report = inspectPack(await entriesOf(fixture('good')), RECIPE, { sourceDateEpoch: EPOCH });
    expect(report.problems).toEqual([]);
    expect(report.memberCount).toBeGreaterThan(0);
    expect(report.unpackedBytes).toBe(0);
  });

  it('refuses a root narrower than 0755', async () => {
    // A 0700 root member rewrites the mode of the directory it is unpacked into, and what that costs
    // inside the machine looks nothing like a permission problem: dbus-daemon drops to `messagebus`,
    // stops being able to resolve any path, never signals readiness and restarts forever.
    const report = inspectPack(await entriesOf(fixture('narrow-root', { rootMode: '0700' })), RECIPE, {});
    expect(codes(report)).toEqual(['root_mode']);
    expect(report.problems[0].detail).toContain('0700');
  });

  it('refuses an archive missing a directory the recipe declares', async () => {
    const report = inspectPack(await entriesOf(fixture('no-data', { directories: ['/workspace'] })), RECIPE, {});
    expect(codes(report)).toEqual(['missing_directory']);
    expect(report.problems[0].detail).toBe('/data');
  });

  it('refuses a relative symlink that climbs out of the tree', async () => {
    const report = inspectPack(await entriesOf(fixture('escape', { escapingLink: true })), RECIPE, {});
    expect(codes(report)).toEqual(['symlink_escapes']);
    expect(report.problems[0].detail).toContain('../../../etc/shadow');
  });

  it('accepts an absolute symlink, which is how a root filesystem points at itself', async () => {
    // `/usr/bin/awk -> /etc/alternatives/awk` is in every Debian tree. Resolved against the archive
    // root, an absolute target is inside by construction; rejecting them would fail every real build.
    const entries = await entriesOf(fixture('absolute-links'));
    const masked = entries.find((entry: { name: string }) => entry.name.endsWith('getty.target'));
    expect(masked).toMatchObject({ type: 'symlink', linkName: '/dev/null' });
    expect(inspectPack(entries, RECIPE, {}).problems).toEqual([]);
  });

  it('refuses an archive whose unpacked size passes the bound', async () => {
    const entries = await entriesOf(fixture('big', { filler: 4096 }));
    expect(inspectPack(entries, RECIPE, { maxBytes: 1024 }).problems.map((item: { code: string }) => item.code))
      .toContain('too_large');
    expect(inspectPack(entries, RECIPE, { maxBytes: 1024 * 1024 }).problems).toEqual([]);
  });

  it('refuses a device node the recipe never asked for', async () => {
    // Appended to the members of a real archive rather than laid out on disk, because creating a
    // character device needs root and a test must not. The recipes declare no devices, so a tree that
    // carries any was built somewhere it could call mknod, and systemd-nspawn supplies /dev itself.
    const entries = await entriesOf(fixture('devices'));
    for (const type of ['char', 'block', 'fifo']) {
      const node = {
        name: `./dev/${type}-one`, type, mode: 0o600, uid: 0, gid: 0, size: 0, mtime: EPOCH, uname: '', gname: '', linkName: '',
      };
      // Kept in name order, so the sortedness check stays out of this one's way.
      const combined = [...entries, node].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      const report = inspectPack(combined, RECIPE, {});
      expect(codes(report), type).toEqual(['device_node']);
      expect(report.problems[0].detail).toContain(type);
    }
  });

  it('refuses a machine-id that is absent or already populated', async () => {
    expect(codes(inspectPack(await entriesOf(fixture('no-id', { machineId: null })), RECIPE, {})))
      .toEqual(['machine_id_missing']);
    // A populated file gives every machine on every host the same identity and puts a random value
    // into the digest.
    const populated = inspectPack(await entriesOf(fixture('set-id', { machineId: 'b9b0f2a1\n' })), RECIPE, {});
    expect(codes(populated)).toEqual(['machine_id_not_empty']);
  });

  it('refuses units the recipe declares that the tree does not mask or enable', async () => {
    const report = inspectPack(await entriesOf(fixture('no-units', { masked: false, enabled: false })), RECIPE, {});
    expect(codes(report)).toEqual(['unit_not_enabled', 'unit_not_masked']);
  });

  it('refuses members stamped after the build epoch, and owner names resolved on the build host', async () => {
    const late = fixture('late', {}, [`--mtime=@${EPOCH + 3600}`]);
    expect(codes(inspectPack(await entriesOf(late), RECIPE, { sourceDateEpoch: EPOCH })))
      .toContain('mtime_not_clamped');
    // Packed without --numeric-owner, so tar writes the build host's account names into every header.
    const named = join(scratch, 'named.tar');
    execFileSync('tar', [
      '--create', '--file', named, '--directory', join(scratch, 'good'),
      '--format=gnu', '--sort=name', `--mtime=@${EPOCH}`, '.',
    ]);
    expect(codes(inspectPack(await entriesOf(named), RECIPE, {}))).toContain('owner_name_recorded');
  });

  it('refuses members that are not in ascending name order', async () => {
    const tree = join(scratch, 'unsorted');
    mkdirSync(tree, { recursive: true });
    for (const name of ['a', 'b']) writeFileSync(join(tree, name), name);
    const archive = join(scratch, 'unsorted.tar');
    // Named in reverse with recursion off, which is what an archiver without --sort can produce.
    execFileSync('tar', [
      '--create', '--file', archive, '--directory', tree, '--no-recursion',
      '--format=gnu', `--mtime=@${EPOCH}`, '--numeric-owner', './b', './a',
    ]);
    expect(codes(inspectPack(await entriesOf(archive), RECIPE, {}))).toContain('unsorted');
  });

  it('stops the build on any problem rather than pinning what it found', async () => {
    const entries = await entriesOf(fixture('assert-me', { rootMode: '0700', directories: [] }));
    expect(() => assertPack(entries, RECIPE, {})).toThrow(/not usable as a machine root/);
    try { assertPack(entries, RECIPE, {}); } catch (cause) {
      expect((cause as { code?: string }).code).toBe('pack_inspection_failed');
      expect((cause as { problems: { code: string }[] }).problems.map((item) => item.code))
        .toEqual(expect.arrayContaining(['root_mode', 'missing_directory']));
    }
  });
});

describe('archive reader', () => {
  it('reads names past the 100-byte header field', async () => {
    const entries = await entriesOf(fixture('long-names', { deepName: true }));
    const deep = entries.find((entry: { name: string }) => entry.name.includes('c'.repeat(60)));
    expect(deep?.name.length).toBeGreaterThan(200);
    expect(deep).toMatchObject({ type: 'file', size: 4 });
  });

  it('reads a pax archive, which is the format mmdebstrap writes', async () => {
    const tree = join(scratch, 'good');
    const archive = join(scratch, 'pax.tar');
    execFileSync('tar', [
      '--create', '--file', archive, '--directory', tree,
      '--format=posix', '--sort=name', `--mtime=@${EPOCH}`, '--numeric-owner', '.',
    ]);
    const entries = await entriesOf(archive);
    // The pax metadata members themselves must not surface as members of the root filesystem.
    expect(entries.some((entry: { name: string }) => entry.name.includes('PaxHeader'))).toBe(false);
    expect(inspectPack(entries, RECIPE, { sourceDateEpoch: EPOCH }).problems).toEqual([]);
  });

  it('captures only the members it is asked for', async () => {
    const tree = join(scratch, 'capture');
    mkdirSync(join(tree, 'var/lib/dpkg'), { recursive: true });
    mkdirSync(join(tree, 'etc/systemd/system'), { recursive: true });
    writeFileSync(join(tree, 'var/lib/dpkg/status'), 'Package: bash\nStatus: install ok installed\nVersion: 5.2.15-2\n');
    writeFileSync(join(tree, 'other'), 'not captured');
    const archive = join(scratch, 'capture.tar');
    execFileSync('tar', ['--create', '--file', archive, '--directory', tree, '--format=gnu', '--sort=name', '--numeric-owner', '.']);

    const { captured } = await readTar(createReadStream(archive), {
      capture: (name: string) => name.endsWith('var/lib/dpkg/status'),
    });
    expect([...captured.keys()]).toEqual(['./var/lib/dpkg/status']);
    expect(installedPackages(captured.get('./var/lib/dpkg/status'))).toEqual([{ name: 'bash', version: '5.2.15-2' }]);
  });
});

describe('installed package provenance', () => {
  it('reads what the archive actually shipped, and skips what is not installed', () => {
    const status = Buffer.from([
      'Package: systemd\nStatus: install ok installed\nVersion: 252.38-1~deb12u1\n',
      'Package: removed-thing\nStatus: deinstall ok config-files\nVersion: 1.0\n',
      'Package: dbus\nStatus: install ok installed\nVersion: 1.14.10-1~deb12u1\nDescription: a bus\n Continued line: Version: lies\n',
    ].join('\n'));
    expect(installedPackages(status)).toEqual([
      { name: 'dbus', version: '1.14.10-1~deb12u1' },
      { name: 'systemd', version: '252.38-1~deb12u1' },
    ]);
    expect(installedPackages(undefined)).toEqual([]);
  });
});

describe('recipe resolution', () => {
  it('folds a base into one complete root filesystem rather than a layer', () => {
    const base = resolveRecipe('site-base');
    const layered = resolveRecipe('site-static');
    expect(layered.base).toBe('site-base');
    // Every package of the base plus its own, in one tree, because a host unpacks exactly one tarball.
    for (const name of base.packages) expect(layered.packages).toContain(name);
    expect(layered.packages).toContain('nginx-light');
    expect(layered.suite).toBe(base.suite);
    expect(layered.variant).toBe(base.variant);
    expect(layered.directories).toEqual(base.directories);
    // The revision stays the recipe's own, because that is what `site-static@1` names.
    expect(layered.version).toBe(1);
  });

  it('takes Node from whichever recipe declares it and writes no checksum of its own', () => {
    expect(resolveRecipe('site-node').node).toEqual({ version: '24.8.0' });
    expect(resolveRecipe('site-static').node).toBeNull();
    expect(resolveRecipe('project-base').node).toEqual({ version: '24.8.0' });
    // A checksum in the catalogue is one nobody re-derives; the build verifies against SHASUMS256.txt.
    expect(Object.keys(resolveRecipe('project-base').node)).toEqual(['version']);
  });
});

describe('host dependencies', () => {
  it('names the missing tool and the command that installs it, rather than half-building', () => {
    const absent = missingBuildTools((command: string) => command !== 'mmdebstrap');
    expect(absent.map((tool: { command: string }) => tool.command)).toEqual(['mmdebstrap']);
    expect(installHint(absent)).toBe('sudo apt-get install -y mmdebstrap');
    expect(installHint(BUILD_TOOLS)).toBe('sudo apt-get install -y gzip mmdebstrap systemd tar uidmap');
    expect(missingBuildTools(() => true)).toEqual([]);
  });

  it('refuses to start a build it cannot finish, with a code the caller can act on', () => {
    expect(() => ensureBuildTools(() => true)).not.toThrow();
    try {
      ensureBuildTools((command: string) => command !== 'mmdebstrap');
      expect.unreachable('a missing build tool must refuse');
    } catch (cause) {
      expect((cause as { code?: string }).code).toBe('missing_build_tools');
      expect((cause as Error).message).toContain('mmdebstrap is not installed');
      expect((cause as Error).message).toContain('sudo apt-get install -y mmdebstrap');
    }
  });

  it('resolves a command only where it is executable', () => {
    expect(onPath('sh')).toBe(true);
    expect(onPath('a-command-this-host-has-not-got')).toBe(false);
    expect(onPath('sh', '')).toBe(false);
  });
});

describe('rebuild verification', () => {
  const pins = {
    'project-base@1': { digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 1024, path: releasePathFor('project-base', 1) },
    'site-base@1': { digest: null, sizeBytes: null, path: releasePathFor('site-base', 1) },
    'site-static@1': { digest: `sha256:${'c'.repeat(64)}`, sizeBytes: 99, path: releasePathFor('site-static', 1) },
    'site-node@1': { digest: null, sizeBytes: null, path: releasePathFor('site-node', 1) },
  };

  it('passes when a rebuild reproduces the pinned bytes', async () => {
    const build = vi.fn(async () => ({ digest: pins['project-base@1'].digest, sizeBytes: 1024 }));
    const result = await verifyArtifacts({ names: ['project-base'], pins, build });
    expect(result.ok).toBe(true);
    expect(result.matched).toEqual([{ reference: 'project-base@1', digest: pins['project-base@1'].digest }]);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('fails when a rebuild produces anything else', async () => {
    const build = vi.fn(async () => ({ digest: `sha256:${'b'.repeat(64)}`, sizeBytes: 2048, treeDigest: `sha256:${'d'.repeat(64)}` }));
    const result = await verifyArtifacts({ names: ['project-base'], pins, build });
    expect(result.ok).toBe(false);
    expect(result.differing).toEqual([{
      reference: 'project-base@1',
      pinned: { digest: pins['project-base@1'].digest, sizeBytes: 1024 },
      built: { digest: `sha256:${'b'.repeat(64)}`, sizeBytes: 2048 },
      treeDigest: `sha256:${'d'.repeat(64)}`,
    }]);
  });

  it('fails on a length that differs even when the digest is quoted back correctly', async () => {
    const build = vi.fn(async () => ({ digest: pins['project-base@1'].digest, sizeBytes: 7 }));
    expect((await verifyArtifacts({ names: ['project-base'], pins, build })).ok).toBe(false);
  });

  it('skips an unpublished pin instead of failing, and never builds one', async () => {
    // This is the shipped catalogue's own state before the first release. Failing here would mean
    // --verify could not pass until something was published, which is exactly backwards.
    const build = vi.fn(async () => ({ digest: `sha256:${'e'.repeat(64)}`, sizeBytes: 1 }));
    const result = await verifyArtifacts({ names: ['site-base', 'site-node'], pins, build });
    expect(result.ok).toBe(true);
    expect(result.unpublished.map((item: { reference: string }) => item.reference)).toEqual(['site-base@1', 'site-node@1']);
    expect(build).not.toHaveBeenCalled();
  });

  it('fails when the pin file carries no entry for a recipe at all', async () => {
    const build = vi.fn(async () => ({ digest: `sha256:${'f'.repeat(64)}`, sizeBytes: 1 }));
    const result = await verifyArtifacts({ names: ['project-base'], pins: {}, build });
    expect(result.ok).toBe(false);
    expect(result.missing.map((item: { reference: string }) => item.reference)).toEqual(['project-base@1']);
    expect(build).not.toHaveBeenCalled();
  });

  it('reports every recipe in one pass rather than stopping at the first difference', async () => {
    const build = vi.fn(async (name: string) => ({
      digest: name === 'project-base' ? pins['project-base@1'].digest : `sha256:${'9'.repeat(64)}`,
      sizeBytes: name === 'project-base' ? 1024 : 5,
    }));
    const result = await verifyArtifacts({ names: ['project-base', 'site-static'], pins, build });
    expect(result.matched).toHaveLength(1);
    expect(result.differing).toHaveLength(1);
    expect(result.ok).toBe(false);
  });
});
