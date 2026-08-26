import { fireEvent, render, screen } from '@testing-library/react';
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
  useTranslation: () => ({
    t: {
      tasksModal: {
        modalTitle: 'Tasks', filterPlaceholder: 'Filter tasks', status: 'Status',
        statusPending: 'Pending', statusInProgress: 'In progress', statusCompleted: 'Completed',
        blockedBy: 'Blocked by', deleteTitle: 'Delete this task?',
        clearCompleted: 'Clear completed', clearCompletedTitle: 'Clear completed tasks?',
        clearCompletedDescription: 'Completed tasks will be permanently removed.',
        clearAll: 'Clear all', clearAllTitle: 'Clear all tasks?',
        clearAllDescription: 'All tasks will be permanently removed.',
        emptyTitle: 'No tasks', emptyDesc: 'No tasks here.',
      },
      common: { cancel: 'Cancel', delete: 'Delete', close: 'Close', daemonUnreachable: 'Unavailable' },
    },
  }),
}));

describe('TasksModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows stable IDs and live elapsed time, with one confirmation per bulk clear action', () => {
    render(<TasksModal onClose={vi.fn()} />);

    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText('#8')).toBeInTheDocument();
    expect(screen.getByText('· 2m 49s')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear completed' }));
    expect(screen.getByRole('heading', { name: 'Clear completed tasks?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('heading', { name: 'Clear all tasks?' })).toBeInTheDocument();
    expect(clearMutate).not.toHaveBeenCalled();
  });
});
