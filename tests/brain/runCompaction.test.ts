import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { runCompaction } from '../../src/brain/events.js';

/** The observed live sequence on a 1M-window session: one manual `/compact` summarizes and applies a
 *  summary, and a second one arrives while the first has already landed. PI raises its "Already
 *  compacted" for the second — from `prepareCompaction`, before any hook or summarization request — and
 *  the route used to relay that as "Nothing to compact yet.", which reads as though the paid compaction
 *  that had just shrunk the context never happened. */
function fakeSession(tokens: () => number, compact: () => Promise<void>): AgentSession {
  return {
    messages: [],
    getContextUsage: () => ({ tokens: tokens(), contextWindow: 1_000_000, percent: (tokens() / 1_000_000) * 100 }),
    compact,
  } as unknown as AgentSession;
}

describe('runCompaction', () => {
  it('reports a real compaction with the context it started and ended on', async () => {
    let context = 92_754;
    const session = fakeSession(() => context, async () => { context = 76_295; });

    const result = await runCompaction(session);

    expect(result.compacted).toBe(true);
    expect(result.contextBefore).toBe(92_754);
    expect(result.contextAfter).toBe(76_295);
    expect(result.usage.tokens).toBe(76_295);
  });

  it('does not tell an already-compacted session it has nothing to compact yet', async () => {
    const session = fakeSession(() => 76_295, () => Promise.reject(new Error('Already compacted')));

    const result = await runCompaction(session);

    expect(result.compacted).toBe(false);
    expect(result.message).not.toBe('Nothing to compact yet.');
    expect(result.message).toMatch(/already compacted/i);
  });

  it('still reports a genuinely too-small session as nothing to compact yet', async () => {
    const session = fakeSession(() => 120, () => Promise.reject(new Error('Nothing to compact (session too small)')));

    const result = await runCompaction(session);

    expect(result.compacted).toBe(false);
    expect(result.message).toBe('Nothing to compact yet.');
  });

  it('lets a real compaction failure propagate instead of dressing it as a no-op', async () => {
    const session = fakeSession(() => 92_754, () => Promise.reject(new Error('Compaction failed: provider 500')));

    await expect(runCompaction(session)).rejects.toThrow(/provider 500/);
  });
});
