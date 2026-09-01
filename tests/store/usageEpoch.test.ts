import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainUsageStore } from '../../src/store/brainUsageStore.js';
import { rebuildBrainUsageRollup } from '../../src/store/brainUsageRollup.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';
import { UserStore } from '../../src/store/userStore.js';

const AT = Date.parse('2026-08-31T12:00:00Z');
const usage = (totalTokens: number) => ({
  input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens,
  cost: { total: totalTokens / 1_000 },
});

function fixture() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'one', 'x'), (2, 'two', 'x')").run();
  const brain = new BrainStore(db);
  brain.createSession({ id: 's1', userId: 1, model: 'm', provider: 'p' });
  brain.createSession({ id: 's2', userId: 2, model: 'm', provider: 'p' });
  return { db, brain };
}

function assistant(brain: BrainStore, sessionId: string, id: string, totalTokens: number, timestamp = AT): void {
  brain.appendMessage({
    id, sessionId, parentId: null, role: 'assistant',
    content: { role: 'assistant', provider: 'p', providerIdentity: 'config', model: 'm', timestamp, usage: usage(totalTokens) },
  });
}

function finish(brain: BrainStore, requestId: string, totalTokens: number): void {
  brain.providerRequests.finish({
    requestId, status: 'succeeded', finishedAt: AT,
    response: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    usage: usage(totalTokens),
  });
}

