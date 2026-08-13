import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

/** A throwaway on-disk database whose settings row already enables the named plugins, for the tests
 *  that boot the WHOLE daemon (`buildApp`) to reach a plugin's root mounts. A fresh install enables
 *  only the bare-assistant tool set, so a domain plugin's routes exist solely on an install whose
 *  owner installed it — this seeds exactly that state. On disk rather than `:memory:` because the
 *  settings row has to exist BEFORE buildApp opens the database. */
export function dbWithPlugins(enabled: string[]): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'elowen-bootstrap-'));
  const dbPath = join(dir, 'elowen.db');
  const db = openDb(dbPath);
  new ConfigStore(db).update({ plugins: { enabled } });
  db.close();
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
