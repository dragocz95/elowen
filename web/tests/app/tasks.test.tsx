import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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
  http.get('*/api/tasks', () => HttpResponse.json([
    { id: 'elowen-1', title: 'Build', status: 'in_progress', type: 'task', labels: [] },
    { id: 'elowen-2', title: 'Plan', status: 'open', type: 'task', labels: [] },
    { id: 'elowen-3', title: 'Wait', status: 'blocked', type: 'task', labels: [] },
    { id: 'elowen-4', title: 'Done', status: 'closed', type: 'task', labels: [] },
    { id: 'elowen-5', title: 'Mission', status: 'open', type: 'epic', labels: [] },
    { id: 'elowen-6', parent_id: 'elowen-5', title: 'Phase', status: 'open', type: 'task', labels: [] },
  ])),
  http.get('*/api/projects', () => HttpResponse.json([
    { id: 1, slug: 'alpha', path: '/repo/alpha', notes: '', icon: '', pr_enabled: null },
    { id: 2, slug: 'beta', path: '/repo/beta', notes: '', icon: '', pr_enabled: null },
  ])),
  http.get('*/api/config', () => HttpResponse.json({ autopilot: { overseerExec: '' }, defaults: { exec: '', autonomy: 'L3', maxSessions: 1 } })),
  http.post('*/api/sessions', async ({ request }) => { spawnBody = await request.json(); return HttpResponse.json({ session: 'elowen-A' }, { status: 201 }); }),
);
beforeEach(() => localStorage.clear());
beforeAll(() => server.listen({ onUnhandledRequest })); afterAll(() => server.close());

describe('TasksPage', () => {
  it('uses one mascot-led hero and a counted spatial status rail instead of pills', async () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><TasksPage /></ToastProvider></Wrapper>);
    const projects = await screen.findByRole('button', { name: /project/i });
    const toolbar = projects.parentElement?.parentElement!;
    const statuses = screen.getByRole('radiogroup', { name: 'Task status' });
    expect(toolbar.className).toContain('flex-wrap');
    expect(toolbar.className).not.toContain('overflow-x-auto');
    expect(statuses.closest('[data-testid="spatial-section-rail"]')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Active 1/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Open 2/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Autopilot 1/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /All 5/ })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Elowen' })).toHaveLength(1);
    expect(screen.getByTestId('spatial-workspace-layout')).toBeInTheDocument();
    expect(container.querySelector('.workspace-tabs')).toBeNull();
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

  it('switches the spatial rail and persists the selected filter', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TasksPage /></ToastProvider></Wrapper>);
    const open = await screen.findByRole('radio', { name: /Open 2/ });
    fireEvent.click(open);
    expect(open).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('elowen.tasks.filter')).toBe('open');
    expect(screen.getByText('Plan')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Build')).toBeNull());
  });

  it('opens task context in the workspace detail rail', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TasksPage /></ToastProvider></Wrapper>);
    const row = (await screen.findByText('Build')).closest('[role="button"]')!;
    fireEvent.click(row);
    expect(await screen.findByRole('complementary', { name: 'Task detail' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Task detail' })).toBeNull();
  });
});
