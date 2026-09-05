import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function session(store: BrainStore, id = 's1'): void {
  store.createSession({ id, userId: 1, model: 'test/model' });
}

describe('BrainStore conversation activity', () => {
  it('keeps CLI-only activity unread-free and baselines the first visible web acknowledgement', () => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.setDelegationBootId('boot-1');
    session(store);

    expect(store.getSessionActivity('s1')).toMatchObject({ state: 'idle', seq: 0, readSeq: 0, unread: false, webParticipatedAt: null });
    expect(store.beginSessionActivity('s1', 'turn-1', 'cli', 'working')).toBe(true);
    expect(store.settleSessionActivity('s1', 'turn-1', 'cli', 'done', 'finished')).toBe(true);
    expect(store.getSessionActivity('s1')).toMatchObject({ state: 'done', seq: 2, readSeq: 0, unread: false, webParticipatedAt: null });

    expect(store.ackSessionActivity('s1')).toBe(true);
    expect(store.ackSessionActivity('s1')).toBe(false);
    expect(store.getSessionActivity('s1')).toMatchObject({ seq: 2, readSeq: 2, unread: false });
    expect(store.getSessionActivity('s1')?.webParticipatedAt).not.toBeNull();
    db.close();
  });

  it('advances CLI reads after web participation without creating web participation', () => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.setDelegationBootId('boot-1');
    session(store);

    expect(store.beginSessionActivity('s1', 'web-turn', 'web')).toBe(true);
    expect(store.settleSessionActivity('s1', 'web-turn', 'web', 'done')).toBe(true);
    expect(store.ackSessionActivity('s1', 1, 'web')).toBe(true);
    expect(store.beginSessionActivity('s1', 'cli-turn', 'cli')).toBe(true);
    expect(store.settleSessionActivity('s1', 'cli-turn', 'cli', 'done')).toBe(true);
    expect(store.ackSessionActivity('s1', 4, 'cli')).toBe(true);
    expect(store.getSessionActivity('s1')).toMatchObject({ readSeq: 4, unread: false, webParticipatedAt: expect.any(String) });
    expect(store.ackSessionActivity('s1', 4, 'cli')).toBe(false);
    db.close();
  });

  it('uses the turn id as a CAS fence and keeps sequence values monotonic', () => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.setDelegationBootId('boot-1');
    session(store);

    expect(store.beginSessionActivity('s1', 'turn-1', 'web')).toBe(true);
    expect(store.beginSessionActivity('s1', 'turn-2', 'web')).toBe(false);
    expect(store.settleSessionActivity('s1', 'turn-2', 'web', 'failed', 'stale')).toBe(false);
    expect(store.settleSessionActivity('s1', 'turn-1', 'web', 'done')).toBe(true);
    expect(store.settleSessionActivity('s1', 'turn-1', 'web', 'failed')).toBe(false);
    expect(store.beginSessionActivity('s1', 'turn-2', 'web')).toBe(true);
    expect(store.ackSessionActivity('s1', 1)).toBe(true);
    expect(store.getSessionActivity('s1')).toMatchObject({ state: 'working', seq: 3, readSeq: 1, unread: true, turnId: 'turn-2' });
    expect(store.ackSessionActivity('s1', 99)).toBe(true);
    expect(store.getSessionActivity('s1')).toMatchObject({ readSeq: 3, unread: false });
    db.close();
  });

  it('reaps foreign working activity while restamping legitimately parked turns', () => {
    const db = openDb(':memory:');
    const first = new BrainStore(db);
    first.setDelegationBootId('boot-1');
    session(first, 'parked');
    session(first, 'foreign');
    expect(first.beginSessionActivity('parked', 'parked-turn', 'web', 'parked')).toBe(true);
    expect(first.beginSessionActivity('foreign', 'foreign-turn', 'cli', 'foreign')).toBe(true);
    first.markSessionParked('parked');

    const second = new BrainStore(db);
    second.setDelegationBootId('boot-2');
    expect(second.reconcileSessionActivityOnBoot()).toEqual({ reaped: 1, restamped: 1 });
    expect(second.getSessionActivity('parked')).toMatchObject({ state: 'working', seq: 1, turnId: 'parked-turn', bootId: 'boot-2' });
    expect(second.getSessionActivity('foreign')).toMatchObject({ state: 'idle', seq: 2, turnId: null, bootId: null });
    db.close();
  });

  it('settles a restamped parked resume and fails the same fence at terminal recovery', () => {
    const db = openDb(':memory:');
    const first = new BrainStore(db);
    first.setDelegationBootId('boot-1');
    session(first);
    expect(first.beginSessionActivity('s1', 'parked-turn', 'web')).toBe(true);
    first.markSessionParked('s1');

    const resumed = new BrainStore(db);
    resumed.setDelegationBootId('boot-2');
    expect(resumed.reconcileSessionActivityOnBoot()).toEqual({ reaped: 0, restamped: 1 });
    expect(resumed.settleSessionActivity('s1', 'parked-turn', 'web', 'done')).toBe(true);
    expect(resumed.getSessionActivity('s1')).toMatchObject({ state: 'done', turnId: null });

    expect(resumed.beginSessionActivity('s1', 'second-park', 'web')).toBe(true);
    resumed.markSessionParked('s1');
    expect(resumed.settleSessionActivity('s1', 'second-park', 'web', 'failed', 'gave up')).toBe(true);
    expect(resumed.getSessionActivity('s1')).toMatchObject({ state: 'failed', turnId: null, detail: 'gave up' });
    db.close();
  });

  it('reaps only working activity owned by an older boot and reset never rewinds sequence', () => {
    const db = openDb(':memory:');
    const first = new BrainStore(db);
    first.setDelegationBootId('boot-1');
    session(first);
    expect(first.beginSessionActivity('s1', 'turn-1', 'web', 'running')).toBe(true);

    const second = new BrainStore(db);
    second.setDelegationBootId('boot-2');
    expect(second.reapSessionActivity('s1')).toBe(true);
    expect(second.reapSessionActivity('s1')).toBe(false);
    expect(second.getSessionActivity('s1')).toMatchObject({ state: 'idle', seq: 2, turnId: null, bootId: null });
    expect(second.beginSessionActivity('s1', 'turn-2', 'cli')).toBe(true);
    expect(second.resetSessionActivity('s1', 'turn-2')).toBe(true);
    expect(second.getSessionActivity('s1')?.seq).toBe(4);
    db.close();
  });
});

