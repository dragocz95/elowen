import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KanbanBoard } from '../../../modules/kanban/KanbanBoard';
import type { Task } from '../../../lib/types';

const tasks: Task[] = [
  { id: 'a', title: 'Alpha', status: 'open' },
  { id: 'b', title: 'Beta', status: 'blocked' },
];

function makeDrop(taskId: string) {
  return { dataTransfer: { getData: () => taskId, setData: () => {}, dropEffect: '' } };
}

describe('KanbanBoard', () => {
  it('renders all five columns with counts', () => {
    render(<KanbanBoard tasks={tasks} onMove={() => {}} />);
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.getByText('Closed')).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  it('dropping a card on a different column calls onMove(taskId, newStatus)', () => {
    const onMove = vi.fn();
    render(<KanbanBoard tasks={tasks} onMove={onMove} />);
    const inProgress = screen.getByTestId('column-in_progress');
    fireEvent.dragOver(inProgress);
    fireEvent.drop(inProgress, makeDrop('a'));
    expect(onMove).toHaveBeenCalledWith('a', 'in_progress');
  });

  it('dropping on the same column does not call onMove', () => {
    const onMove = vi.fn();
    render(<KanbanBoard tasks={tasks} onMove={onMove} />);
    const open = screen.getByTestId('column-open');
    fireEvent.drop(open, makeDrop('a'));
    expect(onMove).not.toHaveBeenCalled();
  });
});
