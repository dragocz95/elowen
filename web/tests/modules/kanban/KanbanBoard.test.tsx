import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { KanbanBoard } from '../../../modules/kanban/KanbanBoard';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Task } from '../../../lib/types';

/** Board renders toasts via its context menu hook, so every render needs a ToastProvider too. */
function wrap() {
  const { wrapper: Base } = createWrapper();
  return { wrapper: ({ children }: { children: ReactNode }) => <Base><ToastProvider>{children}</ToastProvider></Base> };
}

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
    const { wrapper: W } = wrap();
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
    const { wrapper: W } = wrap();
    render(<KanbanBoard tasks={tasks} onMove={onMove} />, { wrapper: W });
    const inProgress = screen.getByTestId('column-in_progress');
    fireEvent.dragOver(inProgress);
    fireEvent.drop(inProgress, makeDrop('a'));
    expect(onMove).toHaveBeenCalledWith('a', 'in_progress');
  });

  it('renders agent identity, result summary and outcome on an enriched card', () => {
    const { wrapper: W } = wrap();
    render(<KanbanBoard tasks={enriched} onMove={() => {}} />, { wrapper: W });
    const card = within(screen.getByTestId('column-closed'));
    expect(card.getByText('orca-atlas')).toBeTruthy();              // resolved agent session name
    expect(card.getByText('npm test passed (132/132)')).toBeTruthy(); // result summary on the closed card
    expect(card.getByText('Success')).toBeTruthy();                  // outcome badge
  });

  it('collapses autopilot epic phases until the epic is expanded', () => {
    const epicTasks: Task[] = [
      { id: 'e', title: 'Autopilot Epic', status: 'in_progress', type: 'epic' },
      { id: 'p1', title: 'Phase One', status: 'in_progress', parent_id: 'e' },
      { id: 'p2', title: 'Phase Two', status: 'open', parent_id: 'e' },
    ];
    const { wrapper: W } = wrap();
    render(<KanbanBoard tasks={epicTasks} onMove={() => {}} />, { wrapper: W });
    // Epic header is shown; phases are hidden while collapsed.
    const header = screen.getByRole('button', { name: /Autopilot Epic/ });
    expect(header).toBeTruthy();
    expect(screen.queryByText('Phase One')).toBeNull();
    // Expanding reveals the phases.
    fireEvent.click(header);
    expect(screen.getByText('Phase One')).toBeTruthy();
    expect(screen.getByText('Phase Two')).toBeTruthy();
  });

  it('dropping on the same column does not call onMove', () => {
    const onMove = vi.fn();
    const { wrapper: W } = wrap();
    render(<KanbanBoard tasks={tasks} onMove={onMove} />, { wrapper: W });
    const open = screen.getByTestId('column-open');
    fireEvent.drop(open, makeDrop('a'));
    expect(onMove).not.toHaveBeenCalled();
  });

  describe('allTasks rollup independence from date filter', () => {
    // Simulate a date filter that hides the open phase (p2) but still shows the epic and the
    // closed phase (p1). Without allTasks the board would derive the epic's effective status only
    // from the visible children and wrongly report it as closed.
    const epic: Task = { id: 'e2', title: 'Filtered Epic', status: 'open', type: 'epic' };
    const closedPhase: Task = { id: 'ph1', title: 'Done Phase', status: 'closed', outcome: 'ok', parent_id: 'e2' };
    const openPhase: Task = { id: 'ph2', title: 'Future Phase', status: 'open', parent_id: 'e2' };

    it('with allTasks: epic with a filtered-out open phase is NOT shown as closed', () => {
      const { wrapper: W } = wrap();
      // tasks = filtered view (open phase absent); allTasks = full project set
      render(
        <KanbanBoard tasks={[epic, closedPhase]} allTasks={[epic, closedPhase, openPhase]} onMove={() => {}} />,
        { wrapper: W },
      );
      // The epic should land in the 'open' column because its open phase is visible in allTasks.
      expect(within(screen.getByTestId('column-open')).getByRole('button', { name: /Filtered Epic/ })).toBeTruthy();
      // And it must not appear in the 'closed' column.
      expect(within(screen.getByTestId('column-closed')).queryByText('Filtered Epic')).toBeNull();
    });

    it('with allTasks: progress counter reflects ALL phases, not just the filtered subset', () => {
      const { wrapper: W } = wrap();
      render(
        <KanbanBoard tasks={[epic, closedPhase]} allTasks={[epic, closedPhase, openPhase]} onMove={() => {}} />,
        { wrapper: W },
      );
      // KanbanEpicCard renders "<done>/<total>" — with two phases (one closed, one open) it
      // should read "1/2", not "1/1" as it would if derived from the filtered tasks only.
      expect(within(screen.getByTestId('column-open')).getByText('1/2')).toBeTruthy();
    });

    it('without allTasks: backward-compat — epic with all visible phases closed reads as closed', () => {
      const { wrapper: W } = wrap();
      // No allTasks → falls back to tasks; tasks only contains the closed phase.
      render(
        <KanbanBoard tasks={[epic, closedPhase]} onMove={() => {}} />,
        { wrapper: W },
      );
      expect(within(screen.getByTestId('column-closed')).getByRole('button', { name: /Filtered Epic/ })).toBeTruthy();
      expect(within(screen.getByTestId('column-closed')).getByText('1/1')).toBeTruthy();
    });
  });
});
