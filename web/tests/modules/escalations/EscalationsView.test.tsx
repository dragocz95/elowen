import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { EscalationsView } from '../../../modules/escalations/EscalationsView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

let patched: { id: string; body: unknown }[] = [];
let approvedGates: string[] = [];
let asksReplied: { taskId: string; askId: string; text: string }[] = [];
const server = setupServer(
  http.patch('*/api/tasks/:id', async ({ params, request }) => { patched.push({ id: String(params.id), body: await request.json() }); return HttpResponse.json({ ok: true }); }),
  http.post('*/api/tasks/:id/approve-gate', ({ params }) => { approvedGates.push(String(params.id)); return HttpResponse.json({ released: ['p2'] }); }),
  http.patch('*/api/missions/:id', () => HttpResponse.json({ ok: true })),
  http.get('*/api/asks/pending', () => HttpResponse.json([])),
  http.post('*/api/tasks/:taskId/ask/:askId/reply', async ({ params, request }) => { asksReplied.push({ taskId: String(params.taskId), askId: String(params.askId), text: (await request.json() as { text: string }).text }); return HttpResponse.json({ ok: true }); }),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => { server.resetHandlers(); patched = []; approvedGates = []; asksReplied = []; }); afterAll(() => server.close());

function seed(client: ReturnType<typeof createWrapper>['client']) {
  client.setQueryData(['activity', 'review'], [
    { id: 2, ts: '2026-06-22 10:00:00', type: 'review', target: 'p1', detail: 'escalated: summary claims a fix that is not in the diff', project_id: 1, label: 'Audit docs' },
  ]);
  client.setQueryData(['tasks'], [
    { id: 'p1', title: 'Audit docs', status: 'closed', parent_id: 'epic1' },
    { id: 'p2', title: 'Fix auth', status: 'blocked', parent_id: 'epic1' },
  ]);
  client.setQueryData(['tasks', 'deps'], [{ task_id: 'p2', depends_on_id: 'p1' }]);
  client.setQueryData(['pending-asks'], []);
}

describe('EscalationsView', () => {
  it('uses one spatial workspace hero and one bordered escalation register', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    seed(client);
    const { container } = render(<Wrapper><ToastProvider><EscalationsView /></ToastProvider></Wrapper>);

    expect(screen.getByTestId('spatial-workspace-layout')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Elowen' })).toHaveLength(1);
    expect(container.querySelectorAll('[data-control-surface]')).toHaveLength(1);
    expect(container.querySelector('.escalation-register-row')?.closest('.control-surface-register')).toBeInTheDocument();
    expect(container.querySelector('.escalation-register-row')).toHaveClass('px-4');
  });

  it('shows the overseer rationale, the rejected phase and the blocked dependent', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    seed(client);
    render(<Wrapper><ToastProvider><EscalationsView /></ToastProvider></Wrapper>);
    expect(screen.getByText('Audit docs')).toBeTruthy();
    expect(screen.getByText(/summary claims a fix that is not in the diff/)).toBeTruthy();
    expect(screen.getByText('Fix auth')).toBeTruthy(); // the blocked dependent
  });

  it('re-run re-opens the rejected phase', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    seed(client);
    render(<Wrapper><ToastProvider><EscalationsView /></ToastProvider></Wrapper>);
    fireEvent.click(screen.getByText('Re-run phase'));
    await waitFor(() => expect(patched.some((p) => p.id === 'p1' && (p.body as { status?: string }).status === 'open')).toBe(true));
  });

  it('approve releases the gate through the daemon (which re-opens only non-still-gated dependents)', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    seed(client);
    render(<Wrapper><ToastProvider><EscalationsView /></ToastProvider></Wrapper>);
    fireEvent.click(screen.getByText('Approve & continue'));
    // The view delegates to POST /tasks/p1/approve-gate (the escalated phase) instead of blindly
    // PATCHing dependents to 'open' — so a dependent gated by another predecessor isn't force-started.
    await waitFor(() => expect(approvedGates).toContain('p1'));
    expect(patched.some((p) => p.id === 'p2')).toBe(false);
  });

  it('renders a parked agent question and sends a human reply that unblocks it', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['activity', 'review'], []);
    client.setQueryData(['tasks'], []);
    client.setQueryData(['tasks', 'deps'], []);
    client.setQueryData(['pending-asks'], [
      { askId: 'ask1', taskId: 'tA', question: 'Postgres or SQLite?', since: 0, title: 'Wire the store', epicId: 'epicX', projectId: 1 },
    ]);
    render(<Wrapper><ToastProvider><EscalationsView /></ToastProvider></Wrapper>);
    expect(screen.getByText('Postgres or SQLite?')).toBeTruthy();
    expect(screen.getByText('Agent is asking · Wire the store')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Type a reply for the agent…'), { target: { value: 'SQLite' } });
    fireEvent.click(screen.getByText('Send reply'));
    await waitFor(() => expect(asksReplied).toEqual([{ taskId: 'tA', askId: 'ask1', text: 'SQLite' }]));
  });

  it('renders an empty state when nothing is escalated', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['activity', 'review'], []);
    client.setQueryData(['tasks'], []);
    client.setQueryData(['tasks', 'deps'], []);
    render(<Wrapper><ToastProvider><EscalationsView /></ToastProvider></Wrapper>);
    expect(screen.getByText('No escalations')).toBeTruthy();
  });
});
