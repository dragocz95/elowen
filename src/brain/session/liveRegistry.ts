/** The mutable state of the live brain: user sessions, each user's active-conversation pointer,
 *  channel sessions (Map order doubles as LRU order) and the per-key promise locks. Generic over the
 *  live record so it stays a pure container — session composition lives with the callers.
 *
 *  Lock topology (MUST be preserved by callers): `send-<sessionId>` is the outer send() lock guarding
 *  that ONE conversation's idle-rollover / vision-hop dispose-and-respawn decision (turns on different
 *  conversations run concurrently); the bare session id is the inner lock guarding prompt()/spawn.
 *  start()/ensureLive lock the bare session id only — that key difference is what makes
 *  send() → ensureLive() re-entrant. */
export class LiveSessionRegistry<T extends { sessionId: string; session: { dispose(): void; isStreaming: boolean } }> {
  private live = new Map<string, T>();
  private active = new Map<number, string>();
  private channels = new Map<string, T>();
  private locks = new Map<string, Promise<unknown>>();
  /** Running delegated children are conversation state, not PI-session state: a model switch, restart,
   *  or vision hop replaces the LiveBrain object in place while the child keeps running. Keep the tree
   *  here so every replacement sees the same abort/status/rollover guard. */
  private children = new Map<string, Set<string>>();
  /** A child can be tracked before its channel spawn finishes. `/stop` records that narrow race here;
   *  ChannelSessionService consumes the marker before prompting (or immediately after an awaited spawn). */
  private pendingAborts = new Set<string>();
  /** Parent aborts fence new delegated sends before the abort snapshots its child set. A counter keeps a
   * concurrent/nested abort from reopening the parent between another abort's snapshot and cleanup. */
  private abortingParents = new Map<string, number>();

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

  // ── delegated-child lifecycle ─────────────────────────────────────────────
  setChildRunning(parentSessionId: string, childSessionId: string, running: boolean): void {
    if (running) {
      let set = this.children.get(parentSessionId);
      if (!set) { set = new Set(); this.children.set(parentSessionId, set); }
      set.add(childSessionId);
      return;
    }
    const set = this.children.get(parentSessionId);
    set?.delete(childSessionId);
    if (set?.size === 0) this.children.delete(parentSessionId);
  }
  childrenOf(parentSessionId: string): string[] { return [...(this.children.get(parentSessionId) ?? [])]; }
  hasActiveChildren(parentSessionId: string): boolean { return (this.children.get(parentSessionId)?.size ?? 0) > 0; }
  clearChildren(parentSessionId: string): void { this.children.delete(parentSessionId); }
  beginParentAbort(parentSessionId: string): void {
    this.abortingParents.set(parentSessionId, (this.abortingParents.get(parentSessionId) ?? 0) + 1);
  }
  endParentAbort(parentSessionId: string): void {
    const count = this.abortingParents.get(parentSessionId) ?? 0;
    if (count <= 1) this.abortingParents.delete(parentSessionId);
    else this.abortingParents.set(parentSessionId, count - 1);
  }
  isParentAborting(parentSessionId: string): boolean { return (this.abortingParents.get(parentSessionId) ?? 0) > 0; }
  isActiveChild(sessionId: string): boolean {
    for (const children of this.children.values()) if (children.has(sessionId)) return true;
    return false;
  }
  requestPendingAbort(sessionId: string): void { this.pendingAborts.add(sessionId); }
  /** Observe a pending child abort without consuming it. Fast owner-steering needs this so the original
   * prompt completion can still consume the marker and settle as aborted. */
  hasPendingAbort(sessionId: string): boolean { return this.pendingAborts.has(sessionId); }
  consumePendingAbort(sessionId: string): boolean { return this.pendingAborts.delete(sessionId); }

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
  /** Dispose idle least-recently-used channels until there is room for one more. Streaming sessions and
   *  parents with running delegated children are in use and must never be evicted. If every candidate is
   *  busy the cap is temporarily soft; a later spawn shrinks the pool once an idle candidate exists.
   *  The loop also lets lowering the cap converge on the next message. */
  channelEvictOldestIfFull(max: number): void {
    while (this.channels.size >= max) {
      const oldestIdle = [...this.channels].find(([, ch]) =>
        !ch.session.isStreaming && !this.hasActiveChildren(ch.sessionId));
      if (!oldestIdle) break;
      oldestIdle[1].session.dispose();
      this.channels.delete(oldestIdle[0]);
    }
  }
  channelDisposeAll(): void {
    for (const [id] of [...this.channels]) this.channelDispose(id);
  }
}
