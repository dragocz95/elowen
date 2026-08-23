import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { TeamPulseTile } from '../../../modules/dashboard/TeamPulseTile';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { HeatmapBucket, PresenceEntry } from '../../../lib/types';

const today = new Date().toISOString().slice(0, 10);
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

function mount(buckets: HeatmapBucket[], people: PresenceEntry[] = []) {
  server.use(http.get('*/api/activity/heatmap', () => HttpResponse.json(buckets)));
  server.use(http.get('*/api/activity/presence', () => HttpResponse.json(people)));
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><TeamPulseTile /></Wrapper>);
}

describe('TeamPulseTile — heatmap', () => {
  it('draws a cell for every hour of the last fourteen days', async () => {
    mount([{ day: today, hour: 9, count: 5 }]);
    const grid = await screen.findByRole('img', { name: en.dashboard.pulseAria });

    // The grid's shape is what makes the quiet hours readable, so empty hours are drawn, not omitted.
    expect(grid.querySelectorAll('span')).toHaveLength(14 * 24);
  });

  it('scales intensity against the busiest hour rather than an absolute number', async () => {
    mount([{ day: today, hour: 9, count: 100 }, { day: today, hour: 10, count: 1 }]);
    const grid = await screen.findByRole('img', { name: en.dashboard.pulseAria });

    const peak = grid.querySelector(`[title*="${today} 09:00"]`);
    const quiet = grid.querySelector(`[title*="${today} 10:00"]`);
    const empty = grid.querySelector(`[title*="${today} 11:00"]`);
    expect(peak?.className).toContain('bg-accent/90');
    // An ordinary hour must still be visible next to a peak one -- and distinguishable from no data.
    expect(quiet?.className).toContain('bg-accent/20');
    expect(empty?.className).not.toContain('bg-accent');
  });

  it('reports the total so the tile says something even before anyone reads the grid', async () => {
    mount([{ day: today, hour: 9, count: 7 }, { day: today, hour: 10, count: 3 }]);
    expect(await screen.findByText('10 turns / 14 days')).toBeInTheDocument();
  });
});

describe('TeamPulseTile — presence rail', () => {
  const person = (over: Partial<PresenceEntry>): PresenceEntry =>
    ({ userId: 1, label: 'Filip Džudža', working: false, lastTs: '2026-08-23 06:00:00', ...over });

  it('shows initials and marks who is mid-turn', async () => {
    mount([], [person({ working: true }), person({ userId: 2, label: 'Michal', working: false })]);

    const rail = (await screen.findByText('Filip Džudža')).closest('li');
    expect(within(rail!).getByText('FD')).toBeInTheDocument();
    expect(rail?.className).toContain('border-accent/50');
    // Somebody merely seen today must not be dressed up as working.
    expect(screen.getByText('Michal').closest('li')?.className).not.toContain('border-accent/50');
    expect(screen.getByText('M')).toBeInTheDocument();
  });

  it('says so plainly when nobody has been around', async () => {
    mount([], []);
    expect(await screen.findByText(en.dashboard.pulseNobody)).toBeInTheDocument();
  });
});
