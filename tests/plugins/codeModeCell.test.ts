import { afterEach, describe, expect, it } from 'vitest';
import { Cell, resolveYieldTime, type CellOptions } from '../../plugins/code-mode/src/runtime/cell.js';
import type { CodeModeOutputItem } from '../../plugins/code-mode/src/protocol/output.js';

const openCells: Cell[] = [];

afterEach(async () => {
  await Promise.all(openCells.splice(0).map((cell) => cell.dispose()));
});

interface RunResult {
  kind: string;
  items: CodeModeOutputItem[];
  errorText?: string;
  notifications: string[];
  storedWrites: Record<string, unknown>;
}

function startCell(source: string, overrides: Partial<CellOptions> = {}): {
  cell: Cell;
  notifications: string[];
  storedWrites: Record<string, unknown>;
} {
  const notifications: string[] = [];
  const storedWrites: Record<string, unknown> = {};
  const cell = new Cell({
    cellId: '1',
    source,
    tools: [
      { name: 'read_file', globalName: 'read_file', description: 'Reads a file', kind: 'function' },
      { name: 'failing', globalName: 'failing', description: 'Always fails', kind: 'function' },
      { name: 'echo', globalName: 'echo', description: 'Echoes', kind: 'freeform' },
    ],
    storedValues: {},
    maxHeapMb: 64,
    invokeTool: async ({ name, input }) => {
      if (name === 'failing') throw new Error('tool blew up');
      if (name === 'echo') return { echoed: input };
      return { content: `contents of ${(input as { path?: string } | undefined)?.path ?? 'nothing'}` };
    },
    notify: (text) => notifications.push(text),
    commitStoredWrites: (writes) => Object.assign(storedWrites, writes),
    ...overrides,
  });
  openCells.push(cell);
  return { cell, notifications, storedWrites };
}

async function run(source: string, overrides: Partial<CellOptions> = {}): Promise<RunResult> {
  const { cell, notifications, storedWrites } = startCell(source, overrides);
  const observation = await cell.observe(5_000);
  return { ...observation, notifications, storedWrites };
}

function textOf(items: CodeModeOutputItem[]): string[] {
  return items.filter((item) => item.type === 'text').map((item) => (item.type === 'text' ? item.text : ''));
}

describe('cell runtime', () => {
  it('runs a chain of dependent tool calls in a single cell', async () => {
    const result = await run(`
      const file = await tools.read_file({ path: '/etc/hostname' });
      text(file.content.toUpperCase());
    `);
    expect(result.kind).toBe('completed');
    expect(result.errorText).toBeUndefined();
    expect(textOf(result.items)).toEqual(['CONTENTS OF /ETC/HOSTNAME']);
  });

  it('runs independent tool calls concurrently', async () => {
    const result = await run(`
      const [a, b] = await Promise.all([
        tools.read_file({ path: 'a' }),
        tools.read_file({ path: 'b' }),
      ]);
      text(a.content + ' | ' + b.content);
    `);
    expect(textOf(result.items)).toEqual(['contents of a | contents of b']);
  });

  it('rejects a failing tool with a plain string, as Codex does', async () => {
    const result = await run(`
      try { await tools.failing({}); } catch (error) { text('caught: ' + error + ' / ' + typeof error); }
    `);
    expect(textOf(result.items)).toEqual(['caught: tool blew up / string']);
  });

  it('passes a string input to a freeform tool', async () => {
    const result = await run(`
      const result = await tools.echo('hello');
      text(result.echoed);
    `);
    expect(textOf(result.items)).toEqual(['hello']);
  });

  it('reports a script exception with its stack and keeps earlier output', async () => {
    const result = await run(`
      text('before');
      throw new Error('boom');
    `);
    expect(result.kind).toBe('completed');
    expect(textOf(result.items)).toEqual(['before']);
    expect(result.errorText).toContain('Error: boom');
    expect(result.errorText).toContain('exec_main.mjs');
  });

  it('treats exit() as clean success', async () => {
    const result = await run(`
      text('before');
      exit();
      text('after');
    `);
    expect(result.errorText).toBeUndefined();
    expect(textOf(result.items)).toEqual(['before']);
  });

  it('stringifies non-string values like Codex', async () => {
    const result = await run(`
      text(1);
      text(true);
      text(null);
      text(undefined);
      text({ a: 1 });
    `);
    expect(textOf(result.items)).toEqual(['1', 'true', 'null', 'undefined', '{"a":1}']);
  });

  it('exposes ALL_TOOLS so a script can discover tools it was not told about', async () => {
    const result = await run(`
      const found = ALL_TOOLS.filter((tool) => tool.description.includes('Reads'));
      const call = await tools[found[0].name]({ path: 'x' });
      text(found.length + ':' + call.content);
    `);
    expect(textOf(result.items)).toEqual(['1:contents of x']);
  });

  it('delivers notify() immediately and keeps it out of the cell output', async () => {
    const result = await run(`
      notify('halfway');
      text('done');
    `);
    expect(result.notifications).toEqual(['halfway']);
    expect(textOf(result.items)).toEqual(['done']);
  });

  it('rejects blank notify text', async () => {
    const result = await run(`
      try { notify('  '); } catch (error) { text(String(error)); }
    `);
    expect(textOf(result.items)).toEqual(['notify expects non-empty text']);
  });

  it('accepts a data URL image and rejects a remote one', async () => {
    const result = await run(`
      image('data:image/png;base64,AAAA');
      try { image('https://example.com/a.png'); } catch (error) { text(String(error)); }
    `);
    expect(result.items[0]).toEqual({ type: 'image', imageUrl: 'data:image/png;base64,AAAA' });
    expect(textOf(result.items)).toEqual([
      'Tool call failed: remote image URLs are not supported in tool outputs. Pass a base64 data URI instead',
    ]);
  });

  it('commits store writes only after the cell completes', async () => {
    const result = await run(`
      store('key', { value: 42 });
      text(JSON.stringify(load('key')));
      text(String(load('missing')));
    `);
    expect(textOf(result.items)).toEqual(['{"value":42}', 'undefined']);
    expect(result.storedWrites).toEqual({ key: { value: 42 } });
  });

  it('reads stored values seeded from the session', async () => {
    const result = await run('text(JSON.stringify(load("seeded")));', {
      storedValues: { seeded: [1, 2, 3] },
    });
    expect(textOf(result.items)).toEqual(['[1,2,3]']);
  });
});

