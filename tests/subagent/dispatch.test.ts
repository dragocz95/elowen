import { describe, it, expect } from 'vitest';
import { SubagentDispatch, predictsRunnerDispatch } from '../../src/subagent/dispatch.js';
import { SubagentRunnerUnavailable, type DelegatedTurnRequest, type DelegatedTurnRunner } from '../../src/brain/delegatedTurn.js';

const request: DelegatedTurnRequest = {
  channelId: 'subagent-sub-dlg-1',
  ownerUserId: 1,
  parentSessionId: 'brain-1',
  delegatedAccess: { admin: false, projectIds: [3], owner: true, permissionBoundary: null },
  scheduled: false,
};

/** A runner stub. `run` records what it was handed; the rest are the verbs the dispatcher never calls. */
function fakeRunner(run: DelegatedTurnRunner['run']): DelegatedTurnRunner & { calls: number } {
  const runner = {
    calls: 0,
    run: (async (...args: Parameters<DelegatedTurnRunner['run']>) => { runner.calls += 1; return run(...args); }) as DelegatedTurnRunner['run'],
    abort: () => {},
    release: async () => ({ busy: false }),
    reset: () => {},
  };
  return runner;
}

/** The daemon-side fencing around a remote turn, stubbed to a pass-through so these tests observe ONLY
 *  the routing decision (the real fencing is ChannelSessionService.sendRemote, covered separately). */
const passThrough = (_req: DelegatedTurnRequest, run: () => Promise<string>): Promise<string> => run();

