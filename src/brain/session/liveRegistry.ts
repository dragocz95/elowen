/** The mutable state of the live brain: user sessions, each user's active-conversation pointer,
 *  channel sessions (Map order doubles as LRU order) and the per-key promise locks. Generic over the
 *  live record so it stays a pure container — session composition lives with the callers.
 *
 *  Lock topology (MUST be preserved by callers): `user-<id>` is the outer send() lock guarding the
 *  vision-fallback stop/start decision; the session id is the inner lock guarding prompt()/spawn.
 *  start() locks the session id only — that key difference is what makes send() → start() re-entrant. */
export class LiveSessionRegistry<T extends { session: { dispose(): void } }> {
  private live = new Map<string, T>();
  private active = new Map<number, string>();
  private channels = new Map<string, T>();
  private locks = new Map<string, Promise<unknown>>();

  /** Serialize on `key`: chains fn behind whatever holds the lock (failures don't poison the chain). */
  withLock<K>(key: string, fn: () => Promise<K>): Promise<K> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  /** Resolves once the current holder of `key` (if any) settles — lets restart() wait for an
   *  in-flight turn without taking the lock itself. */
  settled(key: string): Promise<unknown> {
    return this.locks.get(key) ?? Promise.resolve();
  }

  // ── user sessions ─────────────────────────────────────────────────────────
  get(id: string): T | undefined { return this.live.get(id); }
  has(id: string): boolean { return this.live.has(id); }
  set(id: string, b: T): void { this.live.set(id, b); }
  /** Dispose the PI session and forget the record (no-op when absent). */
  dispose(id: string): void {
    const b = this.live.get(id);
    if (!b) return;
    b.session.dispose();
    this.live.delete(id);
  }
  liveEntries(): [string, T][] { return [...this.live]; }

  // ── active-conversation pointers ──────────────────────────────────────────
  activeIdFor(userId: number): string | undefined { return this.active.get(userId); }
  setActive(userId: number, id: string): void { this.active.set(userId, id); }
  clearActive(userId: number): void { this.active.delete(userId); }
  activeUserIds(): number[] { return [...this.active.keys()]; }
  activeIds(): string[] { return [...this.active.values()]; }

  // ── channel sessions (Map order = LRU order) ─────────────────────────────
  channelGet(channelId: string): T | undefined { return this.channels.get(channelId); }
  /** Dispose + forget one channel session (no-op when absent). */
  channelDispose(channelId: string): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    ch.session.dispose();
    this.channels.delete(channelId);
  }
  /** Insert (or LRU re-insert: delete first, so Map order stays most-recently-used-last). */
  channelTouch(channelId: string, ch: T): void {
    this.channels.delete(channelId);
    this.channels.set(channelId, ch);
  }
  /** When at capacity, dispose the least-recently-used channel to make room for a new one. */
  channelEvictOldestIfFull(max: number): void {
    if (this.channels.size < max) return;
    const oldest = this.channels.entries().next().value;
    if (oldest) { oldest[1].session.dispose(); this.channels.delete(oldest[0]); }
  }
  channelDisposeAll(): void {
    for (const [id] of [...this.channels]) this.channelDispose(id);
  }
}
