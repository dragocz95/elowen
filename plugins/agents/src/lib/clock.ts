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
