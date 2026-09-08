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

  it('shows explicit host mode even with only one registered project', async () => {
    chat.activeSessionId = 'brain-1-a'; chat.telemetry.projectRef = { kind: 'host' };
    server.use(http.get('*/api/projects', () => HttpResponse.json([PROJECTS[0]])), http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, is_admin: true } })));
    mount();
    expect(await screen.findByRole('button', { name: /HOST MODE/ })).toBeInTheDocument();
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

  it('does not offer host execution to members', async () => {
    chat.activeSessionId = 'brain-1-a';
    server.use(http.get('*/api/projects', () => HttpResponse.json([...PROJECTS, { id: 3, slug: 'server', path: '/host', executionKind: 'host' }])));
    mount();
    const trigger = await screen.findByRole('button');
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await screen.findByRole('menuitemradio', { name: /kolin/ });
    expect(screen.queryByText('HOST MODE')).toBeNull();
    expect(screen.queryByText('server')).toBeNull();
  });

  it('requires confirmation for host mode and keeps the managed target after a refusal', async () => {
    chat.activeSessionId = 'brain-1-a'; chat.telemetry.projectRef = { kind: 'managed', projectId: 1 };
    let calls = 0;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, is_admin: true } })),
      http.post('*/api/brain/execution', () => { calls++; return HttpResponse.json({ error: 'conversation still has active work' }, { status: 409 }); }),
    );
    mount();
    const trigger = await screen.findByRole('button', { name: /kolin/ });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'HOST MODE' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(calls).toBe(0);
    fireEvent.click(confirm.getByRole('button', { name: 'Use host mode' }));
    await waitFor(() => expect(calls).toBe(1));
    expect(await confirm.findByText('conversation still has active work')).toBeInTheDocument();
  });
});
