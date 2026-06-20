import { describe, it, expect, vi } from 'vitest';
import { overseerPrompt, makeOverseer } from '../../src/overseer/overseerAgent.js';
import { DecisionQueue } from '../../src/overseer/decisionQueue.js';

describe('overseerPrompt', () => {
  it('tells the agent to loop poll → decide', () => {
    const p = overseerPrompt('m1');
    expect(p).toContain('orca overseer poll');
    expect(p).toContain('orca overseer decide');
  });
});

describe('makeOverseer', () => {
  const cfg = (overseerExec: string) => ({ get: () => ({ autopilot: { overseerExec } }) }) as never;

  it('start() spawns a parked agent named overseer-<id> with ORCA_MISSION', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'orca-overseer-m1' });
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn() } as never, config: cfg('opencode:deepseek/deepseek-v4-flash'), queue: new DecisionQueue() });
    await ctl.start('m1', 1, '/repo');
    const arg = launch.mock.calls[0]![0];
    expect(arg.agentName).toBe('overseer-m1');
    expect(arg.extraEnv).toEqual({ ORCA_MISSION: 'm1' });
    expect(arg.spec).toEqual({ program: 'opencode', model: 'deepseek/deepseek-v4-flash' });
    expect(arg.rawPrompt).toContain('orca overseer poll');
  });

  it('start() is a no-op when overseerExec is empty (relay fallback)', async () => {
    const launch = vi.fn();
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn() } as never, config: cfg(''), queue: new DecisionQueue() });
    await ctl.start('m2', 1, '/repo');
    expect(launch).not.toHaveBeenCalled();
  });

  it('stop() kills the session and drains the queue', async () => {
    const kill = vi.fn().mockResolvedValue(undefined);
    const queue = new DecisionQueue();
    const drain = vi.spyOn(queue, 'drain');
    const ctl = makeOverseer({ spawn: { launch: vi.fn().mockResolvedValue({ session: 'x' }) } as never, tmux: { kill } as never, config: cfg('claude:opus'), queue });
    await ctl.start('m3', 1, '/repo');
    await ctl.stop('m3');
    expect(kill).toHaveBeenCalledWith('orca-overseer-m3');
    expect(drain).toHaveBeenCalledWith('m3');
  });
});
