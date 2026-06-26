import { describe, it, expect, vi } from 'vitest';
import { pilotPrompt, makePilot } from '../../src/overseer/pilotAgent.js';

describe('pilotPrompt', () => {
  it('instructs submit via orca plan submit and forbids implementing', () => {
    const p = pilotPrompt('add CSV export', 'pj-9', 'use the Tasks table');
    expect(p).toContain('orca plan submit');
    expect(p).toContain('add CSV export');
    expect(p).toContain('use the Tasks table');
    expect(p.toLowerCase()).toContain('do not write any code');
  });
  it('never leaks an unsubstituted relay placeholder into the agent prompt', () => {
    // The agent prompt is self-contained; the relay template ({{goal}}/{{project}}) must not bleed in.
    const p = pilotPrompt('add CSV export', 'pj-9', 'use the Tasks table');
    expect(p).not.toContain('{{');
  });
  it('uses the provided cli invocation verbatim (e.g. node <path> in a checkout)', () => {
    const p = pilotPrompt('g', 'pj-9', undefined, 'node /var/www/orca/dist/cli/index.js');
    expect(p).toContain('node /var/www/orca/dist/cli/index.js plan submit');
    expect(p).not.toMatch(/(^|\n)\s*orca plan submit/); // not the bare default when an explicit cli is given
  });
  it('passes the phases JSON via a quoted heredoc so apostrophes cannot break the shell (O24)', () => {
    const p = pilotPrompt('g', 'pj-9');
    expect(p).toContain("<<'ORCA_PHASES'"); // single-quoted heredoc delimiter — no expansion, no quote-breakage
    expect(p).toContain('ORCA_PHASES');
    expect(p).not.toContain("--phases '["); // not the fragile inline single-quoted form
  });
  it('tells the Pilot to keep agent names to tmux-safe characters (O26)', () => {
    expect(pilotPrompt('g', 'pj-9').toLowerCase()).toContain('no spaces');
  });
  it('instructs the Pilot to express phase dependencies as a DAG (id + dependsOn)', () => {
    const p = pilotPrompt('g', 'pj-9');
    expect(p).toContain('dependsOn');
    expect(p.toLowerCase()).toContain('dag');
  });
  it('injects the provided parallelism block verbatim', () => {
    const p = pilotPrompt('g', 'pj-9', undefined, 'orca', undefined, 'PLAN WIDE PLEASE');
    expect(p).toContain('PLAN WIDE PLEASE');
  });
});

describe('makePilot', () => {
  it('spawns an agent in plan mode with ORCA_PLAN_JOB in env and the plan prompt as rawPrompt', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'orca-pilotX' });
    const pilot = makePilot({
      spawn: { launch } as never,
      config: { get: () => ({ autopilot: { pilotExec: 'claude:opus', prompt: 'TPL {{goal}}', notes: '' } }), apiKey: () => null } as never,
      projects: { get: () => ({ id: 1, path: '/repo', notes: 'N' }) } as never,
      planJobs: { setSession: vi.fn() } as never,
      tmux: { list: async () => [] } as never,
      nameAgent: () => 'pilotX',
      cli: 'node /d/cli/index.js',
    });
    await pilot({ id: 'pj-9', goal: 'g', projectId: 1, epicId: null, dryRun: false, status: 'planning', phases: [] }, '/repo');
    expect(launch).toHaveBeenCalledTimes(1);
    const arg = launch.mock.calls[0]![0];
    expect(arg.spec).toEqual({ program: 'claude-code', model: 'opus' });
    expect(arg.extraEnv).toEqual({ ORCA_PLAN_JOB: 'pj-9' });
    expect(arg.projectPath).toBe('/repo');
    expect(arg.rawPrompt).toContain('node /d/cli/index.js plan submit'); // daemon CLI by absolute path
  });

  it('records the spawned tmux session on the plan job so the UI can live-preview the planner', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'orca-pilotX' });
    const setSession = vi.fn();
    const pilot = makePilot({
      spawn: { launch } as never,
      config: { get: () => ({ autopilot: { pilotExec: 'claude:opus' } }) } as never,
      projects: { get: () => ({ id: 1, path: '/repo' }) } as never,
      tmux: { list: async () => [] } as never,
      nameAgent: () => 'pilotX',
      planJobs: { setSession } as never,
    });
    await pilot({ id: 'pj-9', goal: 'g', projectId: 1, epicId: null, dryRun: false, status: 'planning', phases: [] }, '/repo');
    expect(setSession).toHaveBeenCalledWith('pj-9', 'orca-pilotX');
  });

  it('picks a pilot name whose session is not already live (no duplicate-session crash)', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'orca-pilot-Atlas' });
    const queue = ['Nova', 'Atlas'];
    const pilot = makePilot({
      spawn: { launch } as never,
      config: { get: () => ({ autopilot: { pilotExec: 'claude:opus' } }) } as never,
      projects: { get: () => ({ id: 1, path: '/repo' }) } as never,
      planJobs: { setSession: vi.fn() } as never,
      tmux: { list: async () => ['orca-pilot-Nova'] } as never, // a stale pilot session lingers
      nameAgent: () => queue.shift()!,
    });
    await pilot({ id: 'pj-9', goal: 'g', projectId: 1, epicId: null, dryRun: false, status: 'planning', phases: [] }, '/repo');
    expect(launch.mock.calls[0]![0].agentName).toBe('pilot-Atlas'); // skipped the live pilot-Nova
  });
});
