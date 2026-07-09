import { describe, it, expect } from 'vitest';
import { tddDirective, TDD_DIRECTIVE } from '../../src/prompts/tdd.js';
import { render, rawTemplate } from '../../src/prompts/index.js';
import { EDITABLE_PROMPTS } from '../../src/prompts/catalog.js';
import { PromptService } from '../../src/prompts/promptService.js';
import { UserPromptStore } from '../../src/store/userPromptStore.js';
import { openDb } from '../../src/store/db.js';
import { buildAgentCommand } from '../../src/spawn/commandBuilder.js';

describe('tddDirective', () => {
  it('returns the directive prefixed with a blank-line gap when on', () => {
    const out = tddDirective(true);
    expect(out.startsWith('\n\n')).toBe(true);
    expect(out).toContain(TDD_DIRECTIVE);
    expect(out).toContain('Test-Driven Development');
  });
  it('returns an empty string when off (append is a no-op)', () => {
    expect(tddDirective(false)).toBe('');
  });
});

describe('TDD directive is injected at the spawn seam, not through a template placeholder', () => {
  // The directive rides on a code-side append (commandBuilder/brainWorker), NOT a {{tddDirective}}
  // placeholder. That is the whole point: a user's saved wholesale override omits the placeholder, so
  // riding on it would silently drop the directive when TDD mode is on.
  const WORKER_TEMPLATES = ['worker', 'worker-resume', 'worker-phase', 'worker-brain'];

  for (const name of WORKER_TEMPLATES) {
    it(`${name}: the shipped template carries no {{tddDirective}} placeholder`, () => {
      expect(rawTemplate(name)).not.toContain('{{tddDirective}}');
    });
  }

  it('no editable template — worker or non-worker — bakes the directive text in', () => {
    // The directive lives ONLY in the code-side append; no .md ships it. This guards against anyone
    // re-inlining it into a template (which an override would then be able to break again).
    for (const p of EDITABLE_PROMPTS) {
      expect(rawTemplate(p.name)).not.toContain('Test-Driven Development');
    }
  });

  it('a wholesale worker override WITHOUT the placeholder still receives the directive when TDD is on', () => {
    // Reproduces the reported bug: an operator customized the worker prompt before TDD mode existed,
    // so their saved override has no {{tddDirective}}. PromptService substitutes it wholesale.
    const db = openDb(':memory:');
    const userPrompts = new UserPromptStore(db);
    const staleOverride = 'You are the Elowen agent "{{agentName}}" on {{taskId}}. Just do the task.';
    userPrompts.set(7, 'worker', staleOverride);
    const prompts = new PromptService(userPrompts);
    const renderPrompt = (name: string, vars?: Record<string, string>) => prompts.render(name, vars ?? {}, 7);

    // Sanity: the override really lacks the directive (dead placeholder path would leave it here).
    expect(renderPrompt('worker', { agentName: 'A', taskId: 'T-1' })).not.toContain('Test-Driven Development');

    const on = buildAgentCommand(
      { program: 'claude-code', model: 'sonnet' },
      { projectPath: '/o', taskId: 'T-1', agentName: 'A', tddMode: true },
      renderPrompt,
    );
    const off = buildAgentCommand(
      { program: 'claude-code', model: 'sonnet' },
      { projectPath: '/o', taskId: 'T-1', agentName: 'A', tddMode: false },
      renderPrompt,
    );
    expect(on).toContain('Test-Driven Development'); // appended at the seam despite the stale override
    expect(on).toContain('confirm it FAILS');
    expect(off).not.toContain('Test-Driven Development'); // off-state appends nothing
  });

  it('off-state render is byte-identical to the shipped template body (append is a no-op)', () => {
    const vars = { agentName: 'A', taskId: 'T-1', titlePart: '', detailsPart: '', resumePart: '', closeCommand: 'elowen close T-1', cli: 'elowen' };
    const rendered = render('worker', vars);
    expect(rendered + tddDirective(false)).toBe(rendered);
    expect(rendered).not.toContain('Test-Driven Development');
  });
});
