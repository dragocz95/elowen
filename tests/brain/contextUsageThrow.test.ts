import { describe, it, expect } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { sessionUsageSnapshot } from '../../src/brain/events.js';

/** PI throws out of `getContextUsage()` on a message shape it produces itself, and it took a whole turn
 *  down with it: the daemon logged `accepted turn failed — TypeError: Cannot read properties of
 *  undefined (reading 'totalTokens')` and the user got an error instead of an answer.
 *
 *  Once a session carries a compaction entry, PI scans back for an assistant that answered after it and
 *  calls `calculateContextTokens(assistant.usage)` with no guard, while its own sibling helper
 *  (`getAssistantUsage`) checks the field first. An assistant that stops on `toolUse` has no `usage` —
 *  the totals land on the turn's final message — so a compacted session throws as soon as it calls a
 *  tool. That was 61 of 69 compacted sessions in the live database.
 *
 *  The context figure is a statusline number. Losing an answer over it is the worse failure. */
describe('a session whose context usage cannot be computed', () => {
  const store = { descendantUsage: () => ({ totalTokens: 0, cost: 0 }) };

  const sessionThatThrows = (): AgentSession => ({
    getContextUsage: () => { throw new TypeError("Cannot read properties of undefined (reading 'totalTokens')"); },
    messages: [
      { usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.5 } }, durationMs: 1000 },
      // The message that triggers it upstream: a tool call carries no usage at all.
      { stopReason: 'toolUse' },
    ],
  } as unknown as AgentSession);

  // Mutation: drop the try/catch in `contextUsageOf` and this throws instead of returning a snapshot.
  it('still reports the turn instead of failing it', () => {
    const usage = sessionUsageSnapshot(sessionThatThrows(), store, 'brain-1');

    expect(usage.tokens).toBeNull();
    expect(usage.percent).toBeNull();
    expect(usage.contextWindow).toBe(0);
  });

  // The per-message totals are counted by this function itself and never touch the throwing call, so a
  // failure to size the context window must not cost the spend figures the status line also carries.
  it('keeps the token and cost totals it computed itself', () => {
    const usage = sessionUsageSnapshot(sessionThatThrows(), store, 'brain-1');

    expect(usage.totalTokens).toBe(15);
    expect(usage.cost).toBe(0.5);
    expect(usage.input).toBe(10);
    expect(usage.output).toBe(5);
  });
});
