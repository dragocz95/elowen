import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ProjectsView } from '../../../modules/projects/ProjectsView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json([{ id: 1, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '' }])),
  http.get('*/api/projects/summary', () => HttpResponse.json([{
    projectId: 1,
    members: { total: 1, samples: [{ id: 2, username: 'bob', name: 'Bob', avatar: '' }] },
    indicators: [{ plugin: 'demo', label: 'Connected', value: 'main', icon: 'GitBranch', tone: 'success' }],
  }])),
  http.get('*/api/projects/1/git', () => HttpResponse.json({ isRepo: true, status: { branch: 'master', ahead: 0, behind: 0, dirty: 3, clean: false }, branches: [{ name: 'master', current: true }], commits: [{ hash: 'deadbee', subject: 'feat: x', author: 'me', relative: '2 hours ago' }] })),
  http.get('*/api/projects/3/git', () => HttpResponse.json({ error: 'managed project Git inspection requires the environment provider' }, { status: 503 })),
  http.get('*/api/projects/1/files', () => HttpResponse.json([])),
  http.get('*/api/projects/1/commit/deadbee', () => HttpResponse.json({ diff: '', files: [] })),
  http.get('*/api/projects/1/changed', () => HttpResponse.json({ changed: [] })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([])),
  http.get('*/api/users', () => HttpResponse.json([
    { id: 1, username: 'admin', name: 'Admin', is_admin: true, created_at: '', allowed_execs: [], disabled_tools: [], allowed_tools: [], granted_plugins: [], email: '', avatar: '', default_exec: '', advisor_exec: '', advisor_autostart: false },
    { id: 2, username: 'bob', name: 'Bob', is_admin: false, created_at: '', allowed_execs: [], disabled_tools: [], allowed_tools: [], granted_plugins: [], email: '', avatar: '', default_exec: '', advisor_exec: '', advisor_autostart: false },
  ])),
  // The membership endpoint answers ids by default and identities on `?view=profiles`, which is what the
  // People tab opts into; the shared-memory panel still reads the id list.
  http.get('*/api/projects/1/users', ({ request }) => HttpResponse.json(
    new URL(request.url).searchParams.get('view') === 'profiles'
      ? [{ id: 2, username: 'bob', name: 'Bob', email: '', avatar: '' }]
      : [2],
  )),
  http.get('*/api/projects/1/memory-members', () => HttpResponse.json([])),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
);
beforeAll(() => server.listen()); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('ProjectsView', () => {
  it('opens the server-owned default project without requesting container provisioning', async () => {
    let opened = false;
    let environmentRequested = false;
    const project = { id: 3, slug: 'private-default', path: '', notes: '', icon: '', executionKind: 'managed' };
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 4, is_admin: false } })),
      http.get('*/api/projects', () => HttpResponse.json(opened ? [project] : [])),
      http.post('*/api/projects/default', () => { opened = true; return HttpResponse.json(project); }),
      http.post('*/api/plugins/sandbox/api/projects/3/environment', () => { environmentRequested = true; return HttpResponse.json({}); }),
      // Reading the repository is not provisioning: the daemon answers a non-running environment from
      // its own records. Only an explicit lifecycle request may start a container.
      http.get('*/api/projects/3/git', () => HttpResponse.json({ isRepo: false, status: null, remotes: [], branches: [], commits: [] })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    const open = await screen.findByRole('button', { name: 'Open default project' });
    await waitFor(() => expect(open).toBeEnabled());
    expect(opened).toBe(false);
    fireEvent.click(open);
    expect(await screen.findByRole('dialog', { name: 'private-default' })).toBeInTheDocument();
    expect(opened).toBe(true);
    expect(environmentRequested).toBe(false);
  });

  it('lets a granted member create a private managed project without a host path', async () => {
    let body: unknown;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 4, is_admin: false, can_create_projects: true } })),
      http.post('*/api/projects', async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: 3, slug: 'analysis', path: '', notes: '', executionKind: 'managed' }); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = within(screen.getByRole('dialog', { name: 'New project' }));
    expect(dialog.queryByRole('button', { name: 'Browse' })).toBeNull();
    expect(dialog.getByText(/private until/)).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText(/Slug/), { target: { value: 'analysis' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(body).toEqual({ slug: 'analysis', notes: '', executionKind: 'managed' }));
  });

  // Creating a managed project starts its environment, so the same progress window every other lifecycle
  // action uses opens on the operation the creation answered with.
  it('follows the environment start that creating a managed project implies', async () => {
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 4, is_admin: false, can_create_projects: true } })),
      http.post('*/api/projects', () => HttpResponse.json({ id: 3, slug: 'analysis', path: '', notes: '', executionKind: 'managed', environmentOperationId: 'env_op_9' })),
      http.get('*/api/plugins/sandbox/api/environments/operation', () => HttpResponse.json({
        id: 'env_op_9', requestId: 'project-create:3', projectId: 3, accountUserId: 4, generation: 1,
        action: { kind: 'start' }, status: 'running', error: null,
        steps: ['image', 'storage', 'container', 'boot', 'ready', 'initialize'], stepIndex: 3, stepTotal: 6,
        stepLabel: 'boot', percent: 65, logTail: [],
      })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = within(screen.getByRole('dialog', { name: 'New project' }));
    fireEvent.change(dialog.getByLabelText(/Slug/), { target: { value: 'analysis' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Starting the container')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '65');
    expect(screen.getByText('Step 4 of 6')).toBeInTheDocument();
  });

  it('offers equal managed-project editing rights without host path controls', async () => {
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 4, is_admin: false } })),
      http.get('*/api/projects', () => HttpResponse.json([{ id: 3, slug: 'analysis', path: '', notes: '', executionKind: 'managed' }])),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open project analysis' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit project' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Edit project' }));
    expect(dialog.queryByRole('button', { name: 'Browse' })).toBeNull();
    expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
  // Opening a managed project used to render an "Inspect repository" button and read nothing until it
  // was pressed, because the read could provision a cold environment and block on it. The daemon answers
  // a non-running environment from its own records now, so the tab simply asks.
  it('reads a managed project repository on open, with no inspect step to press first', async () => {
    let asked = 0;
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([{ id: 3, slug: 'analysis', path: '', notes: 'Research notes', icon: '', executionKind: 'managed' }])),
      http.get('*/api/projects/3/git', () => {
        asked += 1;
        return HttpResponse.json({ isRepo: true, status: { branch: 'main', head: 'abc', upstream: null, ahead: 0, behind: 0, dirty: 0, untracked: 0, clean: true }, remotes: [], branches: [{ name: 'main', current: true }], commits: [] });
      }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open project analysis' }));

    expect(screen.queryByRole('button', { name: /Inspect repository/i })).toBeNull();
    // What the register already holds is on screen straight away; only the repository is still coming.
    expect(await screen.findByText('Research notes')).toBeInTheDocument();
    expect(await screen.findByText('main')).toBeInTheDocument();
    expect(asked).toBe(1);
  });

  // A project without a repository is an ordinary project, not an invitation to create one.
  it('states plainly that a managed project holds no repository', async () => {
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([{ id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed' }])),
      http.get('*/api/projects/3/git', () => HttpResponse.json({ isRepo: false, status: null, remotes: [], branches: [], commits: [] })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open project analysis' }));
    expect(await screen.findByText('Not a git repository')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Inspect repository|Create repository/i })).toBeNull();
  });

  // A stopped environment is the ordinary state of a project nobody is working in. Saying so is the
  // whole answer; starting a container because a tab opened is not.
  it('says the environment is not running instead of starting one', async () => {
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([{ id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed' }])),
      http.get('*/api/projects/3/git', () => HttpResponse.json({ error: 'project environment is not running' }, { status: 409 })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open project analysis' }));
    const notice = (await screen.findAllByRole('alert')).find((element) => /environment is running/i.test(element.textContent ?? ''));
    expect(notice, 'the repository section reports the stopped environment').toBeTruthy();
    expect(within(notice!).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // ONE answer. A second, generic failure block used to render under the same condition, so the tab
    // said "nothing is wrong here" and "failed to load" at the same time, in two different tones.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    expect(screen.queryByText(/Failed to load git info/i)).toBeNull();
  });

  // Any other repository failure keeps the same single surface; only the wording differs, because the
  // API's own message is more useful than a generic one.
  it('reports a non-409 repository failure once, in the words the API used', async () => {
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([{ id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed' }])),
      http.get('*/api/projects/3/git', () => HttpResponse.json({ error: 'environment provider unavailable' }, { status: 503 })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open project analysis' }));

    expect(await screen.findByText(/environment provider unavailable/i)).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  // Removal used to be excluded from a managed project's action menu and offered instead as a red button
  // inside the environment panel, so the same decision lived in two places depending on where the project
  // ran. It is one menu item now, it still tells a managed project the truth about its environment, and
  // it still travels the durable teardown the daemon owns.
  it('removes a managed project from the same action menu every project has', async () => {
    let deleted = false;
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([{ id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed' }])),
      http.delete('*/api/projects/3', () => {
        deleted = true;
        return HttpResponse.json({ operation: { id: 'op-delete', requestId: 'r', projectId: 3, generation: 1, accountUserId: 1, action: { kind: 'delete' }, status: 'pending', error: null, steps: ['stop', 'containers', 'images', 'volumes', 'storage', 'records'], stepIndex: 0, stepTotal: 6, stepLabel: 'stop', percent: 0 } }, { status: 202 });
      }),
      http.get('*/api/plugins/sandbox/api/environments/operation', () => HttpResponse.json({ id: 'op-delete', requestId: 'r', projectId: 3, generation: 1, accountUserId: 1, action: { kind: 'delete' }, status: 'running', error: null, steps: ['stop', 'containers', 'images', 'volumes', 'storage', 'records'], stepIndex: 1, stepTotal: 6, stepLabel: 'containers', percent: 18, logTail: [] })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'analysis: Actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove project' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    // The managed wording, not the host one: this takes the environment down with the project.
    expect(dialog.getByText(/environment/i)).toBeInTheDocument();
    expect(deleted).toBe(false);
    fireEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deleted).toBe(true));
    // Teardown is a durable operation, so the answer is the progress window that follows it rather than
    // a toast saying it was requested and then never saying anything again.
    expect(await screen.findByTestId('operation-progress-dialog')).toBeInTheDocument();
    expect(await screen.findByText('Removing containers')).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 6')).toBeInTheDocument();
  });

  // A managed project has no host path, which is why the menu used to go one item short of a host
  // project's. It does have the guest root everything inside the environment works from, and that is
  // what the same action now copies -- never a host backing path, which nothing outside the daemon sees.
  it('copies the guest root for a managed project from the same action a host project uses', async () => {
    const copied: string[] = [];
    Object.assign(navigator, { clipboard: { writeText: async (text: string) => { copied.push(text); } } });
    server.use(http.get('*/api/projects', () => HttpResponse.json([
      // A managed project has no host path; the daemon serves the directory it is mounted at instead,
      // which is the project's own name rather than a shared anonymous root.
      { id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed', guestRoot: '/analysis' },
      { id: 4, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '' },
    ])));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'analysis: Actions' }));
    const managedActions = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy path' }));
    await waitFor(() => expect(copied).toEqual(['/analysis']));

    fireEvent.click(await screen.findByRole('button', { name: 'elowen: Actions' }));
    const hostActions = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy path' }));
    await waitFor(() => expect(copied).toEqual(['/analysis', '/var/www/elowen']));
    // The same menu, item for item, in the same order.
    expect(managedActions).toEqual(hostActions);
  });

  // Choosing an icon from the project's own files was refused for a managed project outright, although
  // the daemon already resolved and validated an icon path inside the environment and the editor already
  // served that project's files from the guest. Only this button stood in the way.
  it('offers a managed project the icon picker a host project has', async () => {
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([
        { id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed' },
      ])),
      // The picker reads and renders through the editor's project file routes, so it is offered only
      // where that plugin is installed -- for a managed project exactly as for a host one.
      http.get('*/api/plugins/ui', () => HttpResponse.json([{ name: 'editor', url: '/plugins/editor/web/hash.js', apiVersion: 3, nav: [], account: [], settings: [] }])),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'analysis: Actions' }));
    // The editor plugin is what serves and reads the files, and the menu names it once the listing that
    // gates every one of its affordances has arrived.
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open editor' })).toBeInTheDocument());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit project' }));
    // Editing opens the detail rail over the modal, and the rail is the topmost dialog, so the modal's
    // own controls are reached inside it rather than from the document.
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit project', hidden: true }));
    expect(await dialog.findByText('Choose icon')).toBeEnabled();
    // And no host path field appears alongside it: the icon comes from the environment, not a host tree.
    expect(dialog.queryByLabelText(/path/i)).toBeNull();
  });

  it('lists projects and shows git on select', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    const row = await screen.findByText('elowen');
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Pilot info' })).toBeNull();
    expect(screen.getByLabelText('1 assigned users')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open project elowen' }));
    expect(await screen.findByText('master')).toBeTruthy();
    expect(await screen.findByText('feat: x')).toBeTruthy();
    expect(screen.getByTestId('projects-register')).toHaveAttribute('role', 'table');
    expect(screen.getByTestId('projects-register').closest('.control-surface-register')).toBeInTheDocument();
    expect(screen.getByTestId('projects-register')).not.toHaveClass('border-t-0');
    expect(row.closest('[role="row"]')).toHaveAttribute('aria-selected', 'true');
    // The rail names the record and states its path in the ONE header it already draws. It used to be
    // titled "Project detail" and then repeat the slug and path in a header band of its own.
    const rail = screen.getByRole('dialog', { name: 'elowen' });
    expect(within(rail).getByText('/var/www/elowen')).toHaveAttribute('data-slot', 'dialog-description');
    expect(within(rail).getAllByRole('heading', { name: 'elowen' })).toHaveLength(1);
  });

  it('shows a missing-directory pill in both wide and compact path presentations only for explicit false', async () => {
    server.use(http.get('*/api/projects', () => HttpResponse.json([
      { id: 1, slug: 'elowen', path: '/var/www/elowen', pathExists: false, notes: '', icon: '' },
      { id: 2, slug: 'legacy', path: '/var/www/legacy', notes: '', icon: '' },
    ])));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    await screen.findByText('legacy');
    const warnings = screen.getAllByText('Directory missing');
    expect(warnings).toHaveLength(2);
    expect(warnings.some((warning) => warning.closest('[data-priority="wide"]'))).toBe(true);
    expect(warnings.some((warning) => warning.closest('[data-project-compact-path]'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Open project legacy' }).closest('[role="row"]')).not.toHaveTextContent('Directory missing');
  });

  it('manages member access from the selected Project', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open project elowen' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'People' }));
    expect(await screen.findByText('1 of 1 users have access')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    const dialog = await screen.findByRole('dialog', { name: 'User access' });
    expect(dialog).toHaveTextContent('Bob');
    expect(dialog).not.toHaveTextContent('@admin');
  });

  // A row opens through a real button spanning it, so Enter and Space come from the platform rather than
  // a keydown handler — and the accessible name is the short one the caller supplies, not the row's text.
  it('opens a project from a single named button, not from the row itself', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    const open = await screen.findByRole('button', { name: 'Open project elowen' });
    expect(open.tagName).toBe('BUTTON');
    const row = open.closest('[role="row"]')!;
    expect(row).not.toHaveAttribute('tabindex');

    fireEvent.click(open);
    expect(await screen.findByText('master')).toBeTruthy();
    expect(row).toHaveAttribute('aria-selected', 'true');
  });

  it('withholds editor controls when the editor plugin is unavailable', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'Open project elowen' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Open project elowen' }));
    expect(await screen.findByText('master')).toBeInTheDocument();
    expect(screen.queryByText('Edit project')).toBeNull();
  });

  // The register narrows on one text query and nothing else. A page with no filter fields must not
  // carry a Filters control at all — a trigger that opens an empty panel is a dead end.
  it('puts its search in the canonical toolbar row and offers no empty Filters control', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    await screen.findByText('elowen');
    const search = screen.getByPlaceholderText('Search projects, paths or notes…');
    expect(search.closest('.page-toolbar')).toBeInTheDocument();
    expect(screen.queryByTestId('page-filters-trigger')).toBeNull();
    expect(screen.queryByTestId('page-filter-chips')).toBeNull();
  });

  it('filters the project register without losing the workspace layout', async () => {
    server.use(http.get('*/api/projects', () => HttpResponse.json([
      { id: 1, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '' },
      { id: 2, slug: 'website', path: '/var/www/site', notes: 'public', icon: '' },
    ])));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    await screen.findByText('website');
    fireEvent.change(screen.getByPlaceholderText('Search projects, paths or notes…'), { target: { value: 'elowen' } });
    await waitFor(() => expect(screen.queryByText('website')).not.toBeInTheDocument());
    expect(screen.getByText('elowen')).toBeInTheDocument();
    expect(screen.getByTestId('spatial-workspace-layout')).toBeInTheDocument();
    expect(screen.getAllByTestId('workspace-hero-metrics')).toHaveLength(1);
    expect(screen.getByTestId('projects-register').closest('[data-control-surface]')).toBeInTheDocument();
  });

  it('offers directory creation only from the New project picker', async () => {
    server.use(http.get('*/api/fs/dirs', () => HttpResponse.json({ path: '/workspace', parent: '/', entries: [] })));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    let editor = await screen.findByRole('dialog', { name: 'New project' });
    fireEvent.keyDown(within(editor).getByRole('combobox', { name: 'Execution target' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Host directory' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Browse' }));
    let picker = await screen.findByRole('dialog', { name: 'Pick the project folder' });
    expect(within(picker).getByRole('button', { name: 'New folder' })).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(await screen.findByRole('button', { name: 'elowen: Actions' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit project' }));
    editor = await screen.findByRole('dialog', { name: 'Edit project' });
    fireEvent.click(within(editor).getByRole('button', { name: 'Browse' }));
    picker = await screen.findByRole('dialog', { name: 'Pick the project folder' });
    expect(within(picker).queryByRole('button', { name: 'New folder' })).toBeNull();
  });

  it('creates a child directory, refreshes its parent and navigates into the new folder', async () => {
    let parentReads = 0;
    let createBody: unknown;
    server.use(
      http.get('*/api/fs/dirs', ({ request }) => {
        const requested = new URL(request.url).searchParams.get('path');
        if (requested === '/workspace/new-app') return HttpResponse.json({ path: '/workspace/new-app', parent: '/workspace', entries: [] });
        parentReads += 1;
        return HttpResponse.json({ path: '/workspace', parent: '/', entries: [] });
      }),
      http.post('*/api/fs/dirs', async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json({ path: '/workspace/new-app' }, { status: 201 });
      }),
    );
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['fs-dirs', '/workspace'], { path: '/workspace', parent: '/', entries: [] });
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const editor = await screen.findByRole('dialog', { name: 'New project' });
    fireEvent.keyDown(within(editor).getByRole('combobox', { name: 'Execution target' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Host directory' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Browse' }));
    const picker = await screen.findByRole('dialog', { name: 'Pick the project folder' });
    const newFolder = within(picker).getByRole('button', { name: 'New folder' });
    await waitFor(() => expect(newFolder).toBeEnabled());
    fireEvent.click(newFolder);
    fireEvent.change(within(picker).getByLabelText('Folder name'), { target: { value: 'new-app' } });
    fireEvent.click(within(picker).getByRole('button', { name: 'Create folder' }));

    await waitFor(() => expect(within(picker).getAllByText('/workspace/new-app')).toHaveLength(2));
    expect(createBody).toEqual({ parent: '/workspace', name: 'new-app' });
    expect(parentReads).toBeGreaterThanOrEqual(2);
    expect(client.getQueryState(['fs-dirs', '/workspace'])?.isInvalidated).toBe(true);
    expect(within(picker).getByRole('status')).toHaveTextContent('Folder "new-app" created.');
    expect(within(picker).getByRole('button', { name: 'Select this folder' })).toBeEnabled();
    expect(within(editor).queryByDisplayValue('/workspace/new-app')).toBeNull();
  });

  it('disables navigation while creating and ignores a superseded success', async () => {
    let resolveCreate!: () => void;
    let parentReads = 0;
    const createGate = new Promise<void>((resolve) => { resolveCreate = resolve; });
    server.use(
      http.get('*/api/fs/dirs', ({ request }) => {
        const requested = new URL(request.url).searchParams.get('path');
        if (requested === '/workspace/child') return HttpResponse.json({ path: '/workspace/child', parent: '/workspace', entries: [] });
        parentReads += 1;
        return HttpResponse.json({ path: '/workspace', parent: '/', entries: [{ name: 'child', path: '/workspace/child' }] });
      }),
      http.post('*/api/fs/dirs', async () => {
        await createGate;
        return HttpResponse.json({ path: '/workspace/new-app' }, { status: 201 });
      }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const editor = await screen.findByRole('dialog', { name: 'New project' });
    fireEvent.keyDown(within(editor).getByRole('combobox', { name: 'Execution target' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Host directory' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Browse' }));
    const picker = await screen.findByRole('dialog', { name: 'Pick the project folder' });
    const newFolder = within(picker).getByRole('button', { name: 'New folder' });
    await waitFor(() => expect(newFolder).toBeEnabled());
    fireEvent.click(newFolder);
    fireEvent.change(within(picker).getByLabelText('Folder name'), { target: { value: 'new-app' } });
    fireEvent.click(within(picker).getByRole('button', { name: 'Create folder' }));

    await waitFor(() => {
      expect(within(picker).getByRole('button', { name: 'Up one level' })).toBeDisabled();
      expect(within(picker).getByRole('button', { name: 'child' })).toBeDisabled();
      expect(within(picker).getByRole('button', { name: 'Select this folder' })).toBeDisabled();
    });
    const createForm = within(picker).getByLabelText('Folder name').closest('form');
    if (!createForm) throw new Error('create form missing');
    fireEvent.click(within(createForm).getByRole('button', { name: 'Cancel' }));
    resolveCreate();

    await waitFor(() => expect(parentReads).toBeGreaterThanOrEqual(2));
    expect(within(picker).queryByRole('status')).toBeNull();
    expect(within(picker).queryByText('/workspace/new-app')).toBeNull();
    expect(within(picker).getAllByText('/workspace')).toHaveLength(2);
  });

  it('shows the typed duplicate-directory message for a 409 response', async () => {
    server.use(
      http.get('*/api/fs/dirs', () => HttpResponse.json({ path: '/workspace', parent: '/', entries: [] })),
      http.post('*/api/fs/dirs', () => HttpResponse.json({ error: 'directory already exists' }, { status: 409 })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const editor = await screen.findByRole('dialog', { name: 'New project' });
    fireEvent.keyDown(within(editor).getByRole('combobox', { name: 'Execution target' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Host directory' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Browse' }));
    const picker = await screen.findByRole('dialog', { name: 'Pick the project folder' });
    const newFolder = within(picker).getByRole('button', { name: 'New folder' });
    await waitFor(() => expect(newFolder).toBeEnabled());
    fireEvent.click(newFolder);
    fireEvent.change(within(picker).getByLabelText('Folder name'), { target: { value: 'taken' } });
    fireEvent.click(within(picker).getByRole('button', { name: 'Create folder' }));

    expect(await within(picker).findByText('A folder with this name already exists.')).toBeInTheDocument();
  });

  it('browses from the edit form and cancelling removal preserves the draft without deleting', async () => {
    let deleteHit = false;
    server.use(
      http.get('*/api/fs/dirs', ({ request }) => {
        expect(new URL(request.url).searchParams.get('path')).toBe('/draft/path');
        return HttpResponse.json({ path: '/selected/path', parent: '/', entries: [] });
      }),
      http.delete('*/api/projects/1', () => { deleteHit = true; return HttpResponse.json({ ok: true }); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    await screen.findByText('elowen');
    fireEvent.click(screen.getByRole('button', { name: 'elowen: Actions' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit project' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit project' });
    const editInputs = edit.querySelectorAll('input');
    const editPathInput = editInputs[1] as HTMLInputElement;
    const editNotesInput = edit.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(editPathInput, { target: { value: '/draft/path' } });
    fireEvent.change(editNotesInput, { target: { value: 'draft notes' } });

    const browse = within(edit).getByRole('button', { name: 'Browse' });
    browse.focus();
    fireEvent.click(browse);
    let picker = await screen.findByRole('dialog', { name: 'Pick the project folder' });
    expect(edit).toHaveAttribute('data-presentation', 'drawer');
    expect(picker).toHaveAttribute('data-presentation', 'center');
    const overlays = Array.from(document.querySelectorAll('[data-slot="dialog-overlay"]'));
    expect(overlays.at(-1)?.contains(picker)).toBe(true);
    fireEvent.click(within(picker).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(browse).toHaveFocus());
    expect(editPathInput).toHaveValue('/draft/path');
    expect(editNotesInput).toHaveValue('draft notes');

    fireEvent.click(browse);
    picker = await screen.findByRole('dialog', { name: 'Pick the project folder' });
    const selectFolder = within(picker).getByRole('button', { name: 'Select this folder' });
    await waitFor(() => expect(selectFolder).toBeEnabled());
    fireEvent.click(selectFolder);
    await waitFor(() => expect(editPathInput).toHaveValue('/selected/path'));

    fireEvent.click(within(edit).getByRole('button', { name: 'Remove project' }));
    expect(await screen.findByRole('alertdialog', { name: 'Remove project' })).toBeInTheDocument();
    expect(deleteHit).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('dialog', { name: 'Edit project' })).toBeInTheDocument();
    expect(editPathInput).toHaveValue('/selected/path');
    expect(editNotesInput).toHaveValue('draft notes');
    expect(deleteHit).toBe(false);
  });

  it('submits removal once and never closes a newer editor after a deferred response', async () => {
    let deleteHits = 0;
    let resolveDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { resolveDelete = resolve; });
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([
        { id: 1, slug: 'elowen', path: '[host-path]', notes: '', icon: '' },
        { id: 2, slug: 'website', path: '/var/www/site', notes: 'newer draft', icon: '' },
      ])),
      http.get('*/api/projects/2/git', () => HttpResponse.json({ isRepo: false, status: null, branches: [], commits: [] })),
      http.delete('*/api/projects/1', async () => {
        deleteHits += 1;
        await deleteGate;
        return HttpResponse.json({ ok: true });
      }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);

    await screen.findByText('website');
    fireEvent.click(screen.getByRole('button', { name: 'elowen: Actions' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit project' }));
    const firstEditor = await screen.findByRole('dialog', { name: 'Edit project' });
    fireEvent.click(within(firstEditor).getByRole('button', { name: 'Remove project' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove project' });
    const remove = within(confirm).getByRole('button', { name: 'Remove' });
    fireEvent.click(remove);
    fireEvent.click(remove);
    await waitFor(() => expect(deleteHits).toBe(1));
    expect(confirm).toBeInTheDocument();

    // Synthetic interaction models a newer editor state arriving while the old request is still pending.
    fireEvent.click(screen.getByRole('button', { name: 'website: Actions', hidden: true }));
    fireEvent.click(within(screen.getByRole('menu', { hidden: true })).getByRole('menuitem', { name: 'Edit project', hidden: true }));
    const currentEditor = screen.getByRole('dialog', { name: 'Edit project', hidden: true });
    expect((currentEditor.querySelector('input') as HTMLInputElement)).toHaveValue('website');

    resolveDelete();
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Remove project' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Edit project' })).toBeInTheDocument();
    expect((currentEditor.querySelector('input') as HTMLInputElement)).toHaveValue('website');
    expect(screen.getByRole('button', { name: 'Open project website', hidden: true }).closest('[role="row"]')).toHaveAttribute('aria-selected', 'true');
    expect(deleteHits).toBe(1);
  });
});
