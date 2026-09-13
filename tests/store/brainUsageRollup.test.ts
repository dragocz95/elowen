import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainUsageStore, rollupDroppedUsage } from '../../src/store/brainUsageStore.js';
import { installBrainUsageRollup, rebuildBrainUsageRollup } from '../../src/store/brainUsageRollup.js';

describe('brain usage write-time projection', () => {
  it('folds only valid content-only generations into the effective pair while retaining totals', () => {
    const assistant = (content: unknown) => ({
      usage_epoch: 0,
      content: JSON.stringify({
        role: 'assistant', timestamp: 1, effectiveMs: 1000, content,
        usage: { output: 100, totalTokens: 150 },
      }),
    });
    const rollup = rollupDroppedUsage([
      assistant([{ type: 'text', text: 'answer' }]),
      assistant([{ type: 'thinking', thinking: 'plan' }, { type: 'toolCall', name: 'Read', arguments: {} }]),
      assistant(undefined),
      assistant('answer'),
      assistant([{ type: 'text', text: 'ok' }, 42]),
    ]);
    expect(rollup).toMatchObject([{
      output: 500, totalTokens: 750, effectiveTimingVersion: 2, effectiveMs: 1000, effectiveOutput: 100,
    }]);
  });

  it('projects exact call counts for live rows and new compaction day buckets', () => {
    const db = openDb(':memory:');
    expect(db.prepare('SELECT ready, effective_pair_version FROM brain_usage_rollup_state WHERE id = 1').get())
      .toEqual({ ready: 1, effective_pair_version: 2 });
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

  it('fails closed for malformed assistant content in legacy reads and insert/update triggers', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('admin', 'x')").run();
    db.prepare("INSERT INTO brain_sessions (id, user_id, model, provider) VALUES ('s1', 1, 'm', 'p')").run();
    const messageJson = (content: unknown, includeContent = true) => JSON.stringify({
      model: 'm', provider: 'p', timestamp: 1, effectiveMs: 1000,
      ...(includeContent ? { content } : {}), usage: { output: 100, totalTokens: 100 },
    });
    const insert = db.prepare(
      "INSERT INTO brain_messages (id, session_id, role, content, usage_epoch) VALUES (?, 's1', 'assistant', ?, 0)",
    );
    insert.run('eligible', messageJson([{ type: 'text', text: 'answer' }]));
    insert.run('missing', messageJson(undefined, false));
    insert.run('non-array', messageJson('answer'));
    insert.run('scalar-block', messageJson([{ type: 'text', text: 'ok' }, 42]));

    expect(db.prepare('SELECT source_message_id, effective_ms, effective_output FROM brain_usage_rows ORDER BY source_message_id').all())
      .toEqual([
        { source_message_id: 'eligible', effective_ms: 1000, effective_output: 100 },
        { source_message_id: 'missing', effective_ms: 0, effective_output: 0 },
        { source_message_id: 'non-array', effective_ms: 0, effective_output: 0 },
        { source_message_id: 'scalar-block', effective_ms: 0, effective_output: 0 },
      ]);

    db.prepare("UPDATE brain_messages SET content = ? WHERE id = 'eligible'")
      .run(messageJson([{ type: 'text', text: 'ok' }, null]));
    expect(db.prepare("SELECT effective_ms, effective_output FROM brain_usage_rows WHERE source_message_id = 'eligible'").get())
      .toEqual({ effective_ms: 0, effective_output: 0 });

    db.prepare('UPDATE brain_usage_rollup_state SET ready = 0, effective_pair_version = 1 WHERE id = 1').run();
    const legacy = new BrainUsageStore(db).usageByModel(1)[0]!.usage;
    expect(legacy.output).toBe(400);
    expect(legacy.effectiveMeasuredOutput).toBe(0);
    expect(legacy.effectiveTps).toBeNull();
  });

  it('upgrades the prior projection shape without rewriting its historical rows', () => {
    const db = openDb(':memory:');
    db.exec(`
      DROP TRIGGER brain_usage_rows_insert;
      DROP TRIGGER brain_usage_rows_delete;
      DROP TRIGGER brain_usage_rows_update;
      DROP TABLE brain_usage_rows;
      DROP TABLE brain_usage_rollup_state;
      CREATE TABLE brain_usage_rollup_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
        generation INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO brain_usage_rollup_state (id, ready, generation) VALUES (1, 1, 7);
      CREATE TABLE brain_usage_rows (
        source_message_id TEXT NOT NULL, bucket_index INTEGER NOT NULL, session_id TEXT NOT NULL,
        user_id INTEGER NOT NULL, provider TEXT, model TEXT NOT NULL, ts INTEGER NOT NULL,
        input REAL NOT NULL DEFAULT 0, output REAL NOT NULL DEFAULT 0, cache_read REAL NOT NULL DEFAULT 0,
        cache_write REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, reasoning REAL NOT NULL DEFAULT 0,
        duration_ms REAL NOT NULL DEFAULT 0, measured_output REAL NOT NULL DEFAULT 0,
        effective_ms REAL NOT NULL DEFAULT 0, cost REAL,
        PRIMARY KEY (source_message_id, bucket_index)
      );
      INSERT INTO brain_usage_rows
        (source_message_id, bucket_index, session_id, user_id, model, ts, total)
      VALUES ('historical', 0, 's', 1, 'm', 1, 99);
    `);

    installBrainUsageRollup(db);

    const upgraded = new Set((db.prepare('PRAGMA table_info(brain_usage_rows)').all() as { name: string }[])
      .map((column) => column.name));
    expect(upgraded.has('calls')).toBe(true);
    expect(upgraded.has('usage_epoch')).toBe(true);
    expect(upgraded.has('effective_ms')).toBe(true);
    expect(upgraded.has('effective_output')).toBe(true);
    expect(db.prepare("SELECT total, calls, usage_epoch, effective_ms, effective_output FROM brain_usage_rows WHERE source_message_id = 'historical'").get())
      .toEqual({ total: 99, calls: 0, usage_epoch: 0, effective_ms: 0, effective_output: 0 });
    expect(db.prepare('SELECT ready, generation, effective_pair_version FROM brain_usage_rollup_state WHERE id = 1').get())
      .toEqual({ ready: 1, generation: 7, effective_pair_version: 0 });

    installBrainUsageRollup(db);
    expect(db.prepare("SELECT total, calls, usage_epoch, effective_ms, effective_output FROM brain_usage_rows WHERE source_message_id = 'historical'").get())
      .toEqual({ total: 99, calls: 0, usage_epoch: 0, effective_ms: 0, effective_output: 0 });
    expect(db.prepare('SELECT ready, generation, effective_pair_version FROM brain_usage_rollup_state WHERE id = 1').get())
      .toEqual({ ready: 1, generation: 7, effective_pair_version: 0 });
  });

  it('repairs effective pairs projected before failed retry prefixes were excluded', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('admin', 'x')").run();
    const store = new BrainStore(db);
    store.createSession({ id: 's1', userId: 1, model: 'model-a', provider: 'provider-a' });
    store.appendMessage({
      id: 'failed', sessionId: 's1', parentId: null, role: 'assistant',
      content: {
        role: 'assistant', model: 'model-a', timestamp: 1, stopReason: 'error', effectiveMs: 2000,
        usage: { output: 20, totalTokens: 30 },
      },
    });
    store.appendMessage({
      id: 'summary', sessionId: 's1', parentId: null, role: 'compaction',
      content: {
        role: 'compactionSummary', usageRollup: [{
          model: 'model-a', at: 2, output: 100, totalTokens: 100, effectiveMs: 5000, effectiveOutput: 100,
        }],
      },
    });
    // Reproduce rows written by the first effective-speed projection, before the discriminator existed.
    db.prepare('UPDATE brain_usage_rows SET effective_ms = 2000, effective_output = 20 WHERE source_message_id = ?').run('failed');
    db.prepare('UPDATE brain_usage_rows SET effective_ms = 5000, effective_output = 100 WHERE source_message_id = ?').run('summary');
    db.prepare('UPDATE brain_usage_rollup_state SET effective_pair_version = 0 WHERE id = 1').run();

    installBrainUsageRollup(db);

    // Startup does not scan source history. Version 1 remains unavailable until the explicit rebuild seam.
    expect(db.prepare('SELECT source_message_id, effective_ms, effective_output FROM brain_usage_rows ORDER BY source_message_id').all())
      .toEqual([
        { source_message_id: 'failed', effective_ms: 2000, effective_output: 20 },
        { source_message_id: 'summary', effective_ms: 5000, effective_output: 100 },
      ]);
    expect(db.prepare('SELECT effective_pair_version FROM brain_usage_rollup_state WHERE id = 1').get())
      .toEqual({ effective_pair_version: 0 });
    expect(rebuildBrainUsageRollup(db).rows).toBe(2);
    expect(db.prepare('SELECT source_message_id, effective_ms, effective_output FROM brain_usage_rows ORDER BY source_message_id').all())
      .toEqual([
        { source_message_id: 'failed', effective_ms: 0, effective_output: 0 },
        { source_message_id: 'summary', effective_ms: 0, effective_output: 0 },
      ]);
  });

  it('rebuilds only exact live effective pairs and makes the semantic version bump idempotent', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('admin', 'x')").run();
    db.prepare("INSERT INTO brain_sessions (id, user_id, model, provider) VALUES ('s1', 1, 'm', 'p')").run();
    const message = (id: string, content: unknown, includeContent = true) => db.prepare(
      'INSERT INTO brain_messages (id, session_id, role, content, usage_epoch) VALUES (?, ?, ?, ?, 0)',
    ).run(id, 's1', 'assistant', JSON.stringify({ model: 'm', provider: 'p', timestamp: 1, effectiveMs: 1000,
      ...(includeContent ? { content } : {}), usage: { output: 10, totalTokens: 10 } }));
    message('eligible', [{ type: 'text', text: 'done' }]);
    message('tool', [{ type: 'toolCall', name: 'Read', arguments: {} }]);
    message('missing', undefined, false);
    message('non-array', { type: 'text', text: 'done' });
    message('scalar-block', [{ type: 'text', text: 'done' }, false]);
    db.prepare('UPDATE brain_usage_rows SET effective_ms = 1000, effective_output = 10').run();
    db.prepare('UPDATE brain_usage_rollup_state SET effective_pair_version = 1 WHERE id = 1').run();

    installBrainUsageRollup(db);
    expect(db.prepare('SELECT source_message_id, effective_ms, effective_output FROM brain_usage_rows ORDER BY source_message_id').all())
      .toEqual([
        { source_message_id: 'eligible', effective_ms: 1000, effective_output: 10 },
        { source_message_id: 'missing', effective_ms: 1000, effective_output: 10 },
        { source_message_id: 'non-array', effective_ms: 1000, effective_output: 10 },
        { source_message_id: 'scalar-block', effective_ms: 1000, effective_output: 10 },
        { source_message_id: 'tool', effective_ms: 1000, effective_output: 10 },
      ]);
    expect(db.prepare('SELECT generation, effective_pair_version FROM brain_usage_rollup_state WHERE id = 1').get())
      .toEqual({ generation: 5, effective_pair_version: 1 });
    installBrainUsageRollup(db);
    expect(db.prepare('SELECT generation, effective_pair_version FROM brain_usage_rollup_state WHERE id = 1').get())
      .toEqual({ generation: 5, effective_pair_version: 1 });

    const first = rebuildBrainUsageRollup(db);
    expect(first.rows).toBe(5);
    expect(db.prepare('SELECT source_message_id, effective_ms, effective_output FROM brain_usage_rows ORDER BY source_message_id').all())
      .toEqual([
        { source_message_id: 'eligible', effective_ms: 1000, effective_output: 10 },
        { source_message_id: 'missing', effective_ms: 0, effective_output: 0 },
        { source_message_id: 'non-array', effective_ms: 0, effective_output: 0 },
        { source_message_id: 'scalar-block', effective_ms: 0, effective_output: 0 },
        { source_message_id: 'tool', effective_ms: 0, effective_output: 0 },
      ]);
    expect(db.prepare('SELECT ready, effective_pair_version FROM brain_usage_rollup_state WHERE id = 1').get())
      .toEqual({ ready: 1, effective_pair_version: 2 });

    installBrainUsageRollup(db);
    expect(db.prepare('SELECT generation, effective_pair_version FROM brain_usage_rollup_state WHERE id = 1').get())
      .toEqual({ generation: first.generation, effective_pair_version: 2 });
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
