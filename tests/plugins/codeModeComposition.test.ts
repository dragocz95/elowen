import { afterEach, describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { composeSessionTools, refusedToolResultText } from '../../src/brain/session/capabilities.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import { Cell } from '../../plugins/code-mode/src/runtime/cell.js';
import type { CodeModeOutputItem } from '../../plugins/code-mode/src/protocol/output.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => ['/repo'] } as unknown as Policy;

function tool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id: string, params: unknown) => ({
      content: [{ type: 'text' as const, text: `ran ${name} ${JSON.stringify(params)}` }],
      details: {},
    }),
  } as unknown as ToolDefinition;
}

const pair = (): ToolDefinition[] => [tool('exec'), tool('wait')];

describe('composeSessionTools with code mode', () => {
  it('leaves the tool set untouched when no code-mode composer is wired', () => {
    const tools = composeSessionTools({ kind: 'trusted-channel', pluginTools: [tool('Read')] });
    expect(tools.map((t) => t.name)).toEqual(['Read']);
  });

  it('appends the code-mode pair after the session tools', () => {
    const tools = composeSessionTools({
      kind: 'trusted-channel',
      pluginTools: [tool('Read'), tool('Bash')],
      codeMode: () => pair(),
    });
    expect(tools.map((t) => t.name)).toEqual(['Read', 'Bash', 'exec', 'wait']);
  });

  it('hands the composer the GATED definitions, so a nested call takes the deny gate', async () => {
    let nested: ToolDefinition[] = [];
    const tools = composeSessionTools({
      kind: 'trusted-channel',
      pluginTools: [tool('Read')],
      codeMode: (gated) => { nested = gated; return pair(); },
    });
    expect(tools.length).toBe(3);
    expect(nested.map((t) => t.name)).toEqual(['Read']);

    const read = nested[0]!;
    const denied = await runWithPolicy(POLICY, () => read.execute('id', { path: '/x' } as never, undefined, undefined, undefined as never), {
      toolPolicy: { deny: new Set(['Read']) },
    });
    expect(refusedToolResultText(denied)).toContain('The tool "Read" is not available to you');

    const allowed = await runWithPolicy(POLICY, () => read.execute('id', { path: '/x' } as never, undefined, undefined, undefined as never), {
      toolPolicy: { deny: new Set<string>() },
    });
    expect(refusedToolResultText(allowed)).toBeUndefined();
  });

  it('gates the code-mode pair itself, so denying exec switches code mode off', async () => {
    const tools = composeSessionTools({
      kind: 'trusted-channel',
      pluginTools: [tool('Read')],
      codeMode: () => pair(),
    });
    const exec = tools.find((t) => t.name === 'exec')!;
    const result = await runWithPolicy(POLICY, () => exec.execute('id', { path: 'x' } as never, undefined, undefined, undefined as never), {
      toolPolicy: { deny: new Set(['exec']) },
    });
    expect(refusedToolResultText(result)).toContain('The tool "exec" is not available to you');
  });
});

describe('a denied nested call inside a script', () => {
  const cells: Cell[] = [];
  afterEach(async () => { await Promise.all(cells.splice(0).map((cell) => cell.dispose())); });

  function textOf(items: CodeModeOutputItem[]): string[] {
    return items.filter((item) => item.type === 'text').map((item) => (item.type === 'text' ? item.text : ''));
  }

  /** The whole point of routing nested calls through the composed definitions: a tool the turn's policy
   *  denies must FAIL inside the script, not hand the script a refusal sentence that reads like output. */
  it('rejects rather than resolving with the refusal text', async () => {
    const [read] = composeSessionTools({ kind: 'trusted-channel', pluginTools: [tool('Read')] });
    const cell = new Cell({
      cellId: '1',
      source: `
        try {
          await tools.Read({ path: '/etc/hostname' });
          text('REACHED');
        } catch (error) {
          text('blocked: ' + error);
        }
      `,
      tools: [{ name: 'Read', globalName: 'Read', description: 'Read tool', kind: 'function' }],
      storedValues: {},
      maxHeapMb: 64,
      invokeTool: async ({ input }) => {
        const result = await runWithPolicy(
          POLICY,
          () => read!.execute('id', input as never, undefined, undefined, undefined as never),
          { toolPolicy: { deny: new Set(['Read']) } },
        );
        const refusal = refusedToolResultText(result);
        if (refusal !== undefined) throw new Error(refusal);
        return result;
      },
      notify: () => {},
      commitStoredWrites: () => {},
    });
    cells.push(cell);

    const observation = await cell.observe(5_000);
    expect(observation.kind).toBe('completed');
    expect(textOf(observation.items)).toEqual([
      'blocked: The tool "Read" is not available to you in this conversation.',
    ]);
  });
});
