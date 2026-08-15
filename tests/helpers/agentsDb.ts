import { openDb, type OpenDbOptions, type Db } from '../../src/store/db.js';
import { applyAgentsSchema } from '../fixtures/pluginSchema.js';

/** Open a test database WITH the agents plugin's tables. Core schema.sql no longer carries the
 *  missions/mission_pr/agents/notes DDL (it is plugin-owned, applied via ctx.db().migrate()), so a
 *  test that constructs the plugin's stores directly — or arranges rows in those tables — opens its
 *  db through this helper, which mirrors what a daemon with the agents plugin enabled has. Tests
 *  exercising the plugin-DISABLED shape use plain openDb.
 *
 *  The DDL comes from tests/fixtures/pluginSchema.ts, not from the plugin: agents is installed from the
 *  plugin registry now, and a daemon test importing another repository's source would depend on something
 *  this checkout cannot build. That fixture documents how the copy is kept honest. */
export function openAgentsDb(path = ':memory:', opts: OpenDbOptions = {}): Db {
  const db = openDb(path, opts);
  applyAgentsSchema(db);
  return db;
}
