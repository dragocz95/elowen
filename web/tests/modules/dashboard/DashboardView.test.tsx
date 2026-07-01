import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { DashboardView } from '../../../modules/dashboard/DashboardView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const EVENTS = [
  { id: 3, ts: '2026-06-30 12:00:00', type: 'review', target: 't1', detail: 'approved: ok', project_id: 1, label: 'Ship it' },
  { id: 2, ts: '2026-06-30 11:59:00', type: 'task', target: 't1', detail: 'closed', project_id: 1, label: 'Build the thing' },
  { id: 1, ts: '2026-06-30 11:58:00', type: 'mission', target: 'm-e', detail: 'active', project_id: 1, label: 'My mission' },
];

const server = setupServer(
  http.get('*/api/tasks', () => HttpResponse.json([{ id: 't1', title: 'Alpha', status: 'open' }])),
  http.get('*/api/tasks/deps', () => HttpResponse.json([])),
  http.get('*/api/sessions', () => HttpResponse.json([{ name: 'orca-Iris', role: 'agent', agent: 'iris' }])),
  http.get('*/api/sessions/:name/pane', () => HttpResponse.json({ pane: '' })),
  http.get('*/api/missions', () => HttpResponse.json([])),
  http.get('*/api/asks/pending', () => HttpResponse.json([])),
  http.get('*/api/activity', ({ request }) => {
    const type = new URL(request.url).searchParams.get('type');
    return HttpResponse.json(type ? [] : EVENTS);
  }),
  http.get('*/api/usage/by-model', () => HttpResponse.json([
    { exec: 'sonnet', usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500, costUsd: 3.5 } },
  ])),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('DashboardView', () => {
  it('renders the living dashboard: signal labels, the agent constellation, live missions and the event stream', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['session-signals'], { 'orca-Iris': { type: 'working' } });
    render(<Wrapper><ToastProvider><DashboardView /></ToastProvider></Wrapper>);

    // The three headline signals.
    expect(await screen.findByText('Agents active')).toBeTruthy();
    expect(screen.getByText('Decisions waiting')).toBeTruthy();
    expect(screen.getByText('Cost (month)')).toBeTruthy();

    // The constellation shows the live agent by its friendly name.
    expect(await screen.findByText('Iris')).toBeTruthy();
    expect(screen.getByText('Agent map')).toBeTruthy();

    // Live missions (empty) + the event stream heading and a formatted event sentence.
    expect(screen.getByText('Live missions')).toBeTruthy();
    expect(screen.getByText('Activity')).toBeTruthy();
    expect(await screen.findByText('Approved')).toBeTruthy();
    expect(screen.getByText('Build the thing')).toBeTruthy();
  });

  it('shows the needs-input banner when an agent is waiting', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['session-signals'], { 'orca-Iris': { type: 'needs_input', question: 'Proceed?' } });
    render(<Wrapper><ToastProvider><DashboardView /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(await screen.findByText('Proceed?')).toBeTruthy();
  });
});
