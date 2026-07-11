import { describe, expect, it } from 'vitest';
import { TranscriptModel } from '../../src/brain/transcriptModel.js';
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

    expect(model.view.notice).toBeUndefined();
    expect(model.view.thinking).toBe(true);
    expect(model.lastAssistantText()).toBe('hello');
    expect(toolItem(model, 1, 'run-1')).toMatchObject({
      command: 'npm test', output: { command: 'npm test', text: 'PASS a' },
    });
    expect(toolItem(model, 1, 'run-1').progress).toBeUndefined();

    model.apply({ type: 'idle' });
    expect(model.view).toMatchObject({ thinking: false, notice: undefined });
    expect(model.turnAt(1)).toMatchObject({ role: 'elowen', streaming: false });

    model.apply({ type: 'error', message: 'fetch failed' });
    expect(model.view.thinking).toBe(false);
    expect(model.lastAssistantText()).toBe('\n[error: fetch failed]');
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
    const view = model.view;

    expect(model.apply({
      type: 'subagent', id: 'missing', sessionId: 'child', status: 'running', task: 'x', tools: 0, seconds: 0,
    })).toBe(false);
    expect(model.revision).toBe(revision);
    expect(model.view).toBe(view);
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
});
