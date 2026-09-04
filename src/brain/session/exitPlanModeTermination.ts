import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { EXIT_PLAN_MODE_TOOL } from '../../shared/planTool.js';

type TurnBoundary = Parameters<NonNullable<AgentSession['agent']['shouldStopAfterTurn']>>[0];

/** A plan submission is successful only when the matching tool result settled without an error and
 * carries the plan used by the approval UI. Matching the call id prevents another tool from forging the
 * boundary by returning a similarly shaped details object. */
export function turnSubmittedPlan(turn: TurnBoundary): boolean {
  const exitCallIds = new Set<string>();
  for (const part of turn.message.content) {
    if (part.type === 'toolCall' && part.name === EXIT_PLAN_MODE_TOOL) exitCallIds.add(part.id);
  }
  if (exitCallIds.size === 0) return false;

  return turn.toolResults.some((result) => {
    if (!exitCallIds.has(result.toolCallId) || result.toolName !== EXIT_PLAN_MODE_TOOL || result.isError) return false;
    const details = result.details as { plan?: unknown } | undefined;
    return typeof details?.plan === 'string' && details.plan.trim().length > 0;
  });
}

/** Install Elowen's plan-approval boundary on PI's owner seam.
 *
 * PI calls prepareNextTurn before shouldStopAfterTurn. The prepare hook can run proactive compaction, so
 * recognizing ExitPlanMode only in shouldStopAfterTurn is too late: another provider request may already
 * have happened. This outer wrapper skips every next-turn preparer for a successful submission, then the
 * stop hook ends the run through PI's normal turn_end -> agent_end -> agent_settled lifecycle.
 *
 * The decision is based only on the finalized call/result pair. Sibling calls may finish in the same batch,
 * while cancelled or failed ExitPlanMode results do not stop a turn and cannot surface a stale plan. */
export function installExitPlanModeTermination(session: AgentSession): void {
  const previousPrepare = session.agent.prepareNextTurnWithContext;
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    if (turnSubmittedPlan(turn)) return undefined;
    return previousPrepare?.(turn, signal);
  };

  const previousStop = session.agent.shouldStopAfterTurn;
  session.agent.shouldStopAfterTurn = async (turn, signal) => {
    if (turnSubmittedPlan(turn)) return true;
    return await previousStop?.(turn, signal) === true;
  };
}
