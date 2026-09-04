import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { isChannelSession, isNonUserSession, isSubagentSession } from './sessionId.js';

/** One in-flight tool batch entry of one turn. `delegations` counts the delegated child calls this tool
 *  execution has REGISTERED (Delegate/DelegateContinue/WorkflowStart ride ChannelSessionService, which
 *  marks the edge synchronously before its first await) — a tool blocked ONLY on delegated children is
 *  safe to leave at shutdown, because boot recovery respawns the children and the durable outbox carries
 *  their results back. */
interface ToolExecutionRecord { delegations: number }

/** Ambient link from a deep delegation edge back to the tool call that is executing it. AsyncLocalStorage
 *  rather than plumbing, because the edge is registered many layers below the tool wrapper (plugin →
 *  dispatch → channel service) across genuinely async boundaries. Module-level: the marking site
 *  (channels.ts) must not need a coordinator instance to say "the current tool is a delegation". */
const toolExecutionContext = new AsyncLocalStorage<ToolExecutionRecord>();

/** Called by ChannelSessionService when a delegated call registers its parent→child edge. Outside any
 *  tool execution (boot recovery, result delivery, workflow engine ticks) there is no record and this is
 *  a no-op — exactly right, because no parent turn is blocked on those. */
export function markDelegationInCurrentTool(): void {
  const record = toolExecutionContext.getStore();
  if (record) record.delegations += 1;
}

/** The step-boundary shutdown drain: instead of waiting for whole TURNS to finish (a deep agent turn
 *  runs for many minutes), the drain waits only for the current STEP — one model round-trip plus its
 *  settled tool batch — of every live turn. At the step boundary the transcript's durable pending tail is
 *  fully answered (message_end persisted the assistant and every toolResult), so a restart resumes the
 *  turn from exactly there; mid-step the tail would be trimmed and the step repeated.
 *
 *  THE INVARIANT: A TURN PARKS ONLY WHERE A BOOT RESUME EXISTS. Parking a turn nothing ever resumes
 *  means its final model call never happens and the person who asked simply never gets an answer.
 *  Three session classes have a resume and therefore park:
 *   - DELEGATED SUB-AGENT sessions — a delegated child has a durable run row (respawned by the boot
 *     reconcile) and a workflow node has the engine's recovery journal;
 *   - TOP-LEVEL OWNER conversations (web dock / bound CLI) — parking writes a durable park marker on the
 *     session row (`brain_sessions.parked_at`, via the onParked hook below) and the `owner-conversations`
 *     boot recovery provider continues the turn and delivers its answer;
 *   - ORDINARY PLATFORM CHANNEL turns (Discord rooms, DMs, …) — the turn's durable resume envelope
 *     (channels.ts, PlatformTurnResumeEnvelope) plus the same park marker let the `platform-conversations`
 *     provider continue the turn and deliver its answer to the room.
 *     Eligibility is decided PER TURN at the moment of the park, through the `parksPlatformTurn` hook
 *     (platformTurnRecovery.ts): a faithful resume needs a valid envelope, a verified account and a
 *     nameable outbound target, so anything unproven — and every CRON/scheduled turn, which has no
 *     resume — fails closed and is waited for whole. No hook wired (fail closed) ⇒ never parks.
 *  Everything else has NO resume and is deliberately waited for WHOLE, exactly as before the step
 *  boundary existed: cron/scheduled turns, task-worker sessions (whose factory wires no coordinator),
 *  and held non-session serial keys such as a plugin reload.
 *
 *  Which states make a live turn SAFE to leave behind:
 *   - parked (any resumable class): its agent loop reached `prepareNextTurnWithContext` while
 *     draining and is held there;
 *   - delegating (SUB-AGENT sessions only): every in-flight tool of its current batch has registered at
 *     least one delegated child — the child is recoverable work and the parent's blocked tool call is
 *     re-answered durably at boot (see recoverOne's delegation-wait classification in
 *     delegatedSession.ts). An owner turn blocked on a foreground delegation is NOT safe: its results
 *     are only delivered into a running or freshly prompted turn, which nothing at boot provides for a
 *     top-level conversation, so the drain waits for that delegation whole;
 *   - finished: no active turn at all.
 *  Everything else — streaming from the model, or executing a local tool like Bash — is mid-step and the
 *  drain waits for it (bounded by the caller's overall budget).
 *
 *  One instance per PROCESS (daemon or sub-agent runner), owned by buildBrainCore; the daemon aggregates
 *  the runners' counts over the pool IPC. */
export class StepDrainCoordinator {
  private draining = false;
  /** Sessions whose agent loop is parked at the boundary hold. */
  private parked = new Set<string>();
  /** In-flight tool executions per session (the current step's unsettled batch). */
  private tools = new Map<string, Set<ToolExecutionRecord>>();

  /** `onParked` fires SYNCHRONOUSLY the moment a hold actually parks a session's loop — the seam that
   *  writes the durable park marker for owner conversations and platform channel turns, and it must
   *  complete before the drain can observe the park (marker durable strictly before the process exits).
   *  `parksPlatformTurn` is the per-turn eligibility check for ordinary platform channel sessions
   *  (see the class doc); it is consulted at the moment of the park, when the turn's durable resume
   *  envelope already exists, and anything but an explicit `true` — including a missing hook or a
   *  throwing one — refuses the park. */
  constructor(private hooks?: { onParked?(sessionId: string): void; parksPlatformTurn?(sessionId: string): boolean }) {}

