import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import type { ProjectExecutionRef } from '../../../lib/types';

const chat = { telemetry: { project: null as { cwd: string } | null, projectRef: null as ProjectExecutionRef | null }, activeSessionId: null as string | null };
vi.mock('../../../modules/advisor/BrainChatProvider', () => ({ useBrainChat: () => chat }));
const { ProjectPicker } = await import('../../../modules/advisor/ProjectPicker');
const PROJECTS = [{ id: 1, slug: 'kolin', path: '/workspace', executionKind: 'managed' }, { id: 2, slug: 'elowen', path: '/workspace', executionKind: 'managed' }];
const HOST_PROJECT = { id: 3, slug: 'server', path: '/host', executionKind: 'host' };
const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json(PROJECTS)),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, is_admin: false } })),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());
afterEach(() => { server.resetHandlers(); chat.telemetry.project = null; chat.telemetry.projectRef = null; chat.activeSessionId = null; });
const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><ProjectPicker /></ToastProvider></Wrapper>);
};

describe('ProjectPicker', () => {
  it('stays disabled until a conversation is live', async () => {
    mount();
    expect(await screen.findByRole('button')).toBeDisabled();
  });

  // A host project is a project. The picker calls it by its name, exactly as it names a managed one, and
  // offers no standalone host destination of its own — host administration keeps its home in Projects,
  // the CLI and the API.
  it('names host projects normally and offers no standalone host mode', async () => {
    chat.activeSessionId = 'brain-1-a'; chat.telemetry.projectRef = { kind: 'managed', projectId: 1 };
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([...PROJECTS, HOST_PROJECT])),
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, is_admin: true } })),
    );
    mount();
    const trigger = await screen.findByRole('button', { name: /kolin/ });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    // The host project is listed, under its own name and with no red mode label beside it.
    const option = await screen.findByRole('menuitemradio', { name: 'server' });
    expect(within(option).queryByText('HOST MODE')).toBeNull();
    expect(screen.queryByText('HOST MODE')).toBeNull();
    // And there is no entry that means "the host itself".
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['kolin', 'elowen', 'server']);
  });

  // A conversation may still sit in a host target with no project behind it. The picker shows no host
  // mode for that either — no label, no shield, no red — and names the state for what it is: a target
  // that WAS chosen and has no project. Presentation only: the execution state is left as reported.
  it('shows no host mode for a nameless host target a conversation already sits in', async () => {
    chat.activeSessionId = 'brain-1-a'; chat.telemetry.projectRef = { kind: 'host' };
    let posted = 0;
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([PROJECTS[0]])),
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, is_admin: true } })),
      http.post('*/api/brain/execution', () => { posted++; return HttpResponse.json({ projectRef: { kind: 'host' }, workDir: '/' }); }),
    );
    mount();

    const trigger = await screen.findByRole('button', { name: 'No project' });
    await waitFor(() => expect(trigger).toBeEnabled());
    // None of the ways host mode used to announce itself here.
    expect(screen.queryByText('HOST MODE')).toBeNull();
    expect(trigger.className).not.toMatch(/destructive/);
    expect(trigger.querySelector('svg.lucide-shield-alert')).toBeNull();
    // And nothing was sent to change what the conversation actually runs in.
    expect(posted).toBe(0);
  });

  it('selects managed projects by identity, never by their shared guest path', async () => {
    chat.activeSessionId = 'brain-1-a'; chat.telemetry.projectRef = { kind: 'managed', projectId: 1 };
    let body: unknown;
    server.use(http.post('*/api/brain/execution', async ({ request }) => {
      body = await request.json(); return HttpResponse.json({ projectRef: { kind: 'managed', projectId: 2 }, workDir: '/workspace' });
    }));
    mount();
    const trigger = await screen.findByRole('button', { name: /kolin/ });
    await waitFor(() => expect(trigger).toBeEnabled());
    trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const option = await screen.findByRole('menuitemradio', { name: /elowen/ });
    act(() => option.focus()); fireEvent.keyDown(option, { key: 'Enter' });
    await waitFor(() => expect(body).toEqual({ target: { kind: 'managed', projectId: 2 }, session: 'brain-1-a' }));
    expect(await screen.findByRole('button', { name: /elowen/ })).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  // A host project the API offered this account is a project like any other. The list it returns is
  // already the set this account may reach, so the picker does not re-decide that on its own.
  it('offers host projects to members exactly as it offers managed ones', async () => {
    chat.activeSessionId = 'brain-1-a';
    server.use(http.get('*/api/projects', () => HttpResponse.json([...PROJECTS, HOST_PROJECT])));
    mount();
    const trigger = await screen.findByRole('button');
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await screen.findByRole('menuitemradio', { name: /kolin/ });
    expect(screen.queryByText('HOST MODE')).toBeNull();
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['kolin', 'elowen', 'server']);
  });

  // Host mode asks nothing: choosing a host project sends the host target straight away.
  it('sends a host target with no confirmation step', async () => {
    chat.activeSessionId = 'brain-1-a'; chat.telemetry.projectRef = { kind: 'managed', projectId: 1 };
    let body: unknown;
    let calls = 0;
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([...PROJECTS, HOST_PROJECT])),
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, is_admin: false } })),
      http.post('*/api/brain/execution', async ({ request }) => {
        calls++; body = await request.json();
        return HttpResponse.json({ projectRef: { kind: 'host', projectId: 3 }, workDir: '/host' });
      }),
    );
    mount();
    const trigger = await screen.findByRole('button', { name: /kolin/ });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'server' }));

    await waitFor(() => expect(calls).toBe(1));
    expect(body).toEqual({ target: { kind: 'host', projectId: 3 }, session: 'brain-1-a' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByRole('button', { name: /server/ })).toBeInTheDocument();
  });

  // The switch answers before the container exists, so what the picker shows next is the operation that
  // brings it up. This is the whole point of the change: a spinner on the save indicator said nothing,
  // and on a cold environment it said nothing for minutes.
  describe('the environment a switch has to start', () => {
    const selectElowen = async () => {
      const trigger = await screen.findByRole('button', { name: /kolin/ });
      await waitFor(() => expect(trigger).toBeEnabled());
      trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      fireEvent.click(await screen.findByRole('menuitemradio', { name: /elowen/ }));
    };
    const operation = (over: Record<string, unknown> = {}) => ({
      id: 'env_op_1', requestId: 'r', projectId: 2, accountUserId: 1, generation: 1,
      action: { kind: 'start' }, status: 'running', error: null,
      steps: ['image', 'storage', 'container', 'boot', 'initialize'], stepIndex: 2, stepTotal: 5,
      stepLabel: 'container', percent: 40, logTail: ['STEP 1/4: FROM debian'], ...over,
    });
    const switching = (op: Record<string, unknown>) => [
      http.post('*/api/brain/execution', () => HttpResponse.json({ projectRef: { kind: 'managed', projectId: 2 }, workDir: '/elowen', operationId: 'env_op_1' })),
      http.get('*/api/plugins/sandbox/api/environments/operation', () => HttpResponse.json(op)),
    ];

    it('shows the progress window with the current step and percent', async () => {
      chat.activeSessionId = 'brain-1-a'; chat.telemetry.projectRef = { kind: 'managed', projectId: 1 };
      server.use(...switching(operation()));
      mount();
      await selectElowen();

      // The window opens indeterminate — there is nothing to report until the first frame lands — and
      // then carries the real figure the daemon declared.
      expect(await screen.findByText('Creating the container')).toBeInTheDocument();
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '40');
      expect(bar).toHaveAttribute('aria-valuemin', '0');
      expect(bar).toHaveAttribute('aria-valuemax', '100');
      expect(screen.getByText('Step 3 of 5')).toBeInTheDocument();
    });

    it('settles on success and stops showing the window', async () => {
      chat.activeSessionId = 'brain-1-a'; chat.telemetry.projectRef = { kind: 'managed', projectId: 1 };
      server.use(...switching(operation({ status: 'succeeded', percent: 100, stepIndex: 4, stepLabel: 'initialize' })));
      mount();
      await selectElowen();
      expect(await screen.findByText('Done')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByTestId('operation-progress-dialog')).toBeNull(), { timeout: 4000 });
    });

    // The stale environment the mount rename left behind. The failure names the repair and the window
    // offers it, so nobody has to remove a container by hand to get their project back.
    it('offers the recreate repair when the environment predates the project mount', async () => {
      chat.activeSessionId = 'brain-1-a'; chat.telemetry.projectRef = { kind: 'managed', projectId: 1 };
      let requested: unknown;
      server.use(
        ...switching(operation({ status: 'failed', percent: null, error: 'This environment predates the named project mount. Recreate it to build a new container (elowen).' })),
        http.post('*/api/plugins/sandbox/api/projects/2/environment', async ({ request }) => {
          requested = await request.json();
          return HttpResponse.json({ ...operation({ id: 'env_op_2', action: { kind: 'recreate' } }) });
        }),
      );
      mount();
      await selectElowen();

      expect(await screen.findByRole('alert')).toHaveTextContent(/predates the named project mount/);
      fireEvent.click(screen.getByRole('button', { name: 'Recreate environment' }));
      await waitFor(() => expect(requested).toEqual({ action: { kind: 'recreate' } }));
    });
  });
});
