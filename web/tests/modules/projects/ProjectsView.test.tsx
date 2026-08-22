import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ProjectsView } from '../../../modules/projects/ProjectsView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json([{ id: 1, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '', pr_enabled: null }])),
  http.get('*/api/projects/1/git', () => HttpResponse.json({ isRepo: true, status: { branch: 'master', ahead: 0, behind: 0, dirty: 3, clean: false }, branches: [{ name: 'master', current: true }], commits: [{ hash: 'deadbee', subject: 'feat: x', author: 'me', relative: '2 hours ago' }] })),
  http.get('*/api/projects/1/files', () => HttpResponse.json([])),
  http.get('*/api/projects/1/commit/deadbee', () => HttpResponse.json({ diff: '', files: [] })),
  http.get('*/api/projects/1/changed', () => HttpResponse.json({ changed: [] })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([])),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
);
beforeAll(() => server.listen()); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('ProjectsView', () => {
  it('lists projects and shows git on select', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    const row = await screen.findByText('elowen');
    fireEvent.click(row);
    expect(await screen.findByText('master')).toBeTruthy();
    expect(await screen.findByText('feat: x')).toBeTruthy();
    expect(screen.getByTestId('projects-register')).toHaveAttribute('role', 'table');
    expect(screen.getByTestId('projects-register').closest('.control-surface-register')).toBeInTheDocument();
    expect(screen.getByTestId('projects-register')).not.toHaveClass('border-t-0');
    expect(row.closest('[role="row"]')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('dialog', { name: 'Project detail' })).toBeInTheDocument();
  });

  it('selects a project with Space', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    const card = (await screen.findByText('elowen')).closest('[role="row"]')!;
    fireEvent.keyDown(card, { key: ' ' });
    expect(await screen.findByText('master')).toBeTruthy();
  });

  it('withholds editor controls when the editor plugin is unavailable', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    fireEvent.click(await screen.findByText('elowen'));
    expect(await screen.findByText('master')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open editor' })).toBeNull();
  });

  // The row's hover menu and the right-click menu are two renderings of ONE action list. They used to be two
  // hand-maintained copies, so an action added to one silently went missing from the other.
  it('offers the same project actions in the row menu and the right-click menu', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    const row = (await screen.findByText('elowen')).closest('[role="row"]');
    if (!row) throw new Error('project row not rendered');

    fireEvent.click(screen.getByRole('button', { name: 'elowen: Actions' }));
    const hoverActions = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));

    fireEvent.contextMenu(row);
    const contextActions = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);

    expect(hoverActions).toEqual(['Edit project', 'Copy path', 'Remove project']);
    expect(contextActions).toEqual(hoverActions);
  });

  // Registering, editing and removing a project are admin-only on the daemon. A member used to be shown
  // all three, so every one of them could only answer 403 -- and a project is precisely the path boundary
  // a non-admin is confined to, so it must be an admin who hands one out.
  it('withholds project registration and editing from a member', async () => {
    server.use(http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 4, username: 'member', is_admin: false } })));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    const row = (await screen.findByText('elowen')).closest('[role="row"]');
    if (!row) throw new Error('project row not rendered');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New project' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'elowen: Actions' }));
    const actions = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(actions).toEqual(['Copy path']);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));
    fireEvent.click(screen.getByText('elowen'));
    expect(await screen.findByText('master')).toBeInTheDocument();
    expect(screen.queryByText('Edit project')).toBeNull();
  });

  it('filters the project register without losing the workspace layout', async () => {
    server.use(http.get('*/api/projects', () => HttpResponse.json([
      { id: 1, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '', pr_enabled: null },
      { id: 2, slug: 'website', path: '/var/www/site', notes: 'public', icon: '', pr_enabled: true },
    ])));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    await screen.findByText('website');
    fireEvent.change(screen.getByPlaceholderText('Search projects, paths or notes…'), { target: { value: 'elowen' } });
    await waitFor(() => expect(screen.queryByText('website')).not.toBeInTheDocument());
    expect(screen.getByText('elowen')).toBeInTheDocument();
    expect(screen.getByTestId('spatial-workspace-layout')).toBeInTheDocument();
    expect(screen.getAllByTestId('workspace-hero-mascot')).toHaveLength(1);
    expect(screen.getByTestId('projects-register').closest('[data-control-surface]')).toBeInTheDocument();
  });
});
