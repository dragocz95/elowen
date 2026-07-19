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
        { kind: 'tool', id: 'read-1', name: 'Read', detail: 'src/a.ts' },
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

  describe('workflow', () => {
    const wfEvent = (over: Record<string, unknown> = {}) => ({
      type: 'workflow' as const, id: 'wf-1', toolCallId: 'call-1', title: 'Ship it',
      status: 'running' as const,
      nodes: [{ id: 'gather', task: 'gather', status: 'done' as const, deps: [], sessionId: 's-gather' }],
      ...over,
    });
    const withCall = (): HistoryMessage[] => [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', segments: [{ kind: 'tool', id: 'call-1', name: 'WorkflowStart' }] },
    ];

    it('attaches a live snapshot to its WorkflowStart item and projects it', () => {
      const model = new TranscriptModel(withCall());
      expect(model.apply(wfEvent())).toBe(true);

      const turn = model.turnAt(1);
      if (turn?.role !== 'elowen') throw new Error('expected assistant turn');
      const segment = turn.segments[0];
      if (segment?.kind !== 'tools') throw new Error('expected tools segment');
      expect(segment.items[0]?.wf).toMatchObject({ id: 'wf-1', status: 'running' });
      expect(model.workflows().map((w) => w.id)).toEqual(['wf-1']);
    });

    it('marks the WorkflowStart turn dirty so its marker re-renders', () => {
      const model = new TranscriptModel(withCall());
      const before = model.revision;
      model.apply(wfEvent());
      expect(model.changesSince(before)).toMatchObject({ kind: 'turns', indices: [1] });
    });

    it('ignores a snapshot whose tool call is not in the transcript', () => {
      const model = new TranscriptModel(withCall());
      expect(model.apply(wfEvent({ toolCallId: 'nope' }))).toBe(false);
      expect(model.workflows()).toEqual([]);
    });

    // The regression this whole change exists for. Every hydration — reconnect, opening the stream, even
    // closing a sub-agent view — calls replaceHistory, which wipes the derived projections. The workflow
    // used to have no durable source to be rebuilt from, so it vanished from the rail and its modal could
    // never be reopened; an open modal read an empty node list, which is why Enter appeared to do nothing.
    it('rebuilds the projection from durable history, so a workflow survives replaceHistory', () => {
      const model = new TranscriptModel();
      model.replaceHistory([
        { role: 'user', text: 'go' },
        { role: 'assistant', text: '', segments: [{
          kind: 'tool', id: 'call-1', name: 'WorkflowStart',
          wf: { id: 'wf-1', toolCallId: 'call-1', status: 'done', nodes: [{ id: 'gather', task: 'gather', status: 'done', deps: [] }] },
        }] },
      ]);
      expect(model.workflows().map((w) => w.id)).toEqual(['wf-1']);
      const turn = model.turnAt(1);
      if (turn?.role !== 'elowen') throw new Error('expected assistant turn');
      const segment = turn.segments[0];
      if (segment?.kind !== 'tools') throw new Error('expected tools segment');
      expect(segment.items[0]?.wf?.status).toBe('done');
    });
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
    model.apply({ type: 'tool', id: 'run-1', name: 'Bash', command: 'npm test' });
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
        { kind: 'tool', id: 'delegate-old', name: 'Delegate', detail: 'inspect' },
      ] },
      ...Array.from({ length: 50 }, (_, index) => ({ role: 'assistant', text: `answer ${index}` })),
    ]);
    const beforeTurns = model.turnCount;

    model.apply({
      type: 'subagent', id: 'delegate-old', sessionId: 'child-1', status: 'running', task: 'inspect',
      detail: 'Read src/a.ts', tools: 2, tokens: 100, seconds: 3, model: 'test-model',
      thinkingLevel: 'high', thinkingLabel: 'High',
    });

    expect(model.turnCount).toBe(beforeTurns);
    expect(toolItem(model, 0, 'delegate-old').sub).toMatchObject({ sessionId: 'child-1', tools: 2 });
    // The child's own reasoning level rides the projection so the drilled-in status bar can show it.
    expect(model.subagents()).toEqual([expect.objectContaining({
      sessionId: 'child-1', status: 'running', thinkingLevel: 'high', thinkingLabel: 'High',
    })]);

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

  it('settles a streaming assistant tail when a user turn displaces it, so its sub-agent marker still repaints', () => {
    // Regression for #61: a foreground delegate flips to `done` while its assistant turn is still the
    // streaming tail, then a steered mid-turn user message is appended over it. If the tail keeps
    // `streaming: true`, the viewport can never repaint it (its dirty delta is deferred to the tail-only
    // path) and the marker stays stuck at `●` even though the model already holds `done`.
    const model = new TranscriptModel();
    model.apply({ type: 'user', text: 'delegate a review' });
    model.apply({ type: 'text', delta: 'delegating…' });
    model.apply({ type: 'tool', id: 'del-1', name: 'Delegate', detail: 'review' });
    model.apply({
      type: 'subagent', id: 'del-1', sessionId: 'child', status: 'running', task: 'review',
      detail: 'Read a.ts', tools: 1, tokens: 10, seconds: 1, model: 'fable',
    });
    model.apply({
      type: 'subagent', id: 'del-1', sessionId: 'child', status: 'done', task: 'review',
      tools: 5, tokens: 500, seconds: 9, model: 'fable',
    });
    // Precondition: the marker turn is the streaming tail at the moment the child finishes.
    expect(model.turnAt(1)).toMatchObject({ role: 'elowen', streaming: true });
    expect(toolItem(model, 1, 'del-1').sub).toMatchObject({ status: 'done' });

    const beforeAppend = model.revision;
    model.apply({ type: 'user', text: 'steered mid-turn' });

    // The displaced turn is settled (repaintable) and still carries the `done` marker…
    expect(model.turnAt(1)).toMatchObject({ role: 'elowen', streaming: false });
    expect(toolItem(model, 1, 'del-1').sub).toMatchObject({ status: 'done' });
    // …and the append marks that turn dirty, so the viewport is told to reprint it, not just the suffix.
    expect(model.changesSince(beforeAppend)).toMatchObject({ kind: 'patch', from: 2, indices: [1] });
  });

  it('flags a turn as composing while a tool call is being written, and clears it when the tool lands', () => {
    const model = new TranscriptModel([]);
    const turn = () => { const t = model.turnAt(0); if (t?.role !== 'elowen') throw new Error('expected assistant turn'); return t; };

    model.apply({ type: 'text', delta: 'let me check' });
    expect(turn().composing).toBeFalsy();

    model.apply({ type: 'tool_authoring', name: 'Write' });
    expect(turn().composing).toBe(true);
    expect(turn().composingTool).toBe('Write'); // the tool name is known before its arguments finish
    // A second authoring event within the same turn is a no-op (no visible change).
    expect(model.apply({ type: 'tool_authoring', name: 'Write' })).toBe(false);

    // The tool marker rendering ends the authoring window and forgets the authored tool.
    model.apply({ type: 'tool', name: 'Read', id: 't1' });
    expect(turn().composing).toBe(false);
    expect(turn().composingTool).toBeUndefined();
  });

  it('clears composing when the turn settles even if no tool followed', () => {
    const model = new TranscriptModel([]);
    model.apply({ type: 'tool_authoring' });
    model.apply({ type: 'idle' });
    const t = model.turnAt(0);
    expect(t?.role === 'elowen' && t.composing).toBe(false);
    expect(t?.role === 'elowen' && t.streaming).toBe(false);
  });

  it('exposes the streaming tail authoring window through the composing getter', () => {
    const model = new TranscriptModel([]);
    expect(model.composing).toBe(false);
    model.apply({ type: 'text', delta: 'let me check' });
    expect(model.composing).toBe(false);
    model.apply({ type: 'tool_authoring' });
    expect(model.composing).toBe(true);
    // The window closes with the tool marker, and a settled turn never reports composing.
    model.apply({ type: 'tool', name: 'Read', id: 't1' });
    expect(model.composing).toBe(false);
    model.apply({ type: 'idle' });
    expect(model.composing).toBe(false);
  });

  it('protects the cached sub-agent projection from caller mutation', () => {
    const model = new TranscriptModel([{
      role: 'assistant', text: '', segments: [{
        kind: 'tool', id: 'delegate', name: 'Delegate',
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
    { type: 'tool', id: 'tool-1', name: 'Read', detail: 'src/index.ts' } as const,
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
      ? { role: 'assistant', text: '', segments: [{ kind: 'tool', id: 'old', name: 'Delegate' }] }
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
        kind: 'tool', id: 'delegate', name: 'Delegate',
        sub: { sessionId: 'child', status: 'running', task: 'inspect', tools: 1, seconds: 1 },
      }],
    }]);
    model.apply({ type: 'session', sessionId: 'fresh' });

    expect(model.turnCount).toBe(0);
    expect(model.subagents()).toEqual([]);
    expect(model.lastAssistantText()).toBe('');
    expect(model.changesSince(model.revision - 1)).toEqual({ kind: 'full', revision: model.revision });
  });

  it('projects workflow snapshots latest-per-id, adding no turn of its own', () => {
    const model = new TranscriptModel([
      { role: 'assistant', text: '', segments: [{ kind: 'tool', id: 'call-1', name: 'WorkflowStart' }] },
    ]);
    const beforeTurns = model.turnCount;
    model.apply({
      type: 'workflow', id: 'wf-1', toolCallId: 'call-1', title: 'ship it', status: 'running',
      nodes: [
        { id: 'a', task: 'gather', status: 'running', deps: [], sessionId: 's-a', tokens: 100, seconds: 2 },
        { id: 'b', task: 'write', status: 'pending', deps: ['a'] },
      ],
    });
    expect(model.turnCount).toBe(beforeTurns); // it rides its WorkflowStart row; it is not a turn
    expect(model.workflows()).toEqual([
      expect.objectContaining({ id: 'wf-1', title: 'ship it', status: 'running' }),
    ]);
    expect(model.workflows()[0]!.nodes).toHaveLength(2);

    const projection = model.workflows();
    model.apply({
      type: 'workflow', id: 'wf-1', toolCallId: 'call-1', title: 'ship it', status: 'done',
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
    const model = new TranscriptModel([
      { role: 'assistant', text: '', segments: [{ kind: 'tool', id: 'call-1', name: 'WorkflowStart' }] },
    ]);
    model.apply({ type: 'workflow', id: 'wf-1', toolCallId: 'call-1', status: 'running', nodes: [{ id: 'a', task: 't', status: 'running', deps: [] }] });
    expect(model.workflows()).toHaveLength(1);
    model.apply({ type: 'session', sessionId: 'fresh' });
    expect(model.workflows()).toEqual([]);
  });
});
