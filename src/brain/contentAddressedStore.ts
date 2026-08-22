import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Store immutable bytes under a SHA-256 content address. An owner may include immutable metadata in the
 *  address (general files include their download name); the suffix is always module-chosen, never caller-chosen.
 *  Existing content is touched because the attachment sweep measures its grace window from mtime. */
export function storeContentAddressed(dir: string, bytes: Buffer, suffix: string, address = bytes, allowEmpty = false): string | null {
  if (!allowEmpty && bytes.length === 0) return null;
  const file = `${createHash('sha256').update(address).digest('hex')}.${suffix}`;
  const path = join(dir, file);
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(path)) {
      try { utimesSync(path, new Date(), new Date()); } catch { /* a stale mtime only risks an early sweep */ }
      return file;
    }
    // The name promises exact bytes, so publish atomically: an interrupted write must never leave truncated
    // content that every later call trusts merely because the final content-addressed name already exists.
    const tmp = `${path}.${process.pid}.${randomUUID()}.part`;
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw error;
    }
    return file;
  } catch {
    return null;
  }
}

/** Sweep unreferenced immutable files whose names pass the owning module's strict validator. */
export function sweepContentAddressed(
  dir: string,
  referenced: ReadonlySet<string>,
  isStoredName: (file: string) => boolean,
  graceMs: number,
  now = Date.now(),
): number {
  let removed = 0;
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch { return 0; }
  for (const file of entries) {
    if (!isStoredName(file) || referenced.has(file)) continue;
    const path = join(dir, file);
    try {
      if (now - statSync(path).mtimeMs < graceMs) continue;
      unlinkSync(path);
      removed += 1;
    } catch { /* vanished or unreadable — nothing to reclaim */ }
  }
  return removed;
}
