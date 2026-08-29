import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { DashboardView } from '../../../modules/dashboard/DashboardView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { EffectsProvider } from '../../../lib/useEffects';
import { en } from '../../../lib/i18n/dictionaries/en';
import { formatCost, formatTokens } from '../../../lib/format';

const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
  http.get('*/api/activity', () => HttpResponse.json([
    { id: 1, ts: '2026-06-30 12:00:00', last_ts: '2026-06-30 12:00:00', type: 'turn', target: 'brain-1', detail: '', surface: 'web', count: 2, actor_user_id: 1, actor_label: 'Filip', actor_username: 'admin' },
  ])),
  http.get('*/api/activity/presence', () => HttpResponse.json([
    { userId: 1, username: 'admin', label: 'Filip', working: true },
  ])),
  // The pulse tile draws its curves from /activity/pulse, which carries each person's hourly series.
  // Without this handler the tile renders empty and the assertions below fail for a reason that has
  // nothing to do with the dashboard.
  http.get('*/api/activity/pulse', () => HttpResponse.json({
    today: '2026-06-30', spendAvailable: true,
    people: [{
      userId: 1, label: 'Filip', username: 'admin', working: true, title: '',
      lastTs: '2026-06-30 12:00:00', turns: 2, tokens: 1500, cost: 3.5,
      cacheHitPct: 88, memoryHits: 12, surfaces: ['web'],
      hoursToday: Array.from({ length: 24 }, (_, h) => (h === 12 ? 2 : 0)),
      activeToday: true,
      month: {
        turns: 60, tokens: 400_000, cost: 12, cacheHitPct: 90, memoryHits: 300,
        surfaces: ['web'], days: Array.from({ length: 30 }, () => 2),
      },
    }],
    totals: { turns: 2, tokens: 1500, cost: 3.5, activePeople: 1, runningAgents: 0, memoryHits: 12, cacheHitPct: 88 },
    yesterday: { people: 1, turns: 1, tokens: 800 },
    memoryByHour: Array.from({ length: 24 }, () => 0),
  })),
  // The hero's own reads. Health decides presence (a failing probe greys the mascot to "Offline"),
  // the plugin listing gates the cron pod, and usage feeds the month figure.
  http.get('*/api/health', () => HttpResponse.json({ ok: true, version: '0.28.11' })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([])),
  http.get('*/api/usage/by-model', () => HttpResponse.json([])),
  http.get('*/api/usage/by-day', () => HttpResponse.json([])),
);
beforeAll(() => server.listen());
afterAll(() => server.close());

describe('DashboardView', () => {
  it('renders recent activity and team presence', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><ToastProvider><DashboardView /></ToastProvider></EffectsProvider></Wrapper>);
    expect(await screen.findByRole('region', { name: 'Activity' })).toBeInTheDocument();
    expect(await screen.findAllByText(/Filip/)).not.toHaveLength(0);
    expect(await screen.findByText(/working now: Filip/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Team pulse' })).toBeInTheDocument();
    // The pulse tile's own content, not just its heading. The ring is not asserted here: jsdom computes
    // no layout, so Recharts measures zero and renders nothing — see TeamPulseTile.test.tsx.
    expect(screen.getByText('Active users')).toBeInTheDocument();
  });

  // The hero was deleted wholesale with the agents/work cleanup, because two of its four pods read
  // that domain — and nothing failed, because nothing asserted it was there. This is that assertion.
  it('leads with the hero: the greeting, who is mid-turn, and the composer', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><ToastProvider><DashboardView /></ToastProvider></EffectsProvider></Wrapper>);

    // The greeting is time-of-day dependent, so the heading is asserted by role rather than by text.
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    // The hero states presence exactly ONCE — as the orbital field's accessible name. The count under the
    // greeting and the status row above the composer both said the same thing the tiles below already
    // report, so neither survives; asserting their absence is what keeps them from creeping back.
    expect(screen.queryByText(/working now: 1/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /Filip/ })).toBeNull();
    expect(screen.getByRole('img', { name: /Elowen: /i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/what can i do for you/i)).toBeInTheDocument();
  });

  /** Heading, then the divider rail — the same anatomy every other page opens with. The figures come from
   *  the pulse response the page already fetches for presence, so the rail costs no request of its own. */
  it('opens with the metric rail under the greeting', async () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><EffectsProvider><ToastProvider><DashboardView /></ToastProvider></EffectsProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1 });

    const rail = container.querySelector('[data-testid="workspace-hero-metrics"]')!;
    expect(rail).not.toBeNull();
    await waitFor(() => expect(rail.textContent).toContain(formatTokens(1500)));
    const readings = Array.from(rail.querySelectorAll('.workspace-metric')).map((metric) => [
      metric.querySelector('.workspace-metric__label')!.textContent,
      metric.querySelector('.workspace-metric__value')!.textContent,
    ]);
    expect(readings).toEqual([
      [en.dashboard.pulseColTurns, '2'],
      [en.dashboard.pulseColTokens, formatTokens(1500)],
      [en.dashboard.pulseColCost, formatCost(3.5, 2)],
      [en.dashboard.workingNow, '1'],
    ]);
  });
});
