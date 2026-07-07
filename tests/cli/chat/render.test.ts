import { describe, it, expect } from 'vitest';
import { emptyView, fromHistory, pushUser, beginAssistant, reduce } from '../../../src/brain/transcript.js';

describe('chat render reducer', () => {
  it('builds a view from history, dropping empty turns', () => {
    const v = fromHistory([{ role: 'user', text: 'hi' }, { role: 'assistant', text: '' }, { role: 'assistant', text: 'yo' }]);
    expect(v.turns).toEqual([
      { role: 'you', text: 'hi' },
      { role: 'orca', segments: [{ kind: 'text', text: 'yo' }], streaming: false },
    ]);
  });

  it('streams text deltas into one text segment', () => {
    let v = beginAssistant(pushUser(emptyView(), 'ahoj'));
    v = reduce(v, { type: 'text', delta: 'a' });
    v = reduce(v, { type: 'text', delta: 'hoj' });
    const turn = v.turns.at(-1)!;
    expect(turn).toMatchObject({ role: 'orca', streaming: true });
    expect(turn.role === 'orca' && turn.segments).toEqual([{ kind: 'text', text: 'ahoj' }]);
    expect(v.thinking).toBe(true);
  });

  it('groups consecutive tool calls into one tools segment (no text between them)', () => {
    let v = beginAssistant(emptyView());
    v = reduce(v, { type: 'tool', name: 'grep' });
    v = reduce(v, { type: 'tool', name: 'read_file' });
    const turn = v.turns.at(-1)!;
    expect(turn.role === 'orca' && turn.segments).toEqual([{ kind: 'tools', items: [{ name: 'grep', detail: undefined }, { name: 'read_file', detail: undefined }] }]);
  });

  it('interleaves text and tools in order (text → tools → text = three segments)', () => {
    let v = beginAssistant(emptyView());
    v = reduce(v, { type: 'text', delta: 'looking' });
    v = reduce(v, { type: 'tool', name: 'grep' });
    v = reduce(v, { type: 'text', delta: 'found it' });
    const turn = v.turns.at(-1)!;
    expect(turn.role === 'orca' && turn.segments).toEqual([
      { kind: 'text', text: 'looking' },
      { kind: 'tools', items: [{ name: 'grep', detail: undefined }] },
      { kind: 'text', text: 'found it' },
    ]);
  });

  it('diff event attaches to the most recent tool call', () => {
    let v = beginAssistant(emptyView());
    v = reduce(v, { type: 'tool', name: 'edit', detail: 'src/a.ts' });
    v = reduce(v, { type: 'diff', diff: '-old\n+new' });
    const turn = v.turns.at(-1)!;
    expect(turn.role === 'orca' && turn.segments).toEqual([
      { kind: 'tools', items: [{ name: 'edit', detail: 'src/a.ts', diff: '-old\n+new' }] },
    ]);
  });

  it('tool_output event attaches to the most recent tool call', () => {
    let v = beginAssistant(emptyView());
    v = reduce(v, { type: 'tool', name: 'run_command', detail: 'npm test' });
    v = reduce(v, { type: 'tool_output', output: { title: 'console output', kind: 'console', text: 'Tests 4 passed', command: 'npm test', status: 'exit 0', tone: 'success' } });
    const turn = v.turns.at(-1)!;
    expect(turn.role === 'orca' && turn.segments).toEqual([
      { kind: 'tools', items: [{ name: 'run_command', detail: 'npm test', output: { title: 'console output', kind: 'console', text: 'Tests 4 passed', command: 'npm test', status: 'exit 0', tone: 'success' } }] },
    ]);
  });

  it('threads the verbatim command from the start event into the output (end event carries no args)', () => {
    let v = beginAssistant(emptyView());
    v = reduce(v, { type: 'tool', name: 'run_command', detail: 'mkdir -p build', command: 'mkdir -p build', id: 'x' });
    // The end event's output has no command — the reducer fills it from the matching start event.
    v = reduce(v, { type: 'tool_output', id: 'x', output: { title: 'console output', kind: 'console', text: '', status: 'done' } });
    const turn = v.turns.at(-1)!;
    const item = turn.role === 'orca' && turn.segments[0]?.kind === 'tools' ? turn.segments[0].items[0] : null;
    expect(item?.command).toBe('mkdir -p build');
    expect(item?.output?.command).toBe('mkdir -p build');
  });

  it('does not overwrite a command the output already carries', () => {
    let v = beginAssistant(emptyView());
    v = reduce(v, { type: 'tool', name: 'run_command', command: 'a', id: 'y' });
    v = reduce(v, { type: 'tool_output', id: 'y', output: { title: 'console output', kind: 'console', text: 'x', command: 'b' } });
    const turn = v.turns.at(-1)!;
    const item = turn.role === 'orca' && turn.segments[0]?.kind === 'tools' ? turn.segments[0].items[0] : null;
    expect(item?.output?.command).toBe('b');
  });

  it('tool_output and diff events attach by tool call id when tools finish out of order', () => {
    let v = beginAssistant(emptyView());
    v = reduce(v, { type: 'tool', name: 'first', id: 'a' });
    v = reduce(v, { type: 'tool', name: 'second', id: 'b' });
    v = reduce(v, { type: 'tool_output', id: 'a', output: { title: 'console output', kind: 'console', text: 'A done' } });
    v = reduce(v, { type: 'diff', id: 'b', diff: '-old\n+new' });
    const turn = v.turns.at(-1)!;
    expect(turn.role === 'orca' && turn.segments).toEqual([
      { kind: 'tools', items: [
        { name: 'first', detail: undefined, icon: undefined, id: 'a', output: { title: 'console output', kind: 'console', text: 'A done' } },
        { name: 'second', detail: undefined, icon: undefined, id: 'b', diff: '-old\n+new' },
      ] },
    ]);
  });

  it('idle finalizes the turn and stops thinking', () => {
    let v = beginAssistant(emptyView());
    v = reduce(v, { type: 'text', delta: 'done' });
    v = reduce(v, { type: 'idle' });
    expect(v.turns.at(-1)).toMatchObject({ streaming: false });
    expect(v.thinking).toBe(false);
  });

  it('creates an assistant turn if a text event arrives with none open', () => {
    const v = reduce(emptyView(), { type: 'text', delta: 'hi' });
    expect(v.turns).toHaveLength(1);
    const turn = v.turns[0]!;
    expect(turn.role === 'orca' && turn.segments).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  it('error appends a note and stops', () => {
    const v = reduce(beginAssistant(emptyView()), { type: 'error', message: 'boom' });
    const turn = v.turns.at(-1)!;
    const text = turn.role === 'orca' ? turn.segments.map((s) => (s.kind === 'text' ? s.text : '')).join('') : '';
    expect(text).toContain('boom');
    expect(v.thinking).toBe(false);
  });
});
