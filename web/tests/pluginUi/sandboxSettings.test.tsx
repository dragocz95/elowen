import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import manifest from '../../../plugins/sandbox/elowen-plugin.json';
import { WorkspacesSettings } from '../../../plugins/sandbox/web-src/WorkspacesSettings';
import { EnvironmentSettings } from '../../../plugins/sandbox/web-src/EnvironmentSettings';
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
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function mount(node: ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider>{node}</ToastProvider></Wrapper>);
}

describe('sandbox Project workspaces', () => {
  it('supports keyboard row selection and renders the live patch in a Project modal', async () => {
    mount(<WorkspacesSettings surface="project" project={overview.projects[0]} />);
    const row = await screen.findByRole('row', { name: /Feature Alpha/i });
    fireEvent.keyDown(row, { key: 'Enter' });
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
