import { lstatSync, mkdirSync } from 'node:fs';
import { join, parse, relative, sep } from 'node:path';
import { hostPath } from './containerSpec.mjs';

/** Walk all ancestors without following guest-controlled symlinks. Roots are host configuration; these
 * checks are not a replacement for keeping their parents inaccessible to container workloads. */
export function checkedHostPath(path, { create = false, file = false } = {}) {
  hostPath(path);
  const root = parse(path).root;
  const parts = relative(root, path).split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const last = index === parts.length - 1;
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create || (last && file)) throw error;
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new Error('Symlink in container storage path');
    if (last && file ? !stat.isFile() : !stat.isDirectory()) throw new Error('Unexpected container storage path type');
  }
  return path;
}
