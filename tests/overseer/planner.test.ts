import { describe, it, expect } from 'vitest';
import { parsePhases, decompose, planPrompt, defaultPromptTemplate, _resetDefaultCache } from '../../src/overseer/planner.js';
import { FakeInference } from '../../src/inference/client.js';

describe('planner.parsePhases', () => {
  it('parses a clean JSON array', () => {
    const phases = parsePhases('[{"title":"Set up schema","type":"task"},{"title":"Add API","type":"feature"}]');
    expect(phases).toEqual([
      { title: 'Set up schema', type: 'task' },
      { title: 'Add API', type: 'feature' },
    ]);
  });

  it('extracts the array from surrounding prose / fences', () => {
    const phases = parsePhases('Sure! Here is the plan:\n```json\n[{"title":"Phase one"}]\n```\nDone.');
    expect(phases).toEqual([{ title: 'Phase one', type: 'task' }]); // missing type defaults to task
  });

  it('coerces unknown types to task and drops titleless entries', () => {
    const phases = parsePhases('[{"title":"Keep","type":"wat"},{"type":"bug"},{"title":"  "}]');
    expect(phases).toEqual([{ title: 'Keep', type: 'task' }]);
  });

  it('captures and sanitizes the model-assigned agent name', () => {
    const phases = parsePhases('[{"title":"A","type":"task","agent":"Nova"},{"title":"B","agent":"At las!"},{"title":"C"}]');
    expect(phases[0].agent).toBe('Nova');
    expect(phases[1].agent).toBe('Atlas'); // stripped to a tmux-safe token
    expect(phases[2].agent).toBeUndefined();
  });

  it('keeps tmux-legal dashes and underscores in agent names (no collapse to one word)', () => {
    const phases = parsePhases('[{"title":"A","agent":"code-reviewer"},{"title":"B","agent":"bug_finder"},{"title":"C","agent":"db:writer"}]');
    expect(phases[0].agent).toBe('code-reviewer'); // dash survives (#33)
    expect(phases[1].agent).toBe('bug_finder');    // underscore survives
    expect(phases[2].agent).toBe('dbwriter');      // ':' (session separator) still stripped
  });

  it('extracts the first balanced array and ignores a trailing bracketed note (#30)', () => {
    const phases = parsePhases('Here is the plan: [{"title":"Only"}]. Notes: [misc, do not parse this]');
    expect(phases).toEqual([{ title: 'Only', type: 'task' }]);
  });

  it('does not choke on brackets inside string values', () => {
    const phases = parsePhases('[{"title":"Fix [BUG-12] in parser","details":"handle ] and ["}]');
    expect(phases[0].title).toBe('Fix [BUG-12] in parser');
    expect(phases[0].details).toBe('handle ] and [');
  });

  it('captures per-phase details when present', () => {
    const phases = parsePhases('[{"title":"A","details":"Build X with acceptance Y"},{"title":"B","details":"  "}]');
    expect(phases[0].details).toBe('Build X with acceptance Y');
    expect(phases[1].details).toBeUndefined(); // blank → omitted
  });

  it('throws when there is no array', () => {
    expect(() => parsePhases('no json here')).toThrow();
  });

  it('throws when the array has no valid phases', () => {
    expect(() => parsePhases('[]')).toThrow();
  });
});

describe('planner.planPrompt', () => {
  it('substitutes the goal into a {{goal}} placeholder', () => {
    expect(planPrompt('ship it', 'Plan this: {{goal}} now')).toBe('Plan this: ship it now');
  });
  it('appends the goal when the template lacks a placeholder', () => {
    expect(planPrompt('ship it', 'No placeholder here')).toContain('Goal: ship it');
  });
  it('default template contains the {{goal}} placeholder', () => {
    expect(defaultPromptTemplate()).toContain('{{goal}}');
  });
  it('_resetDefaultCache forces a re-read (cache is not permanent) (#31)', () => {
    const first = defaultPromptTemplate();
    _resetDefaultCache();
    const second = defaultPromptTemplate(); // re-read from disk, not the stale module-level cache
    expect(second).toBe(first);
  });
  it('substitutes the project notes into a {{project}} placeholder', () => {
    const out = planPrompt('ship it', 'Ctx: {{project}}\nGoal: {{goal}}', { notes: 'monorepo; run pnpm' });
    expect(out).toContain('monorepo; run pnpm');
    expect(out).toContain('Goal: ship it');
    expect(out).not.toContain('{{project}}');
  });
  it('prepends the project context when the template has no {{project}} placeholder', () => {
    const out = planPrompt('ship it', 'Plan: {{goal}}', { notes: 'always use TDD' });
    expect(out.startsWith('Project context')).toBe(true);
    expect(out).toContain('always use TDD');
    expect(out).toContain('Plan: ship it');
  });
  it('injects nothing when the project has no notes', () => {
    expect(planPrompt('ship it', 'Plan: {{goal}}', { notes: '   ' })).toBe('Plan: ship it');
    expect(planPrompt('ship it', 'Plan: {{goal}}')).toBe('Plan: ship it');
  });
});

describe('planner.decompose', () => {
  it('runs the inference client and returns validated phases', async () => {
    const inf = new FakeInference('[{"title":"A","type":"feature"},{"title":"B"}]');
    const phases = await decompose(inf, 'build a thing');
    expect(phases).toEqual([
      { title: 'A', type: 'feature' },
      { title: 'B', type: 'task' },
    ]);
  });
});
