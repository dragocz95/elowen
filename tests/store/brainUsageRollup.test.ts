import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainUsageStore } from '../../src/store/brainUsageStore.js';
import { installBrainUsageRollup, rebuildBrainUsageRollup } from '../../src/store/brainUsageRollup.js';

describe('brain usage write-time projection', () => {
  it('projects exact call counts for live rows and new compaction day buckets', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('admin', 'x')").run();
    const store = new BrainStore(db);
    store.createSession({ id: 's1', userId: 1, model: 'model-a', provider: 'provider-a' });
    store.appendMessage({
      id: 'a1', sessionId: 's1', parentId: null, role: 'assistant',
      content: {
        role: 'assistant', model: 'model-a', provider: 'provider-a', providerIdentity: 'config',
        timestamp: Date.parse('2026-08-24T12:00:00Z'), usage: { totalTokens: 10 },
      },
    });
    store.appendMessage({ id: 'keep', sessionId: 's1', parentId: null, role: 'user', content: { role: 'user', content: 'keep' } });

    expect(db.prepare("SELECT calls FROM brain_usage_rows WHERE source_message_id = 'a1'").get()).toEqual({ calls: 1 });
    store.compactSessionMessages('s1', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary' } }, 1);
    expect(db.prepare("SELECT calls FROM brain_usage_rows WHERE source_message_id = 'sum'").get()).toEqual({ calls: 1 });
  });

  it('upgrades the prior projection shape without rewriting its historical rows', () => {
    const db = openDb(':memory:');
    db.exec(`
      DROP TRIGGER brain_usage_rows_insert;
      DROP TRIGGER brain_usage_rows_delete;
      DROP TRIGGER brain_usage_rows_update;
      DROP TABLE brain_usage_rows;
      CREATE TABLE brain_usage_rows (
        source_message_id TEXT NOT NULL, bucket_index INTEGER NOT NULL, session_id TEXT NOT NULL,
        user_id INTEGER NOT NULL, provider TEXT, model TEXT NOT NULL, ts INTEGER NOT NULL,
        input REAL NOT NULL DEFAULT 0, output REAL NOT NULL DEFAULT 0, cache_read REAL NOT NULL DEFAULT 0,
        cache_write REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, reasoning REAL NOT NULL DEFAULT 0,
        duration_ms REAL NOT NULL DEFAULT 0, measured_output REAL NOT NULL DEFAULT 0, cost REAL,
        PRIMARY KEY (source_message_id, bucket_index)
      );
      INSERT INTO brain_usage_rows
        (source_message_id, bucket_index, session_id, user_id, model, ts, total)
      VALUES ('historical', 0, 's', 1, 'm', 1, 99);
    `);

    installBrainUsageRollup(db);

    expect((db.prepare('PRAGMA table_info(brain_usage_rows)').all() as { name: string }[])
      .some((column) => column.name === 'calls')).toBe(true);
    expect(db.prepare("SELECT total, calls FROM brain_usage_rows WHERE source_message_id = 'historical'").get())
      .toEqual({ total: 99, calls: 0 });
  });

  it('backfills legacy provider attribution once and removes brain_messages from usage reads', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('admin', 'x')").run();
    db.prepare("INSERT INTO brain_sessions (id, user_id, model, provider) VALUES ('s1', 1, 'model-a', 'provider-now')").run();
    const at = Date.parse('2026-08-20T12:00:00Z');
    db.prepare('INSERT INTO brain_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(
      'a1', 's1', 'assistant', JSON.stringify({
        model: 'model-a', provider: 'provider-original', providerIdentity: 'config', timestamp: at,
        usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.03 } },
      }),
    );
    db.prepare('INSERT INTO brain_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(
      'c1', 's1', 'compaction', JSON.stringify({
        usageRollup: [{ model: 'model-a', at: at - 1, input: 5, output: 5, totalTokens: 10, cost: { total: 0.01 } }],
      }),
    );

    // Simulate an upgraded database before its explicit backfill: the legacy reader remains authoritative.
    db.prepare('UPDATE brain_usage_rollup_state SET ready = 0 WHERE id = 1').run();
    const legacy = new BrainUsageStore(db).usageByModel(1);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ provider: 'provider-original', model: 'model-a', usage: { total: 40, costUsd: 0.04 } });

    expect(rebuildBrainUsageRollup(db).rows).toBe(2);
    const spy = vi.spyOn(db, 'prepare');
    const projected = new BrainUsageStore(db).usageByModel(1);
    expect(projected).toEqual(legacy);
    expect(spy.mock.calls.some(([sql]) => sql.includes('usage_rows AS'))).toBe(false);

    const plan = db.prepare(`EXPLAIN QUERY PLAN
      SELECT provider, model, SUM(total) FROM brain_usage_rows
       WHERE user_id = 1 AND ts >= ? GROUP BY provider, model`).all(at - 1000) as { detail: string }[];
    expect(plan.map((row) => row.detail).join('\n')).toContain('idx_brain_usage_rows_user_ts');
  });
});
