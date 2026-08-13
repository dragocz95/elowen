import { openDb, type OpenDbOptions, type Db } from '../../src/store/db.js';
import { AGENTS_MIGRATIONS } from '../../plugins/agents/src/store/migrations.js';
import { WORK_MIGRATIONS } from '../../plugins/work/src/store/migrations.js';

/** Open a test database in the shape a STANDARD install has: core's own schema plus the tables of every
 *  bundled domain plugin that ships enabled — agents (missions/mission_pr/agents/notes) and work
 *  (tasks/task_deps/task_usage). Neither set is in core's schema.sql any more; each plugin applies its
 *  own DDL through ctx.db().migrate(), so a test wiring a whole daemon-shaped app opens its database
 *  here rather than re-deriving which plugin owns what.
 *
 *  A test that specifically exercises ONE plugin's shape — or the absence of another's — opens the
 *  narrower {@link openAgentsDb} / {@link openWorkDb} instead, or plain openDb for neither. */
export function openPluginTablesDb(path = ':memory:', opts: OpenDbOptions = {}): Db {
  const db = openDb(path, opts);
  for (const step of [...AGENTS_MIGRATIONS, ...WORK_MIGRATIONS]) step.up(db);
  return db;
}
