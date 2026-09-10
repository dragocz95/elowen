import { createHash } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { checkedHostPath } from './containerPaths.mjs';
import { hostPath } from './containerSpec.mjs';

function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || posix.isAbsolute(value) || posix.normalize(value) !== value || value === '..' || value.startsWith('../')) throw new Error('Unsafe publication entry');
  return value;
}
const exists = (path) => { try { return lstatSync(path); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; } };
function sync(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

/** Bounded guest file transport, not host archive extraction. The destination is resolved by the Sites
 * authority. An interrupted, exclusively owned staging tree can be retried; existing sources never are. */
export async function exportProjectTree({ destination, operationId, manifest, readChunk, verify }) {
  hostPath(destination); checkedHostPath(dirname(destination), { create: true });
  if (!manifest || manifest.kind !== 'export-manifest' || !Array.isArray(manifest.entries) || manifest.entries.length > 10000) throw new Error('Invalid guest publication manifest');
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const suffix = createHash('sha256').update(operationId).digest('hex').slice(0, 16);
  const stage = `${destination}.elowen-${suffix}`;
  const receipt = `${stage}.json`;
  const identity = { operationId, destination, digest };
  const old = exists(receipt) ? JSON.parse(readFileSync(checkedHostPath(receipt, { file: true }), 'utf8')) : null;
  if (old && (old.operationId !== operationId || old.destination !== destination)) throw new Error('Publication checkpoint ownership mismatch');
  if (exists(destination)) {
    if (old?.ready && !exists(stage)) return;
    throw new Error('Publication destination already exists');
  }
  if (old?.ready && exists(stage)) {
    checkedHostPath(stage); renameSync(stage, destination); sync(dirname(destination)); return;
  }
  if (exists(stage)) {
    if (!old) throw new Error('Unowned publication staging directory exists');
    checkedHostPath(stage); rmSync(stage, { recursive: true });
  }
  if (!old) writeFileSync(receipt, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
  else writeFileSync(receipt, JSON.stringify(identity));
  sync(receipt); sync(dirname(receipt)); mkdirSync(stage, { mode: 0o700 });
  const seen = new Set();
  let bytes = 0;
  const directories = [];
  for (const item of manifest.entries) {
    relative(item.path);
    if (seen.has(item.path) || !Number.isSafeInteger(item.mode) || item.mode < 0 || item.mode > 0o777) throw new Error('Invalid publication entry metadata');
    seen.add(item.path);
    const path = join(stage, item.path);
    checkedHostPath(dirname(path), { create: true });
    if (item.kind === 'directory') { checkedHostPath(path, { create: true }); directories.push([path, item.mode]); }
    else if (item.kind === 'file') {
      if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > 256 * 1024 * 1024 || (bytes += item.size) > 16 * 1024 ** 3) throw new Error('Publication exceeds its file bound');
      const fd = openSync(path, 'wx', 0o600);
      try {
        let offset = 0;
        do {
          const read = await readChunk(item.path, offset, Math.min(262144, item.size - offset));
          if (read.kind !== 'read' || read.version !== item.version || read.totalBytes !== item.size) throw new Error('Publication source changed during transfer');
          const content = Buffer.from(read.base64, 'base64');
          if (content.length > item.size - offset || content.length > 262144 || (!content.length && offset < item.size)) throw new Error('Invalid publication chunk');
          for (let written = 0; written < content.length;) written += writeSync(fd, content, written, content.length - written);
          offset += content.length;
        } while (offset < item.size);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      chmodSync(path, item.mode);
    } else if (item.kind !== 'symlink') throw new Error('Unsupported publication entry');
  }
  // Links are created last, so no file write can traverse a guest-supplied link.
  for (const item of manifest.entries.filter((entry) => entry.kind === 'symlink')) {
    if (typeof item.target !== 'string' || item.target.includes('\0') || posix.isAbsolute(item.target)) throw new Error('Unsafe publication symlink');
    const target = posix.normalize(posix.join(posix.dirname(item.path), item.target));
    if (target === '..' || target.startsWith('../')) throw new Error('Publication symlink leaves its tree');
    const path = join(stage, item.path); checkedHostPath(dirname(path)); symlinkSync(item.target, path);
  }
  await verify();
  for (const [path, mode] of directories.reverse()) chmodSync(path, mode);
  if (!Number.isSafeInteger(manifest.mode) || manifest.mode < 0 || manifest.mode > 0o777) throw new Error('Invalid publication root mode');
  chmodSync(stage, manifest.mode);
  writeFileSync(receipt, JSON.stringify({ ...identity, ready: true })); sync(receipt); sync(dirname(receipt));
  renameSync(stage, destination); sync(dirname(destination));
}

export function removeOwnedArtifact(path) {
  const stat = exists(path);
  if (!stat) return;
  if (stat.isFile()) {
    checkedHostPath(path, { file: true });
    unlinkSync(path);
  } else if (stat.isDirectory()) {
    checkedHostPath(path);
    rmSync(path, { recursive: true });
  } else {
    throw new Error('Unexpected container storage path type');
  }
  sync(dirname(path));
}
