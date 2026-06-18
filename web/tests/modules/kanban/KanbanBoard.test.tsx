import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { KanbanBoard } from '../../../modules/kanban/KanbanBoard';
import { createWrapper } from '../../test-utils';
import type { Task } from '../../../lib/types';

const tasks: Task[] = [
  { id: 'a', title: 'Alpha', status: 'open' },
  { id: 'b', title: 'Beta', status: 'blocked' },
];

const enriched: Task[] = [
  { id: 'c', title: 'Gamma', status: 'closed', outcome: 'ok', result_summary: 'npm test passed (132/132)', labels: ['agent:atlas', 'exec:sonnet'] },
];

function makeDrop(taskId: string) {
  return { dataTransfer: { getData: () => taskId, setData: () => {}, dropEffect: '' } };
}

describe('KanbanBoard', () => {
  it('renders all five columns with counts', () => {
    const { wrapper: W } = createWrapper();
    render(<KanbanBoard tasks={tasks} onMove={() => {}} />, { wrapper: W });
    // All five status columns render (labels may repeat as status badges, so assert by column id).
    for (const s of ['open', 'in_progress', 'blocked', 'closed', 'cancelled']) {
      expect(screen.getByTestId(`column-${s}`)).toBeTruthy();
    }
    // The open column header shows its count of 1 (task 'a').
    expect(within(screen.getByTestId('column-open')).getByText('1')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  it('dropping a card on a different column calls onMove(taskId, newStatus)', () => {
    const onMove = vi.fn();
    const { wrapper: W } = createWrapper();
    render(<KanbanBoard tasks={tasks} onMove={onMove} />, { wrapper: W });
    const inProgress = screen.getByTestId('column-in_progress');
    fireEvent.dragOver(inProgress);
    fireEvent.drop(inProgress, makeDrop('a'));
    expect(onMove).toHaveBeenCalledWith('a', 'in_progress');
  });

  it('renders agent identity, result summary and outcome on an enriched card', () => {
    const { wrapper: W } = createWrapper();
    render(<KanbanBoard tasks={enriched} onMove={() => {}} />, { wrapper: W });
    const card = within(screen.getByTestId('column-closed'));
    expect(card.getByText('orca-atlas')).toBeTruthy();              // resolved agent session name
    expect(card.getByText('npm test passed (132/132)')).toBeTruthy(); // result summary on the closed card
    expect(card.getByText('Success')).toBeTruthy();                  // outcome badge
  });

  it('dropping on the same column does not call onMove', () => {
    const onMove = vi.fn();
    const { wrapper: W } = createWrapper();
    render(<KanbanBoard tasks={tasks} onMove={onMove} />, { wrapper: W });
    const open = screen.getByTestId('column-open');
    fireEvent.drop(open, makeDrop('a'));
    expect(onMove).not.toHaveBeenCalled();
  });
});
