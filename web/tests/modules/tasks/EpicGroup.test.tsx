import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { EpicGroup } from '../../../modules/tasks/EpicGroup';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Task } from '../../../lib/types';

const epic: Task = { id: 'orca-epic', title: 'Ship feature', status: 'in_progress', type: 'epic', project_id: 1 };
const phases: Task[] = [
  { id: 'orca-p1', title: 'Phase One', status: 'closed', parent_id: 'orca-epic' },
  { id: 'orca-p2', title: 'Phase Two', status: 'open', parent_id: 'orca-epic' },
];

const server = setupServer(
  http.get('http://localhost:4400/sessions', () => HttpResponse.json([])),
  http.get('http://localhost:4400/projects', () => HttpResponse.json([{ id: 1, slug: 'orca', path: '/var/www/orca', notes: '' }])),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderEpic() {
  const { wrapper: W } = createWrapper();
  return render(
    <ToastProvider>
      <EpicGroup
        epic={epic}
        phases={phases}
        expanded={false}
        onToggle={() => {}}
        onEdit={() => {}}
        onSelect={() => {}}
        activeId={null}
        blockedBy={new Map()}
      />
    </ToastProvider>,
    { wrapper: W },
  );
}

describe('EpicGroup — delete mission', () => {
  it('confirming the delete-mission action issues DELETE /tasks/:id?subtree=1', async () => {
    let deleted: { id: string; subtree: string | null } | null = null;
    server.use(
      http.delete('http://localhost:4400/tasks/:id', ({ params, request }) => {
        const url = new URL(request.url);
        deleted = { id: params.id as string, subtree: url.searchParams.get('subtree') };
        return HttpResponse.json({ ok: true, tasks: 3 });
      }),
    );

    renderEpic();

    // Open the danger action menu, then pick "Delete mission" → opens the confirm dialog.
    fireEvent.click(screen.getByRole('button', { name: /delete mission/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete mission/i }));

    // Confirm copy makes the irreversible, files-untouched scope explicit.
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/does not touch any files/i)).toBeInTheDocument();

    // The confirm button lives in the dialog footer (not the menu trigger, which has aria-haspopup).
    const confirm = screen.getAllByRole('button', { name: /delete mission/i }).find((b) => !b.hasAttribute('aria-haspopup'));
    fireEvent.click(confirm!);

    await waitFor(() => expect(deleted).toEqual({ id: 'orca-epic', subtree: '1' }));
  });

  it('cancelling the confirm dialog does not delete', async () => {
    const calls = vi.fn();
    server.use(
      http.delete('http://localhost:4400/tasks/:id', () => { calls(); return HttpResponse.json({ ok: true, tasks: 0 }); }),
    );

    renderEpic();
    fireEvent.click(screen.getByRole('button', { name: /delete mission/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete mission/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await new Promise((r) => setTimeout(r, 20));
    expect(calls).not.toHaveBeenCalled();
  });
});
