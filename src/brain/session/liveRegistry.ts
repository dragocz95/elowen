/** The mutable state of the live brain: user sessions, each user's active-conversation pointer,
 *  channel sessions (Map order doubles as LRU order) and the per-key promise locks. Generic over the
 *  live record so it stays a pure container — session composition lives with the callers.
 *
 *  Lock topology (MUST be preserved by callers): `send-<sessionId>` is the outer send() lock guarding
 *  that ONE conversation's idle-rollover / vision-hop dispose-and-respawn decision (turns on different
 *  conversations run concurrently); the bare session id is the inner lock guarding prompt()/spawn.
 *  start()/ensureLive lock the bare session id only — that key difference is what makes
 *  send() → ensureLive() re-entrant. */

/** The outer send-lock prefix. Written here rather than at the call sites so `busy()` can map the pair of
 *  locks a turn holds back onto the single conversation they belong to. */
const SEND_LOCK_PREFIX = 'send-';
export const sendLockKey = (sessionId: string): string => `${SEND_LOCK_PREFIX}${sessionId}`;
const lockedConversation = (key: string): string =>
  key.startsWith(SEND_LOCK_PREFIX) ? key.slice(SEND_LOCK_PREFIX.length) : key;

/** Which writer holds a liveness claim on a delegated child. The two writers are independent and must
 *  not share one boolean: `call` is the delegated-call lifecycle (begin/endDelegatedCall around the
 *  child's actual run, plus the runner's mirrored edges), `progress` is the delegate plugin's live
 *  progress row (a `running` update raises it, a terminal one settles it). A DelegateContinue that
 *  STEERED into a running child settles its OWN progress row while the original call is still running —
 *  with a plain Set that terminal update erased the call's claim, orphaning a live child from
 *  DelegateStop, the parent's abort tree and the shutdown gate. */
export type ChildClaimSource = 'call' | 'progress';

export class LiveSessionRegistry<T extends { sessionId: string; session: { dispose(): void; isStreaming: boolean }; pendingReasoningMarker?: { timer: ReturnType<typeof setTimeout> } }> {
  private live = new Map<string, T>();
  private active = new Map<number, string>();
  private channels = new Map<string, T>();
  private locks = new Map<string, Promise<unknown>>();
  /** Running delegated children are conversation state, not PI-session state: a model switch, restart,
   *  or vision hop replaces the LiveBrain object in place while the child keeps running. Keep the tree
   *  here so every replacement sees the same abort/status/rollover guard. Each child maps to the SET of
   *  sources currently claiming it (see ChildClaimSource): the child stays alive while any claim
   *  remains, and a source can only ever release its own — a Set per source keeps same-source
   *  re-registration idempotent (the runner mirrors begin edges per call, not per 0↔1 transition). */
  private children = new Map<string, Map<string, Set<ChildClaimSource>>>();
  /** Event-driven waiters used by a delegated parent that returned from its model turn while its OWN
   *  background children are still running. The outer Delegate lifecycle stays open until these claims
   *  settle instead of treating the parent's provisional "children started" reply as its final result. */
  private childIdleWaiters = new Map<string, Set<() => void>>();
  /** A child can be tracked before its channel spawn finishes. `/stop` records that narrow race here;
   *  ChannelSessionService consumes the marker before prompting (or immediately after an awaited spawn). */
  private pendingAborts = new Set<string>();
  /** Sessions whose teardown is COMMITTED and in flight: still registered in `live`, but already doomed.
   *  ensureLive's pre-lock fast path reads this to tell a healthy live session (attach immediately) from
   *  one being disposed (queue on the lock and respawn instead).
   *
   *  Marking is for a teardown that has DECIDED to dispose and then awaits — stopSession's
   *  abort-then-dispose. It is deliberately not for every path that merely awaits while registered:
   *  `restart()` awaits `settled()` holding a record that is still perfectly serviceable, and it does not
   *  hold the session lock, so marking it would push a concurrent ensureLive through the lock and spawn a
   *  DUPLICATE session in the window before its dispose. Those paths leave the record unmarked on purpose;
   *  a caller that fast-paths onto one gets a working session, exactly as it did before this fast path. */
  private disposing = new Set<string>();
  /** Parent aborts fence new delegated sends before the abort snapshots its child set. A counter keeps a
   * concurrent/nested abort from reopening the parent between another abort's snapshot and cleanup. */
  private abortingParents = new Map<string, number>();

