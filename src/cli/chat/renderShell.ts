import type { TUI } from '@earendil-works/pi-tui';
import { FrameScheduler } from './frameScheduler.js';
import { computeLayoutBudget, constrainFrame } from './layoutBudget.js';
import type { LayoutBudget, LayoutBudgetInput } from './layoutBudget.js';

export interface RenderFrame {
  reasons: Set<string>;
  forced: boolean;
  requestedAt: number;
  prepareMs: number;
}

export interface RenderShellOptions {
  tui: TUI;
  term: { columns: number; rows: number };
  prepare(): void;
  onFlush?(frame: { reasons: string[]; forced: boolean }): void;
}

/** The only frame scheduler and PI render sink for one chat. Components may still call requestRender;
 * this owner folds those calls into the same bounded reason queue and detects resize before preparation. */
export class RenderShell {
  private readonly scheduler: FrameScheduler;
  private readonly nativeRequestRender: TUI['requestRender'];
  private previousDimensions: { columns: number; rows: number } | null = null;
  private pendingFrame: RenderFrame | null = null;
  private stopped = false;

  constructor(private readonly options: RenderShellOptions) {
    this.nativeRequestRender = options.tui.requestRender.bind(options.tui);
    this.scheduler = new FrameScheduler((frame) => this.flush(frame));
    options.tui.requestRender = (force = false): void => {
      if (force) this.scheduleForcedRender('pi-tui:forced-request');
      else this.scheduleRender('pi-tui:request', 'interactive');
    };
  }

  scheduleRender(reason = 'state', priority?: 'interactive' | 'normal'): void {
    const chosen = priority ?? (reason.startsWith('scroll:') || reason.startsWith('input:') ? 'interactive' : 'normal');
    this.scheduler.schedule(reason, chosen);
  }

  scheduleForcedRender(reason = 'geometry'): void { this.scheduler.scheduleForced(reason); }
  allocateLayout(input: LayoutBudgetInput): LayoutBudget { return computeLayoutBudget(input); }
  composeRoot(lines: string[], columns: number, rows: number): string[] {
    return constrainFrame(lines, columns, rows);
  }
  pause(): void { this.scheduler.pause(); }
  resume(): void { this.scheduler.resume(); }

  takeFrame(): RenderFrame | null {
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    return frame;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.scheduler.stop();
    this.options.tui.requestRender = this.nativeRequestRender;
  }

  private flush(frame: { reasons: string[]; forced: boolean }): void {
    const startedAt = performance.now();
    const dimensions = { columns: this.options.term.columns, rows: this.options.term.rows };
    if (this.previousDimensions
      && (this.previousDimensions.columns !== dimensions.columns || this.previousDimensions.rows !== dimensions.rows)) {
      frame.forced = true;
      if (!frame.reasons.includes('resize')) frame.reasons.push('resize');
    }
    this.previousDimensions = dimensions;
    this.options.prepare();
    const prepareMs = performance.now() - startedAt;
    if (this.pendingFrame) {
      for (const reason of frame.reasons) this.pendingFrame.reasons.add(reason);
      this.pendingFrame.forced ||= frame.forced;
      this.pendingFrame.prepareMs += prepareMs;
    } else {
      this.pendingFrame = {
        reasons: new Set(frame.reasons), forced: frame.forced, requestedAt: startedAt, prepareMs,
      };
    }
    this.options.onFlush?.(frame);
    this.nativeRequestRender(frame.forced);
  }
}
