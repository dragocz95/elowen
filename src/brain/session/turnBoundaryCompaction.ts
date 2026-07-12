import {
  calculateContextTokens,
  estimateTokens,
  type AgentSession,
  type AgentSessionEvent,
  type SessionManager,
} from '@earendil-works/pi-coding-agent';
import { coordinateNativeCompactionChecks } from './compactionCheckCoordinator.js';

type PiAssistantMessage = Extract<AgentSessionEvent, { type: 'message_end' }>['message'];
export interface PendingCompactionMessage {
  text: string;
  images?: readonly { type: 'image'; data: string; mimeType: string }[];
}

function pendingQueueTokens(
  session: AgentSession,
  pendingMessages?: () => readonly PendingCompactionMessage[],
): number {
  const pending: readonly PendingCompactionMessage[] = pendingMessages?.() ?? [
    ...(session.getSteeringMessages?.() ?? []).map((text) => ({ text })),
    ...(session.getFollowUpMessages?.() ?? []).map((text) => ({ text })),
  ];
  return pending.reduce((total, message) => total + estimateTokens({
    role: 'user',
    content: [{ type: 'text', text: message.text }, ...(message.images ?? [])],
    timestamp: Date.now(),
  }), 0);
}

/** PI's zero/error-usage fallback, kept local because estimateContextTokens is not part of the public
 * coding-agent export. Start from the newest valid provider usage and estimate only its unseen tail;
 * when no valid usage exists, conservatively estimate the whole visible message context. */
function estimatedContextTokens(
  messages: readonly Parameters<typeof estimateTokens>[0][],
  compactionTimestamp?: string,
): number {
  const compactedAt = compactionTimestamp ? new Date(compactionTimestamp).getTime() : Number.NEGATIVE_INFINITY;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || message.stopReason === 'error' || message.stopReason === 'aborted') continue;
    // A kept pre-compaction assistant still carries usage for the discarded, much larger context. PI's
    // native fallback rejects that stale source too; otherwise the first zero-usage response after a
    // compact would immediately retrigger another compact from the old number.
    if (message.timestamp <= compactedAt) continue;
    const contextTokens = message.usage ? calculateContextTokens(message.usage) : 0;
    if (contextTokens <= 0) continue;
    return contextTokens + messages.slice(index + 1).reduce((total, trailing) => total + estimateTokens(trailing), 0);
  }
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function latestCompaction(sessionManager: SessionManager) {
  return sessionManager.getBranch().findLast((entry) => entry.type === 'compaction') ?? null;
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
  pendingMessages?: () => readonly PendingCompactionMessage[],
): boolean {
  const checkCompaction = coordinateNativeCompactionChecks(session);
  // Injected/custom AgentSession implementations may intentionally expose only the public surface.
  // Their ordinary end-of-run PI behavior remains intact; the production 0.80 runtime has this seam.
  if (!checkCompaction) return false;
  // Even with proactive compaction disabled, keep native pre-prompt/overflow checks coordinated with
  // abortSessionWork. Only the extra between-tool-turn invocation below is feature-gated.
  if (!enabled) return false;

  const previous = session.agent.prepareNextTurnWithContext;
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    const snapshot = await previous?.(turn, signal);
    if (signal?.aborted) return snapshot;

    const beforeEntry = latestCompaction(sessionManager);
    const before = beforeEntry?.id ?? null;
    // A successful assistant usage snapshot ends BEFORE its tool results. Passing it directly makes PI
    // trust the smaller number and miss a threshold crossed by the completed tool batch. Preserve the
    // provider's authoritative context count and add PI's own conservative estimate for that exact tail.
    const assistantUsage = (turn.message as { usage?: Parameters<typeof calculateContextTokens>[0] }).usage;
    const directTokens = assistantUsage ? calculateContextTokens(assistantUsage) : 0;
    const queuedTokens = pendingQueueTokens(session, pendingMessages);
    const boundaryTokens = directTokens > 0
      ? directTokens
        + turn.toolResults.reduce((total, message) => total + estimateTokens(message), 0)
        + queuedTokens
      : estimatedContextTokens(turn.context.messages, beforeEntry?.timestamp) + queuedTokens;
    const fullBoundaryMessage = {
      ...turn.message,
      usage: {
        input: boundaryTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: boundaryTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as PiAssistantMessage;
    // AgentSession.abort() owns the Agent controller, while PI auto-compaction owns a separate controller.
    // Bridge the public Agent signal to public abortCompaction() for exactly this awaited boundary check.
    let aborted = signal?.aborted === true;
    const abortCompaction = (): void => {
      aborted = true;
      session.abortCompaction();
    };
    // PI emits compaction_start immediately BEFORE it constructs the auto-compaction AbortController.
    // If the Agent signal fired during the preceding async auth lookup, the first abortCompaction() was
    // necessarily a no-op. Replay it in a microtask: PI has installed its controller by then, but has not
    // started the summary request yet. This is event-driven and scoped to this one boundary check.
    const unsubscribe = session.subscribe?.((event) => {
      if ((event as { type?: string }).type !== 'compaction_start' || !aborted) return;
      queueMicrotask(() => session.abortCompaction());
    }) ?? (() => undefined);
    signal?.addEventListener('abort', abortCompaction, { once: true });
    if (signal?.aborted) abortCompaction();
    try {
      await checkCompaction(fullBoundaryMessage);
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', abortCompaction);
    }
    if (signal?.aborted) return snapshot;
    const after = latestCompaction(sessionManager)?.id ?? null;
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
