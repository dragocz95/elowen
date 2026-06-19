import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
vi.mock('next/navigation', () => ({ usePathname: () => '/dash', useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { Shell } from '../../components/shell/Shell';

class FakeES { onmessage = null; addEventListener() {} close() {} constructor(public url: string) {} }
(globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;
const server = setupServer(http.get('http://localhost:4400/health', () => HttpResponse.json({ ok: true })));
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => localStorage.clear()); afterAll(() => server.close());

describe('Shell', () => {
  it('renders the Sidebar, content slot and a mobile menu trigger', () => {
    // Set a token so LoginGate renders the shell chrome instead of the login form.
    localStorage.setItem('orca.token', 'test-token');
    render(<Shell><span>page-body</span></Shell>);
    // Wordmark appears in the sidebar and the (md:hidden) mobile top bar.
    expect(screen.getAllByAltText('Orca').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Dash/ })).toBeInTheDocument();
    expect(screen.getByText('page-body')).toBeInTheDocument();
    // Mobile menu opens the sidebar drawer on click.
    expect(screen.getAllByRole('button', { name: /toggle sidebar/i }).length).toBeGreaterThan(0);
  });
});
