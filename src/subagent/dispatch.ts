import { logger } from '../shared/logger.js';
import type { BrainEvent } from '../brain/events.js';
import { SubagentRunnerUnavailable, type DelegatedTurnRequest, type DelegatedTurnRunner } from '../brain/delegatedTurn.js';

const log = logger('subagent-dispatch');

export type SubagentDispatchMode = 'in-process' | 'runner';

export interface SubagentDispatchDeps {
  /** Execute the delegated turn HERE — byte for byte what happened before the runner existed. */
  runTurn: (request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void) => Promise<string>;
  /** Hold the parts of a delegated CALL that live only in this process (the parent/child edge and the
   *  abort fencing) around its execution, wherever that happens — see ChannelSessionService.sendRemote.
   *  Both routes go through it: the call is open for as long as `run` is, and `run` is longer than the
   *  child's own turn now that runDelegatedTurn settles the reply against the child's own delegations
   *  (BrainService.settleDelegatedReply) — the edge held here is what keeps the child a live claim, and
   *  a stop on it a real abort, for that whole wait. */
  fenceRemote: (request: DelegatedTurnRequest, run: () => Promise<string>) => Promise<string>;
  /** The forked runner. ABSENT in the runner itself, which is what structurally keeps a nested delegation
   *  inside the same process instead of forking a runner from a runner. */
  runner?: DelegatedTurnRunner;
  /** The operator's switch, read LIVE so turning it off is a rollback with no redeploy: the very next
   *  delegated turn runs in-process again. */
  runnerEnabled?: () => boolean;
}

/** ONE source of truth for "does the next delegated turn leave this process?". Shared by
 *  {@link SubagentDispatch.mode} (the actual routing) and the daemon's plugin wiring
 *  (ctx.delegatedTurnsOutOfProcess — the workflow engine's expansion gate), so the prediction a plugin
 *  bakes into a child's briefing and tool policy can never drift from the decision this dispatcher makes:
 *  both read the same expression over the same live inputs.
 *
 *  A pool sized to zero by the operator is not a runner that might work — it is the in-process path, and
 *  saying so here is what keeps that config from logging a fallback warning per delegated turn.
 *
 *  The one residual divergence is the async fork-failure fallback in {@link SubagentDispatch.send}: a
 *  turn this predicted as 'runner' may still end up running here. That is safe by construction on the
 *  consumer side — the workflow engine derives the node's briefing AND its WorkflowAddNodes deny from
 *  this SAME prediction and carries both inside the delegated access, so a fallback turn arrives
 *  conservatively narrowed, never with a capability its briefing does not match. */
export function predictsRunnerDispatch(runner: DelegatedTurnRunner | undefined, runnerEnabled: boolean): boolean {
  if (!runner || !runnerEnabled) return false;
  return runner.usable?.() !== false;
}

/** THE routing decision for one delegated turn: run it on this event loop, or hand it to the sub-agent
 *  runner process.
 *
 *  It sits below both spawn routes by construction — the Delegate tool and a workflow node reach the host
 *  through the same `run` handle, and that handle ends here.
 *
 *  `in-process` is the default and is deliberately a straight pass-through: no wire payload is built, no
 *  child is consulted, nothing is re-derived. Flipping the switch off must leave literally the old code
 *  path, because that is what makes it a usable rollback. */
export class SubagentDispatch {
  constructor(private d: SubagentDispatchDeps) {}

  mode(): SubagentDispatchMode {
    return predictsRunnerDispatch(this.d.runner, this.d.runnerEnabled?.() === true) ? 'runner' : 'in-process';
  }

  async send(request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void): Promise<string> {
    const runner = this.d.runner;
    // The in-process turn holds its own edge inside ChannelSessionService.send, but only for the turn; the
    // outer fence here keeps the call open through the settlement that follows the turn (the edge counts
    // overlapping holders, so the nesting is exact).
    if (!runner || this.mode() === 'in-process') {
      return this.d.fenceRemote(request, () => this.d.runTurn(request, text, onEvent));
    }
    try {
      return await this.d.fenceRemote(request, () => runner.run(request, text, onEvent));
    } catch (e) {
      // The runner could not be STARTED — nothing of this turn ran anywhere, so running it here is the
      // difference between a slower delegation and a broken one. A turn that failed INSIDE a healthy
      // runner is a real failure and is reported as one: retrying it here would duplicate whatever side
      // effects it already had.
      if (!(e instanceof SubagentRunnerUnavailable)) throw e;
      log.warn(`sub-agent runner unavailable, running this delegated turn in-process: ${e.message}`);
      return this.d.fenceRemote(request, () => this.d.runTurn(request, text, onEvent));
    }
  }
}
