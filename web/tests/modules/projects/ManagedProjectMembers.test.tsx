import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { ManagedProjectMembers } from '../../../modules/projects/ManagedProjectMembers';

const project = { id: 7, slug: 'shared', path: '', notes: '', icon: '', executionKind: 'managed' as const };
const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'me', is_admin: false, can_share_projects: false } })),
  http.get('*/api/projects/7/users', () => HttpResponse.json([2, 3])),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
function mount() {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><ManagedProjectMembers project={project} /></ToastProvider></Wrapper>);
}

describe('managed project membership', () => {
  it('lets any member remove another member but does not offer invitations without a grant', async () => {
    let removed = false;
    server.use(http.delete('*/api/users/3/projects/7', () => { removed = true; return HttpResponse.json({ ok: true }); }));
    mount();
    expect(await screen.findByText('Account 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(/Copied credentials/)).toBeInTheDocument();
    expect(removed).toBe(false);
    fireEvent.click(dialog.getByRole('button', { name: 'Remove member' }));
    await waitFor(() => expect(removed).toBe(true));
  });

  it('requires full-project sharing confirmation and posts through the canonical membership route', async () => {
    let submitted: unknown;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'me', is_admin: false, can_share_projects: true } })),
      http.post('*/api/users/4/projects', async ({ request }) => { submitted = await request.json(); return HttpResponse.json({ ok: true }); }),
    );
    mount();
    fireEvent.change(await screen.findByLabelText('Account ID'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite member' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(/all existing project files/)).toBeInTheDocument();
    expect(submitted).toBeUndefined();
    fireEvent.click(dialog.getByRole('button', { name: 'Invite member' }));
    await waitFor(() => expect(submitted).toEqual({ projectId: 7 }));
  });

  it('refreshes membership after revocation succeeds but runtime cleanup fails', async () => {
    let revoked = false;
    server.use(
      http.get('*/api/projects/7/users', () => HttpResponse.json(revoked ? [2] : [2, 3])),
      http.delete('*/api/users/3/projects/7', () => { revoked = true; return HttpResponse.json({ error: 'membership revoked; runtime cleanup unavailable' }, { status: 503 }); }),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove member' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Remove member' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('membership revoked; runtime cleanup unavailable');
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Account 3')).toBeNull());
  });
});
