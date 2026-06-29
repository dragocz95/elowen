import { describe, it, expect, vi } from 'vitest';
import { overseerPrompt, makeOverseer } from '../../src/overseer/overseerAgent.js';
import { DecisionQueue } from '../../src/overseer/decisionQueue.js';

describe('overseerPrompt', () => {
  it('tells the agent to loop poll → decide', () => {
    const p = overseerPrompt('m1');
    expect(p).toContain('orca overseer poll');
    expect(p).toContain('orca overseer decide');
  });
  it('uses the provided cli invocation verbatim (e.g. node <path> in a checkout)', () => {
    const p = overseerPrompt('m1', 'node /d/cli/index.js');
    expect(p).toContain('node /d/cli/index.js overseer poll');
    expect(p).toContain('node /d/cli/index.js overseer decide');
    expect(p).not.toMatch(/`orca overseer poll`/); // not the bare default when an explicit cli is given
  });
  it('explains each decision kind so the overseer judges them differently (O19)', () => {
    const p = overseerPrompt('m1');
    expect(p).toContain('"task"');
    expect(p).toContain('"prompt"');
    expect(p).toContain('"review"');
    expect(p.toLowerCase()).toContain('blocks its dependents'); // review semantics spelled out
  });
  it('tells the agent it may exit cleanly so a crash/full-context overseer is restartable (O20)', () => {
    expect(overseerPrompt('m1').toLowerCase()).toContain('exit cleanly');
  });
  it('injects the code-review criteria template into the review handling', () => {
    const p = overseerPrompt('m1');
    expect(p).not.toContain('{{codeReview}}'); // placeholder was substituted, not left raw
    expect(p.toLowerCase()).toContain('code-review criteria'); // the injected section is present
    expect(p.toLowerCase()).toContain('scope'); // a distinctive focus area from code-review.md
  });
  it('renders the code-review template via the same per-user renderer it is given', () => {
    // overseerPrompt asks its renderer for BOTH 'overseer' and 'code-review' — a custom renderer
    // (the per-user override path) must be consulted for the criteria too, not just the loop prompt.
    const renderPrompt = vi.fn((name: string, vars: Record<string, string>) => name === 'code-review' ? 'CR-CRITERIA' : `loop: ${vars.codeReview}`);
    const p = overseerPrompt('m1', 'orca', renderPrompt);
    expect(renderPrompt).toHaveBeenCalledWith('code-review', {});
    expect(p).toContain('CR-CRITERIA');
  });
});

