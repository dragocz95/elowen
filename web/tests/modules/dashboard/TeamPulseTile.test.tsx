import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { TeamPulseTile } from '../../../modules/dashboard/TeamPulseTile';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { PulsePerson, PulseResponse } from '../../../lib/types';

const today = new Date().toISOString().slice(0, 10);
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const person = (over: Partial<PulsePerson> = {}): PulsePerson => ({
  userId: 1, label: 'Filip Džudža', username: 'filip', working: false, title: '',
  lastTs: '2026-08-23 06:00:00', turns: 10, tokens: 5000, cost: 1.5,
  surfaces: ['web'], rhythm: [{ day: today, hour: 9, count: 5 }], ...over,
});

function mount(people: PulsePerson[], over: Partial<PulseResponse> = {}) {
  const totals = people.reduce(
    (a, p) => ({ turns: a.turns + p.turns, tokens: a.tokens + p.tokens, cost: p.cost === null ? a.cost : (a.cost ?? 0) + p.cost }),
    { turns: 0, tokens: 0, cost: null as number | null },
  );
  const body: PulseResponse = { days: 14, today, people, totals, spendAvailable: true, ...over };
  server.use(http.get('*/api/activity/pulse', () => HttpResponse.json(body)));
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><TeamPulseTile /></Wrapper>);
}

describe('TeamPulseTile — ridgeline', () => {
  it('draws one layer per person', async () => {
    mount([person(), person({ userId: 2, label: 'Michal', username: 'michal' })]);
    const chart = await screen.findByRole('img', { name: en.dashboard.pulseAria });

    // Two people, two layers, each drawn as a filled area plus its outline.
    expect(chart.querySelectorAll('g')).toHaveLength(2);
  });

  it('normalises each layer against that person\'s own peak, not the instance total', async () => {
    // Michal does a fraction of Filip's volume. Against a shared maximum his layer would flatten into
    // a straight line and the tile would claim he never works, which is the failure this guards.
    mount([
      person({ rhythm: [{ day: today, hour: 9, count: 500 }] }),
      person({ userId: 2, label: 'Michal', username: 'michal', tokens: 10, rhythm: [{ day: today, hour: 14, count: 2 }] }),
    ]);
    const chart = await screen.findByRole('img', { name: en.dashboard.pulseAria });

    // Each layer opens at its own baseline ("M 0 <baseline>") and rises to its busiest hour. Measuring
    // baseline-minus-peak gives the amplitude, which must be the SAME for both: that is what per-person
    // normalisation means. Under a shared maximum Michal's 2 turns against Filip's 500 would come out
    // near zero and his layer would be a flat line.
    const amplitudes = [...chart.querySelectorAll('g')].map((g) => {
      const d = g.querySelector('path')?.getAttribute('d') ?? '';
      const baseline = Number(/^M 0 ([\d.]+)/.exec(d)?.[1]);
      const ys = [...d.matchAll(/\d[\d.]* ([\d.]+)/g)].map((m) => Number(m[1]));
      return Number((baseline - Math.min(...ys)).toFixed(2));
    });
    expect(amplitudes).toHaveLength(2);
    expect(amplitudes[0]).toBeGreaterThan(0);
    expect(amplitudes[1]).toBeCloseTo(amplitudes[0]!, 2);
  });
});

describe('TeamPulseTile — people', () => {
  it('shows what someone is working on while they are mid-turn', async () => {
    mount([person({ working: true, title: 'Tabulky na platformách' })]);

    const row = (await screen.findByText('Filip Džudža')).closest('li');
    expect(within(row!).getByText('Tabulky na platformách')).toBeInTheDocument();
    expect(within(row!).getByText(en.dashboard.workingNow)).toBeInTheDocument();
  });

  it('does not dress up somebody merely seen today as working', async () => {
    mount([person({ working: false, title: 'stale title' })]);

    const row = (await screen.findByText('Filip Džudža')).closest('li');
    // A title belongs to a live turn. Rendering the last one for an idle person would invent activity.
    expect(within(row!).queryByText('stale title')).not.toBeInTheDocument();
    expect(within(row!).getByText(en.dashboard.pulseSeen)).toBeInTheDocument();
  });

  it('reports today\'s spend and where the turns came from', async () => {
    mount([person({ tokens: 1_200_000, cost: 12.5, surfaces: ['web', 'discord'] })]);

    const row = (await screen.findByText('Filip Džudža')).closest('li');
    expect(within(row!).getByText('1.2M')).toBeInTheDocument();
    expect(within(row!).getByText('$12.50')).toBeInTheDocument();
    // Surfaces are drawn with the shared PlatformIcon, which names each one in its title.
    expect(within(row!).getByTitle('Web app')).toBeInTheDocument();
    expect(within(row!).getByTitle('Discord')).toBeInTheDocument();
  });

  it('says a turn was never priced instead of reporting it as free', async () => {
    // null cost means nobody priced the turn; showing $0.00 would understate a real bill.
    mount([person({ cost: null })]);

    const row = (await screen.findByText('Filip Džudža')).closest('li');
    expect(within(row!).getByText(en.dashboard.pulseUnpriced)).toBeInTheDocument();
    expect(within(row!).queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('says the rollup is missing rather than showing a confident zero', async () => {
    mount([person()], { spendAvailable: false, totals: { turns: 1, tokens: 100, cost: null } });
    expect(await screen.findByText(en.dashboard.pulseSpendOff)).toBeInTheDocument();
  });

  it('says so plainly when nobody has been around', async () => {
    mount([]);
    expect(await screen.findByText(en.dashboard.pulseNobody)).toBeInTheDocument();
  });
});
