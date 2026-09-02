import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksModal } from '../../../modules/advisor/TasksModal';

const clearMutate = vi.fn();
const deleteMutate = vi.fn();
const updateMutate = vi.fn();

vi.mock('../../../modules/advisor/BrainChatProvider', () => ({
  useBrainChat: () => ({ activeSessionId: 'brain-7-a', syncSessionTasks: vi.fn() }),
}));
vi.mock('../../../lib/queries', () => ({
  useSessionTasks: () => ({
    data: {
      tasks: [
        {
          id: '7', subject: 'Timed task', description: 'Visible detail', activeForm: 'Timing task',
          status: 'in_progress', startedAt: 0, metadata: {}, blockedBy: [], blocks: [],
        },
        {
          id: '8', subject: 'Finished task', description: 'Done', status: 'completed',
          metadata: {}, blockedBy: [], blocks: [],
        },
        {
          id: '9', subject: 'Waiting task', description: '', status: 'pending', owner: 'reviewer',
          metadata: {}, blockedBy: ['7'], blocks: [],
        },
      ],
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../../lib/mutations', () => ({
  useClearSessionTasks: () => ({ mutate: clearMutate, isPending: false }),
  useDeleteSessionTask: () => ({ mutate: deleteMutate, isPending: false }),
  useUpdateSessionTask: () => ({ mutate: updateMutate, isPending: false }),
}));
vi.mock('../../../lib/useNow', () => ({ useNow: () => 169_000 }));
vi.mock('../../../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../../../lib/i18n', () => ({
  interpolate: (template: string, values: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (placeholder, key) => (key in values ? String(values[key]) : placeholder)),
  useTranslation: () => ({
    t: {
      tasksModal: {
        modalTitle: 'Tasks', filterPlaceholder: 'Filter tasks', status: 'Status',
        statusPending: 'Pending', statusInProgress: 'In progress', statusCompleted: 'Completed',
        blockedBy: 'Blocked by', deleteTitle: 'Delete this task?',
        markCompleted: 'Mark as completed', markPending: 'Mark as pending',
        rename: 'Rename', renameLabel: 'Task name', owner: 'Owner', taskActions: 'Task actions',
        completedGroup: 'Completed ({n})',
        clearCompleted: 'Clear completed', clearCompletedTitle: 'Clear completed tasks?',
        clearCompletedDescription: 'Completed tasks will be permanently removed.',
        clearAll: 'Clear all', clearAllTitle: 'Clear all tasks?',
        clearAllDescription: 'All tasks will be permanently removed.',
        emptyTitle: 'No tasks', emptyDesc: 'No tasks here.',
      },
      common: { cancel: 'Cancel', delete: 'Delete', close: 'Close', actions: 'Actions', daemonUnreachable: 'Unavailable' },
    },
  }),
}));

const renderModal = () => render(<TasksModal onClose={vi.fn()} />);

describe('TasksModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows stable IDs and live elapsed time, with one confirmation per bulk clear action', () => {
    renderModal();

    expect(screen.getByText('#7')).toBeInTheDocument();
    // QUERY CHANGED, not behaviour: the elapsed time lost its leading "· " separator when the row moved
    // from a stacked block to a single line, where it sits in its own column.
    expect(screen.getByText('2m 49s')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear completed' }));
    expect(screen.getByRole('heading', { name: 'Clear completed tasks?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('heading', { name: 'Clear all tasks?' })).toBeInTheDocument();
    expect(clearMutate).not.toHaveBeenCalled();
  });

  // BEHAVIOUR CHANGED: finished work used to sit in the list between the open tasks. It is history, so it
  // folds into one group at the bottom — reachable, reopenable, but not what the list shows first.
  it('folds finished work into a collapsed group and opens it on demand', () => {
    renderModal();

    expect(screen.queryByText('Finished task')).toBeNull();
    const group = screen.getByRole('button', { name: 'Completed (1)' });
    fireEvent.click(group);
    expect(screen.getByText('Finished task')).toBeInTheDocument();
    // #8 is completed, so its box is ticked and ticking it again reopens it.
    expect(screen.getByRole('checkbox', { name: 'Mark as pending: Finished task' })).toBeChecked();
  });

  // BEHAVIOUR CHANGED: the description was printed under every subject. It is private agent context and
  // made a list of twenty unreadable, so it is revealed per row instead.
  it('reveals a task description under the row and leaves a task without one inert', () => {
    renderModal();

    expect(screen.queryByText('Visible detail')).toBeNull();
    // The subject, not the activeForm: this is the row a rename edits, so it has to show the name it
    // would change. The activeForm is a progress label and belongs to the live panels.
    fireEvent.click(screen.getByRole('button', { name: 'Timed task' }));
    expect(screen.getByText('Visible detail')).toBeInTheDocument();

    // "Waiting task" carries an empty description, so its subject is plain text with nothing to unfold.
    expect(screen.queryByRole('button', { name: 'Waiting task' })).toBeNull();
    expect(screen.getByText('Waiting task')).toBeInTheDocument();
  });

  it('shows the owner and the unresolved blockers of a waiting task', () => {
    renderModal();

    expect(screen.getByTitle('Owner')).toHaveTextContent('reviewer');
    expect(screen.getByText('Blocked by: #7')).toBeInTheDocument();
  });

  // QUERY CHANGED, not behaviour: the same status change used to go through a native <select>. It is a
  // tick box for the two everyday states now, with the third in the row menu.
  it('ticks a pending task off through its checkbox', () => {
    renderModal();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark as completed: Waiting task' }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]![0]).toEqual({ sessionId: 'brain-7-a', taskId: '9', status: 'completed' });
  });

  it('offers every status and the destructive actions in the row menu', async () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Task actions: Waiting task' }));
    const menu = await screen.findByRole('menu');
    for (const name of ['Pending', 'In progress', 'Completed', 'Rename', 'Delete']) {
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    }

    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'In progress' })); });
    expect(updateMutate.mock.calls[0]![0]).toEqual({ sessionId: 'brain-7-a', taskId: '9', status: 'in_progress' });
  });

  it('deletes from the row menu behind the existing confirmation', async () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Task actions: Waiting task' }));
    const menu = await screen.findByRole('menu');
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' })); });

    expect(screen.getByRole('heading', { name: 'Delete this task?' })).toBeInTheDocument();
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  // The rename is the reason PATCH grew a `subject` field; Enter and blur are the two ways out of a field
  // that replaces a label in place, and each has to end in exactly one patch.
  it('renames a task inline and patches the subject once on Enter', async () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Task actions: Waiting task' }));
    const menu = await screen.findByRole('menu');
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' })); });

    const field = screen.getByRole('textbox', { name: 'Task name: Waiting task' });
    fireEvent.change(field, { target: { value: 'Renamed task' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    // Enter closes the field, so the blur that follows the reader leaving it has nothing left to commit.
    fireEvent.blur(field);

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]![0]).toEqual({ sessionId: 'brain-7-a', taskId: '9', subject: 'Renamed task' });
  });

  it('commits a rename on blur and sends nothing when the subject is unchanged or empty', async () => {
    renderModal();

    const openRename = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Task actions: Waiting task' }));
      const menu = await screen.findByRole('menu');
      await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' })); });
      return screen.getByRole('textbox', { name: 'Task name: Waiting task' });
    };

    let field = await openRename();
    fireEvent.blur(field);
    expect(updateMutate).not.toHaveBeenCalled();

    field = await openRename();
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.blur(field);
    expect(updateMutate).not.toHaveBeenCalled();

    field = await openRename();
    fireEvent.change(field, { target: { value: 'Blurred rename' } });
    fireEvent.blur(field);
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]![0]).toEqual({ sessionId: 'brain-7-a', taskId: '9', subject: 'Blurred rename' });
  });

  it('abandons a rename on Escape', async () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Task actions: Waiting task' }));
    const menu = await screen.findByRole('menu');
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' })); });

    const field = screen.getByRole('textbox', { name: 'Task name: Waiting task' });
    fireEvent.change(field, { target: { value: 'Discarded' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.blur(field);

    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Waiting task')).toBeInTheDocument();
  });

  // The native control the redesign replaced. It carried the status change and nothing else, and a
  // <select> reappearing here would mean the row grew a second, unstyled way to do the same thing.
  it('keeps the native select out of the list', () => {
    renderModal();
    expect(document.querySelector('select')).toBeNull();
  });
});
