import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
vi.mock('next/navigation', () => ({ usePathname: () => '/dash', useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { Shell } from '../../components/shell/Shell';

class FakeES { onmessage = null; addEventListener() {} close() {} constructor(public url: string) {} }
(globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;
const server = setupServer(
  http.get('*/api/health', () => HttpResponse.json({ ok: true })),
  // A valid session: LoginGate's me() probe resolves → the shell chrome renders.
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin' } })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('Shell', () => {
  it('renders the Sidebar, content slot and a mobile menu trigger', async () => {
    render(<Shell><span>page-body</span></Shell>);
    // Wordmark and the new Home world appear after the async gate opens.
    expect((await screen.findAllByAltText('Elowen')).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('page-body')).toBeInTheDocument();
    // Mobile menu opens the sidebar drawer on click.
    expect(screen.getAllByRole('button', { name: /toggle sidebar/i }).length).toBeGreaterThan(0);
  });
});
