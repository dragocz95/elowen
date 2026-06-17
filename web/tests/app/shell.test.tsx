import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
vi.mock('next/navigation', () => ({ usePathname: () => '/dash' }));
import { Shell } from '../../components/shell/Shell';

class FakeES { onmessage = null; addEventListener() {} close() {} constructor(public url: string) {} }
(globalThis as any).EventSource = FakeES as any;
const server = setupServer(http.get('http://localhost:4400/health', () => HttpResponse.json({ ok: true })));
beforeAll(() => server.listen()); afterEach(() => localStorage.clear()); afterAll(() => server.close());

describe('Shell', () => {
  it('renders the Sidebar + content slot, no TopBar', () => {
    // Set a token so LoginGate renders the shell chrome instead of the login form.
    localStorage.setItem('orca.token', 'test-token');
    render(<Shell><span>page-body</span></Shell>);
    expect(screen.getByAltText('Orca')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dash/ })).toBeInTheDocument();
    expect(screen.getByText('page-body')).toBeInTheDocument();
  });
});
