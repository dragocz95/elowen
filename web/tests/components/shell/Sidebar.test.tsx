import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
vi.mock('next/navigation', () => ({ usePathname: () => '/dash', useSearchParams: () => new URLSearchParams() }));
import { Sidebar } from '../../../components/shell/Sidebar';
import { createWrapper } from '../../test-utils';

const server = setupServer(http.get('*/api/health', () => HttpResponse.json({ ok: true })));
beforeAll(() => server.listen({ onUnhandledRequest })); afterAll(() => server.close());
beforeEach(() => localStorage.clear());

describe('Sidebar (registry-driven)', () => {
  it('renders wordmark + groups + active item from the registry', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    // An admin sees the admin-only "Administration" group.
    client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true, allowed_execs: [], name: '', email: '', avatar: '', default_exec: '', created_at: '' } });
    render(<Wrapper><Sidebar /></Wrapper>);
    expect(screen.getByAltText('Elowen')).toBeInTheDocument();
    expect(screen.getByText('Operate')).toBeInTheDocument();
    expect(screen.getByText('Administration')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dash/ }).className).toContain('border-accent'); // Elowen brand-red active line
  });

  it('renders without crashing in setup mode (me resolved but no user yet)', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: undefined }); // /auth/me in setup mode returns { user: undefined }
    expect(() => render(<Wrapper><Sidebar /></Wrapper>)).not.toThrow();
    expect(screen.getByText('Operate')).toBeInTheDocument();
    expect(screen.queryByText('Administration')).not.toBeInTheDocument();
  });

  it('hides the Administration group from a non-admin', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 2, username: 'bob', is_admin: false, allowed_execs: [], name: '', email: '', avatar: '', default_exec: '', created_at: '' } });
    render(<Wrapper><Sidebar /></Wrapper>);
    expect(screen.getByText('Operate')).toBeInTheDocument();
    expect(screen.queryByText('Administration')).not.toBeInTheDocument();
  });

  it('shows live agents and last outcome in the ops bar', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['tasks'], [{ id: 'tx', title: 'Refactor', status: 'closed', outcome: 'ok', result_summary: 'passed', closed_at: '2026-06-18 10:00:00' }]);
    client.setQueryData(['sessions'], [{ name: 'elowen-a', role: 'agent', agent: 'a' }, { name: 'elowen-b', role: 'agent', agent: 'b' }]);
    client.setQueryData(['session-signals'], { 'elowen-a': { type: 'needs_input', question: 'go?' } });
    render(<Wrapper><Sidebar /></Wrapper>);
    // The notification bell moved to the TopBar; the Sidebar keeps the ops bar (live agents + last outcome).
    expect(screen.getByText('2 live agents')).toBeInTheDocument();
    expect(screen.getByText('Last: Refactor')).toBeInTheDocument();
  });
});
