import { describe, it, expect } from 'vitest';
import { reduce, pushUser, beginAssistant, emptyView, fromHistory, getChatViewChange, groupToolItems } from '../../src/brain/transcript.js';
import type { ChatView, ToolItem } from '../../src/brain/transcript.js';

describe('groupToolItems: collapse consecutive same-tool rows', () => {
  it('folds a run of the same bare tool into one group carrying the LATEST detail and a count', () => {
    const items: ToolItem[] = [
      { name: 'read_file', detail: 'a.ts' },
      { name: 'read_file', detail: 'a.ts' },
      { name: 'read_file', detail: 'b.ts' },
    ];
    const groups = groupToolItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(3);
    expect(groups[0]!.item.detail).toBe('b.ts'); // latest detail wins so the streaming row updates in place
  });

  it('does NOT merge across a different tool (grouping is strictly consecutive + same name)', () => {
    const groups = groupToolItems([
      { name: 'read_file', detail: 'a.ts' },
      { name: 'list_dir', detail: 'src' },
      { name: 'read_file', detail: 'b.ts' },
    ]);
    expect(groups.map((g) => [g.item.name, g.count])).toEqual([
      ['read_file', 1], ['list_dir', 1], ['read_file', 1],
    ]);
  });

  it('keeps an item carrying a diff / output / sub / command as its own group (count 1)', () => {
    const groups = groupToolItems([
      { name: 'read_file', detail: 'a.ts' },
      { name: 'read_file', detail: 'b.ts', output: { title: 't', kind: 'result', text: 'x' } },
      { name: 'read_file', detail: 'c.ts' },
      { name: 'run_command', command: 'ls' }, // a shell command row is meaningful per call → never folded
      { name: 'run_command', command: 'pwd' },
      { name: 'edit_file', detail: 'd.ts', diff: '+ 1 x' },
    ]);
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1, 1, 1, 1]);
    // The read WITH output breaks the run, so the read before and after it don't merge either.
    expect(groups.map((g) => g.item.name)).toEqual(['read_file', 'read_file', 'read_file', 'run_command', 'run_command', 'edit_file']);
  });
});

describe('transcript fromHistory: compaction divider', () => {
  it('renders a compaction row as a divider turn, keeping the tail that follows', () => {
    const view = fromHistory([
      { role: 'compaction', text: '' },
      { role: 'user', text: 'recent q' },
      { role: 'assistant', text: 'recent a' },
    ]);
    expect(view.turns[0]).toEqual({ role: 'divider' });
    expect(view.turns[1]).toEqual({ role: 'you', text: 'recent q' });
    expect(view.turns[2]).toMatchObject({ role: 'elowen', streaming: false });
  });
});

describe('transcript fold: session (idle rollover)', () => {
  it('resets the transcript to the fresh conversation, then rebuilds from the daemon stream', () => {
    // The prior conversation is on screen (no optimistic local turn — the daemon is the echo authority).
    let view: ChatView = {
      turns: [
        { role: 'you', text: 'yesterday' },
        { role: 'elowen', segments: [{ kind: 'text', text: 'old answer' }], streaming: false },
      ],
      thinking: false,
    };
    // The rollover `session` event clears the transcript — everything belonged to the PREVIOUS conversation.
    view = reduce(view, { type: 'session', sessionId: 'brain-1-x' });
    expect(view.turns).toEqual([]);
    // The daemon then re-emits the triggering message as a `user` event and streams its reply into the
    // fresh conversation.
    view = reduce(view, { type: 'user', text: 'today' });
    view = reduce(view, { type: 'text', delta: 'fresh answer' });
    expect(view.turns).toEqual([
      { role: 'you', text: 'today' },
      { role: 'elowen', segments: [{ kind: 'text', text: 'fresh answer' }], streaming: true },
    ]);
  });

  it('resets to empty regardless of the prior content', () => {
    const view = reduce({ turns: [{ role: 'elowen', segments: [{ kind: 'text', text: 'x' }], streaming: false }], thinking: false }, { type: 'session', sessionId: 's' });
    expect(view.turns).toEqual([]);
  });

  it('is a no-op on an empty view', () => {
    expect(reduce(emptyView(), { type: 'session', sessionId: 's' }).turns).toEqual([]);
  });
});

