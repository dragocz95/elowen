/**
 * Host side of one code-mode cell: owns the worker thread, accumulates its output and serves the
 * yield/wait/terminate protocol.
 *
 * Two behaviours are copied from Codex on purpose:
 *  - output is accumulated HERE, not in the worker, so a terminated cell still reports what it
 *    produced before it was killed;
 *  - a yielded cell keeps running in the background and keeps dispatching tool calls, so `exec` can
 *    return to the model while work continues.
 *
 * One behaviour is deliberately stronger than Codex: `resourceLimits` gives each cell a real heap
 * cap. Codex accepts `max_heap_size_bytes` in its protocol and then drops it.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { CodeModeOutputItem } from '../protocol/output.js';
import type { CellToolBinding, HostToWorkerMessage, WorkerToHostMessage } from './protocolTypes.js';

/** Codex `YIELD_GRACE_PERIOD` and `MIN_YIELD_TIME_FOR_GRACE`. */
const YIELD_GRACE_PERIOD_MS = 1_000;
const MIN_YIELD_TIME_FOR_GRACE_MS = 10_000;

export interface CellObservation {
  kind: 'yielded' | 'completed' | 'terminated';
  items: CodeModeOutputItem[];
  errorText?: string;
}

export interface CellOptions {
  cellId: string;
  source: string;
  tools: CellToolBinding[];
  storedValues: Record<string, unknown>;
  maxHeapMb: number;
  /** Dispatches a nested tool call. Rejecting with any value surfaces its message to the script.
   *  The signal aborts when the cell is terminated or disposed: killing the worker stops the script,
   *  but a nested Bash or MCP call already in flight would otherwise run to completion unattended. */
  invokeTool: (call: {
    name: string;
    kind: 'function' | 'freeform';
    input: unknown;
    signal: AbortSignal;
  }) => Promise<unknown>;
  /** Injects an extra tool output for the running exec call. */
  notify: (text: string) => void;
  /** Commits `store` writes into the session once the cell completes. */
  commitStoredWrites: (writes: Record<string, unknown>) => void;
}

/** Applies Codex's grace period, then the session clamp, to a requested yield time. */
export function resolveYieldTime(requestedMs: number, maxYieldTimeMs: number): number {
  const withGrace = requestedMs >= MIN_YIELD_TIME_FOR_GRACE_MS ? requestedMs + YIELD_GRACE_PERIOD_MS : requestedMs;
  return Math.min(withGrace, maxYieldTimeMs);
}

type Settlement = { kind: 'completed' | 'terminated'; errorText?: string };

export class Cell {
  readonly cellId: string;

  private readonly worker: Worker;
  private readonly options: CellOptions;
  private items: CodeModeOutputItem[] = [];
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private settlement: Settlement | undefined;
  /** Set once a settlement has been handed to an observer, so the cell is not reported twice. */
  private settlementDelivered = false;
  private observer:
    | { resolve: (observation: CellObservation) => void; timer: NodeJS.Timeout | undefined; yieldTimeMs: number }
    | undefined;
  /** Worker startup must not be charged to the caller's yield budget. An observer that registers
   *  before the worker is up waits without a timer until `started` arrives, which is the same point
   *  at which Codex arms its own timer on `RuntimeEvent::Started`. Without this, a short yield time
   *  expires during thread startup and the model is told the script yielded before it even ran. */
  private started = false;
  private terminating = false;
  private closed = false;
  /** Aborted on terminate and on dispose, so nested calls die with the script that issued them. */
  private readonly abort = new AbortController();

  constructor(options: CellOptions) {
    this.options = options;
    this.cellId = options.cellId;
    // Plain ESM on purpose: the same relative path resolves from the TypeScript source during tests
    // and from the copied plugin tree in dist/, with no compile step in between.
    this.worker = new Worker(fileURLToPath(new URL('./worker.mjs', import.meta.url)), {
      workerData: {
        source: options.source,
        tools: options.tools,
        storedValues: options.storedValues,
      },
      resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb },
      // The script has no console, so anything on these streams is harness noise, not model output.
      stdout: true,
      stderr: true,
    });
    // A yielded cell runs in the background by design; it must not be the reason the daemon cannot exit.
    this.worker.unref();

