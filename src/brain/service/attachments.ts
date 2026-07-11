import type { BrainEvent } from '../events.js';

type ClientListener = (e: BrainEvent) => void;

interface StableClientBinding {
  userId: number;
  sessionId: string;
  generation: number;
  /** Monotonic generation supplied by one CLI process's start requests. Prevents network-reordered
   *  older starts from reclaiming the stable identity after a newer selection already won. */
  requestGeneration?: number;
  /** Present only while this client's SSE transport is still attached. The stable binding deliberately
   *  survives transport teardown so a racing stop POST can still resolve an idle-rollover replacement. */
  listener?: ClientListener;
  detach?: () => void;
  detachedAt?: number;
  /** A start claim reserves its default-session candidate until the replacement SSE arrives. A transport
   *  that merely disconnected after being fully attached is NOT pending and must not block a later CLI
   *  launch in the same cwd for the whole grace TTL. */
  pendingStart?: boolean;
}

interface ClientGenerationTombstone {
  /** Highest request generation that was cancelled or explicitly stopped. It deliberately survives after
   *  the live binding is consumed so a network-delayed start/send cannot resurrect the client. */
  requestGeneration: number;
  /** Highest generation for which an explicit stop has already been consumed. A failed-start tombstone
   *  fences reordered work too, but must still allow the following stop to clean up the prior binding. */
  stoppedThrough: number;
  detachedAt: number;
}

interface AttachmentLimits {
  /** Crash/SIGKILL clients never send stop. Keep a bounded grace cache for their detached identities. */
  maxDetached?: number;
  detachedTtlMs?: number;
  now?: () => number;
}

export interface ClientClaim {
  accepted: boolean;
  generation: number;
  sessionId: string;
  previousSessionId?: string;
  /** No current binding exists to redirect this stale request to: it was already cancelled/stopped. */
  closed?: boolean;
}

export interface ClientRelease {
  accepted: boolean;
  sessionId?: string;
}

/** Result of resolving the target carried by a generation-bound parent SSE. An idle rollover moves the
 * stable binding before it emits its `session` frame; a reconnect that missed that frame must tap the
 * moved target rather than repeatedly attempting the disposed predecessor. */
export interface ClientStreamResolution {
  accepted: boolean;
  sessionId: string;
}

/** Live client attachment tracking, shared by the conversation lifecycle (subscribe/tap and the
 *  switch-away/default-start guards), the turn runner (an idle rollover carries attachments onto the
 *  replacement session), the spawner (tap re-attach on respawn) and the status views (`attached`). */
export class ClientAttachments {
  private readonly maxDetached: number;
  private readonly detachedTtlMs: number;
  private readonly now: () => number;
  private nextGeneration = 0;

  constructor(limits: AttachmentLimits = {}) {
    this.maxDetached = Math.max(0, limits.maxDetached ?? 1_024);
    this.detachedTtlMs = Math.max(0, limits.detachedTtlMs ?? 5 * 60_000);
    this.now = limits.now ?? Date.now;
  }
  /** Live client streams (SSE listeners from /brain/stream) → the session id each is attached to.
   *  Only REAL client streams register here (subscribe + tapSession); internal fanout listeners and the
   *  respawn re-attach never do. An idle rollover re-keys entries onto the replacement session (the
   *  listeners are carried there). Powers `attached` in listSessions, the CLI default-start resolution
   *  ("don't grab a conversation another client holds") and the switch-away cleanup guard. */
  readonly clientStreams = new Map<ClientListener, string>();

  /** Stable authenticated client identities (scoped by user id). Unlike `clientStreams`, a binding is
   *  retained after its socket closes until the client's stop request consumes it or the same client
   *  reconnects. This closes both races at quit: POST-before-SSE-detach and SSE-detach-before-POST. */
  private readonly stableClients = new Map<string, StableClientBinding>();
  private readonly stableKeyByListener = new Map<ClientListener, string>();
  /** Generation high-water marks left by failed starts and explicit stops. Kept separately from live
   *  bindings so a cancelled claim cannot become stop's target, while reordered requests still fence. */
  private readonly generationTombstones = new Map<string, ClientGenerationTombstone>();

