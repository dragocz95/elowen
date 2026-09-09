import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { ManagedProjectMembers } from '../../../modules/projects/ManagedProjectMembers';

const project = { id: 7, slug: 'shared', path: '', notes: '', icon: '', executionKind: 'managed' as const };
const member = (id: number, username: string, name: string, email: string) => ({ id, username, name, email, avatar: '' });
/** Which shape the tab asked the membership endpoint for, so a spec can prove it OPTED IN to profiles
 *  rather than quietly depending on the default answer having changed underneath it. */
let requestedViews: (string | null)[] = [];
const members = (rows: ReturnType<typeof member>[]) => http.get('*/api/projects/7/users', ({ request }) => {
  const view = new URL(request.url).searchParams.get('view');
  requestedViews.push(view);
  return HttpResponse.json(view === 'profiles' ? rows : rows.map((row) => row.id));
});
const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'me', name: 'Me', is_admin: false, can_share_projects: false } })),
  members([member(2, 'me', 'Me', 'me@example.test'), member(3, 'dana', 'Dana Nováková', 'dana@example.test')]),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); requestedViews = []; });
afterAll(() => server.close());
function mount() {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><ManagedProjectMembers project={project} /></ToastProvider></Wrapper>);
}

describe('managed project membership', () => {
  // The tab used to render a bare "Account 3" for everyone but an administrator, because the member
  // list was a list of numbers. `onUnhandledRequest: 'error'` is the other half of the guard: a member
  // must reach that identity without ever touching the admin-only account directory.
  it('shows a member who each account is, without reading the instance directory', async () => {
    mount();
    expect(await screen.findByText('Dana Nováková')).toBeInTheDocument();
    expect(screen.getByText('@dana · dana@example.test')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByLabelText('Dana Nováková')).toBeInTheDocument();
    // The identity came from the explicit opt-in, not from the endpoint's default answer.
    expect(requestedViews).toContain('profiles');
  });

  it('lets any member remove another member but does not offer invitations without a grant', async () => {
    let removed = false;
    server.use(http.delete('*/api/users/3/projects/7', () => { removed = true; return HttpResponse.json({ ok: true }); }));
    mount();
    expect(await screen.findByText('Dana Nováková')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add members' })).toBeNull();
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
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'me', name: 'Me', is_admin: false, can_share_projects: true } })),
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

  // The administrator is the only account that may read the directory, so the searchable picker is
  // theirs alone. It offers additions only: removal stays on the row that shows the person.
  it('lets an administrator add members from the searchable account picker', async () => {
    const granted: number[] = [];
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'root', name: 'Root', is_admin: true } })),
      http.get('*/api/users', () => HttpResponse.json([
        { id: 1, username: 'root', name: 'Root', email: '', avatar: '', is_admin: true },
        { id: 3, username: 'dana', name: 'Dana Nováková', email: 'dana@example.test', avatar: '', is_admin: false },
        { id: 4, username: 'petr', name: 'Petr Malý', email: 'petr@example.test', avatar: '', is_admin: false },
      ])),
      http.post('*/api/users/4/projects', () => { granted.push(4); return HttpResponse.json({ ok: true }); }),
    );
    mount();
    const open = await screen.findByRole('button', { name: 'Add members' });
    // Disabled until the directory has actually arrived: there is nothing to pick from before that.
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const dialog = within(await screen.findByRole('dialog'));
    // Already a member, and an administrator whose access needs no row: neither is a candidate.
    expect(dialog.queryByText('Dana Nováková')).toBeNull();
    expect(dialog.queryByText('Root')).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: /Petr Malý/ }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(granted).toEqual([4]));
  });

  it('refreshes membership after revocation succeeds but runtime cleanup fails', async () => {
    let revoked = false;
    server.use(
      http.get('*/api/projects/7/users', ({ request }) => {
        const rows = revoked
          ? [member(2, 'me', 'Me', 'me@example.test')]
          : [member(2, 'me', 'Me', 'me@example.test'), member(3, 'dana', 'Dana Nováková', 'dana@example.test')];
        return HttpResponse.json(new URL(request.url).searchParams.get('view') === 'profiles' ? rows : rows.map((row) => row.id));
      }),
      http.delete('*/api/users/3/projects/7', () => { revoked = true; return HttpResponse.json({ error: 'membership revoked; runtime cleanup unavailable' }, { status: 503 }); }),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove member' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Remove member' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('membership revoked; runtime cleanup unavailable');
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Dana Nováková')).toBeNull());
  });
});
