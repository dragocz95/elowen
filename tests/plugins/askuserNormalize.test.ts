import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { composeSessionTools } from '../../src/brain/session/capabilities.js';

const repoRoot = join(__dirname, '..', '..');

interface Normalized { question: string; header: string; multiSelect: boolean; custom: boolean; options: { label: string; description?: string; preview?: string }[] }
interface ToolResult { content: { text: string }[] }
interface RegisteredTool extends ToolDefinition {
  execute(id: string, params: unknown): Promise<ToolResult>;
}
type NormalizeFn = (q: unknown) => Normalized;
type FormatFn = (questions: { question: string }[], answers: unknown) => string;
type RegisterFn = (ctx: unknown) => void;

const load = async () => await import(join(repoRoot, 'plugins/askuser/index.mjs')) as {
  normalizeQuestion: NormalizeFn;
  formatAnswers: FormatFn;
  register: RegisterFn;
};

describe('AskUserQuestion — canonical model surface', () => {
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

  it('keeps the final host-transformed schema strict, required, and truthful', async () => {
    const raw = await registered(async () => []);
    const tool = composeSessionTools({ kind: 'owner-chat', pluginTools: [raw] })
      .find((entry) => entry.name === 'AskUserQuestion')!;
    const schema = tool.parameters as {
      type?: string;
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, any>;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['questions']);
    expect(Object.keys(schema.properties ?? {})).toEqual(['_reason', 'questions']);

    const questions = schema.properties?.questions;
    expect(questions).toMatchObject({ type: 'array', minItems: 1, maxItems: 4 });
    const question = questions.items;
    expect(question.additionalProperties).toBe(false);
    expect(question.required).toEqual(['question', 'header', 'options', 'multiSelect']);
    expect(question.properties.question).toMatchObject({ type: 'string', minLength: 1, pattern: '\\?$' });
    expect(question.properties.header).toMatchObject({ type: 'string', minLength: 1, maxLength: 12 });
    expect(question.properties.multiSelect).toMatchObject({ type: 'boolean' });
    expect(question.properties.custom).toMatchObject({ type: 'boolean', default: true });

    const options = question.properties.options;
    expect(options).toMatchObject({ type: 'array', minItems: 2, maxItems: 4 });
    expect(options.items.additionalProperties).toBe(false);
    expect(options.items.required).toEqual(['label', 'description']);
    expect(options.items.properties.label).toMatchObject({ type: 'string', minLength: 1 });
    expect(options.items.properties.description).toMatchObject({ type: 'string', minLength: 1 });
    expect(options.items.properties.preview).toMatchObject({ type: 'string', minLength: 1 });

    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain('"answers"');
    expect(serialized).not.toContain('"annotations"');
    expect(serialized).not.toContain('"metadata"');
    expect(serialized).not.toContain('"multiple"');
  });

  it('accepts a valid canonical payload and returns the interactive answers', async () => {
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
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ header: 'Approach', multiSelect: false, custom: true });
    expect(result.content[0].text).toContain('"Which approach?" = "Safe"');
  });

  it.each(['answers', 'annotations', 'metadata'])('rejects removed %s instead of silently dropping it', async (field) => {
    let called = false;
    const tool = await registered(async () => { called = true; return []; });
    const result = await tool.execute('t', {
      questions: [{
        question: 'Which approach?', header: 'Approach', multiSelect: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      }],
      [field]: {},
    });
    expect(result.content[0].text).toContain(`Error: ${field} is not supported.`);
    expect(called).toBe(false);
  });

  it.each([
    ['question without a question mark', { question: 'Which approach', header: 'Approach', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }, 'end with "?"'],
    ['header longer than twelve characters', { question: 'Which approach?', header: 'Longer header', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }, 'at most 12'],
    ['fewer than two options', { question: 'Which approach?', header: 'Approach', options: [{ label: 'A', description: 'a' }], multiSelect: false }, '2-4 options'],
    ['more than four options', { question: 'Which approach?', header: 'Approach', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }, { label: 'C', description: 'c' }, { label: 'D', description: 'd' }, { label: 'E', description: 'e' }], multiSelect: false }, '2-4 options'],
    ['an option without a description', { question: 'Which approach?', header: 'Approach', options: [{ label: 'A' }, { label: 'B', description: 'b' }], multiSelect: false }, 'description'],
    ['a preview on multi-select', { question: 'Which approaches?', header: 'Approach', options: [{ label: 'A', description: 'a', preview: 'A' }, { label: 'B', description: 'b' }], multiSelect: true }, 'single-select'],
  ])('rejects %s instead of silently coercing it', async (_name, question, message) => {
    let called = false;
    const tool = await registered(async () => { called = true; return []; });
    const result = await tool.execute('t', { questions: [question] });
    expect(result.content[0].text).toContain(`Error:`);
    expect(result.content[0].text).toContain(message);
    expect(called).toBe(false);
  });
});

describe('AskUserQuestion — hidden replay normalization', () => {
  it('keeps legacy string options, missing header, and multiple out of the schema but normalizes stored calls', async () => {
    const { normalizeQuestion } = await load();
    const q = normalizeQuestion({ question: 'Which colour?', multiple: true, options: ['Blue', 'Green', 'Red'] });
    expect(q.multiSelect).toBe(true);
    expect(q.custom).toBe(true);
    expect(q.header.length).toBeLessThanOrEqual(12);
    expect(q.options).toEqual([{ label: 'Blue' }, { label: 'Green' }, { label: 'Red' }]);
  });

  it('carries a single-select preview through without changing its markdown', async () => {
    const { normalizeQuestion } = await load();
    const q = normalizeQuestion({
      question: 'Which layout?',
      header: 'Layout',
      multiSelect: false,
      options: [
        { label: 'Grid', description: 'cards', preview: '┌───┐\n│ A │\n└───┘' },
        { label: 'List', description: 'rows' },
      ],
    });
    expect(q.options[0].preview).toBe('┌───┐\n│ A │\n└───┘');
  });
});

describe('AskUserQuestion — answer formatting', () => {
  const questions = [{ question: 'Which colour?' }, { question: 'Pick tools?' }];

  it('renders one line per real answer, with multiple picks and custom text preserved', async () => {
    const { formatAnswers } = await load();
    const out = formatAnswers(questions, [
      { selected: ['Blue'] },
      { selected: ['A', 'B'], other: 'and my note' },
    ]);
    expect(out).toContain('"Which colour?" = "Blue"');
    expect(out).toContain('"Pick tools?" = "A, B, and my note"');
  });
});
