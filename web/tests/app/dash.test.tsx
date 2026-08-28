import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import DashPage from '../../app/dash/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';
import { EffectsProvider } from '../../lib/useEffects';

const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
  http.get('*/api/activity', () => HttpResponse.json([])),
  http.get('*/api/activity/presence', () => HttpResponse.json([])),
  http.get('*/api/activity/heatmap', () => HttpResponse.json([])),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('DashPage', () => {
  it('renders the activity journal and team pulse', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><ToastProvider><DashPage /></ToastProvider></EffectsProvider></Wrapper>);
    expect(await screen.findByRole('region', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Team pulse' })).toBeInTheDocument();
    expect(await screen.findByText('No activity yet.')).toBeInTheDocument();
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
    render(<Wrapper><EffectsProvider><ToastProvider><DashPage /></ToastProvider></EffectsProvider></Wrapper>);

    expect(await screen.findByRole('region', { name: 'Team pulse' })).toBeInTheDocument();
    // The hero still draws its pods, falling back to zero turns rather than crashing.
    expect(await screen.findByTestId('hero-cosmos')).toBeInTheDocument();
    // …and the tile says it has nothing to show instead of half-rendering a broken payload.
    expect(screen.getByText('Nobody around yet')).toBeInTheDocument();
  });
});
