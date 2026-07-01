import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { DashboardView } from '../../../modules/dashboard/DashboardView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const config = {
  models: [], customModels: [], hiddenPresets: [], modelNotes: {},
  autopilot: { model: '', overseerModel: '', apiUrl: '', apiKeySet: false, notes: '', prompt: '', pilotExec: 'claude:sonnet', overseerExec: '', reviewOnDone: true },
  providers: {}, defaults: { exec: 'claude:sonnet', autonomy: 'L3', maxSessions: 1 }, security: { tokenTtlDays: 30 },
};

const server = setupServer(
  http.get('*/api/tasks', () => HttpResponse.json([
    { id: 't1', title: 'Alpha', status: 'open' },
    { id: 't2', title: 'Beta', status: 'blocked' },
  ])),
  http.get('*/api/sessions', () => HttpResponse.json([{ name: 'orca-x', role: 'agent', agent: 'x' }])),
  http.get('*/api/missions', () => HttpResponse.json([{ id: 'm1', epic_id: 'e', autonomy: 'L3', max_sessions: 1, state: 'active' }])),
  http.get('*/api/config', () => HttpResponse.json(config)),
  http.get('*/api/projects', () => HttpResponse.json([{ id: 1, name: 'demo', path: '/tmp/demo' }])),
  http.get('*/api/usage/by-model', () => HttpResponse.json([
    { exec: 'sonnet', usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500, costUsd: 3.5 } },
  ])),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('DashboardView', () => {
  it('renders the airy overview: system-overview stat cards and the configuration row', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><DashboardView /></ToastProvider></Wrapper>);
    // System overview section + its stat labels.
    expect(await screen.findByText('System overview')).toBeTruthy();
    expect(screen.getByText('Projects')).toBeTruthy();
    expect(screen.getByText('Active missions')).toBeTruthy();
    expect(screen.getByText('Agents')).toBeTruthy();
    // Configuration row reflects the daemon config (autonomy + review-on-done) — awaited because the
    // pill values depend on the /config query resolving.
    expect(screen.getByText('Configuration')).toBeTruthy();
    expect(await screen.findByText('L3')).toBeTruthy();
  });

  it('renders the monthly usage card with the top model, tokens and cost', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><DashboardView /></ToastProvider></Wrapper>);
    expect(await screen.findByText('sonnet')).toBeTruthy();
    expect(screen.getByText('Top model')).toBeTruthy();
  });

  it('shows the needs-input banner when an agent is waiting', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['session-signals'], { 'orca-x': { type: 'needs_input', question: 'Proceed?' } });
    render(<Wrapper><ToastProvider><DashboardView /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(await screen.findByText('Proceed?')).toBeTruthy();
  });
});
