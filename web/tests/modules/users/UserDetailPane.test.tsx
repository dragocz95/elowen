import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { UserDetailPane } from '../../../modules/users/UserDetailPane';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Project, User } from '../../../lib/types';

const server = setupServer(
  http.get('*/api/users/:id/stats', () => HttpResponse.json({ memoryCount: 0, sessionCount: 0, topModel: null })),
  http.get('*/api/users/:id/tools', () => HttpResponse.json([])),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const user = (over: Partial<User> = {}): User => ({
  id: 2, username: 'bob', name: '', email: '', avatar: '', created_at: '2026-01-02', is_admin: false,
  allowed_execs: [], disabled_tools: [], default_exec: '', advisor_exec: '', advisor_autostart: false, ...over,
});

const project = (id: number, slug: string): Project => ({ id, slug, path: `/p/${slug}`, notes: '', icon: '', pr_enabled: null });

function mount(u: User, projects: Project[] = [], globalExecs: string[] = []) {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper>
      <ToastProvider>
        <UserDetailPane user={u} projects={projects} globalExecs={globalExecs} customModels={[]} />
      </ToastProvider>
    </Wrapper>,
  );
}

describe('UserDetailPane', () => {
  it('summarizes an unrestricted user as "all models allowed"', async () => {
    server.use(http.get('*/api/users/2/projects', () => HttpResponse.json([])));
    mount(user(), [], ['sonnet', 'codex:gpt-5.4']);
    expect(await screen.findByText('All models allowed · 2 available')).toBeTruthy();
    // Samples list the available models when nothing is restricted.
    expect(screen.getByText('Claude Sonnet 4.5')).toBeTruthy();
  });

  it('summarizes a restricted user with model and provider counts', async () => {
    server.use(http.get('*/api/users/2/projects', () => HttpResponse.json([])));
    mount(user({ allowed_execs: ['sonnet', 'opus'] }), [], ['sonnet', 'opus', 'codex:gpt-5.4']);
    expect(await screen.findByText('2 models · 1 providers')).toBeTruthy();
  });

  it('saving the models modal PATCHes allowed_execs', async () => {
    let patched: { id?: string; body?: unknown } = {};
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.patch('*/api/users/:id', async ({ params, request }) => {
        patched = { id: String(params.id), body: await request.json() };
        return HttpResponse.json({ id: 2 });
      }),
    );
    mount(user(), [], ['sonnet', 'codex:gpt-5.4']);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    // Models group by provider inside the modal.
    expect(await screen.findByRole('heading', { name: 'Claude Code' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Codex' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Claude Sonnet 4\.5/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patched.id).toBe('2'));
    expect((patched.body as { allowed_execs: string[] }).allowed_execs).toEqual(['sonnet']);
  });

  it('summarizes project assignments and saves the diff as individual assign/unassign calls', async () => {
    const assignedTo: number[] = [];
    const unassigned: number[] = [];
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([1])),
      http.post('*/api/users/2/projects', async ({ request }) => {
        assignedTo.push((await request.json() as { projectId: number }).projectId);
        return HttpResponse.json({ ok: true });
      }),
      http.delete('*/api/users/2/projects/:pid', ({ params }) => {
        unassigned.push(Number(params.pid));
        return HttpResponse.json({ ok: true });
      }),
    );
    mount(user(), [project(1, 'alpha'), project(2, 'beta')]);
    expect(await screen.findByText('1 of 2 projects assigned')).toBeTruthy();
    // With no execs (models block renders "—") the projects summary owns the only Manage button.
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    // Single group → no filter chips row.
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /beta/ })); // assign beta
    fireEvent.click(screen.getByRole('button', { name: /alpha/ })); // unassign alpha
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(assignedTo).toEqual([2]));
    await waitFor(() => expect(unassigned).toEqual([1]));
  });
});
