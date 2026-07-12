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
  onResize?(dimensions: { columns: number; rows: number }): void;
  onFlush?(frame: { reasons: string[]; forced: boolean }): void;
}

/** The only frame scheduler and PI render sink for one chat. Components may still call requestRender;
 * this owner folds those calls into the same bounded reason queue and detects resize before preparation. */
export class RenderShell {
  private readonly scheduler: FrameScheduler;
  private readonly nativeRequestRender: TUI['requestRender'];
  private previousDimensions: { columns: number; rows: number } | null = null;
  private pendingFrame: RenderFrame | null = null;
  private activeFrame: { reasons: Set<string>; nativeForced: boolean } | null = null;
  private readonly postRenderForceReasons = new Set<string>();
  private postRenderForceScheduled = false;
  private paused = false;
  private stopped = false;

  constructor(private readonly options: RenderShellOptions) {
    this.nativeRequestRender = options.tui.requestRender.bind(options.tui);
    // The diagnostic clock and request clock share performance.now(), so totalMs starts at the first
    // dirty request rather than when the asynchronous scheduler eventually flushes it.
    // PI already owns the physical 16ms render clock. A second 16/33ms throttle here stacked both waits
    // and pushed ordinary event-to-frame latency over 50ms. This coordinator flushes dirty reasons on the
    // next timer turn; `pendingFrame` below guarantees preparation still happens only once per PI frame.
    this.scheduler = new FrameScheduler((frame) => this.flush(frame), {
      now: () => performance.now(), interactiveIntervalMs: 0, normalIntervalMs: 0,
    });
    options.tui.requestRender = (force = false): void => {
      if (this.activeFrame) {
        const reason = force ? 'pi-tui:forced-request-during-frame' : 'pi-tui:request-during-frame';
        this.activeFrame.reasons.add(reason);
        if (force && !this.activeFrame.nativeForced) this.postRenderForceReasons.add(reason);
        return;
      }
      if (force) this.scheduleForcedRender('pi-tui:forced-request');
      else this.scheduleRender('pi-tui:request', 'interactive');
    };
  }

  scheduleRender(reason = 'state', priority?: 'interactive' | 'normal'): void {
    if (this.paused || this.stopped) return;
    if (this.activeFrame) { this.activeFrame.reasons.add(reason); return; }
    if (this.pendingFrame) {
      // PI has already accepted this physical frame. Merge synchronously: a new 0ms timer can otherwise
      // land behind PI's render/diff and turn an event that was eligible for this frame into >50ms backlog.
      // requestedAt deliberately stays the earlier pending timestamp.
      this.pendingFrame.reasons.add(reason);
      const resized = this.dimensionsChanged();
      const needsNativeReset = resized && !this.pendingFrame.forced;
      if (resized) {
        this.pendingFrame.reasons.add('resize');
        this.pendingFrame.forced = true;
      }
      this.options.onFlush?.({ reasons: [...this.pendingFrame.reasons], forced: this.pendingFrame.forced });
      if (needsNativeReset) this.nativeRequestRender(true);
      return;
    }
    const chosen = priority ?? (reason.startsWith('scroll:') || reason.startsWith('input:') ? 'interactive' : 'normal');
    this.scheduler.schedule(reason, chosen);
  }

  scheduleForcedRender(reason = 'geometry'): void {
    if (this.paused || this.stopped) return;
    if (this.activeFrame) {
      this.activeFrame.reasons.add(reason);
      if (!this.activeFrame.nativeForced) this.postRenderForceReasons.add(reason);
      return;
    }
    if (this.pendingFrame) {
      const needsNativeReset = !this.pendingFrame.forced;
      this.pendingFrame.reasons.add(reason);
      this.pendingFrame.forced = true;
      this.options.onFlush?.({ reasons: [...this.pendingFrame.reasons], forced: true });
      if (needsNativeReset) this.nativeRequestRender(true);
      return;
    }
    this.scheduler.scheduleForced(reason);
  }
  allocateLayout(input: LayoutBudgetInput): LayoutBudget { return computeLayoutBudget(input); }
  composeRoot(lines: string[], columns: number, rows: number): string[] {
    return constrainFrame(lines, columns, rows);
  }
  pause(): void {
    this.paused = true;
    this.scheduler.pause();
    // TUI.stop cancels its native request. The associated frame can never be rendered; retaining it
    // would make resume merge into a phantom already-forced request and skip the mandatory repaint.
    this.pendingFrame = null;
    this.activeFrame = null;
    this.postRenderForceReasons.clear();
  }
  resume(): void { if (!this.stopped) { this.paused = false; this.scheduler.resume(); } }

