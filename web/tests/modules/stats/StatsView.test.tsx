import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { StatsView } from '../../../modules/stats/StatsView';
import { createWrapper } from '../../test-utils';
import { EffectsProvider } from '../../../lib/useEffects';

let seenSearch = '';
const server = setupServer(
  http.get('*/api/usage/by-model', ({ request }) => {
    seenSearch = new URL(request.url).search;
    return HttpResponse.json([{ exec: 'sonnet', usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, costUsd: 1.5 } }]);
  }),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => { server.resetHandlers(); seenSearch = ''; localStorage.clear(); }); afterAll(() => server.close());

const renderStats = () => {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><EffectsProvider><StatsView /></EffectsProvider></Wrapper>);
};

describe('StatsView', () => {
  it('renders the date filter and the usage instrument from the default window', async () => {
    const { container } = renderStats();
    expect(await screen.findByText('sonnet')).toBeTruthy();
    expect(screen.getByTestId('spatial-workspace-layout')).toBeTruthy();
    expect(screen.queryByTestId('usage-flame')).toBeNull();
    expect(screen.getAllByRole('img', { name: 'Elowen' })).toHaveLength(1);
    expect(screen.queryByTestId('page-mascot')).toBeNull();
    expect(container.querySelectorAll('[data-control-surface]')).toHaveLength(1);
    // Default preset is '7d' — a finite from-bound is sent, no 'to' (open-ended).
    await waitFor(() => expect(seenSearch).toContain('from='));
    expect(seenSearch).not.toContain('to=');
  });

  it('changing the preset re-requests usage with a narrower window', async () => {
    renderStats();
    await screen.findByText('sonnet');
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => {
      const params = new URLSearchParams(seenSearch);
      expect(params.has('from')).toBe(true);
      expect(params.has('to')).toBe(true); // 'today' has both a start and end bound
    });
  });

  it('uses the shared compact data register while keeping both figures accessible', async () => {
    renderStats();

    const row = await screen.findByTestId('model-usage-row');
    const table = screen.getByRole('table', { name: 'Cost by model' });
    expect(table).toHaveClass('@container');
    expect(table.style.getPropertyValue('--data-table-compact-columns')).toBe('2rem minmax(0,1fr) auto');
    expect(row).toHaveClass('data-table-grid');
    expect(row).toHaveClass('interactive-row');
    expect(row.className).not.toContain('rounded-xl');
    expect(screen.getByLabelText('Total tokens: 150')).toBeTruthy();
    expect(screen.getByLabelText('Tracked cost: $1.5000')).toBeTruthy();
  });
});
