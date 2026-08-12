import { openDb, type OpenDbOptions, type Db } from '../../src/store/db.js';
import { AGENTS_MIGRATIONS } from '../../plugins/agents/src/store/migrations.js';

/** Open a test database WITH the agents plugin's tables. Core schema.sql no longer carries the
 *  missions/mission_pr/agents/notes DDL (it is plugin-owned, applied via ctx.db().migrate()), so a
 *  test that constructs the plugin's stores directly — or arranges rows in those tables — opens its
 *  db through this helper, which mirrors what a daemon with the agents plugin enabled has. Tests
 *  exercising the plugin-DISABLED shape use plain openDb. */
export function openAgentsDb(path = ':memory:', opts: OpenDbOptions = {}): Db {
  const db = openDb(path, opts);
  for (const step of AGENTS_MIGRATIONS) step.up(db);
  return db;
}
