import { openDb, type OpenDbOptions, type Db } from '../../src/store/db.js';
import { applyAgentsSchema, applyWorkSchema } from '../fixtures/pluginSchema.js';

/** Open core's current schema plus the frozen agents/work table shapes that can remain on upgraded
 *  databases after those plugins are retired. Tests use this only when old physical rows materially affect
 *  a core operation such as user deletion or id-reuse protection; ordinary core tests use plain openDb.
 *
 *  The DDL comes from tests/fixtures/pluginSchema.ts rather than another repository. The fixture stays
 *  frozen at the last core-owned shape so these compatibility tests cannot silently drift. */
export function openPluginTablesDb(path = ':memory:', opts: OpenDbOptions = {}): Db {
  const db = openDb(path, opts);
  applyAgentsSchema(db);
  applyWorkSchema(db);
  return db;
}