  /** Serialize on `key`: chains fn behind whatever holds the lock (failures don't poison the chain). */
  withLock<K>(key: string, fn: () => Promise<K>): Promise<K> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const stored = next.then(() => undefined, () => undefined);
    this.locks.set(key, stored);
    // Release the key once it settles so the map doesn't accumulate a permanent entry for every session
    // id ever locked (idle/channel rollover mints fresh ids for the daemon's whole lifetime). Only delete
    // when we're still the tail — a newer withLock on the same key will have replaced `stored`.
    void stored.then(() => { if (this.locks.get(key) === stored) this.locks.delete(key); });
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
  set(id: string, b: T): void { this.disposing.delete(id); this.live.set(id, b); }
  /** Dispose the PI session and forget the record (no-op when absent). A reasoning marker still riding
   *  out its debounce dies with the session — the un-announced level change does not survive a dispose
   *  (respawns reset it), so the marker must not land after the record is gone. */
  dispose(id: string): void {
    this.disposing.delete(id);
    const b = this.live.get(id);
    if (!b) return;
    if (b.pendingReasoningMarker) { clearTimeout(b.pendingReasoningMarker.timer); b.pendingReasoningMarker = undefined; }
    b.session.dispose();
    this.live.delete(id);
  }
  /** Mark/unmark an in-flight teardown — see the `disposing` field. `dispose()` and `set()` clear it
   *  themselves, so a caller only has to clear when it ABANDONS a teardown it had marked. */
  markDisposing(id: string): void { this.disposing.add(id); }
  clearDisposing(id: string): void { this.disposing.delete(id); }
  isDisposing(id: string): boolean { return this.disposing.has(id); }
  liveEntries(): [string, T][] { return [...this.live]; }

  // ── active-conversation pointers ──────────────────────────────────────────
  activeIdFor(userId: number): string | undefined { return this.active.get(userId); }
  setActive(userId: number, id: string): void { this.active.set(userId, id); }
  clearActive(userId: number): void { this.active.delete(userId); }
  activeUserIds(): number[] { return [...this.active.keys()]; }
  activeIds(): string[] { return [...this.active.values()]; }

