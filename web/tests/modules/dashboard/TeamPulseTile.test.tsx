import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { TeamPulseTile } from '../../../modules/dashboard/TeamPulseTile';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { PulsePerson, PulseResponse } from '../../../lib/types';

/** Today's headline gauges. The monthly ring charts moved to the metrics panel — their tests live in
 *  MetricsTile.test.tsx alongside them. */

const HOURS = 24;
const MONTH_DAYS = 30;
const today = new Date().toISOString().slice(0, 10);
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const hours = (hour: number, count: number): number[] =>
  Array.from({ length: HOURS }, (_, h) => (h === hour ? count : 0));

const month = (over: Partial<PulsePerson['month']> = {}): PulsePerson['month'] => ({
  turns: 300, tokens: 900_000, cost: 40, cacheHitPct: 90, memoryHits: 1200,
  surfaces: ['web'], days: Array<number>(MONTH_DAYS).fill(10), ...over,
});

const person = (over: Partial<PulsePerson> = {}): PulsePerson => ({
  userId: 1, label: 'Filip Džudža', username: 'filip', working: false, activeToday: true, title: '',
  lastTs: '2026-08-23 06:00:00', turns: 10, tokens: 5000, cost: 1.5,
  cacheHitPct: 92, memoryHits: 40, surfaces: ['web'], hoursToday: hours(9, 5),
  month: month(), ...over,
});

function mount(people: PulsePerson[], over: Partial<PulseResponse> = {}) {
  const sums = people.reduce(
    (a, p) => ({ turns: a.turns + p.turns, tokens: a.tokens + p.tokens, cost: p.cost === null ? a.cost : (a.cost ?? 0) + p.cost }),
    { turns: 0, tokens: 0, cost: null as number | null },
  );
  const body: PulseResponse = {
    today,
    month: {
      from: '2026-07-28', days: MONTH_DAYS,
      tokens: people.reduce((n, p) => n + p.month.tokens, 0),
      cost: 40,
      surfaces: [
        { surface: 'internal', turns: 200, tokens: 600_000, cost: 25 },
        { surface: 'cli', turns: 100, tokens: 300_000, cost: 15 },
      ],
      context: { cacheRead: 800_000, input: 60_000, cacheWrite: 30_000, output: 10_000 },
    },
    people,
    totals: {
      ...sums, activePeople: people.filter((p) => p.activeToday).length,
      runningAgents: 0, memoryHits: 40, cacheHitPct: 92,
    },
    yesterday: { people: 1, turns: 5, tokens: 2500 },
    memoryByHour: Array<number>(HOURS).fill(0),
    spendAvailable: true,
    ...over,
  };
  server.use(http.get('*/api/activity/pulse', () => HttpResponse.json(body)));
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><TeamPulseTile /></Wrapper>);
}

describe('TeamPulseTile — headline', () => {
  it('says so plainly when nobody has been around', async () => {
    mount([]);
    expect(await screen.findByText(en.dashboard.pulseNobody)).toBeInTheDocument();
  });

  it('says the rollup is missing rather than showing a confident zero', async () => {
    mount([person()], {
      spendAvailable: false,
      totals: { turns: 1, tokens: 100, cost: null, activePeople: 1, runningAgents: 0, memoryHits: 0, cacheHitPct: null },
    });
    expect(await screen.findByText(en.dashboard.pulseSpendOff)).toBeInTheDocument();
  });

  it('withholds a percentage when yesterday was empty', async () => {
    // A first active day has nothing to divide by; "+100 %" would be arithmetic on nothing.
    mount([person()], { yesterday: { people: 0, turns: 0, tokens: 0 } });
    expect(await screen.findByText(en.dashboard.pulseNoBaseline)).toBeInTheDocument();
  });

  it('counts running sub-agents separately from people', async () => {
    mount([person()], {
      totals: { turns: 1, tokens: 100, cost: 1, activePeople: 1, runningAgents: 3, memoryHits: 0, cacheHitPct: null },
    });

    const card = (await screen.findByText(en.dashboard.pulseRunningAgents)).closest('div')?.parentElement;
    expect(within(card!).getByText('3')).toBeInTheDocument();
    expect(within(card!).getByText(en.dashboard.pulseAgentsBusy)).toBeInTheDocument();
  });
});
