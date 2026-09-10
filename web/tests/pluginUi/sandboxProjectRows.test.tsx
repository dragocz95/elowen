import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import manifest from '../../../plugins/sandbox/elowen-plugin.json';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';
import { onUnhandledRequest } from '../msw';

const { loadPluginUi } = vi.hoisted(() => ({ loadPluginUi: vi.fn() }));
vi.mock('../../lib/pluginUi', async (loadOriginal) => ({
  ...(await loadOriginal<typeof import('../../lib/pluginUi')>()),
  loadPluginUi,
}));

import { ensurePluginUiRuntime } from '../../lib/pluginUi';
import { ProjectsView } from '../../modules/projects/ProjectsView';
import { useProjectRowContribution } from '../../../plugins/sandbox/web-src/projectRows';

ensurePluginUiRuntime();
const strings = (manifest as { web: { strings: Record<string, string> } }).web.strings;

/** One managed project that is running, one that is stopped, and a host project the plugin owns nothing
 *  of — the three cases a register row can be in. */
const projects = [
  { id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed' },
  { id: 5, slug: 'reports', path: '', notes: '', icon: '', executionKind: 'managed' },
  { id: 7, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '' },
];
const environmentOf = (projectId: number, state: string) => ({
  projectId, generation: 2, state, desiredState: state, lastError: null,
  limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 4096 },
});

let posted: { projectId: number; body: unknown }[] = [];

const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json(projects)),
  http.get('*/api/projects/summary', () => HttpResponse.json([])),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([{
    name: 'sandbox', url: '/plugins/sandbox/web/hash.js', apiVersion: 16,
    nav: [], account: [], project: [], settings: [], strings, projectRows: true,
  }])),
  http.get('*/api/plugins/sandbox/api/environments/status', ({ request }) => {
    const projectId = Number(new URL(request.url).searchParams.get('projectId'));
    return HttpResponse.json(environmentOf(projectId, projectId === 3 ? 'running' : 'stopped'));
  }),
  http.post('*/api/plugins/sandbox/api/projects/:id/environment', async ({ params, request }) => {
    const projectId = Number(params.id);
    const body = await request.json() as { action: { kind: string }; requestId: string };
    posted.push({ projectId, body });
    return HttpResponse.json({
      id: 'op-1', requestId: body.requestId, projectId, generation: 2, accountUserId: 1,
      action: body.action, status: 'pending', error: null,
      steps: ['image', 'storage', 'container', 'boot', 'initialize'], stepIndex: 0, stepTotal: 5, stepLabel: 'image', percent: 0,
    });
  }),
  http.get('*/api/plugins/sandbox/api/environments/operation', () => HttpResponse.json({
    id: 'op-1', requestId: 'r', projectId: 5, generation: 2, accountUserId: 1, action: { kind: 'start' },
    status: 'running', error: null, steps: ['image', 'storage', 'container', 'boot', 'initialize'],
    stepIndex: 2, stepTotal: 5, stepLabel: 'container', percent: 40, logTail: [],
  })),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); localStorage.clear(); });
afterAll(() => server.close());

function mount() {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
}

describe('sandbox contribution to the Project register rows', () => {
  beforeEach(() => {
    posted = [];
    loadPluginUi.mockReset();
    // Exactly what the built bundle registers, running against the real host runtime.
    loadPluginUi.mockResolvedValue({ requiresApiVersion: 16, projectRows: useProjectRowContribution });
  });

  it('reads each managed row state from the plugin and names it in the plugin words', async () => {
    mount();
    expect((await screen.findAllByRole('img', { name: strings.state_running })).length).toBeGreaterThan(0);
    expect((await screen.findAllByRole('img', { name: strings.state_stopped })).length).toBeGreaterThan(0);
    // A host project has no environment, so the plugin says nothing about its row.
    const hostRow = screen.getByRole('button', { name: 'Open project elowen' }).closest('[role="row"]') as HTMLElement;
    expect(within(hostRow).queryByRole('img', { name: strings.state_running })).toBeNull();
    expect(within(hostRow).queryByRole('menuitem')).toBeNull();
  });

  it('enables each lifecycle action by the state the environment is actually in', async () => {
    mount();
    await screen.findAllByRole('img', { name: strings.state_running });

    fireEvent.click(screen.getByRole('button', { name: 'analysis: Actions' }));
    await screen.findAllByRole('menuitem');
    expect(screen.getByRole('menuitem', { name: strings.startEnvironment })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: strings.stopEnvironment })).not.toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: strings.restartEnvironment })).not.toHaveAttribute('data-disabled');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));

    fireEvent.click(screen.getByRole('button', { name: 'reports: Actions' }));
    await screen.findAllByRole('menuitem');
    expect(screen.getByRole('menuitem', { name: strings.startEnvironment })).not.toHaveAttribute('data-disabled');
    // A stopped environment cannot be stopped again; the item stays in place and refuses.
    expect(screen.getByRole('menuitem', { name: strings.stopEnvironment })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: strings.snapshotEnvironment })).not.toHaveAttribute('data-disabled');
  });

  it('starts a stopped environment from the row and follows the durable operation', async () => {
    mount();
    await screen.findAllByRole('img', { name: strings.state_stopped });
    fireEvent.click(screen.getByRole('button', { name: 'reports: Actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: strings.startEnvironment }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      projectId: 5,
      body: { action: { kind: 'start' }, requestId: expect.any(String), expectedGeneration: 2 },
    });
    // The same progress window every other lifecycle surface raises, on the same durable row.
    expect(await screen.findByTestId('operation-progress-dialog')).toBeInTheDocument();
    expect(await screen.findByText('Creating the container')).toBeInTheDocument();
  });

  // A lost response must not queue a second start when the person tries again: the idempotency key is
  // persisted with the intent and reused until the daemon acknowledges it.
  it('reuses the persisted request identity after a lost response', async () => {
    const requests: { requestId: string; expectedGeneration: number }[] = [];
    server.use(http.post('*/api/plugins/sandbox/api/projects/5/environment', async ({ request }) => {
      const body = await request.json() as { requestId: string; expectedGeneration: number };
      requests.push(body);
      if (requests.length === 1) return HttpResponse.json({ error: 'Response lost' }, { status: 503 });
      return HttpResponse.json({ id: 'op-1', requestId: body.requestId, projectId: 5, generation: 2, accountUserId: 1, action: { kind: 'start' }, status: 'pending', error: null });
    }));
    mount();
    await screen.findAllByRole('img', { name: strings.state_stopped });

    for (const attempt of [1, 2]) {
      fireEvent.click(screen.getByRole('button', { name: 'reports: Actions' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: strings.startEnvironment }));
      await waitFor(() => expect(requests).toHaveLength(attempt));
    }
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.requestId).toEqual(expect.any(String));
  });

  it('asks before stopping a running environment, and sends nothing until it is confirmed', async () => {
    mount();
    await screen.findAllByRole('img', { name: strings.state_running });
    fireEvent.click(screen.getByRole('button', { name: 'analysis: Actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: strings.stopEnvironment }));

    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(strings.stopWarning!)).toBeInTheDocument();
    expect(posted).toHaveLength(0);
    fireEvent.click(dialog.getByRole('button', { name: strings.stopEnvironment }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toEqual({ action: { kind: 'stop' }, requestId: expect.any(String), expectedGeneration: 2 });
  });
});
