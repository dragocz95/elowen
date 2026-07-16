import { describe, expect, it } from 'vitest';
import { TranscriptModel, type TranscriptRead } from '../../src/brain/transcriptModel.js';
import type { HistoryMessage } from '../../src/brain/transcript.js';

const toolItem = (model: TranscriptModel, turnIndex: number, id: string) => {
  const turn = model.turnAt(turnIndex);
  if (turn?.role !== 'elowen') throw new Error('expected assistant turn');
  for (const segment of turn.segments) {
    if (segment.kind !== 'tools') continue;
    const item = segment.items.find((candidate) => candidate.id === id);
    if (item) return item;
  }
  throw new Error(`missing tool ${id}`);
};

describe('TranscriptModel', () => {
  it('replaces durable history, preserves compaction and caches the last assistant text', () => {
    const model = new TranscriptModel([
      { role: 'assistant', text: 'discarded' },
      { role: 'compaction', text: '' },
      { role: 'user', text: 'recent question' },
      { role: 'assistant', text: '', segments: [
        { kind: 'text', text: 'recent ' },
        { kind: 'tool', id: 'read-1', name: 'read_file', detail: 'src/a.ts' },
        { kind: 'text', text: 'answer' },
      ] },
    ]);

    expect(model.turnCount).toBe(4);
    expect(model.turnAt(1)).toEqual({ role: 'divider' });
    expect(model.lastAssistantText()).toBe('recent answer');

    const before = model.revision;
    model.replaceHistory([{ role: 'user', text: 'fresh' }, { role: 'assistant', text: 'fresh answer' }]);

    expect(model.turnCount).toBe(2);
    expect(model.lastAssistantText()).toBe('fresh answer');
    expect(model.changesSince(before)).toEqual({ kind: 'full', revision: model.revision });
  });

  it('folds a live session-event into an event turn and dedups the durable twin from history', () => {
    const model = new TranscriptModel([
      { role: 'user', text: 'hi' },
      { role: 'event', id: 'evt-1', kind: 'model', detail: 'anthropic/claude' },
    ]);
    expect(model.turnCount).toBe(2);
    expect(model.turnAt(1)).toEqual({ role: 'event', events: [{ id: 'evt-1', kind: 'model', detail: 'anthropic/claude' }] });

    // The same marker replayed over the live ring must NOT show up twice.
    expect(model.apply({ type: 'session-event', id: 'evt-1', kind: 'model', detail: 'anthropic/claude', at: '2026-07-16T09:00:00.000Z' })).toBe(false);
    expect(model.turnCount).toBe(2);
    expect(model.turnAt(1)).toEqual({ role: 'event', events: [{ id: 'evt-1', kind: 'model', detail: 'anthropic/claude' }] });
  });

  // A run of markers is ONE turn, so they stack as a block and only the block is separated from what
  // follows — the same shape consecutive tool calls take.
  it('extends the marker run in place instead of starting a turn per marker', () => {
    const model = new TranscriptModel([{ role: 'user', text: 'hi' }]);
    expect(model.apply({ type: 'session-event', id: 'evt-1', kind: 'mode', detail: 'Workflow', at: '2026-07-16T09:00:00.000Z' })).toBe(true);
    expect(model.apply({ type: 'session-event', id: 'evt-2', kind: 'reasoning', detail: 'max', at: '2026-07-16T09:00:01.000Z' })).toBe(true);

    expect(model.turnCount).toBe(2);
    expect(model.turnAt(1)).toEqual({ role: 'event', events: [
      { id: 'evt-1', kind: 'mode', detail: 'Workflow' },
      { id: 'evt-2', kind: 'reasoning', detail: 'max' },
    ] });

    // A user turn closes the run: the next marker starts a fresh block.
    model.apply({ type: 'user', text: 'go on' });
    model.apply({ type: 'session-event', id: 'evt-3', kind: 'model', detail: 'anthropic/claude', at: '2026-07-16T09:00:02.000Z' });
    expect(model.turnCount).toBe(4);
    expect(model.turnAt(3)).toEqual({ role: 'event', events: [{ id: 'evt-3', kind: 'model', detail: 'anthropic/claude' }] });
  });

  it('collapses a consecutive run of durable markers from history into one turn', () => {
    const model = new TranscriptModel([
      { role: 'user', text: 'hi' },
      { role: 'event', id: 'evt-1', kind: 'rename', detail: 'Marker demo' },
      { role: 'event', id: 'evt-2', kind: 'reasoning', detail: 'max' },
      { role: 'assistant', text: 'sure' },
    ]);
    expect(model.turnCount).toBe(3);
    expect(model.turnAt(1)).toEqual({ role: 'event', events: [
      { id: 'evt-1', kind: 'rename', detail: 'Marker demo' },
      { id: 'evt-2', kind: 'reasoning', detail: 'max' },
    ] });
  });

  it('does not expose an old assistant plan when durable history ends with a user turn', () => {
    const model = new TranscriptModel([
      { role: 'assistant', text: '<proposed_plan>old</proposed_plan>' },
      { role: 'user', text: 'new request' },
    ]);

    expect(model.lastAssistantText()).toBe('');
  });

  it('does not expose an old assistant plan when durable history ends with a compaction divider', () => {
    const model = new TranscriptModel([
      { role: 'assistant', text: '<proposed_plan>old</proposed_plan>' },
      { role: 'compaction', text: '' },
    ]);

    expect(model.lastAssistantText()).toBe('');
  });

  it('clears the assistant-tail projection when a live user turn is appended', () => {
    const model = new TranscriptModel([{ role: 'assistant', text: '<proposed_plan>old</proposed_plan>' }]);

    model.apply({ type: 'user', text: 'implement something else' });

    expect(model.lastAssistantText()).toBe('');
  });

  it('folds streamed text, reasoning, tool lifecycle, notice, idle and error without changing UX state', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'user', text: 'run it' });
    model.apply({ type: 'notice', kind: 'retry', message: 'retrying' });
    model.apply({ type: 'reasoning', delta: 'checking' });
    model.apply({ type: 'text', delta: 'hello' });
    model.apply({ type: 'tool', id: 'run-1', name: 'run_command', command: 'npm test' });
    model.apply({ type: 'tool_progress', id: 'run-1', text: 'PASS a' });
    model.apply({
      type: 'tool_output', id: 'run-1',
      output: { title: 'tool result', kind: 'console', text: 'PASS a' },
    });

    const readable: TranscriptRead = model;
    expect(readable.notice).toBeUndefined();
    expect(readable.thinking).toBe(true);
    expect(model.lastAssistantText()).toBe('hello');
    expect(toolItem(model, 1, 'run-1')).toMatchObject({
      command: 'npm test', output: { command: 'npm test', text: 'PASS a' },
    });
    expect(toolItem(model, 1, 'run-1').progress).toBeUndefined();

    model.apply({ type: 'idle' });
    expect(readable).toMatchObject({ thinking: false, notice: undefined });
    expect(model.turnAt(1)).toMatchObject({ role: 'elowen', streaming: false });

    model.apply({ type: 'error', message: 'fetch failed' });
    expect(readable.thinking).toBe(false);
    expect(model.lastAssistantText()).toBe('\n[error: fetch failed]');
  });

  it('stays busy for the full compaction lifecycle even after the agent turn became idle', () => {
    const model = new TranscriptModel();

    model.apply({ type: 'user', text: 'run a long task' });
    model.apply({ type: 'idle' });
    expect(model.thinking).toBe(false);
    expect(model.activity).toBeNull();

    model.apply({ type: 'notice', kind: 'compaction', message: 'compacting conversation…' });
    expect(model.thinking).toBe(true);
    expect(model.activity).toBe('compaction');
    expect(model.notice).toBe('compacting conversation…');

    // A late terminal idle must not make the composer look sendable while the summary request runs.
    model.apply({ type: 'idle' });
    expect(model.thinking).toBe(true);
    expect(model.activity).toBe('compaction');

    model.apply({ type: 'notice', kind: 'compaction', message: 'conversation compacted', done: true });
    expect(model.thinking).toBe(false);
    expect(model.activity).toBeNull();
    expect(model.notice).toBeUndefined();
  });

  it('patches a settled old tool and updates the sub-agent projection incrementally', () => {
    const model = new TranscriptModel([
      { role: 'assistant', text: '', segments: [
        { kind: 'tool', id: 'delegate-old', name: 'delegate', detail: 'inspect' },
      ] },
      ...Array.from({ length: 50 }, (_, index) => ({ role: 'assistant', text: `answer ${index}` })),
    ]);
    const beforeTurns = model.turnCount;

    model.apply({
      type: 'subagent', id: 'delegate-old', sessionId: 'child-1', status: 'running', task: 'inspect',
      detail: 'read_file src/a.ts', tools: 2, tokens: 100, seconds: 3, model: 'test-model',
    });

    expect(model.turnCount).toBe(beforeTurns);
    expect(toolItem(model, 0, 'delegate-old').sub).toMatchObject({ sessionId: 'child-1', tools: 2 });
    expect(model.subagents()).toEqual([expect.objectContaining({ sessionId: 'child-1', status: 'running' })]);

    const projection = model.subagents();
    model.apply({ type: 'notice', kind: 'retry', message: 'retry' });
    expect(model.subagents()).toBe(projection);

    model.apply({
      type: 'subagent', id: 'delegate-old', sessionId: 'child-1', status: 'done', task: 'inspect',
      tools: 7, tokens: 900, seconds: 12,
    });
    expect(model.subagents()).not.toBe(projection);
    expect(model.subagents()).toEqual([expect.objectContaining({ status: 'done', tools: 7 })]);
  });

  it('protects the cached sub-agent projection from caller mutation', () => {
    const model = new TranscriptModel([{
      role: 'assistant', text: '', segments: [{
        kind: 'tool', id: 'delegate', name: 'delegate',
        sub: { sessionId: 'child', status: 'running', task: 'inspect', tools: 1, seconds: 1 },
      }],
    }]);
    const projection = model.subagents();

    expect(Object.isFrozen(projection)).toBe(true);
    expect(() => (projection as unknown as typeof projection[number][]).pop()).toThrow(TypeError);
    expect(Object.isFrozen(projection[0])).toBe(true);
    expect(() => { (projection[0] as { sessionId: string }).sessionId = 'corrupted'; }).toThrow(TypeError);
    expect(model.subagents()).toBe(projection);

    model.apply({
      type: 'subagent', id: 'delegate', sessionId: 'child', status: 'done', task: 'inspect', tools: 2, seconds: 2,
    });
    expect(model.subagents()).toEqual([expect.objectContaining({ status: 'done', tools: 2 })]);
  });

  it('treats an unknown old tool patch as a true no-op', () => {
    const model = new TranscriptModel([{ role: 'assistant', text: 'settled' }]);
    const revision = model.revision;
    const turn = model.turnAt(0);

    expect(model.apply({
      type: 'subagent', id: 'missing', sessionId: 'child', status: 'running', task: 'x', tools: 0, seconds: 0,
    })).toBe(false);
    expect(model.revision).toBe(revision);
    expect(model.turnAt(0)).toBe(turn);
    expect(model.subagents()).toEqual([]);
  });

  it('coalesces bounded changes and requests a full refresh after journal eviction', () => {
    const model = new TranscriptModel([], { journalLimit: 3 });
    const base = model.revision;
    model.apply({ type: 'user', text: 'one' });
    const afterAppend = model.revision;
    model.apply({ type: 'text', delta: 'a' });
    model.apply({ type: 'notice', kind: 'retry', message: 'retry' });

    expect(model.changesSince(afterAppend)).toEqual({
      kind: 'suffix', from: 1, revision: model.revision,
    });

    model.apply({ type: 'reasoning', delta: 'b' });
    expect(model.changesSince(base)).toEqual({ kind: 'full', revision: model.revision });
    expect(model.changesSince(model.revision)).toEqual({ kind: 'none', revision: model.revision });
  });

  it.each([
    { type: 'text', delta: 'answer' } as const,
    { type: 'reasoning', delta: 'thought' } as const,
    { type: 'tool', id: 'tool-1', name: 'read_file', detail: 'src/index.ts' } as const,
  ])('publishes a fresh assistant $type event as an appended suffix', (event) => {
    const model = new TranscriptModel([{ role: 'assistant', text: 'settled' }]);
    const revision = model.revision;

    model.apply(event);

    expect(model.changesSince(revision)).toEqual({
      kind: 'suffix', from: 1, revision: model.revision,
    });
  });

  it.each([
    { type: 'tool_progress', id: 'missing', text: 'late output' } as const,
    { type: 'diff', id: 'missing', diff: { title: 'late diff', oldText: 'before', newText: 'after' } } as const,
    { type: 'tool_output', id: 'missing', output: { title: 'late result', kind: 'console', text: 'late output' } } as const,
  ])('publishes a fresh assistant for an unmatched $type event as an appended suffix', (event) => {
    const model = new TranscriptModel([{ role: 'assistant', text: 'settled' }]);
    const revision = model.revision;

    model.apply(event);

    expect(model.turnCount).toBe(2);
    expect(model.changesSince(revision)).toEqual({
      kind: 'suffix', from: 1, revision: model.revision,
    });
  });

  it('visits at most one turn for a steady event at exactly 40,000 turns', () => {
    const history: HistoryMessage[] = Array.from({ length: 40_000 }, (_, index) => index === 0
      ? { role: 'assistant', text: '', segments: [{ kind: 'tool', id: 'old', name: 'delegate' }] }
      : { role: 'assistant', text: `settled ${index}` });
    const visits: number[] = [];
    const model = new TranscriptModel(history, { onTurnVisit: (index) => visits.push(index) });

    model.apply({
      type: 'subagent', id: 'old', sessionId: 'child', status: 'running', task: 'inspect', tools: 1, seconds: 1,
    });

    expect(model.turnCount).toBe(40_000);
    expect(visits).toEqual([0]);

    visits.length = 0;
    model.apply({ type: 'text', delta: 'tail' });
    expect(visits).toEqual([39_999]);

    visits.length = 0;
    model.apply({ type: 'notice', kind: 'retry', message: 'retry' });
    expect(visits).toEqual([]);
  });

  it('resets all indexes and derived state on session rollover', () => {
    const model = new TranscriptModel([{
      role: 'assistant', text: '', segments: [{
        kind: 'tool', id: 'delegate', name: 'delegate',
        sub: { sessionId: 'child', status: 'running', task: 'inspect', tools: 1, seconds: 1 },
      }],
    }]);
    model.apply({ type: 'session', sessionId: 'fresh' });

    expect(model.turnCount).toBe(0);
    expect(model.subagents()).toEqual([]);
    expect(model.lastAssistantText()).toBe('');
    expect(model.changesSince(model.revision - 1)).toEqual({ kind: 'full', revision: model.revision });
  });

  it('projects workflow snapshots latest-per-id without touching any turn', () => {
    const model = new TranscriptModel([{ role: 'assistant', text: 'hi' }]);
    const beforeTurns = model.turnCount;
    model.apply({
      type: 'workflow', id: 'wf-1', title: 'ship it', status: 'running',
      nodes: [
        { id: 'a', task: 'gather', status: 'running', deps: [], sessionId: 's-a', tokens: 100, seconds: 2 },
        { id: 'b', task: 'write', status: 'pending', deps: ['a'] },
      ],
    });
    expect(model.turnCount).toBe(beforeTurns); // a workflow is a side panel, not a turn
    expect(model.workflows()).toEqual([
      expect.objectContaining({ id: 'wf-1', title: 'ship it', status: 'running' }),
    ]);
    expect(model.workflows()[0]!.nodes).toHaveLength(2);

    const projection = model.workflows();
    model.apply({
      type: 'workflow', id: 'wf-1', title: 'ship it', status: 'done',
      nodes: [
        { id: 'a', task: 'gather', status: 'done', deps: [], sessionId: 's-a', tokens: 120, seconds: 3 },
        { id: 'b', task: 'write', status: 'done', deps: ['a'], sessionId: 's-b', tokens: 80, seconds: 4 },
      ],
    });
    expect(model.workflows()).not.toBe(projection); // fresh immutable snapshot on change
    expect(model.workflows()).toHaveLength(1); // same id updates in place, not appended
    expect(model.workflows()[0]!.status).toBe('done');
  });

  it('clears workflow projection on session rollover', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'workflow', id: 'wf-1', status: 'running', nodes: [{ id: 'a', task: 't', status: 'running', deps: [] }] });
    expect(model.workflows()).toHaveLength(1);
    model.apply({ type: 'session', sessionId: 'fresh' });
    expect(model.workflows()).toEqual([]);
  });
});
