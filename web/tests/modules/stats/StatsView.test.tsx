import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { StatsView } from '../../../modules/stats/StatsView';
import { createWrapper } from '../../test-utils';

let seenSearch = '';
const server = setupServer(
  http.get('*/api/usage/by-model', ({ request }) => {
    seenSearch = new URL(request.url).search;
    return HttpResponse.json([{ exec: 'sonnet', usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, costUsd: 1.5 } }]);
  }),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => { server.resetHandlers(); seenSearch = ''; }); afterAll(() => server.close());

describe('StatsView', () => {
  it('renders the date filter and the usage cards from the default window', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><StatsView /></Wrapper>);
    expect(await screen.findByText('sonnet')).toBeTruthy();
    // Default preset is '7d' — a finite from-bound is sent, no 'to' (open-ended).
    await waitFor(() => expect(seenSearch).toContain('from='));
    expect(seenSearch).not.toContain('to=');
  });

  it('changing the preset re-requests usage with a narrower window', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><StatsView /></Wrapper>);
    await screen.findByText('sonnet');
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => {
      const params = new URLSearchParams(seenSearch);
      expect(params.has('from')).toBe(true);
      expect(params.has('to')).toBe(true); // 'today' has both a start and end bound
    });
  });

  it('uses a compact responsive model row while keeping both figures accessible', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><StatsView /></Wrapper>);

    const row = await screen.findByTestId('model-usage-row');
    expect(row.className).toContain('grid-cols-[auto_minmax(0,1fr)_auto]');
    expect(row.className).toContain('@lg:grid-cols-');
    expect(screen.getByLabelText('Total tokens: 150')).toBeTruthy();
    expect(screen.getByLabelText('Total cost: $1.5000')).toBeTruthy();
  });
});
