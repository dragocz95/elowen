import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { sameProjectExecution, type ProjectExecutionRef } from '../../shared/projectExecution.js';
import { turnSubmittedPlan } from './exitPlanModeTermination.js';

type BoundaryTurn = Parameters<NonNullable<AgentSession['agent']['prepareNextTurnWithContext']>>[0];

type ProjectExecutionBoundaryDeps = {
  current: () => ProjectExecutionRef | undefined;
  commit: (ref: ProjectExecutionRef) => Promise<void>;
};

/** Holds one model-requested Project switch until PI's awaited between-step boundary. */
export function createProjectExecutionBoundary(deps: ProjectExecutionBoundaryDeps) {
  let pending: { source: ProjectExecutionRef | undefined; target: ProjectExecutionRef } | undefined;

  return {
    request(target: ProjectExecutionRef): 'pending' | 'unchanged' {
      const current = deps.current();
      if (current && sameProjectExecution(current, target)) return 'unchanged';
      if (pending) {
        if (sameProjectExecution(pending.target, target)) return 'pending';
        throw new Error('another Project switch is already pending');
      }
      pending = { source: current, target };
      return 'pending';
    },
    install(session: AgentSession): void {
      const previous = session.agent.prepareNextTurnWithContext;
      session.agent.prepareNextTurnWithContext = async (turn: BoundaryTurn, signal) => {
        let snapshot;
        try {
          snapshot = await previous?.(turn, signal);
        } catch (error) {
          pending = undefined;
          throw error;
        }
        const requested = pending;
        pending = undefined;
        if (!requested || signal?.aborted || turnSubmittedPlan(turn)) return snapshot;
        const current = deps.current();
        if ((requested.source === undefined && current !== undefined)
          || (requested.source !== undefined && (current === undefined || !sameProjectExecution(requested.source, current)))) {
          return snapshot;
        }
        try {
          await deps.commit(requested.target);
        } catch {
          // The old target remains authoritative. The next turn can discover the live refusal via Project.list.
        }
        return snapshot;
      };
    },
  };
}