  /** Long-lived listeners keyed by SESSION id — re-attached by the spawner whenever that session
   *  (re)spawns, so an open drill-in stream survives respawns (unlike a raw `listeners.add`). */
  readonly sessionTaps = new Map<string, Set<(e: BrainEvent) => void>>();

  /** How many live client streams are currently attached to this session (web dock subscriptions +
   *  CLI session taps). 0 = no client is following the conversation right now. */
  attachedCount(sessionId: string): number {
    let n = 0;
    for (const sid of this.clientStreams.values()) if (sid === sessionId) n += 1;
    return n;
  }

  /** Default CLI start candidates are held as soon as /brain/start claims them, before their SSE exists.
   *  This closes the two-simultaneous-launch gap without treating an ordinary disconnected grace binding
   *  as attached for five minutes. */
  availableForDefaultStart(sessionId: string): boolean {
    this.pruneDetached();
    if (this.attachedCount(sessionId) > 0) return false;
    for (const binding of this.stableClients.values()) {
      if (binding.sessionId === sessionId && binding.pendingStart) return false;
    }
    return true;
  }

  private stableKey(userId: number, clientId: string): string {
    return `${userId}\u0000${clientId}`;
  }

  /** Opportunistic pruning needs no timer (and therefore cannot keep the daemon alive). Active
   *  transports are never candidates; only detached grace bindings expire or count toward the cap. */
  private pruneDetached(): void {
    const now = this.now();
    const detached: { key: string; at: number; kind: 'binding' | 'tombstone' }[] = [];
    for (const entry of this.stableClients) {
      const [key, binding] = entry;
      if (binding.listener) continue;
      if (now - (binding.detachedAt ?? now) >= this.detachedTtlMs) this.stableClients.delete(key);
      else detached.push({ key, at: binding.detachedAt ?? 0, kind: 'binding' });
    }
    for (const [key, tombstone] of this.generationTombstones) {
      if (now - tombstone.detachedAt >= this.detachedTtlMs) this.generationTombstones.delete(key);
      else detached.push({ key, at: tombstone.detachedAt, kind: 'tombstone' });
    }
    if (detached.length <= this.maxDetached) return;
    detached.sort((a, b) => a.at - b.at);
    for (const entry of detached.slice(0, detached.length - this.maxDetached)) {
      if (entry.kind === 'binding') this.stableClients.delete(entry.key);
      else this.generationTombstones.delete(entry.key);
    }
  }

  private rememberGeneration(key: string, requestGeneration: number | undefined, stopped = false): void {
    if (requestGeneration === undefined) return;
    const previous = this.generationTombstones.get(key);
    this.generationTombstones.delete(key); // refresh bounded-cache insertion order
    this.generationTombstones.set(key, {
      requestGeneration: Math.max(requestGeneration, previous?.requestGeneration ?? 0),
      stoppedThrough: Math.max(stopped ? requestGeneration : 0, previous?.stoppedThrough ?? 0),
      detachedAt: this.now(),
    });
  }

  /** Register one live SSE transport. A reconnect with the same authenticated client id replaces only
   *  that client's old listener; unrelated clients attached to the same conversation are untouched. */
  attach(userId: number, sessionId: string, listener: ClientListener, detach: () => void, clientId?: string, requestGeneration?: number): boolean {
    this.pruneDetached();
    if (!clientId) {
      this.clientStreams.set(listener, sessionId);
      return true;
    }
    const key = this.stableKey(userId, clientId);
    const previous = this.stableClients.get(key);
    // A stop/cancel consumed the corresponding claim. Only a NEW /start with a higher generation may
    // clear this tombstone; a late SSE is never allowed to do so on its own.
    if (this.generationTombstones.has(key)) return false;
    // A buffered/retried SSE from switch A can arrive after start B already claimed this identity.
    // Reject it before it enters clientStreams or any LiveBrain listener set.
    if (previous?.requestGeneration !== undefined
      && (requestGeneration === undefined
        ? previous.sessionId !== sessionId
        : requestGeneration < previous.requestGeneration
          || (requestGeneration === previous.requestGeneration && previous.sessionId !== sessionId))) {
      return false;
    }
    if (previous?.listener && previous.listener !== listener) previous.detach?.();
    this.clientStreams.set(listener, sessionId);
    this.stableClients.delete(key); // refresh insertion order on reconnect
    this.stableClients.set(key, {
      userId, sessionId, listener, detach,
      generation: previous?.sessionId === sessionId ? previous.generation : ++this.nextGeneration,
      ...(requestGeneration !== undefined
        ? { requestGeneration }
        : previous?.sessionId === sessionId && previous.requestGeneration !== undefined
          ? { requestGeneration: previous.requestGeneration } : {}),
      pendingStart: false,
    });
    this.stableKeyByListener.set(listener, key);
    return true;
  }

