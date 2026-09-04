import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { UsersView } from '../../../modules/users/UsersView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const server = setupServer(
  http.get('*/api/users', () => HttpResponse.json([
    { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: false, allowed_execs: [] },
    { id: 2, username: 'bob', created_at: '2026-01-02', is_admin: false, allowed_execs: [] },
  ])),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('UsersView', () => {
  it('lists users from the API', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><UsersView /></ToastProvider></Wrapper>);
    // The full-width directory renders both accounts before any contextual detail is selected.
    expect((await screen.findAllByText('alice')).length).toBeGreaterThan(0);
    expect(screen.getByText('bob')).toBeTruthy();
    expect(screen.getByTestId('spatial-workspace-layout')).toBeInTheDocument();
    expect(screen.getAllByTestId('workspace-hero-metrics')).toHaveLength(1);
    expect(screen.getByTestId('users-register').closest('[data-control-surface]')).toBeInTheDocument();
    expect(screen.getByTestId('users-register').closest('.control-surface-register')).toBeInTheDocument();
    expect(screen.getByTestId('users-register')).not.toHaveClass('border-t-0');
  });

  // The directory narrows on one text query and nothing else. A page with no filter fields must not
  // carry a Filters control at all — a trigger that opens an empty panel is a dead end.
  it('puts its search in the canonical toolbar row and offers no empty Filters control', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><UsersView /></ToastProvider></Wrapper>);

    await screen.findAllByText('alice');
    expect(screen.getByPlaceholderText('Search users…').closest('.page-toolbar')).toBeInTheDocument();
    expect(screen.queryByTestId('page-filters-trigger')).toBeNull();
    expect(screen.queryByTestId('page-filter-chips')).toBeNull();
  });

  // A row opens through a real button spanning it, so Enter and Space come from the platform. The action
  // menu is a sibling of that button, never inside it, so working the menu must not open the row.
  it('opens a row from its own named button and keeps the action menu independent', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><UsersView /></ToastProvider></Wrapper>);
    const open = await screen.findByRole('button', { name: 'Open user bob' });
    expect(open.tagName).toBe('BUTTON');
    const bobRow = open.closest('[role="row"]')!;
    expect(bobRow).not.toHaveAttribute('tabindex');
    expect(bobRow).toHaveAttribute('aria-selected', 'false');

    fireEvent.keyDown(screen.getByRole('button', { name: 'bob: Actions' }), { key: 'Enter' });
    expect(bobRow).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(open);
    expect(bobRow).toHaveAttribute('aria-selected', 'true');
  });

  it('admin can select a user and restrict them to a model from the detail pane', async () => {
    let patched: { id?: string; body?: unknown } = {};
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: true, allowed_execs: [] } })),
      // The allow-list is built from the LIVE brain catalog only — legacy worker presets in the config
      // must not reappear as choices.
      http.get('*/api/brain/models', () => HttpResponse.json([
        { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'anthropic/claude-opus-5', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
      ])),
      http.get('*/api/users', () => HttpResponse.json([
        { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: true, allowed_execs: [] },
        { id: 2, username: 'bob', created_at: '2026-01-02', is_admin: false, allowed_execs: [] },
      ])),
      http.get('*/api/users/:id/projects', () => HttpResponse.json([])),
      http.get('*/api/users/:id/tools', () => HttpResponse.json([])),
      http.get('*/api/users/:id/stats', () => HttpResponse.json({ memoryCount: 0, sessionCount: 0, topModel: null })),
      http.patch('*/api/users/:id', async ({ params, request }) => { patched = { id: String(params.id), body: await request.json() }; return HttpResponse.json({ id: 2, username: 'bob', is_admin: false, allowed_execs: ['anthropic/claude-opus-5'] }); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><UsersView /></ToastProvider></Wrapper>);

    // Admin (alice) carries an Admin badge in the list. Select bob → his allowed-models summary shows
    // in the detail pane; Manage opens the selection modal.
    expect(await screen.findByText('Admin')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Open user bob' }));
    expect(await screen.findByText('All models allowed · 1 available')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage allowed models' }));
    fireEvent.click(await screen.findByRole('button', { name: 'claude-opus-5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // Saving the modal PATCHes that user's allowed_execs with the live catalog identity.
    await waitFor(() => expect(patched.id).toBe('2'));
    expect((patched.body as { allowed_execs: string[] }).allowed_execs).toEqual(['anthropic/claude-opus-5']);
  });

  it('deleting a user requires confirmation — no DELETE until the dialog is confirmed', async () => {
    let deleteHit = false;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: true, allowed_execs: [] } })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: [], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/users', () => HttpResponse.json([
        { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: true, allowed_execs: [] },
        { id: 2, username: 'bob', created_at: '2026-01-02', is_admin: false, allowed_execs: [] },
      ])),
      http.get('*/api/users/:id/projects', () => HttpResponse.json([])),
      http.get('*/api/users/:id/tools', () => HttpResponse.json([])),
      http.get('*/api/users/:id/stats', () => HttpResponse.json({ memoryCount: 0, sessionCount: 0, topModel: null })),
      http.delete('*/api/users/2', () => { deleteHit = true; return HttpResponse.json({ ok: true }); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><UsersView /></ToastProvider></Wrapper>);

    await screen.findByText('Admin');
    // Destructive actions stay visible through the row menu and still require confirmation.
    fireEvent.click(screen.getByRole('button', { name: 'bob: Actions' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete bob' }));
    // A confirmation dialog appears; nothing is deleted yet.
    expect(await screen.findByText('Delete bob?')).toBeTruthy();
    expect(deleteHit).toBe(false);
    // Confirming fires the DELETE.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteHit).toBe(true));
  });

  it('confirms role changes from both menu paths and warns before self-demotion', async () => {
    let patchHits = 0;
    let resolvePatch!: () => void;
    const patchGate = new Promise<void>((resolve) => { resolvePatch = resolve; });
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: true, allowed_execs: [] } })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: [], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/users', () => HttpResponse.json([
        { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: true, allowed_execs: [] },
        { id: 2, username: 'bob', created_at: '2026-01-02', is_admin: false, allowed_execs: [] },
      ])),
      http.patch('*/api/users/1', async () => {
        patchHits += 1;
        await patchGate;
        return HttpResponse.json({ id: 1, username: 'alice', is_admin: false, allowed_execs: [] });
      }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><UsersView /></ToastProvider></Wrapper>);

    await screen.findByText('Admin');
    fireEvent.click(screen.getByRole('button', { name: 'alice: Actions' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Remove admin' }));
    const firstConfirm = await screen.findByRole('alertdialog', { name: 'Remove administrator access from alice?' });
    expect(firstConfirm).toHaveTextContent('immediately removes your access to Users, instance settings and all administrator-only actions');
    expect(patchHits).toBe(0);
    fireEvent.click(within(firstConfirm).getByRole('button', { name: 'Cancel' }));

    const aliceRow = screen.getByRole('button', { name: 'Open user alice' }).closest('[role="row"]');
    if (!aliceRow) throw new Error('alice row not rendered');
    fireEvent.contextMenu(aliceRow);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Remove admin' }));
    expect(patchHits).toBe(0);
    const confirm = await screen.findByRole('alertdialog');
    const removeAdmin = within(confirm).getByRole('button', { name: 'Remove admin' });
    fireEvent.click(removeAdmin);
    fireEvent.click(removeAdmin);
    await waitFor(() => expect(patchHits).toBe(1));
    expect(confirm).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(confirm).toBeInTheDocument();

    resolvePatch();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(patchHits).toBe(1);
  });

  it('shows a specific create error and preserves the submitted form draft', async () => {
    server.use(http.post('*/api/users', () => HttpResponse.json({ error: 'username taken' }, { status: 409 })));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><UsersView /></ToastProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'New user' }));
    const form = await screen.findByRole('dialog', { name: 'Add user' });
    const usernameInput = within(form).getByPlaceholderText('Username');
    const passwordInput = within(form).getByPlaceholderText('Password');
    fireEvent.change(usernameInput, { target: { value: 'alice' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('That username is already taken')).toBeInTheDocument();
    expect(usernameInput).toHaveValue('alice');
    expect(passwordInput).toHaveValue('password123');
  });

  it('maps role and delete API refusals to specific messages', async () => {
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: true, allowed_execs: [] } })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: [], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/users', () => HttpResponse.json([
        { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: true, allowed_execs: [] },
        { id: 2, username: 'bob', created_at: '2026-01-02', is_admin: false, allowed_execs: [] },
      ])),
      http.patch('*/api/users/1', () => HttpResponse.json({ error: 'cannot demote the last admin' }, { status: 400 })),
      http.delete('*/api/users/2', () => HttpResponse.json({ error: 'account processes are still active' }, { status: 409 })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><UsersView /></ToastProvider></Wrapper>);

    await screen.findByText('Admin');
    fireEvent.click(screen.getByRole('button', { name: 'alice: Actions' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Remove admin' }));
    const roleConfirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(roleConfirm).getByRole('button', { name: 'Remove admin' }));
    expect(await screen.findByText('The last administrator cannot be demoted.')).toBeInTheDocument();
    expect(roleConfirm).toBeInTheDocument();
    fireEvent.click(within(roleConfirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'bob: Actions' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete bob' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('The user still has active processes. Stop them before deleting the account.')).toBeInTheDocument();
  });
});
