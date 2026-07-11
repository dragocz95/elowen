import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { TaskCard } from '../../../modules/tasks/TaskCard';
import { useTaskDrop } from '../../../modules/tasks/useTaskDrop';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Task } from '../../../lib/types';

const server = setupServer(
  http.get('*/api/sessions', () => HttpResponse.json([])),
  http.get('*/api/projects', () => HttpResponse.json([{ id: 1, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '', pr_enabled: null }])),
  http.get('*/api/config', () => HttpResponse.json({})),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeDrop(taskId: string) {
  return { dataTransfer: { getData: () => taskId, setData: () => {}, dropEffect: '' } };
}

const task = (over: Partial<Task> & { id: string }): Task => ({ title: over.id, status: 'open', project_id: 1, ...over });

describe('TaskCard drag-onto-card', () => {
  it('opens from Enter or Space without handling key events from nested controls', () => {
    const open = vi.fn();
    const { wrapper: W } = createWrapper();
    render(
      <ToastProvider><TaskCard task={task({ id: 'keyboard', title: 'Keyboard task' })} onEdit={open} /></ToastProvider>,
      { wrapper: W },
    );

    const card = screen.getByText('Keyboard task').closest('[role="button"]')!;
    expect(card).toHaveClass('px-4');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(open).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Start' }), { key: 'Enter' });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('dropping a dragged task onto a plain task card opens the make-subtask/add-dependency choice', () => {
    function Harness() {
      const a = task({ id: 'a', title: 'Alpha' });
      const b = task({ id: 'b', title: 'Beta' });
      const taskDrop = useTaskDrop([a, b], new Map(), new Set());
      return (
        <>
          <TaskCard task={b} onEdit={() => {}} onDropTask={(e) => taskDrop.handleDrop(e, b)} dropTargetValid={taskDrop.isValidTarget('a', b)} />
          {taskDrop.popup}
        </>
      );
    }
    const { wrapper: W } = createWrapper();
    render(<ToastProvider><Harness /></ToastProvider>, { wrapper: W });
    fireEvent.drop(screen.getByText('Beta'), makeDrop('a'));
    expect(screen.getByRole('menuitem', { name: 'Make subtask of Beta' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Add dependency on Beta' })).toBeTruthy();
  });

  it('dropping onto an epic card reparents directly with no popup', async () => {
    server.use(http.patch('*/api/tasks/:id', () => HttpResponse.json({ id: 'a', title: 'Alpha', status: 'open', type: 'task', parent_id: 'epic' })));
    function Harness() {
      const a = task({ id: 'a', title: 'Alpha' });
      const epic = task({ id: 'epic', title: 'Mission Epic', type: 'epic' });
      const taskDrop = useTaskDrop([a, epic], new Map(), new Set());
      return (
        <>
          <TaskCard task={epic} onEdit={() => {}} onDropTask={(e) => taskDrop.handleDrop(e, epic)} dropTargetValid={taskDrop.isValidTarget('a', epic)} />
          {taskDrop.popup}
        </>
      );
    }
    const { wrapper: W } = createWrapper();
    render(<ToastProvider><Harness /></ToastProvider>, { wrapper: W });
    fireEvent.drop(screen.getByText('Mission Epic'), makeDrop('a'));
    expect(screen.queryByRole('menuitem')).toBeNull();
    await waitFor(() => expect(screen.getByText('Added as a subtask of Mission Epic')).toBeTruthy());
  });

  it('a phase card (isPhase) is not draggable and ignores drops', () => {
    const { wrapper: W } = createWrapper();
    render(
      <ToastProvider><TaskCard task={task({ id: 'p', title: 'Phase' })} onEdit={() => {}} isPhase onDropTask={() => { throw new Error('must not be called'); }} /></ToastProvider>,
      { wrapper: W },
    );
    const card = screen.getByText('Phase').closest('[role="button"]')!;
    expect(card.getAttribute('draggable')).toBe('false');
    expect(() => fireEvent.drop(card, makeDrop('x'))).not.toThrow();
  });
});
