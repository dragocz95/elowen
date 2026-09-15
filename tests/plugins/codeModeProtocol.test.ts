import { describe, expect, it } from 'vitest';
import {
  CODE_MODE_FREEFORM_GRAMMAR,
  ExecSourceError,
  parseExecSource,
} from '../../plugins/code-mode/src/protocol/execSource.js';
import { normalizeCodeModeIdentifier } from '../../plugins/code-mode/src/protocol/identifiers.js';
import { renderJsonSchemaToTypescript } from '../../plugins/code-mode/src/protocol/jsonSchemaTypes.js';
import {
  buildExecToolDescription,
  buildWaitToolDescription,
  sortAndDedupeToolDefinitions,
  type CodeModeToolDefinition,
} from '../../plugins/code-mode/src/protocol/description.js';

/** The grammar is a contract with the provider's constrained sampler: one wrong escape and the
 *  model can no longer emit a pragma line. Pinned against the literal Codex text. */
describe('exec freeform grammar', () => {
  it('matches the Codex grammar byte for byte', () => {
    const expected = [
      '',
      'start: pragma_source | plain_source',
      'pragma_source: PRAGMA_LINE NEWLINE SOURCE',
      'plain_source: SOURCE',
      '',
      String.raw`PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/`,
      String.raw`NEWLINE: /\r?\n/`,
      String.raw`SOURCE: /[\s\S]+/`,
      '',
    ].join('\n');
    expect(CODE_MODE_FREEFORM_GRAMMAR).toBe(expected);
  });
});

describe('parseExecSource', () => {
  it('returns the source unchanged when there is no pragma', () => {
    expect(parseExecSource("text('hi')")).toEqual({ code: "text('hi')" });
  });

  it('strips the pragma line and reads its fields', () => {
    expect(parseExecSource('// @exec: {"yield_time_ms": 10}\ntext(\'hi\')')).toEqual({
      code: "text('hi')",
      yieldTimeMs: 10,
      maxOutputTokens: undefined,
    });
  });

  it('accepts leading whitespace before the pragma', () => {
    const parsed = parseExecSource('   // @exec: {"max_output_tokens": 50}\nexit()');
    expect(parsed.code).toBe('exit()');
    expect(parsed.maxOutputTokens).toBe(50);
  });

  it('keeps a pragma-looking line that is not on the first line as source', () => {
    const source = "text('hi')\n// @exec: {\"yield_time_ms\": 10}";
    expect(parseExecSource(source)).toEqual({ code: source });
  });

  it('rejects empty input', () => {
    expect(() => parseExecSource('   ')).toThrow(ExecSourceError);
    expect(() => parseExecSource('')).toThrow(/exec expects raw JavaScript source text \(non-empty\)/);
  });

  it('rejects a pragma with no source after it', () => {
    expect(() => parseExecSource('// @exec: {"yield_time_ms": 10}\n   ')).toThrow(
      'exec pragma must be followed by JavaScript source on subsequent lines',
    );
  });

  it('rejects an empty pragma directive', () => {
    expect(() => parseExecSource('// @exec:\ntext(1)')).toThrow(
      'exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`',
    );
  });

  it('rejects invalid JSON in the pragma', () => {
    expect(() => parseExecSource('// @exec: {nope}\ntext(1)')).toThrow(
      /^exec pragma must be valid JSON with supported fields/,
    );
  });

  it('rejects a non-object pragma', () => {
    expect(() => parseExecSource('// @exec: [1,2]\ntext(1)')).toThrow(
      'exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`',
    );
  });

  it('rejects unknown pragma fields', () => {
    expect(() => parseExecSource('// @exec: {"nope": 1}\ntext(1)')).toThrow(
      'exec pragma only supports `yield_time_ms` and `max_output_tokens`; got `nope`',
    );
  });

  it('rejects non-integer and negative pragma values', () => {
    expect(() => parseExecSource('// @exec: {"yield_time_ms": 1.5}\ntext(1)')).toThrow(
      /must be non-negative safe integers/,
    );
    expect(() => parseExecSource('// @exec: {"max_output_tokens": -1}\ntext(1)')).toThrow(
      /must be non-negative safe integers/,
    );
  });

  it('rejects pragma values beyond the safe integer range', () => {
    expect(() => parseExecSource('// @exec: {"yield_time_ms": 9007199254740993}\ntext(1)')).toThrow(
      'exec pragma field `yield_time_ms` must be a non-negative safe integer',
    );
  });
});