  /** Claim the conversation selected by an authenticated `/brain/start` before the client opens its
   *  replacement SSE. Deliberate session switches therefore outrank the previous stream binding during
   *  the history/meta loading gap. The old transport for this identity is detached immediately, while
   *  unrelated clients on that old conversation remain attached. */
  claim(userId: number, clientId: string, sessionId: string, requestGeneration?: number): ClientClaim {
    this.pruneDetached();
    const key = this.stableKey(userId, clientId);
    const previous = this.stableClients.get(key);
    const tombstone = this.generationTombstones.get(key);
    if (requestGeneration !== undefined && tombstone && requestGeneration <= tombstone.requestGeneration) {
      return { accepted: false, closed: true, generation: 0, sessionId };
    }
    if (requestGeneration !== undefined && previous?.requestGeneration !== undefined
      && requestGeneration < previous.requestGeneration) {
      return { accepted: false, generation: previous.generation, sessionId: previous.sessionId, previousSessionId: previous.sessionId };
    }
    if (requestGeneration !== undefined && previous?.requestGeneration === requestGeneration
      && previous.sessionId !== sessionId) {
      return { accepted: false, generation: previous.generation, sessionId: previous.sessionId, previousSessionId: previous.sessionId };
    }
    // `/brain/start` declares a new stream generation even when it resumes the same conversation. Detach
    // this caller first so switch-away guards count only OTHER clients, never its dying old SSE.
    if (previous?.listener) previous.detach?.();
    const generation = ++this.nextGeneration;
    this.generationTombstones.delete(key);
    this.stableClients.delete(key);
    this.stableClients.set(key, {
      userId, sessionId, generation, detachedAt: this.now(),
      ...(requestGeneration !== undefined ? { requestGeneration } : {}),
      pendingStart: true,
    });
    this.pruneDetached();
    return {
      accepted: true, generation, sessionId,
      ...(previous?.sessionId ? { previousSessionId: previous.sessionId } : {}),
    };
  }

  /** Whether one start request still owns the stable claim it created before spawning. */
  isCurrentClaim(userId: number, clientId: string, generation: number): boolean {
    return this.stableClients.get(this.stableKey(userId, clientId))?.generation === generation;
  }

  /** Current target of this client identity. A newer start to the SAME target keeps that target alive;
   *  an absent/different result means an older in-flight start was abandoned and may clean up its spawn. */
  claimedSession(userId: number, clientId: string): string | undefined {
    return this.stableClients.get(this.stableKey(userId, clientId))?.sessionId;
  }

  /** Roll back a failed start without deleting a newer start/stream generation. */
  cancelClaim(userId: number, clientId: string, generation: number): void {
    const key = this.stableKey(userId, clientId);
    const binding = this.stableClients.get(key);
    if (binding?.generation !== generation) return;
    this.stableClients.delete(key);
    this.rememberGeneration(key, binding.requestGeneration);
    this.pruneDetached();
  }

  /** Authorize one generation-bound request (currently /brain/send). With no prior state, establish the
   *  detached binding so a CLI can recover after a daemon restart before its SSE reconnects. A tombstone
   *  can be cleared only by a strictly newer /brain/start, never by send itself. */
  authorizeRequest(userId: number, clientId: string, sessionId: string, requestGeneration: number): boolean {
    this.pruneDetached();
    const key = this.stableKey(userId, clientId);
    if (this.generationTombstones.has(key)) return false;
    const binding = this.stableClients.get(key);
    if (binding) return binding.sessionId === sessionId && binding.requestGeneration === requestGeneration;
    this.stableClients.set(key, {
      userId, sessionId, generation: ++this.nextGeneration,
      requestGeneration, detachedAt: this.now(), pendingStart: false,
    });
    this.pruneDetached();
    return this.stableClients.get(key)?.requestGeneration === requestGeneration;
  }

