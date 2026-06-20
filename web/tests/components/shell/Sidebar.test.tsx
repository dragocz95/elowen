import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
vi.mock('next/navigation', () => ({ usePathname: () => '/dash' }));
import { Sidebar } from '../../../components/shell/Sidebar';
import { createWrapper } from '../../test-utils';

const server = setupServer(http.get('*/health', () => HttpResponse.json({ ok: true })));
beforeAll(() => server.listen({ onUnhandledRequest })); afterAll(() => server.close());
beforeEach(() => localStorage.clear());

describe('Sidebar (registry-driven)', () => {
  it('renders wordmark + groups + active item from the registry', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    // An admin sees the admin-only "Administration" group.
    client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true, allowed_execs: [], name: '', email: '', avatar: '', default_exec: '', created_at: '' } });
    render(<Wrapper><Sidebar /></Wrapper>);
    expect(screen.getByAltText('Orca')).toBeInTheDocument();
    expect(screen.getByText('Operate')).toBeInTheDocument();
    expect(screen.getByText('Administration')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dash/ }).className).toContain('border-accent');
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

  it('shows live agents and last outcome in the ops bar, and a pending-approval count on the notification bell', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['tasks'], [{ id: 'tx', title: 'Refactor', status: 'closed', outcome: 'ok', result_summary: 'passed', closed_at: '2026-06-18 10:00:00' }]);
    client.setQueryData(['sessions'], [{ name: 'orca-a', role: 'agent', agent: 'a' }, { name: 'orca-b', role: 'agent', agent: 'b' }]);
    client.setQueryData(['session-signals'], { 'orca-a': { type: 'needs_input', question: 'go?' } });
    render(<Wrapper><Sidebar /></Wrapper>);
    // One agent waiting for approval → badge on the notification bell.
    const bell = screen.getByLabelText('Notifications');
    expect(within(bell).getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2 live agents')).toBeInTheDocument();
    expect(screen.getByText('Last: Refactor')).toBeInTheDocument();
  });
});
