export type FramePriority = 'interactive' | 'normal';

export interface ScheduledFrame {
  reasons: string[];
  forced: boolean;
  /** Earliest dirty request folded into this frame. */
  requestedAt: number;
}

export interface FrameSchedulerOptions {
  interactiveIntervalMs?: number;
  normalIntervalMs?: number;
  now?: () => number;
}

/** One-shot render coordinator. It owns no idle loop: a timer exists only while dirty work is waiting,
 * and every event that lands before the deadline is folded into the same reason set/frame. */
export class FrameScheduler {
  private readonly reasons = new Set<string>();
  private readonly now: () => number;
  private readonly intervals: Record<FramePriority, number>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = Number.POSITIVE_INFINITY;
  private priority: FramePriority = 'normal';
  private forced = false;
  private requestedAt: number | null = null;
  private paused = false;
  private stopped = false;
  private lastFrameAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly render: (frame: ScheduledFrame) => void,
    options: FrameSchedulerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.intervals = {
      interactive: options.interactiveIntervalMs ?? 16,
      normal: options.normalIntervalMs ?? 33,
    };
  }

  schedule(reason: string, priority: FramePriority = 'normal'): void {
    if (this.paused || this.stopped) return;
    if (this.reasons.size === 0) this.requestedAt = this.now();
    this.reasons.add(reason);
    if (this.rank(priority) > this.rank(this.priority)) this.priority = priority;
    this.arm(false);
  }

  scheduleForced(reason: string): void {
    if (this.paused || this.stopped) return;
    if (this.reasons.size === 0) this.requestedAt = this.now();
    this.reasons.add(reason);
    this.forced = true;
    this.priority = 'interactive';
    this.arm(true);
  }

  pause(): void {
    if (this.stopped) return;
    this.paused = true;
    this.cancelPending();
  }

  resume(): void {
    if (!this.stopped) this.paused = false;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.paused = true;
    this.cancelPending();
  }

  private arm(immediate: boolean): void {
    const interval = this.intervals[this.priority];
    const delay = immediate ? 0 : Math.max(0, interval - (this.now() - this.lastFrameAt));
    const dueAt = this.now() + delay;
    if (this.timer) {
      if (dueAt >= this.timerDueAt) return;
      clearTimeout(this.timer);
    }
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => this.flush(), delay);
  }

  private flush(): void {
    this.timer = null;
    this.timerDueAt = Number.POSITIVE_INFINITY;
    if (this.paused || this.stopped || this.reasons.size === 0) return;
    const frame = {
      reasons: [...this.reasons],
      forced: this.forced,
      requestedAt: this.requestedAt ?? this.now(),
    };
    this.reasons.clear();
    this.forced = false;
    this.requestedAt = null;
    this.priority = 'normal';
    this.lastFrameAt = this.now();
    this.render(frame);
  }

  private cancelPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerDueAt = Number.POSITIVE_INFINITY;
    this.reasons.clear();
    this.forced = false;
    this.requestedAt = null;
    this.priority = 'normal';
  }

  private rank(priority: FramePriority): number {
    return priority === 'interactive' ? 2 : 1;
  }
}
