import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { EpicGroup } from '../../../modules/tasks/EpicGroup';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Task } from '../../../lib/types';

const epic: Task = { id: 'elowen-epic', title: 'Ship feature', status: 'in_progress', type: 'epic', project_id: 1 };
const phases: Task[] = [
  { id: 'elowen-p1', title: 'Phase One', status: 'closed', parent_id: 'elowen-epic' },
  { id: 'elowen-p2', title: 'Phase Two', status: 'open', parent_id: 'elowen-epic' },
];

const server = setupServer(
  http.get('*/api/sessions', () => HttpResponse.json([])),
  http.get('*/api/projects', () => HttpResponse.json([{ id: 1, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '', pr_enabled: null }])),
  // EpicGroup now drives the mission lifecycle + rolled-up cost, so it reads these too.
  http.get('*/api/missions', () => HttpResponse.json([])),
  http.get('*/api/config', () => HttpResponse.json({})),
  http.get('*/api/tasks/:id/usage', () => HttpResponse.json({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: null })),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderEpic(extra: Partial<React.ComponentProps<typeof EpicGroup>> = {}) {
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
        {...extra}
      />
    </ToastProvider>,
    { wrapper: W },
  );
}

describe('EpicGroup — delete mission', () => {
  it('uses the same horizontal register rhythm as plain task rows', () => {
    renderEpic();
    expect(screen.getByRole('button', { name: /ship feature/i })).toHaveClass('px-4');
  });

  it('confirming the delete-mission action issues DELETE /tasks/:id?subtree=1', async () => {
    let deleted: { id: string; subtree: string | null } | null = null;
    server.use(
      http.delete('*/api/tasks/:id', ({ params, request }) => {
        const url = new URL(request.url);
        deleted = { id: params.id as string, subtree: url.searchParams.get('subtree') };
        return HttpResponse.json({ ok: true, tasks: 3 });
      }),
    );

    renderEpic();

    // Open the epic action menu, then pick "Delete mission" → opens the confirm dialog.
    fireEvent.click(screen.getByRole('button', { name: /mission actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete mission/i }));

    // Confirm copy makes the irreversible, files-untouched scope explicit.
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/does not touch any files/i)).toBeInTheDocument();

    // The confirm button lives in the dialog footer (not the menu trigger, which has aria-haspopup).
    const confirm = screen.getAllByRole('button', { name: /delete mission/i }).find((b) => !b.hasAttribute('aria-haspopup'));
    fireEvent.click(confirm!);

    await waitFor(() => expect(deleted).toEqual({ id: 'elowen-epic', subtree: '1' }));
  });

  it('cancelling the confirm dialog does not delete', async () => {
    const calls = vi.fn();
    server.use(
      http.delete('*/api/tasks/:id', () => { calls(); return HttpResponse.json({ ok: true, tasks: 0 }); }),
    );

    renderEpic();
    fireEvent.click(screen.getByRole('button', { name: /mission actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete mission/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await new Promise((r) => setTimeout(r, 20));
    expect(calls).not.toHaveBeenCalled();
  });
});

describe('EpicGroup — PR-native surface', () => {
  const mission = (pr: unknown) => ({ id: 'm-elowen-epic', epic_id: 'elowen-epic', autonomy: 'L3', max_sessions: 1, state: 'disengaged', pr });

  it('links out to the open PR when one exists', async () => {
    server.use(http.get('*/api/missions', () => HttpResponse.json([mission({ branch: 'elowen/x', prNumber: 42, prUrl: 'https://github.com/o/r/pull/42', prState: 'open' })])));
    renderEpic();
    const link = await screen.findByTitle(/view pull request/i);
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/42');
    expect(link.textContent).toContain('42');
  });

  it('offers "Open PR" (POST /missions/:id/pr) only once the mission is ready', async () => {
    let opened: string | null = null;
    server.use(
      http.get('*/api/missions', () => HttpResponse.json([mission({ branch: 'elowen/x', prNumber: null, prUrl: null, prState: 'ready' })])),
      http.post('*/api/missions/:id/pr', ({ params }) => { opened = params.id as string; return HttpResponse.json({ url: 'https://github.com/o/r/pull/9', number: 9 }); }),
    );
    renderEpic();
    const btn = await screen.findByRole('button', { name: /open pr/i });
    fireEvent.click(btn);
    await waitFor(() => expect(opened).toBe('m-elowen-epic'));
  });

  it('does NOT offer "Open PR" mid-mission (worktree provisioned but no phases done yet)', async () => {
    // The regression guard: prState null means the mission just engaged / is still running — the
    // affordance must stay hidden so a partial PR can't be opened after only the first phase.
    server.use(http.get('*/api/missions', () => HttpResponse.json([mission({ branch: 'elowen/x', prNumber: null, prUrl: null, prState: null })])));
    renderEpic();
    await screen.findByText('Ship feature'); // rendered
    expect(screen.queryByRole('button', { name: /open pr/i })).toBeNull();
  });

  it('shows neither link nor button when the verify gate failed', async () => {
    server.use(http.get('*/api/missions', () => HttpResponse.json([mission({ branch: 'elowen/x', prNumber: null, prUrl: null, prState: 'verify_failed' })])));
    renderEpic();
    await screen.findByText('Ship feature'); // rendered
    expect(screen.queryByRole('link', { name: /view pull request/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /open pr/i })).toBeNull();
  });
});

describe('EpicGroup — drag a task card onto the group header', () => {
  function makeDrop(taskId: string) {
    return { dataTransfer: { getData: () => taskId, setData: () => {}, dropEffect: '' } };
  }

  it('routes a card-onto-header drop to onDropTask (the mission-attach gesture)', () => {
    const onDropTask = vi.fn((e: React.DragEvent) => e.preventDefault());
    renderEpic({ onDropTask, dropTargetValid: true });
    fireEvent.drop(screen.getByText('Ship feature'), makeDrop('elowen-other'));
    expect(onDropTask).toHaveBeenCalledTimes(1);
  });

  it('applies an accent highlight while a valid drag hovers, and clears it after drop', () => {
    const onDropTask = vi.fn((e: React.DragEvent) => e.preventDefault());
    renderEpic({ onDropTask, dropTargetValid: true });
    const header = screen.getByText('Ship feature');
    fireEvent.dragEnter(header, makeDrop('elowen-other'));
    const card = header.closest('.group\\/epic')!;
    expect(card.className).toMatch(/ring-accent/);
    fireEvent.drop(header, makeDrop('elowen-other'));
    expect(card.className).not.toMatch(/ring-accent/);
  });
});
