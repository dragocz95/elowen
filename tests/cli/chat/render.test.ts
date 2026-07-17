import { describe, expect, it } from 'vitest';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';

const lastTurn = (model: TranscriptModel) => model.turnAt(model.turnCount - 1)!;

describe('chat transcript model', () => {
  it('builds a transcript from history, dropping empty turns', () => {
    const model = new TranscriptModel([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: '' },
      { role: 'assistant', text: 'yo' },
    ]);
    expect(Array.from({ length: model.turnCount }, (_, index) => model.turnAt(index))).toEqual([
      { role: 'you', text: 'hi' },
      { role: 'elowen', segments: [{ kind: 'text', text: 'yo' }], streaming: false },
    ]);
  });

  it('streams text deltas into one text segment', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'user', text: 'ahoj' });
    model.apply({ type: 'text', delta: 'a' });
    model.apply({ type: 'text', delta: 'hoj' });
    const turn = lastTurn(model);
    expect(turn).toMatchObject({ role: 'elowen', streaming: true });
    expect(turn.role === 'elowen' && turn.segments).toEqual([{ kind: 'text', text: 'ahoj' }]);
    expect(model.thinking).toBe(true);
  });

  it('groups consecutive tool calls into one tools segment', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool', name: 'grep' });
    model.apply({ type: 'tool', name: 'Read' });
    const turn = lastTurn(model);
    expect(turn.role === 'elowen' && turn.segments).toEqual([{
      kind: 'tools',
      items: [
        { name: 'grep', detail: undefined, icon: undefined },
        { name: 'Read', detail: undefined, icon: undefined },
      ],
    }]);
  });

  it('interleaves text and tools in event order', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'text', delta: 'looking' });
    model.apply({ type: 'tool', name: 'grep' });
    model.apply({ type: 'text', delta: 'found it' });
    const turn = lastTurn(model);
    expect(turn.role === 'elowen' && turn.segments).toEqual([
      { kind: 'text', text: 'looking' },
      { kind: 'tools', items: [{ name: 'grep', detail: undefined, icon: undefined }] },
      { kind: 'text', text: 'found it' },
    ]);
  });

  it('attaches a diff to the most recent tool call', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool', name: 'edit', detail: 'src/a.ts' });
    model.apply({ type: 'diff', diff: '-old\n+new' });
    const turn = lastTurn(model);
    expect(turn.role === 'elowen' && turn.segments).toEqual([{
      kind: 'tools', items: [{ name: 'edit', detail: 'src/a.ts', icon: undefined, diff: '-old\n+new' }],
    }]);
  });

  it('attaches tool output to the most recent tool call', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool', name: 'Bash', detail: 'npm test' });
    const output = {
      title: 'console output', kind: 'console' as const, text: 'Tests 4 passed', command: 'npm test',
      status: 'exit 0', tone: 'success' as const,
    };
    model.apply({ type: 'tool_output', output });
    const turn = lastTurn(model);
    expect(turn.role === 'elowen' && turn.segments).toEqual([{
      kind: 'tools', items: [{ name: 'Bash', detail: 'npm test', icon: undefined, output }],
    }]);
  });

  it('threads the verbatim start command into an output that carries no command', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool', name: 'Bash', detail: 'mkdir -p build', command: 'mkdir -p build', id: 'x' });
    model.apply({ type: 'tool_output', id: 'x', output: { title: 'console output', kind: 'console', text: '', status: 'done' } });
    const turn = lastTurn(model);
    const item = turn.role === 'elowen' && turn.segments[0]?.kind === 'tools' ? turn.segments[0].items[0] : null;
    expect(item?.command).toBe('mkdir -p build');
    expect(item?.output?.command).toBe('mkdir -p build');
  });

  it('does not overwrite a command the output already carries', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool', name: 'Bash', command: 'a', id: 'y' });
    model.apply({ type: 'tool_output', id: 'y', output: { title: 'console output', kind: 'console', text: 'x', command: 'b' } });
    const turn = lastTurn(model);
    const item = turn.role === 'elowen' && turn.segments[0]?.kind === 'tools' ? turn.segments[0].items[0] : null;
    expect(item?.output?.command).toBe('b');
  });

  it('attaches tool output and diff by id when tools finish out of order', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool', name: 'first', id: 'a' });
    model.apply({ type: 'tool', name: 'second', id: 'b' });
    model.apply({ type: 'tool_output', id: 'a', output: { title: 'console output', kind: 'console', text: 'A done' } });
    model.apply({ type: 'diff', id: 'b', diff: '-old\n+new' });
    const turn = lastTurn(model);
    expect(turn.role === 'elowen' && turn.segments).toEqual([{
      kind: 'tools', items: [
        { name: 'first', detail: undefined, icon: undefined, id: 'a', output: { title: 'console output', kind: 'console', text: 'A done' } },
        { name: 'second', detail: undefined, icon: undefined, id: 'b', diff: '-old\n+new' },
      ],
    }]);
  });

  it('idle finalizes the turn and stops thinking', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'text', delta: 'done' });
    model.apply({ type: 'idle' });
    expect(lastTurn(model)).toMatchObject({ streaming: false });
    expect(model.thinking).toBe(false);
  });

  it('creates an assistant turn if a text event arrives with none open', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'text', delta: 'hi' });
    expect(model.turnCount).toBe(1);
    const turn = model.turnAt(0)!;
    expect(turn.role === 'elowen' && turn.segments).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  it('error appends a note and stops', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'error', message: 'boom' });
    const turn = lastTurn(model);
    const text = turn.role === 'elowen'
      ? turn.segments.map((segment) => (segment.kind === 'text' ? segment.text : '')).join('')
      : '';
    expect(text).toContain('boom');
    expect(model.thinking).toBe(false);
  });
});
