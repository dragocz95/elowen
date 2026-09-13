import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { closeSync, cpSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertContainerSpec, hostPath, resourceToken } from './containerSpec.mjs';
import { checkedHostPath } from './containerPaths.mjs';
import { selectRuntimeClient } from './runtimeClient.mjs';

/** Every entry below one root, including file content rather than only its size. This is the proof that
 *  a cross-filesystem copy may replace the source tree. */
async function inventoryOf(root) {
  const entries = [];
  const walk = async (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (stat.isDirectory()) {
        entries.push(`${relative}/`);
        await walk(path, relative);
      } else if (stat.isSymbolicLink()) entries.push(`${relative} -> ${readlinkSync(path)}`);
      else if (stat.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        entries.push(`${relative} ${stat.size} ${hash.digest('hex')}`);
      } else throw new Error(`Unsupported file type in project workspace: ${relative}`);
    }
  };
  await walk(root, '');
  return entries;
}
/** What the same tree would occupy somewhere else, counting a symlink as the name it carries. */
function bytesIn(root) {
  let total = 0;
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path); else total += stat.size;
    }
  };
  walk(root);
  return total;
}

/** The mode of a guest root filesystem's own root directory. Privacy of an environment's storage comes
 *  from the disk and snapshot directories ABOVE this one, which the daemon owns at 0700; the root of the
 *  tree a container boots has to stay traversable, because every guest service that drops privileges —
 *  `dbus-daemon` becoming `messagebus` first among them — cannot reach a single file through a `/` the
 *  daemon kept to itself, and systemd then waits for a bus that never answers. Both base images carry
 *  0755 here, and neither a tar extraction nor `cp -a` of a tree's CONTENTS changes the mode of the
 *  directory it is extracted into. */
const ROOTFS_MODE = 0o755;
const COMPONENT_MODE = 0o700;

/** What one entry of a snapshot's tree inventory carries, in order. It is recorded in every snapshot
 *  manifest, so it is the manifest's own statement of what its digests were taken over — and it is the
 *  shape the privileged helper's `inventory()` actually emits. The two are held together by
 *  `tests/contract/nspawnHelper.test.ts`; changing either without the other silently changes what a
 *  fingerprint means. */
export const SNAPSHOT_TREE_FORMAT = 'inventory-v1:path,type,size,uid,gid,mode,mtimeNs,hardlink,xattrs,linkTarget';

