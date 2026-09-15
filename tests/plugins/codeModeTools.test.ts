import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
// Imported straight from the installed package: the point of these tests is what pi-ai ACTUALLY does
// with our tool definition, not what we believe it does.
import { resolveGrammarConstrainedSampling } from '../../node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js';
import { buildCodeModeTools, type NestedToolBinding } from '../../plugins/code-mode/src/tools.js';
import { CodeModeSession } from '../../plugins/code-mode/src/runtime/session.js';

const sessions: CodeModeSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.shutdown()));
});

interface Harness {
  exec: { name: string; description: string; parameters: unknown; constrainedSampling?: unknown; execute: Function };
  wait: { name: string; execute: Function };
  session: CodeModeSession;
  notifications: string[];
  reported: { name: string; ok: boolean; error?: string }[][];
}

function harness(overrides: { nested?: NestedToolBinding[]; codeModeOnly?: boolean } = {}): Harness {
  const session = new CodeModeSession();
  sessions.push(session);
  const notifications: string[] = [];
  const reported: { name: string; ok: boolean; error?: string }[][] = [];
  const nested = overrides.nested ?? [
    {
      name: 'read_file',
      globalName: 'read_file',
      description: 'Reads a file',
      kind: 'function',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      outputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      deferred: false,
      invoke: async (input) => ({ content: `contents of ${(input as { path: string }).path}` }),
    },
  ];
  const [exec, wait] = buildCodeModeTools({
    session: () => session,
    nested,
    codeModeOnly: overrides.codeModeOnly ?? true,
    notify: (text) => notifications.push(text),
    reportNestedCalls: (calls) => reported.push(calls),
  });
  return { exec: exec as never, wait: wait as never, session, notifications, reported };
}

function textOf(result: { content: { type: string; text?: string }[] }): string[] {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
}

describe('exec tool definition', () => {
  it('is named exec and takes exactly one required string property', () => {
    const { exec } = harness();
    expect(exec.name).toBe('exec');
    const parameters = exec.parameters as { type: string; required?: string[]; properties: Record<string, { type: string }> };
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['source']);
    expect(parameters.properties.source?.type).toBe('string');
  });

  it('is accepted by pi-ai as a lark grammar tool', () => {
    const { exec } = harness();
    const resolved = resolveGrammarConstrainedSampling(exec, true);
    expect(resolved).toEqual({
      format: 'lark',
      definition: expect.stringContaining('PRAGMA_LINE'),
      inputProperty: 'source',
    });
  });

  it('degrades to an ordinary function tool when the model has no grammar support', () => {
    const { exec } = harness();
    expect(resolveGrammarConstrainedSampling(exec, false)).toBeUndefined();
  });

  it('targets models whose catalog entry advertises grammar tools', () => {
    const catalog = JSON.parse(
      readFileSync('node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json', 'utf8'),
    ) as Record<string, Record<string, { compat?: { supportsOpenAIGrammarTools?: boolean } }>>;
    // The catalog is keyed by api, then by model id.
    const models = catalog['openai-codex-responses']!;
    expect(models['gpt-5.6-sol']?.compat?.supportsOpenAIGrammarTools).toBe(true);
    expect(models['gpt-5.6-luna']?.compat?.supportsOpenAIGrammarTools).toBe(true);
    expect(models['gpt-6-astra']?.compat?.supportsOpenAIGrammarTools).toBe(true);
  });

  it('lists nested tools as typed declarations under code_mode_only', () => {
    const { exec } = harness();
    expect(exec.description).toContain('### `read_file`');
    expect(exec.description).toContain('read_file(args: { path: string; }): Promise<{ content: string; }>;');
  });
});

