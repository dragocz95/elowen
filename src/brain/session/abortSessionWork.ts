import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { cancelNativeCompactionChecks } from './compactionCheckCoordinator.js';

/** Cancel every PI controller owned by one session, then wait for its agent loop to settle. PI keeps
 * compaction/branch-summary controllers separate from Agent.abort(), so calling abort() alone can leave
 * `/stop`, disposal, or a worker shutdown waiting on an in-flight summary request. Optional calls keep
 * injected test/custom AgentSession implementations compatible with the public minimum surface. */
export async function abortSessionWork(session: AgentSession): Promise<void> {
  const extended = session as AgentSession & {
    abortCompaction?: () => void;
    abortBranchSummary?: () => void;
  };
  // Native threshold/overflow compaction awaits auth BEFORE constructing its AbortController. A stop
  // requested in that gap makes the immediate abortCompaction() a no-op. PI then synchronously emits
  // compaction_start immediately before assigning the controller, so replay once in the following
  // microtask. Keep this session-level: overflow/pre-prompt compaction does not pass through Elowen's
  // turn-boundary adapter, but every production teardown does pass through this function.
  const unsubscribe = session.subscribe?.((event) => {
    if ((event as { type?: string }).type !== 'compaction_start') return;
    queueMicrotask(() => extended.abortCompaction?.());
  }) ?? (() => undefined);
  try {
    // Must be created before session.abort(): a pre-prompt check runs while PI still reports idle, so
    // abort() can resolve immediately even though the auth/compaction Promise is still in flight.
    const checksSettled = cancelNativeCompactionChecks(session);
    extended.abortCompaction?.();
    extended.abortBranchSummary?.();
    await Promise.all([session.abort(), checksSettled]);
  } finally {
    unsubscribe();
  }
}
