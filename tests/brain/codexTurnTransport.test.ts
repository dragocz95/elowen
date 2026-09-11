import { describe, expect, it, vi } from 'vitest';
import { BrainTurnRunner } from '../../src/brain/service/turnRunner.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';
import type { SubagentUpdate } from '../../src/brain/events.js';

function runnerFor(live: Pick<LiveBrain, 'sessionId' | 'provider'>) {
  const close = vi.fn();
  const runner = new BrainTurnRunner({
    sessions: { get: (sessionId: string) => sessionId === live.sessionId ? live : undefined },
    closeCodexWebSocketSession: close,
  } as never);
  return {
    close,
    finishTurn: (sessionId: string) => (runner as unknown as { finishTurnTransport(id: string): void }).finishTurnTransport(sessionId),
    subagentUpdate: (update: SubagentUpdate) => (runner as unknown as { onSubagentUpdate(live: LiveBrain, update: SubagentUpdate): void })
      .onSubagentUpdate(live as LiveBrain, update),
  };
}

const running = (id: string, background = false): SubagentUpdate => ({
  id,
  sessionId: `child-${id}`,
  status: 'running',
  task: 'work',
  tools: 0,
  seconds: 0,
  background,
});

describe('Codex turn transport lifecycle', () => {
  it('releases the cached socket once when a Codex turn ends', () => {
    const harness = runnerFor({ sessionId: 'codex-session', provider: 'openai-codex' });

    harness.finishTurn('codex-session');

    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledWith('codex-session');
  });

  it('does not release transport for another provider', () => {
    const harness = runnerFor({ sessionId: 'anthropic-session', provider: 'anthropic' });

    harness.finishTurn('anthropic-session');

    expect(harness.close).not.toHaveBeenCalled();
  });

  it('releases once when a Codex turn parks on a foreground sub-agent', () => {
    const harness = runnerFor({ sessionId: 'codex-session', provider: 'openai-codex' });

    harness.subagentUpdate(running('one'));
    harness.subagentUpdate({ ...running('one'), tools: 2 });

    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('keeps the socket for a background sub-agent update', () => {
    const harness = runnerFor({ sessionId: 'codex-session', provider: 'openai-codex' });

    harness.subagentUpdate(running('one', true));

    expect(harness.close).not.toHaveBeenCalled();
  });
});
