import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { delay, http, HttpResponse } from 'msw';
import { DashboardView } from '../../../modules/dashboard/DashboardView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { EffectsProvider } from '../../../lib/useEffects';
import { en } from '../../../lib/i18n/dictionaries/en';
import { formatCost, formatTokens } from '../../../lib/format';
import { consumePendingBrainComposer } from '../../../lib/brainDock';

let activityCalls = 0;
let modelUsageCalls = 0;
let dayUsageCalls = 0;
let dayUsageDays: string | null = null;

const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', name: 'Filip Džudža', is_admin: true } })),
  http.get('*/api/activity', () => {
    activityCalls += 1;
    return HttpResponse.json([
      { id: 1, ts: '2026-06-30 12:00:00', last_ts: '2026-06-30 12:00:00', type: 'turn', target: 'brain-1', detail: '', surface: 'web', count: 2, actor_user_id: 1, actor_label: 'Filip', actor_username: 'admin' },
    ]);
  }),
  http.get('*/api/activity/presence', () => HttpResponse.json([
    { userId: 1, username: 'admin', label: 'Filip', working: true },
  ])),
  // The strip and the panels all divide this one payload: the strip reads `totals`, the pulse panel the
  // gauges, the metrics panel the `month` rollup. One handler keeps their numbers consistent.
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
    month: {
      from: '2026-06-01', days: 30, tokens: 400_000, cost: 12,
      surfaces: [{ surface: 'web', turns: 60, tokens: 400_000, cost: 12 }],
      context: { cacheRead: 300_000, input: 60_000, cacheWrite: 30_000, output: 10_000 },
    },
    totals: { turns: 2, tokens: 1500, cost: 3.5, activePeople: 1, runningAgents: 0, memoryHits: 12, cacheHitPct: 88 },
    yesterday: { people: 1, turns: 1, tokens: 800 },
    memoryByHour: Array.from({ length: 24 }, () => 0),
  })),
  http.get('*/api/health', () => HttpResponse.json({ ok: true, version: '0.28.11' })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([])),
  http.get('*/api/system/readiness', () => HttpResponse.json({ checks: [{ id: 'chat', label: 'Chat', ok: true, detail: 'ready' }] })),
  http.get('*/api/usage/by-model', () => { modelUsageCalls += 1; return HttpResponse.json([]); }),
  http.get('*/api/usage/by-day', ({ request }) => {
    dayUsageCalls += 1;
    dayUsageDays = new URL(request.url).searchParams.get('days');
    return HttpResponse.json([]);
  }),
);
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  consumePendingBrainComposer();
  activityCalls = 0;
  modelUsageCalls = 0;
  dayUsageCalls = 0;
  dayUsageDays = null;
});
afterAll(() => server.close());

function mount() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><EffectsProvider><ToastProvider><DashboardView /></ToastProvider></EffectsProvider></Wrapper>);
}

describe('DashboardView — first paint', () => {
  it('greets the signed-in person by first name, with the ask line beneath', async () => {
    mount();
    const heading = await screen.findByRole('heading', { level: 1 });
    // Time-of-day greeting + the account's real first name — never a hardcoded one.
    await waitFor(() => expect(heading.textContent).toMatch(/^(Good morning|Good afternoon|Good evening), Filip\./));
    expect(screen.getByText(en.dashboard.heroAsk)).toBeInTheDocument();
  });

  it('states today in the strip with real figures and mounts no panel', async () => {
    mount();
    const strip = screen.getByRole('list', { name: en.dashboard.stripLabel });
    await waitFor(() => expect(strip.textContent).toContain(formatTokens(1500)));
    expect(strip.textContent).toContain('2');
    expect(strip.textContent).toContain(formatCost(3.5, 2));
    // One person mid-turn → the working figure reads 1. textContent concatenates without whitespace.
    await waitFor(() => expect(strip.textContent).toContain(`1${en.dashboard.workingNow.toLowerCase()}`));

    // Layout contract: the strip stays a single scrollable row, and its band is set off from the app
    // bar by the shell rhythm instead of sitting glued to it.
    expect(strip.className).toContain('overflow-x-auto');
    expect(strip.className).toContain('whitespace-nowrap');
    expect(strip.parentElement?.className).toContain('pt-4');
    expect(strip.parentElement?.className).toContain('pb-3');

    // Progressive disclosure: none of the heavy surfaces exists before its button is pressed.
    expect(screen.queryByRole('region', { name: en.dashboard.eventStream })).toBeNull();
    expect(screen.queryByRole('region', { name: en.dashboard.pulse })).toBeNull();
    expect(screen.queryByRole('region', { name: en.dashboard.metricsTitle })).toBeNull();
    expect(screen.queryByTestId('pulse-rings')).toBeNull();
    expect(activityCalls).toBe(0);
    expect(modelUsageCalls).toBe(0);
    expect(dayUsageCalls).toBe(0);
    // The composer, however, is part of the hero itself.
    expect(screen.getByPlaceholderText(en.dashboard.composerPlaceholder)).toBeInTheDocument();
  });

  it('keeps the working count unknown until the pulse request resolves', () => {
    server.use(http.get('*/api/activity/pulse', async () => {
      await delay(100);
      return HttpResponse.json({ people: [], totals: { turns: 0, tokens: 0, cost: 0 } });
    }));
    mount();

    const strip = screen.getByRole('list', { name: en.dashboard.stripLabel });
    expect(strip.textContent).toContain(`—${en.dashboard.workingNow.toLowerCase()}`);
  });
});

