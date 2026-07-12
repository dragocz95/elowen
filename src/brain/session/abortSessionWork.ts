import type { AgentSession } from '@earendil-works/pi-coding-agent';

/** Cancel every PI controller owned by one session, then wait for its agent loop to settle. PI keeps
 * compaction/branch-summary controllers separate from Agent.abort(), so calling abort() alone can leave
 * `/stop`, disposal, or a worker shutdown waiting on an in-flight summary request. Optional calls keep
 * injected test/custom AgentSession implementations compatible with the public minimum surface. */
export async function abortSessionWork(session: AgentSession): Promise<void> {
  const extended = session as AgentSession & {
    abortCompaction?: () => void;
    abortBranchSummary?: () => void;
  };
  extended.abortCompaction?.();
  extended.abortBranchSummary?.();
  await session.abort();
}
