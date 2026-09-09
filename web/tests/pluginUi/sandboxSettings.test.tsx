import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import manifest from '../../../plugins/sandbox/elowen-plugin.json';
import { WorkspacesSettings } from '../../../plugins/sandbox/web-src/WorkspacesSettings';
import { EnvironmentSettings } from '../../../plugins/sandbox/web-src/EnvironmentSettings';
import { ProjectEnvironmentSettings } from '../../../plugins/sandbox/web-src/ProjectEnvironmentSettings';
import { ensurePluginUiRuntime } from '../../lib/pluginUi';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';
import { onUnhandledRequest } from '../msw';

ensurePluginUiRuntime();
const strings = (manifest as { web: { strings: Record<string, string> } }).web.strings;
const listing = [{ name: 'sandbox', url: '/plugins/sandbox/web/index.js', apiVersion: 5, nav: [], user: manifest.web.user, project: manifest.web.project, settings: [], strings }];
const targetUser = {
  id: 2, username: 'bob', created_at: '', is_admin: false, allowed_execs: [], disabled_tools: [], allowed_tools: [], granted_plugins: [],
  name: 'Bob', email: '', avatar: '', default_exec: '', advisor_exec: '', advisor_autostart: false,
};

const overview = {
  projects: [{ id: 1, slug: 'demo', path: '/repo' }],
  sessions: [{ id: 'brain-1', title: 'Demo conversation', updatedAt: '2026-08-26T06:00:00Z' }],
  workspaces: [{
    id: 'ws_1', userId: 1, projectId: 1, label: 'Feature Alpha', path: '/data/ws_1', branch: 'elowen/u1/feature-alpha-a1b2c3d4', baseRef: 'main',
    lifecycle: 'active', orphanReason: null, createdAt: '2026-08-26T05:00:00Z', updatedAt: '2026-08-26T05:30:00Z', lastUsedAt: '2026-08-26T06:00:00Z',
    accessible: true, status: { branch: 'elowen/u1/feature-alpha-a1b2c3d4', head: 'abc', upstream: null, ahead: 1, behind: 0, dirty: 1, untracked: 0, clean: false },
    files: [{ path: 'src/app.ts', code: ' M', untracked: false }], uniqueCommits: 1, activeProcesses: 0,
    bindings: [{ sessionId: 'brain-1', updatedAt: '2026-08-26T06:00:00Z' }],
  }],
};

const environment = {
  mode: 'confined', probe: { available: true, reason: null }, networkAvailable: true,
  home: { path: '/data/users/1/home', generation: 2, bytes: 2048, entries: 4, truncated: false, activeProcesses: 0 },
  author: { name: 'Amy', email: 'amy@example.test' }, migrationCollision: false,
};

const server = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json(listing)),
  http.get('*/api/plugins/sandbox/api/overview', () => HttpResponse.json(overview)),
  http.post('*/api/plugins/sandbox/api/workspaces/diff', () => HttpResponse.json({ diff: 'diff --git a/src/app.ts b/src/app.ts\n+change' })),
  http.get('*/api/plugins/sandbox/api/environment', () => HttpResponse.json(environment)),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); localStorage.clear(); });
afterAll(() => server.close());

function mount(node: ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider>{node}</ToastProvider></Wrapper>);
}

