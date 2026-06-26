import { describe, it, expect } from 'vitest';
import { parsePhases, decompose, planPrompt, modelsBlock, parallelismBlock, defaultPromptTemplate, _resetDefaultCache } from '../../src/overseer/planner.js';
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

  it('captures a per-phase exec when present', () => {
    const phases = parsePhases('[{"title":"A","type":"task","exec":"sonnet"},{"title":"B","type":"task"},{"title":"C","exec":"  "}]');
    expect(phases[0].exec).toBe('sonnet');
    expect(phases[1].exec).toBeUndefined();
    expect(phases[2].exec).toBeUndefined(); // blank → omitted
  });

  it('throws when there is no array', () => {
    expect(() => parsePhases('no json here')).toThrow();
  });

  it('throws when the array has no valid phases', () => {
    expect(() => parsePhases('[]')).toThrow();
  });

  it('captures id and dependsOn (including an explicit empty array)', () => {
    const phases = parsePhases('[{"title":"API","id":"api","dependsOn":[]},{"title":"UI","id":"ui","dependsOn":["api"]}]');
    expect(phases[0].id).toBe('api');
    expect(phases[0].dependsOn).toEqual([]); // [] = no deps, distinct from absent
    expect(phases[1].id).toBe('ui');
    expect(phases[1].dependsOn).toEqual(['api']);
  });

  it('sanitizes id and dependsOn to slug chars and drops empty entries', () => {
    const phases = parsePhases('[{"title":"A","id":"my id!","dependsOn":["a b","ok-1",":x","   "]}]');
    expect(phases[0].id).toBe('myid');
    expect(phases[0].dependsOn).toEqual(['ab', 'ok-1', 'x']); // blank entry dropped
  });

  it('omits id/dependsOn for a legacy plan without them', () => {
    const phases = parsePhases('[{"title":"A","type":"task"}]');
    expect(phases[0].id).toBeUndefined();
    expect(phases[0].dependsOn).toBeUndefined();
  });

  it('treats a non-array dependsOn as absent', () => {
    const phases = parsePhases('[{"title":"A","id":"a","dependsOn":"api"}]');
    expect(phases[0].dependsOn).toBeUndefined();
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
  it('default template carries a {{models}} placeholder', () => {
    expect(defaultPromptTemplate()).toContain('{{models}}');
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
  it('substitutes a models block into a {{models}} placeholder', () => {
    const out = planPrompt('ship it', 'Models:\n{{models}}\nGoal: {{goal}}', undefined, '- sonnet: coder');
    expect(out).toContain('- sonnet: coder');
    expect(out).not.toContain('{{models}}');
    expect(out).toContain('Goal: ship it');
  });
  it('collapses {{models}} to empty when no block is given', () => {
    expect(planPrompt('ship it', 'Models:\n{{models}}\nGoal: {{goal}}', undefined, '')).toBe('Models:\n\nGoal: ship it');
  });
  it('prepends the models block when the template has no {{models}} placeholder', () => {
    const out = planPrompt('ship it', 'Plan: {{goal}}', undefined, '- sonnet: coder');
    expect(out.startsWith('- sonnet: coder')).toBe(true);
    expect(out).toContain('Plan: ship it');
  });
  it('substitutes a parallelism block into a {{parallelism}} placeholder', () => {
    const out = planPrompt('ship it', 'P:\n{{parallelism}}\nGoal: {{goal}}', undefined, undefined, 'RUN WIDE');
    expect(out).toContain('RUN WIDE');
    expect(out).not.toContain('{{parallelism}}');
  });
  it('prepends the parallelism block when the template has no {{parallelism}} placeholder', () => {
    const out = planPrompt('ship it', 'Plan: {{goal}}', undefined, undefined, 'RUN WIDE');
    expect(out.startsWith('RUN WIDE')).toBe(true);
    expect(out).toContain('Plan: ship it');
  });
  it('default template carries a {{parallelism}} placeholder', () => {
    expect(defaultPromptTemplate()).toContain('{{parallelism}}');
  });
});

describe('planner.modelsBlock', () => {
  it('lists only enabled models that have a non-empty note + carries the exec instruction', () => {
    const block = modelsBlock(['sonnet', 'codex:gpt-5.4', 'deepseek/x'], { sonnet: 'Strong coder', 'codex:gpt-5.4': '  ', 'ollama/y': 'not enabled' });
    expect(block).toContain('- sonnet: Strong coder');
    expect(block).not.toContain('codex:gpt-5.4'); // empty note → omitted
    expect(block).not.toContain('ollama/y');       // not in allowedExecs → omitted
    expect(block).toMatch(/exec/i);
  });
  it('returns empty string when nothing qualifies', () => {
    expect(modelsBlock(['sonnet'], {})).toBe('');
    expect(modelsBlock([], { sonnet: 'x' })).toBe('');
  });
});

describe('planner.parallelismBlock', () => {
  it('invites parallel branches only when >1 session AND isolated worktrees', () => {
    const block = parallelismBlock(3, true);
    expect(block).toMatch(/AT THE SAME TIME/);
    expect(block).toMatch(/3 phases/);
    expect(block).toMatch(/dependsOn: \[\]/);
  });
  it('asks for a sequential chain with a single session', () => {
    expect(parallelismBlock(1, true)).toMatch(/ONE AT A TIME/);
  });
  it('asks for a sequential chain in a shared (non-isolated) checkout even with >1 session', () => {
    // The single-writer gate would serialize anyway — emitting parallel phases there is false parallelism.
    expect(parallelismBlock(2, false)).toMatch(/ONE AT A TIME/);
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
