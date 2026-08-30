import { describe, expect, it } from 'vitest';
import { collectSubagents, emptyView, fromHistory, fromSnapshot, groupToolItems, prependHistory, reduce, submittedPlan } from '../../lib/transcript';
import type { ToolItem } from '../../lib/transcript';

describe('web fromSnapshot: a reconnect frame rebuilds the whole transcript', () => {
  /** What the server sends after the phone comes back: the durable prefix WITHOUT the steered row it
   *  replays as an ordering marker, plus the unsettled tail of the run. */
  const frame = {
    history: [
      { role: 'user' as const, text: 'first', id: 'm1' },
      { role: 'assistant' as const, text: 'answer', id: 'm2' },
    ],
    events: [
      { type: 'user', text: 'steer now' },
      { type: 'text', delta: 'working' },
    ],
  };

  it('does not double a message that was already on screen before the drop', () => {
    let live = fromHistory(frame.history);
    live = reduce(live, { type: 'user', text: 'steer now' });
    live = reduce(live, { type: 'text', delta: 'working' });
    expect(live.turns.filter((turn) => turn.role === 'you')).toHaveLength(2);

    const rebuilt = fromSnapshot(frame);
    expect(rebuilt.turns.map((turn) => (turn.role === 'you' ? `you:${turn.text}` : turn.role)))
      .toEqual(['you:first', 'elowen', 'you:steer now', 'elowen']);
    expect(rebuilt.thinking).toBe(true); // no terminal event in the tail — the turn is still running
  });

  it('ignores out-of-band frames in the replayed tail and settles on a terminal one', () => {
    const view = fromSnapshot({
      history: frame.history,
      events: [
        { type: 'card', card: { id: 'c1', title: 'x' } },
        { type: 'text', delta: 'done thinking' },
        { type: 'queue', items: [] },
        { type: 'idle', model: 'claude-opus-5', durationMs: 83_000, completedAt: '2026-08-21T14:00:00.000Z' },
      ],
    });
    expect(view.thinking).toBe(false);
    const last = view.turns.at(-1);
    expect(last).toMatchObject({
      role: 'elowen', streaming: false, model: 'claude-opus-5', durationMs: 83_000, createdAt: '2026-08-21T14:00:00.000Z',
    });
  });
});

