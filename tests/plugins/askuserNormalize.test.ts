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

  it('mirrors the reference schema: reference bounds only, no header cap, no question pattern', async () => {
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
    // `multiSelect` carries the reference default instead of being required, so an omitted flag is a
    // single-select question rather than a rejected call.
    expect(question.required).toEqual(['question', 'header', 'options']);
    expect(question.properties.multiSelect).toMatchObject({ type: 'boolean', default: false });
    // The reference states the chip width in prose and enforces nothing — a long header is clipped at
    // render, and neither a length cap nor a trailing-question-mark pattern may creep back in.
    expect(question.properties.header.maxLength).toBeUndefined();
    expect(question.properties.header.description).toContain('max 12 chars');
    expect(question.properties.question.pattern).toBeUndefined();
    expect(question.properties.custom).toMatchObject({ type: 'boolean', default: true });

    const options = question.properties.options;
    expect(options).toMatchObject({ type: 'array', minItems: 2, maxItems: 4 });
    expect(options.items.required).toEqual(['label', 'description']);
    expect(options.items.properties.label).toMatchObject({ type: 'string' });
    expect(options.items.properties.description).toMatchObject({ type: 'string' });
    expect(options.items.properties.preview).toMatchObject({ type: 'string' });

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

  // The three cases below are the ones that used to cost a whole turn: the reference accepts all of them,
  // so Elowen must too.
  it('accepts a header longer than the chip width and hands it on for the renderer to clip', async () => {
    const calls: Normalized[][] = [];
    const tool = await registered(async (questions) => { calls.push(questions); return [{ selected: ['A'] }]; });
    const result = await tool.execute('t', {
      questions: [{
        question: 'Which approach?',
        header: 'Authentication', // 14 characters — two over the chip width
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
        multiSelect: false,
      }],
    });
    expect(result.content[0].text).toContain('"Which approach?" = "A"');
    expect(calls[0]![0]!.header).toBe('Authentication'); // full text survives; clipping happens at render
  });

  it('accepts a question that does not end with a question mark', async () => {
    let asked = false;
    const tool = await registered(async () => { asked = true; return [{ selected: ['A'] }]; });
    const result = await tool.execute('t', {
      questions: [{
        question: 'Pick a deployment target',
        header: 'Target',
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
        multiSelect: false,
      }],
    });
    expect(asked).toBe(true);
    expect(result.content[0].text).toContain('"Pick a deployment target" = "A"');
  });

  it('defaults a missing multiSelect to false instead of rejecting the call', async () => {
    const calls: Normalized[][] = [];
    const tool = await registered(async (questions) => { calls.push(questions); return [{ selected: ['A'] }]; });
    const result = await tool.execute('t', {
      questions: [{
        question: 'Which approach?',
        header: 'Approach',
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      }],
    });
    expect(result.content[0].text).toContain('"Which approach?" = "A"');
    expect(calls[0]![0]!.multiSelect).toBe(false);
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
    ['fewer than two options', { question: 'Which approach?', header: 'Approach', options: [{ label: 'A', description: 'a' }], multiSelect: false }, '2-4 options'],
    ['more than four options', { question: 'Which approach?', header: 'Approach', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }, { label: 'C', description: 'c' }, { label: 'D', description: 'd' }, { label: 'E', description: 'e' }], multiSelect: false }, '2-4 options'],
    ['an option without a description', { question: 'Which approach?', header: 'Approach', options: [{ label: 'A' }, { label: 'B', description: 'b' }], multiSelect: false }, 'description must be a string'],
    ['two options sharing a label', { question: 'Which approach?', header: 'Approach', options: [{ label: 'A', description: 'a' }, { label: 'A', description: 'b' }], multiSelect: false }, 'option labels must be unique within each question'],
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
    // A missing header falls back to the question text at full length — the chip clips it at render, so
    // cutting it here would only throw away text a wider surface can still show.
    expect(q.header).toBe('Which colour?');
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

  // The preview is the only part of the question the model never saw rendered, so an answer that names
  // only the label leaves it reconstructing what the user actually compared.
  it('carries the preview of the chosen option back with the answer', async () => {
    const { formatAnswers } = await load();
    const withPreviews = [{
      question: 'Which layout?',
      options: [
        { label: 'Grid', description: 'cards', preview: 'A | B' },
        { label: 'List', description: 'rows', preview: 'A\nB' },
      ],
    }];
    const out = formatAnswers(withPreviews, [{ selected: ['List'] }]);
    expect(out).toContain('"Which layout?" = "List"');
    expect(out).toContain('selected preview: A\nB');
    expect(out).not.toContain('A | B'); // only the CHOSEN option's preview comes back
  });
});

describe('AskUserQuestion — batch validation', () => {
  const ask = async (questions: unknown) => {
    const tools: RegisteredTool[] = [];
    const { register } = await load();
    register({
      registerTool: (tool: RegisteredTool) => tools.push(tool),
      registerSystemPromptFragment: () => undefined,
      askUser: async (qs: Normalized[]) => qs.map((q) => ({ header: q.header, selected: [q.options[0]!.label] })),
      logger: { info: () => undefined },
    });
    return (await tools[0]!.execute('t', { questions })).content[0]!.text;
  };
  const question = (text: string) => ({
    question: text,
    header: 'Pick',
    multiSelect: false,
    options: [{ label: 'One', description: 'first' }, { label: 'Two', description: 'second' }],
  });

  it('rejects two questions with the same text in one batch', async () => {
    // Answers are index-aligned, so a repeated question text makes the answer block ambiguous. Same rule
    // and same wording as the reference's uniqueness refine.
    expect(await ask([question('Which one?'), question('Which one?')]))
      .toContain('Question texts must be unique, option labels must be unique within each question');
    expect(await ask([question('Which one?'), question('Which other one?')])).toContain('User answered:');
  });
});
