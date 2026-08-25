import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { DashboardView } from '../../../modules/dashboard/DashboardView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { EffectsProvider } from '../../../lib/useEffects';

const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
  http.get('*/api/activity', () => HttpResponse.json([
    { id: 1, ts: '2026-06-30 12:00:00', last_ts: '2026-06-30 12:00:00', type: 'turn', target: 'brain-1', detail: '', surface: 'web', count: 2, actor_user_id: 1, actor_label: 'Filip', actor_username: 'admin' },
  ])),
  http.get('*/api/activity/presence', () => HttpResponse.json([
    { userId: 1, username: 'admin', label: 'Filip', working: true },
  ])),
  // The tile draws its ridgeline from /activity/pulse, which carries the per-person rhythm the old
  // /activity/heatmap route used to serve instance-wide. Without this handler the tile renders empty
  // and the chart assertion below fails for a reason that has nothing to do with the dashboard.
  http.get('*/api/activity/pulse', () => HttpResponse.json({
    days: 14, today: '2026-06-30', spendAvailable: true,
    people: [{
      userId: 1, label: 'Filip', username: 'admin', working: true, title: '',
      lastTs: '2026-06-30 12:00:00', turns: 2, tokens: 1500, cost: 3.5,
      surfaces: ['web'], rhythm: [{ day: '2026-06-30', hour: 12, count: 2 }],
    }],
    totals: { turns: 2, tokens: 1500, cost: 3.5 },
  })),
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
    expect(screen.getByRole('img', { name: 'Activity by hour over the last two weeks' })).toBeInTheDocument();
  });
});