describe('conversation activity migration', () => {
  it('adds neutral read columns to an existing database without scanning history', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'elowen-conversation-activity-'));
    const path = join(tempDir, 'legacy.db');
    const db = openDb(path);
    db.exec(`
      DROP TRIGGER brain_usage_rows_insert;
      DROP TRIGGER brain_usage_rows_delete;
      DROP TRIGGER brain_usage_rows_update;
      CREATE TABLE brain_sessions_legacy AS
        SELECT id, user_id, title, model, provider, work_dir, parent_session_id, delegated_access,
               forked_from_session_id, spill_ns, cleared_at, direct, last_writer_user_id, parked_at,
               park_attempts, created_at, updated_at FROM brain_sessions WHERE 0;
      DROP INDEX idx_brain_sessions_user;
      DROP INDEX idx_brain_sessions_debug_updated;
      DROP TABLE brain_sessions;
      ALTER TABLE brain_sessions_legacy RENAME TO brain_sessions;
      CREATE INDEX idx_brain_sessions_user ON brain_sessions(user_id);
      CREATE INDEX idx_brain_sessions_debug_updated ON brain_sessions(updated_at DESC, id DESC);
    `);
    db.prepare(`INSERT INTO brain_sessions
      (id, user_id, title, model, provider, work_dir, parent_session_id, delegated_access,
       forked_from_session_id, spill_ns, cleared_at, direct, last_writer_user_id, parked_at,
       park_attempts, created_at, updated_at)
      VALUES ('legacy', 1, '', 'm', '', '', NULL, NULL, NULL, 'legacy', NULL, 0, NULL, NULL, 0, datetime('now'), datetime('now'))`).run();
    db.prepare("INSERT INTO brain_messages (id, session_id, role, content) VALUES ('m1', 'legacy', 'user', 'old history')").run();
    db.pragma('user_version = 17');
    db.close();

    const migrated = openDb(path);
    const row = migrated.prepare(`SELECT activity_state, activity_seq, activity_read_seq, activity_turn_id,
      activity_boot_id, activity_detail, activity_at, web_participated_at FROM brain_sessions WHERE id = 'legacy'`).get() as Record<string, unknown>;
    expect(row).toEqual({
      activity_state: 'idle', activity_seq: 0, activity_read_seq: 0, activity_turn_id: null,
      activity_boot_id: null, activity_detail: '', activity_at: null, web_participated_at: null,
    });
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM brain_messages WHERE session_id = 'legacy'").get()).toEqual({ count: 1 });
    migrated.close();
  });

  it('keeps the activity listing on brain_sessions and its existing user index', () => {
    const db = openDb(':memory:');
    const plan = db.prepare(`EXPLAIN QUERY PLAN
      SELECT id, activity_state, activity_seq, activity_read_seq, activity_turn_id,
             activity_boot_id, activity_detail, activity_at, web_participated_at
        FROM brain_sessions WHERE user_id = ? ORDER BY updated_at DESC, id DESC`).all(1) as { detail: string }[];
    const details = plan.map((row) => row.detail).join(' ');
    expect(details).not.toMatch(/brain_messages/i);
    expect(details).toMatch(/idx_brain_sessions_user|brain_sessions/i);
    db.close();
  });
});