  /** May a hold ever be installed for this session — see the class doc. Sub-agent sessions are resumed by
   *  the delegation reconcile / workflow journal; owner conversations and ordinary platform channel turns
   *  by their park-marker sweeps. Task sessions and (without the platform hook) every non-subagent
   *  channel session have no resume. */
  private parkEligible(sessionId: string): boolean {
    if (isSubagentSession(sessionId) || !isNonUserSession(sessionId)) return true;
    return isChannelSession(sessionId) && typeof this.hooks?.parksPlatformTurn === 'function';
  }

  /** May THIS park actually happen right now. Static classes park unconditionally; an ordinary platform
   *  channel turn parks only when the hook proves its current turn is faithfully resumable (valid durable
   *  envelope, verified account, outbound target — and never a cron/scheduled turn). Fail closed: a
   *  refused park simply leaves the turn mid-step and the drain waits for it whole, as before. */
  private mayParkNow(sessionId: string): boolean {
    if (isSubagentSession(sessionId) || !isNonUserSession(sessionId)) return true;
    try { return this.hooks?.parksPlatformTurn?.(sessionId) === true; } catch { return false; }
  }

  /** Latch the drain. One-way, like BrainService.draining: a draining process is on its way out. */
  begin(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** PAUSE-mode park: mark THIS live turn parked right now, without waiting for its loop to reach the
   *  step boundary. Same eligibility as the hold (only a session with a boot resume may park, a platform
   *  turn only when its envelope proves it), same durable marker through `onParked`. Returns whether the
   *  turn was parked; the caller exits the process immediately afterwards and boot recovery continues the
   *  turn from its durable tail — see BrainService.pauseForRestart. */
  parkNow(sessionId: string): boolean {
    if (!this.parkEligible(sessionId) || !this.mayParkNow(sessionId)) return false;
    this.parked.add(sessionId);
    this.hooks?.onParked?.(sessionId);
    return true;
  }

  /** Install the boundary hold on a freshly spawned session. Installed LAST (after the compaction
   *  wrapper), so it runs FIRST: a draining daemon must not spend a compaction model call on a turn it is
   *  about to park. The hold releases only on the turn's own abort signal (`/stop` still works and lets
   *  the turn unwind); otherwise the loop stays parked until the process exits — which is the point. */
  installHold(session: AgentSession, sessionId: string): void {
    // A session without a boot resume must never park: the drain deliberately waits for those turns
    // whole, and a hold here would deadlock that wait against its own park.
    if (!this.parkEligible(sessionId)) return;
    const previous = session.agent.prepareNextTurnWithContext;
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      if (this.draining && !signal?.aborted && this.mayParkNow(sessionId)) {
        this.parked.add(sessionId);
        // Durable marker first (owner conversations and platform channel turns — see the brainCore
        // wiring): the drain exits the moment every turn reads as parked, so the marker must already be
        // on disk by then.
        this.hooks?.onParked?.(sessionId);
        try {
          await new Promise<void>((resolve) => {
            if (!signal) return; // no abort seam to release on — parked until exit, released by nothing
            signal.addEventListener('abort', () => resolve(), { once: true });
            if (signal.aborted) resolve();
          });
        } finally {
          this.parked.delete(sessionId);
        }
      }
      return previous?.(turn, signal);
    };
  }

  /** Wrap every composed tool so its execution window is observable per session. The wrapper only
   *  brackets execute with bookkeeping inside the ALS record scope; arguments, results and errors pass
   *  through untouched, so system-prompt bytes and tool behavior stay identical (the in-process/runner
   *  parity invariant). */
  wrapTools(sessionId: string, tools: ToolDefinition[]): ToolDefinition[] {
    // Tool-batch tracking feeds only the delegation-safe rule, which applies to sub-agent sessions
    // alone (see unsafeCount) — for every other session the records would be bookkeeping nothing reads.
    if (!isSubagentSession(sessionId)) return tools;
    return tools.map((tool) => {
      if (typeof tool.execute !== 'function') return tool; // defensive (test stubs) — nothing to observe
      const run = tool.execute.bind(tool);
      const execute = (async (...args: Parameters<ToolDefinition['execute']>) => {
        const record: ToolExecutionRecord = { delegations: 0 };
        let records = this.tools.get(sessionId);
        if (!records) { records = new Set(); this.tools.set(sessionId, records); }
        records.add(record);
        try {
          return await toolExecutionContext.run(record, () => run(...args));
        } finally {
          records.delete(record);
          if (records.size === 0) this.tools.delete(sessionId);
        }
      }) as ToolDefinition['execute'];
      return { ...tool, execute };
    });
  }

  /** How many of the given in-flight turns are still MID-STEP — the number the drain waits on. The
   *  caller passes the registry's live turn identities (same lock→conversation mapping as busy(), so the
   *  two views cannot disagree); a held non-session serial key (e.g. a plugin reload) reads as unsafe
   *  here exactly as it counted as a turn before. */
  unsafeCount(activeTurnSessionIds: string[]): number {
    let unsafe = 0;
    for (const sessionId of activeTurnSessionIds) {
      // Parked is safe for EVERY resumable class: only park-eligible sessions ever enter this set.
      if (this.parked.has(sessionId)) continue;
      // The delegation-safe rule stays SUB-AGENT ONLY (see the class doc): a channel/cron turn, a
      // non-session serial key, and an owner turn blocked on a foreground delegation are all waited
      // for whole — none of them has a boot path that would deliver the blocked call's answer.
      if (!isSubagentSession(sessionId)) { unsafe += 1; continue; }
      const records = this.tools.get(sessionId);
      if (records && records.size > 0 && [...records].every((record) => record.delegations > 0)) continue;
      unsafe += 1;
    }
    return unsafe;
  }
}