describe('sandbox Project workspaces', () => {
  it('shows managed project lifecycle instead of account HOME and reports pending operations honestly', async () => {
    let submitted: unknown;
    const environment = { projectId: 1, generation: 2, state: 'stopped', desiredState: 'stopped', lastError: null, limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 4096 } };
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, is_admin: false } })),
      http.get('*/api/plugins/sandbox/api/projects/1/environment', () => HttpResponse.json({ environment, snapshots: [], operations: [] })),
      http.post('*/api/plugins/sandbox/api/projects/1/environment', async ({ request }) => { submitted = await request.json(); return HttpResponse.json({ id: 'op-1', requestId: (submitted as { requestId: string }).requestId, projectId: 1, generation: 2, accountUserId: 1, action: { kind: 'start' }, status: 'pending', error: null }); }),
    );
    mount(<WorkspacesSettings surface="project" project={{ ...overview.projects[0]!, executionKind: 'managed' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start environment' }));
    await waitFor(() => expect(submitted).toEqual({ action: { kind: 'start' }, expectedGeneration: 2, requestId: expect.any(String) }));
    expect(await screen.findByText('Operation requested. Completion is reported by the environment.')).toBeInTheDocument();
    expect(screen.queryByText('Environment started.')).toBeNull();
    expect(screen.queryByText('Account HOME')).toBeNull();
  });
  it('opens a row through its single named control and renders the live patch in a Project modal', async () => {
    mount(<WorkspacesSettings surface="project" project={overview.projects[0]} />);
    // Opening a row is the row contract: ONE real button spanning it, carrying a short accessible name
    // rather than the row's whole text. It is a native button, so Enter and Space come from the
    // platform instead of a key handler the row has to re-implement.
    const open = await screen.findByRole('button', { name: strings.openWorkspace!.replace('{name}', 'Feature Alpha') });
    fireEvent.click(open);
    const detail = await screen.findByRole('dialog', { name: 'Feature Alpha' });
    expect(within(detail).getByText((_text, element) => element?.tagName === 'LI' && element.textContent?.includes('src/app.ts') === true)).toBeInTheDocument();
    expect(await within(detail).findByText('+change')).toBeInTheDocument();
    expect(within(detail).getByText(strings.active!)).toBeInTheDocument();
  });

  it('creates a workspace with an explicit Project, label and base ref', async () => {
    let submitted: unknown;
    server.use(http.post('*/api/plugins/sandbox/api/workspaces/create', async ({ request }) => {
      submitted = await request.json();
      return HttpResponse.json({ workspace: overview.workspaces[0] }, { status: 201 });
    }));
    mount(<WorkspacesSettings surface="project" project={overview.projects[0]} />);
    fireEvent.click(await screen.findByRole('button', { name: strings.create }));
    const dialog = within(await screen.findByRole('dialog', { name: strings.createTitle }));
    fireEvent.change(dialog.getByPlaceholderText(strings.labelPlaceholder!), { target: { value: 'Fix checkout' } });
    fireEvent.change(dialog.getByPlaceholderText(strings.baseRefPlaceholder!), { target: { value: 'develop' } });
    fireEvent.click(dialog.getByRole('button', { name: strings.save }));
    await waitFor(() => expect(submitted).toEqual({ projectId: '1', label: 'Fix checkout', baseRef: 'develop' }));
  });

  it('shows the error state instead of a loading skeleton after the request fails', async () => {
    server.use(http.get('*/api/plugins/sandbox/api/overview', () => HttpResponse.json({ error: 'broken' }, { status: 500 })));
    mount(<WorkspacesSettings surface="project" project={overview.projects[0]} />);
    expect(await screen.findByText(strings.loadError!)).toBeInTheDocument();
  });
});

