import { describe, expect, it, vi } from 'vitest';
import { abortSessionWork } from '../../src/brain/session/abortSessionWork.js';
import { installTurnBoundaryAutoCompaction } from '../../src/brain/session/turnBoundaryCompaction.js';

describe('abortSessionWork', () => {
  it('replays an abort when native overflow compaction creates its controller after async auth', async () => {
    const listeners = new Set<(event: { type: string }) => void>();
    let controllerReady = false;
    let lateControllerAborted = false;
    const session = {
      subscribe: vi.fn((listener: (event: { type: string }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      abortCompaction: vi.fn(() => {
        if (controllerReady) lateControllerAborted = true;
      }),
      abortBranchSummary: vi.fn(),
      abort: vi.fn(async () => {
        // Mirrors PI _runAutoCompaction after its awaited auth lookup: compaction_start is emitted
        // synchronously, then the controller is assigned before the next microtask.
        for (const listener of listeners) listener({ type: 'compaction_start' });
        controllerReady = true;
        await Promise.resolve();
      }),
    };

    await abortSessionWork(session as never);

    expect(lateControllerAborted).toBe(true);
    expect(session.abortCompaction).toHaveBeenCalledTimes(2);
    expect(session.abortBranchSummary).toHaveBeenCalledOnce();
    expect(listeners).toHaveLength(0);
  });

  it('keeps the abort latch alive until a pre-prompt compaction check settles', async () => {
    const listeners = new Set<(event: { type: string }) => void>();
    let releaseAuth!: () => void;
    const auth = new Promise<void>((resolve) => { releaseAuth = resolve; });
    let controllerReady = false;
    let providerStarted = false;
    const session = {
      _checkCompaction: vi.fn(async () => {
        await auth;
        for (const listener of listeners) listener({ type: 'compaction_start' });
        controllerReady = true;
        await Promise.resolve();
        return false;
      }),
      subscribe: vi.fn((listener: (event: { type: string }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      abortCompaction: vi.fn(),
      abortBranchSummary: vi.fn(),
      // PI reports idle here because pre-prompt _checkCompaction runs before _runAgentPrompt marks the
      // AgentSession active. The coordinator, not abort(), must keep teardown attached to the check.
      abort: vi.fn(async () => undefined),
      agent: { state: { messages: [], model: {}, thinkingLevel: 'high' } },
    };
    installTurnBoundaryAutoCompaction(session as never, { getBranch: () => [] } as never, false);

    const prompt = (async () => {
      await session._checkCompaction({ role: 'assistant' } as never, false);
      providerStarted = true;
    })();
    await Promise.resolve();
    const abort = abortSessionWork(session as never);
    await Promise.resolve();
    releaseAuth();

    await expect(prompt).rejects.toThrow('session work aborted');
    await abort;
    expect(providerStarted).toBe(false);
    expect(controllerReady).toBe(true);
    expect(session.abortCompaction).toHaveBeenCalledTimes(2);
    expect(listeners).toHaveLength(0);
  });
});