describe('makeOverseer', () => {
  const cfg = (overseerExec: string) => ({ get: () => ({ autopilot: { overseerExec } }) }) as never;

  it('start() spawns a parked agent named overseer-<id> with ORCA_MISSION', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'orca-overseer-m1' });
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never, config: cfg('opencode:deepseek/deepseek-v4-flash'), queue: new DecisionQueue(), cli: 'node /d/cli/index.js' });
    await ctl.start('m1', 1, '/repo');
    const arg = launch.mock.calls[0]![0];
    expect(arg.agentName).toBe('overseer-m1');
    expect(arg.extraEnv).toEqual({ ORCA_MISSION: 'm1' });
    expect(arg.spec).toEqual({ program: 'opencode', model: 'deepseek/deepseek-v4-flash' });
    expect(arg.rawPrompt).toContain('node /d/cli/index.js overseer poll'); // daemon CLI by absolute path
  });

  it('start() is idempotent — never double-spawns when the overseer is already parked', async () => {
    // engage and resume both call start() unconditionally, and the overseer can already be parked from
    // a prior engage. Without the in-park guard, `tmux new-session` throws "duplicate session" and
    // crashes the caller (the route handler), which is exactly what livelocked the mission.
    const launch = vi.fn().mockResolvedValue({ session: 'orca-overseer-m1' });
    const list = vi.fn().mockResolvedValue(['orca-overseer-m1']); // already parked
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list } as never, config: cfg('opencode:deepseek/deepseek-v4-flash'), queue: new DecisionQueue() });
    await ctl.start('m1', 1, '/repo');
    expect(launch).not.toHaveBeenCalled();
  });

  it('start() is a no-op when overseerExec is empty (relay fallback)', async () => {
    const launch = vi.fn();
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never, config: cfg(''), queue: new DecisionQueue() });
    await ctl.start('m2', 1, '/repo');
    expect(launch).not.toHaveBeenCalled();
  });

  it('ensure() re-parks the agent when its session has died', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'orca-overseer-m1' });
    const list = vi.fn().mockResolvedValue([]); // session gone
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list } as never, config: cfg('opencode:deepseek/deepseek-v4-flash'), queue: new DecisionQueue(), cli: 'node /d/cli/index.js' });
    await ctl.ensure('m1', 1, '/repo');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0].agentName).toBe('overseer-m1');
  });

  it('ensure() does not double-spawn when the overseer is already parked', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'orca-overseer-m1' });
    const list = vi.fn().mockResolvedValue(['orca-overseer-m1', 'orca-AgentX']); // still alive
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list } as never, config: cfg('opencode:deepseek/deepseek-v4-flash'), queue: new DecisionQueue() });
    await ctl.ensure('m1', 1, '/repo');
    expect(launch).not.toHaveBeenCalled();
  });

  it('ensure() is inert when overseerExec is empty (relay fallback)', async () => {
    const launch = vi.fn();
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never, config: cfg(''), queue: new DecisionQueue() });
    await ctl.ensure('m4', 1, '/repo');
    expect(launch).not.toHaveBeenCalled();
  });

  it('start() parks the overseer INSIDE the mission worktree so its read-only git sees the agent diff', async () => {
    // The overseer judges a phase by running `git diff HEAD` itself. In PR-native mode the agent's work
    // lives in the mission's worktree, not the main checkout — park it there or every phase false-rejects
    // as "fabricated" (the main checkout shows zero changes) and the mission loops forever.
    const launch = vi.fn().mockResolvedValue({ session: 'orca-overseer-m1' });
    const missionGit = { worktreeFor: vi.fn().mockReturnValue('/wt/m1') };
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never, config: cfg('opencode:deepseek/deepseek-v4-flash'), queue: new DecisionQueue(), missionGit });
    await ctl.start('m1', 1, '/repo');
    expect(missionGit.worktreeFor).toHaveBeenCalledWith('m1');
    expect(launch.mock.calls[0]![0].projectPath).toBe('/wt/m1');
  });

  it('start() falls back to the project checkout when the mission has no worktree (non-PR mission)', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'x' });
    const missionGit = { worktreeFor: vi.fn().mockReturnValue(null) };
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never, config: cfg('claude:opus'), queue: new DecisionQueue(), missionGit });
    await ctl.start('m1', 1, '/repo');
    expect(launch.mock.calls[0]![0].projectPath).toBe('/repo');
  });

  it('start() uses the project checkout when no missionGit is wired at all', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'x' });
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never, config: cfg('claude:opus'), queue: new DecisionQueue() });
    await ctl.start('m1', 1, '/repo');
    expect(launch.mock.calls[0]![0].projectPath).toBe('/repo');
  });

  it('ensure() re-parks into the worktree too (not just the first start)', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'x' });
    const missionGit = { worktreeFor: vi.fn().mockReturnValue('/wt/m1') };
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never, config: cfg('opencode:deepseek/deepseek-v4-flash'), queue: new DecisionQueue(), missionGit });
    await ctl.ensure('m1', 1, '/repo');
    expect(launch.mock.calls[0]![0].projectPath).toBe('/wt/m1');
  });

  it('stop() kills the session and drains the queue', async () => {
    const kill = vi.fn().mockResolvedValue(undefined);
    const queue = new DecisionQueue();
    const drain = vi.spyOn(queue, 'drain');
    const ctl = makeOverseer({ spawn: { launch: vi.fn().mockResolvedValue({ session: 'x' }) } as never, tmux: { kill, list: vi.fn().mockResolvedValue([]) } as never, config: cfg('claude:opus'), queue });
    await ctl.start('m3', 1, '/repo');
    await ctl.stop('m3');
    expect(kill).toHaveBeenCalledWith('orca-overseer-m3');
    expect(drain).toHaveBeenCalledWith('m3');
  });
});
