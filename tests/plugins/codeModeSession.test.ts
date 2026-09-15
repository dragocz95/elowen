import { afterEach, describe, expect, it } from 'vitest';
import { CodeModeSession } from '../../plugins/code-mode/src/runtime/session.js';
import type { CellToolBinding } from '../../plugins/code-mode/src/runtime/protocolTypes.js';
import type { CodeModeOutputItem } from '../../plugins/code-mode/src/protocol/output.js';

const sessions: CodeModeSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.shutdown()));
});

const TOOLS: CellToolBinding[] = [
  { name: 'echo', globalName: 'echo', description: 'Echoes its input', kind: 'function' },
];

function newSession(): CodeModeSession {
  const session = new CodeModeSession();
  sessions.push(session);
  return session;
}

function start(session: CodeModeSession, source: string) {
  return session.start({
    source,
    tools: TOOLS,
    invokeTool: async ({ input }) => ({ echoed: input }),
    notify: () => {},
  });
}

function textOf(items: CodeModeOutputItem[]): string[] {
  return items.filter((item) => item.type === 'text').map((item) => (item.type === 'text' ? item.text : ''));
}

describe('CodeModeSession cell ids', () => {
  it('numbers cells from one, as decimal strings', () => {
    const session = newSession();
    expect(start(session, 'exit();').cellId).toBe('1');
    expect(start(session, 'exit();').cellId).toBe('2');
  });

  it('tracks open cells and hands them back by id', () => {
    const session = newSession();
    const cell = start(session, 'await new Promise(() => {});');
    expect(session.get(cell.cellId)).toBe(cell);
    expect(session.openCellIds).toEqual([cell.cellId]);
  });
});

describe('CodeModeSession.wait', () => {
  it('reports an unknown cell with the literal Codex wording', async () => {
    const session = newSession();
    await expect(session.wait('7', { yieldTimeMs: 10 })).resolves.toEqual({
      kind: 'missing',
      errorText: 'exec cell 7 not found',
    });
  });

  it('resumes a yielded cell and closes it once it completes', async () => {
    const session = newSession();
    const cell = start(session, `
      text('first');
      await new Promise((resolve) => setTimeout(resolve, 200));
      text('second');
    `);
    const first = await cell.observe(60);
    expect(first.kind).toBe('yielded');
    session.settleInitialObservation(cell.cellId, first);

    const second = await session.wait(cell.cellId, { yieldTimeMs: 5_000 });
    expect(second.kind).toBe('completed');
    expect('items' in second ? textOf(second.items) : []).toEqual(['second']);

    // The cell is gone once its result has been delivered.
    expect(session.openCellIds).toEqual([]);
    await expect(session.wait(cell.cellId, { yieldTimeMs: 10 })).resolves.toEqual({
      kind: 'missing',
      errorText: `exec cell ${cell.cellId} not found`,
    });
  });

  it('keeps a cell open while it is still yielding', async () => {
    const session = newSession();
    const cell = start(session, 'await new Promise((resolve) => setTimeout(resolve, 3000));');
    session.settleInitialObservation(cell.cellId, await cell.observe(60));
    const again = await session.wait(cell.cellId, { yieldTimeMs: 60 });
    expect(again.kind).toBe('yielded');
    expect(session.openCellIds).toEqual([cell.cellId]);
  });

  it('terminates a runaway cell on request and closes it', async () => {
    const session = newSession();
    const cell = start(session, "text('before'); while (true) {}");
    session.settleInitialObservation(cell.cellId, await cell.observe(120));

    const terminated = await session.wait(cell.cellId, { yieldTimeMs: 5_000, terminate: true });
    expect(terminated.kind).toBe('terminated');
    expect(session.openCellIds).toEqual([]);
  });
});

describe('CodeModeSession stored values', () => {
  it('shares store writes with a later cell once the writer completes', async () => {
    const session = newSession();
    const writer = start(session, "store('shared', { n: 1 });");
    session.settleInitialObservation(writer.cellId, await writer.observe(5_000));

    const reader = start(session, 'text(JSON.stringify(load("shared")));');
    const observation = await reader.observe(5_000);
    expect(textOf(observation.items)).toEqual(['{"n":1}']);
    expect(session.loadStoredValue('shared')).toEqual({ n: 1 });
  });

  it('does not show a later cell the writes of a terminated one', async () => {
    const session = newSession();
    const writer = start(session, "store('lost', 1); while (true) {}");
    await writer.observe(120);
    await session.wait(writer.cellId, { yieldTimeMs: 100, terminate: true });

    const reader = start(session, 'text(String(load("lost")));');
    expect(textOf((await reader.observe(5_000)).items)).toEqual(['undefined']);
  });
});

describe('CodeModeSession.resolveYieldTime', () => {
  it('applies the grace period and the session clamp', () => {
    const session = new CodeModeSession({ maxYieldTimeMs: 20_000 });
    sessions.push(session);
    expect(session.resolveYieldTime(9_999)).toBe(9_999);
    expect(session.resolveYieldTime(10_000)).toBe(11_000);
    expect(session.resolveYieldTime(60_000)).toBe(20_000);
  });
});

describe('CodeModeSession.shutdown', () => {
  it('disposes every open cell', async () => {
    const session = new CodeModeSession();
    const cell = session.start({
      source: 'await new Promise(() => {});',
      tools: TOOLS,
      invokeTool: async () => ({}),
      notify: () => {},
    });
    await session.shutdown();
    expect(session.openCellIds).toEqual([]);
    expect(cell.isClosed).toBe(true);
  });
});
