import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrainEvent } from '../../../src/brain/events.js';
import {
  HYDRATION_MAX_BYTES,
  HYDRATION_MAX_EVENTS,
  SerializedEventBuffer,
} from '../../../src/brain/session/serializedEventBuffer.js';
import {
  SnapshotHydrator,
  SnapshotLaneLease,
  SnapshotTimeoutError,
} from '../../../src/cli/chat/snapshotHydrator.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('SerializedEventBuffer', () => {
  it('accepts exactly the event limit and rejects the next raw event without retaining a suffix', () => {
    const buffer = new SerializedEventBuffer<{ n: number }>({ maxEvents: HYDRATION_MAX_EVENTS, maxBytes: Number.MAX_SAFE_INTEGER });
    for (let n = 0; n < HYDRATION_MAX_EVENTS; n += 1) expect(buffer.append({ n })).toBe('accepted');
    expect(buffer.count).toBe(HYDRATION_MAX_EVENTS);

    expect(buffer.append({ n: HYDRATION_MAX_EVENTS })).toBe('overflow');
    expect(buffer.count).toBe(0);
    expect(buffer.bytes).toBe(0);
    expect(buffer.values()).toEqual([]);
  });

  it('accounts serialized UTF-8 JSON bytes, including multibyte text, and accepts exactly the byte limit', () => {
    const event = { text: 'Žluťoučký 🐉' };
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    expect(bytes).toBeGreaterThan(JSON.stringify(event).length);

    const exact = new SerializedEventBuffer<typeof event>({ maxEvents: 10, maxBytes: bytes });
    expect(exact.append(event)).toBe('accepted');
    expect(exact.bytes).toBe(bytes);

    const short = new SerializedEventBuffer<typeof event>({ maxEvents: 10, maxBytes: bytes - 1 });
    expect(short.append(event)).toBe('overflow');
    expect(short.count).toBe(0);
  });

  it('accepts exactly four MiB of serialized JSON and rejects the next byte', () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ text: '' })).byteLength;
    const event = { text: 'a'.repeat(HYDRATION_MAX_BYTES - overhead) };
    const buffer = new SerializedEventBuffer<typeof event>();
    expect(buffer.append(event)).toBe('accepted');
    expect(buffer.bytes).toBe(HYDRATION_MAX_BYTES);
    expect(buffer.append({ text: '' })).toBe('overflow');
    expect(buffer.count).toBe(0);
  });

  it('treats JSON serialization failure as overflow and discards the complete replay', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const buffer = new SerializedEventBuffer<unknown>({ maxEvents: 10, maxBytes: HYDRATION_MAX_BYTES });
    expect(buffer.append({ ok: true })).toBe('accepted');
    expect(buffer.append(cyclic)).toBe('overflow');
    expect(buffer.values()).toEqual([]);
  });
});