describe('web groupToolItems: collapse consecutive same-tool pills', () => {
  it('folds a run of the same bare tool into one group with the latest detail and a count', () => {
    const items: ToolItem[] = [
      { name: 'Read', detail: 'a.ts' },
      { name: 'Read', detail: 'a.ts' },
      { name: 'Read', detail: 'b.ts' },
    ];
    const groups = groupToolItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(3);
    expect(groups[0]!.item.detail).toBe('b.ts');
  });

  it('does not merge across a different tool, and an item with a diff/output stays its own group', () => {
    const groups = groupToolItems([
      { name: 'Read', detail: 'a.ts' },
      { name: 'ListDir', detail: 'src' },
      { name: 'Read', detail: 'b.ts', output: { title: 't', kind: 'result', text: 'x' } },
      { name: 'Read', detail: 'c.ts' },
      { name: 'Edit', detail: 'd.ts', diff: '+ 1 x' },
    ]);
    expect(groups.map((g) => [g.item.name, g.count])).toEqual([
      ['Read', 1], ['ListDir', 1], ['Read', 1], ['Read', 1], ['Edit', 1],
    ]);
  });

  it('keeps a delegate row carrying sub-agent state out of collapsed tool groups', () => {
    const sub = { sessionId: 'brain-ch-subagent-child', status: 'running' as const, task: 'inspect', tools: 1, seconds: 2 };
    const groups = groupToolItems([
      { name: 'Delegate', detail: 'first' },
      { name: 'Delegate', detail: 'background', sub },
      { name: 'Delegate', detail: 'third' },
    ]);
    expect(groups.map((group) => group.count)).toEqual([1, 1, 1]);
    expect(groups[1]!.item.sub?.sessionId).toBe('brain-ch-subagent-child');
  });

  it('folds a run of the SAME failure (differing only by path) and keeps every member', () => {
    const groups = groupToolItems([
      { name: 'Edit', output: { title: 't', kind: 'result', text: 'no such file /a/b.ts', tone: 'danger' } },
      { name: 'Edit', output: { title: 't', kind: 'result', text: 'no such file /c/d.ts', tone: 'danger' } },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.members).toHaveLength(2);
  });

  it('keeps a WorkflowStart row out of collapsed groups (wf is not collapsible)', () => {
    const groups = groupToolItems([
      { name: 'WorkflowStart' },
      { name: 'WorkflowStart', wf: { id: 'w', toolCallId: 'c', status: 'running', nodes: [] } },
    ]);
    expect(groups.map((g) => g.count)).toEqual([1, 1]);
  });
});

describe('web transcript fromHistory: session-event and workflow rows', () => {
  it('folds consecutive session-change markers into one event turn and carries kind/detail', () => {
    const view = fromHistory([
      { id: 'e1', role: 'event', text: '', kind: 'model', detail: 'gpt-5' },
      { id: 'e2', role: 'event', text: '', kind: 'mode', detail: 'build' },
    ]);
    expect(view.turns).toHaveLength(1);
    const turn = view.turns[0]!;
    expect(turn.role).toBe('event');
    if (turn.role === 'event') {
      expect(turn.events.map((e) => [e.kind, e.detail])).toEqual([['model', 'gpt-5'], ['mode', 'build']]);
    }
  });

  it('carries a workflow DAG through onto its tool item', () => {
    const view = fromHistory([{
      id: 'm1', role: 'assistant', text: '',
      segments: [{ kind: 'tool', name: 'WorkflowStart', id: 'c', wf: { id: 'w', toolCallId: 'c', status: 'done', nodes: [{ id: 'n', task: 'x', status: 'done', deps: [] }] } }],
    }]);
    const turn = view.turns[0]!;
    expect(turn.role).toBe('elowen');
    if (turn.role === 'elowen') {
      const seg = turn.segments[0]!;
      expect(seg.kind).toBe('tools');
      if (seg.kind === 'tools') expect(seg.items[0]!.wf?.id).toBe('w');
    }
  });
});

describe('web transcript fromHistory: compaction divider', () => {
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

  it('stamps each turn with its source row id (the stable React key + prepend dedupe identity)', () => {
    const view = fromHistory([
      { id: 'm1', role: 'user', text: 'q' },
      { id: 'm2', role: 'assistant', text: 'a' },
    ]);
    expect(view.turns[0]).toMatchObject({ role: 'you', id: 'm1' });
    expect(view.turns[1]).toMatchObject({ role: 'elowen', id: 'm2' });
  });
});

describe('web transcript prependHistory: lazy-load scroll-up', () => {
  it('prepends an older page in front and leaves the live streaming tail untouched', () => {
    // A live view: one settled history turn plus a still-streaming reply (no id).
    let view = fromHistory([{ id: 'm3', role: 'user', text: 'newest q' }]);
    view = reduce(view, { type: 'text', delta: 'streaming…' });
    const streamingTail = view.turns[view.turns.length - 1];

    const older = prependHistory(view, [
      { id: 'm1', role: 'user', text: 'old q' },
      { id: 'm2', role: 'assistant', text: 'old a' },
    ]);
    expect(older.turns.map((tn) => tn.id)).toEqual(['m1', 'm2', 'm3', undefined]);
    // Same object identity for the tail → React never remounts the streaming turn on a prepend.
    expect(older.turns[older.turns.length - 1]).toBe(streamingTail);
  });

  it('drops turns already present (by id) so an overlapping/re-fetched page never doubles a turn', () => {
    const view = fromHistory([
      { id: 'm2', role: 'user', text: 'q2' },
      { id: 'm3', role: 'assistant', text: 'a3' },
    ]);
    const merged = prependHistory(view, [
      { id: 'm1', role: 'user', text: 'q1' },
      { id: 'm2', role: 'user', text: 'q2' }, // overlaps the current head — must not double
    ]);
    expect(merged.turns.map((tn) => tn.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('returns the same view unchanged when the page adds nothing new (no state churn)', () => {
    const view = fromHistory([{ id: 'm1', role: 'user', text: 'q' }]);
    expect(prependHistory(view, [{ id: 'm1', role: 'user', text: 'q' }])).toBe(view);
    expect(prependHistory(view, [])).toBe(view);
  });

  it('replaces synthetic running-work anchors when pagination reaches their real tool rows', () => {
    let view = fromHistory([
      {
        id: 'sub-anchor-call-sub', synthetic: true, role: 'assistant', text: '',
        segments: [{ kind: 'tool', name: 'Delegate', id: 'call-sub', sub: { sessionId: 'child', status: 'running', task: 'inspect', tools: 1, seconds: 2 } }],
      },
      {
        id: 'wf-anchor-call-wf', synthetic: true, role: 'assistant', text: '',
        segments: [{ kind: 'tool', name: 'WorkflowStart', id: 'call-wf', wf: { id: 'wf-1', toolCallId: 'call-wf', status: 'running', nodes: [] } }],
      },
      { id: 'tail', role: 'user', text: 'newest q' },
    ]);

    view = prependHistory(view, [{
      id: 'colliding-read-row', role: 'assistant', text: '',
      segments: [
        { kind: 'tool', name: 'Read', id: 'call-sub' },
        { kind: 'tool', name: 'Read', id: 'call-wf' },
      ],
    }]);
    expect(view.turns.map((turn) => turn.id)).toEqual([
      'colliding-read-row', 'sub-anchor-call-sub', 'wf-anchor-call-wf', 'tail',
    ]);

    view = prependHistory(view, [
      {
        id: 'real-sub-row', role: 'assistant', text: '',
        segments: [{ kind: 'tool', name: 'DelegateContinue', id: 'call-sub', sub: { sessionId: 'child', status: 'running', task: 'inspect', tools: 1, seconds: 2 } }],
      },
      {
        id: 'real-wf-row', role: 'assistant', text: '',
        segments: [{ kind: 'tool', name: 'WorkflowStart', id: 'call-wf', wf: { id: 'wf-1', toolCallId: 'call-wf', status: 'running', nodes: [] } }],
      },
    ]);

    expect(view.turns.map((turn) => turn.id)).toEqual(['real-sub-row', 'real-wf-row', 'colliding-read-row', 'tail']);
    view = reduce(view, { type: 'subagent', id: 'call-sub', sessionId: 'child', status: 'done', task: 'inspect', tools: 2, seconds: 4 });
    const subagents = view.turns.flatMap((turn) => turn.role === 'elowen'
      ? turn.segments.flatMap((segment) => segment.kind === 'tools' ? segment.items.flatMap((item) => item.sub ?? []) : [])
      : []);
    expect(subagents).toEqual([expect.objectContaining({ sessionId: 'child', status: 'done' })]);
  });
});

describe('web transcript reducer', () => {
  // ExitPlanMode's result text is addressed to the model and withheld from the transcript by tool policy,
  // so the plan arrives on `tool_end` — an event this fold ignored entirely. The daemon carried the plan
  // and the web dropped it, which meant the web client showed a bare "ExitPlanMode" row and the plan
  // itself was visible nowhere at all.
  it('attaches a submitted plan arriving on tool_end, and keeps it out of the fold', () => {
    let view = emptyView();
    view = reduce(view, { type: 'tool', name: 'ExitPlanMode', id: 'p1' });
    view = reduce(view, { type: 'tool_end', id: 'p1', plan: '# Ship it\n\n1. Wire the store' });

    const turn = view.turns.at(-1);
    const items = turn?.role === 'elowen' && turn.segments[0]?.kind === 'tools' ? turn.segments[0].items : [];
    expect(items[0]?.plan).toBe('# Ship it\n\n1. Wire the store');
  });

  // A panel is not a row: two plans are two documents, and folding them into a `×2` pill would show one
  // and silently discard the other.
  it('never folds two submitted plans into one pill', () => {
    let view = emptyView();
    view = reduce(view, { type: 'tool', name: 'ExitPlanMode', id: 'p1' });
    view = reduce(view, { type: 'tool_end', id: 'p1', plan: '# First' });
    view = reduce(view, { type: 'tool', name: 'ExitPlanMode', id: 'p2' });
    view = reduce(view, { type: 'tool_end', id: 'p2', plan: '# Second' });

    const turn = view.turns.at(-1);
    const items = turn?.role === 'elowen' && turn.segments[0]?.kind === 'tools' ? turn.segments[0].items : [];
    expect(groupToolItems(items).map((g) => g.item.plan)).toEqual(['# First', '# Second']);
  });

  it('ignores a tool_end that carries no plan', () => {
    let view = emptyView();
    view = reduce(view, { type: 'tool', name: 'Read', id: 'r1' });
    const before = view.turns.at(-1);
    view = reduce(view, { type: 'tool_end', id: 'r1' });
    expect(view.turns.at(-1)).toBe(before);
  });

  it('attaches diff and tool output by tool call id', () => {
    let view = emptyView();
    view = reduce(view, { type: 'tool', name: 'first', id: 'a' });
    view = reduce(view, { type: 'tool', name: 'second', id: 'b' });
    view = reduce(view, { type: 'tool_output', id: 'a', output: { title: 'console output', kind: 'console', text: 'A done' } });
    view = reduce(view, { type: 'diff', id: 'b', diff: '-old\n+new' });

    const turn = view.turns.at(-1);
    expect(turn?.role === 'elowen' && turn.segments).toEqual([
      { kind: 'tools', items: [
        { name: 'first', detail: undefined, icon: undefined, id: 'a', output: { title: 'console output', kind: 'console', text: 'A done' } },
        { name: 'second', detail: undefined, icon: undefined, id: 'b', diff: '-old\n+new' },
      ] },
    ]);
  });

  it('attaches live Bash progress by id and the final tool_output supersedes it (no doubled dump)', () => {
    let view = emptyView();
    view = reduce(view, { type: 'tool', name: 'Bash', id: 'r1' });
    view = reduce(view, { type: 'tool_progress', id: 'r1', text: 'PASS a' });
    let turn = view.turns.at(-1);
    let item = turn?.role === 'elowen' && turn.segments[0]?.kind === 'tools' ? turn.segments[0].items[0] : undefined;
    expect(item).toMatchObject({ id: 'r1', progress: 'PASS a' });

    view = reduce(view, { type: 'tool_progress', id: 'r1', text: 'PASS a\nPASS b' }); // latest tail replaces
    view = reduce(view, { type: 'tool_output', id: 'r1', output: { title: 'console output', kind: 'console', text: 'PASS a\nPASS b\n[exit 0]' } });
    turn = view.turns.at(-1);
    item = turn?.role === 'elowen' && turn.segments[0]?.kind === 'tools' ? turn.segments[0].items[0] : undefined;
    expect(item?.progress).toBeUndefined();                 // the live tail is cleared
    expect(item?.output).toMatchObject({ kind: 'console' }); // only the final block remains
  });

  it('folds a `user` delivery event into a you-turn (a drained queued message)', () => {
    let view = reduce(emptyView(), { type: 'text', delta: 'reply to the first message' });
    view = reduce(view, { type: 'idle' }); // the first turn settles
    view = reduce(view, { type: 'user', text: 'queued follow-up' });
    expect(view.turns.at(-1)).toEqual({ role: 'you', text: 'queued follow-up' });
  });

  // Esc/Stop before the turn produced output: the daemon deletes the row and sends discard_user; the fold
  // pulls the matching you-bubble by durableId and stops the spinner. Composer restore is the provider's job.
  it('discards the trailing you-turn on discard_user, by durableId', () => {
    let view = reduce(emptyView(), { type: 'user', text: 'cancel before the reply', durableId: 'dur-1' });
    expect(view.turns.at(-1)).toEqual({ role: 'you', text: 'cancel before the reply', id: 'dur-1' });
    expect(view.thinking).toBe(true);
    view = reduce(view, { type: 'discard_user', durableId: 'dur-1', text: 'cancel before the reply' });
    expect(view.turns).toEqual([]);
    expect(view.thinking).toBe(false);
  });

  it('leaves a you-turn AND its spinner in place when discard_user names a different turn', () => {
    let view = reduce(emptyView(), { type: 'user', text: 'kept', durableId: 'dur-1' });
    expect(view.thinking).toBe(true);
    view = reduce(view, { type: 'discard_user', durableId: 'other-id', text: 'kept' });
    expect(view.turns.some((t) => t.role === 'you' && t.id === 'dur-1')).toBe(true);
    // A no-match must NOT settle the spinner: a duplicate discard (double Esc) would otherwise kill the
    // spinner of a turn the user has meanwhile resent.
    expect(view.thinking).toBe(true);
  });

  it('rehydrates durable child state and patches done after parent idle without a new spinner turn', () => {
    let view = fromHistory([{ role: 'assistant', text: '', segments: [{
      kind: 'tool', id: 'delegate-1', name: 'Delegate', detail: 'inspect',
      sub: { sessionId: 'brain-ch-subagent-child', status: 'running', task: 'inspect', tools: 1, seconds: 2 },
    }] }]);
    expect(view.thinking).toBe(false);
    const before = view.turns.length;

    view = reduce(view, {
      type: 'subagent', id: 'delegate-1', sessionId: 'brain-ch-subagent-child', status: 'done',
      task: 'inspect', tools: 4, tokens: 800, seconds: 9,
    });
    expect(view.turns).toHaveLength(before);
    expect(view.thinking).toBe(false);
    const turn = view.turns[0];
    if (!turn || turn.role !== 'elowen' || turn.segments[0]?.kind !== 'tools') throw new Error('expected delegate row');
    expect(turn.segments[0].items[0]).toMatchObject({
      id: 'delegate-1', sub: { sessionId: 'brain-ch-subagent-child', status: 'done', tools: 4 },
    });
  });

  it('keeps reasoning, timestamps, and delivery identical in live updates and reload history', () => {
    const settled = {
      sessionId: 'child-parity', status: 'done' as const, task: 'inspect', detail: 'Read src/a.ts',
      tools: 4, tokens: 800, seconds: 9, model: 'anthropic/sonnet',
      thinkingLevel: 'high', thinkingLabel: 'High',
      startedAt: '2026-08-30 05:00:00', updatedAt: '2026-08-30 05:00:09',
      background: true, autoDeliver: true, resultDelivery: 'acknowledged' as const,
    };
    const anchor = { role: 'assistant' as const, text: '', segments: [{ kind: 'tool' as const, id: 'delegate-parity', name: 'Delegate' }] };
    const reloaded = fromHistory([{ ...anchor, segments: [{ ...anchor.segments[0], sub: settled }] }]);
    const live = reduce(fromHistory([anchor]), { type: 'subagent', id: 'delegate-parity', ...settled });

    expect(collectSubagents(live.turns)).toEqual(collectSubagents(reloaded.turns));
    expect(collectSubagents(live.turns)).toEqual([settled]);
  });

  it('ignores an unknown post-idle sub-agent id without creating a turn', () => {
    const before = fromHistory([{ role: 'assistant', text: 'settled' }]);
    const after = reduce(before, {
      type: 'subagent', id: 'missing', sessionId: 'child', status: 'done', task: 'x', tools: 1, seconds: 1,
    });
    expect(after).toBe(before);
    expect(after.thinking).toBe(false);
  });
});

describe('web transcript submittedPlan: the plan waiting on a decision', () => {
  const planTurn = { id: 'm2', role: 'assistant' as const, text: '', segments: [{ kind: 'tool' as const, name: 'ExitPlanMode', id: 'call-1', plan: '# Ship it' }] };

  it('reports the plan of the newest assistant turn with its call id', () => {
    expect(submittedPlan(fromHistory([{ id: 'm1', role: 'user', text: 'plan it' }, planTurn]).turns))
      .toEqual({ id: 'call-1', plan: '# Ship it' });
  });

  // The regression this pins: a model/mode marker (or a compaction divider) landing after the plan is not
  // the conversation moving on, and disqualifying the tail on it lost the decision entirely.
  it('is not hidden by a trailing session-event or compaction row', () => {
    const withEvent = fromHistory([planTurn, { id: 'e1', role: 'event', text: '', kind: 'mode', detail: 'plan' }]);
    expect(submittedPlan(withEvent.turns)).toEqual({ id: 'call-1', plan: '# Ship it' });
    const withDivider = fromHistory([planTurn, { id: 'c1', role: 'compaction', text: '' }]);
    expect(submittedPlan(withDivider.turns)).toEqual({ id: 'call-1', plan: '# Ship it' });
  });

  it('answers null once a newer user turn or a plan-less answer moved the conversation on', () => {
    expect(submittedPlan(fromHistory([planTurn, { id: 'm3', role: 'user', text: 'do it' }]).turns)).toBeNull();
    expect(submittedPlan(fromHistory([planTurn, { id: 'm4', role: 'assistant', text: 'done' }]).turns)).toBeNull();
    expect(submittedPlan(emptyView().turns)).toBeNull();
  });

  it('follows the live tool_end frame that carries the plan', () => {
    let view = reduce(emptyView(), { type: 'tool', name: 'ExitPlanMode', id: 'call-9' });
    expect(submittedPlan(view.turns)).toBeNull();
    view = reduce(view, { type: 'tool_end', id: 'call-9', plan: '# Live plan' });
    expect(submittedPlan(view.turns)).toEqual({ id: 'call-9', plan: '# Live plan' });
  });
});