    this.worker.on('message', (message: WorkerToHostMessage) => {
      this.onWorkerMessage(message);
    });
    this.worker.on('error', (error: Error) => {
      this.settle({ kind: 'completed', errorText: error.stack ?? error.message });
    });
    this.worker.on('exit', () => {
      // A worker that exits without a result was terminated or died; do not leave an observer hanging.
      if (this.settlement === undefined) {
        this.settle({ kind: this.terminating ? 'terminated' : 'completed', errorText: this.terminating ? undefined : 'exec runtime ended unexpectedly' });
      }
    });
  }

  private onWorkerMessage(message: WorkerToHostMessage): void {
    switch (message.type) {
      case 'started':
        this.started = true;
        this.rearmObserverTimer();
        return;
      case 'item':
        this.items.push(message.item);
        return;
      case 'notify':
        this.options.notify(message.text);
        return;
      case 'yieldRequested':
        this.flushYield();
        return;
      case 'toolCall':
        void this.dispatchTool(message);
        return;
      case 'timer':
        this.scheduleTimer(message.id, message.delayMs);
        return;
      case 'timerCleared':
        this.clearTimer(message.id);
        return;
      case 'result':
        this.onResult(message);
        return;
    }
  }

  private onResult(message: Extract<WorkerToHostMessage, { type: 'result' }>): void {
    // A terminated cell loses its store writes, matching Codex's commit-on-completion rule.
    if (!this.terminating) {
      try {
        const writes = JSON.parse(message.storedWritesJson) as Record<string, unknown>;
        if (Object.keys(writes).length > 0) this.options.commitStoredWrites(writes);
      } catch {
        // A malformed payload cannot be produced by the bootstrap; ignoring it would hide a real
        // fault, so surface it as the cell's error instead of silently dropping the writes.
        this.settle({ kind: 'completed', errorText: 'exec runtime returned malformed stored values' });
        return;
      }
    }
    this.settle({ kind: this.terminating ? 'terminated' : 'completed', errorText: message.errorText });
  }

  private async dispatchTool(message: Extract<WorkerToHostMessage, { type: 'toolCall' }>): Promise<void> {
    let reply: HostToWorkerMessage;
    try {
      const input = message.inputJson === undefined ? undefined : (JSON.parse(message.inputJson) as unknown);
      const result = await this.options.invokeTool({
        name: message.name,
        kind: message.kind,
        input,
        signal: this.abort.signal,
      });
      reply = { type: 'toolResult', id: message.id, ok: true, resultJson: result === undefined ? undefined : JSON.stringify(result) };
    } catch (error) {
      reply = {
        type: 'toolResult',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (this.closed || this.settlement !== undefined) return;
    this.worker.postMessage(reply);
  }

  private scheduleTimer(id: number, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (this.closed || this.settlement !== undefined) return;
      this.worker.postMessage({ type: 'timerFired', id } satisfies HostToWorkerMessage);
    }, delayMs);
    // A pending timer must not hold the daemon's event loop open.
    timer.unref();
    this.timers.set(id, timer);
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(id);
  }

  private rearmObserverTimer(): void {
    const observer = this.observer;
    if (observer === undefined) return;
    if (observer.timer !== undefined) clearTimeout(observer.timer);
    observer.timer = this.armYieldTimer(observer.yieldTimeMs);
  }

  private armYieldTimer(yieldTimeMs: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const observer = this.observer;
      if (observer === undefined) return;
      this.observer = undefined;
      observer.resolve({ kind: 'yielded', items: this.takeItems() });
    }, yieldTimeMs);
    // A yielded cell runs on in the background; its timer must not hold the event loop open.
    timer.unref();
    return timer;
  }

  private takeItems(): CodeModeOutputItem[] {
    const items = this.items;
    this.items = [];
    return items;
  }

  private flushYield(): void {
    const observer = this.observer;
    if (observer === undefined) return;
    this.observer = undefined;
    clearTimeout(observer.timer);
    observer.resolve({ kind: 'yielded', items: this.takeItems() });
  }

  private settle(settlement: Settlement): void {
    if (this.settlement !== undefined) return;
    this.settlement = settlement;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();

    const observer = this.observer;
    if (observer === undefined) return;
    this.observer = undefined;
    clearTimeout(observer.timer);
    this.settlementDelivered = true;
    observer.resolve({ kind: settlement.kind, items: this.takeItems(), errorText: settlement.errorText });
  }

  /**
   * Waits for the cell to settle or for `yieldTimeMs` to elapse, whichever comes first. A settled
   * cell answers immediately, which is how `wait` on an already finished cell behaves.
   */
  observe(yieldTimeMs: number): Promise<CellObservation> {
    if (this.settlement !== undefined && !this.settlementDelivered) {
      this.settlementDelivered = true;
      return Promise.resolve({
        kind: this.settlement.kind,
        items: this.takeItems(),
        errorText: this.settlement.errorText,
      });
    }
    if (this.settlement !== undefined) {
      return Promise.resolve({ kind: this.settlement.kind, items: this.takeItems(), errorText: undefined });
    }
    if (this.observer !== undefined) {
      return Promise.reject(new Error(`exec cell ${this.cellId} already has an active observer`));
    }

    return new Promise<CellObservation>((resolve) => {
      this.observer = {
        resolve,
        timer: this.started ? this.armYieldTimer(yieldTimeMs) : undefined,
        yieldTimeMs,
      };
    });
  }

  /** Whether the cell has finished and its result has already been handed to an observer. */
  get isClosed(): boolean {
    return this.closed || (this.settlement !== undefined && this.settlementDelivered);
  }

  async terminate(): Promise<void> {
    this.terminating = true;
    this.abort.abort();
    await this.worker.terminate();
    this.settle({ kind: 'terminated' });
  }

  /** Releases the worker and any pending timers; safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.worker.terminate();
  }
}