describe('managed environment lifecycle', () => {
  const project = { id: 1, slug: 'demo', path: '', executionKind: 'managed' as const };
  const environment = { projectId: 1, generation: 2, state: 'stopped', desiredState: 'stopped', lastError: null, limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 4096 } };
  const detail = { environment, operations: [], snapshots: [{ id: 'complete', generation: 2, consistency: 'crash-consistent', createdAt: '2026-09-08', note: 'Before change', completeProject: true }, { id: 'partial', generation: 2, consistency: 'crash-consistent', createdAt: '2026-09-08', note: 'Incomplete', completeProject: false }] };
  const setup = () => server.use(http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, is_admin: false } })), http.get('*/api/plugins/sandbox/api/projects/1/environment', () => HttpResponse.json(detail)));

  it('reuses persisted request identity after a lost response', async () => {
    setup();
    const requests: { requestId: string; expectedGeneration: number }[] = [];
    server.use(http.post('*/api/plugins/sandbox/api/projects/1/environment', async ({ request }) => {
      const body = await request.json() as { requestId: string; expectedGeneration: number };
      requests.push(body);
      if (requests.length === 1) return HttpResponse.json({ error: 'Response lost' }, { status: 503 });
      return HttpResponse.json({ id: 'op-retry', requestId: body.requestId, projectId: 1, generation: 2, accountUserId: 1, action: { kind: 'start' }, status: 'pending', error: null });
    }));
    mount(<ProjectEnvironmentSettings project={project} />);
    fireEvent.click(await screen.findByRole('button', { name: strings.startEnvironment }));
    expect(await screen.findByText('Response lost')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: strings.startEnvironment }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.requestId).toEqual(expect.any(String));
  });

  it('sends admin resource limits as a durable lifecycle action', async () => {
    setup();
    let submitted: unknown;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, is_admin: true } })),
      http.post('*/api/plugins/sandbox/api/projects/1/environment', async ({ request }) => { submitted = await request.json(); return HttpResponse.json({ id: 'op-limits', requestId: (submitted as { requestId: string }).requestId, projectId: 1, generation: 2, accountUserId: 1, action: { kind: 'limits' }, status: 'pending', error: null }); }),
    );
    mount(<ProjectEnvironmentSettings project={project} />);
    fireEvent.click(await screen.findByRole('button', { name: strings.editLimits }));
    const dialog = within(await screen.findByRole('dialog', { name: strings.editLimits }));
    fireEvent.change(dialog.getByLabelText(strings.memoryLimit!), { target: { value: '2048' } });
    fireEvent.click(dialog.getByRole('button', { name: strings.saveLimits }));
    await waitFor(() => expect(submitted).toEqual({ action: { kind: 'limits', limits: { ...environment.limits, memoryMb: 2048 } }, expectedGeneration: 2, requestId: expect.any(String) }));
  });

  it('fails visibly without exposing actions when the provider is unavailable', async () => {
    setup();
    server.use(http.get('*/api/plugins/sandbox/api/projects/1/environment', () => HttpResponse.json({ error: 'project environment provider unavailable' }, { status: 503 })));
    mount(<ProjectEnvironmentSettings project={project} />);
    expect(await screen.findByText('project environment provider unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: strings.startEnvironment })).toBeNull();
  });

  it('only restores complete snapshots after explicit destructive confirmation', async () => {
    setup();
    let submitted: unknown;
    server.use(http.post('*/api/plugins/sandbox/api/projects/1/environment', async ({ request }) => { submitted = await request.json(); return HttpResponse.json({ id: 'op-restore', requestId: (submitted as { requestId: string }).requestId, projectId: 1, accountUserId: 1, generation: 2, status: 'pending', action: { kind: 'restore', snapshotId: 'complete' }, error: null }); }));
    mount(<ProjectEnvironmentSettings project={project} />);
    const select = await screen.findByRole('combobox', { name: strings.snapshots });
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: /Incomplete/ })).toBeNull();
    fireEvent.click(await screen.findByRole('option', { name: /Before change/ }));
    fireEvent.click(screen.getByRole('button', { name: strings.restoreEnvironment }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(strings.restoreWarning!)).toBeInTheDocument();
    expect(submitted).toBeUndefined();
    fireEvent.click(dialog.getByRole('button', { name: strings.restoreEnvironment }));
    await waitFor(() => expect(submitted).toEqual({ action: { kind: 'restore', snapshotId: 'complete' }, expectedGeneration: 2, requestId: expect.any(String) }));
    expect(screen.queryByRole('button', { name: strings.editLimits })).toBeNull();
  });

  it('requests durable project deletion through core instead of deleting only the container', async () => {
    setup();
    let deleted = false;
    server.use(http.delete('*/api/projects/1', async ({ request }) => { const body = await request.json() as { requestId: string }; expect(body).toEqual({ requestId: expect.any(String), expectedGeneration: 2 }); deleted = true; return HttpResponse.json({ operation: { id: 'op-delete', requestId: body.requestId, projectId: 1, generation: 2, accountUserId: 1, action: { kind: 'delete' }, status: 'pending', error: null } }, { status: 202 }); }));
    mount(<ProjectEnvironmentSettings project={project} />);
    fireEvent.click(await screen.findByRole('button', { name: strings.deleteProject }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(strings.deleteProjectWarning!)).toBeInTheDocument();
    expect(deleted).toBe(false);
    fireEvent.click(dialog.getByRole('button', { name: strings.deleteProject }));
    await waitFor(() => expect(deleted).toBe(true));
    expect(await screen.findByText(strings.operationRequested!)).toBeInTheDocument();
  });
});

describe('sandbox Environment settings', () => {
  it('targets the selected User and requires the exact server-issued phrase before resetting HOME', async () => {
    let resetBody: unknown;
    const targetIds: string[] = [];
    server.use(
      http.post('*/api/plugins/sandbox/api/environment/reset-preview', ({ request }) => {
        targetIds.push(new URL(request.url).searchParams.get('userId') ?? '');
        return HttpResponse.json({
          generation: 2, bytes: 2048, entries: 4, activeProcesses: 0, author: environment.author,
          phrase: 'RESET HOME', previewHash: 'preview-1',
        });
      }),
      http.post('*/api/plugins/sandbox/api/environment/reset', async ({ request }) => {
        targetIds.push(new URL(request.url).searchParams.get('userId') ?? '');
        resetBody = await request.json();
        return HttpResponse.json({ generation: 3 });
      }),
    );
    mount(<EnvironmentSettings surface="user" user={targetUser} />);
    // The account drawer shows a preview row and keeps the settings one click deeper, so this panel
    // reads like the tool and project summaries beside it instead of a page pasted into the rail.
    fireEvent.click(await screen.findByRole('button', { name: strings.manageEnvironment }));
    fireEvent.click(await screen.findByRole('button', { name: strings.resetHome }));
    const dialog = within(await screen.findByRole('dialog', { name: strings.resetTitle }));
    const confirm = dialog.getByRole('button', { name: strings.reset });
    expect(confirm).toBeDisabled();
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'RESET HOME' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(resetBody).toEqual({ previewHash: 'preview-1', phrase: 'RESET HOME' }));
    expect(targetIds).toEqual(['2', '2']);
  });
});

