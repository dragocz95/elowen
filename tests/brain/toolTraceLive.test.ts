import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { createSpawnEventReducer } from '../../src/brain/service/spawnEventReducer.js';
import { createToolTraceSink } from '../../src/brain/toolTrace/sink.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { BrainEvent } from '../../src/brain/events.js';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/** The live half of `src/brain/toolTrace/`: the rows a producer publishes, and the wrapper row the
 *  reducer hides so those rows are not sitting under something that says nothing. */

function reducer(isCodeModeTool?: (name: string) => boolean) {
  const published: BrainEvent[] = [];
  const store = new BrainStore(openDb(':memory:'));
  const live = { discardingUserTurn: false, turnProducedOutput: false, lastAdmitted: undefined } as never;
  const run = createSpawnEventReducer({
    replay: { publish: (e: BrainEvent) => { published.push(e); } } as never,
    getLive: () => live,
    model: { id: 'gpt-5.6-sol', provider: 'openai-codex' } as never,
    sessionId: 'sess-1',
    session: {} as never,
    store,
    providerId: 'openai-codex',
    iconOf: () => undefined,
    queuedSteer: [],
    queuedFollowUp: [],
    ...(isCodeModeTool ? { isCodeModeTool } : {}),
  });
  return { run: (e: unknown) => run(e as AgentSessionEvent), published };
}

const toolEvents = (name: string): unknown[] => [
  { type: 'tool_execution_start', toolName: name, toolCallId: 'c1', args: { command: 'ls' } },
  { type: 'tool_execution_end', toolName: name, toolCallId: 'c1', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false },
];

describe('the wrapper row is hidden where the recorded rows are drawn', () => {
  it('drops the display events of a code-mode tool', () => {
    const { run, published } = reducer((name) => name === 'exec' || name === 'wait');

    for (const event of toolEvents('exec')) run(event);

    expect(published).toEqual([]);
  });

  it('leaves every other tool alone, and leaves everything alone outside code mode', () => {
    const traced = reducer((name) => name === 'exec');
    for (const event of toolEvents('Bash')) traced.run(event);
    expect(traced.published.map((e) => e.type)).toEqual(['tool', 'tool_output']);

    const plain = reducer();
    for (const event of toolEvents('exec')) plain.run(event);
    expect(plain.published.map((e) => e.type)).toEqual(['tool', 'tool_output']);
  });
});

describe('the sink publishes its rows into the turn it runs in', () => {
  const inTurn = <T>(emit: (e: BrainEvent) => void, fn: () => Promise<T>): Promise<T> =>
    runWithPolicy({} as never, fn, { emitToolTrace: emit });

  it('opens a row when the call starts and settles it when it returns', async () => {
    const events: BrainEvent[] = [];
    await inTurn((e) => events.push(e), async () => {
      const sink = createToolTraceSink('cell_1', (name) => (name === 'Bash' ? 'terminal' : undefined));
      await sink.call('Bash', { command: 'ls' }, async () => ({ content: [{ type: 'text', text: '$ ls\n(cwd: /tmp)\na\n[exit 0]' }], details: { exitCode: 0 } }));
      // What was published is what was recorded: the durable twin of each row.
      expect(sink.drain().map((r) => (r.kind === 'call' ? r.row : r.kind))).toEqual(['cell_1:0']);
    });

    expect(events.map((e) => e.type)).toEqual(['tool', 'tool_output']);
    expect(events[0]).toMatchObject({ type: 'tool', name: 'Bash', id: 'cell_1:0', icon: 'terminal' });
    expect(events[1]).toMatchObject({ type: 'tool_output', id: 'cell_1:0' });
  });

  it('records and publishes a failure as an errored row, then rethrows', async () => {
    const events: BrainEvent[] = [];
    await inTurn((e) => events.push(e), async () => {
      const sink = createToolTraceSink('cell_1');
      await expect(sink.call('Bash', { command: 'ls' }, async () => { throw new Error('not permitted'); })).rejects.toThrow('not permitted');

      const [record] = sink.drain();
      expect(record).toMatchObject({ kind: 'call', row: 'cell_1:0', name: 'Bash', isError: true });
    });

    expect(events.map((e) => e.type)).toEqual(['tool', 'tool_output']);
  });

  it('keeps recording when there is no turn to publish into, instead of throwing inside a tool call', async () => {
    const sink = createToolTraceSink('cell_1');

    await sink.call('Read', { file_path: '/a' }, async () => ({ content: [{ type: 'text', text: 'x' }] }));
    sink.note('halfway');

    expect(sink.drain().map((r) => r.kind)).toEqual(['call', 'note']);
  });
});
