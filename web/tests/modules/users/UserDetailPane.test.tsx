import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';

const { loadPluginUi } = vi.hoisted(() => ({ loadPluginUi: vi.fn() }));
vi.mock('../../../lib/pluginUi', async (loadOriginal) => ({
  ...(await loadOriginal<typeof import('../../../lib/pluginUi')>()),
  loadPluginUi,
}));

import { UserDetailPane } from '../../../modules/users/UserDetailPane';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Project, User } from '../../../lib/types';

const server = setupServer(
  http.get('*/api/users/:id/stats', () => HttpResponse.json({ memoryCount: 0, sessionCount: 0, topModel: null })),
  http.get('*/api/users/:id/tools', () => HttpResponse.json([])),
  http.get('*/api/plugins', () => HttpResponse.json([])),
  http.get('*/api/plugins/ui', () => HttpResponse.json([])),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
beforeEach(() => { loadPluginUi.mockReset(); });
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const user = (over: Partial<User> = {}): User => ({
  id: 2, username: 'bob', name: '', email: '', avatar: '', created_at: '2026-01-02', is_admin: false,
  allowed_execs: [], disabled_tools: [], allowed_tools: [], granted_plugins: [], default_exec: '', advisor_exec: '', advisor_autostart: false, ...over,
});

const project = (id: number, slug: string): Project => ({ id, slug, path: `/p/${slug}`, notes: '', icon: '' });

function StatefulUserPanel({ user: selected }: { user: User }) {
  const [mountedFor] = useState(selected.id);
  return <div>Environment for {selected.username} mounted #{mountedFor}</div>;
}

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

  // The admin allow-list shows brain models by the name the catalog gives them — the exec is the row's
  // identity, not its label, so two providers offering the same model stay two grantable entries.
  it('labels brain execs from the catalog and keeps same-named models from two providers apart', async () => {
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([
        { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'elowen:anthropic/claude-opus-5', legacyExec: 'elowen:anthropic/claude-opus-5', program: 'elowen', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
        { provider: 'relay', providerLabel: 'Relay', model: 'claude-opus-5', exec: 'elowen:relay/claude-opus-5', legacyExec: 'elowen:relay/claude-opus-5', program: 'elowen', source: 'relay', contextWindow: 200000, contextWindowSet: false },
      ])),
    );
    mount(user(), [], ['elowen:anthropic/claude-opus-5', 'elowen:relay/claude-opus-5']);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    const rows = await screen.findAllByRole('button', { name: /claude-opus-5/ });
    expect(rows).toHaveLength(2);
    // The clean model name is shown; the raw spec is not what the admin reads.
    expect(rows.every((r) => r.textContent?.includes('elowen:'))).toBe(false);
  });

  // The reported bug: deleting the `alibaba` provider left its models behind in the global `allowedExecs`
  // list, and this pane built its rows straight from that list — so `alibaba/…` stayed listed and stayed
  // selectable long after the provider was gone. A brain row must come from the LIVE catalog, which is
  // built from the configured providers and therefore cannot contain a dead one. CLI worker execs
  // (`sonnet`, `codex:…`) keep coming from the global list, which is where they legitimately live.
  it('drops brain models whose provider is gone, and keeps CLI worker execs', async () => {
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([
        { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'anthropic/claude-opus-5', legacyExec: 'elowen:anthropic/claude-opus-5', program: 'elowen', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
      ])),
    );
    // `alibaba/qwen3.8-max` is exactly the shape the operator's config is in: still in allowedExecs,
    // no longer backed by any provider, so absent from /brain/models.
    mount(user(), [], ['sonnet', 'anthropic/claude-opus-5', 'alibaba/qwen3.8-max']);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(await screen.findByRole('button', { name: /claude-opus-5/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Claude Sonnet 4\.5/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /qwen3\.8-max/ })).toBeNull();
  });

  // Reducing the offered set must never reduce what the admin can SEE they granted. A user still carrying
  // a dead model has to keep reading as restricted, or the pane would claim "all models allowed" — the one
  // reading that would make a permission list look wider than it is.
  it('does not read a user restricted to a dead model as unrestricted', async () => {
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
    );
    mount(user({ allowed_execs: ['alibaba/qwen3.8-max'] }), [], ['sonnet', 'alibaba/qwen3.8-max']);
    expect(await screen.findByText(/1 models/)).toBeTruthy();
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

  it('mounts a generic plugin panel with the selected User DTO', async () => {
    server.use(
      http.get('*/api/users/:id/projects', () => HttpResponse.json([])),
      http.get('*/api/plugins/ui', () => HttpResponse.json([{
        name: 'sandbox', url: '/plugins/sandbox/web/hash.js', apiVersion: 5, nav: [], account: [],
        user: [{ id: 'environment', label: 'Development environment', icon: 'Box' }], project: [], settings: [], strings: {},
      }])),
    );
    loadPluginUi.mockResolvedValue({
      requiresApiVersion: 5,
      user: { environment: StatefulUserPanel },
    });

    const { wrapper: Wrapper } = createWrapper();
    const view = render(<Wrapper><ToastProvider><UserDetailPane user={user({ name: 'Bob' })} projects={[]} globalExecs={[]} customModels={[]} /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Development environment')).toBeInTheDocument();
    expect(await screen.findByText('Environment for bob mounted #2')).toBeInTheDocument();
    expect(loadPluginUi).toHaveBeenCalledWith('sandbox', '/plugins/sandbox/web/hash.js', undefined);

    view.rerender(<Wrapper><ToastProvider><UserDetailPane user={user({ id: 3, username: 'amy', name: 'Amy' })} projects={[]} globalExecs={[]} customModels={[]} /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Environment for amy mounted #3')).toBeInTheDocument();
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

describe('UserDetailPane — editing name and username', () => {
  it('sends both fields and shows the new identity', async () => {
    server.use(http.get('*/api/users/2/projects', () => HttpResponse.json([])));
    let sent: unknown = null;
    server.use(http.patch('*/api/users/2', async ({ request }) => {
      sent = await request.json();
      return HttpResponse.json({ ...user(), name: 'Bob Novák', username: 'bob.novak' });
    }));
    mount(user());

    fireEvent.click(await screen.findByRole('button', { name: 'Edit name' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '  Bob Novák  ' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob.novak' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Whitespace is trimmed before it becomes a login credential.
    await waitFor(() => expect(sent).toEqual({ name: 'Bob Novák', username: 'bob.novak' }));
    await screen.findByText('Name saved');
  });

  it('names a taken username instead of the generic save error', async () => {
    server.use(http.get('*/api/users/2/projects', () => HttpResponse.json([])));
    server.use(http.patch('*/api/users/2', () => HttpResponse.json({ error: 'username taken' }, { status: 409 })));
    mount(user());

    fireEvent.click(await screen.findByRole('button', { name: 'Edit name' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('That username is already taken')).toBeTruthy();
    // The form stays open on a refusal so the admin can correct the name instead of retyping it.
    expect(screen.getByLabelText('Username')).toBeTruthy();
  });

  it('will not submit an empty login name', async () => {
    server.use(http.get('*/api/users/2/projects', () => HttpResponse.json([])));
    let called = false;
    server.use(http.patch('*/api/users/2', () => { called = true; return HttpResponse.json(user()); }));
    mount(user());

    fireEvent.click(await screen.findByRole('button', { name: 'Edit name' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(called).toBe(false));
  });
});
