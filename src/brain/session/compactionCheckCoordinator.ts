import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

type PiAssistantMessage = Extract<AgentSessionEvent, { type: 'message_end' }>['message'];
type CheckCompaction = (assistantMessage: PiAssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
type PiCompactionSession = { _checkCompaction?: CheckCompaction };

interface ActiveCheck {
  generation: number;
  /** PI uses skipAbortedCheck=false only for the pre-prompt check that runs before AgentSession becomes
   * active. Cancelling that check must reject admission, otherwise prompt() would continue after stop. */
  prePrompt: boolean;
}

interface CoordinatorState {
  generation: number;
  active: Set<ActiveCheck>;
  waiters: Set<() => void>;
  wrapped: CheckCompaction;
}

const coordinators = new WeakMap<AgentSession, CoordinatorState>();

/** Isolate PI's one version-sensitive compaction seam and make every native check observable by teardown.
 * This covers boundary, post-agent overflow, and pre-prompt checks without replacing PI's compaction
 * implementation or controller. */
export function coordinateNativeCompactionChecks(session: AgentSession): CheckCompaction | undefined {
  const existing = coordinators.get(session);
  if (existing) return existing.wrapped;
  const piSession = session as unknown as PiCompactionSession;
  const original = piSession._checkCompaction?.bind(session);
  if (!original) return undefined;

  const state = {} as CoordinatorState;
  state.generation = 0;
  state.active = new Set();
  state.waiters = new Set();
  state.wrapped = async (assistantMessage, skipAbortedCheck) => {
    const check: ActiveCheck = { generation: state.generation, prePrompt: skipAbortedCheck === false };
    state.active.add(check);
    try {
      let result: boolean;
      try {
        result = await original(assistantMessage, skipAbortedCheck);
      } catch (error) {
        if (check.generation === state.generation) throw error;
        if (check.prePrompt) throw new Error('session work aborted');
        return false;
      }
      if (check.generation !== state.generation && check.prePrompt) throw new Error('session work aborted');
      return check.generation === state.generation ? result : false;
    } finally {
      state.active.delete(check);
      if (state.active.size === 0) {
        for (const resolve of state.waiters) resolve();
        state.waiters.clear();
      }
    }
  };
  piSession._checkCompaction = state.wrapped;
  coordinators.set(session, state);
  return state.wrapped;
}

/** Mark every currently-running native compaction check cancelled and wait until its async auth/summary
 * path has actually unwound. The caller owns abortCompaction(); this function owns only admission fencing
 * and the lifetime that keeps the caller's compaction_start listener attached. */
export function cancelNativeCompactionChecks(session: AgentSession): Promise<void> {
  const state = coordinators.get(session);
  if (!state || state.active.size === 0) return Promise.resolve();
  state.generation += 1;
  return new Promise<void>((resolve) => state.waiters.add(resolve));
}

/** True across the full native check, including PI's auth-before-controller gap where isCompacting and
 * isStreaming are both still false. Turn admission uses this to queue, never start a concurrent prompt. */
export function hasActiveNativeCompactionCheck(session: AgentSession): boolean {
  return (coordinators.get(session)?.active.size ?? 0) > 0;
}
