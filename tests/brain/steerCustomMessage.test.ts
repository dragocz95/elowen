import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { steerCustomMessage } from '../../src/brain/session/steerCustomMessage.js';

/** Delivery of a hidden custom message INTO a turn that is already streaming — how a sub-agent result
 *  reaches a parent that is still working, and how the owner redirects a running child.
 *
 *  This is pinned against PI's own source because the failure is silent on both sides: the call that used
 *  to do it still exists and still resolves, it just stops delivering, and every unit test around it keeps
 *  passing because the message IS recorded — only the running turn never sees it. */

const distFile = (...candidates: string[]) => {
  for (const rel of candidates) {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error(`none of the PI dist candidates exist: ${candidates.join(', ')}`);
};

describe('steering a custom message into a running turn', () => {
  it('enqueues on the agent steering queue, in the shape PI ingests', () => {
    const steer = vi.fn();
    const session = { agent: { steer }, sendCustomMessage: vi.fn() } as unknown as AgentSession;

    steerCustomMessage(session, {
      customType: 'subagent_result',
      content: 'child finished',
      display: false,
      details: { source: 'elowen', resultId: 'r-1' },
    });

    // The steering queue is the ONLY channel the agent loop injects from mid-turn, so anything that
    // "sends" instead of enqueuing is delivery that silently never happens.
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]?.[0]).toMatchObject({
      role: 'custom',
      customType: 'subagent_result',
      content: 'child finished',
      display: false,
      details: { source: 'elowen', resultId: 'r-1' },
    });
    expect(typeof (steer.mock.calls[0]?.[0] as { timestamp?: unknown }).timestamp).toBe('number');
  });

  it('normalizes missing content the way PI does, so an untyped caller cannot enqueue a null body', () => {
    const steer = vi.fn();
    const session = { agent: { steer } } as unknown as AgentSession;
    steerCustomMessage(session, { customType: 'note', content: undefined });
    expect((steer.mock.calls[0]?.[0] as { content?: unknown }).content).toEqual([]);
  });

  it('pins the two PI facts this helper exists for (source pin against a PI upgrade)', () => {
    // (1) `triggerTurn: false` no longer reaches the steering branch. Before PI 0.84.2 the streaming test
    // stood alone, so the flag meant "never start a turn" while a live turn still got the message; the
    // added condition is what turned that call into a recording. If a future PI drops it again, this
    // fails — and the helper can go back to being a plain sendCustomMessage.
    const session = distFile('../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js');
    expect(session).toContain('this.isStreaming && options?.triggerTurn !== false');

    // (2) mid-turn work is injected from the steering queue and nowhere else — the reason a message merely
    // pushed onto agent state is invisible to the turn that is running.
    const loop = distFile(
      '../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js',
      '../../node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js',
    );
    expect(loop).toContain('await config.getSteeringMessages?.()');
  });
});