describe('SubagentDispatch — where a delegated turn executes', () => {
  it('runs in-process when no runner exists at all (the runner process itself, and every test wiring)', async () => {
    const local: string[] = [];
    const d = new SubagentDispatch({
      runTurn: async (_r, text) => { local.push(text); return 'local'; },
      fenceRemote: passThrough,
      runnerEnabled: () => true, // even with the switch ON: no runner ⇒ nothing to hand it to
    });
    expect(d.mode()).toBe('in-process');
    expect(await d.send(request, 'do it')).toBe('local');
    expect(local).toEqual(['do it']);
  });

  it('runs in-process while the operator switch is OFF, and never consults the runner', async () => {
    const runner = fakeRunner(async () => 'remote');
    const d = new SubagentDispatch({
      runTurn: async () => 'local',
      fenceRemote: passThrough,
      runner,
      runnerEnabled: () => false,
    });
    expect(d.mode()).toBe('in-process');
    expect(await d.send(request, 'do it')).toBe('local');
    expect(runner.calls).toBe(0);
  });

  it('defaults to in-process when the switch resolver is absent', async () => {
    const runner = fakeRunner(async () => 'remote');
    const d = new SubagentDispatch({ runTurn: async () => 'local', fenceRemote: passThrough, runner });
    expect(d.mode()).toBe('in-process');
    expect(await d.send(request, 'do it')).toBe('local');
  });

  it('holds the in-process turn under the same fence: the call stays a live claim through its settlement', async () => {
    // runDelegatedTurn settles the reply against the child's own delegations AFTER ChannelSessionService.send
    // released the turn's edge; the fence here is what keeps the call open (and stoppable) for that wait.
    const fenced: string[] = [];
    const d = new SubagentDispatch({
      runTurn: async () => 'local',
      fenceRemote: (req, run) => { fenced.push(req.channelId); return run(); },
    });
    expect(d.mode()).toBe('in-process');
    expect(await d.send(request, 'do it')).toBe('local');
    expect(fenced).toEqual(['subagent-sub-dlg-1']);
  });

  it('forwards to the runner while the switch is ON, through the daemon-side fence', async () => {
    const fenced: string[] = [];
    const runner = fakeRunner(async (_req, text) => `remote:${text}`);
    const d = new SubagentDispatch({
      runTurn: async () => 'local',
      fenceRemote: (req, run) => { fenced.push(req.channelId); return run(); },
      runner,
      runnerEnabled: () => true,
    });
    expect(d.mode()).toBe('runner');
    expect(await d.send(request, 'do it')).toBe('remote:do it');
    expect(fenced).toEqual(['subagent-sub-dlg-1']); // the parent/child edge is still registered HERE
  });

  // The switch is the operator's rollback: it must not need a restart to take effect.
  it('reads the switch live, per turn', async () => {
    let on = false;
    const runner = fakeRunner(async () => 'remote');
    const d = new SubagentDispatch({
      runTurn: async () => 'local', fenceRemote: passThrough, runner, runnerEnabled: () => on,
    });
    expect(await d.send(request, 'a')).toBe('local');
    on = true;
    expect(await d.send(request, 'b')).toBe('remote');
    on = false;
    expect(await d.send(request, 'c')).toBe('local');
    expect(runner.calls).toBe(1);
  });

  // A pool the operator has sized to zero is not a runner that might work — it IS the in-process path.
  // Saying so here is what keeps that config from logging a fallback warning once per delegated turn.
  it('reports in-process when the runner says it cannot take work at all', async () => {
    const runner = { ...fakeRunner(async () => 'remote'), usable: () => false };
    const d = new SubagentDispatch({
      runTurn: async () => 'local', fenceRemote: passThrough, runner, runnerEnabled: () => true,
    });
    expect(d.mode()).toBe('in-process');
    expect(await d.send(request, 'do it')).toBe('local');
    expect(runner.calls).toBe(0);
  });

  it('still routes to a runner that does not implement the usability check', async () => {
    const runner = fakeRunner(async () => 'remote');
    const d = new SubagentDispatch({
      runTurn: async () => 'local', fenceRemote: passThrough, runner, runnerEnabled: () => true,
    });
    expect(d.mode()).toBe('runner');
    expect(await d.send(request, 'do it')).toBe('remote');
  });

  it('relays the child progress stream to the delegating turn', async () => {
    const seen: string[] = [];
    const runner = fakeRunner(async (_req, _text, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-sub-dlg-1' });
      onEvent?.({ type: 'tool', name: 'Bash' });
      return 'remote';
    });
    const d = new SubagentDispatch({
      runTurn: async () => 'local', fenceRemote: passThrough, runner, runnerEnabled: () => true,
    });
    await d.send(request, 'do it', (e) => seen.push(e.type));
    expect(seen).toEqual(['session', 'tool']);
  });

  it('falls back to in-process when the runner cannot be STARTED — nothing ran anywhere yet', async () => {
    const runner = fakeRunner(async () => { throw new SubagentRunnerUnavailable('fork failed'); });
    const handed: DelegatedTurnRequest[] = [];
    const d = new SubagentDispatch({
      runTurn: async (req) => { handed.push(req); return 'local'; },
      fenceRemote: passThrough, runner, runnerEnabled: () => true,
    });
    expect(await d.send(request, 'do it')).toBe('local');
    // The fallback executes the SAME request, delegated access included: a workflow node predicted
    // remote carries its WorkflowAddNodes deny inside that access, so the capability contract survives
    // the degradation instead of silently widening in-process.
    expect(handed).toEqual([request]);
    expect(handed[0]).toBe(request);
  });

  // The plugin wiring (ctx.delegatedTurnsOutOfProcess in brainCore) and this dispatcher share ONE
  // predicate, so the prediction a plugin bakes into a child's briefing/tool policy and the routing
  // decision here cannot drift. This pins that the two answers agree over the whole input matrix.
  describe('predictsRunnerDispatch — the shared prediction', () => {
    const cases: { runner: DelegatedTurnRunner | undefined; enabled: boolean; expected: boolean }[] = [
      { runner: undefined, enabled: true, expected: false },
      { runner: fakeRunner(async () => 'remote'), enabled: false, expected: false },
      { runner: fakeRunner(async () => 'remote'), enabled: true, expected: true },
      { runner: { ...fakeRunner(async () => 'remote'), usable: () => false }, enabled: true, expected: false },
      { runner: { ...fakeRunner(async () => 'remote'), usable: () => true }, enabled: true, expected: true },
    ];

    it('answers the routing matrix', () => {
      for (const c of cases) expect(predictsRunnerDispatch(c.runner, c.enabled)).toBe(c.expected);
    });

    it('agrees with mode() on every combination — the drift the prediction API existed to prevent', () => {
      for (const c of cases) {
        const d = new SubagentDispatch({
          runTurn: async () => 'local', fenceRemote: passThrough,
          ...(c.runner ? { runner: c.runner } : {}), runnerEnabled: () => c.enabled,
        });
        expect(d.mode()).toBe(predictsRunnerDispatch(c.runner, c.enabled) ? 'runner' : 'in-process');
      }
    });
  });

  it('does NOT retry a turn that failed inside a healthy runner — that would duplicate its side effects', async () => {
    let localRuns = 0;
    const runner = fakeRunner(async () => { throw new Error('the sub-agent runner exited — this delegated turn was interrupted'); });
    const d = new SubagentDispatch({
      runTurn: async () => { localRuns += 1; return 'local'; },
      fenceRemote: passThrough, runner, runnerEnabled: () => true,
    });
    await expect(d.send(request, 'do it')).rejects.toThrow('interrupted');
    expect(localRuns).toBe(0);
  });

  it('propagates an abort refused by the daemon-side fence without touching the runner', async () => {
    const runner = fakeRunner(async () => 'remote');
    const d = new SubagentDispatch({
      runTurn: async () => 'local',
      fenceRemote: () => Promise.reject(new Error('delegation aborted')),
      runner,
      runnerEnabled: () => true,
    });
    await expect(d.send(request, 'do it')).rejects.toThrow('delegation aborted');
    expect(runner.calls).toBe(0);
  });
});