  // ── delegated-child lifecycle ─────────────────────────────────────────────
  /** Raise or release ONE source's liveness claim on a delegated child. Releasing removes only that
   *  source's claim; the child stays registered while any other source still holds one — the plugin's
   *  terminal progress row for a steered continuation must not deregister a child whose original
   *  delegated call is still running. */
  setChildRunning(parentSessionId: string, childSessionId: string, running: boolean, source: ChildClaimSource = 'call'): void {
    if (running) {
      let claims = this.children.get(parentSessionId);
      if (!claims) { claims = new Map(); this.children.set(parentSessionId, claims); }
      let sources = claims.get(childSessionId);
      if (!sources) { sources = new Set(); claims.set(childSessionId, sources); }
      sources.add(source);
      return;
    }
    const claims = this.children.get(parentSessionId);
    const sources = claims?.get(childSessionId);
    if (!claims || !sources) return;
    sources.delete(source);
    if (sources.size === 0) claims.delete(childSessionId);
    if (claims.size === 0) {
      this.children.delete(parentSessionId);
      this.resolveChildIdleWaiters(parentSessionId);
    }
  }
  childrenOf(parentSessionId: string): string[] { return [...(this.children.get(parentSessionId)?.keys() ?? [])]; }
  /** Whether one specific lifecycle writer still claims this edge. UI progress uses this to distinguish a
   * continuation tool's terminal row from the actual delegated call finishing. */
  hasChildClaim(parentSessionId: string, childSessionId: string, source: ChildClaimSource): boolean {
    return this.children.get(parentSessionId)?.get(childSessionId)?.has(source) === true;
  }
  hasActiveChildren(parentSessionId: string): boolean { return (this.children.get(parentSessionId)?.size ?? 0) > 0; }
  /** Park without polling until this parent's current direct children settle, or until the caller's bounded
   *  collect window expires. A new child started after an idle resolution belongs to the next collect pass. */
  waitForChildrenIdle(parentSessionId: string, timeoutMs: number): Promise<'idle' | 'timeout'> {
    if (!this.hasActiveChildren(parentSessionId)) return Promise.resolve('idle');
    const bounded = Math.max(0, Math.floor(timeoutMs));
    if (bounded === 0) return Promise.resolve('timeout');
    return new Promise((resolve) => {
      let waiters = this.childIdleWaiters.get(parentSessionId);
      if (!waiters) { waiters = new Set(); this.childIdleWaiters.set(parentSessionId, waiters); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: 'idle' | 'timeout') => {
        if (timer) clearTimeout(timer);
        waiters!.delete(onIdle);
        if (waiters!.size === 0) this.childIdleWaiters.delete(parentSessionId);
        resolve(outcome);
      };
      const onIdle = () => settle('idle');
      waiters.add(onIdle);
      timer = setTimeout(() => settle('timeout'), bounded);
      timer.unref?.();
      // No async boundary exists above, but keep the post-registration check as a future-proof fence if
      // this method ever gains instrumentation that can yield between the first check and waiter insert.
      if (!this.hasActiveChildren(parentSessionId)) onIdle();
    });
  }
  clearChildren(parentSessionId: string): void {
    this.children.delete(parentSessionId);
    this.resolveChildIdleWaiters(parentSessionId);
  }
  private resolveChildIdleWaiters(parentSessionId: string): void {
    const waiters = this.childIdleWaiters.get(parentSessionId);
    if (!waiters) return;
    this.childIdleWaiters.delete(parentSessionId);
    for (const resolve of waiters) resolve();
  }
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
    for (const claims of this.children.values()) if (claims.has(sessionId)) return true;
    return false;
  }
  /** Work still in flight, for the graceful-shutdown wait: serialized operations currently holding a
   *  session lock (a running turn holds one for its whole duration) and delegated children still running.
   *
   *  Deliberately a COUNT of what is observably busy, not a promise to have caught everything — a lock is
   *  released a microtask after its operation settles, so a zero here can trail reality by a tick. That is
   *  the right trade for a shutdown gate: it can only ever make us wait a moment longer, never cut a turn
   *  short, and the caller bounds the whole wait anyway. */
  busy(): { turns: number; children: number } {
    let children = 0;
    for (const claims of this.children.values()) children += claims.size;
    // A running turn holds BOTH locks of the topology above at once — `send-<id>` around the whole send and
    // the bare id around prompt() — so counting map entries reports every turn twice. Collapse each key
    // onto the conversation it locks and count those instead.
    const conversations = new Set<string>();
    for (const key of this.locks.keys()) conversations.add(lockedConversation(key));
    return { turns: conversations.size, children };
  }
  /** The conversations {@link busy} counts as turns, by IDENTITY — the step-boundary drain needs to ask
   *  "is THIS turn parked" per session, which a count cannot answer. Same lock→conversation mapping as
   *  busy(), so the two can never disagree about what is in flight. */
  activeTurnSessionIds(): string[] {
    const conversations = new Set<string>();
    for (const key of this.locks.keys()) conversations.add(lockedConversation(key));
    return [...conversations];
  }
  /** Every delegated child currently claimed live, across all parents — the drain-start log's identity
   *  companion to busy().children. */
  allChildSessionIds(): string[] {
    const out = new Set<string>();
    for (const claims of this.children.values()) for (const id of claims.keys()) out.add(id);
    return [...out];
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
  channelEntries(): [string, T][] { return [...this.channels]; }
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
}
