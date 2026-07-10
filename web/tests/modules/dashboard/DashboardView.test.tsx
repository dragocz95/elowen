import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { DashboardView } from '../../../modules/dashboard/DashboardView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { EffectsProvider } from '../../../lib/useEffects';

const EVENTS = [
  { id: 3, ts: '2026-06-30 12:00:00', type: 'review', target: 't1', detail: 'approved: ok', project_id: 1, label: 'Ship it' },
  { id: 2, ts: '2026-06-30 11:59:00', type: 'task', target: 't1', detail: 'closed', project_id: 1, label: 'Build the thing' },
];

/** Configurable per test: which sessions + tasks the daemon reports. */
function server(opts: { sessions?: unknown[]; tasks?: unknown[]; jobs?: unknown[] } = {}) {
  return setupServer(
    http.get('*/api/health', () => HttpResponse.json({ ok: true, version: '0.26.0' })),
    http.get('*/api/tasks', () => HttpResponse.json(opts.tasks ?? [{ id: 't1', title: 'Alpha', status: 'in_progress', labels: ['agent:Iris'] }])),
    http.get('*/api/tasks/deps', () => HttpResponse.json([])),
    http.get('*/api/sessions', () => HttpResponse.json(opts.sessions ?? [{ name: 'elowen-Iris', role: 'agent', agent: 'iris' }])),
    http.get('*/api/sessions/:name/pane', () => HttpResponse.json({ pane: '' })),
    http.get('*/api/missions', () => HttpResponse.json([])),
    http.get('*/api/auth/me', () => HttpResponse.json({ user: { is_admin: false } })),
    http.get('*/api/asks/pending', () => HttpResponse.json([])),
    http.get('*/api/activity', ({ request }) => {
      const type = new URL(request.url).searchParams.get('type');
      return HttpResponse.json(type ? [] : EVENTS);
    }),
    http.get('*/api/usage/by-model', () => HttpResponse.json([
      { exec: 'sonnet', usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500, costUsd: 3.5 } },
    ])),
    http.get('*/api/usage/by-day', () => HttpResponse.json([{ day: '2026-06-30', tokens: 1500, cost: 3.5 }])),
    http.get('*/api/plugins/cronjob/jobs', () => HttpResponse.json(opts.jobs ?? [])),
  );
}

describe('DashboardView', () => {
  const srv = server();
  beforeAll(() => srv.listen({ onUnhandledRequest })); afterEach(() => srv.resetHandlers()); afterAll(() => srv.close());

  it('renders the daily journal and attention rail with live agent work in the hero', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['session-signals'], { 'elowen-Iris': { type: 'working' } });
    render(<Wrapper><EffectsProvider><ToastProvider><DashboardView /></ToastProvider></EffectsProvider></Wrapper>);

    // Tile labels.
    expect(await screen.findByText('Right now')).toBeTruthy();
    expect(screen.getByText('Decisions waiting')).toBeTruthy();
    expect(screen.getByText('This month')).toBeTruthy();
    expect(screen.getByText('Agents active')).toBeTruthy();
    expect(screen.getByText('Next run')).toBeTruthy();
    expect(screen.getByText('Activity')).toBeTruthy();
    expect(screen.getByText("Today's tasks")).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Activity' })).toBeTruthy();
    expect(screen.getByRole('region', { name: "Today's tasks" })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Attention' })).toBeTruthy();

    // The task the agent is on shows both in the hero and in today's tasks; the hero attributes it.
    expect((await screen.findAllByText('Alpha')).length).toBeGreaterThan(0);
    expect(screen.getByText('Agent Iris')).toBeTruthy();

    // Activity feed renders a formatted event sentence; no scheduled jobs.
    expect(await screen.findByText('Build the thing')).toBeTruthy();
    expect(screen.getByText('No scheduled jobs')).toBeTruthy();
  });

  it('shows the resting hero when no agent is running', async () => {
    srv.use(http.get('*/api/sessions', () => HttpResponse.json([])));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><ToastProvider><DashboardView /></ToastProvider></EffectsProvider></Wrapper>);
    expect(await screen.findByText('Elowen is resting')).toBeTruthy();
  });

  it('shows the needs-input banner when an agent is waiting', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['session-signals'], { 'elowen-Iris': { type: 'needs_input', question: 'Proceed?' } });
    render(<Wrapper><EffectsProvider><ToastProvider><DashboardView /></ToastProvider></EffectsProvider></Wrapper>);
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(await screen.findByText('Proceed?')).toBeTruthy();
  });

  it('does not present cached sessions as working while the daemon is offline', async () => {
    srv.use(http.get('*/api/health', () => HttpResponse.json({ ok: false }, { status: 503 })));
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['session-signals'], { 'elowen-Iris': { type: 'working' } });
    render(<Wrapper><EffectsProvider><ToastProvider><DashboardView /></ToastProvider></EffectsProvider></Wrapper>);
    expect(await screen.findAllByText('Offline')).not.toHaveLength(0);
    expect(screen.queryByText('Agent Iris')).toBeNull();
    expect(screen.queryByText('Agents working: 1')).toBeNull();
  });
});
