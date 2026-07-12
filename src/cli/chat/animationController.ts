import { MascotFloat } from './mascotFloat.js';

export interface AnimationControllerOptions {
  render(reason: string): void;
  canAnimateMascot(): boolean;
  thinkingIntervalMs?: number;
  mascotIntervalMs?: number;
}

/** Sole owner of decorative/ephemeral UI timers. Every timer is one-shot or re-arms only while visible
 * motion is unsettled; `stop()` leaves an idle/closed chat with no timer handles. */
export class AnimationController {
  private readonly mascot = new MascotFloat();
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private mascotTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly visualTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly options: AnimationControllerOptions) {}

  get timerCount(): number {
    return Number(this.thinkingTimer != null) + Number(this.mascotTimer != null) + this.visualTimers.size;
  }

  get mascotOffset(): number { return this.mascot.value(); }

  updateThinking(active: boolean): void {
    if (this.stopped || !active) {
      if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
      this.thinkingTimer = null;
      return;
    }
    if (this.thinkingTimer) return;
    this.thinkingTimer = setTimeout(() => {
      this.thinkingTimer = null;
      if (!this.stopped) this.options.render('animation:thinking');
    }, this.options.thinkingIntervalMs ?? 250);
  }

  nudgeMascot(direction: number): void {
    if (this.stopped || !this.options.canAnimateMascot()) {
      this.cancelMascot();
      return;
    }
    this.mascot.impulse(direction);
    this.armMascot();
  }

  cancelMascot(): void {
    if (this.mascotTimer) clearTimeout(this.mascotTimer);
    this.mascotTimer = null;
    this.mascot.reset();
  }

  scheduleVisual(name: string, delayMs: number, callback: () => void): void {
    this.cancelVisual(name);
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.visualTimers.delete(name);
      if (!this.stopped) callback();
    }, Math.max(0, delayMs));
    this.visualTimers.set(name, timer);
  }

  cancelVisual(name: string): void {
    const timer = this.visualTimers.get(name);
    if (timer) clearTimeout(timer);
    this.visualTimers.delete(name);
  }

  pause(): void {
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = null;
    this.cancelMascot();
    for (const timer of this.visualTimers.values()) clearTimeout(timer);
    this.visualTimers.clear();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pause();
  }

  private armMascot(): void {
    if (this.mascotTimer) clearTimeout(this.mascotTimer);
    const interval = this.options.mascotIntervalMs ?? 100;
    this.mascotTimer = setTimeout(() => {
      this.mascotTimer = null;
      if (this.stopped || !this.options.canAnimateMascot()) { this.cancelMascot(); return; }
      this.mascot.tick(interval);
      this.options.render('animation:mascot');
      if (!this.mascot.settled()) this.armMascot();
    }, interval);
  }
}
