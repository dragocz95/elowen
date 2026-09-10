import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { ProjectAccessPanel } from '../../../modules/projects/ProjectAccessPanel';

const project = { id: 7, slug: 'shared', path: '', notes: '', icon: '', executionKind: 'managed' as const };
const hostProject = { ...project, path: '/srv/shared', executionKind: 'host' as const };
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
function mount(target: typeof project | typeof hostProject = project) {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><ProjectAccessPanel project={target} /></ToastProvider></Wrapper>);
}

describe('project membership', () => {
  // This tab used to be a bespoke roster: a heading, a paragraph, one row per person and a Remove button
  // on each. A host project shows a one-line access summary with a Manage button, and a managed project
  // is the same kind of record, so it now shows the same thing built from the same components.
  it('presents access exactly as a host project does, with one summary and one Manage button', async () => {
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'root', name: 'Root', is_admin: true } })),
      http.get('*/api/users', () => HttpResponse.json([
        { id: 3, username: 'dana', name: 'Dana Nováková', email: 'dana@example.test', avatar: '', is_admin: false },
        { id: 4, username: 'petr', name: 'Petr Malý', email: 'petr@example.test', avatar: '', is_admin: false },
      ])),
    );
    mount();
    // The host count line: members out of the directory the reader can actually see.
    expect(await screen.findByText('1 of 2 users have access')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument();
    // No roster underneath it, and no second removal control competing with the picker.
    expect(screen.queryByRole('button', { name: 'Remove member' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave project' })).toBeNull();
    // The people are still named, as avatar chips in the summary.
    expect(screen.getByLabelText('Dana Nováková')).toBeInTheDocument();
    expect(requestedViews).toContain('profiles');
  });

  // A member without the directory grant must still learn who shares the environment, and the count has
  // to stay truthful: there is no total to compare against when the directory is not readable.
  it('counts only what a member can see and never requests the instance directory', async () => {
    mount();
    expect(await screen.findByText('2 users have access')).toBeInTheDocument();
    expect(screen.queryByText(/of 2 users/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Dana Nováková')).toBeInTheDocument();
    expect(dialog.getByText('dana@example.test')).toBeInTheDocument();
  });

  it('states the sharing consequence in the picker and removes through the canonical route', async () => {
    let removed = false;
    server.use(http.delete('*/api/users/3/projects/7', () => { removed = true; return HttpResponse.json({ ok: true }); }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/all existing project files/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: /Dana Nováková/ }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(removed).toBe(true));
  });

  it('requires full-project sharing confirmation for an invitation by account id', async () => {
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

  it('offers no invitation at all without the sharing grant', async () => {
    mount();
    expect(await screen.findByRole('button', { name: 'Manage' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Account ID')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
  });

  // The administrator adds through the directory picker, and an account that already reaches every
  // project without an assignment row is not offered as a grant that would change nothing.
  it('lets an administrator grant access from the shared account picker', async () => {
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
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.queryByText('Root')).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: /Petr Malý/ }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(granted).toEqual([4]));
  });

  // One People tab serves both kinds of project. What a HOST project does not carry is the environment's
  // sharing consequence and the invite-by-id path, because there is no environment to hand over and its
  // reader is an administrator with the directory in front of them.
  it('states a host project in its own terms, with no environment warning and no invite by id', async () => {
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'root', name: 'Root', is_admin: true } })),
      http.get('*/api/users', () => HttpResponse.json([
        { id: 3, username: 'dana', name: 'Dana Nováková', email: 'dana@example.test', avatar: '', is_admin: false },
      ])),
    );
    mount(hostProject);
    expect(await screen.findByText('1 of 1 users have access')).toBeInTheDocument();
    expect(screen.queryByLabelText('Account ID')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.queryByText(/all existing project files/)).toBeNull();
    expect(dialog.getByText(/may use this Project/)).toBeInTheDocument();
  });

  it('refreshes membership after a failed save whose response never arrived', async () => {
    let revoked = false;
    server.use(
      http.get('*/api/projects/7/users', ({ request }) => {
        const rows = revoked
          ? [member(2, 'me', 'Me', 'me@example.test')]
          : [member(2, 'me', 'Me', 'me@example.test'), member(3, 'dana', 'Dana Nováková', 'dana@example.test')];
        return HttpResponse.json(new URL(request.url).searchParams.get('view') === 'profiles' ? rows : rows.map((row) => row.id));
      }),
      // A transport failure, not an HTTP refusal: the daemon may well have applied the revocation before
      // the response was lost, which is why the summary has to ask again instead of trusting the error.
      http.delete('*/api/users/3/projects/7', () => { revoked = true; return HttpResponse.error(); }),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: /Dana Nováková/ }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    // The shared picker reports a failed save in its own words and stays open, exactly as it does for a
    // host project. What matters here is that the summary behind it tells the truth afterwards: the
    // revocation DID land on the daemon even though the caller never heard about it.
    expect(await dialog.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByText('1 user has access')).toBeInTheDocument());
  });
});
