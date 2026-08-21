import type { Db } from './dbTypes.js';
import { BRAIN_REGISTRY_PROVIDER_PREFIX } from '../shared/execs.js';

const numeric = (src: string, path: string, absent = '0'): string =>
  `CASE WHEN json_type(${src}, '${path}') IN ('integer', 'real') THEN json_extract(${src}, '${path}') ELSE ${absent} END`;

const markedProvider = (src: string, path: string): string => `NULLIF(CASE WHEN json_type(${src}, '${path}') = 'text' THEN
  CASE WHEN json_extract(${src}, '$.providerIdentity') = 'config'
    THEN json_extract(${src}, '${path}')
    WHEN json_extract(${src}, '${path}') LIKE '${BRAIN_REGISTRY_PROVIDER_PREFIX}%'
    THEN substr(json_extract(${src}, '${path}'), ${BRAIN_REGISTRY_PROVIDER_PREFIX.length + 1})
    ELSE json_extract(${src}, '${path}') END
END, '')`;

const columns = `source_message_id, bucket_index, session_id, user_id, provider, model, ts,
  input, output, cache_read, cache_write, total, reasoning, duration_ms, measured_output, cost`;

const liveSelect = (message: string, recoverProvider = 'NULL'): string => `
SELECT ${message}.id, -1, ${message}.session_id, s.user_id,
       COALESCE(${markedProvider(`${message}.content`, '$.provider')}, ${recoverProvider},
         CASE WHEN NULLIF(json_extract(${message}.content, '$.model'), '') IS NULL THEN NULLIF(s.provider, '') END),
       COALESCE(NULLIF(json_extract(${message}.content, '$.model'), ''), s.model),
       ${numeric(`${message}.content`, '$.timestamp', 'NULL')},
       ${numeric(`${message}.content`, '$.usage.input')},
       ${numeric(`${message}.content`, '$.usage.output')},
       ${numeric(`${message}.content`, '$.usage.cacheRead')},
       ${numeric(`${message}.content`, '$.usage.cacheWrite')},
       ${numeric(`${message}.content`, '$.usage.totalTokens')},
       ${numeric(`${message}.content`, '$.usage.reasoning')},
       ${numeric(`${message}.content`, '$.durationMs')},
       CASE WHEN ${numeric(`${message}.content`, '$.durationMs')} > 0
                  AND ${numeric(`${message}.content`, '$.usage.output')} > 0
            THEN ${numeric(`${message}.content`, '$.usage.output')} ELSE 0 END,
       ${numeric(`${message}.content`, '$.usage.cost.total', 'NULL')}
  FROM brain_sessions s
 WHERE s.id = ${message}.session_id AND ${message}.role = 'assistant'
   AND json_valid(${message}.content) AND json_type(${message}.content) = 'object'
   AND ${numeric(`${message}.content`, '$.timestamp', 'NULL')} IS NOT NULL`;

const rollupSelect = (message: string, recoverProvider = 'NULL'): string => `
SELECT ${message}.id, CAST(je.key AS INTEGER), ${message}.session_id, s.user_id,
       COALESCE(${markedProvider('je.value', '$.provider')}, ${recoverProvider}),
       COALESCE(NULLIF(json_extract(je.value, '$.model'), ''), s.model),
       ${numeric('je.value', '$.at', 'NULL')},
       ${numeric('je.value', '$.input')}, ${numeric('je.value', '$.output')},
       ${numeric('je.value', '$.cacheRead')}, ${numeric('je.value', '$.cacheWrite')},
       ${numeric('je.value', '$.totalTokens')}, ${numeric('je.value', '$.reasoning')},
       ${numeric('je.value', '$.durationMs')}, ${numeric('je.value', '$.measuredOutput')},
       ${numeric('je.value', '$.cost.total', 'NULL')}
  FROM brain_sessions s,
       json_each(CASE WHEN json_valid(${message}.content)
                      THEN CASE WHEN json_type(${message}.content, '$.usageRollup') = 'array'
                                THEN json_extract(${message}.content, '$.usageRollup') END END) je
 WHERE s.id = ${message}.session_id AND ${message}.role = 'compaction' AND je.type = 'object'
   AND ${numeric('je.value', '$.at', 'NULL')} IS NOT NULL`;

function insertTriggerBody(message: string): string {
  return `INSERT INTO brain_usage_rows (${columns}) ${liveSelect(message)};
  INSERT INTO brain_usage_rows (${columns}) ${rollupSelect(message)};
  UPDATE brain_usage_rollup_state SET generation = generation + 1 WHERE id = 1;`;
}

/** Install the cheap write-time projection. Existing databases remain on the legacy reader until the
 * explicit backfill marks this projection ready; a deploy therefore never performs a live-sized scan. */
