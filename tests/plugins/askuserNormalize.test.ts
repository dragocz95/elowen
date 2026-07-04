import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');

describe('ask_user_question — forgiving question normalization', () => {
  it('accepts the minimal form (bare string options, no header/multiSelect)', async () => {
    const { normalizeQuestion } = await import(join(repoRoot, 'plugins/askuser/index.mjs')) as {
      normalizeQuestion: (q: unknown) => { question: string; header: string; multiSelect: boolean; options: { label: string; description?: string }[] };
    };
    const q = normalizeQuestion({ question: 'Which colour?', options: ['Blue', 'Green', 'Red'] });
    expect(q.multiSelect).toBe(false);
    expect(q.header).toBe('Which colour?'); // derived from the question (≤20 chars)
    expect(q.options).toEqual([{ label: 'Blue' }, { label: 'Green' }, { label: 'Red' }]);
  });

  it('accepts the rich form and honors header/multiSelect; drops empty-label options', async () => {
    const { normalizeQuestion } = await import(join(repoRoot, 'plugins/askuser/index.mjs')) as {
      normalizeQuestion: (q: unknown) => { header: string; multiSelect: boolean; options: { label: string; description?: string }[] };
    };
    const q = normalizeQuestion({
      question: 'Pick tools',
      header: 'Tools',
      multiSelect: true,
      options: [{ label: 'A', description: 'first' }, { label: '  ' }, 'B'],
    });
    expect(q.header).toBe('Tools');
    expect(q.multiSelect).toBe(true);
    expect(q.options).toEqual([{ label: 'A', description: 'first' }, { label: 'B' }]);
  });

  it('caps a derived header at 20 chars', async () => {
    const { normalizeQuestion } = await import(join(repoRoot, 'plugins/askuser/index.mjs')) as {
      normalizeQuestion: (q: unknown) => { header: string };
    };
    const q = normalizeQuestion({ question: 'This is a very long question that has no header set', options: ['a', 'b'] });
    expect(q.header.length).toBeLessThanOrEqual(20);
  });
});
