import {
  HYDRATION_MAX_BYTES,
  HYDRATION_MAX_EVENTS,
  SerializedEventBuffer,
} from '../../brain/session/serializedEventBuffer.js';

export type SnapshotHydrationLane = 'parent' | 'child';
type SnapshotHydrationState =
  | 'ready'
  | 'awaiting-snapshot'
  | 'hydrating'
  | 'timed-out'
  | 'overflowed'
  | 'stopped';
export type SnapshotHydrationOutcome = 'committed' | 'failed' | 'timeout' | 'overflow' | 'superseded' | 'cancelled';
export type SnapshotBufferOutcome = 'buffered' | 'passthrough' | 'overflow' | 'stale';

export class SnapshotTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`transcript history timed out after ${timeoutMs} ms`);
    this.name = 'SnapshotTimeoutError';
  }
}

export interface SnapshotHydratorClock {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface SnapshotHydratorOptions {
  timeoutMs?: number;
  maxEvents?: number;
  maxBytes?: number;
  clock?: SnapshotHydratorClock;
}

export interface SnapshotLaneOptions {
  /** Child drill-in buffers immediately while it waits for the stream's first atomic snapshot. */
  awaitingSnapshot?: boolean;
  /** Called once for a generation after the complete replay is discarded. The owner reconnects the
   * stream with snapshot=1; it must not attempt to apply a partial suffix. */
  onOverflow(): void;
}

export interface SnapshotHydrationHandlers<H, E> {
  commit(history: H, replay: readonly E[]): void;
  /** A failed/timeout history read leaves the existing transcript authoritative. Replay contains all
   * newer live events that can safely be folded onto that last valid state. */
  retain(replay: readonly E[], error: unknown): void;
}

export interface SnapshotLaneStatus {
  lane: SnapshotHydrationLane;
  generation: number;
  operationGeneration: number;
  state: SnapshotHydrationState;
  bufferedEvents: number;
  bufferedBytes: number;
  activeTimer: boolean;
}

type GateOutcome<E> = {
  kind: Exclude<SnapshotHydrationOutcome, 'committed' | 'failed'>;
  error?: unknown;
  replay?: readonly E[];
};

interface ActiveOperation<E> {
  generation: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  outcome?: GateOutcome<E>;
  resolveGate(outcome: GateOutcome<E>): void;
}

interface LaneRecord<E> {
  lane: SnapshotHydrationLane;
  generation: number;
  operationGeneration: number;
  state: SnapshotHydrationState;
  buffer: SerializedEventBuffer<E>;
  lifecycle: AbortSignal;
  lifecycleListener: () => void;
  options: SnapshotLaneOptions;
  overflowNotified: boolean;
  operation: ActiveOperation<E> | null;
}

const defaultClock: SnapshotHydratorClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Owns the two independent hydration lanes used by the interactive chat. Every asynchronous history
 * publication is fenced by both the lane generation and its operation generation. */
export class SnapshotHydrator<E> {
  private readonly records = new Map<SnapshotHydrationLane, LaneRecord<E>>();
  private readonly laneGenerations = new Map<SnapshotHydrationLane, number>();
  private readonly timeoutMs: number;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly clock: SnapshotHydratorClock;
  private stopped = false;

  constructor(options: SnapshotHydratorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxEvents = options.maxEvents ?? HYDRATION_MAX_EVENTS;
    this.maxBytes = options.maxBytes ?? HYDRATION_MAX_BYTES;
    this.clock = options.clock ?? defaultClock;
  }

  openLane(lane: SnapshotHydrationLane, lifecycle: AbortSignal, options: SnapshotLaneOptions): SnapshotLaneLease<E> {
    if (this.stopped) throw new Error('snapshot hydrator is stopped');
    const previous = this.records.get(lane);
    if (previous) this.disposeRecord(previous, 'superseded');
    const generation = (this.laneGenerations.get(lane) ?? 0) + 1;
    this.laneGenerations.set(lane, generation);
    const record: LaneRecord<E> = {
      lane,
      generation,
      operationGeneration: 0,
      state: options.awaitingSnapshot ? 'awaiting-snapshot' : 'ready',
      buffer: new SerializedEventBuffer<E>({ maxEvents: this.maxEvents, maxBytes: this.maxBytes }),
      lifecycle,
      lifecycleListener: () => this.cancelCurrent(record, 'cancelled'),
      options,
      overflowNotified: false,
      operation: null,
    };
    this.records.set(lane, record);
    lifecycle.addEventListener('abort', record.lifecycleListener, { once: true });
    if (lifecycle.aborted) this.cancelCurrent(record, 'cancelled');
    return new SnapshotLaneLease(this, record);
  }

  stopLane(lane: SnapshotHydrationLane): void {
    const record = this.records.get(lane);
    if (record) this.disposeRecord(record, 'cancelled');
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const record of [...this.records.values()]) this.disposeRecord(record, 'cancelled');
  }

  current(record: LaneRecord<E>): boolean {
    return !this.stopped && this.records.get(record.lane) === record && record.state !== 'stopped';
  }

  status(record: LaneRecord<E>): SnapshotLaneStatus {
    return {
      lane: record.lane,
      generation: record.generation,
      operationGeneration: record.operationGeneration,
      state: record.state,
      bufferedEvents: record.buffer.count,
      bufferedBytes: record.buffer.bytes,
      activeTimer: record.operation !== null && !record.operation.settled,
    };
  }