describe('normalizeCodeModeIdentifier', () => {
  it('keeps valid identifiers unchanged', () => {
    expect(normalizeCodeModeIdentifier('mcp__ologs__get_profile')).toBe('mcp__ologs__get_profile');
  });

  it('rewrites invalid characters', () => {
    expect(normalizeCodeModeIdentifier('hidden-dynamic-tool')).toBe('hidden_dynamic_tool');
  });

  it('rewrites a leading digit', () => {
    expect(normalizeCodeModeIdentifier('1tool')).toBe('_tool');
  });

  it('returns an underscore for an empty name', () => {
    expect(normalizeCodeModeIdentifier('')).toBe('_');
  });

  it('replaces each non-ascii code point with exactly one underscore', () => {
    expect(normalizeCodeModeIdentifier('tooléé')).toBe('tool__');
  });
});

describe('renderJsonSchemaToTypescript', () => {
  it('renders a flat object inline', () => {
    const rendered = renderJsonSchemaToTypescript({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    });
    expect(rendered).toBe('{ city: string; }');
  });

  it('marks properties outside required as optional', () => {
    const rendered = renderJsonSchemaToTypescript({
      type: 'object',
      properties: { city: { type: 'string' }, limit: { type: 'integer' } },
      required: ['city'],
      additionalProperties: false,
    });
    expect(rendered).toBe('{ city: string; limit?: number; }');
  });

  it('renders descriptions as comments on a multi-line object', () => {
    const rendered = renderJsonSchemaToTypescript({
      type: 'object',
      properties: {
        weather: {
          type: 'array',
          description: 'look up weather for a given list of locations',
          items: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      },
      required: ['weather'],
    });
    expect(rendered).toBe(
      ['{', '  // look up weather for a given list of locations', '  weather: Array<{ location: string; }>;', '}'].join('\n'),
    );
  });

  it('renders an empty object as {}', () => {
    expect(renderJsonSchemaToTypescript({ type: 'object', properties: {}, additionalProperties: false })).toBe('{}');
  });

  it('renders an index signature for an open object without properties', () => {
    expect(renderJsonSchemaToTypescript({ type: 'object' })).toBe('{ [key: string]: unknown; }');
  });

  it('renders enums and consts as literal unions', () => {
    expect(renderJsonSchemaToTypescript({ enum: ['a', 'b'] })).toBe('"a" | "b"');
    expect(renderJsonSchemaToTypescript({ const: 7 })).toBe('7');
  });

  it('renders unions and intersections', () => {
    expect(renderJsonSchemaToTypescript({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
    expect(
      renderJsonSchemaToTypescript({
        allOf: [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, { type: 'boolean' }],
      }),
    ).toBe('(string | number) & boolean');
  });

  it('quotes property names that are not valid identifiers', () => {
    expect(
      renderJsonSchemaToTypescript({
        type: 'object',
        properties: { 'content-type': { type: 'string' } },
        required: ['content-type'],
      }),
    ).toBe('{ "content-type": string; }');
  });

  it('resolves a local $ref and decodes its pointer escapes', () => {
    const rendered = renderJsonSchemaToTypescript({
      type: 'object',
      properties: { item: { $ref: '#/definitions/Result~1item~0v1' } },
      required: ['item'],
      definitions: {
        'Result/item~v1': {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    });
    expect(rendered).toBe('{ item: { id: string; }; }');
  });

  it('bounds a recursive schema instead of expanding forever', () => {
    const rendered = renderJsonSchemaToTypescript({
      $id: 'root',
      type: 'object',
      properties: { child: { $ref: '#' } },
      required: ['child'],
    });
    expect(rendered).toContain('unknown');
    expect(rendered.length).toBeLessThan(500);
  });

  it('falls back to unknown for an unresolvable ref', () => {
    expect(renderJsonSchemaToTypescript({ $ref: '#/definitions/missing' })).toBe('unknown');
  });

  it('renders boolean schemas', () => {
    expect(renderJsonSchemaToTypescript(true)).toBe('unknown');
    expect(renderJsonSchemaToTypescript(false)).toBe('never');
  });
});

function toolDefinition(overrides: Partial<CodeModeToolDefinition> = {}): CodeModeToolDefinition {
  return {
    name: 'weather_tool',
    description: 'Weather tool',
    kind: 'function',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { forecast: { type: 'string' } },
      required: ['forecast'],
    },
    ...overrides,
  };
}

describe('buildExecToolDescription', () => {
  it('substitutes the configured yield time into the template', () => {
    const description = buildExecToolDescription({
      enabledTools: [],
      defaultExecYieldTimeMs: 30_000,
    });
    expect(description).toContain('`yield_time_ms` asks `exec` to yield early if the script is still running. Defaults to 30000 ms.');
    // Only the yield line carries the ms default; the token default keeps its own wording.
    expect(description).toContain('Defaults to 10000 tokens.');
  });

  it('advertises only the helpers the runtime actually installs', () => {
    const description = buildExecToolDescription({
      enabledTools: [],
      defaultExecYieldTimeMs: 10_000,
    });
    for (const helper of ['exit()', 'text(', 'image(', 'generatedImage(', 'store(', 'load(', 'notify(', 'setTimeout(', 'clearTimeout(', 'ALL_TOOLS', 'yield_control()']) {
      expect(description).toContain(helper);
    }
    // Elowen tool results carry no audio items, so the helper must not be promised.
    expect(description).not.toContain('audio(');
  });

  it('renders a typed declaration per tool', () => {
    const description = buildExecToolDescription({
      enabledTools: [toolDefinition()],
      defaultExecYieldTimeMs: 10_000,
    });
    expect(description).toContain('### `weather_tool`');
    expect(description).toContain('declare const tools: { weather_tool(args: { city: string; }): Promise<{ forecast: string; }>; };');
  });

  it('shows the normalised global next to the raw name when they differ', () => {
    const description = buildExecToolDescription({
      enabledTools: [toolDefinition({ name: 'hidden-dynamic-tool' })],
      defaultExecYieldTimeMs: 10_000,
    });
    expect(description).toContain('### `hidden_dynamic_tool` (`hidden-dynamic-tool`)');
  });

  it('renders freeform tools as taking a string input', () => {
    const description = buildExecToolDescription({
      enabledTools: [toolDefinition({ name: 'patch', kind: 'freeform', inputSchema: undefined, outputSchema: undefined })],
      defaultExecYieldTimeMs: 10_000,
    });
    expect(description).toContain('patch(input: string): Promise<unknown>;');
  });

  it('declares every tool it is given: a code-mode session withholds none', () => {
    // Code mode composes no tool deferral and no search (spawner), so there is no second class of tool
    // that would have to be discovered through `ALL_TOOLS` at runtime.
    const description = buildExecToolDescription({
      enabledTools: [toolDefinition({ name: 'first_tool' }), toolDefinition({ name: 'second_tool' })],
      defaultExecYieldTimeMs: 10_000,
    });
    expect(description).toContain('### `first_tool`');
    expect(description).toContain('### `second_tool`');
    expect(description).not.toContain('Some deferred nested tools may be omitted');
  });
});

describe('buildWaitToolDescription', () => {
  it('tells the model to use wait only after a yield', () => {
    expect(buildWaitToolDescription()).toContain('Use `wait` only after `exec` returns `Script running with cell ID ...`.');
  });
});

describe('sortAndDedupeToolDefinitions', () => {
  it('sorts by name and drops tools that normalise to the same global', () => {
    const result = sortAndDedupeToolDefinitions([
      toolDefinition({ name: 'zulu' }),
      toolDefinition({ name: 'alpha-one' }),
      toolDefinition({ name: 'alpha_one' }),
    ]);
    expect(result.map((tool) => tool.name)).toEqual(['alpha-one', 'zulu']);
  });
});