  takeFrame(): RenderFrame | null {
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    this.activeFrame = null;
    this.schedulePostRenderForce();
    return frame;
  }

  /** Prepare mutable UI state at the start of PI's actual physical render, never at dirty-request time.
   * Events coalesced while PI waits for its 16ms clock are therefore visible in this same frame. */
  beginRender(): void {
    const pending = this.pendingFrame;
    if (!pending) return;
    const startedAt = performance.now();
    const dimensions = { columns: this.options.term.columns, rows: this.options.term.rows };
    const resized = !!this.previousDimensions
      && (this.previousDimensions.columns !== dimensions.columns || this.previousDimensions.rows !== dimensions.rows);
    if (resized) {
      pending.reasons.add('resize');
      if (!pending.forced) this.postRenderForceReasons.add('resize');
    }
    const active = { reasons: pending.reasons, nativeForced: pending.forced };
    this.activeFrame = active;
    this.previousDimensions = dimensions;
    try {
      if (resized) this.options.onResize?.(dimensions);
      this.options.prepare();
    } catch (error) {
      this.activeFrame = null;
      this.postRenderForceReasons.clear();
      throw error;
    } finally {
      pending.prepareMs += performance.now() - startedAt;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.paused = true;
    this.scheduler.stop();
    this.pendingFrame = null;
    this.activeFrame = null;
    this.postRenderForceReasons.clear();
    this.options.tui.requestRender = this.nativeRequestRender;
  }

  private flush(frame: { reasons: string[]; forced: boolean; requestedAt: number }): void {
    const resized = this.dimensionsChanged();
    if (resized) {
      frame.reasons = [...new Set([...frame.reasons, 'resize'])];
      frame.forced = true;
    }
    if (this.pendingFrame) {
      for (const reason of frame.reasons) this.pendingFrame.reasons.add(reason);
      this.pendingFrame.forced ||= frame.forced;
      this.pendingFrame.requestedAt = Math.min(this.pendingFrame.requestedAt, frame.requestedAt);
      this.options.onFlush?.({ reasons: [...this.pendingFrame.reasons], forced: this.pendingFrame.forced });
      // A newly forced transition must reset PI's diff state now. Ordinary dirty work is already covered
      // by the outstanding native request and needs no second sink call.
      if (frame.forced) this.nativeRequestRender(true);
      return;
    } else {
      this.pendingFrame = {
        reasons: new Set(frame.reasons), forced: frame.forced, requestedAt: frame.requestedAt, prepareMs: 0,
      };
    }
    this.options.onFlush?.(frame);
    this.nativeRequestRender(frame.forced);
  }

  private dimensionsChanged(): boolean {
    return !!this.previousDimensions
      && (this.previousDimensions.columns !== this.options.term.columns
        || this.previousDimensions.rows !== this.options.term.rows);
  }

  private schedulePostRenderForce(): void {
    if (this.postRenderForceScheduled || this.postRenderForceReasons.size === 0) return;
    this.postRenderForceScheduled = true;
    process.nextTick(() => {
      this.postRenderForceScheduled = false;
      if (this.paused || this.stopped || this.postRenderForceReasons.size === 0) {
        this.postRenderForceReasons.clear();
        return;
      }
      const reasons = [...this.postRenderForceReasons];
      this.postRenderForceReasons.clear();
      for (const reason of reasons) this.scheduleForcedRender(reason);
    });
  }
}