describe('exec execution', () => {
  it('returns the status header and the script output', async () => {
    const { exec } = harness();
    const result = await exec.execute('call-1', { source: "text('hello');" });
    const texts = textOf(result);
    expect(texts[0]).toMatch(/^Script completed\nWall time \d+\.\d seconds\nOutput:\n$/);
    expect(texts[1]).toBe('hello');
    expect(result.details.success).toBe(true);
  });

  it('dispatches a nested call through the binding and reports it', async () => {
    const { exec, reported } = harness();
    const result = await exec.execute('call-1', {
      source: "const file = await tools.read_file({ path: 'a.txt' });\ntext(file.content);",
    });
    expect(textOf(result)[1]).toBe('contents of a.txt');
    expect(reported).toEqual([[{ name: 'read_file', ok: true }]]);
  });

  it('surfaces a denied nested call as a rejection inside the script', async () => {
    const { exec, reported } = harness({
      nested: [{
        name: 'Bash',
        globalName: 'Bash',
        description: 'Runs a command',
        kind: 'function',
        deferred: false,
        invoke: async () => {
          throw new Error('Tool Bash is not permitted in this conversation.');
        },
      }],
    });
    const result = await exec.execute('call-1', {
      source: "try { await tools.Bash({ command: 'ls' }); text('RAN'); } catch (error) { text('refused: ' + error); }",
    });
    expect(textOf(result)[1]).toBe('refused: Tool Bash is not permitted in this conversation.');
    expect(reported[0]).toEqual([
      { name: 'Bash', ok: false, error: 'Tool Bash is not permitted in this conversation.' },
    ]);
  });

  it('reports a script exception as a failed result without failing the turn', async () => {
    const { exec } = harness();
    const result = await exec.execute('call-1', { source: "text('before');\nthrow new Error('boom');" });
    const joined = textOf(result).join('\n');
    expect(joined).toContain('Script failed');
    expect(joined).toContain('Script error:\nError: boom');
    expect(result.details.success).toBe(false);
  });

  it('returns the parser message for a malformed pragma instead of throwing', async () => {
    const { exec } = harness();
    const result = await exec.execute('call-1', { source: '// @exec: {"nope": 1}\ntext(1);' });
    expect(textOf(result)).toEqual([
      'exec pragma only supports `yield_time_ms` and `max_output_tokens`; got `nope`',
    ]);
  });

  it('returns the parser message for empty input', async () => {
    const { exec } = harness();
    const result = await exec.execute('call-1', { source: '   ' });
    expect(textOf(result)[0]).toContain('exec expects raw JavaScript source text (non-empty)');
  });

  it('honours the max_output_tokens pragma', async () => {
    const { exec } = harness();
    const result = await exec.execute('call-1', {
      source: `// @exec: {"max_output_tokens": 5}\ntext('0123456789'.repeat(8));`,
    });
    expect(textOf(result).join('\n')).toContain('tokens truncated');
  });

  it('delivers notify() to the host while the script runs', async () => {
    const { exec, notifications } = harness();
    await exec.execute('call-1', { source: "notify('halfway');\ntext('done');" });
    expect(notifications).toEqual(['halfway']);
  });

  it('returns an image block for an image item', async () => {
    const { exec } = harness();
    const result = await exec.execute('call-1', { source: "image('data:image/png;base64,AAAA');" });
    expect(result.content).toContainEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
  });
});

describe('exec yielding and wait', () => {
  it('yields with a cell id the wait tool can resume', async () => {
    const { exec, wait } = harness();
    const yielded = await exec.execute('call-1', {
      source: `// @exec: {"yield_time_ms": 80}\ntext('first');\nawait new Promise((r) => setTimeout(r, 300));\ntext('second');`,
    });
    const header = textOf(yielded)[0] ?? '';
    expect(header).toMatch(/^Script running with cell ID \d+\n/);
    expect(textOf(yielded)[1]).toBe('first');

    const cellId = header.slice('Script running with cell ID '.length).split('\n')[0]!;
    const resumed = await wait.execute('call-2', { cell_id: cellId, yield_time_ms: 5_000 });
    expect(textOf(resumed)[0]).toMatch(/^Script completed\n/);
    expect(textOf(resumed)[1]).toBe('second');
  });

  it('reports an unknown cell with the Codex wording and marks the result failed', async () => {
    const { wait } = harness();
    const result = await wait.execute('call-2', { cell_id: '42' });
    const joined = textOf(result).join('\n');
    expect(joined).toContain('Script failed');
    expect(joined).toContain('Script error:\nexec cell 42 not found');
    expect(result.details.success).toBe(false);
  });

  it('terminates a runaway cell on request', async () => {
    const { exec, wait } = harness();
    const yielded = await exec.execute('call-1', {
      source: `// @exec: {"yield_time_ms": 100}\ntext('before');\nwhile (true) {}`,
    });
    const cellId = (textOf(yielded)[0] ?? '').slice('Script running with cell ID '.length).split('\n')[0]!;
    const terminated = await wait.execute('call-2', { cell_id: cellId, terminate: true });
    expect(textOf(terminated)[0]).toMatch(/^Script terminated\n/);
  });
});
