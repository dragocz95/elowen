import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { closeSync, copyFileSync, constants, cpSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertContainerSpec, hostPath, resourceToken, snapshotReference } from './containerSpec.mjs';
import { checkedHostPath } from './containerPaths.mjs';

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
async function fingerprint(path, maxBytes) {
  checkedHostPath(path, { file: true });
  const stat = lstatSync(path);
  if (stat.size < 1 || stat.size > maxBytes || stat.nlink !== 1) throw new Error('Invalid snapshot archive size or link count');
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    sizeBytes += chunk.length;
    if (sizeBytes > maxBytes) throw new Error('Snapshot archive exceeds limit');
    hash.update(chunk);
  }
  if (sizeBytes !== stat.size) throw new Error('Snapshot archive changed during verification');
  return { sizeBytes, sha256: hash.digest('hex') };
}

/** Component primitives only. The daemon lifecycle owner must hold its resource queue and prevent new
 * execution leases throughout snapshot/restore. Incomplete directories are durable recovery evidence,
 * not garbage to delete on retry. No guest archive is ever extracted by a host shell or host tar. */
export class ContainerStorage {
  #podman;
  #maxArchiveBytes;
  constructor(podman, { maxArchiveBytes = 16 * 1024 ** 3 } = {}) {
    if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 1) throw new Error('Invalid snapshot archive bound');
    this.#podman = podman;
    this.#maxArchiveBytes = maxArchiveBytes;
  }

  async prepare(spec) {
    assertContainerSpec(spec);
    checkedHostPath(spec.storageRoot, { create: true });
    if (spec.resource.kind === 'project') for (const mount of spec.mounts.filter((entry) => entry.type === 'bind')) checkedHostPath(mount.source, { create: true });
    if (spec.disk) await this.#prepareDisk(spec);
    else for (const volume of spec.volumes) checkedHostPath(volume.path, { create: true });
    for (const volume of spec.volumes) await this.#podman.ensureVolume(spec, volume.component);
  }

  /** `fill` is how the pending root filesystem gets its contents, and the only thing that differs between
   *  a NEW disk and one migrated from a legacy container: the default materializes the fixed image, and
   *  the migration path extracts its own verified export archive. Everything after it — the inventory
   *  proof, the fsync, the atomic activation and the durable manifest — is one protocol for both, because
   *  a second copy of it is how the two would come to disagree about when a disk is complete. */
  async #prepareDisk(spec, fill = null) {
    const directory = checkedHostPath(dirname(spec.disk.rootfsPath), { create: true });
    const manifestPath = join(directory, 'disk.json');
    const pendingManifestPath = join(directory, 'disk.pending');
    const validateManifest = (manifest) => {
      if (manifest.diskId !== spec.disk.id || manifest.format !== 2 || manifest.resource?.kind !== spec.resource.kind
        || manifest.resource?.id !== spec.resource.id || manifest.rootfsPath !== spec.disk.rootfsPath
        || manifest.sourceImage !== spec.disk.sourceImage || JSON.stringify(manifest.components) !== JSON.stringify(spec.disk.components)
        || !manifest.materialized) throw new Error('Environment disk manifest ownership mismatch');
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
      try { checkedHostPath(pending); await this.#podman.removeDiskPath(pending); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
    try {
      checkedHostPath(spec.disk.rootfsPath);
      const missing = new Error('The persistent rootfs exists without its durable disk record; restore a snapshot explicitly');
      missing.code = 'disk_record_missing';
      throw missing;
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    try { checkedHostPath(pending); await this.#podman.removeDiskPath(pending); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    mkdirSync(pending, { mode: ROOTFS_MODE });
    for (const component of spec.disk.components) checkedHostPath(component.path, { create: true });
    const { sourceImageId, ...provenance } = fill ? await fill(pending) : { sourceImageId: await this.#podman.materializeRootfs(spec, pending) };
    await this.#podman.syncDiskTree(pending);
    writeDurable(pendingManifestPath, { resource: spec.resource, diskId: spec.disk.id, format: 2, sourceImage: spec.disk.sourceImage,
      sourceImageId, rootfsPath: spec.disk.rootfsPath, components: spec.disk.components, createdAt: new Date().toISOString(), ...provenance, materialized: true });
    syncPath(directory);
    renameSync(pending, spec.disk.rootfsPath);
    syncPath(directory);
    renameSync(pendingManifestPath, manifestPath);
    syncPath(directory);
  }

  /** Capture the merged root filesystem of a legacy envelope into a host-owned archive, fingerprinted and
   *  fsynced, and record a durable receipt for it. The receipt is what makes the capture resumable: an
   *  archive present WITHOUT one is the remains of an export that was interrupted, so it is discarded and
   *  taken again rather than trusted for its size. A receipt that exists is verified against the file on
   *  disk and returned, so a retry never exports a second time. */
  async captureRootfsExport(spec, migrationId) {
    assertContainerSpec(spec);
    resourceToken(migrationId);
    if (spec.disk) throw new Error('Only a legacy image-backed environment is migrated');
    const directory = checkedHostPath(join(spec.storageRoot, 'migrations', migrationId), { create: true });
    const archive = join(directory, 'rootfs.tar');
    const receiptPath = join(directory, 'export.json');
    const identity = { migrationId, resource: spec.resource, generation: spec.generation, specHash: spec.specHash };
    let receipt;
    try { receipt = JSON.parse(readFileSync(checkedHostPath(receiptPath, { file: true }), 'utf8')); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (receipt) {
      if (JSON.stringify({ migrationId: receipt.migrationId, resource: receipt.resource, generation: receipt.generation, specHash: receipt.specHash }) !== JSON.stringify(identity)
        || receipt.archivePath !== archive) throw new Error('Migration export receipt ownership mismatch');
      const measured = await fingerprint(archive, this.#maxArchiveBytes);
      if (measured.sizeBytes !== receipt.sizeBytes || measured.sha256 !== receipt.sha256) throw new Error('The migration export archive changed after it was captured');
      return receipt;
    }
    try { checkedHostPath(archive, { file: true }); await this.#podman.removeDiskPath(archive); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const containerId = await this.#podman.exportContainerRootfs(spec, archive);
    const digest = await fingerprint(archive, this.#maxArchiveBytes);
    syncPath(archive);
    const complete = { ...identity, archivePath: archive, containerId, ...digest };
    writeDurable(receiptPath, complete);
    syncPath(directory);
    return complete;
  }

  /** Materialize a captured export into the candidate disk. The archive is re-fingerprinted against the
   *  receipt first, so an activation can only ever publish the bytes the export proved. */
  async materializeMigratedDisk(spec, capture) {
    assertContainerSpec(spec);
    if (!spec.disk) throw new Error('A rootfs-backed candidate specification is required');
    const archive = checkedHostPath(capture.archivePath, { file: true });
    const measured = await fingerprint(archive, this.#maxArchiveBytes);
    if (measured.sizeBytes !== capture.sizeBytes || measured.sha256 !== capture.sha256) throw new Error('The migration export archive changed after it was captured');
    await this.#prepareDisk(spec, async (pending) => {
      await this.#podman.extractRootfsArchive(archive, pending);
      await this.#podman.verifyExtractedRootfs(archive, pending);
      return { sourceImageId: await this.#podman.imageIdentity(spec.disk.sourceImage),
        migratedFrom: { containerId: capture.containerId, archivePath: archive, sizeBytes: measured.sizeBytes, sha256: measured.sha256 } };
    });
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

  async snapshot(spec, snapshotId, { includeData = true } = {}) {
    assertContainerSpec(spec);
    resourceToken(snapshotId);
    if (typeof includeData !== 'boolean' || (spec.resource.kind === 'project' && !includeData)) throw new Error('Project snapshots require all storage components');
    if (spec.disk) return await this.#snapshotDisk(spec, snapshotId, includeData);
    const parent = checkedHostPath(join(spec.storageRoot, 'snapshots'), { create: true });
    const directory = join(parent, snapshotId);
    try {
      checkedHostPath(directory);
      const pending = checkedHostPath(join(directory, 'pending.json'), { file: true });
      const previous = JSON.parse(readFileSync(pending, 'utf8'));
      if (previous.resumeRunning && (await this.#podman.inspect(spec))?.state === 'paused') await this.#podman.unpause(spec);
      await this.#podman.discardIncompleteSnapshot(spec, snapshotId);
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    absent(directory);
    const row = await this.#podman.inspect(spec);
    if (!row || !['running', 'stopped', 'exited', 'created'].includes(row.state)) throw new Error('Container cannot be quiesced for snapshot');
    checkedHostPath(directory, { create: true });
    writeDurable(join(directory, 'pending.json'), { snapshotId, resource: spec.resource, generation: spec.generation, specHash: spec.specHash, resumeRunning: row.state === 'running' });
    syncPath(directory);
    syncPath(parent);
    const manifest = {
      version: 1, snapshotId, resource: spec.resource, generation: spec.generation, specHash: spec.specHash,
      consistency: 'crash-consistent', completeProject: spec.resource.kind === 'project',
      image: { reference: snapshotReference(spec, snapshotId), id: null }, components: [],
    };
    let paused = false;
    const failures = [];
    try {
      if (row.state === 'running') { await this.#podman.pause(spec); paused = true; }
      manifest.image.id = await this.#podman.snapshotImage(spec, snapshotId);
      for (const volume of spec.volumes) {
        if (volume.component === 'data' && !includeData) continue;
        const archive = join(directory, `${volume.component}.tar`);
        await this.#podman.exportVolume(spec, volume.component, snapshotId);
        const digest = await fingerprint(archive, this.#maxArchiveBytes);
        syncPath(archive);
        manifest.components.push({ component: volume.component, ...digest });
      }
      syncPath(directory);
    } catch (error) { failures.push(error); }
    finally {
      if (row.state === 'running') {
        try {
          // A client timeout can hide a successful pause. Reconcile that observed state rather than
          // leaving the project frozen just because the launcher did not acknowledge the operation.
          if (paused || (await this.#podman.inspect(spec))?.state === 'paused') await this.#podman.unpause(spec);
        } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join('; '));
    writeDurable(join(directory, 'manifest.pending'), manifest);
    renameSync(join(directory, 'manifest.pending'), join(directory, 'manifest.json'));
    syncPath(directory);
    unlinkSync(join(directory, 'pending.json'));
    syncPath(directory);
    return manifest;
  }

  async #snapshotDisk(spec, snapshotId, includeData) {
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
      if (pending.resumeRunning && (await this.#podman.inspect(spec))?.state === 'paused') await this.#podman.unpause(spec);
      await this.#podman.removeDiskPath(directory);
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    absent(directory);
    const row = await this.#podman.inspect(spec);
    if (!row || !['running', 'stopped', 'exited', 'created'].includes(row.state)) throw new Error('Container cannot be quiesced for snapshot');
    checkedHostPath(directory, { create: true });
    writeDurable(join(directory, 'pending.json'), { snapshotId, resource: spec.resource, generation: spec.generation, specHash: spec.specHash, resumeRunning: row.state === 'running' });
    syncPath(directory); syncPath(parent);
    const diskManifest = JSON.parse(readFileSync(checkedHostPath(join(dirname(spec.disk.rootfsPath), 'disk.json'), { file: true }), 'utf8'));
    const sources = [{ component: 'rootfs', path: spec.disk.rootfsPath }, ...spec.disk.components.filter((entry) => includeData || entry.component !== 'data')];
    await this.#podman.preflightDiskCopy(sources.map((entry) => entry.path), parent);
    const manifest = { version: 2, snapshotId, resource: spec.resource, generation: spec.generation, diskId: spec.disk.id,
      specHash: spec.specHash, consistency: 'crash-consistent', completeProject: spec.resource.kind === 'project',
      treeFormat: 'inventory-v1:path,type,size,uid,gid,mode,mtimeNs,hardlink,xattrs,linkTarget',
      sourceImage: { reference: spec.disk.sourceImage, id: diskManifest.sourceImageId }, trees: [] };
    const failures = [];
    let paused = false;
    try {
      if (row.state === 'running') { await this.#podman.pause(spec); paused = true; }
      for (const source of sources) {
        const target = join(directory, source.component);
        mkdirSync(target, { mode: source.component === 'rootfs' ? ROOTFS_MODE : COMPONENT_MODE });
        await this.#podman.copyDiskTree(source.path, target);
        await this.#podman.syncDiskTree(target);
        manifest.trees.push({ component: source.component, path: target, ...await this.#podman.fingerprintDiskTree(target) });
      }
      syncPath(directory);
    } catch (error) { failures.push(error); }
    finally {
      if (row.state === 'running') {
        try { if (paused || (await this.#podman.inspect(spec))?.state === 'paused') await this.#podman.unpause(spec); }
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
    if (manifest.version === 2) return await this.#restoreDiskSnapshot(sourceSpec, snapshotId, targetSpec, manifest);
    if (sourceSpec.disk || targetSpec.disk) throw new Error('Legacy snapshots are restorable only for legacy environments');
    if (sourceSpec.resource.kind !== targetSpec.resource.kind
      || (sourceSpec.resource.id === targetSpec.resource.id && sourceSpec.generation === targetSpec.generation)) throw new Error('Restore needs a new resource or generation');
    if (targetSpec.image !== manifest.image.id && targetSpec.image !== manifest.image.reference) throw new Error('Restore target must use the snapshot root image');
    if (manifest.components.length !== targetSpec.volumes.length) throw new Error('Restore requires a snapshot with all mounted storage components');
    const directory = checkedHostPath(join(targetSpec.storageRoot, 'restores', String(targetSpec.generation)), { create: true });
    const pending = join(directory, 'pending.json');
    const expected = { snapshotId, source: sourceSpec.resource, sourceGeneration: sourceSpec.generation, target: targetSpec.resource, targetGeneration: targetSpec.generation, targetSpecHash: targetSpec.specHash };
    const read = (path) => { try { checkedHostPath(path, { file: true }); return JSON.parse(readFileSync(path, 'utf8')); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; } };
    const complete = read(join(directory, 'complete.json'));
    if (complete) {
      if (JSON.stringify(complete) !== JSON.stringify({ ...expected, image: manifest.image })) throw new Error('Restore completion ownership mismatch');
      for (const volume of targetSpec.volumes) await this.#podman.inspectVolume(targetSpec, volume.component);
      return manifest;
    }
    const previous = read(pending);
    if (previous && JSON.stringify(previous) !== JSON.stringify(expected)) throw new Error('Restore checkpoint ownership mismatch');
    if (!previous) {
      for (const volume of targetSpec.volumes) absent(volume.path);
      writeDurable(pending, expected); syncPath(directory);
    }
    for (const entry of manifest.components) {
      const receiptPath = join(directory, `${entry.component}.json`);
      const receipt = read(receiptPath);
      if (receipt) {
        if (JSON.stringify(receipt) !== JSON.stringify(entry)) throw new Error('Restore component checkpoint mismatch');
        await this.#podman.inspectVolume(targetSpec, entry.component);
        continue;
      }
      // A failed import is replaced only in this checkpoint-owned, never activated generation.
      await this.#podman.importSnapshotVolume(sourceSpec, snapshotId, targetSpec, entry.component, { resume: previous !== null });
      writeDurable(receiptPath, entry); syncPath(directory);
    }
    writeDurable(join(directory, 'complete.json'), { ...expected, image: manifest.image });
    syncPath(directory); unlinkSync(pending); syncPath(directory);
    return manifest;
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
    if (missing.length) {
      if (sourceSpec.resource.kind !== 'site' || missing.length !== 1 || missing[0] !== 'data') throw new Error('Restore requires every disk tree');
      const currentData = sourceSpec.disk.components.find((entry) => entry.component === 'data');
      if (!currentData) throw new Error('Current Site data is missing from the source disk');
      trees.push({ component: 'data', path: currentData.path, current: true, ...await this.#podman.fingerprintDiskTree(currentData.path) });
    }
    if (trees.length !== targets.size || trees.some((tree) => !targets.has(tree.component))) throw new Error('Snapshot tree does not belong to the restore target');
    await this.#podman.preflightDiskCopy(trees.map((tree) => tree.path), diskDirectory);
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
        const copied = await this.#podman.fingerprintDiskTree(target);
        if (copied.digest !== tree.digest || copied.logicalBytes !== tree.logicalBytes) throw new Error('Restored snapshot tree differs from its manifest');
        writeDurable(receiptPath, tree); syncPath(directory);
        continue;
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      const pending = `${target}.pending`;
      try { checkedHostPath(pending); await this.#podman.removeDiskPath(pending); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      mkdirSync(pending, { mode: tree.component === 'rootfs' ? ROOTFS_MODE : COMPONENT_MODE });
      await this.#podman.copyDiskTree(tree.path, pending);
      const copied = await this.#podman.fingerprintDiskTree(pending);
      if (copied.digest !== tree.digest || copied.logicalBytes !== tree.logicalBytes) throw new Error('Restored snapshot tree differs from its manifest');
      await this.#podman.syncDiskTree(pending); renameSync(pending, target); syncPath(diskDirectory);
      writeDurable(receiptPath, tree); syncPath(directory);
    }
    const diskRecord = { resource: targetSpec.resource, diskId: targetSpec.disk.id, format: 2,
      sourceImage: manifest.sourceImage.reference, sourceImageId: manifest.sourceImage.id, rootfsPath: targetSpec.disk.rootfsPath,
      components: targetSpec.disk.components, createdAt: new Date().toISOString(), restoredFrom: snapshotId, materialized: true };
    const existingDisk = read(join(diskDirectory, 'disk.json'));
    if (existingDisk) {
      const { createdAt: _existingCreatedAt, ...actual } = existingDisk;
      const { createdAt: _newCreatedAt, ...wanted } = diskRecord;
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error('Restored disk manifest ownership mismatch');
    } else writeDurable(join(diskDirectory, 'disk.json'), diskRecord);
    syncPath(diskDirectory);
    for (const volume of targetSpec.volumes) await this.#podman.ensureVolume(targetSpec, volume.component);
    writeDurable(join(directory, 'complete.json'), { ...expected, sourceImage: manifest.sourceImage });
    syncPath(directory); unlinkSync(journal); syncPath(directory);
    return manifest;
  }

  async importRetainedSiteSnapshot(spec, snapshotId, artifact) {
    assertContainerSpec(spec); resourceToken(snapshotId);
    if (spec.resource.kind !== 'site') throw new Error('Only Sites may import retained release snapshots');
    const imageId = await this.#podman.inspectRetainedSiteImage(spec, artifact.imageReference, artifact.imageId);
    const directory = checkedHostPath(join(spec.storageRoot, 'snapshots', snapshotId), { create: true });
    const manifest = { version: 1, snapshotId, resource: spec.resource, generation: spec.generation, specHash: spec.specHash,
      consistency: 'crash-consistent', completeProject: false, retained: true,
      image: { reference: artifact.imageReference, id: imageId }, components: [] };
    if (artifact.archivePath) {
      const original = await fingerprint(artifact.archivePath, this.#maxArchiveBytes);
      const archive = join(directory, 'data.tar');
      try { copyFileSync(artifact.archivePath, archive, constants.COPYFILE_EXCL); }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      const copied = await fingerprint(archive, this.#maxArchiveBytes);
      if (JSON.stringify(original) !== JSON.stringify(copied)) throw new Error('Retained snapshot archive differs from the original');
      syncPath(archive); manifest.components.push({ component: 'data', ...copied });
    }
    const path = join(directory, 'manifest.json');
    try { writeDurable(path, manifest); }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; checkedHostPath(path, { file: true }); if (readFileSync(path, 'utf8') !== JSON.stringify(manifest)) throw new Error('Retained snapshot binding changed'); }
    syncPath(directory);
    return await this.readSnapshot(spec, snapshotId);
  }

  async readSnapshot(spec, snapshotId) {
    assertContainerSpec(spec);
    resourceToken(snapshotId);
    const directory = checkedHostPath(join(spec.storageRoot, 'snapshots', snapshotId));
    const path = checkedHostPath(join(directory, 'manifest.json'), { file: true });
    if (lstatSync(path).size > 256 * 1024) throw new Error('Snapshot manifest exceeds limit');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (manifest.version === 2) {
      if (!spec.disk || manifest.snapshotId !== snapshotId || manifest.resource?.kind !== spec.resource.kind || manifest.resource?.id !== spec.resource.id
        || manifest.generation !== spec.generation || manifest.diskId !== spec.disk.id || manifest.specHash !== spec.specHash
        || manifest.consistency !== 'crash-consistent' || manifest.completeProject !== (spec.resource.kind === 'project') || !Array.isArray(manifest.trees)
        || manifest.treeFormat !== 'inventory-v1:path,type,size,uid,gid,mode,mtimeNs,hardlink,xattrs,linkTarget') throw new Error('Snapshot manifest ownership mismatch');
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
    if (spec.disk || manifest.version !== 1 || manifest.snapshotId !== snapshotId || manifest.resource?.kind !== spec.resource.kind
      || manifest.resource?.id !== spec.resource.id || manifest.generation !== spec.generation || manifest.specHash !== spec.specHash
      || manifest.consistency !== 'crash-consistent' || manifest.completeProject !== (spec.resource.kind === 'project')
      || (manifest.retained ? spec.resource.kind !== 'site' : manifest.image?.reference !== snapshotReference(spec, snapshotId)) || !Array.isArray(manifest.components)) throw new Error('Snapshot manifest ownership mismatch');
    const components = manifest.components.map((entry) => entry?.component);
    const expected = spec.volumes.map((volume) => volume.component);
    if (new Set(components).size !== components.length || components.some((component) => !expected.includes(component))
      || (manifest.completeProject && JSON.stringify(components) !== JSON.stringify(expected))) throw new Error('Snapshot storage components mismatch');
    const imageId = manifest.retained
      ? await this.#podman.inspectRetainedSiteImage(spec, manifest.image.reference, manifest.image.id)
      : await this.#podman.inspectSnapshotImage(spec, snapshotId);
    if (imageId !== manifest.image.id) throw new Error('Snapshot image changed');
    for (const entry of manifest.components) {
      const digest = await fingerprint(join(directory, `${entry.component}.tar`), this.#maxArchiveBytes);
      if (digest.sizeBytes !== entry.sizeBytes || digest.sha256 !== entry.sha256) throw new Error('Snapshot archive integrity mismatch');
    }
    return manifest;
  }

  async removeDisk(spec, owningSpecs) {
    assertContainerSpec(spec);
    if (!spec.disk || !Array.isArray(owningSpecs) || owningSpecs.length < 1) throw new Error('A complete disk cleanup ownership set is required');
    for (const owner of owningSpecs) {
      assertContainerSpec(owner);
      if (owner.disk?.id !== spec.disk.id) continue;
      if (await this.#podman.inspect(owner)) throw new Error('An envelope still owns environment disk');
      for (const volume of owner.volumes) {
        try { await this.#podman.inspectVolume(owner, volume.component); throw new Error('A volume still owns environment disk'); }
        catch (cause) { if (!/missing/i.test(cause.message)) throw cause; }
      }
    }
    const directory = dirname(spec.disk.rootfsPath);
    await this.#podman.removeDiskPath(directory);
    try { lstatSync(directory); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    throw new Error('Environment disk removal was not verified');
  }

}
