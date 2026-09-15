/**
 * One code-mode session: the cells a conversation has open, their ids, and the `store`/`load` values
 * they share.
 *
 * A cell deliberately OUTLIVES the turn that created it. `exec` can yield while the script keeps
 * running, and a later `wait` in a following turn picks it up again, so the registry is session
 * scoped and is only emptied by {@link CodeModeSession.shutdown}.
 */
import { Cell, resolveYieldTime, type CellObservation, type CellOptions } from './cell.js';
import type { CellToolBinding } from './protocolTypes.js';

/** Codex clamps every requested yield to the session limit; this is the default ceiling. */
export const DEFAULT_MAX_YIELD_TIME_MS = 600_000;
/** Per-cell heap cap. Codex has none; a worker thread lets us actually enforce one. */
export const DEFAULT_MAX_HEAP_MB = 256;
/** How many cells one session may hold open. Each is an OS thread, and a model that yields in a loop
 *  would otherwise keep spawning them. */
export const DEFAULT_MAX_OPEN_CELLS = 8;
/** How long a yielded cell may go unobserved before it is terminated. A script nobody waits on keeps
 *  running and keeps calling tools, so abandonment needs a deadline, not a hope that someone returns. */
export const DEFAULT_ABANDONED_CELL_MS = 600_000;

/** Raised when a session already holds the maximum number of open cells. Reported to the model. */
export class TooManyCellsError extends Error {}

export interface StartCellOptions {
  source: string;
  tools: CellToolBinding[];
  invokeTool: CellOptions['invokeTool'];
  notify: (text: string) => void;
}

export interface WaitOptions {
  yieldTimeMs: number;
  terminate?: boolean;
}

/** A cell the model named that this session no longer has, reported with Codex's literal wording. */
export interface MissingCell {
  kind: 'missing';
  errorText: string;
}

export type CellOutcome = CellObservation | MissingCell;

export class CodeModeSession {
  private readonly cells = new Map<string, Cell>();
  /** Codex ids are a per-session counter starting at 1, rendered as a decimal string. */
  private nextCellId = 1;
  private readonly storedValues = new Map<string, unknown>();
  private readonly maxYieldTimeMs: number;
  private readonly maxHeapMb: number;
  private readonly maxOpenCells: number;
  private readonly abandonedCellMs: number;
  /** Per-cell abandonment deadline, re-armed on every observation and cleared when the cell closes. */
  private readonly abandonTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: {
    maxYieldTimeMs?: number;
    maxHeapMb?: number;
    maxOpenCells?: number;
    abandonedCellMs?: number;
  } = {}) {
    this.maxYieldTimeMs = options.maxYieldTimeMs ?? DEFAULT_MAX_YIELD_TIME_MS;
    this.maxHeapMb = options.maxHeapMb ?? DEFAULT_MAX_HEAP_MB;
    this.maxOpenCells = options.maxOpenCells ?? DEFAULT_MAX_OPEN_CELLS;
    this.abandonedCellMs = options.abandonedCellMs ?? DEFAULT_ABANDONED_CELL_MS;
  }

  /** Terminates and forgets a cell nobody came back for. */
  private armAbandonTimer(cellId: string): void {
    this.clearAbandonTimer(cellId);
    const timer = setTimeout(() => {
      this.abandonTimers.delete(cellId);
      const cell = this.cells.get(cellId);
      if (cell === undefined) return;
      this.cells.delete(cellId);
      void cell.terminate().then(() => cell.dispose());
    }, this.abandonedCellMs);
    timer.unref();
    this.abandonTimers.set(cellId, timer);
  }

  private clearAbandonTimer(cellId: string): void {
    const timer = this.abandonTimers.get(cellId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.abandonTimers.delete(cellId);
  }

  /** How many cells this session is holding open; read by the plugin reload guard. */
  get openCellCount(): number {
    return this.cells.size;
  }

  /** Starts a cell and returns it; the caller observes it to get the first slice of output. */
  start(options: StartCellOptions): Cell {
    if (this.cells.size >= this.maxOpenCells) {
      throw new TooManyCellsError(
        `too many exec cells are already running (${this.maxOpenCells}); wait on one or terminate it first`,
      );
    }
    const cellId = String(this.nextCellId);
    this.nextCellId += 1;
    const cell = new Cell({
      cellId,
      source: options.source,
      tools: options.tools,
      // A snapshot, as in Codex: a sibling cell that commits later is not visible to this one.
      storedValues: Object.fromEntries(this.storedValues),
      maxHeapMb: this.maxHeapMb,
      invokeTool: options.invokeTool,
      notify: options.notify,
      commitStoredWrites: (writes) => {
        for (const [key, value] of Object.entries(writes)) this.storedValues.set(key, value);
      },
    });
    this.cells.set(cellId, cell);
    this.armAbandonTimer(cellId);
    return cell;
  }

  get(cellId: string): Cell | undefined {
    return this.cells.get(cellId);
  }

  get openCellIds(): string[] {
    return [...this.cells.keys()];
  }

  /** Applies the session clamp to a requested yield time, including Codex's grace period. */
  resolveYieldTime(requestedMs: number): number {
    return resolveYieldTime(requestedMs, this.maxYieldTimeMs);
  }

  /**
   * Observes a cell the model named. A cell that finishes here is removed from the registry, so a
   * second `wait` on the same id reports it as missing rather than replaying its result.
   */
  async wait(cellId: string, options: WaitOptions): Promise<CellOutcome> {
    const cell = this.cells.get(cellId);
    if (cell === undefined) return { kind: 'missing', errorText: `exec cell ${cellId} not found` };

    if (options.terminate === true) {
      await cell.terminate();
      const observation = await cell.observe(0);
      this.close(cellId);
      return observation;
    }

    const observation = await cell.observe(this.resolveYieldTime(options.yieldTimeMs));
    if (observation.kind === 'yielded') this.armAbandonTimer(cellId);
    else this.close(cellId);
    return observation;
  }

  /** Records the outcome of a cell's FIRST observation, made by `exec` itself. */
  settleInitialObservation(cellId: string, observation: CellObservation): void {
    if (observation.kind === 'yielded') this.armAbandonTimer(cellId);
    else this.close(cellId);
  }

  private close(cellId: string): void {
    this.clearAbandonTimer(cellId);
    const cell = this.cells.get(cellId);
    if (cell === undefined) return;
    this.cells.delete(cellId);
    void cell.dispose();
  }

  /** Reads a stored value; exposed for tests and for surfacing session state, not to the script. */
  loadStoredValue(key: string): unknown {
    return this.storedValues.get(key);
  }

  async shutdown(): Promise<void> {
    for (const timer of this.abandonTimers.values()) clearTimeout(timer);
    this.abandonTimers.clear();
    const cells = [...this.cells.values()];
    this.cells.clear();
    await Promise.all(cells.map((cell) => cell.dispose()));
  }
}
