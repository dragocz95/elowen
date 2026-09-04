import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');

interface Normalized { question: string; header: string; multiSelect: boolean; custom: boolean; options: { label: string; description?: string; preview?: string }[] }
interface RegisteredTool {
  parameters: Record<string, unknown>;
  execute(id: string, params: unknown): Promise<{ content: { text: string }[] }>;
}
type NormalizeFn = (q: unknown) => Normalized;
type FormatFn = (questions: { question: string }[], answers: unknown) => string;
type RegisterFn = (ctx: unknown) => void;

const load = async () => await import(join(repoRoot, 'plugins/askuser/index.mjs')) as {
  normalizeQuestion: NormalizeFn;
  formatAnswers: FormatFn;
  register: RegisterFn;
};

describe('AskUserQuestion — Fable-compatible surface', () => {
  const registered = async (askUser: (questions: Normalized[]) => Promise<unknown[]>) => {
    const tools: RegisteredTool[] = [];
    const { register } = await load();
    register({
      registerTool: (tool: RegisteredTool) => tools.push(tool),
      registerSystemPromptFragment: () => undefined,
      askUser,
      logger: { info: () => undefined },
    });
    return tools[0]!;
  };

  it('declares required headers, 2-4 rich options, multiSelect, and optional response metadata', async () => {
    const tool = await registered(async () => []);
    const schema = JSON.stringify(tool.parameters);
    expect(schema).toContain('"header"');
    expect(schema).toContain('"multiSelect"');
    expect(schema).toContain('"minItems":2');
    expect(schema).toContain('"maxItems":4');
    expect(schema).toContain('"description"');
    expect(schema).toContain('"answers"');
    expect(schema).toContain('"annotations"');
    expect(schema).toContain('"metadata"');
    expect(schema).toContain('"custom"');
    expect(schema).not.toContain('"multiple"');
    expect(schema).not.toContain('"anyOf"');
  });

  it('accepts the canonical payload and always asks the user even when answers are prefilled', async () => {
    const calls: Normalized[][] = [];
    const tool = await registered(async (questions) => {
      calls.push(questions);
      return [{ selected: ['Safe'] }];
    });
    const result = await tool.execute('t', {
      questions: [{
        question: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'Safe', description: 'Use the safer implementation.' },
          { label: 'Fast', description: 'Use the faster implementation.' },
        ],
        multiSelect: false,
      }],
      answers: { 'Which approach?': 'Fast' },
      annotations: { 'Which approach?': { preview: 'ignored', notes: 'prefilled' } },
      metadata: { source: 'test' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ header: 'Approach', multiSelect: false });
    expect(result.content[0].text).toContain('"Which approach?" = "Safe"');
    expect(result.content[0].text).not.toContain('"Fast"');
  });
});

describe('AskUserQuestion — forgiving question normalization', () => {
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

  // normalizeQuestion REBUILDS every option field by field, so a new field that is not copied here is
  // silently dropped and no renderer ever sees it — it would typecheck and simply not work.
  describe('option previews', () => {
    it('carries a preview through, newlines intact', async () => {
      const { normalizeQuestion } = await load();
      const q = normalizeQuestion({
        question: 'Which layout?',
        options: [
          { label: 'Grid', description: 'cards', preview: '┌───┐ ┌───┐\n│ A │ │ B │\n└───┘ └───┘' },
          { label: 'List', description: 'rows' },
        ],
      });
      expect(q.options[0].preview).toBe('┌───┐ ┌───┐\n│ A │ │ B │\n└───┘ └───┘');
      expect(q.options[1].preview).toBeUndefined(); // previews are per-option, not all-or-nothing
    });

    it('drops previews on a multi-select question — there is no single focused option to preview', async () => {
      const { normalizeQuestion } = await load();
      const q = normalizeQuestion({
        question: 'Which layouts?',
        multiple: true,
        options: [{ label: 'Grid', preview: 'A B' }, { label: 'List', preview: 'A\nB' }],
      });
      expect(q.multiSelect).toBe(true);
      expect(q.options.every((op) => op.preview === undefined)).toBe(true);
    });

    it('ignores a blank or non-string preview rather than rendering an empty pane', async () => {
      const { normalizeQuestion } = await load();
      const q = normalizeQuestion({
        question: 'Pick',
        options: [{ label: 'a', preview: '   ' }, { label: 'b', preview: 42 }],
      });
      expect(q.options[0].preview).toBeUndefined();
      expect(q.options[1].preview).toBeUndefined();
    });
  });
});

describe('AskUserQuestion — answer formatting', () => {
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