  /** Resolve a parent SSE's requested session through its stable authenticated binding. Only the exact
   * generation that created the binding may follow a retarget; an older/newer transport is stale rather
   * than a licence to attach to whatever the client id currently owns. No binding is deliberately
   * accepted for daemon-restart compatibility — `attach()` will reconstruct it after normal ownership
   * validation. */
  resolveStreamSession(userId: number, clientId: string, requestGeneration: number, requestedSessionId: string): ClientStreamResolution {
    this.pruneDetached();
    const key = this.stableKey(userId, clientId);
    if (this.generationTombstones.has(key)) return { accepted: false, sessionId: requestedSessionId };
    const binding = this.stableClients.get(key);
    if (!binding || binding.requestGeneration === undefined) return { accepted: true, sessionId: requestedSessionId };
    if (binding.requestGeneration !== requestGeneration) return { accepted: false, sessionId: requestedSessionId };
    return { accepted: true, sessionId: binding.sessionId };
  }

  /** Detach a dead SSE transport without losing its stable session binding. The following stop POST may
   *  therefore still find the replacement id even when socket abort reached the daemon first. */
  detachTransport(listener: ClientListener): void {
    this.clientStreams.delete(listener);
    const key = this.stableKeyByListener.get(listener);
    if (!key) return;
    this.stableKeyByListener.delete(listener);
    const binding = this.stableClients.get(key);
    if (binding?.listener === listener) {
      binding.listener = undefined;
      binding.detach = undefined;
      binding.detachedAt = this.now();
    }
    this.pruneDetached();
  }

  /** Consume one authenticated client's binding and detach only its live transport. Returns the
   *  binding's CURRENT session id (updated by retarget), which intentionally outranks a stale id in the
   *  stop request body. */
  release(userId: number, clientId: string, requestGeneration?: number): ClientRelease {
    this.pruneDetached();
    const key = this.stableKey(userId, clientId);
    const binding = this.stableClients.get(key);
    if (!binding) {
      const tombstone = this.generationTombstones.get(key);
      if (requestGeneration !== undefined && tombstone && requestGeneration <= tombstone.stoppedThrough) {
        return { accepted: false };
      }
      this.rememberGeneration(key, requestGeneration, true);
      this.pruneDetached();
      return { accepted: true };
    }
    // A network-delayed stop from generation N must never tear down a newer N+1 binding.
    if (requestGeneration !== undefined && binding.requestGeneration !== undefined
      && requestGeneration < binding.requestGeneration) {
      return { accepted: false };
    }
    this.stableClients.delete(key);
    if (binding.listener) this.stableKeyByListener.delete(binding.listener);
    binding.detach?.();
    this.rememberGeneration(key, requestGeneration === undefined
      ? binding.requestGeneration
      : Math.max(requestGeneration, binding.requestGeneration ?? 0), true);
    this.pruneDetached();
    return { accepted: true, sessionId: binding.sessionId };
  }

  /** Re-key everything attached to a rolled-over conversation onto its replacement session. */
  retarget(oldId: string, freshId: string): void {
    // Attached client streams move with their listeners so `attached` stays truthful post-rollover.
    for (const [l, sid] of this.clientStreams) if (sid === oldId) this.clientStreams.set(l, freshId);
    // Stable identities move even when their transport happened to disconnect just before this method.
    // A stop request carrying the pre-rollover id can consequently still reach the replacement session.
    for (const binding of this.stableClients.values()) if (binding.sessionId === oldId) binding.sessionId = freshId;
    // Session taps (the CLI's bound stream) follow too, so a later respawn of the REPLACEMENT session
    // re-attaches them — the client just rebinds its id, its open stream never goes dark.
    const taps = this.sessionTaps.get(oldId);
    if (taps) {
      this.sessionTaps.delete(oldId);
      const existing = this.sessionTaps.get(freshId);
      if (existing) for (const t of taps) existing.add(t);
      else this.sessionTaps.set(freshId, taps);
    }
  }
}
