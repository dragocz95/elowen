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
  { id: 1, slug: 'orca', path: '/var/www/orca', notes: '' },
  { id: 2, slug: 'other', path: '/var/www/other', notes: '' },
];
const ALL = [
  { id: 't-a', title: 'Alpha', status: 'in_progress', type: 'task', labels: [], project_id: 1 },
  { id: 't-b', title: 'Beta', status: 'open', type: 'task', labels: [], project_id: 2 },
];

let lastTasksUrl = '';
const server = setupServer(
  http.get('http://localhost:4400/projects', () => HttpResponse.json(PROJECTS)),
  http.get('http://localhost:4400/tasks', ({ request }) => {
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

    // Click the "other" project pill → only Beta.
    fireEvent.click(screen.getByRole('button', { name: 'other' }));
    await waitFor(() => expect(lastTasksUrl).toContain('project_id=2'));
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
    expect(screen.getByText('Beta')).toBeInTheDocument();

    // Click "All projects" → both back.
    fireEvent.click(screen.getByRole('button', { name: /All projects/i }));
    await waitFor(() => expect(lastTasksUrl).not.toContain('project_id='));
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
  });
});