import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainUsageStore } from '../../src/store/brainUsageStore.js';
import { rebuildBrainUsageRollup } from '../../src/store/brainUsageRollup.js';

describe('brain usage write-time projection', () => {
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
