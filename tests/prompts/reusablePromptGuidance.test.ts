import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADVISOR_STYLES, DEFAULT_ADVISOR_STYLE, personalityText } from '../../src/brain/personality.js';

const root = join(import.meta.dirname, '..', '..');

describe('reusable agent guidance', () => {
  it('preserves all personality registers and the concise default', () => {
    expect(ADVISOR_STYLES).toEqual(['professional', 'friendly', 'concise', 'detailed']);
    expect(DEFAULT_ADVISOR_STYLE).toBe('concise');
    expect(personalityText('professional')).toContain('formal second person (vykani)');
    expect(personalityText('friendly')).toContain('informal second person (tykani)');
    expect(personalityText('concise')).toContain('fewest words that fully answer');
    expect(personalityText('detailed')).toContain('tradeoffs, assumptions, and alternatives');
    expect(personalityText('unknown')).toBe(personalityText('concise'));
    expect(personalityText('')).toBe(personalityText('concise'));
  });

  it('keeps every question field and selection constraint in the injected guidance', () => {
    const source = readFileSync(join(root, 'plugins/askuser/index.mjs'), 'utf8');
    const fragment = source.split('ctx.registerSystemPromptFragment(')[1]?.split('\n  );')[0];
    expect(fragment).toBeDefined();
    for (const field of ['AskUserQuestion', 'question', 'header', 'label', 'description', 'multiSelect', 'preview', 'custom']) {
      expect(fragment).toContain(`\`${field}\``);
    }
    expect(fragment).toContain('2-4 distinct options');
    expect(fragment).toContain('recommended option first');
    expect(fragment).toContain('single-select visual choice');
    expect(fragment).toContain('set `custom` false only when free text would be invalid');
    expect(fragment).toContain('reason for a denied tool call is unclear');
    expect(fragment).toContain('waits for an answer');
  });

  it.each(['plugins/subagent/index.mjs', 'plugins/subagent/lib/workflow.mjs'])('%s gives generic workers scope and honest reporting duties', (file) => {
    const source = readFileSync(join(root, file), 'utf8');
    const prompt = source.match(/: \{ prompt: '([^']+)' \}/)?.[1];
    expect(prompt).toBeDefined();
    expect(prompt).toContain('within its scope and permissions');
    expect(prompt).toContain('evidence');
    expect(prompt).toContain('unfinished work or blockers');
  });
});
