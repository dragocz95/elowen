import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { createWrapper } from '../test-utils';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/dash',
  useRouter: () => ({ push, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import { Sidebar } from '../../components/shell/Sidebar';
import { CommandPalette } from '../../components/shell/CommandPalette';
import { DashboardView } from '../../modules/dashboard/DashboardView';

const tasksCalls: string[] = [];
const server = setupServer(
  http.get('*/api/health', () => HttpResponse.json({ ok: true })),
  http.get('*/api/tasks', ({ request }) => { tasksCalls.push(request.url); return HttpResponse.json([]); }),
  http.get('*/api/activity', () => HttpResponse.json([])),
  http.get('*/api/usage/by-model', () => HttpResponse.json([])),
  http.get('*/api/usage/by-day', () => HttpResponse.json([])),
  http.get('*/api/sessions', () => HttpResponse.json([{ name: 'elowen-7', role: 'agent' }])),
  http.get('*/api/asks/pending', () => HttpResponse.json([])),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());
beforeEach(() => { localStorage.clear(); tasksCalls.length = 0; push.mockClear(); });

const WORK_LISTING = [{ name: 'work', nav: [{ label: 'Tasks', icon: 'ListChecks', route: 'tasks' }], settings: [] }];

/** With the work plugin disabled the instance genuinely has no task register: `/tasks` answers 503.
 *  Every core surface that reads a task must then hide the affordance — the failure mode this guards
 *  against is the quiet one, where an empty list is rendered as "nothing to do" and the operator reads
 *  a claim about work that was never tracked. */
describe('core surfaces without the work plugin', () => {
  it('does not even ask for tasks', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['plugin-ui', 'en'], []);
    render(<Wrapper><Sidebar /></Wrapper>);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tasksCalls).toEqual([]);
  });

  it('reads the busy dot off live agent sessions instead of reporting ready', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['plugin-ui', 'en'], []);
    client.setQueryData(['sessions'], [{ name: 'elowen-7', role: 'agent' }]);
    render(<Wrapper><Sidebar /></Wrapper>);
    const dot = await screen.findByTitle('Busy');
    expect(dot).toBeInTheDocument();
  });

  it('drops the task creation commands from the palette', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['plugin-ui', 'en'], []);
    render(<Wrapper><CommandPalette /></Wrapper>);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.change(screen.getByPlaceholderText('Search commands…'), { target: { value: 'task' } });
    expect(screen.queryByText('New task')).not.toBeInTheDocument();
  });

  it('keeps the task creation command once the plugin is there', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['plugin-ui', 'en'], WORK_LISTING);
    render(<Wrapper><CommandPalette /></Wrapper>);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByPlaceholderText('Search commands…');
    fireEvent.change(input, { target: { value: 'new task' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/p/work/tasks?new=1');
  });

  it("hides today's tasks on the dashboard rather than showing an empty day", () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['plugin-ui', 'en'], []);
    render(<Wrapper><DashboardView /></Wrapper>);
    expect(screen.queryByText("Today's tasks")).not.toBeInTheDocument();
  });

  it("shows today's tasks again once the plugin is there", () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['plugin-ui', 'en'], WORK_LISTING);
    render(<Wrapper><DashboardView /></Wrapper>);
    expect(screen.getByText("Today's tasks")).toBeInTheDocument();
  });
});
