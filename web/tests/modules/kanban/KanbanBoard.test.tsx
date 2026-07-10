import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { KanbanBoard } from '../../../modules/kanban/KanbanBoard';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Task } from '../../../lib/types';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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

  it('opens a regular card from Enter or Space', () => {
    const onSelect = vi.fn();
    const { wrapper: W } = wrap();
    render(<KanbanBoard tasks={tasks} onMove={() => {}} onSelect={onSelect} />, { wrapper: W });
    const card = screen.getByRole('button', { name: /Alpha/ });

    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });

    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenNthCalledWith(1, tasks[0]);
    expect(onSelect).toHaveBeenNthCalledWith(2, tasks[0]);
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
    expect(card.getByText('atlas')).toBeTruthy();                   // resolved agent session name (friendly, no elowen- prefix)
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
    // The whole epic is keyboard-operable; Space expands just like click/Enter.
    fireEvent.keyDown(header, { key: ' ' });
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

  it('dropping a card onto another card opens the make-subtask/add-dependency choice, not a column move', () => {
    const onMove = vi.fn();
    const { wrapper: W } = wrap();
    render(<KanbanBoard tasks={tasks} onMove={onMove} />, { wrapper: W });
    // A real drag always fires dragstart on the source first — that's what arms `dropTargetValid`
    // (read from React state, since dataTransfer.getData is unavailable during dragover/drop in a
    // real browser for security reasons). Mirror that sequence here, not just the drop.
    fireEvent.dragStart(screen.getByText('Alpha'), makeDrop('a'));
    fireEvent.drop(screen.getByText('Beta'), makeDrop('a'));
    expect(screen.getByRole('menuitem', { name: 'Make subtask of Beta' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Add dependency on Beta' })).toBeTruthy();
    expect(onMove).not.toHaveBeenCalled(); // the card drop must not also trigger the column's own onDrop
  });

  it('dropping a card onto an epic card reparents directly with no choice popup', async () => {
    server.use(http.patch('*/api/tasks/:id', () => HttpResponse.json({ id: 'a', title: 'Alpha', status: 'open', type: 'task', parent_id: 'epic' })));
    const epicTasks: Task[] = [
      { id: 'a', title: 'Alpha', status: 'open' },
      { id: 'epic', title: 'Mission Epic', status: 'open', type: 'epic' },
    ];
    const { wrapper: W } = wrap();
    render(<KanbanBoard tasks={epicTasks} onMove={() => {}} />, { wrapper: W });
    fireEvent.dragStart(screen.getByText('Alpha'), makeDrop('a'));
    fireEvent.drop(screen.getByText('Mission Epic'), makeDrop('a'));
    expect(screen.queryByRole('menuitem')).toBeNull(); // no choice — an epic target reparents directly
    await waitFor(() => expect(screen.getByText('Added as a subtask of Mission Epic')).toBeTruthy());
  });

  it('dropping on an invalid target card (e.g. a closed task) lets the drop fall through to the column move', () => {
    const onMove = vi.fn();
    const closedAndOpen: Task[] = [
      { id: 'a', title: 'Alpha', status: 'closed' },
      { id: 'b', title: 'Beta', status: 'open' },
    ];
    const { wrapper: W } = wrap();
    render(<KanbanBoard tasks={closedAndOpen} onMove={onMove} />, { wrapper: W });
    fireEvent.dragStart(screen.getByText('Alpha'), makeDrop('a'));
    // Beta sits in the 'open' column; dropping a closed task onto it is not a legal subtask/dependency
    // target (closed tasks can't be reparented), so the drop must bubble to the column's status move.
    fireEvent.drop(screen.getByText('Beta'), makeDrop('a'));
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(onMove).toHaveBeenCalledWith('a', 'open');
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
