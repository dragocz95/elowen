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
  // mode for that either — no label, no shield, no red — only the neutral wording any nameless target
  // gets. Presentation only: the execution state is left exactly as the daemon reported it.
  it('shows no host mode for a nameless host target a conversation already sits in', async () => {
    chat.activeSessionId = 'brain-1-a'; chat.telemetry.projectRef = { kind: 'host' };
    let posted = 0;
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([PROJECTS[0]])),
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, is_admin: true } })),
      http.post('*/api/brain/execution', () => { posted++; return HttpResponse.json({ projectRef: { kind: 'host' }, workDir: '/' }); }),
    );
    mount();

    const trigger = await screen.findByRole('button', { name: 'Execution target not selected' });
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
});
