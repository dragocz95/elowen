import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');

interface Normalized { question: string; header: string; multiSelect: boolean; custom: boolean; options: { label: string; description?: string }[] }
type NormalizeFn = (q: unknown) => Normalized;
type FormatFn = (questions: { question: string }[], answers: unknown) => string;

const load = async () => await import(join(repoRoot, 'plugins/askuser/index.mjs')) as { normalizeQuestion: NormalizeFn; formatAnswers: FormatFn };

describe('ask_user_question — forgiving question normalization', () => {
  it('accepts the minimal form (bare string options, no header/multiple)', async () => {
    const { normalizeQuestion } = await load();
    const q = normalizeQuestion({ question: 'Which colour?', options: ['Blue', 'Green', 'Red'] });
    expect(q.multiSelect).toBe(false);
    expect(q.custom).toBe(true); // free-text answer allowed by default
    expect(q.header).toBe('Which colour?'); // derived from the question (≤30 chars)
    expect(q.options).toEqual([{ label: 'Blue' }, { label: 'Green' }, { label: 'Red' }]);
  });

  it('accepts the rich form and honors header/multiple/custom; drops empty-label options', async () => {
    const { normalizeQuestion } = await load();
    const q = normalizeQuestion({
      question: 'Pick tools',
      header: 'Tools',
      multiple: true,
      custom: false,
      options: [{ label: 'A', description: 'first' }, { label: '  ' }, 'B'],
    });
    expect(q.header).toBe('Tools');
    expect(q.multiSelect).toBe(true);
    expect(q.custom).toBe(false);
    expect(q.options).toEqual([{ label: 'A', description: 'first' }, { label: 'B' }]);
  });

  it('still accepts the legacy `multiSelect` alias of `multiple`', async () => {
    const { normalizeQuestion } = await load();
    expect(normalizeQuestion({ question: 'Pick', multiSelect: true, options: ['a', 'b'] }).multiSelect).toBe(true);
    expect(normalizeQuestion({ question: 'Pick', options: ['a', 'b'] }).multiSelect).toBe(false);
  });

  it('caps a derived header at 30 chars', async () => {
    const { normalizeQuestion } = await load();
    const q = normalizeQuestion({ question: 'This is a very long question that has no header set', options: ['a', 'b'] });
    expect(q.header.length).toBeLessThanOrEqual(30);
  });
});

describe('ask_user_question — answer formatting', () => {
  const questions = [{ question: 'Which colour?' }, { question: 'Pick tools' }];

  it('renders one "<question>" = "<answer>" line per question, multiple picks joined with ", "', async () => {
    const { formatAnswers } = await load();
    const out = formatAnswers(questions, [
      { selected: ['Blue'] },
      { selected: ['A', 'B'], other: 'and my note' },
    ]);
    expect(out).toContain('"Which colour?" = "Blue"');
    expect(out).toContain('"Pick tools" = "A, B, and my note"');
  });

  it('marks a missing answer as "(no answer)"', async () => {
    const { formatAnswers } = await load();
    const out = formatAnswers(questions, [{ selected: ['Blue'] }]);
    expect(out).toContain('"Pick tools" = "(no answer)"');
  });
});