describe('transcript fold: user (queued message delivery)', () => {
  it('appends a you-turn after the previous (finalized) assistant reply', () => {
    const before: ChatView = {
      turns: [
        { role: 'you', text: 'first' },
        { role: 'elowen', segments: [{ kind: 'text', text: 'reply to first' }], streaming: false },
      ],
      thinking: false,
    };
    const after = reduce(before, { type: 'user', text: 'second\n\nthird' });
    expect(after.turns.at(-1)).toEqual({ role: 'you', text: 'second\n\nthird' });
    // A streamed reply that follows opens its own fresh assistant turn (the last turn is a 'you').
    const withReply = reduce(after, { type: 'text', delta: 'combined answer' });
    expect(withReply.turns.at(-1)).toEqual({ role: 'elowen', segments: [{ kind: 'text', text: 'combined answer' }], streaming: true });
  });
});

describe('transcript fold: diff with a notes-only output view', () => {
  it('attaches both the diff and the riding output to the matching tool item', () => {
    let v = beginAssistant(pushUser(emptyView(), 'edit it'));
    v = reduce(v, { type: 'tool', name: 'edit_file', detail: 'a.ts', id: 'c1' });
    const output = { title: 'tool result', kind: 'result' as const, text: '', tone: 'normal' as const, notes: ['formatted a.ts with prettier'] };
    v = reduce(v, { type: 'diff', diff: '+    1 x', id: 'c1', output });
    const turn = v.turns[v.turns.length - 1]!;
    if (turn.role !== 'elowen') throw new Error('expected elowen turn');
    const seg = turn.segments.find((s) => s.kind === 'tools');
    if (seg?.kind !== 'tools') throw new Error('expected tools segment');
    expect(seg.items[0]).toMatchObject({ diff: '+    1 x', output });
  });
});

describe('transcript fold: run_command live progress → reconcile with final output', () => {
  const toolItem = (v: ChatView): ToolItem => {
    const turn = v.turns[v.turns.length - 1]!;
    if (turn.role !== 'elowen') throw new Error('expected elowen turn');
    const seg = turn.segments.find((s) => s.kind === 'tools');
    if (seg?.kind !== 'tools') throw new Error('expected tools segment');
    return seg.items[0]!;
  };

  it('attaches the live tail to the matching run_command tool item by id, updating in place', () => {
    let v = beginAssistant(pushUser(emptyView(), 'run tests'));
    v = reduce(v, { type: 'tool', name: 'run_command', command: 'npm test', id: 'r1' });
    v = reduce(v, { type: 'tool_progress', id: 'r1', text: 'PASS a.test' });
    expect(toolItem(v)).toMatchObject({ command: 'npm test', progress: 'PASS a.test' });
    v = reduce(v, { type: 'tool_progress', id: 'r1', text: 'PASS a.test\nPASS b.test' });
    expect(toolItem(v).progress).toBe('PASS a.test\nPASS b.test'); // latest tail replaces, never appends
  });

  it('the final tool_output SUPERSEDES the live progress (reconcile → no doubled dump)', () => {
    let v = beginAssistant(pushUser(emptyView(), 'run tests'));
    v = reduce(v, { type: 'tool', name: 'run_command', command: 'npm test', id: 'r1' });
    v = reduce(v, { type: 'tool_progress', id: 'r1', text: 'PASS a.test' });
    v = reduce(v, { type: 'tool_output', id: 'r1', output: { title: 'tool result', kind: 'console', text: '$ npm test\nPASS a.test\nPASS b.test\n[exit 0]' } });
    const item = toolItem(v);
    expect(item.progress).toBeUndefined();                 // the live tail is cleared
    expect(item.output).toMatchObject({ kind: 'console' }); // only the final block remains
  });

  it('a progress-bearing run_command never collapses into a grouped ×N row', () => {
    const groups = groupToolItems([
      { name: 'run_command', id: 'r1', progress: 'building…' },
      { name: 'run_command', id: 'r2', progress: 'linking…' },
    ]);
    expect(groups.map((g) => g.count)).toEqual([1, 1]);
  });
});

