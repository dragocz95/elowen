import { describe, expect, it } from 'vitest';
import { emptyView, fromHistory, groupToolItems, reduce } from '../../lib/transcript';
import type { ToolItem } from '../../lib/transcript';

describe('web groupToolItems: collapse consecutive same-tool pills', () => {
  it('folds a run of the same bare tool into one group with the latest detail and a count', () => {
    const items: ToolItem[] = [
      { name: 'read_file', detail: 'a.ts' },
      { name: 'read_file', detail: 'a.ts' },
      { name: 'read_file', detail: 'b.ts' },
    ];
    const groups = groupToolItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(3);
    expect(groups[0]!.item.detail).toBe('b.ts');
  });

  it('does not merge across a different tool, and an item with a diff/output stays its own group', () => {
    const groups = groupToolItems([
      { name: 'read_file', detail: 'a.ts' },
      { name: 'list_dir', detail: 'src' },
      { name: 'read_file', detail: 'b.ts', output: { title: 't', kind: 'result', text: 'x' } },
      { name: 'read_file', detail: 'c.ts' },
      { name: 'edit_file', detail: 'd.ts', diff: '+ 1 x' },
    ]);
    expect(groups.map((g) => [g.item.name, g.count])).toEqual([
      ['read_file', 1], ['list_dir', 1], ['read_file', 1], ['read_file', 1], ['edit_file', 1],
    ]);
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
});

describe('web transcript reducer', () => {
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

  it('attaches live run_command progress by id and the final tool_output supersedes it (no doubled dump)', () => {
    let view = emptyView();
    view = reduce(view, { type: 'tool', name: 'run_command', id: 'r1' });
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
});