export function installBrainUsageRollup(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_usage_rollup_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
      generation INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO brain_usage_rollup_state (id, ready, generation) VALUES (1, 0, 0);
    CREATE TABLE IF NOT EXISTS brain_usage_rows (
      source_message_id TEXT NOT NULL,
      bucket_index INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      provider TEXT,
      model TEXT NOT NULL,
      ts INTEGER NOT NULL,
      input REAL NOT NULL DEFAULT 0,
      output REAL NOT NULL DEFAULT 0,
      cache_read REAL NOT NULL DEFAULT 0,
      cache_write REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      reasoning REAL NOT NULL DEFAULT 0,
      duration_ms REAL NOT NULL DEFAULT 0,
      measured_output REAL NOT NULL DEFAULT 0,
      cost REAL,
      PRIMARY KEY (source_message_id, bucket_index)
    );
    CREATE INDEX IF NOT EXISTS idx_brain_usage_rows_user_ts ON brain_usage_rows(user_id, ts);
    CREATE INDEX IF NOT EXISTS idx_brain_usage_rows_user_model_ts ON brain_usage_rows(user_id, provider, model, ts);
    CREATE INDEX IF NOT EXISTS idx_brain_usage_rows_session ON brain_usage_rows(session_id);

    CREATE TRIGGER IF NOT EXISTS brain_usage_rows_insert AFTER INSERT ON brain_messages BEGIN
      ${insertTriggerBody('NEW')}
    END;
    CREATE TRIGGER IF NOT EXISTS brain_usage_rows_delete AFTER DELETE ON brain_messages BEGIN
      DELETE FROM brain_usage_rows WHERE source_message_id = OLD.id;
      UPDATE brain_usage_rollup_state SET generation = generation + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS brain_usage_rows_update AFTER UPDATE OF content, role, session_id ON brain_messages BEGIN
      DELETE FROM brain_usage_rows WHERE source_message_id = OLD.id;
      ${insertTriggerBody('NEW')}
    END;
  `);
  db.prepare(`UPDATE brain_usage_rollup_state SET ready = 1
               WHERE id = 1 AND ready = 0 AND NOT EXISTS (SELECT 1 FROM brain_messages)`).run();
}

/** Rebuild historical rows once, under one IMMEDIATE transaction. This is deliberately not called by
 * database startup: operators deploy the trigger-backed reader first, then run this against a verified
 * database copy before scheduling the production migration. */
export function rebuildBrainUsageRollup(db: Db): { rows: number; generation: number } {
  return db.transaction(() => {
    db.prepare('DELETE FROM brain_usage_rows').run();
    const sameModel = `sm AS MATERIALIZED (
      SELECT a.session_id,
             NULLIF(json_extract(a.content, '$.model'), '') AS model,
             MIN(${markedProvider('a.content', '$.provider')}) AS provider
        FROM brain_messages a
       WHERE a.role = 'assistant' AND json_valid(a.content) AND json_type(a.content) = 'object'
         AND NULLIF(json_extract(a.content, '$.model'), '') IS NOT NULL
         AND ${markedProvider('a.content', '$.provider')} IS NOT NULL
       GROUP BY a.session_id, NULLIF(json_extract(a.content, '$.model'), '')
      HAVING COUNT(DISTINCT ${markedProvider('a.content', '$.provider')}) = 1)`;
    const liveBackfill = liveSelect(
      'm',
      `(SELECT sm.provider FROM sm WHERE sm.session_id = m.session_id
          AND sm.model = NULLIF(json_extract(m.content, '$.model'), ''))`,
    ).replace('  FROM brain_sessions s\n', '  FROM brain_messages m JOIN brain_sessions s ON s.id = m.session_id\n');
    const rollupBackfill = rollupSelect(
      'm',
      `(SELECT sm.provider FROM sm WHERE sm.session_id = m.session_id
          AND sm.model = NULLIF(json_extract(je.value, '$.model'), ''))`,
    ).replace(
      '  FROM brain_sessions s,\n',
      '  FROM brain_messages m JOIN brain_sessions s ON s.id = m.session_id,\n',
    );
    // One materialized provider lookup feeds both halves. Running these as separate INSERTs would rebuild
    // the expensive legacy attribution CTE twice during the migration for no semantic benefit.
    db.exec(`WITH ${sameModel} INSERT INTO brain_usage_rows (${columns}) ${liveBackfill} UNION ALL ${rollupBackfill}`);
    db.prepare('UPDATE brain_usage_rollup_state SET ready = 1, generation = generation + 1 WHERE id = 1').run();
    const row = db.prepare(`SELECT (SELECT COUNT(*) FROM brain_usage_rows) AS rows, generation
                              FROM brain_usage_rollup_state WHERE id = 1`).get() as { rows: number; generation: number };
    return row;
  }).immediate();
}
