import {
  calculateContextTokens,
  estimateTokens,
  type AgentSession,
  type AgentSessionEvent,
  type SessionManager,
} from '@earendil-works/pi-coding-agent';

type PiAssistantMessage = Extract<AgentSessionEvent, { type: 'message_end' }>['message'];
type PiCompactionSession = {
  /** PI 0.80 owns threshold/overflow classification and the native compaction event pipeline, but its
   * check is not yet declared as public. Keep that one version-sensitive access isolated here. */
  _checkCompaction?: (assistantMessage: PiAssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
};

function latestCompactionId(sessionManager: SessionManager): string | null {
  return sessionManager.getBranch().findLast((entry) => entry.type === 'compaction')?.id ?? null;
}

/** Install proactive compaction at PI's safe between-turn boundary.
 *
 * PI normally evaluates its threshold only after `agent_end`. A single agent run may contain many
 * assistant → tool → assistant steps, so that is too late: the next provider request can overflow even
 * though the user configured 80%. `prepareNextTurnWithContext` runs after the assistant and its whole
 * tool batch have settled, but before the next provider call. We delegate the decision and compaction to
 * PI itself, then replace only the next-turn message context with PI's compacted state. No running tool
 * is interrupted and normal overflow recovery remains owned by PI. */
export function installTurnBoundaryAutoCompaction(
  session: AgentSession,
  sessionManager: SessionManager,
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  const piSession = session as unknown as PiCompactionSession;
  const checkCompaction = piSession._checkCompaction?.bind(session);
  // Injected/custom AgentSession implementations may intentionally expose only the public surface.
  // Their ordinary end-of-run PI behavior remains intact; the production 0.80 runtime has this seam.
  if (!checkCompaction) return false;

  const previous = session.agent.prepareNextTurnWithContext;
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    const snapshot = await previous?.(turn, signal);
    if (signal?.aborted) return snapshot;

    const before = latestCompactionId(sessionManager);
    // A successful assistant usage snapshot ends BEFORE its tool results. Passing it directly makes PI
    // trust the smaller number and miss a threshold crossed by the completed tool batch. Preserve the
    // provider's authoritative context count and add PI's own conservative estimate for that exact tail.
    const assistantUsage = (turn.message as { usage?: Parameters<typeof calculateContextTokens>[0] }).usage;
    const directTokens = assistantUsage ? calculateContextTokens(assistantUsage) : 0;
    const boundaryTokens = directTokens > 0
      ? directTokens + turn.toolResults.reduce((total, message) => total + estimateTokens(message), 0)
      : 0;
    const fullBoundaryMessage = {
      ...turn.message,
      usage: {
        input: boundaryTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: boundaryTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as PiAssistantMessage;
    // AgentSession.abort() owns the Agent controller, while PI auto-compaction owns a separate controller.
    // Bridge the public Agent signal to public abortCompaction() for exactly this awaited boundary check.
    const abortCompaction = (): void => session.abortCompaction();
    signal?.addEventListener('abort', abortCompaction, { once: true });
    if (signal?.aborted) abortCompaction();
    try {
      await checkCompaction(fullBoundaryMessage);
    } finally {
      signal?.removeEventListener('abort', abortCompaction);
    }
    if (signal?.aborted) return snapshot;
    const after = latestCompactionId(sessionManager);
    if (!after || after === before) return snapshot;

    const context = snapshot?.context ?? turn.context;
    return {
      ...snapshot,
      context: { ...context, messages: session.agent.state.messages.slice() },
      model: session.agent.state.model,
      thinkingLevel: session.agent.state.thinkingLevel,
    };
  };
  return true;
}
