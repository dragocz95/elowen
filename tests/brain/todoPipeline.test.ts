import { describe, it, expect } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { toBrainEvent } from '../../src/brain/events.js';
import { normalizeTodos } from '../../src/brain/todos.js';
import { shapeBrainMessages } from '../../src/brain/messageView.js';
import type { BrainMessageRow } from '../../src/store/brainStore.js';
import { latestTodos } from '../../src/cli/chat/render.js';

describe('normalizeTodos', () => {
  it('drops junk, coerces status, keeps titles', () => {
    const out = normalizeTodos([
      { title: 'A', status: 'completed' },
      { title: '  ', status: 'pending' },   // empty title dropped
      { title: 'B', status: 'bogus' },      // unknown status → pending
      'nope',                                // non-object dropped
      { title: 'C', status: 'in_progress' },
    ]);
    expect(out).toEqual([
      { title: 'A', status: 'completed' },
      { title: 'B', status: 'pending' },
      { title: 'C', status: 'in_progress' },
    ]);
  });
  it('returns [] for a non-array', () => {
    expect(normalizeTodos(undefined)).toEqual([]);
    expect(normalizeTodos('x')).toEqual([]);
  });
});

describe('toBrainEvent — todo lift', () => {
  it('lifts result.details.todos into a todo event', () => {
    const e = { type: 'tool_execution_end', result: { details: { todos: [{ title: 'A', status: 'completed' }] } } } as unknown as AgentSessionEvent;
    expect(toBrainEvent(e)).toEqual({ type: 'todo', todos: [{ title: 'A', status: 'completed' }] });
  });
  it('prefers a diff over todos when both are present (edit tools)', () => {
    const e = { type: 'tool_execution_end', result: { details: { diff: '-  1 a\n+  1 b', todos: [] } } } as unknown as AgentSessionEvent;
    expect(toBrainEvent(e)).toMatchObject({ type: 'diff' });
  });
});

describe('shapeBrainMessages + latestTodos — rehydration', () => {
  it('lifts details.todos off a toolResult onto the toolCall segment, and latestTodos returns the last snapshot', () => {
    const rows: BrainMessageRow[] = [
      { role: 'assistant', content: JSON.stringify({ content: [{ type: 'toolCall', id: 'c1', name: 'todo_write', arguments: {} }] }) },
      { role: 'toolResult', content: JSON.stringify({ toolCallId: 'c1', details: { todos: [{ title: 'A', status: 'in_progress' }] } }) },
      { role: 'assistant', content: JSON.stringify({ content: [{ type: 'toolCall', id: 'c2', name: 'todo_write', arguments: {} }] }) },
      { role: 'toolResult', content: JSON.stringify({ toolCallId: 'c2', details: { todos: [{ title: 'A', status: 'completed' }, { title: 'B', status: 'pending' }] } }) },
    ] as BrainMessageRow[];
    const views = shapeBrainMessages(rows);
    const firstTool = views[0]?.segments?.find((s) => s.kind === 'tool');
    expect(firstTool && 'todos' in firstTool ? firstTool.todos : null).toEqual([{ title: 'A', status: 'in_progress' }]);
    // The panel state on resume = the LAST todo snapshot across the whole history.
    expect(latestTodos(views)).toEqual([{ title: 'A', status: 'completed' }, { title: 'B', status: 'pending' }]);
  });

  it('latestTodos is [] when no todo tool ran', () => {
    const rows: BrainMessageRow[] = [
      { role: 'assistant', content: JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }) },
    ] as BrainMessageRow[];
    expect(latestTodos(shapeBrainMessages(rows))).toEqual([]);
  });
});
