import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { en } from '../../../lib/i18n/dictionaries/en';

// SessionPicker reads the single chat controller via useBrainChat (activeSessionId + currentModel) — mock
// it so the picker is exercised in isolation against a controlled binding (no BrainChatProvider boot).
const ctx = vi.hoisted(() => ({ value: { activeSessionId: null as string | null, currentModel: '' } }));
vi.mock('../../../modules/advisor/BrainChatProvider', () => ({ useBrainChat: () => ctx.value }));

import { SessionPicker } from '../../../modules/advisor/SessionPicker';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const user = (is_admin: boolean) => ({ id: 1, username: 'u', name: '', email: '', avatar: '', default_exec: '', is_admin, allowed_execs: [], created_at: '2026-01-01' });
const meHandler = (is_admin: boolean) => http.get('*/api/auth/me', () => HttpResponse.json({ user: user(is_admin) }));
const noSessions = http.get('*/api/sessions', () => HttpResponse.json([]));

function renderPicker(ui: React.ReactElement, over: Partial<typeof ctx.value> = {}) {
  ctx.value = { activeSessionId: null, currentModel: '', ...over };
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider>{ui}</ToastProvider></Wrapper>);
}

describe('SessionPicker', () => {
  it('lists running sessions except the excluded ones and picks one on click', async () => {
    const onPick = vi.fn();
    server.use(meHandler(false), http.get('*/api/sessions', () => HttpResponse.json([
      { name: 'elowen-w1', role: 'agent', agent: 'w1' },
      { name: 'elowen-advisor-1', role: 'advisor', agent: 'advisor-1' },
    ])));
    renderPicker(<SessionPicker open onPick={onPick} onClose={vi.fn()} exclude={['elowen-advisor-1']} />);

    const row = await screen.findByRole('menuitem', { name: /w1/ });
    expect(screen.queryByRole('menuitem', { name: /advisor-1/ })).toBeNull();
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledWith('elowen-w1');
  });

  it('shows the empty state when every session is excluded', async () => {
    server.use(meHandler(false), http.get('*/api/sessions', () => HttpResponse.json([
      { name: 'elowen-w1', role: 'agent', agent: 'w1' },
    ])));
    renderPicker(<SessionPicker open onPick={vi.fn()} onClose={vi.fn()} exclude={['elowen-w1']} />);
    expect(await screen.findByText(/no running sessions|žádné běžící session/i)).toBeTruthy();
  });

  it('shows the admin-only Elowen CLI section with the open row (with an active conversation)', async () => {
    server.use(meHandler(true), noSessions);
    renderPicker(<SessionPicker open onPick={vi.fn()} onClose={vi.fn()} exclude={[]} />, { activeSessionId: 'sess-1', currentModel: 'claude-opus' });
    expect(await screen.findByText(en.advisor.sectionElowenCli)).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: new RegExp(en.advisor.elowenCliOpen) })).toBeInTheDocument();
    expect(screen.getByText('claude-opus')).toBeInTheDocument();
  });

  it('renders NO Elowen CLI nodes for a non-admin', async () => {
    server.use(meHandler(false), noSessions);
    renderPicker(<SessionPicker open onPick={vi.fn()} onClose={vi.fn()} exclude={[]} />, { activeSessionId: 'sess-1', currentModel: 'claude-opus' });
    // Wait for the (non-admin) session list heading so the me query has settled before asserting absence.
    expect(await screen.findByText(en.advisor.pickSession)).toBeInTheDocument();
    expect(screen.queryByText(en.advisor.sectionElowenCli)).toBeNull();
    expect(screen.queryByText(en.advisor.elowenCliOpen)).toBeNull();
    expect(screen.queryByText(en.advisor.sectionCliAgents)).toBeNull();
  });

  it('opens the brain terminal, then calls onPick(terminal) + onClose', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    let sentSession: string | null = null;
    server.use(
      meHandler(true),
      noSessions,
      http.post('*/api/brain/terminal', async ({ request }) => {
        sentSession = ((await request.json()) as { session: string }).session;
        return HttpResponse.json({ terminal: 'elowen-chat-1-abcd', created: true });
      }),
    );
    renderPicker(<SessionPicker open onPick={onPick} onClose={onClose} exclude={[]} />, { activeSessionId: 'sess-42', currentModel: '' });
    const row = await screen.findByRole('menuitem', { name: new RegExp(en.advisor.elowenCliOpen) });
    fireEvent.click(row);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith('elowen-chat-1-abcd'));
    expect(sentSession).toBe('sess-42');
    expect(onClose).toHaveBeenCalled();
  });

  it('disables the open row and shows the no-session hint when there is no active conversation', async () => {
    server.use(meHandler(true), noSessions);
    renderPicker(<SessionPicker open onPick={vi.fn()} onClose={vi.fn()} exclude={[]} />, { activeSessionId: null, currentModel: '' });
    expect(await screen.findByText(en.advisor.elowenCliNoSession)).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: new RegExp(en.advisor.elowenCliOpen) })).toBeNull();
  });
});
