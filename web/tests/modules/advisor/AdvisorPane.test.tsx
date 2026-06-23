import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { AdvisorPane } from '../../../modules/advisor/AdvisorPane';

// xterm touches browser-only globals; the real terminal isn't under test here.
vi.mock('../../../components/terminal/StreamTerminal', () => ({
  StreamTerminal: ({ name }: { name: string }) => <div data-testid="stream">{name}</div>,
}));

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const meUser = { id: 1, username: 'admin', name: '', email: '', avatar: '', default_exec: '', is_admin: true, allowed_execs: [], created_at: '2026-01-01' };
const baseHandlers = [
  http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser })),
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], autopilot: {}, providers: {}, defaults: {} })),
];

function renderPane(ui: React.ReactElement) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider>{ui}</ToastProvider></Wrapper>);
}

describe('AdvisorPane', () => {
  it('renders the advisor terminal when running, with no remove control', async () => {
    server.use(
      ...baseHandlers,
      http.get('*/api/advisor/status', () => HttpResponse.json({ running: true, exec: 'sonnet', session: 'orca-advisor-1' })),
      http.get('*/api/sessions', () => HttpResponse.json([])),
    );
    renderPane(<AdvisorPane pane={{ id: 'advisor', kind: 'advisor' }} onRemove={vi.fn()} />);
    expect((await screen.findByTestId('stream')).textContent).toBe('orca-advisor-1');
    expect(screen.queryByRole('button', { name: /close panel|zavřít panel/i })).toBeNull();
  });

  it('renders a session terminal with a remove control that fires onRemove', async () => {
    const onRemove = vi.fn();
    server.use(
      ...baseHandlers,
      http.get('*/api/advisor/status', () => HttpResponse.json({ running: false, exec: '', session: null })),
      http.get('*/api/sessions', () => HttpResponse.json([{ name: 'orca-w1', role: 'agent', agent: 'w1' }])),
    );
    renderPane(<AdvisorPane pane={{ id: 'orca-w1', kind: 'session', name: 'orca-w1' }} onRemove={onRemove} />);
    expect((await screen.findByTestId('stream')).textContent).toBe('orca-w1');
    fireEvent.click(screen.getByRole('button', { name: /close panel|zavřít panel/i }));
    expect(onRemove).toHaveBeenCalled();
  });
});
