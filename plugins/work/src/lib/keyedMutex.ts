/** A per-key async mutex: calls sharing a key run strictly one-at-a-time (FIFO), while different keys
 *  run concurrently. Used to serialize git operations on one checkout — the baseline read at spawn and
 *  the commit+snapshot at close must not interleave across agents sharing a working tree, or a task's
 *  frozen change range could straddle another's commit. Keys with no pending work are dropped so the
 *  map can't grow without bound. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  /** Run `fn` exclusively for `key`. Resolves/rejects with `fn`'s own result; a throwing `fn` never
   *  wedges the chain — the next waiter still runs. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(() => fn());
    // The tail swallows fn's outcome so the chain never breaks; the next run() for this key waits on it.
    const tail = result.then(() => {}, () => {});
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return result;
  }
}
