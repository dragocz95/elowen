import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
afterAll(() => server.close());

describe('DashPage', () => {
  it('renders the activity journal and team pulse', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><ToastProvider><DashPage /></ToastProvider></EffectsProvider></Wrapper>);
    expect(await screen.findByRole('region', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Team pulse' })).toBeInTheDocument();
    expect(await screen.findByText('No activity yet.')).toBeInTheDocument();
  });
});
