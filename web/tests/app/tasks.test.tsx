import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import TasksPage from '../../app/tasks/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

let spawnBody: unknown = null;
const server = setupServer(
  http.get('*/api/tasks', () => HttpResponse.json([{ id: 'elowen-1', title: 'Build', status: 'in_progress', type: 'task', labels: [] }])),
  http.get('*/api/projects', () => HttpResponse.json([
    { id: 1, slug: 'alpha', path: '/repo/alpha', notes: '', icon: '', pr_enabled: null },
    { id: 2, slug: 'beta', path: '/repo/beta', notes: '', icon: '', pr_enabled: null },
  ])),
  http.post('*/api/sessions', async ({ request }) => { spawnBody = await request.json(); return HttpResponse.json({ session: 'elowen-A' }, { status: 201 }); }),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterAll(() => server.close());

describe('TasksPage', () => {
  it('keeps the toolbar and its status choices wrapping instead of horizontally scrolling', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TasksPage /></ToastProvider></Wrapper>);
    const projects = await screen.findByRole('group', { name: /project/i });
    const toolbar = projects.parentElement!;
    const statuses = screen.getByRole('radiogroup');
    expect(toolbar.className).toContain('flex-wrap');
    expect(toolbar.className).not.toContain('overflow-x-auto');
    expect(statuses.className).toContain('flex-wrap');
    expect(statuses.className).not.toContain('flex-nowrap');
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument();
  });

  it('launches a task via the Launch action', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TasksPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('elowen-1')).toBeInTheDocument());
    // No live session for this task → the run control shows "Start"
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(spawnBody).toMatchObject({ taskId: 'elowen-1' }));
  });
});