describe('SnapshotHydrator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps lease capabilities limited to hydration operations', () => {
    expect(Object.getOwnPropertyDescriptor(SnapshotLaneLease.prototype, 'lane')).toBeUndefined();
    expect(SnapshotLaneLease.prototype.cancel).toBeUndefined();
  });

  it('times out a transport that ignores abort, retains the last valid state and fences its late result', async () => {
    vi.useFakeTimers();
    const lifecycle = new AbortController();
    const request = deferred<string[]>();
    const commits: string[][] = [];
    const retained: BrainEvent[][] = [];
    const notices: Error[] = [];
    const hydrator = new SnapshotHydrator<BrainEvent>({ timeoutMs: 10_000 });
    const lane = hydrator.openLane('parent', lifecycle.signal, { onOverflow: vi.fn() });

    const operation = lane.hydrate(
      (signal) => {
        signal.addEventListener('abort', () => { /* transport deliberately ignores it */ });
        return request.promise;
      },
      {
        commit: (history) => commits.push(history),
        retain: (replay, error) => {
          retained.push([...replay]);
          notices.push(error as Error);
        },
      },
    );
    expect(lane.buffer({ type: 'text', delta: 'still live' })).toBe('buffered');
    expect(lane.status()).toMatchObject({ state: 'hydrating', bufferedEvents: 1, activeTimer: true });

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(operation).resolves.toBe('timeout');
    expect(retained).toEqual([[{ type: 'text', delta: 'still live' }]]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBeInstanceOf(SnapshotTimeoutError);
    expect(commits).toEqual([]);
    expect(lane.status()).toMatchObject({ state: 'timed-out', bufferedEvents: 0, activeTimer: false });
    expect(vi.getTimerCount()).toBe(0);

    request.resolve(['late stale history']);
    await tick();
    expect(commits).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  it('aborts and disposes the history operation on overflow, then requests one fresh snapshot', async () => {
    const lifecycle = new AbortController();
    const request = deferred<string[]>();
    let requestSignal!: AbortSignal;
    const onOverflow = vi.fn();
    const commit = vi.fn();
    const retain = vi.fn();
    const hydrator = new SnapshotHydrator<BrainEvent>({ maxEvents: 2, maxBytes: HYDRATION_MAX_BYTES });
    const lane = hydrator.openLane('parent', lifecycle.signal, { onOverflow });
    const operation = lane.hydrate((signal) => { requestSignal = signal; return request.promise; }, { commit, retain });

    expect(lane.buffer({ type: 'text', delta: 'one' })).toBe('buffered');
    expect(lane.buffer({ type: 'text', delta: 'two' })).toBe('buffered');
    expect(lane.buffer({ type: 'text', delta: 'three' })).toBe('overflow');
    expect(requestSignal.aborted).toBe(true);
    await expect(operation).resolves.toBe('overflow');
    expect(lane.status()).toMatchObject({ state: 'overflowed', bufferedEvents: 0, bufferedBytes: 0, activeTimer: false });
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();

    expect(lane.buffer({ type: 'text', delta: 'ignored after overflow' })).toBe('stale');
    expect(onOverflow).toHaveBeenCalledTimes(1);
    request.resolve(['late']);
    await tick();
    expect(commit).not.toHaveBeenCalled();
  });

  it('aborts history on serialized UTF-8 byte overflow without applying a partial replay', async () => {
    const event = { type: 'text' as const, delta: '🐉' };
    const exactBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    const lifecycle = new AbortController();
    const request = deferred<string[]>();
    let requestSignal!: AbortSignal;
    const onOverflow = vi.fn();
    const commit = vi.fn();
    const retain = vi.fn();
    const hydrator = new SnapshotHydrator<BrainEvent>({ maxEvents: 10, maxBytes: exactBytes });
    const lane = hydrator.openLane('child', lifecycle.signal, { awaitingSnapshot: true, onOverflow });
    const operation = lane.hydrate((signal) => { requestSignal = signal; return request.promise; }, { commit, retain });

    expect(lane.buffer(event)).toBe('buffered');
    expect(lane.buffer({ type: 'text', delta: 'x' })).toBe('overflow');
    await expect(operation).resolves.toBe('overflow');
    expect(requestSignal.aborted).toBe(true);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
    expect(lane.status()).toMatchObject({ bufferedEvents: 0, bufferedBytes: 0 });
  });

  it('keeps parent and child lanes independent', async () => {
    const parentRequest = deferred<string[]>();
    const childRequest = deferred<string[]>();
    const parentLifecycle = new AbortController();
    const childLifecycle = new AbortController();
    const parentCommit = vi.fn();
    const childCommit = vi.fn();
    const hydrator = new SnapshotHydrator<BrainEvent>();
    const parent = hydrator.openLane('parent', parentLifecycle.signal, { onOverflow: vi.fn() });
    const child = hydrator.openLane('child', childLifecycle.signal, { awaitingSnapshot: true, onOverflow: vi.fn() });
    const p = parent.hydrate(() => parentRequest.promise, { commit: parentCommit, retain: vi.fn() });
    const c = child.hydrate(() => childRequest.promise, { commit: childCommit, retain: vi.fn() });
    parent.buffer({ type: 'text', delta: 'parent' });
    child.buffer({ type: 'text', delta: 'child' });

    parentRequest.resolve(['P']);
    await expect(p).resolves.toBe('committed');
    expect(parentCommit).toHaveBeenCalledWith(['P'], [{ type: 'text', delta: 'parent' }]);
    expect(child.status()).toMatchObject({ state: 'hydrating', bufferedEvents: 1 });

    childRequest.resolve(['C']);
    await expect(c).resolves.toBe('committed');
    expect(childCommit).toHaveBeenCalledWith(['C'], [{ type: 'text', delta: 'child' }]);
  });

  it('atomically applying a snapshot supersedes compaction history and its buffered replay', async () => {
    const request = deferred<string[]>();
    const lifecycle = new AbortController();
    const commitHistory = vi.fn();
    const commitSnapshot = vi.fn();
    const hydrator = new SnapshotHydrator<BrainEvent>();
    const lane = hydrator.openLane('parent', lifecycle.signal, { onOverflow: vi.fn() });
    const operation = lane.hydrate(() => request.promise, { commit: commitHistory, retain: vi.fn() });
    lane.buffer({ type: 'text', delta: 'stale replay' });

    expect(lane.applySnapshot(commitSnapshot)).toBe(true);
    expect(commitSnapshot).toHaveBeenCalledTimes(1);
    expect(lane.status()).toMatchObject({ state: 'ready', bufferedEvents: 0, activeTimer: false });
    await expect(operation).resolves.toBe('superseded');

    request.resolve(['old compaction response']);
    await tick();
    expect(commitHistory).not.toHaveBeenCalled();
  });

  it('treats a repeated compaction as a new durable boundary and replays only post-boundary events', async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const lifecycle = new AbortController();
    const firstCommit = vi.fn();
    const secondCommit = vi.fn();
    const hydrator = new SnapshotHydrator<BrainEvent>();
    const lane = hydrator.openLane('parent', lifecycle.signal, { onOverflow: vi.fn() });
    const firstOperation = lane.hydrate(() => first.promise, { commit: firstCommit, retain: vi.fn() });
    lane.buffer({ type: 'text', delta: 'before newer compaction' });

    const secondOperation = lane.hydrate(() => second.promise, { commit: secondCommit, retain: vi.fn() });
    lane.buffer({ type: 'text', delta: 'after newer compaction' });
    await expect(firstOperation).resolves.toBe('superseded');
    second.resolve(['newest durable boundary']);
    await expect(secondOperation).resolves.toBe('committed');

    expect(firstCommit).not.toHaveBeenCalled();
    expect(secondCommit).toHaveBeenCalledWith(
      ['newest durable boundary'],
      [{ type: 'text', delta: 'after newer compaction' }],
    );
  });

  it('opening B invalidates A and stop fences both lanes while cleaning timers and listeners', async () => {
    vi.useFakeTimers();
    const parentLifecycle = new AbortController();
    const childLifecycle = new AbortController();
    const parentAdd = vi.spyOn(parentLifecycle.signal, 'addEventListener');
    const parentRemove = vi.spyOn(parentLifecycle.signal, 'removeEventListener');
    const a = deferred<string[]>();
    const b = deferred<string[]>();
    const child = deferred<string[]>();
    const commitA = vi.fn();
    const commitB = vi.fn();
    const commitChild = vi.fn();
    const hydrator = new SnapshotHydrator<BrainEvent>();
    const leaseA = hydrator.openLane('parent', parentLifecycle.signal, { onOverflow: vi.fn() });
    const opA = leaseA.hydrate(() => a.promise, { commit: commitA, retain: vi.fn() });
    const leaseB = hydrator.openLane('parent', parentLifecycle.signal, { onOverflow: vi.fn() });
    const opB = leaseB.hydrate(() => b.promise, { commit: commitB, retain: vi.fn() });
    const childLease = hydrator.openLane('child', childLifecycle.signal, { awaitingSnapshot: true, onOverflow: vi.fn() });
    const childOp = childLease.hydrate(() => child.promise, { commit: commitChild, retain: vi.fn() });

    await expect(opA).resolves.toBe('superseded');
    expect(leaseA.isCurrent()).toBe(false);
    expect(leaseB.generation).toBeGreaterThan(leaseA.generation);
    expect(vi.getTimerCount()).toBe(2);

    hydrator.stop();
    await expect(opB).resolves.toBe('cancelled');
    await expect(childOp).resolves.toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
    expect(parentAdd).toHaveBeenCalled();
    expect(parentRemove).toHaveBeenCalled();

    a.resolve(['A']);
    b.resolve(['B']);
    child.resolve(['child']);
    await tick();
    expect(commitA).not.toHaveBeenCalled();
    expect(commitB).not.toHaveBeenCalled();
    expect(commitChild).not.toHaveBeenCalled();
  });
});
