import type { AgentSession } from '@earendil-works/pi-coding-agent';

/** The custom message PI's own `sendCustomMessage` accepts (agent-session.js:1063-1077). */
export type CustomMessageInput = {
  customType: string;
  content: unknown;
  display?: boolean;
  details?: Record<string, unknown>;
};

/** Steer a HIDDEN custom message — a delegation result, an owner instruction — into a turn that is already
 *  streaming, without ever starting a second one.
 *
 *  Until PI 0.84.2 that was exactly `sendCustomMessage(msg, { triggerTurn: false, deliverAs: 'steer' })`:
 *  the flag meant "never run a turn", while a streaming agent still received the message on its steering
 *  queue. 0.84.2 moved that streaming branch behind `triggerTurn !== false` (agent-session.js:1081), so
 *  with the flag off the message is now merely recorded in agent state — and the running loop never reads
 *  state: it injects mid-turn work solely from the steering queue (pi-agent-core agent-loop.js:83,160). A
 *  result landing mid-turn would sit unseen until something else happened to start a turn.
 *
 *  Neither public option restores the pairing. `triggerTurn: true` runs a whole turn through
 *  `_runAgentPrompt` when the turn ends between the caller's `isStreaming` read and this call — outside the
 *  lock that serializes prompts on the session, which is the one outcome these paths must not produce —
 *  and `deliverAs: 'nextTurn'` gives up the mid-turn delivery that is the entire point. So enqueue on the
 *  agent's own queue, the exact call PI used to make: a live turn folds the message in after its current
 *  tool round, and a turn that already ended leaves it waiting for the next turn's start rather than
 *  forcing one. Persistence is unchanged either way — the message is recorded when the loop ingests it,
 *  exactly as before, which is why callers still fence delivery on their own `resultInContext` checks. */
export function steerCustomMessage(session: AgentSession, message: CustomMessageInput): void {
  const { agent } = session as unknown as { agent: { steer(message: unknown): void } };
  agent.steer({
    role: 'custom',
    customType: message.customType,
    // Untyped callers can pass null/missing content; normalize exactly as PI's ingestion does.
    content: message.content ?? [],
    display: message.display,
    details: message.details,
    timestamp: Date.now(),
  });
}
