import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { TimelineView } from '../../../modules/timeline/TimelineView';
import { createWrapper } from '../../test-utils';

// Recent timestamps (relative to now) so events land inside the 12h window
// regardless of when the suite runs. Includes a flood of identical signals.
function fixture() {
  const now = Date.now();
  const min = 60 * 1000;
  const flood = Array.from({ length: 4 }, (_, i) => ({
    id: 10 + i,
    ts: new Date(now - 30 * min + i * 5_000).toISOString(),
    type: 'signal',
    target: 'agent-1',
    detail: 'working',
  }));
  return [
    { id: 3, ts: new Date(now - 5 * min).toISOString(), type: 'task', target: 'orca-x', detail: 'closed' },
    { id: 2, ts: new Date(now - 20 * min).toISOString(), type: 'mission', target: 'm1', detail: 'active' },
    ...flood,
  ];
}

const server = setupServer(http.get('*/activity', () => HttpResponse.json(fixture())));
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('TimelineView', () => {
  it('renders the activity feed rows', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><TimelineView /></Wrapper>);
    const feed = within(await screen.findByTestId('activity-feed'));
    expect(feed.getByText('orca-x')).toBeTruthy();
    expect(feed.getByText('m1')).toBeTruthy();
  });

  it('renders the timeline track tick labels', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><TimelineView /></Wrapper>);
    await screen.findByTestId('activity-feed');
    // Window auto-sizes to the data span (fixture events ~30 min old → short window).
    const ticks = screen.getAllByTestId('axis-tick');
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    for (const tick of ticks) {
      expect(tick.textContent).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it('renders markers for events in the window', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><TimelineView /></Wrapper>);
    await screen.findByTestId('activity-feed');
    const dots = screen.getAllByTestId('axis-dot');
    expect(dots.length).toBeGreaterThanOrEqual(1);
  });

  it('collapses the signal flood into a single counted entry', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><TimelineView /></Wrapper>);
    const feed = within(await screen.findByTestId('activity-feed'));
    // 4 identical "working" signals collapse → one "agent-1" feed row + ×4 badge
    expect(feed.getAllByText('agent-1')).toHaveLength(1);
    expect(feed.getByText('×4')).toBeTruthy();
  });
});
