import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { isSubagentSession } from './sessionId.js';

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
 *  PARKING IS ONLY SAFE WHERE BOOT RECOVERY CAN RESUME THE WORK, which today means DELEGATED SUB-AGENT
 *  sessions only: a delegated child has a durable run row (respawned by the boot reconcile) and a
 *  workflow node has the engine's recovery journal — but a TOP-LEVEL owner/channel turn has neither.
 *  Nothing prompts such a session again after a restart, so parking it would mean its final model call
 *  never happens and the person who asked simply never gets an answer. Those turns are therefore always
 *  counted mid-step and the drain waits them out whole, exactly as it did before the step boundary
 *  existed (turn-only drains converge in 10–30 s in practice).
 *
 *  For a sub-agent session, three states make its turn SAFE to leave behind:
 *   - parked: its agent loop reached `prepareNextTurnWithContext` while draining and is held there;
 *   - delegating: every in-flight tool of its current batch has registered at least one delegated child
 *     (the child is recoverable work, and the parent's blocked tool call is re-answered durably at boot —
 *     see recoverOne's delegation-wait classification in delegatedSession.ts);
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

  /** Latch the drain. One-way, like BrainService.draining: a draining process is on its way out. */
  begin(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** Install the boundary hold on a freshly spawned session. Installed LAST (after the compaction
   *  wrapper), so it runs FIRST: a draining daemon must not spend a compaction model call on a turn it is
   *  about to park. The hold releases only on the turn's own abort signal (`/stop` still works and lets
   *  the turn unwind); otherwise the loop stays parked until the process exits — which is the point. */
  installHold(session: AgentSession, sessionId: string): void {
    // Only a delegated sub-agent session may park: boot recovery can resume IT. Parking a top-level
    // conversation turn would strand it — the drain deliberately waits for those whole, and a hold here
    // would deadlock that wait against its own park.
    if (!isSubagentSession(sessionId)) return;
    const previous = session.agent.prepareNextTurnWithContext;
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      if (this.draining && !signal?.aborted) {
        this.parked.add(sessionId);
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
    // Same gate as installHold: a non-sub-agent turn is unconditionally mid-step, so tracking its tool
    // batches would be bookkeeping nothing reads.
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
      // A turn boot recovery cannot resume is waited for WHOLE — parking and the delegation rule apply
      // only to delegated sub-agent sessions (see the class doc). This covers top-level owner/channel
      // conversations, cron sessions and non-session serial keys alike.
      if (!isSubagentSession(sessionId)) { unsafe += 1; continue; }
      if (this.parked.has(sessionId)) continue;
      const records = this.tools.get(sessionId);
      if (records && records.size > 0 && [...records].every((record) => record.delegations > 0)) continue;
      unsafe += 1;
    }
    return unsafe;
  }
}
