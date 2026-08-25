import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { TeamPulseTile } from '../../../modules/dashboard/TeamPulseTile';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { PulsePerson, PulseResponse } from '../../../lib/types';

/** The tile's rendered surface. The chart itself is not asserted here: jsdom computes no layout, so
 *  Recharts' ResponsiveContainer measures zero and draws nothing — the curve maths is covered by
 *  `pulseSeries.test.ts` instead, where it is plain arithmetic. */

const HOURS = 24;
const today = new Date().toISOString().slice(0, 10);
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const hours = (hour: number, count: number): number[] =>
  Array.from({ length: HOURS }, (_, h) => (h === hour ? count : 0));

const person = (over: Partial<PulsePerson> = {}): PulsePerson => ({
  userId: 1, label: 'Filip Džudža', username: 'filip', working: false, title: '',
  lastTs: '2026-08-23 06:00:00', turns: 10, tokens: 5000, cost: 1.5,
  cacheHitPct: 92, memoryHits: 40, surfaces: ['web'], hoursToday: hours(9, 5), ...over,
});

function mount(people: PulsePerson[], over: Partial<PulseResponse> = {}) {
  const sums = people.reduce(
    (a, p) => ({ turns: a.turns + p.turns, tokens: a.tokens + p.tokens, cost: p.cost === null ? a.cost : (a.cost ?? 0) + p.cost }),
    { turns: 0, tokens: 0, cost: null as number | null },
  );
  const body: PulseResponse = {
    today,
    people,
    totals: { ...sums, activePeople: people.length, runningAgents: 0, memoryHits: 40, cacheHitPct: 92 },
    yesterday: { people: 1, turns: 5, tokens: 2500 },
    memoryByHour: Array<number>(HOURS).fill(0),
    spendAvailable: true,
    ...over,
  };
  server.use(http.get('*/api/activity/pulse', () => HttpResponse.json(body)));
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><TeamPulseTile /></Wrapper>);
}

const rowFor = async (name: string) => (await screen.findByText(name)).closest('tr');

describe('TeamPulseTile — people', () => {
  it('shows what someone is working on while they are mid-turn', async () => {
    mount([person({ working: true, title: 'Tabulky na platformách' })]);

    const row = await rowFor('Filip Džudža');
    expect(within(row!).getByText('Tabulky na platformách')).toBeInTheDocument();
    expect(within(row!).getByText(en.dashboard.workingNow)).toBeInTheDocument();
  });

  it('does not dress up somebody merely seen today as working', async () => {
    mount([person({ working: false, title: 'stale title' })]);

    const row = await rowFor('Filip Džudža');
    // A title belongs to a live turn. Rendering the last one for an idle person would invent activity.
    expect(within(row!).queryByText('stale title')).not.toBeInTheDocument();
    expect(within(row!).getByText(en.dashboard.pulseSeen)).toBeInTheDocument();
  });

  it("reports today's spend and where the turns came from", async () => {
    mount([person({ tokens: 1_200_000, cost: 12.5, surfaces: ['web', 'discord'] })]);

    const row = await rowFor('Filip Džudža');
    expect(within(row!).getByText('1.2M')).toBeInTheDocument();
    expect(within(row!).getByText('$12.50')).toBeInTheDocument();
    // Surfaces are drawn with the shared PlatformIcon, which names each one in its title.
    expect(within(row!).getByTitle(/Web app/)).toBeInTheDocument();
  });

  it('says a turn was never priced instead of reporting it as free', async () => {
    // null cost means nobody priced the turn; showing $0.00 would understate a real bill.
    mount([person({ cost: null })]);

    const row = await rowFor('Filip Džudža');
    expect(within(row!).queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('leaves the cache column blank rather than claiming a cold zero', async () => {
    // Nobody ran a turn today, so there is no ratio. "0 %" would read as a catastrophic cache miss.
    mount([person({ cacheHitPct: null })]);

    const row = await rowFor('Filip Džudža');
    expect(within(row!).queryByText('0 %')).not.toBeInTheDocument();
  });

  it('reports each person\'s recalled memories', async () => {
    mount([person({ memoryHits: 1377 })]);

    const row = await rowFor('Filip Džudža');
    expect(within(row!).getByText('1,377')).toBeInTheDocument();
  });
});

describe('TeamPulseTile — headline', () => {
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

  it('says so plainly when nobody has been around', async () => {
    mount([]);
    expect(await screen.findByText(en.dashboard.pulseNobody)).toBeInTheDocument();
  });
});
