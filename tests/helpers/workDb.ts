import { openDb, type OpenDbOptions, type Db } from '../../src/store/db.js';
import { applyWorkSchema } from '../fixtures/pluginSchema.js';

/** Apply the work plugin's tables to an already-open database — for a test that needs BOTH another
 *  plugin's tables and the task domain's (open through that plugin's helper, then pass the db here). */
export function applyWorkMigrations<T extends Db>(db: T): T {
  applyWorkSchema(db);
  return db;
}

/** Open a test database WITH the work plugin's tables. Core schema.sql no longer carries the
 *  tasks/task_deps/task_usage DDL (it is plugin-owned, applied via ctx.db().migrate()), so a test that
 *  constructs the task stores — or arranges rows in those tables — opens its db through this helper,
 *  which mirrors what a daemon with the work plugin enabled has. Tests exercising the plugin-DISABLED
 *  shape use plain openDb.
 *
 *  The DDL comes from tests/fixtures/pluginSchema.ts, not from the plugin: work is installed from the
 *  plugin registry now, and a daemon test importing another repository's source would depend on something
 *  this checkout cannot build. That fixture documents how the copy is kept honest. */
export function openWorkDb(path = ':memory:', opts: OpenDbOptions = {}): Db {
  return applyWorkMigrations(openDb(path, opts));
}
