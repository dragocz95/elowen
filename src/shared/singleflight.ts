/** Per-key in-flight coalescing: while a call for `key` is running, every further call for that same key
 *  joins the running one instead of starting a second. The sibling of {@link KeyedMutex} — that one
 *  SERIALIZES callers that each need their own turn, this one COALESCES callers that all want the same
 *  single result. Reach for the mutex when running twice would be wrong but each caller needs its own
 *  effect; reach for this when running twice would be wasteful or racy and one result serves everybody.
 *
 *  Not a cache: the entry is dropped the moment the call settles, so the next caller starts fresh work.
 *  A caller that wants a TTL layers its own cache in front (see UsageService). */
export class Singleflight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  /** Run `fn` for `key`, or return the promise of the run already in progress. Rejections are shared by
   *  every joined caller, exactly as if each had called `fn` itself. */
  run(key: string, fn: () => Promise<T>): Promise<T> {
    const active = this.inFlight.get(key);
    if (active) return active;
    // Only this run may evict its own entry: a settle that lands after a later run registered must not
    // delete the newer promise and let a third caller start redundant work.
    const started = fn().finally(() => {
      if (this.inFlight.get(key) === started) this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }

  /** Whether a run for `key` is in progress. For observers that must not act on a resource while it is
   *  mid-flight — BrainTerminalService's janitor skips any terminal between its binding upsert and its
   *  spawn, which would otherwise look exactly like a dead one. */
  isRunning(key: string): boolean {
    return this.inFlight.has(key);
  }
}
