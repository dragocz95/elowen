import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { closeSync, copyFileSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertContainerSpec, resourceToken, snapshotReference } from './containerSpec.mjs';
import { checkedHostPath } from './containerPaths.mjs';

function syncPath(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeDurable(path, content) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(content)); fsyncSync(fd); } finally { closeSync(fd); }
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
    for (const volume of spec.volumes) checkedHostPath(volume.path, { create: true });
    for (const volume of spec.volumes) await this.#podman.ensureVolume(spec, volume.component);
  }

  async snapshot(spec, snapshotId, { includeData = true } = {}) {
    assertContainerSpec(spec);
    resourceToken(snapshotId);
    if (typeof includeData !== 'boolean' || (spec.resource.kind === 'project' && !includeData)) throw new Error('Project snapshots require all storage components');
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

  async restoreVolumes(sourceSpec, snapshotId, targetSpec) {
    assertContainerSpec(targetSpec);
    const manifest = await this.readSnapshot(sourceSpec, snapshotId);
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
    if (manifest.version !== 1 || manifest.snapshotId !== snapshotId || manifest.resource?.kind !== spec.resource.kind
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
}
