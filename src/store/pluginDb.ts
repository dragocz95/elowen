import { withWriteLock } from './db.js';
import { logger } from '../shared/logger.js';
import type { Db } from './db.js';
import type { PluginDb, PluginDbHandle, PluginDbMigrationStep } from '../plugins/api.js';

const log = logger('plugin-db');

/** Build the namespaced main-database handle a plugin receives as `ctx.db()`.
 *
 *  One shared SQLite file, not a per-plugin sidecar: a plugin migrated out of the core (agents) keeps
 *  transacting across its own tables and the core's (mission row + task status is one logical write),
 *  there is one WAL/backup/busy_timeout discipline, and existing installs keep their data in place.
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
