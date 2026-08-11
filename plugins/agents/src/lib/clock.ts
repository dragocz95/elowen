export interface Clock {
  now(): number;
  /** Returns a cancel function. */
  setInterval(fn: () => void, ms: number): () => void;
}

export class SystemClock implements Clock {
  now() { return Date.now(); }
  setInterval(fn: () => void, ms: number) {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  }
}

export class FakeClock implements Clock {
  private t: number;
  private timers: { fn: () => void; ms: number; next: number; alive: boolean }[] = [];
  constructor(start = 0) { this.t = start; }
  now() { return this.t; }
  setInterval(fn: () => void, ms: number) {
    const timer = { fn, ms, next: this.t + ms, alive: true };
    this.timers.push(timer);
    return () => { timer.alive = false; };
  }
  advance(ms: number) {
    const target = this.t + ms;
    let guard = 0;
    while (true) {
      const due = this.timers.filter(t => t.alive && t.next <= target).sort((a, b) => a.next - b.next)[0];
      if (!due || guard++ > 100000) break;
      this.t = due.next;
      due.next += due.ms;
      due.fn();
    }
    this.t = target;
  }
}