describe('per-user usage epochs', () => {
  it('isolates users, ignores timestamps and advances through epoch two without rewriting history', () => {
    const { db, brain } = fixture();
    assistant(brain, 's1', 'old-1', 10, AT + 86_400_000);
    assistant(brain, 's2', 'other', 90, AT + 86_400_000);
    const oldContent = (db.prepare("SELECT content FROM brain_messages WHERE id = 'old-1'").get() as { content: string }).content;

    expect(brain.usageByModel(1)[0]?.usage.total).toBe(10);
    expect(brain.resetUsage(1)).toEqual({ chatCleared: 1, originsCleared: 0 });
    expect(brain.usageByModel(1)).toEqual([]);
    expect(brain.usageByModel(2)[0]?.usage.total).toBe(90);
    expect((db.prepare("SELECT content FROM brain_messages WHERE id = 'old-1'").get() as { content: string }).content).toBe(oldContent);

    assistant(brain, 's1', 'new-1', 20, AT + 86_400_000);
    expect(db.prepare("SELECT usage_epoch FROM brain_messages WHERE id = 'new-1'").get()).toEqual({ usage_epoch: 1 });
    expect(db.prepare("SELECT usage_epoch FROM brain_usage_rows WHERE source_message_id = 'new-1'").get()).toEqual({ usage_epoch: 1 });
    expect(brain.usageByModel(1)[0]?.usage.total).toBe(20);
    expect(brain.tokenTotals(1)).toEqual({ s1: 20 });
    expect(brain.tokenTotalsAll()).toMatchObject({ s1: 20, s2: 90 });

    expect(brain.clearUsage(1)).toBe(1);
    assistant(brain, 's1', 'new-2', 30, AT - 86_400_000);
    expect(db.prepare("SELECT usage_epoch FROM brain_messages WHERE id = 'new-2'").get()).toEqual({ usage_epoch: 2 });
    expect(brain.usageByModel(1)[0]?.usage.total).toBe(30);
    expect(db.prepare('SELECT usage_epoch FROM brain_usage_reset_state WHERE user_id = 1').get()).toEqual({ usage_epoch: 2 });
  });

  it('preserves epochs through settled-run rewrite, rekey and fork copies', () => {
    const { db, brain } = fixture();
    assistant(brain, 's1', 'old', 10);
    brain.clearUsage(1);
    brain.appendMessage({ id: 'user', sessionId: 's1', parentId: null, role: 'user', content: { role: 'user', content: 'next' } });
    expect(brain.persistAgentRun('s1', [
      { role: 'user', reusePreprojectedUser: true },
      { id: 'settled', role: 'assistant', content: { role: 'assistant', provider: 'p', model: 'm', timestamp: AT, usage: usage(20) } },
    ])).toBe(true);
    expect(db.prepare('SELECT id, usage_epoch FROM brain_messages WHERE session_id = ? ORDER BY rowid').all('s1'))
      .toEqual([{ id: 'old', usage_epoch: 0 }, { id: 'user', usage_epoch: 1 }, { id: 'settled', usage_epoch: 1 }]);

    brain.reassignSession('s1', 'archived');
    expect(db.prepare('SELECT id, usage_epoch FROM brain_messages WHERE session_id = ? ORDER BY rowid').all('archived'))
      .toEqual([{ id: 'old', usage_epoch: 0 }, { id: 'user', usage_epoch: 1 }, { id: 'settled', usage_epoch: 1 }]);
    brain.forkSession('archived', 'fork');
    expect(db.prepare('SELECT usage_epoch FROM brain_messages WHERE session_id = ? ORDER BY rowid').all('fork'))
      .toEqual([{ usage_epoch: 0 }, { usage_epoch: 1 }, { usage_epoch: 1 }]);
  });

  it('assigns generated rows to the epoch current when the run settles', () => {
    const { db, brain } = fixture();
    brain.appendMessage({ id: 'user-before-reset', sessionId: 's1', parentId: null, role: 'user', content: { role: 'user', content: 'in flight' } });

    brain.clearUsage(1);
    expect(brain.persistAgentRun('s1', [
      { role: 'user', reusePreprojectedUser: true },
      { id: 'assistant-after-reset', role: 'assistant', content: { role: 'assistant', provider: 'p', model: 'm', timestamp: AT, usage: usage(20) } },
    ])).toBe(true);

    expect(db.prepare('SELECT id, usage_epoch FROM brain_messages WHERE session_id = ? ORDER BY rowid').all('s1'))
      .toEqual([{ id: 'user-before-reset', usage_epoch: 0 }, { id: 'assistant-after-reset', usage_epoch: 1 }]);
  });

  it('keeps pre/post reset buckets separate through compaction, legacy reads and projection rebuilds', () => {
    const { db, brain } = fixture();
    assistant(brain, 's1', 'old', 10);
    brain.clearUsage(1);
    assistant(brain, 's1', 'new', 20);

    brain.compactSessionMessages('s1', { id: 'summary', role: 'compaction', content: { role: 'compactionSummary', text: 'kept' } }, 0);
    const content = JSON.parse((db.prepare("SELECT content FROM brain_messages WHERE id = 'summary'").get() as { content: string }).content) as {
      usageRollup: { usageEpoch: number; totalTokens: number }[];
    };
    expect(content.usageRollup.map((bucket) => [bucket.usageEpoch, bucket.totalTokens])).toEqual([[0, 10], [1, 20]]);
    expect(brain.usageByModel(1)[0]?.usage.total).toBe(20);
    expect(brain.tokenTotals(1)).toEqual({ s1: 20 });
    expect(brain.tokenTotalsAll()).toMatchObject({ s1: 20 });

    db.prepare('UPDATE brain_usage_rollup_state SET ready = 0 WHERE id = 1').run();
    expect(new BrainUsageStore(db).usageByModel(1)[0]?.usage.total).toBe(20);
    rebuildBrainUsageRollup(db);
    expect(new BrainUsageStore(db).usageByModel(1)[0]?.usage.total).toBe(20);
    expect(db.prepare("SELECT usage_epoch, total FROM brain_usage_rows WHERE source_message_id = 'summary' ORDER BY usage_epoch").all())
      .toEqual([{ usage_epoch: 0, total: 10 }, { usage_epoch: 1, total: 20 }]);
  });

  it('filters delegated descendant totals by the root owner epoch', () => {
    const { brain } = fixture();
    brain.createSession({ id: 'child', userId: 1, model: 'm', provider: 'p', parentSessionId: 's1' });
    assistant(brain, 'child', 'child-old', 11);
    brain.clearUsage(1);
    assistant(brain, 'child', 'child-new', 22);

    expect(brain.descendantUsage('s1')).toMatchObject({ totalTokens: 22, cost: 0.022 });
  });

  it('keeps provider rows physical, masks old wire usage and assigns pending completion to the new epoch', () => {
    const { db, brain } = fixture();
    const old = brain.providerRequests.start({
      sessionId: 's1', turnId: 'old', kind: 'chat', configuredProvider: 'p', wireProvider: 'p', api: 'a', model: 'm', payload: { messages: ['old'] },
    });
    finish(brain, old.requestId, 10);
    const pending = brain.providerRequests.start({
      sessionId: 's1', turnId: 'pending', kind: 'chat', configuredProvider: 'p', wireProvider: 'p', api: 'a', model: 'm', payload: { messages: ['pending'] },
    });
    const physicalBefore = brain.providerRequests.row(old.requestId)!;

    brain.clearUsage(1);
    expect(brain.providerRequests.row(old.requestId)).toEqual(physicalBefore);
    expect(brain.providerRequests.debugRequest('s1', old.requestId)).toMatchObject({ totalTokens: null, costUsd: null });
    expect(brain.providerRequests.debugRequests('s1')?.items[0]).toMatchObject({ totalTokens: null, costUsd: null });
    expect(db.prepare("SELECT request_count, total_tokens FROM brain_request_session_summary WHERE session_id = 's1'").get())
      .toEqual({ request_count: 1, total_tokens: 0 });

    finish(brain, pending.requestId, 7);
    expect(brain.providerRequests.row(pending.requestId)).toMatchObject({ usage_epoch: 1, total_tokens: 7 });
    expect(brain.providerRequests.debugRequest('s1', pending.requestId)).toMatchObject({ totalTokens: 7, costUsd: 0.007 });
    expect(brain.providerRequests.reconstruct(old.requestId)).toEqual({ messages: ['old'] });
    expect(db.prepare("SELECT request_count, error_count, total_tokens FROM brain_request_session_summary WHERE session_id = 's1'").get())
      .toEqual({ request_count: 2, error_count: 0, total_tokens: 7 });
  });

  it('rolls back epoch, summaries and origins when a later reset step fails, while preserving in-flight pins', () => {
    const { db, brain } = fixture();
    const origins = new UsageOriginStore(db);
    const request = brain.providerRequests.start({
      sessionId: 's1', turnId: 'old', kind: 'chat', configuredProvider: 'p', wireProvider: 'p', api: 'a', model: 'm', payload: {},
    });
    finish(brain, request.requestId, 10);
    origins.addTurn(1, { value: '203.0.113.1', kind: 'ip', trusted: true }, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10, cost: null }, AT);

    expect(() => brain.resetUsage(1, () => {
      origins.clearForUser(1);
      throw new Error('injected reset failure');
    })).toThrow(/injected reset failure/);
    expect(db.prepare('SELECT 1 FROM brain_usage_reset_state WHERE user_id = 1').get()).toBeUndefined();
    expect(db.prepare("SELECT total_tokens FROM brain_request_session_summary WHERE session_id = 's1'").get()).toEqual({ total_tokens: 10 });
    expect(db.prepare('SELECT total FROM usage_by_origin WHERE user_id = 1').get()).toEqual({ total: 10 });

    origins.recordRequest('s1', 1, { value: '203.0.113.2', kind: 'ip', trusted: true }, AT);
    brain.resetUsage(1, () => origins.clearForUser(1));
    expect(origins.pinnedOrigin('s1')).toMatchObject({ value: '203.0.113.2' });
    const settled = origins.settleTurn('s1');
    origins.addTurn(settled.userId!, settled.origin, { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5, cost: null }, AT);
    expect(db.prepare('SELECT total FROM usage_by_origin WHERE user_id = 1').get()).toEqual({ total: 5 });
  });

  it('cleans reset metadata on explicit user deletion', () => {
    const db = openDb(':memory:');
    const users = new UserStore(db);
    const user = users.create('one', 'pw');
    db.prepare('INSERT INTO brain_usage_reset_state (user_id, usage_epoch, reset_at) VALUES (?, 3, ?)').run(user.id, AT);

    users.delete(user.id);

    expect(db.prepare('SELECT 1 FROM brain_usage_reset_state WHERE user_id = ?').get(user.id)).toBeUndefined();
  });
});
