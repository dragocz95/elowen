import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { UserStatsInline } from '../../../modules/users/UserStatsInline';
import { createWrapper } from '../../test-utils';
import type { UserStats } from '../../../lib/types';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

function mountWith(stats: UserStats) {
  server.use(http.get('*/api/users/1/stats', () => HttpResponse.json(stats)));
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><UserStatsInline userId={1} /></Wrapper>);
}

describe('UserStatsInline', () => {
  it('shows counts and the most-used model for a populated user', async () => {
    mountWith({ memoryCount: 12, sessionCount: 5, topModel: 'anthropic/claude-opus-4-8' });
    expect(await screen.findByText('12')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('anthropic/claude-opus-4-8')).toBeTruthy();
  });

  it('renders explicit empty states for a fresh user (never a bare 0)', async () => {
    mountWith({ memoryCount: 0, sessionCount: 0, topModel: null });
    expect(await screen.findByText('No memories')).toBeTruthy();
    expect(screen.getByText('No sessions yet')).toBeTruthy();
    expect(screen.getByText('No model yet')).toBeTruthy();
  });
});
