import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { BrainStore } from '../../store/brainStore.js';
import { isProvablyFinalAssistant } from '../persistence.js';

/** Continue an interrupted turn from the transcript's current tail WITHOUT adding a message.
 *
 *  The resume after a pause-for-restart is a continuation, not a new prompt: the checkpointed transcript
 *  ends on the answers to the tool calls the restart cut off (the synthetic `[interrupted]` results the
 *  boot wrote, see persistence.ts settlePartialTurn), and what the model owes is simply its next step.
 *  Any injected "the daemon restarted…" message was a second voice in the conversation — a user-shaped
 *  entry the model had to acknowledge, and one more row in the cached prefix of every later turn.
 *
 *  PI's native mechanism for exactly this is the agent loop started with an EMPTY prompt batch
 *  (pi-agent-core agent-loop.js `runAgentLoop(prompts = [])`: no message is appended or emitted and
 *  `runLoop` proceeds straight to the next assistant response over the context as it stands). PI's own
 *  auto-retry rides the same path (`Agent.continue()` → `runAgentLoopContinue`). The session-level entry
 *  that wraps a run with the full lifecycle — `_isAgentRunActive`/isStreaming, retry, agent_settled —
 *  is `AgentSession._runAgentPrompt(messages)` (pi-coding-agent agent-session.js; sendCustomMessage with
 *  triggerTurn is its only other caller). It is not on the public type surface, so it is reached through
 *  the same guarded probe this codebase already uses for `_checkCompaction`: absent seam → a loud
 *  failure, never a silent no-op.
 *
 *  Precondition, PI's own: the last message must be a user or tool-result message. A trailing assistant
 *  that is NOT provably final (a provider error, an abort, a length cut — what a failed earlier resume
 *  or the pause itself leaves) is the fragment of a response the model produces again: it is removed
 *  from PI's state AND from the durable transcript (the one row a resume may rewrite; PI's own retry
 *  does the same to its state before `agent.continue()`), so the continuation starts from the message
 *  before it. A trailing assistant that IS provably final means the turn had finished: `nothing`. */
export async function continueInterruptedTurn(
  session: AgentSession,
  durable?: { store: BrainStore; sessionId: string },
): Promise<'continued' | 'nothing'> {
  const seam = session as unknown as {
    _runAgentPrompt?: (messages: unknown[]) => Promise<void>;
    messages: { role?: string }[];
    agent?: { state?: { messages: { role?: string }[] } };
  };
  if (typeof seam._runAgentPrompt !== 'function') {
    throw new Error('PI runtime does not expose the turn continuation seam (_runAgentPrompt)');
  }
  const tail = seam.messages.at(-1);
  if (!tail) return 'nothing';
  if (tail.role === 'assistant') {
    if (isFinalAssistantMessage(tail)) return 'nothing';
    trimUnfinishedTail(seam, durable);
    if (!continuable(seam.messages)) return 'nothing';
  }
  await seam._runAgentPrompt([]);
  return 'continued';
}

/** Whether a transcript tail can be continued at all (see {@link continueInterruptedTurn}). */
export function continuable(messages: readonly { role?: string }[]): boolean {
  const last = messages.at(-1);
  return !!last && last.role !== 'assistant';
}

/** The in-memory twin of persistence.ts isProvablyFinalAssistant: stopReason stop and usage counts. */
function isFinalAssistantMessage(message: { role?: string }): boolean {
  return isProvablyFinalAssistant(JSON.stringify(message));
}

/** Drop the unfinished trailing assistant from PI's state (through the agent state setter PI's own
 *  retry uses) and from the durable transcript, so neither the next model call nor the next boot sees it. */
function trimUnfinishedTail(
  seam: { messages: { role?: string }[]; agent?: { state?: { messages: { role?: string }[] } } },
  durable?: { store: BrainStore; sessionId: string },
): void {
  if (seam.agent?.state) seam.agent.state.messages = seam.messages.slice(0, -1);
  else seam.messages.splice(-1, 1);
  if (!durable) return;
  const last = durable.store.getMessages(durable.sessionId).at(-1);
  if (last && last.role === 'assistant' && !isProvablyFinalAssistant(last.content)) {
    durable.store.deleteMessage(durable.sessionId, last.id);
  }
}