describe('cell isolation', () => {
  it('hides Node globals and the module system', async () => {
    const result = await run(`
      text(JSON.stringify({
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        console: typeof console,
        Buffer: typeof Buffer,
        WebAssembly: typeof WebAssembly,
      }));
    `);
    expect(textOf(result.items)).toEqual([
      '{"process":"undefined","require":"undefined","fetch":"undefined","console":"undefined","Buffer":"undefined","WebAssembly":"undefined"}',
    ]);
  });

  it('rejects dynamic import', async () => {
    const result = await run(`
      try { await import('node:fs'); text('REACHED'); } catch (error) { text('blocked'); }
    `);
    expect(textOf(result.items)).toEqual(['blocked']);
  });

  /**
   * The escape a naive `vm` port allows: reaching the host realm through the prototype of any
   * function handed into the sandbox. Every global must be a function of the context itself.
   */
  it('cannot reach the worker realm through a global function constructor', async () => {
    const result = await run(`
      const escaped = text.constructor.constructor('return typeof process')();
      text('escaped:' + escaped);
    `);
    expect(textOf(result.items)).toEqual(['escaped:undefined']);
  });

  it('cannot reach the worker realm through the tools object', async () => {
    const result = await run(`
      const escaped = tools.read_file.constructor.constructor('return typeof require')();
      text('escaped:' + escaped);
    `);
    expect(textOf(result.items)).toEqual(['escaped:undefined']);
  });

  it('does not leave the bridge reachable from the script', async () => {
    const result = await run(`
      text(typeof globalThis.__codeModeSend + '/' + typeof globalThis.__codeModeConfig);
    `);
    expect(textOf(result.items)).toEqual(['undefined/undefined']);
  });
});

describe('cell yielding and termination', () => {
  it('yields while the script keeps running, then reports completion on the next observe', async () => {
    const { cell } = startCell(`
      text('first');
      await new Promise((resolve) => setTimeout(resolve, 250));
      text('second');
    `);

    const yielded = await cell.observe(60);
    expect(yielded.kind).toBe('yielded');
    expect(textOf(yielded.items)).toEqual(['first']);

    const completed = await cell.observe(5_000);
    expect(completed.kind).toBe('completed');
    // A wait returns only what is new since the last yield.
    expect(textOf(completed.items)).toEqual(['second']);
  });

  it('flushes immediately on yield_control()', async () => {
    const { cell } = startCell(`
      text('early');
      yield_control();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      text('late');
    `);
    const started = Date.now();
    const yielded = await cell.observe(5_000);
    expect(yielded.kind).toBe('yielded');
    expect(textOf(yielded.items)).toEqual(['early']);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('terminates a runaway loop and keeps the output produced before it', async () => {
    const { cell } = startCell(`
      text('before');
      while (true) {}
    `);
    const yielded = await cell.observe(120);
    expect(yielded.kind).toBe('yielded');
    expect(textOf(yielded.items)).toEqual(['before']);

    await cell.terminate();
    const terminated = await cell.observe(1_000);
    expect(terminated.kind).toBe('terminated');
  });

  it('discards store writes from a terminated cell', async () => {
    const { cell, storedWrites } = startCell(`
      store('key', 1);
      while (true) {}
    `);
    await cell.observe(120);
    await cell.terminate();
    expect(storedWrites).toEqual({});
  });

  it('refuses a second concurrent observer', async () => {
    const { cell } = startCell('await new Promise((resolve) => setTimeout(resolve, 500));');
    const first = cell.observe(300);
    await expect(cell.observe(300)).rejects.toThrow('exec cell 1 already has an active observer');
    await first;
  });
});

describe('resolveYieldTime', () => {
  it('adds a grace period from ten seconds up and clamps to the session maximum', () => {
    expect(resolveYieldTime(9_999, 600_000)).toBe(9_999);
    expect(resolveYieldTime(10_000, 600_000)).toBe(11_000);
    expect(resolveYieldTime(10_000, 10_000)).toBe(10_000);
  });
});
