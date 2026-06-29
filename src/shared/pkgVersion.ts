import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Read this package's version from its package.json, resolved two dirs up from the CALLING module
 *  (`dist/<area>/<file>.js` → package root), defaulting to '0.0.0' if unreadable. Single source for the
 *  CLI (`orca --version`) and the daemon (`ORCA_VERSION` on /health); pass `import.meta.url`. */
export function readPkgVersion(metaUrl: string): string {
  try {
    return (JSON.parse(readFileSync(join(dirname(fileURLToPath(metaUrl)), '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
