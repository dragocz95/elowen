import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { SessionQueue, combineQueuedText, firstBatchSize, type QueueSnapshotItem, type QueuedMessage } from '../../src/brain/session/sessionQueue.js';

/** A store-backed queue harness: a real in-memory brain store (durable across a simulated respawn) plus a
 *  spy capturing every snapshot the queue emits. */
function harness() {
  const emits: { sessionId: string; items: QueueSnapshotItem[] }[] = [];
  const emit = vi.fn((sessionId: string, items: QueueSnapshotItem[]) => emits.push({ sessionId, items }));
  const store = new BrainStore(openDb(':memory:'));
  return { emit, emits, store, queue: new SessionQueue(store, emit) };
}

const msg = (text: string, over: Partial<{ userId: number; mode: 'build' | 'plan'; display: string; images: { data: string; mimeType: string }[] }> = {}) =>
  ({ userId: over.userId ?? 1, text, display: over.display ?? text, mode: over.mode ?? ('build' as const), at: Date.now(), ...(over.images ? { images: over.images } : {}) });

describe('SessionQueue', () => {
  it('enqueue appends in order, mints ids, and emits a full snapshot each time (chip = display text)', () => {
    const { queue, emits } = harness();
    const id1 = queue.enqueue('s1', msg('one', { display: 'one (clean)' }));
    const id2 = queue.enqueue('s1', msg('two'));
    expect(id1).not.toBe(id2);
    expect(queue.list('s1')).toEqual([{ id: id1, text: 'one (clean)' }, { id: id2, text: 'two' }]);
    // Each mutation broadcasts the CURRENT full snapshot (not a delta).
    expect(emits.map((e) => e.items.map((i) => i.text))).toEqual([['one (clean)'], ['one (clean)', 'two']]);
    expect(emits.every((e) => e.sessionId === 's1')).toBe(true);
  });

  it('list snapshot omits image bytes (id + display text only)', () => {
    const { queue } = harness();
    queue.enqueue('s1', { ...msg('with image'), images: [{ data: 'AAAA', mimeType: 'image/png' }] });
    expect(queue.list('s1')).toEqual([{ id: expect.any(String), text: 'with image' }]);
  });

  it('remove drops one by id and emits the reduced snapshot; unknown id is a no-op', () => {
    const { queue, emit } = harness();
    const a = queue.enqueue('s1', msg('a'));
    const b = queue.enqueue('s1', msg('b'));
    emit.mockClear();
    expect(queue.remove('s1', a)).toBe(true);
    expect(queue.list('s1')).toEqual([{ id: b, text: 'b' }]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![1]).toEqual([{ id: b, text: 'b' }]);
    // Unknown id → false, no emit.
    emit.mockClear();
    expect(queue.remove('s1', 'nope')).toBe(false);
    expect(queue.remove('other-session', b)).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('drainBatch returns AND clears the batch, emitting the remaining snapshot (only when non-empty)', () => {
    const { queue, emit } = harness();
    queue.enqueue('s1', msg('first'));
    queue.enqueue('s1', msg('second'));
    emit.mockClear();
    const drained = queue.drainBatch('s1');
    expect(drained.map((m) => m.text)).toEqual(['first', 'second']);
    expect(queue.list('s1')).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![1]).toEqual([]); // the cleared snapshot
    // Draining an already-empty queue is silent.
    emit.mockClear();
    expect(queue.drainBatch('s1')).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('clear drops everything and emits an empty snapshot when there was something to clear', () => {
    const { queue, emit } = harness();
    queue.enqueue('s1', msg('x'));
    emit.mockClear();
    queue.clear('s1');
    expect(queue.list('s1')).toEqual([]);
    expect(emit).toHaveBeenCalledWith('s1', []);
    // Clearing an empty queue is silent.
    emit.mockClear();
    queue.clear('s1');
    expect(emit).not.toHaveBeenCalled();
  });

  it('queues are isolated per session', () => {
    const { queue } = harness();
    queue.enqueue('s1', msg('a'));
    queue.enqueue('s2', msg('b'));
    expect(queue.list('s1').map((m) => m.text)).toEqual(['a']);
    expect(queue.list('s2').map((m) => m.text)).toEqual(['b']);
    queue.drainBatch('s1');
    expect(queue.list('s2').map((m) => m.text)).toEqual(['b']); // untouched
  });

  it('durability: an accepted-but-undelivered message survives a daemon restart (re-seeds from the store)', () => {
    const { store, queue } = harness();
    queue.enqueue('s1', { ...msg('survive me', { display: 'survive me (clean)' }), images: [{ data: 'IMG', mimeType: 'image/png' }] });
    // A fresh SessionQueue over the SAME store simulates the daemon restarting: the rows are still there.
    const respawned = new SessionQueue(store, () => {});
    expect(respawned.list('s1')).toEqual([{ id: expect.any(String), text: 'survive me (clean)' }]);
    // And the delivered batch still carries the model text + image bytes for the flush turn.
    const drained = respawned.drainBatch('s1');
    expect(drained).toHaveLength(1);
    expect(drained[0]!.text).toBe('survive me');
    expect(drained[0]!.images).toEqual([{ data: 'IMG', mimeType: 'image/png' }]);
    // Drained from the durable store too — a second respawn sees nothing.
    expect(new SessionQueue(store, () => {}).list('s1')).toEqual([]);
  });

  it('drainBatch splits on a mode change — a plan-mode message NEVER rides a build-mode batch (safety)', () => {
    const { queue } = harness();
    queue.enqueue('s1', msg('fix the tests', { mode: 'build' }));
    queue.enqueue('s1', msg('and this too', { mode: 'build' }));
    queue.enqueue('s1', msg('wait — only propose a plan', { mode: 'plan' }));
    // First batch is the leading same-mode (build) run — the plan message is left behind.
    const first = queue.drainBatch('s1');
    expect(first.map((m) => m.text)).toEqual(['fix the tests', 'and this too']);
    expect(first.every((m) => m.mode === 'build')).toBe(true);
    // The plan message drains as its OWN batch, in plan mode.
    const second = queue.drainBatch('s1');
    expect(second.map((m) => m.text)).toEqual(['wait — only propose a plan']);
    expect(second[0]!.mode).toBe('plan');
    expect(queue.drainBatch('s1')).toEqual([]);
  });

  it('drainBatch caps images per batch — excess images split into a follow-up batch, never dropped', () => {
    const { queue } = harness();
    const three = (tag: string) => [0, 1, 2].map((i) => ({ data: `${tag}${i}`, mimeType: 'image/png' }));
    queue.enqueue('s1', msg('shots A', { images: three('a') })); // 3 images
    queue.enqueue('s1', msg('shots B', { images: three('b') })); // 3 images — 3+3 > 4 cap
    const first = queue.drainBatch('s1');
    expect(first.map((m) => m.text)).toEqual(['shots A']);
    expect(first.flatMap((m) => m.images ?? [])).toHaveLength(3);
    const second = queue.drainBatch('s1');
    expect(second.map((m) => m.text)).toEqual(['shots B']);
    expect(second.flatMap((m) => m.images ?? [])).toHaveLength(3);
    // Every image is delivered across the two batches (6 total), none silently dropped.
    expect(new SessionQueue(harness().store, () => {}).list('s1')).toEqual([]);
  });
});

describe('firstBatchSize', () => {
  const build = (images = 0): QueuedMessage => ({ id: 'x', userId: 1, text: 't', display: 't', mode: 'build', at: 0, ...(images ? { images: Array.from({ length: images }, () => ({ data: 'd', mimeType: 'image/png' })) } : {}) });
  const plan = (): QueuedMessage => ({ ...build(), mode: 'plan' });
  it('is 0 for an empty list and always ≥1 otherwise', () => {
    expect(firstBatchSize([])).toBe(0);
    expect(firstBatchSize([build()])).toBe(1);
  });
  it('stops at the first mode change', () => {
    expect(firstBatchSize([build(), build(), plan(), build()])).toBe(2);
  });
  it('stops before the image cap is exceeded (default cap 4)', () => {
    expect(firstBatchSize([build(2), build(2), build(2)])).toBe(2); // 2+2=4 ok, +2 would be 6
    expect(firstBatchSize([build(4), build(1)])).toBe(1); // one full-cap message stands alone
  });
});

describe('combineQueuedText', () => {
  it('passes a single message through verbatim', () => {
    expect(combineQueuedText([{ text: 'just one' }])).toBe('just one');
  });
  it('separates multiple messages with a blank line', () => {
    expect(combineQueuedText([{ text: 'one' }, { text: 'two' }, { text: 'three' }])).toBe('one\n\ntwo\n\nthree');
  });
});