/** `mode` is computed in `plugins/sandbox/lib/api.mjs` from the account's operator authority, the
 *  instance-wide `confineNonOperators` setting and the live bubblewrap probe. It is never given a
 *  project, so it can only describe how commands run DIRECTLY ON THE HOST are contained for this
 *  account. These cases hold the drawer to that claim and no wider one: the section used to headline the
 *  bare words "Direct host", which reads as a statement about everywhere the account's work runs — and a
 *  managed project runs in its own container regardless of this value. */
describe('sandbox Environment settings — what the account row may claim', () => {
  const environmentWith = (over: Record<string, unknown>) => ({ ...environment, ...over });
  const rowFor = (label: string) => screen.getByText(label).closest('.settings-row');

  it('names the scope of the mode instead of stating it bare, and reads as records like the rows above it', async () => {
    mount(<EnvironmentSettings surface="user" user={targetUser} />);
    const row = (await screen.findByText(strings.hostExecution!)).closest('.settings-row');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(strings.modeConfined!)).toBeInTheDocument();
    // The scope belongs in the record's own help, not in a paragraph the reader has to hunt for.
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Help' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent(strings.hostExecutionHint!);
  });

  // An operator, or an instance that turned confinement off, gets 'direct'. The account genuinely runs
  // host commands unconfined — but that is all it means, and the row must not grow into a claim that
  // every project is a host directory.
  it('reports an unconfined account without claiming anything about its managed projects', async () => {
    server.use(http.get('*/api/plugins/sandbox/api/environment', () => HttpResponse.json(environmentWith({ mode: 'direct', networkAvailable: false }))));
    mount(<EnvironmentSettings surface="user" user={targetUser} />);
    expect(await screen.findByText(strings.modeDirect!)).toBeInTheDocument();
    expect(screen.getByText(strings.hostExecution!)).toBeInTheDocument();
    // The retired headline is gone in every locale's English source.
    expect(screen.queryByText('Direct host')).toBeNull();
    // Nothing in the visible row asserts a runtime for any project; the container story is the project
    // surface's, and this panel is never handed a project.
    expect(screen.queryByText(/container/i)).toBeNull();
  });

  // A failed probe on a confined account is the one state where nothing runs at all. It has to read as a
  // refusal rather than as a quiet fallback to unconfined execution.
  it('shows a refusal and the daemon reason when the namespace probe fails', async () => {
    server.use(http.get('*/api/plugins/sandbox/api/environment', () => HttpResponse.json(environmentWith({
      mode: 'unavailable', probe: { available: false, reason: 'user namespaces are disabled' }, networkAvailable: false,
    }))));
    mount(<EnvironmentSettings surface="user" user={targetUser} />);
    expect(await screen.findByText(strings.modeUnavailable!)).toBeInTheDocument();
    const probeRow = rowFor(strings.probe!) as HTMLElement;
    expect(within(probeRow).getByText(strings.probeFailed!)).toBeInTheDocument();
    fireEvent.click(within(probeRow).getByRole('button', { name: 'Help' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('user namespaces are disabled');
  });

  it('reads the account HOME and its running commands as their own records', async () => {
    server.use(http.get('*/api/plugins/sandbox/api/environment', () => HttpResponse.json(environmentWith({
      home: { ...environment.home, bytes: 3 * 1024 * 1024, activeProcesses: 2 },
    }))));
    mount(<EnvironmentSettings surface="user" user={targetUser} />);
    expect(within((await screen.findByText(strings.home!)).closest('.settings-row') as HTMLElement).getByText('3.0 MB')).toBeInTheDocument();
    expect(within(rowFor(strings.processes!) as HTMLElement).getByText('2')).toBeInTheDocument();
  });

  it('states a load failure and offers a retry rather than an empty environment', async () => {
    let attempts = 0;
    server.use(http.get('*/api/plugins/sandbox/api/environment', () => {
      attempts += 1;
      return attempts === 1 ? HttpResponse.json({ error: 'nope' }, { status: 500 }) : HttpResponse.json(environment);
    }));
    mount(<EnvironmentSettings surface="user" user={targetUser} />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    // No mode is asserted while the state is unknown.
    expect(screen.queryByText(strings.modeConfined!)).toBeNull();
    expect(screen.queryByText(strings.modeDirect!)).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByText(strings.modeConfined!)).toBeInTheDocument();
  });
});
