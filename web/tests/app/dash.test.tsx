import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { DashPageBody } from '../../app/dash/DashPageBody';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';
import { EffectsProvider } from '../../lib/useEffects';
import { en } from '../../lib/i18n/dictionaries/en';

const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
  http.get('*/api/activity', () => HttpResponse.json([])),
  http.get('*/api/activity/presence', () => HttpResponse.json([])),
  http.get('*/api/activity/heatmap', () => HttpResponse.json([])),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('DashPage — the /dash route body', () => {
  it('opens on the hero with the metric strip and no mounted panel', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><ToastProvider><DashPageBody recapSeed={null} /></ToastProvider></EffectsProvider></Wrapper>);
    const heading = await screen.findByRole('heading', { level: 1 });
    const strip = screen.getByRole('list', { name: en.dashboard.stripLabel });
    expect(heading).toBeInTheDocument();
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveStyle({ scrollbarWidth: 'none' });
    expect(strip).toHaveClass('[&::-webkit-scrollbar]:hidden');
    expect(strip.parentElement).toHaveClass('px-4', 'md:px-0');
    expect(heading.closest('section')).toHaveClass('px-4', 'pt-10', 'sm:px-0', 'sm:pt-[clamp(3.5rem,13dvh,9rem)]');
    // The panels are progressive disclosure — none of them exists on first paint.
    expect(screen.queryByRole('region', { name: en.dashboard.eventStream })).toBeNull();
    expect(screen.queryByRole('region', { name: en.dashboard.pulse })).toBeNull();
  });

  // A pulse payload without `totals` used to throw out of the hero and take the entire route with it.
  // The route has to survive a section the response did not carry.
  it('renders when the pulse payload is missing its totals', async () => {
    server.use(
      http.get('*/api/activity/pulse', () => HttpResponse.json({
        today: '2026-01-01',
        people: [{ id: 1, name: 'Admin', working: true, activeToday: true, hoursToday: [], title: '' }],
        yesterday: { people: 0, turns: 0, tokens: 0 },
        memoryByHour: [],
        spendAvailable: true,
      })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><ToastProvider><DashPageBody recapSeed={null} /></ToastProvider></EffectsProvider></Wrapper>);

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    // The strip falls back to placeholders rather than crashing on the absent rollup.
    expect(screen.getByRole('list', { name: en.dashboard.stripLabel })).toBeInTheDocument();
  });
});
