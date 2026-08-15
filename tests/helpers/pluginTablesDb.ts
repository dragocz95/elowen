import { openDb, type OpenDbOptions, type Db } from '../../src/store/db.js';
import { applyAgentsSchema, applyWorkSchema } from '../fixtures/pluginSchema.js';

/** Open a test database in the shape a STANDARD install has: core's own schema plus the tables of the two
 *  domain plugins most installs run — agents (missions/mission_pr/agents/notes) and work
 *  (tasks/task_deps/task_usage). Neither set is in core's schema.sql any more; each plugin applies its
 *  own DDL through ctx.db().migrate(), so a test wiring a whole daemon-shaped app opens its database
 *  here rather than re-deriving which plugin owns what.
 *
 *  A test that specifically exercises ONE plugin's shape — or the absence of another's — opens the
 *  narrower {@link openAgentsDb} / {@link openWorkDb} instead, or plain openDb for neither.
 *
 *  The DDL comes from tests/fixtures/pluginSchema.ts, not from the plugins: both are installed from the
 *  plugin registry now, and a daemon test importing another repository's source would depend on something
 *  this checkout cannot build. That fixture documents how the copy is kept honest. */
export function openPluginTablesDb(path = ':memory:', opts: OpenDbOptions = {}): Db {
  const db = openDb(path, opts);
  applyAgentsSchema(db);
  applyWorkSchema(db);
  return db;
}
