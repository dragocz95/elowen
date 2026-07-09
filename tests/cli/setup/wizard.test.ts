import { describe, it, expect } from 'vitest';
import { navigate, buildSteps, deploymentStepApplies, type ReviewDecision } from '../../../src/cli/setup/wizard.js';
import { WizardCancelled, type StepResult, type WizardCtx, type WizardStep } from '../../../src/cli/setup/types.js';
import type { InstallInfo } from '../../../src/cli/installInfo.js';

const installInfo = (): InstallInfo => ({ publicUrl: 'https://elo.example.com', mode: 'domain', serviceUser: 'elowen', daemonPort: 4400, webPort: 4500 });

const ctx = (): WizardCtx => ({ base: 'http://x', fetchFn: (async () => new Response('{}')) as unknown as typeof fetch, answers: {} });
const step = (id: string, run: () => Promise<StepResult>): WizardStep => ({ id: id as WizardStep['id'], title: id, run });
const finish = async (): Promise<ReviewDecision> => 'finish';

describe('cli/setup.navigate', () => {
  it('advances forward on done and reaches review', async () => {
    const visited: number[] = [];
    const steps = [step('a', async () => ({ status: 'done' })), step('b', async () => ({ status: 'done' }))];
    const r = await navigate(steps, ctx(), { onStep: (i) => visited.push(i), review: finish });
    expect(visited).toEqual([0, 1]);
    expect(r).toEqual({ done: true, skipped: false });
  });

  it("'back' returns to the previous step", async () => {
    const visited: number[] = [];
    let b = 0;
    const steps = [step('a', async () => ({ status: 'done' })), step('b', async () => (b++ === 0 ? { status: 'back' } : { status: 'done' }))];
    await navigate(steps, ctx(), { onStep: (i) => visited.push(i), review: finish });
    expect(visited).toEqual([0, 1, 0, 1]); // a → b(back) → a → b(done)
  });

  it('back at index 0 stays at 0', async () => {
    const visited: number[] = [];
    let a = 0;
    const steps = [step('a', async () => (a++ === 0 ? { status: 'back' } : { status: 'done' }))];
    await navigate(steps, ctx(), { onStep: (i) => visited.push(i), review: finish });
    expect(visited).toEqual([0, 0]);
  });

  it('skip advances like done (does not mark the run skipped)', async () => {
    const r = await navigate([step('a', async () => ({ status: 'skipped' }))], ctx(), { onStep: () => {}, review: finish });
    expect(r).toEqual({ done: true, skipped: false });
  });

  it('review edit-jump re-runs a step, then finishes', async () => {
    const visited: number[] = [];
    let reviews = 0;
    const steps = [step('a', async () => ({ status: 'done' })), step('b', async () => ({ status: 'done' }))];
    const review = async (): Promise<ReviewDecision> => (reviews++ === 0 ? 0 : 'finish');
    await navigate(steps, ctx(), { onStep: (i) => visited.push(i), review });
    expect(visited).toEqual([0, 1, 0, 1]);
  });

  it('skip-remaining marks the run skipped', async () => {
    const r = await navigate([step('a', async () => ({ status: 'done' }))], ctx(), { onStep: () => {}, review: async () => 'skip-remaining' });
    expect(r).toEqual({ done: true, skipped: true });
  });

  it('resumes from startIndex', async () => {
    const visited: number[] = [];
    const steps = ['a', 'b', 'c'].map((id) => step(id, async () => ({ status: 'done' })));
    await navigate(steps, ctx(), { onStep: (i) => visited.push(i), review: finish }, 2);
    expect(visited).toEqual([2]);
  });

  it('propagates a WizardCancelled thrown by a step', async () => {
    const steps = [step('a', async () => { throw new WizardCancelled(); })];
    await expect(navigate(steps, ctx(), { onStep: () => {}, review: finish })).rejects.toBeInstanceOf(WizardCancelled);
  });
});

describe('cli/setup deployment-step gating (install/setup parity)', () => {
  it('applies only on a systemd box (install.json) run as root, and never when embedded in install', () => {
    expect(deploymentStepApplies({ info: installInfo(), isRoot: true, embedded: false })).toBe(true);
    expect(deploymentStepApplies({ info: null, isRoot: true, embedded: false })).toBe(false); // plain npm install
    expect(deploymentStepApplies({ info: installInfo(), isRoot: false, embedded: false })).toBe(false); // no privileges
    expect(deploymentStepApplies({ info: installInfo(), isRoot: true, embedded: true })).toBe(false); // install already asked
  });

  it('buildSteps inserts the Deployment step after Account when it applies', () => {
    const steps = buildSteps({ info: installInfo(), isRoot: true, embedded: false });
    expect(steps.map((s) => s.id)).toEqual(['account', 'deployment', 'project', 'ai', 'memory', 'lsp']);
  });

  it('buildSteps omits the Deployment step off a systemd box', () => {
    const steps = buildSteps({ info: null, isRoot: true, embedded: false });
    expect(steps.map((s) => s.id)).toEqual(['account', 'project', 'ai', 'memory', 'lsp']);
    expect(steps.some((s) => s.id === 'deployment')).toBe(false);
  });
});
