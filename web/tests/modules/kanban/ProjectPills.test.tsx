import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import KanbanPage from '../../../app/kanban/page';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const PROJECTS = [
  { id: 1, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '', pr_enabled: null },
  { id: 2, slug: 'other', path: '/var/www/other', notes: '', icon: '', pr_enabled: null },
];
const ALL = [
  { id: 't-a', title: 'Alpha', status: 'in_progress', type: 'task', labels: [], project_id: 1 },
  { id: 't-b', title: 'Beta', status: 'open', type: 'task', labels: [], project_id: 2 },
];

let lastTasksUrl = '';
const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json(PROJECTS)),
  http.get('*/api/tasks', ({ request }) => {
    lastTasksUrl = request.url;
    const u = new URL(request.url);
    const pid = u.searchParams.get('project_id');
    return HttpResponse.json(pid ? ALL.filter((t) => t.project_id === Number(pid)) : ALL);
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest })); afterAll(() => server.close());
beforeEach(() => { localStorage.clear(); lastTasksUrl = ''; });

describe('KanbanPage project pills', () => {
  it('narrow the board via /tasks?project_id=N and "All" resets it', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><KanbanPage /></ToastProvider></Wrapper>);

    // Default = "All projects" → both tasks appear on the board.
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(lastTasksUrl).not.toContain('project_id=');

    // Open the project dropdown and choose "other" → only Beta.
    fireEvent.click(screen.getByRole('button', { name: 'Project filter' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'other' }));
    await waitFor(() => expect(lastTasksUrl).toContain('project_id=2'));
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
    expect(screen.getByText('Beta')).toBeInTheDocument();

    // Reopen the dropdown and choose "All projects" → both back.
    fireEvent.click(screen.getByRole('button', { name: 'Project filter' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'All projects' }));
    await waitFor(() => expect(lastTasksUrl).not.toContain('project_id='));
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
  });

  it('conveys the active project with a checked menu item', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><KanbanPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Project filter' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Project filter' }));
    expect(screen.getByRole('menuitemradio', { name: 'All projects' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'other' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'other' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Project filter' })).toHaveTextContent('other'));
    fireEvent.click(screen.getByRole('button', { name: 'Project filter' }));
    expect(screen.getByRole('menuitemradio', { name: 'other' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'All projects' })).toHaveAttribute('aria-checked', 'false');
  });
});
