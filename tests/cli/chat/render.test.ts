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
