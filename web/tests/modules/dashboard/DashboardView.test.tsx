import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { DashboardView } from '../../../modules/dashboard/DashboardView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const server = setupServer(
  http.get('*/tasks', () => HttpResponse.json([
    { id: 't1', title: 'Alpha', status: 'open' },
    { id: 't2', title: 'Beta', status: 'blocked' },
  ])),
  http.get('*/sessions', () => HttpResponse.json([{ name: 'orca-x', role: 'agent', agent: 'x' }])),
  http.get('*/missions', () => HttpResponse.json([{ id: 'm1', epic_id: 'e', autonomy: 'low', max_sessions: 1, state: 'active' }])),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('DashboardView', () => {
  it('renders metric cards and a task row with a status badge', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><DashboardView /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Alpha')).toBeTruthy();
    // metric labels present
    expect(screen.getAllByText(/Open/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Blocked/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Live sessions/i)).toBeTruthy();
    expect(screen.getByText(/Active missions/i)).toBeTruthy();
  });

  it('shows the needs-input banner when an agent is waiting', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['session-signals'], { 'orca-x': { type: 'needs_input', question: 'Proceed?' } });
    render(<Wrapper><ToastProvider><DashboardView /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(await screen.findByText('Proceed?')).toBeTruthy();
  });
});
