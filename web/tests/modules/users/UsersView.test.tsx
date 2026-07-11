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
  });

  it('selects rows with Space and keeps the always-visible action menu independent', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><UsersView /></ToastProvider></Wrapper>);
    const bobRow = (await screen.findByText('bob')).closest('[role="row"]')!;
    expect(bobRow).toHaveAttribute('aria-selected', 'false');

    fireEvent.keyDown(screen.getByRole('button', { name: 'bob: Actions' }), { key: 'Enter' });
    expect(bobRow).toHaveAttribute('aria-selected', 'false');

    fireEvent.keyDown(bobRow, { key: ' ' });
    expect(bobRow).toHaveAttribute('aria-selected', 'true');
  });

  it('admin can select a user and restrict them to a model from the detail pane', async () => {
    let patched: { id?: string; body?: unknown } = {};
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: true, allowed_execs: [] } })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'codex:gpt-5.4'], customModels: [], hiddenPresets: [], autopilot: {}, providers: {}, defaults: {} })),
      http.get('*/api/users', () => HttpResponse.json([
        { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: true, allowed_execs: [] },
        { id: 2, username: 'bob', created_at: '2026-01-02', is_admin: false, allowed_execs: [] },
      ])),
      http.get('*/api/users/:id/projects', () => HttpResponse.json([])),
      http.get('*/api/users/:id/tools', () => HttpResponse.json([])),
      http.get('*/api/users/:id/stats', () => HttpResponse.json({ memoryCount: 0, sessionCount: 0, topModel: null })),
      http.patch('*/api/users/:id', async ({ params, request }) => { patched = { id: String(params.id), body: await request.json() }; return HttpResponse.json({ id: 2, username: 'bob', is_admin: false, allowed_execs: ['sonnet'] }); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><UsersView /></ToastProvider></Wrapper>);

    // Admin (alice) carries an Admin badge in the list. Select bob → his allowed-models summary shows
    // in the detail pane; Manage opens the selection modal.
    expect(await screen.findByText('Admin')).toBeTruthy();
    fireEvent.click((await screen.findByText('bob')).closest('[role="row"]')!);
    expect(await screen.findByText('All models allowed · 2 available')).toBeTruthy();
    // Projects list is empty ("—") and bob has no tools, so the models summary owns the only Manage button.
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    fireEvent.click(await screen.findByRole('button', { name: /Claude Sonnet/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // Saving the modal PATCHes that user's allowed_execs.
    await waitFor(() => expect(patched.id).toBe('2'));
    expect((patched.body as { allowed_execs: string[] }).allowed_execs).toEqual(['sonnet']);
  });

  it('deleting a user requires confirmation — no DELETE until the dialog is confirmed', async () => {
    let deleteHit = false;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'alice', created_at: '2026-01-01', is_admin: true, allowed_execs: [] } })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: [], customModels: [], hiddenPresets: [], autopilot: {}, providers: {}, defaults: {} })),
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
});
