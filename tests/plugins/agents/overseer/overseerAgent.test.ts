import { describe, it, expect, vi } from 'vitest';
import { render } from '../../../../src/prompts/index.js';
import { overseerPrompt as rawOverseerPrompt, makeOverseer as rawMakeOverseer, type RenderPrompt } from '../../../../plugins/agents/src/overseer/overseerAgent.js';

// The plugin functions take the prompt renderer as a REQUIRED seam (ctx.host.prompts in
// production); the core file renderer stands in here, matching the pre-extraction defaults.
const overseerPrompt = (missionId: string, cli?: string, rp: RenderPrompt = render) => rawOverseerPrompt(missionId, rp, cli);
const prompts = { render: (n: string, v?: Record<string, string>) => render(n, v), rawTemplate: () => '' };
const makeOverseer = (deps: Omit<Parameters<typeof rawMakeOverseer>[0], 'prompts'> & { prompts?: Parameters<typeof rawMakeOverseer>[0]['prompts'] }) => rawMakeOverseer({ prompts, ...deps });
import { DecisionQueue } from '../../../../plugins/agents/src/overseer/decisionQueue.js';

describe('overseerPrompt', () => {
  it('tells the agent to loop poll → decide', () => {
    const p = overseerPrompt('m1');
    expect(p).toContain('elowen overseer poll');
    expect(p).toContain('elowen overseer decide');
  });
  it('uses the provided cli invocation verbatim (e.g. node <path> in a checkout)', () => {
    const p = overseerPrompt('m1', 'node /d/cli/index.js');
    expect(p).toContain('node /d/cli/index.js overseer poll');
    expect(p).toContain('node /d/cli/index.js overseer decide');
    expect(p).not.toMatch(/`elowen overseer poll`/); // not the bare default when an explicit cli is given
  });
  it('explains each decision kind so the overseer judges them differently (O19)', () => {
    const p = overseerPrompt('m1');
    expect(p).toContain('"task"');
    expect(p).toContain('"prompt"');
    expect(p).toContain('"review"');
    expect(p.toLowerCase()).toContain('blocks its dependents'); // review semantics spelled out
  });
  it('explains the "message" kind and its free-text answer command (elowen ask)', () => {
    const p = overseerPrompt('m1');
    expect(p).toContain('"message"'); // the free-text agent question kind
    expect(p).toContain('overseer decide --id <id> --message'); // how to answer it
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
    const p = overseerPrompt('m1', 'elowen', renderPrompt);
    expect(renderPrompt).toHaveBeenCalledWith('code-review', {});
    expect(p).toContain('CR-CRITERIA');
  });
});

describe('makeOverseer', () => {
  const cfg = (overseerExec: string) => ({ get: () => ({ autopilot: { overseerExec } }) }) as never;

  it('uses the mission overseer override instead of the global overseer', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'elowen-overseer-m1' });
    const ctl = makeOverseer({
      spawn: { launch } as never,
      tmux: { kill: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never,
      config: cfg('claude:sonnet'), queue: new DecisionQueue(),
      missions: { get: () => ({ created_by: 1, overseer_exec: 'codex:gpt-5.4' }) },
    });
    await ctl.start('m1', 1, '/repo');
    expect(launch.mock.calls[0]![0].spec).toEqual({ program: 'codex', model: 'gpt-5.4' });
  });

  it('start() spawns a parked agent named overseer-<id> with ELOWEN_MISSION', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'elowen-overseer-m1' });
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never, config: cfg('opencode:deepseek/deepseek-v4-flash'), queue: new DecisionQueue(), cli: 'node /d/cli/index.js' });
    await ctl.start('m1', 1, '/repo');
    const arg = launch.mock.calls[0]![0];
    expect(arg.agentName).toBe('overseer-m1');
    expect(arg.extraEnv).toEqual({ ELOWEN_MISSION: 'm1' });
    expect(arg.spec).toEqual({ program: 'opencode', model: 'deepseek/deepseek-v4-flash' });
    expect(arg.rawPrompt).toContain('node /d/cli/index.js overseer poll'); // daemon CLI by absolute path
  });

  it('start() is idempotent — never double-spawns when the overseer is already parked', async () => {
    // engage and resume both call start() unconditionally, and the overseer can already be parked from
    // a prior engage. Without the in-park guard, `tmux new-session` throws "duplicate session" and
    // crashes the caller (the route handler), which is exactly what livelocked the mission.
    const launch = vi.fn().mockResolvedValue({ session: 'elowen-overseer-m1' });
    const list = vi.fn().mockResolvedValue(['elowen-overseer-m1']); // already parked
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list } as never, config: cfg('opencode:deepseek/deepseek-v4-flash'), queue: new DecisionQueue() });
    await ctl.start('m1', 1, '/repo');
    expect(launch).not.toHaveBeenCalled();
  });

  it('start() and ensure() racing each other still park exactly one overseer', async () => {
    // engage, the mission tick's ensure and the watchdog all call park concurrently. The guard is a
    // check-then-act across an await, so without serialization both callers see the session missing and
    // launch — and the second `tmux new-session` throws "duplicate session", crashing its caller.
    const live: string[] = [];
    const launch = vi.fn(async (arg: { agentName: string }) => {
      live.push(`elowen-${arg.agentName}`);
      return { session: `elowen-${arg.agentName}` };
    });
    const list = vi.fn(async () => [...live]);
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list } as never, config: cfg('claude:opus'), queue: new DecisionQueue() });
    await Promise.all([ctl.start('m1', 1, '/repo'), ctl.ensure('m1', 1, '/repo'), ctl.ensure('m1', 1, '/repo')]);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('a failed park does not poison the next one', async () => {
    const launch = vi.fn()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce({ session: 'elowen-overseer-m1' });
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never, config: cfg('claude:opus'), queue: new DecisionQueue() });
    await expect(ctl.start('m1', 1, '/repo')).rejects.toThrow('spawn failed');
    await ctl.ensure('m1', 1, '/repo');
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('start() is a no-op when overseerExec is empty (relay fallback)', async () => {
    const launch = vi.fn();
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never, config: cfg(''), queue: new DecisionQueue() });
    await ctl.start('m2', 1, '/repo');
    expect(launch).not.toHaveBeenCalled();
  });

  it('ensure() re-parks the agent when its session has died', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'elowen-overseer-m1' });
    const list = vi.fn().mockResolvedValue([]); // session gone
    const ctl = makeOverseer({ spawn: { launch } as never, tmux: { kill: vi.fn(), list } as never, config: cfg('opencode:deepseek/deepseek-v4-flash'), queue: new DecisionQueue(), cli: 'node /d/cli/index.js' });
    await ctl.ensure('m1', 1, '/repo');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0].agentName).toBe('overseer-m1');
  });

  it('ensure() does not double-spawn when the overseer is already parked', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'elowen-overseer-m1' });
    const list = vi.fn().mockResolvedValue(['elowen-overseer-m1', 'elowen-AgentX']); // still alive
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
    const launch = vi.fn().mockResolvedValue({ session: 'elowen-overseer-m1' });
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
    expect(kill).toHaveBeenCalledWith('elowen-overseer-m3');
    expect(drain).toHaveBeenCalledWith('m3');
  });
});