function syncPath(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeDurable(path, content) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(content)); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncTree(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) syncTree(path);
    else if (!stat.isSymbolicLink()) syncPath(path);
  }
  syncPath(root);
}
function absent(path) {
  try { lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Storage destination already exists; resume through lifecycle recovery');
}

/** Every field of a disk record that ties it to ONE environment, ONE generation and ONE set of trees.
 *  The published root filesystem reference is checked beside this shared structural identity. */
function diskOwnershipMismatch(manifest, spec) {
  return manifest.diskId !== spec.disk.id || manifest.format !== 2 || manifest.resource?.kind !== spec.resource.kind
    || manifest.resource?.id !== spec.resource.id || manifest.rootfsPath !== spec.disk.rootfsPath
    || JSON.stringify(manifest.components) !== JSON.stringify(spec.disk.components) || !manifest.materialized;
}
/** Component primitives only. The daemon lifecycle owner must hold its resource queue and prevent new
 * execution leases throughout snapshot/restore. Incomplete directories are durable recovery evidence,
 * not garbage to delete on retry. No guest archive is ever extracted by a host shell or host tar. */
export class ContainerStorage {
  #clients;
  constructor(nspawn) {
    this.#clients = { nspawn };
  }

  /** Which runtime owns the trees of this specification. Every primitive below names the specification it
   *  is acting for, so the disk record decides the driver rather than a field on this object — and a row
   *  this release cannot drive is refused here by name instead of being acted on. */
  #driver(spec) { return selectRuntimeClient(spec, this.#clients); }

  async prepare(spec, options = {}) {
    assertContainerSpec(spec);
    checkedHostPath(spec.storageRoot, { create: true });
    for (const mount of spec.mounts.filter((entry) => entry.type === 'bind')) checkedHostPath(mount.source, { create: true });
    if (!spec.disk) throw new Error('An environment without a persistent disk cannot be prepared');
    return await this.#prepareDisk(spec, options);
  }

  /** Fill the pending root filesystem from the published artifact its disk record names, then prove it,
   *  fsync it, activate it atomically and write its durable manifest. */
  async #prepareDisk(spec, options = {}) {
    const directory = checkedHostPath(dirname(spec.disk.rootfsPath), { create: true });
    const manifestPath = join(directory, 'disk.json');
    const pendingManifestPath = join(directory, 'disk.pending');
    const validateManifest = (manifest) => {
      if (diskOwnershipMismatch(manifest, spec) || manifest.sourceImage !== spec.disk.sourceImage) throw new Error('Environment disk manifest ownership mismatch');
      return manifest;
    };
    const readManifest = (path) => {
      try { return validateManifest(JSON.parse(readFileSync(checkedHostPath(path, { file: true }), 'utf8'))); }
      catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
    };
    const manifest = readManifest(manifestPath);
    if (manifest) {
      try {
        checkedHostPath(spec.disk.rootfsPath);
        for (const component of spec.disk.components) checkedHostPath(component.path);
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw cause;
        const missing = new Error('The persistent environment disk is missing; restore a snapshot explicitly');
        missing.code = 'disk_missing';
        throw missing;
      }
      return;
    }
    const pending = join(directory, 'rootfs.pending');
    const pendingManifest = readManifest(pendingManifestPath);
    if (pendingManifest) {
      let rootfsExists = true;
      try { checkedHostPath(spec.disk.rootfsPath); }
      catch (cause) { if (cause.code === 'ENOENT') rootfsExists = false; else throw cause; }
      if (rootfsExists) {
        try { for (const component of spec.disk.components) checkedHostPath(component.path); }
        catch (cause) {
          if (cause.code !== 'ENOENT') throw cause;
          const missing = new Error('The persistent environment disk is missing; restore a snapshot explicitly');
          missing.code = 'disk_missing';
          throw missing;
        }
        renameSync(pendingManifestPath, manifestPath);
        syncPath(directory);
        return;
      }
      unlinkSync(pendingManifestPath);
      syncPath(directory);
      try { checkedHostPath(pending); await this.#driver(spec).removeDiskPath(pending); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
    try {
      checkedHostPath(spec.disk.rootfsPath);
      const missing = new Error('The persistent rootfs exists without its durable disk record; restore a snapshot explicitly');
      missing.code = 'disk_record_missing';
      throw missing;
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    try { checkedHostPath(pending); await this.#driver(spec).removeDiskPath(pending); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    mkdirSync(pending, { mode: ROOTFS_MODE });
    for (const component of spec.disk.components) checkedHostPath(component.path, { create: true });
    let filled;
    try {
      filled = { sourceImageId: await this.#driver(spec).materializeRootfs(spec, pending, options) };
    } catch (cause) {
      // An incomplete tree is never activated — no manifest names it — so keeping it buys no recovery
      // evidence and holds a whole root filesystem of space that the retry, and every other environment
      // on the host, needs. The export archive is kept: that one IS the resumable receipt.
      try { await this.#driver(spec).removeDiskPath(pending); syncPath(directory); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], `${cause.message}; incomplete rootfs cleanup failed: ${cleanup.message}`); }
      throw cause;
    }
    const { sourceImageId, ...provenance } = filled;
    await this.#driver(spec).syncDiskTree(pending);
    writeDurable(pendingManifestPath, { resource: spec.resource, diskId: spec.disk.id, format: 2, sourceImage: spec.disk.sourceImage,
      sourceImageId, rootfsPath: spec.disk.rootfsPath, components: spec.disk.components, createdAt: new Date().toISOString(), ...provenance, materialized: true });
    syncPath(directory);
    renameSync(pending, spec.disk.rootfsPath);
    syncPath(directory);
    renameSync(pendingManifestPath, manifestPath);
    syncPath(directory);
  }

  /** Bring a HOST project's directory into the project's own workspace volume, once. Core's
   *  `ProjectStore.adoptAsManaged` records where the directory came from and leaves it there; this is the
   *  one moment it becomes the environment's workspace, so it runs before the first container exists and
   *  does nothing at all on every start after that — a volume that is not empty has already been served.
   *
   *  On one filesystem the rename is atomic and free. Across filesystems the tree is copied, free space
   *  being established from the destination's own figures first, and the copy is verified entry by entry
   *  before the project is allowed to start on it; a copy that fails or differs is removed again so the
   *  next start retries from the untouched original instead of serving half a workspace. */
  async adoptWorkspace(spec, sourcePath) {
    assertContainerSpec(spec);
    if (spec.resource.kind !== 'project') throw new Error('Only a project owns a workspace volume');
    const source = hostPath(sourcePath);
    const target = checkedHostPath(spec.volumes.find((volume) => volume.component === 'workspace').path, { create: true });
    if (readdirSync(target).length) {
      try { checkedHostPath(source); }
      catch (cause) { if (cause.code === 'ENOENT') return false; throw cause; }
      const expected = await inventoryOf(source);
      const copied = await inventoryOf(target);
      if (JSON.stringify(copied) !== JSON.stringify(expected)) throw new Error('The adopted project source differs from the workspace volume');
      rmSync(source, { recursive: true });
      syncPath(dirname(source));
      return false;
    }
    let entries;
    try { checkedHostPath(source); entries = readdirSync(source); }
    catch (cause) {
      if (cause.code === 'ENOENT') throw new Error(`The adopted project directory ${source} is missing`);
      throw cause;
    }
    if (!entries.length) return false;
    rmdirSync(target);
    try {
      renameSync(source, target);
      syncPath(dirname(target));
      syncPath(dirname(source));
      return true;
    } catch (cause) {
      if (cause.code !== 'EXDEV') {
        checkedHostPath(target, { create: true });
        throw cause;
      }
    }
    const required = bytesIn(source);
    const filesystem = statfsSync(dirname(target));
    const free = filesystem.bavail * filesystem.bsize;
    if (free < required) {
      checkedHostPath(target, { create: true });
      throw new Error(`The project workspace volume needs ${required} bytes of free space and has ${free}`);
    }
    const staging = `${target}.adopting`;
    try {
      try { checkedHostPath(staging); rmSync(staging, { recursive: true }); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      checkedHostPath(staging, { create: true });
      const expected = await inventoryOf(source);
      for (const name of entries) cpSync(join(source, name), join(staging, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      const copied = await inventoryOf(staging);
      const current = await inventoryOf(source);
      if (JSON.stringify(copied) !== JSON.stringify(expected) || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('The adopted directory changed while it was being copied');
      syncTree(staging);
      renameSync(staging, target);
      syncPath(dirname(target));
      rmSync(source, { recursive: true });
      syncPath(dirname(source));
      return true;
    } catch (cause) {
      try { checkedHostPath(staging); rmSync(staging, { recursive: true }); }
      catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([cause, cleanup], `${cause.message}; adoption staging cleanup failed: ${cleanup.message}`); }
      checkedHostPath(target, { create: true });
      throw cause;
    }
  }

  /** Move the current workspace back to the host path recorded by core after the environment owner has
   *  removed every container that could still write to it. */
  async releaseWorkspace(spec, targetPath) {
    assertContainerSpec(spec);
    if (spec.resource.kind !== 'project') throw new Error('Only a project owns a workspace volume');
    const source = spec.volumes.find((volume) => volume.component === 'workspace').path;
    const target = hostPath(targetPath);
    checkedHostPath(dirname(target));
    try {
      checkedHostPath(target);
      try { checkedHostPath(source); }
      catch (cause) { if (cause.code === 'ENOENT') return false; throw cause; }
      if (readdirSync(target).length) throw new Error('The adopted project path is no longer empty');
      rmdirSync(target);
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    checkedHostPath(source);
    try {
      renameSync(source, target);
      syncPath(dirname(target));
      syncPath(dirname(source));
      return true;
    } catch (cause) { if (cause.code !== 'EXDEV') throw cause; }
    const required = bytesIn(source);
    const filesystem = statfsSync(dirname(target));
    const free = filesystem.bavail * filesystem.bsize;
    if (free < required) throw new Error(`The original project path needs ${required} bytes of free space and has ${free}`);
    const staging = `${target}.releasing`;
    try {
      try { checkedHostPath(staging); rmSync(staging, { recursive: true }); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      checkedHostPath(staging, { create: true });
      const entries = readdirSync(source);
      const expected = await inventoryOf(source);
      for (const name of entries) cpSync(join(source, name), join(staging, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      const copied = await inventoryOf(staging);
      const current = await inventoryOf(source);
      if (JSON.stringify(copied) !== JSON.stringify(expected) || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('The project workspace changed while it was being released');
      syncTree(staging);
      renameSync(staging, target);
      syncPath(dirname(target));
      rmSync(source, { recursive: true });
      syncPath(dirname(source));
      return true;
    } catch (cause) {
      try { checkedHostPath(staging); rmSync(staging, { recursive: true }); }
      catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([cause, cleanup], `${cause.message}; release staging cleanup failed: ${cleanup.message}`); }
      throw cause;
    }
  }

  async snapshot(spec, snapshotId) {
    assertContainerSpec(spec);
    resourceToken(snapshotId);
    if (!spec.disk) throw new Error('An environment without a persistent disk cannot be snapshotted');
    return await this.#snapshotDisk(spec, snapshotId);
  }

  async #snapshotDisk(spec, snapshotId) {
    const parent = checkedHostPath(join(spec.storageRoot, 'snapshots'), { create: true });
    const directory = join(parent, snapshotId);
    try {
      checkedHostPath(join(directory, 'manifest.json'), { file: true });
      const manifest = await this.readSnapshot(spec, snapshotId);
      try { unlinkSync(join(directory, 'pending.json')); syncPath(directory); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      return manifest;
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    try {
      checkedHostPath(directory);
      const pending = JSON.parse(readFileSync(checkedHostPath(join(directory, 'pending.json'), { file: true }), 'utf8'));
      if (pending.resumeRunning && (await this.#driver(spec).inspect(spec))?.state === 'paused') await this.#driver(spec).unpause(spec);
      await this.#driver(spec).removeDiskPath(directory);
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    absent(directory);
    const row = await this.#driver(spec).inspect(spec);
    if (!row || !['running', 'stopped', 'exited', 'created'].includes(row.state)) throw new Error('Container cannot be quiesced for snapshot');
    checkedHostPath(directory, { create: true });
    writeDurable(join(directory, 'pending.json'), { snapshotId, resource: spec.resource, generation: spec.generation, specHash: spec.specHash, resumeRunning: row.state === 'running' });
    syncPath(directory); syncPath(parent);
    const diskManifest = JSON.parse(readFileSync(checkedHostPath(join(dirname(spec.disk.rootfsPath), 'disk.json'), { file: true }), 'utf8'));
    const sources = [{ component: 'rootfs', path: spec.disk.rootfsPath }, ...spec.disk.components];
    await this.#driver(spec).preflightDiskCopy(sources.map((entry) => entry.path), parent);
    const manifest = { version: 2, snapshotId, resource: spec.resource, generation: spec.generation, diskId: spec.disk.id,
      specHash: spec.specHash, consistency: 'crash-consistent', completeProject: spec.resource.kind === 'project',
      treeFormat: SNAPSHOT_TREE_FORMAT,
      sourceImage: { reference: spec.disk.sourceImage, id: diskManifest.sourceImageId }, trees: [] };
    const failures = [];
    let paused = false;
    try {
      if (row.state === 'running') { await this.#driver(spec).pause(spec); paused = true; }
      for (const source of sources) {
        const target = join(directory, source.component);
        mkdirSync(target, { mode: source.component === 'rootfs' ? ROOTFS_MODE : COMPONENT_MODE });
        await this.#driver(spec).copyDiskTree(source.path, target);
        await this.#driver(spec).syncDiskTree(target);
        manifest.trees.push({ component: source.component, path: target, ...await this.#driver(spec).fingerprintDiskTree(target) });
      }
      syncPath(directory);
    } catch (error) { failures.push(error); }
    finally {
      if (row.state === 'running') {
        try { if (paused || (await this.#driver(spec).inspect(spec))?.state === 'paused') await this.#driver(spec).unpause(spec); }
        catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join('; '));
    writeDurable(join(directory, 'manifest.pending'), manifest);
    renameSync(join(directory, 'manifest.pending'), join(directory, 'manifest.json'));
    syncPath(directory); unlinkSync(join(directory, 'pending.json')); syncPath(directory);
    return manifest;
  }

  async restoreVolumes(sourceSpec, snapshotId, targetSpec) {
    assertContainerSpec(targetSpec);
    const manifest = await this.readSnapshot(sourceSpec, snapshotId);
    return await this.#restoreDiskSnapshot(sourceSpec, snapshotId, targetSpec, manifest);
  }

  async #restoreDiskSnapshot(sourceSpec, snapshotId, targetSpec, manifest) {
    if (!sourceSpec.disk || !targetSpec.disk || sourceSpec.resource.kind !== targetSpec.resource.kind
      || (sourceSpec.resource.id === targetSpec.resource.id && sourceSpec.generation === targetSpec.generation)) throw new Error('Disk restore needs a new rootfs-backed generation');
    const directory = checkedHostPath(join(targetSpec.storageRoot, 'restores', String(targetSpec.generation)), { create: true });
    const journal = join(directory, 'pending.json');
    const expected = { snapshotId, source: sourceSpec.resource, sourceGeneration: sourceSpec.generation,
      target: targetSpec.resource, targetGeneration: targetSpec.generation, targetDiskId: targetSpec.disk.id, targetSpecHash: targetSpec.specHash };
    const read = (path) => { try { return JSON.parse(readFileSync(checkedHostPath(path, { file: true }), 'utf8')); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; } };
    const complete = read(join(directory, 'complete.json'));
    if (complete) {
      if (JSON.stringify(complete) !== JSON.stringify({ ...expected, sourceImage: manifest.sourceImage })) throw new Error('Restore completion ownership mismatch');
      return manifest;
    }
    const previous = read(journal);
    if (previous && JSON.stringify(previous) !== JSON.stringify(expected)) throw new Error('Restore checkpoint ownership mismatch');
    const diskDirectory = checkedHostPath(dirname(targetSpec.disk.rootfsPath), { create: true });
    if (!previous) { writeDurable(journal, expected); syncPath(directory); }
    const targets = new Map([['rootfs', targetSpec.disk.rootfsPath], ...targetSpec.disk.components.map((entry) => [entry.component, entry.path])]);
    const trees = [...manifest.trees];
    const missing = [...targets.keys()].filter((component) => !trees.some((tree) => tree.component === component));
    if (missing.length) throw new Error('Restore requires every disk tree');
    if (trees.length !== targets.size || trees.some((tree) => !targets.has(tree.component))) throw new Error('Snapshot tree does not belong to the restore target');
    await this.#driver(targetSpec).preflightDiskCopy(trees.map((tree) => tree.path), diskDirectory);
    for (const tree of trees) {
      const target = targets.get(tree.component);
      const receiptPath = join(directory, `${tree.component}.json`);
      const receipt = read(receiptPath);
      if (receipt) {
        if (JSON.stringify(receipt) !== JSON.stringify(tree)) throw new Error('Restore tree checkpoint mismatch');
        checkedHostPath(target);
        continue;
      }
      try {
        checkedHostPath(target);
        const copied = await this.#driver(targetSpec).fingerprintDiskTree(target);
        if (copied.digest !== tree.digest || copied.logicalBytes !== tree.logicalBytes) throw new Error('Restored snapshot tree differs from its manifest');
        writeDurable(receiptPath, tree); syncPath(directory);
        continue;
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      const pending = `${target}.pending`;
      try { checkedHostPath(pending); await this.#driver(targetSpec).removeDiskPath(pending); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      mkdirSync(pending, { mode: tree.component === 'rootfs' ? ROOTFS_MODE : COMPONENT_MODE });
      await this.#driver(targetSpec).copyDiskTree(tree.path, pending);
      const copied = await this.#driver(targetSpec).fingerprintDiskTree(pending);
      if (copied.digest !== tree.digest || copied.logicalBytes !== tree.logicalBytes) throw new Error('Restored snapshot tree differs from its manifest');
      await this.#driver(targetSpec).syncDiskTree(pending); renameSync(pending, target); syncPath(diskDirectory);
      writeDurable(receiptPath, tree); syncPath(directory);
    }
    // The reference is the TARGET specification's, never the snapshot's. A restore fills the disk from
    // copied trees, and a retained snapshot naming the removed container runtime must not move a current
    // row back onto it. `prepare` compares this field against the specification before it starts anything,
    // so writing the snapshot's reference over the target would also leave it unable to start.
    // Nothing here reads a clock: `createdAt` is the one field the completion comparison strips, so every
    // other value has to be derivable again identically when a restore resumes.
    const adopted = targetSpec.disk.sourceImage !== manifest.sourceImage.reference;
    const diskRecord = { resource: targetSpec.resource, diskId: targetSpec.disk.id, format: 2,
      sourceImage: targetSpec.disk.sourceImage, sourceImageId: adopted ? null : manifest.sourceImage.id,
      rootfsPath: targetSpec.disk.rootfsPath, components: targetSpec.disk.components,
      createdAt: new Date().toISOString(), restoredFrom: snapshotId,
      ...(adopted ? { adoptedFrom: { reference: manifest.sourceImage.reference, imageId: manifest.sourceImage.id ?? null, snapshotId } } : {}),
      materialized: true };
    const existingDisk = read(join(diskDirectory, 'disk.json'));
    if (existingDisk) {
      const { createdAt: _existingCreatedAt, ...actual } = existingDisk;
      const { createdAt: _newCreatedAt, ...wanted } = diskRecord;
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error('Restored disk manifest ownership mismatch');
    } else writeDurable(join(diskDirectory, 'disk.json'), diskRecord);
    syncPath(diskDirectory);
    writeDurable(join(directory, 'complete.json'), { ...expected, sourceImage: manifest.sourceImage });
    syncPath(directory); unlinkSync(journal); syncPath(directory);
    return manifest;
  }

  async readSnapshot(spec, snapshotId) {
    assertContainerSpec(spec);
    resourceToken(snapshotId);
    const directory = checkedHostPath(join(spec.storageRoot, 'snapshots', snapshotId));
    const path = checkedHostPath(join(directory, 'manifest.json'), { file: true });
    if (lstatSync(path).size > 256 * 1024) throw new Error('Snapshot manifest exceeds limit');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (manifest.version !== 2 || !spec.disk || manifest.snapshotId !== snapshotId || manifest.resource?.kind !== spec.resource.kind || manifest.resource?.id !== spec.resource.id
      || manifest.generation !== spec.generation || manifest.diskId !== spec.disk.id || manifest.specHash !== spec.specHash
      || manifest.consistency !== 'crash-consistent' || manifest.completeProject !== (spec.resource.kind === 'project') || !Array.isArray(manifest.trees)
      || manifest.treeFormat !== SNAPSHOT_TREE_FORMAT) throw new Error('Snapshot manifest ownership mismatch');
    const expected = ['rootfs', ...spec.disk.components.map((entry) => entry.component)];
    const components = manifest.trees.map((entry) => entry?.component);
    if (new Set(components).size !== components.length || components.some((component) => !expected.includes(component))
      || (manifest.completeProject && JSON.stringify(components) !== JSON.stringify(expected))) throw new Error('Snapshot storage components mismatch');
    for (const tree of manifest.trees) {
      if (tree.path !== join(directory, tree.component) || !Number.isSafeInteger(tree.logicalBytes) || tree.logicalBytes < 0
        || !Number.isSafeInteger(tree.allocatedBytes) || tree.allocatedBytes < 0 || !/^[a-f0-9]{64}$/.test(tree.digest)) throw new Error('Snapshot tree manifest is invalid');
      checkedHostPath(tree.path);
    }
    return manifest;
  }

  async removeDisk(spec, owningSpecs) {
    assertContainerSpec(spec);
    if (!spec.disk || !Array.isArray(owningSpecs) || owningSpecs.length < 1) throw new Error('A complete disk cleanup ownership set is required');
    for (const owner of owningSpecs) {
      assertContainerSpec(owner);
      if (owner.disk?.id !== spec.disk.id) continue;
      if (await this.#driver(owner).inspect(owner)) throw new Error('An envelope still owns environment disk');
    }
    const directory = dirname(spec.disk.rootfsPath);
    // A disk directory that is already gone leaves nothing to remove and nothing to verify, and deletion
    // has to reach the end regardless: a removal interrupted after the tree went away, or a disk record
    // whose directory an earlier cleanup already took, would otherwise make the environment permanently
    // undeletable. The same skip the storage removals beside it perform. A directory that IS there and
    // cannot be removed still fails, on the driver call and again on the verification below.
    try { checkedHostPath(directory); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    await this.#driver(spec).removeDiskPath(directory);
    try { lstatSync(directory); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    throw new Error('Environment disk removal was not verified');
  }

}
