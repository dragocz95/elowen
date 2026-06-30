import { describe, it, expect } from 'vitest';
import { canDropOnTask, canReparent } from '../../../modules/tasks/useTaskDrop';
import type { Task } from '../../../lib/types';

const task = (over: Partial<Task> & { id: string }): Task => ({ title: over.id, status: 'open', project_id: 1, ...over });

describe('canDropOnTask', () => {
  it('rejects dropping a task onto itself', () => {
    const a = task({ id: 'a' });
    expect(canDropOnTask(a, a, new Set())).toBe(false);
  });
  it('rejects a cross-project drop', () => {
    const a = task({ id: 'a', project_id: 1 });
    const b = task({ id: 'b', project_id: 2 });
    expect(canDropOnTask(a, b, new Set())).toBe(false);
  });
  it('rejects when the dragged task is already a phase', () => {
    const a = task({ id: 'a', parent_id: 'epic' });
    const b = task({ id: 'b' });
    expect(canDropOnTask(a, b, new Set())).toBe(false);
    expect(canDropOnTask(task({ id: 'c' }), b, new Set(['c']))).toBe(false);
  });
  it('rejects when the target is already a phase', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', parent_id: 'epic' });
    expect(canDropOnTask(a, b, new Set())).toBe(false);
    expect(canDropOnTask(a, task({ id: 'd' }), new Set(['d']))).toBe(false);
  });
  it('allows a valid standalone-onto-standalone drop', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    expect(canDropOnTask(a, b, new Set())).toBe(true);
  });
  it('allows dropping an epic-with-children onto a plain task (dependency is still legal)', () => {
    const epic = task({ id: 'epic', type: 'epic' });
    const b = task({ id: 'b' });
    expect(canDropOnTask(epic, b, new Set())).toBe(true);
  });
});

describe('canReparent', () => {
  it('true when the dragged task has no children', () => {
    expect(canReparent(task({ id: 'a' }), new Map())).toBe(true);
  });
  it('false when the dragged task already has children (no nested epics)', () => {
    const childMap = new Map([['epic', [task({ id: 'phase' })]]]);
    expect(canReparent(task({ id: 'epic' }), childMap)).toBe(false);
  });
});
