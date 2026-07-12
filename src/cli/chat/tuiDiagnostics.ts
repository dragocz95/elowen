import { createWriteStream, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WriteStream } from 'node:fs';

interface TuiFrameDiagnostic {
  type: 'frame';
  /** Monotonic physical-frame completion sequence within this mounted chat composition. */
  sequence: number;
  reasons: string[];
  forced: boolean;
  prepareMs: number;
  /** Dirty request to physical-root preparation, excluding preparation itself. */
  queueMs: number;
  /** Complete constrained root composition and opt-in diagnostic traversal. */
  rootRenderMs: number;
  /** Synchronous PI work after the root returns: overlays, diff, terminal write and cursor placement. */
  piTailMs: number;
  transcriptMs: number;
  totalMs: number;
  transcriptRows: number;
  transcriptRowsExact?: boolean;
  visibleRows: number;
  renderedTurns: number;
  reconciledTurns: number;
  indexedTurns: number;
  cachedRows: number;
  layoutVisits: number;
  scrollOffset: number;
  maxScrollOffset: number;
  /** Height-index work charged to this frame, not the viewport's lifetime counter. */
  heightIndexOperations: number;
  terminal: { columns: number; rows: number };
  sections: Record<string, number>;
  rootRows: number;
  maxVisibleWidth: number;
  /** ANSI reverse-video spans by row/column, without transcript text. Useful for distinguishing a real
   * component cursor/selection from a stale terminal cell while keeping diagnostics content-free. */
  reverseSpans?: { stage: 'raw' | 'constrained'; row: number; from: number; to: number }[];
}

type TuiDiagnosticEvent = TuiFrameDiagnostic | {
  type: 'lifecycle';
  action: string;
  detail?: string;
} | {
  type: 'scheduler';
  action: string;
  reasons?: string[];
  forced?: boolean;
};

export interface TuiDiagnostics {
  readonly enabled: boolean;
  readonly path: string | null;
  record(event: TuiDiagnosticEvent): void;
  close(): Promise<void>;
}

interface TuiDiagnosticsDeps {
  now?: () => number;
  pid?: number;
}

class DisabledTuiDiagnostics implements TuiDiagnostics {
  readonly enabled = false;
  readonly path = null;
  record(_event: TuiDiagnosticEvent): void { /* diagnostics disabled */ }
  async close(): Promise<void> { /* no resources */ }
}

class FileTuiDiagnostics implements TuiDiagnostics {
  private readonly stream: WriteStream;
  private readonly now: () => number;
  private readonly pid: number;
  private frameBucketStartedAt: number | null = null;
  private framesInBucket = 0;
  private closed = false;
  private failed = false;

  get enabled(): boolean { return !this.failed; }

  constructor(readonly path: string, deps: TuiDiagnosticsDeps) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: 'a', encoding: 'utf8' });
    // WriteStream reports open/write failures asynchronously. A missing listener becomes an uncaught
    // exception that can strand the TUI in raw/alternate-screen mode, so diagnostics always fail closed.
    this.stream.on('error', () => { this.failed = true; });
    this.now = deps.now ?? Date.now;
    this.pid = deps.pid ?? process.pid;
  }

  record(event: TuiDiagnosticEvent): void {
    if (this.closed || this.failed) return;
    const at = this.now();
    if (event.type === 'frame') this.recordFrameRate(at);
    this.write({ at, pid: this.pid, ...event });
  }

  private recordFrameRate(at: number): void {
    if (this.frameBucketStartedAt == null) {
      this.frameBucketStartedAt = at;
      this.framesInBucket = 1;
      return;
    }
    const elapsedMs = at - this.frameBucketStartedAt;
    if (elapsedMs >= 1_000) {
      this.write({
        at,
        pid: this.pid,
        type: 'summary',
        windowMs: elapsedMs,
        renders: this.framesInBucket,
        rendersPerSecond: elapsedMs > 0 ? (this.framesInBucket * 1_000) / elapsedMs : 0,
      });
      this.frameBucketStartedAt = at;
      this.framesInBucket = 1;
      return;
    }
    this.framesInBucket++;
  }

  private write(value: Record<string, unknown>): void {
    if (this.closed || this.failed) return;
    try {
      this.stream.write(`${JSON.stringify(value)}\n`);
    } catch {
      this.failed = true;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.failed || this.stream.destroyed) {
      this.stream.destroy();
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.stream.off('close', finish);
        this.stream.off('error', finish);
        resolve();
      };
      this.stream.once('close', finish);
      this.stream.once('error', finish);
      try { this.stream.end(finish); } catch { finish(); }
    });
  }
}

/** Opt-in TUI diagnostics. The sink is always a file and never stdout/stderr, because terminal output
 * while pi-tui owns the alternate screen corrupts its differential-render model. */
export function createTuiDiagnostics(
  env: NodeJS.ProcessEnv = process.env,
  deps: TuiDiagnosticsDeps = {},
): TuiDiagnostics {
  if (env.ELOWEN_TUI_DEBUG !== '1' && env.ELOWEN_TUI_PERF !== '1') return new DisabledTuiDiagnostics();
  const pid = deps.pid ?? process.pid;
  const path = env.ELOWEN_TUI_LOG?.trim() || join(tmpdir(), `elowen-tui-${pid}.jsonl`);
  try {
    return new FileTuiDiagnostics(path, { ...deps, pid });
  } catch {
    // An invalid opt-in log path must never prevent chat startup or write the failure into the TUI.
    return new DisabledTuiDiagnostics();
  }
}