describe('transcript fold: subagent progress', () => {
  const delegateCall = (): ChatView => {
    let v = pushUser(emptyView(), 'do it');
    v = beginAssistant(v);
    return reduce(v, { type: 'tool', name: 'delegate', detail: 'research the config', id: 'call-1' });
  };

  it('attaches live progress to the matching delegate tool item by call id', () => {
    const v = reduce(delegateCall(), {
      type: 'subagent', id: 'call-1', sessionId: 'brain-ch-subagent-sub-x', status: 'running',
      task: 'research the config', detail: 'read_file src/a.ts', tools: 2, tokens: 1500, seconds: 7,
    });
    const turn = v.turns[v.turns.length - 1]!;
    if (turn.role !== 'elowen') throw new Error('expected elowen turn');
    const seg = turn.segments.find((s) => s.kind === 'tools');
    if (seg?.kind !== 'tools') throw new Error('expected tools segment');
    expect(seg.items[0]!.sub).toMatchObject({
      sessionId: 'brain-ch-subagent-sub-x', status: 'running', detail: 'read_file src/a.ts', tools: 2, tokens: 1500, seconds: 7,
    });
  });

  it('a later update replaces the previous state (done settles the row)', () => {
    let v = reduce(delegateCall(), { type: 'subagent', id: 'call-1', sessionId: 's', status: 'running', task: 't', tools: 1, seconds: 2 });
    v = reduce(v, { type: 'subagent', id: 'call-1', sessionId: 's', status: 'done', task: 't', tools: 5, tokens: 9000, seconds: 31 });
    const turn = v.turns[v.turns.length - 1]!;
    if (turn.role !== 'elowen') throw new Error('expected elowen turn');
    const seg = turn.segments.find((s) => s.kind === 'tools');
    if (seg?.kind !== 'tools') throw new Error('expected tools segment');
    expect(seg.items[0]!.sub).toMatchObject({ status: 'done', tools: 5, tokens: 9000, seconds: 31 });
  });

  it('done after parent idle patches the original settled row without a new turn or spinner', () => {
    let v = reduce(delegateCall(), {
      type: 'subagent', id: 'call-1', sessionId: 's', status: 'running', task: 't', tools: 1, seconds: 2,
    });
    v = reduce(v, { type: 'idle' });
    const turnsBefore = v.turns.length;
    expect(v.thinking).toBe(false);

    v = reduce(v, {
      type: 'subagent', id: 'call-1', sessionId: 's', status: 'done', task: 't', tools: 5, seconds: 31,
    });

    expect(v.turns).toHaveLength(turnsBefore);
    expect(v.thinking).toBe(false);
    const turn = v.turns.find((candidate) => candidate.role === 'elowen');
    if (!turn || turn.role !== 'elowen') throw new Error('expected original elowen turn');
    const seg = turn.segments.find((candidate) => candidate.kind === 'tools');
    if (!seg || seg.kind !== 'tools') throw new Error('expected delegate tool');
    expect(seg.items[0]!.sub?.status).toBe('done');
  });

  it('rehydrates a durable running child with its drill-in session id', () => {
    const v = fromHistory([{ role: 'assistant', text: '', segments: [{
      kind: 'tool', id: 'call-1', name: 'delegate', detail: 'inspect',
      sub: { sessionId: 'brain-ch-subagent-child', status: 'running', task: 'inspect', tools: 1, seconds: 3 },
    }] }]);
    const turn = v.turns[0];
    if (!turn || turn.role !== 'elowen' || turn.segments[0]?.kind !== 'tools') throw new Error('expected delegate row');
    expect(turn.segments[0].items[0]).toMatchObject({
      id: 'call-1', sub: { sessionId: 'brain-ch-subagent-child', status: 'running' },
    });
    expect(v.thinking).toBe(false);
  });

  it('an update with an unknown call id is a safe no-op', () => {
    const before = reduce(delegateCall(), { type: 'idle' });
    const after = reduce(before, { type: 'subagent', id: 'other', sessionId: 's', status: 'running', task: 't', tools: 0, seconds: 0 });
    expect(after).toBe(before);
    expect(after.thinking).toBe(false);
  });

  it('retains compact coalesced revisions without retaining predecessor views', () => {
    const base = reduce(delegateCall(), { type: 'idle' });
    let next = base;
    for (let index = 0; index < 100; index += 1) {
      next = reduce(next, { type: 'notice', kind: 'retry', message: `retry ${index}` });
    }
    next = reduce(next, {
      type: 'subagent', id: 'call-1', sessionId: 's', status: 'running', task: 't', tools: 2, seconds: 3,
    });
    expect(getChatViewChange(next, base)).toEqual({ kind: 'turns', indices: [1] });
  });

  it('keeps isolated dirty turns separate from an appended suffix', () => {
    const base = reduce(delegateCall(), { type: 'idle' });
    let next = pushUser(base, 'new question');
    next = reduce(next, {
      type: 'subagent', id: 'call-1', sessionId: 's', status: 'done', task: 't', tools: 4, seconds: 5,
    });
    expect(getChatViewChange(next, base)).toEqual({ kind: 'patch', from: 2, indices: [1] });
  });
});
