/** How long a live PI session may sit unwatched and idle before the sweep disposes the RUNTIME. Purely a
 *  memory bound: the durable conversation is untouched and the next message respawns it from SQLite.
 *  Nothing about it moves or replaces a conversation — no surface has an idle cutoff on its history. */
export const IDLE_LIVE_SESSION_TTL_MS = 30 * 60 * 1000;

/** One live conversation as the reaper sees it: its id and whether it currently qualifies for reaping
 *  (nobody attached, nothing running). The caller owns that predicate — this module owns only WHEN. */
export interface ReapCandidate {
  sessionId: string;
  reapable: boolean;
}

/** Continuity clock behind the idle live-session reaper.
 *
 *  The subtle part of reaping a runtime nobody watches is not the TTL, it is what the TTL is measured
 *  FROM. Measuring from the client's disconnect would kill an agent that is still working — a phone locks,
 *  the tab detaches, and thirty minutes later the run is torn down mid-turn. So the stamp is taken the
 *  moment a session first becomes BOTH unwatched and idle, and ANY violation of that state (a new attach,
 *  a new turn, a parked question) drops it. An agent working for hours without a client therefore never
 *  starts the clock at all; only a genuinely abandoned runtime ages. */
export class IdleSessionClock {
  /** sessionId → epoch ms at which it last became continuously reapable. */
  private readonly since = new Map<string, number>();

  /** Advance the clock over the current live set and return the ids reapable for at least `ttlMs`.
   *  Sessions absent from `candidates` (already disposed) are forgotten, so the map cannot grow. */
  due(candidates: readonly ReapCandidate[], now: number, ttlMs: number): string[] {
    const seen = new Set<string>();
    const due: string[] = [];
    for (const candidate of candidates) {
      seen.add(candidate.sessionId);
      if (!candidate.reapable) { this.since.delete(candidate.sessionId); continue; }
      const first = this.since.get(candidate.sessionId);
      if (first === undefined) { this.since.set(candidate.sessionId, now); continue; }
      if (now - first >= ttlMs) due.push(candidate.sessionId);
    }
    for (const id of [...this.since.keys()]) if (!seen.has(id)) this.since.delete(id);
    return due;
  }

  /** How long this session has been continuously reapable, for the reap log line. */
  reapableSince(sessionId: string): number | undefined {
    return this.since.get(sessionId);
  }

  /** Drop one session's stamp (it was disposed by another path). */
  forget(sessionId: string): void {
    this.since.delete(sessionId);
  }
}