  buffer(record: LaneRecord<E>, event: E): SnapshotBufferOutcome {
    if (!this.current(record)) return 'stale';
    if (record.state === 'overflowed' || record.state === 'stopped') return 'stale';
    if (record.state !== 'hydrating' && record.state !== 'awaiting-snapshot') return 'passthrough';
    if (record.buffer.append(event) === 'accepted') return 'buffered';
    record.state = 'overflowed';
    if (record.operation) this.settleOperation(record, record.operation, { kind: 'overflow' });
    if (!record.overflowNotified) {
      record.overflowNotified = true;
      record.options.onOverflow();
    }
    return 'overflow';
  }

  applySnapshot(record: LaneRecord<E>, commit: () => void): boolean {
    if (!this.current(record)) return false;
    if (record.operation) this.settleOperation(record, record.operation, { kind: 'superseded' });
    record.buffer.clear();
    record.state = 'ready';
    commit();
    return true;
  }

  async hydrate<H>(
    record: LaneRecord<E>,
    fetchHistory: (signal: AbortSignal) => Promise<H>,
    handlers: SnapshotHydrationHandlers<H, E>,
  ): Promise<SnapshotHydrationOutcome> {
    if (!this.current(record)) return 'cancelled';
    if (record.operation) {
      // A second history operation represents a newer durable boundary (not merely another waiter for
      // the same GET). Anything buffered before that boundary may already be in the newer history and
      // must not be replayed again.
      this.settleOperation(record, record.operation, { kind: 'superseded' });
      record.buffer.clear();
    } else if (record.state !== 'awaiting-snapshot' && record.state !== 'hydrating') record.buffer.clear();
    record.state = 'hydrating';
    const operationGeneration = ++record.operationGeneration;
    const controller = new AbortController();
    let resolveGate!: (outcome: GateOutcome<E>) => void;
    const gate = new Promise<GateOutcome<E>>((resolve) => { resolveGate = resolve; });
    const operation: ActiveOperation<E> = {
      generation: operationGeneration,
      controller,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      settled: false,
      resolveGate,
    };
    operation.timer = this.clock.setTimeout(() => {
      if (!this.current(record) || record.operation !== operation) return;
      const error = new SnapshotTimeoutError(this.timeoutMs);
      const replay = record.buffer.drain();
      record.state = 'timed-out';
      this.settleOperation(record, operation, { kind: 'timeout', error, replay });
    }, this.timeoutMs);
    record.operation = operation;

    let request: Promise<H>;
    try { request = fetchHistory(controller.signal); }
    catch (error) { request = Promise.reject(error); }
    const fetchOutcome = Promise.resolve(request).then(
      (history) => ({ kind: 'history' as const, history }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    const outcome = await Promise.race([fetchOutcome, gate]);

    if (outcome.kind !== 'history' && outcome.kind !== 'error') {
      if (outcome.kind === 'timeout' && this.current(record)) {
        handlers.retain(outcome.replay ?? [], outcome.error);
      }
      return outcome.kind;
    }
    if (!this.current(record) || record.operation !== operation || operation.generation !== record.operationGeneration) {
      return operation.outcome?.kind ?? (operation.settled ? 'superseded' : 'cancelled');
    }
    this.completeOperation(record, operation);
    const replay = record.buffer.drain();
    record.state = 'ready';
    if (outcome.kind === 'history') {
      handlers.commit(outcome.history, replay);
      return 'committed';
    }
    handlers.retain(replay, outcome.error);
    return 'failed';
  }

  private cancelCurrent(record: LaneRecord<E>, reason: 'cancelled' | 'superseded'): void {
    if (this.records.get(record.lane) === record) this.disposeRecord(record, reason);
  }

  private disposeRecord(record: LaneRecord<E>, reason: 'cancelled' | 'superseded'): void {
    if (record.operation) this.settleOperation(record, record.operation, { kind: reason });
    record.lifecycle.removeEventListener('abort', record.lifecycleListener);
    record.buffer.clear();
    record.state = 'stopped';
    if (this.records.get(record.lane) === record) this.records.delete(record.lane);
  }

  private completeOperation(record: LaneRecord<E>, operation: ActiveOperation<E>): void {
    if (operation.settled) return;
    operation.settled = true;
    this.clock.clearTimeout(operation.timer);
    if (record.operation === operation) record.operation = null;
  }

  private settleOperation(record: LaneRecord<E>, operation: ActiveOperation<E>, outcome: GateOutcome<E>): void {
    if (operation.settled) return;
    operation.settled = true;
    operation.outcome = outcome;
    this.clock.clearTimeout(operation.timer);
    operation.controller.abort(outcome.error);
    if (record.operation === operation) record.operation = null;
    operation.resolveGate(outcome);
  }
}

/** A generation-capturing capability. Consumers never pass naked generation numbers back into the
 * hydrator, so an old async closure cannot accidentally address a newer lane. */
export class SnapshotLaneLease<E> {
  constructor(private readonly owner: SnapshotHydrator<E>, private readonly record: LaneRecord<E>) {}

  get generation(): number { return this.record.generation; }
  isCurrent(): boolean { return this.owner.current(this.record); }
  status(): SnapshotLaneStatus { return this.owner.status(this.record); }
  buffer(event: E): SnapshotBufferOutcome { return this.owner.buffer(this.record, event); }
  applySnapshot(commit: () => void): boolean { return this.owner.applySnapshot(this.record, commit); }
  hydrate<H>(fetchHistory: (signal: AbortSignal) => Promise<H>, handlers: SnapshotHydrationHandlers<H, E>): Promise<SnapshotHydrationOutcome> {
    return this.owner.hydrate(this.record, fetchHistory, handlers);
  }
}
