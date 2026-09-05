import { withWriteLock } from './db.js';
import { logger } from '../shared/logger.js';
import type { Db } from './db.js';
import type { PluginDb, PluginDbHandle, PluginDbMigrationStep } from '../plugins/api.js';

const log = logger('plugin-db');

// @platform-keep plugin-db :: makePluginDb && plugin_migrations
/** Generic plugin persistence retained for future github/sandblox consumers; zero in-repo callers is expected.
 *
 * One shared SQLite file preserves one WAL/backup/busy-timeout discipline and lets a plugin transact
 * atomically across its own tables and the host rows it is explicitly allowed to reach.
 *  Namespacing is a convention (`p_<plugin>_*`, enforced by marketplace review, not runtime — an
 *  admin-installed plugin already runs in-process with full DB reach, so a runtime SQL parser would be
 *  theatre). What IS enforced here is migration bookkeeping: each step runs exactly once per plugin,
 *  inside one immediate transaction together with its bookkeeping row, with the same busy-retry
 *  discipline as the core migrations.
 *
 *  `canMigrate:false` marks a non-daemon process (the sub-agent runner opens the DB with
 *  `{migrate:false}`) — plugin migrations are a daemon-boot concern, so there they are a logged no-op,
 *  never a second migrator racing the daemon. */
export function makePluginDb(db: Db, plugin: string, opts: { canMigrate: boolean }): PluginDb {
  const handle: PluginDbHandle = {
    exec: (sql) => { db.exec(sql); },
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) => stmt.run(...params),
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
      };
    },
  };
  return {
    ...handle,
    // better-sqlite3 builds a wrapped function; the plugin-facing contract runs it, so "forgot to call
    // the transaction" is not a shape a plugin can produce. Nested calls become savepoints, which is
    // what lets a store method that transacts internally still compose inside a caller's transaction.
    // Take the writer lock before a plugin reads: a runner commit otherwise invalidates the snapshot.
    transaction: <T>(fn: () => T): T => withWriteLock(db, fn),
    appliedVersion: () => {
      const row = db.prepare('SELECT MAX(version) AS v FROM plugin_migrations WHERE plugin = ?').get(plugin) as { v: number | null };
      return row.v ?? 0;
    },
    migrate: (steps: PluginDbMigrationStep[]) => {
      if (!opts.canMigrate) { log.info(`[${plugin}] migrations skipped (non-daemon process)`); return; }
      const sorted = [...steps].sort((a, b) => a.version - b.version);
      for (const step of sorted) {
        if (!Number.isInteger(step.version) || step.version < 1) throw new Error(`[${plugin}] migration version must be a positive integer, got ${step.version}`);
        const done = db.prepare('SELECT 1 FROM plugin_migrations WHERE plugin = ? AND version = ?').get(plugin, step.version);
        if (done) continue;
        // Step + bookkeeping in ONE immediate transaction: a crash between them would otherwise re-run
        // a non-idempotent step on the next boot. Same lock discipline as applyAdditiveMigrations.
        withWriteLock(db, () => {
          step.up(handle);
          db.prepare('INSERT INTO plugin_migrations (plugin, version, applied_at) VALUES (?, ?, datetime(\'now\'))').run(plugin, step.version);
        });
        log.info(`[${plugin}] applied migration v${step.version}`);
      }
    },
  };
}
