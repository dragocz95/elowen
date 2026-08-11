import { describe, it, expect, vi } from 'vitest';
import { render } from '../../../../src/prompts/index.js';
import { pilotPrompt as rawPilotPrompt, makePilot as rawMakePilot } from '../../../../plugins/agents/src/overseer/pilotAgent.js';
import type { RenderPrompt } from '../../../../plugins/agents/src/spawn/commandBuilder.js';

// The plugin functions take the prompt renderer as a REQUIRED seam (ctx.host.prompts in
// production); the core file renderer stands in here, matching the pre-extraction defaults.
const pilotPrompt = (goal: string, jobId: string, notes?: string, cli?: string, models?: string, parallelism?: string, rp: RenderPrompt = render) => rawPilotPrompt(goal, jobId, rp, notes, cli, models, parallelism);
const prompts = { render: (n: string, v?: Record<string, string>) => render(n, v), rawTemplate: () => '' };
const makePilot = (deps: Omit<Parameters<typeof rawMakePilot>[0], 'prompts'> & { prompts?: Parameters<typeof rawMakePilot>[0]['prompts'] }) => rawMakePilot({ prompts, ...deps });

describe('pilotPrompt', () => {
  it('instructs submit via elowen plan submit and forbids implementing', () => {
    const p = pilotPrompt('add CSV export', 'pj-9', 'use the Tasks table');
    expect(p).toContain('elowen plan submit');
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
    const p = pilotPrompt('g', 'pj-9', undefined, 'node /var/www/elowen/dist/cli/index.js');
    expect(p).toContain('node /var/www/elowen/dist/cli/index.js plan submit');
    expect(p).not.toMatch(/(^|\n)\s*elowen plan submit/); // not the bare default when an explicit cli is given
  });
  it('passes the phases JSON via a quoted heredoc so apostrophes cannot break the shell (O24)', () => {
    const p = pilotPrompt('g', 'pj-9');
    expect(p).toContain("<<'ELOWEN_PHASES'"); // single-quoted heredoc delimiter — no expansion, no quote-breakage
    expect(p).toContain('ELOWEN_PHASES');
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
    const p = pilotPrompt('g', 'pj-9', undefined, 'elowen', undefined, 'PLAN WIDE PLEASE');
    expect(p).toContain('PLAN WIDE PLEASE');
  });
});

describe('makePilot', () => {
  it('uses the plan job planner override instead of the global planner', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'elowen-pilotX' });
    const pilot = makePilot({
      spawn: { launch } as never,
      config: { get: () => ({ autopilot: { pilotExec: 'claude:sonnet' } }) } as never,
      projects: { get: () => ({ id: 1, path: '/repo' }) } as never,
      planJobs: { setSession: vi.fn() } as never,
      tmux: { list: async () => [] } as never,
      nameAgent: () => 'pilotX',
    });
    await pilot({ id: 'pj-9', goal: 'g', projectId: 1, epicId: null, dryRun: false, status: 'planning', phases: [], pilotExec: 'codex:gpt-5.4' }, '/repo');
    expect(launch.mock.calls[0]![0].spec).toEqual({ program: 'codex', model: 'gpt-5.4' });
  });

  it('spawns an agent in plan mode with ELOWEN_PLAN_JOB in env and the plan prompt as rawPrompt', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'elowen-pilotX' });
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
    expect(arg.extraEnv).toEqual({ ELOWEN_PLAN_JOB: 'pj-9' });
    expect(arg.projectPath).toBe('/repo');
    expect(arg.rawPrompt).toContain('node /d/cli/index.js plan submit'); // daemon CLI by absolute path
  });

  it('records the spawned tmux session on the plan job so the UI can live-preview the planner', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'elowen-pilotX' });
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
    expect(setSession).toHaveBeenCalledWith('pj-9', 'elowen-pilotX');
  });

  it('picks a pilot name whose session is not already live (no duplicate-session crash)', async () => {
    const launch = vi.fn().mockResolvedValue({ session: 'elowen-pilot-Atlas' });
    const queue = ['Nova', 'Atlas'];
    const pilot = makePilot({
      spawn: { launch } as never,
      config: { get: () => ({ autopilot: { pilotExec: 'claude:opus' } }) } as never,
      projects: { get: () => ({ id: 1, path: '/repo' }) } as never,
      planJobs: { setSession: vi.fn() } as never,
      tmux: { list: async () => ['elowen-pilot-Nova'] } as never, // a stale pilot session lingers
      nameAgent: () => queue.shift()!,
    });
    await pilot({ id: 'pj-9', goal: 'g', projectId: 1, epicId: null, dryRun: false, status: 'planning', phases: [] }, '/repo');
    expect(launch.mock.calls[0]![0].agentName).toBe('pilot-Atlas'); // skipped the live pilot-Nova
  });
});
