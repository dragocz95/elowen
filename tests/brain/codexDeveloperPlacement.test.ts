import { describe, expect, it } from 'vitest';
import { codexDeveloperPayload } from '../../src/brain/session/codexDeveloperPlacement.js';

/** A body in the shape pi-ai builds today (`openai-codex-responses.js:391-402`), trimmed to the fields
 *  this transform reads or moves. */
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'gpt-5.6-luna',
  store: false,
  stream: true,
  instructions: 'You are Elowen.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  text: { verbosity: 'low' },
  include: ['reasoning.encrypted_content'],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  tools: [{ type: 'function', name: 'exec' }, { type: 'function', name: 'wait' }],
  ...over,
});

describe('codexDeveloperPayload', () => {
  it('splices tools then the prompt into input as developer items, in Codex order', () => {
    const next = codexDeveloperPayload(body())!;
    expect(next.instructions).toBe('');
    expect(next.tools).toBeUndefined();
    expect('tools' in next).toBe(false);
    expect(next.input).toEqual([
      {
        type: 'additional_tools',
        role: 'developer',
        // One `functions` namespace holding every tool — Codex's lite declaration, not the flat array.
        tools: [{
          type: 'namespace',
          name: 'functions',
          description: '',
          tools: [{ type: 'function', name: 'exec' }, { type: 'function', name: 'wait' }],
        }],
      },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Elowen.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it("normalises pi-ai's null `strict` to the boolean Codex declares", () => {
    const next = codexDeveloperPayload(body({
      tools: [{ type: 'function', name: 'wait', strict: null }, { type: 'custom', name: 'exec' }],
    }))!;
    const [namespace] = next.input as [{ tools: [{ tools: unknown[] }] }];
    expect(namespace.tools[0].tools).toEqual([
      { type: 'function', name: 'wait', strict: false },
      { type: 'custom', name: 'exec' },
    ]);
  });

  it('carries reasoning state across the thread, the way Codex does for these models', () => {
    const withReasoning = codexDeveloperPayload(body({ reasoning: { effort: 'high', summary: 'concise' } }))!;
    expect(withReasoning.reasoning).toEqual({ effort: 'high', summary: 'concise', context: 'all_turns' });
    // A body carrying no reasoning object is left without one rather than given an invented default.
    expect(codexDeveloperPayload(body())!.reasoning).toBeUndefined();
  });

  it('turns parallel tool calls off and leaves every other field untouched', () => {
    const next = codexDeveloperPayload(body())!;
    expect(next.parallel_tool_calls).toBe(false);
    expect(next.model).toBe('gpt-5.6-luna');
    expect(next.store).toBe(false);
    expect(next.stream).toBe(true);
    expect(next.text).toEqual({ verbosity: 'low' });
    expect(next.include).toEqual(['reasoning.encrypted_content']);
    expect(next.tool_choice).toBe('auto');
  });

  it('carries a body with no tools, since a turn can be composed without any', () => {
    const next = codexDeveloperPayload(body({ tools: [] }))!;
    expect(next.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Elowen.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  // `undefined` is pi's "leave it alone". A second pass must not splice a second copy of the prompt, and
  // a body this transform cannot read must never be rewritten on a guess.
  it('answers unchanged for its own output and for anything it does not recognise', () => {
    const once = codexDeveloperPayload(body())!;
    expect(codexDeveloperPayload(once)).toBeUndefined();
    expect(codexDeveloperPayload(body({ instructions: '' }))).toBeUndefined();
    expect(codexDeveloperPayload(body({ input: 'not an array' }))).toBeUndefined();
    expect(codexDeveloperPayload(body({ instructions: 42 }))).toBeUndefined();
    expect(codexDeveloperPayload(null)).toBeUndefined();
    expect(codexDeveloperPayload([])).toBeUndefined();
  });

  it('does not mutate the body it was given', () => {
    const original = body();
    const snapshot = JSON.parse(JSON.stringify(original)) as unknown;
    codexDeveloperPayload(original);
    expect(original).toEqual(snapshot);
  });
});
