import { isChannelSession, isNonUserSession, isSubagentSession } from './sessionId.js';

/** The park decision of the pause-for-restart: which live turns get a durable park marker the moment the
 *  daemon is told to stop, so a boot resume continues them from their checkpointed tail.
 *
 *  THE INVARIANT: A TURN PARKS ONLY WHERE A BOOT RESUME EXISTS. Parking a turn nothing ever resumes means
 *  its final model call never happens and the person who asked simply never gets an answer. Two session
 *  classes have a resume and therefore park:
 *   - TOP-LEVEL OWNER conversations (web dock / bound CLI) — the marker on the session row
 *     (`brain_sessions.parked_at`, via the onParked hook below) is the `owner-conversations` boot
 *     provider's worklist; it continues the turn and delivers its answer;
 *   - ORDINARY PLATFORM CHANNEL turns (Discord rooms, DMs, …) — the turn's durable resume envelope
 *     (channels.ts, PlatformTurnResumeEnvelope) plus the same marker let the `platform-conversations`
 *     provider continue the turn and deliver its answer to the room. Eligibility is decided PER TURN at
 *     the moment of the park through the `parksPlatformTurn` hook (platformTurnRecovery.ts): a faithful
 *     resume needs a valid envelope, a verified account and a nameable outbound target, so anything
 *     unproven — and every CRON/scheduled turn, which has no resume — fails closed. No hook wired (fail
 *     closed) ⇒ never parks.
 *  Delegated SUB-AGENT sessions never take a marker: their durable run row is claimed and respawned by
 *  the boot reconcile (delegatedSession.ts). Everything else (a task-worker session, a cron run) has NO
 *  resume; the pause gives it one bounded wait and records the interruption (BrainService.pauseForRestart).
 *
 *  One instance per process, owned by buildBrainCore. */
export class TurnParkPolicy {
  /** `onParked` fires SYNCHRONOUSLY the moment a turn is parked — the seam that writes the durable park
   *  marker for owner conversations and platform channel turns; it must complete before the pause can
   *  exit (marker durable strictly before the process leaves). `parksPlatformTurn` is the per-turn
   *  eligibility check for ordinary platform channel sessions (see the class doc); anything but an
   *  explicit `true` — including a missing hook or a throwing one — refuses the park. */
  constructor(private hooks?: { onParked?(sessionId: string): void; parksPlatformTurn?(sessionId: string): boolean }) {}

  /** May a park ever happen for this session — see the class doc. */
  private parkEligible(sessionId: string): boolean {
    if (isSubagentSession(sessionId)) return false;
    if (!isNonUserSession(sessionId)) return true;
    return isChannelSession(sessionId) && typeof this.hooks?.parksPlatformTurn === 'function';
  }

  /** May THIS park actually happen right now. Owner conversations park unconditionally; an ordinary
   *  platform channel turn parks only when the hook proves its current turn is faithfully resumable
   *  (valid durable envelope, verified account, outbound target — and never a cron/scheduled turn). */
  private mayParkNow(sessionId: string): boolean {
    if (!isNonUserSession(sessionId)) return true;
    try { return this.hooks?.parksPlatformTurn?.(sessionId) === true; } catch { return false; }
  }

  /** Mark THIS live turn parked right now. Returns whether the turn was parked; a refusal means the
   *  caller must treat the turn as having no resume. */
  parkNow(sessionId: string): boolean {
    if (!this.parkEligible(sessionId) || !this.mayParkNow(sessionId)) return false;
    this.hooks?.onParked?.(sessionId);
    return true;
  }
}
