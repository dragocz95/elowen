import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { isContextOverflow, type AssistantMessage } from '@earendil-works/pi-ai';
import { localResidentContextTokens } from '../contextBreakdown.js';

type PiAssistantMessage = AssistantMessage;
type CheckCompaction = (assistantMessage: PiAssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
type PiCompactionSession = { _checkCompaction?: CheckCompaction };
const RESIDENT_CONTEXT_TOKENS = Symbol('residentContextTokens');
type ResidentContextMessage = PiAssistantMessage & { [RESIDENT_CONTEXT_TOKENS]?: number };

/** Carry a boundary-specific local estimate through the coordinator without mutating or persisting the
 * provider's billing usage. */
export function withResidentContextTokens(message: PiAssistantMessage, tokens: number): PiAssistantMessage {
  return { ...message, [RESIDENT_CONTEXT_TOKENS]: tokens } as ResidentContextMessage;
}

function compactionUsage(message: PiAssistantMessage, tokens: number) {
  const usage = message.usage ?? {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const output = usage.output;
  return {
    ...usage,
    // PI's silent-overflow path reads input + cacheRead, while threshold accounting reads totalTokens.
    // Give both the same resident-context truth and preserve output for recoverable-length classification.
    input: Math.max(0, tokens - output),
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: tokens,
  };
}

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
        const explicit = (assistantMessage as ResidentContextMessage)[RESIDENT_CONTEXT_TOKENS];
        const residentTokens = explicit ?? localResidentContextTokens(session);
        let checkedMessage = residentTokens === undefined
          ? assistantMessage
          : { ...assistantMessage, usage: compactionUsage(assistantMessage, residentTokens) } as PiAssistantMessage;
        // PI deliberately ignores direct usage on ordinary errors and falls back to an older assistant.
        // On cumulative-usage sessions that fallback is the exact stale number we must not reuse. Preserve
        // genuine overflow recovery, but classify a non-overflow error as a threshold check over the local
        // resident count. This clone exists only for PI's check; the provider message stays untouched.
        if (residentTokens !== undefined && checkedMessage.stopReason === 'error') {
          const contextWindow = session.model?.contextWindow ?? 0;
          if (!isContextOverflow(checkedMessage, contextWindow)) {
            checkedMessage = { ...checkedMessage, stopReason: 'stop' } as PiAssistantMessage;
          }
        }
        result = await original(checkedMessage, skipAbortedCheck);
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