describe('DashboardView — quick actions', () => {
  it('seeds the advisor composer through the existing compose channel', async () => {
    mount();
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getByRole('button', { name: en.dashboard.pillSummary }));
    expect(consumePendingBrainComposer()).toBe(en.dashboard.pillSummaryPrompt);
  });

  it('answers the costs pill with the metrics panel instead of a prompt', async () => {
    mount();
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getByRole('button', { name: en.dashboard.pillCosts }));
    expect(await screen.findByRole('region', { name: en.dashboard.metricsTitle })).toBeInTheDocument();
    expect(consumePendingBrainComposer()).toBeNull();
  });

  it('replaces one quick action with the setup route when chat is not ready', async () => {
    server.use(http.get('*/api/system/readiness', () => HttpResponse.json({
      checks: [{ id: 'chat', label: 'Chat', ok: false, detail: 'no provider' }],
    })));
    mount();

    expect(await screen.findByRole('link', { name: en.dashboard.finishSetup.cta })).toHaveAttribute('href', '/settings?cat=brain');
    expect(screen.queryByRole('button', { name: en.dashboard.pillCapabilities })).toBeNull();
  });
});

describe('DashboardView — disclosure panels', () => {
  it('starts panel-only requests only after their panel is revealed', async () => {
    mount();
    await screen.findByRole('heading', { level: 1 });
    expect(activityCalls).toBe(0);
    expect(modelUsageCalls).toBe(0);
    expect(dayUsageCalls).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: en.dashboard.showFeed }));
    await waitFor(() => expect(activityCalls).toBe(1));
    expect(modelUsageCalls).toBe(0);
    expect(dayUsageCalls).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: en.dashboard.showMetrics }));
    await waitFor(() => expect(modelUsageCalls).toBe(1));
    expect(dayUsageCalls).toBe(1);
    // The panel asks for the full thirty-day chart window in that single lazy request.
    expect(dayUsageDays).toBe('30');
  });

  it('opens at most one panel and reflects the state in aria-expanded', async () => {
    mount();
    await screen.findByRole('heading', { level: 1 });
    const feedButton = screen.getByRole('button', { name: en.dashboard.showFeed });
    const pulseButton = screen.getByRole('button', { name: en.dashboard.showPulse });

    fireEvent.click(feedButton);
    expect(await screen.findByRole('region', { name: en.dashboard.eventStream })).toBeInTheDocument();
    expect(feedButton).toHaveAttribute('aria-expanded', 'true');
    expect(pulseButton).toHaveAttribute('aria-expanded', 'false');

    // Opening the pulse REPLACES the feed — the panels are exclusive, not additive.
    fireEvent.click(pulseButton);
    expect(await screen.findByRole('region', { name: en.dashboard.pulse })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: en.dashboard.eventStream })).toBeNull();
    expect(pulseButton).toHaveAttribute('aria-expanded', 'true');
    expect(feedButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders the pulse panel with real gauge content', async () => {
    mount();
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getByRole('button', { name: en.dashboard.showPulse }));
    expect(await screen.findByText(en.dashboard.pulseActivePeople)).toBeInTheDocument();
  });

  it('moves focus into the opened panel and returns it to the trigger on Escape', async () => {
    mount();
    await screen.findByRole('heading', { level: 1 });
    const feedButton = screen.getByRole('button', { name: en.dashboard.showFeed });

    fireEvent.click(feedButton);
    const heading = await screen.findByRole('heading', { name: en.dashboard.eventStream });
    await waitFor(() => expect(document.activeElement).toBe(heading));

    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: en.dashboard.eventStream })).toBeNull();
    expect(document.activeElement).toBe(feedButton);
  });

  it('closes an open panel from its own close control', async () => {
    mount();
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getByRole('button', { name: en.dashboard.showMetrics }));
    await screen.findByRole('region', { name: en.dashboard.metricsTitle });
    fireEvent.click(screen.getByRole('button', { name: en.dashboard.closePanel }));
    expect(screen.queryByRole('region', { name: en.dashboard.metricsTitle })).toBeNull();
  });
});
