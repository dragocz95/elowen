import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
  it('keeps the closed mobile drawer out of the accessibility tree', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: undefined });
    client.setQueryData(['tasks'], []);
    render(<Wrapper><Sidebar mode="drawer" drawerOpen={false} /></Wrapper>);
    expect(screen.getByRole('navigation', { hidden: true })).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('navigation', { hidden: true })).toHaveAttribute('inert');
  });

  it('renders the four product worlds and the admin System menu', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true, allowed_execs: [], name: '', email: '', avatar: '', default_exec: '', created_at: '' } });
    client.setQueryData(['tasks'], []);
    render(<Wrapper><Sidebar /></Wrapper>);
    expect(screen.getByAltText('Elowen')).toBeInTheDocument();
    expect(screen.getByText('Spaces')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Work' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Projects' })).toBeInTheDocument();
    const memory = screen.getByRole('link', { name: 'Memory' });
    const system = screen.getByRole('button', { name: 'System' });
    expect(memory).toBeInTheDocument();
    expect(memory.compareDocumentPosition(system) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/Elowen —/)).toBeInTheDocument();

    fireEvent.click(system);
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/account');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users');
  });

  it('renders without crashing in setup mode (me resolved but no user yet)', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: undefined }); // /auth/me in setup mode returns { user: undefined }
    client.setQueryData(['tasks'], []);
    expect(() => render(<Wrapper><Sidebar /></Wrapper>)).not.toThrow();
    expect(screen.getByText('Spaces')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'System' })).toBeInTheDocument();
  });

  it('keeps admin destinations out of the System menu for a non-admin', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 2, username: 'bob', is_admin: false, allowed_execs: [], name: '', email: '', avatar: '', default_exec: '', created_at: '' } });
    client.setQueryData(['tasks'], []);
    render(<Wrapper><Sidebar /></Wrapper>);
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(screen.getByRole('link', { name: 'Account' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('shows the complete world hierarchy in the mobile drawer', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true, allowed_execs: [], name: '', email: '', avatar: '', default_exec: '', created_at: '' } });
    client.setQueryData(['tasks'], []);
    // Sessions is a plugin world now — seed the /plugins/ui listing the nav model consumes.
    client.setQueryData(['plugin-ui', 'en'], [{ name: 'agents', nav: [{ label: 'Sessions', icon: 'SquareTerminal', route: 'sessions' }] }]);
    render(<Wrapper><Sidebar mode="drawer" drawerOpen /></Wrapper>);
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kanban' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Timeline' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Stats' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Editor' })).toBeInTheDocument();
  });

  it('exposes child routes through an accessible flyout in rail mode', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 2, username: 'bob', is_admin: false, allowed_execs: [], name: '', email: '', avatar: '', default_exec: '', created_at: '' } });
    client.setQueryData(['tasks'], []);
    render(<Wrapper><Sidebar mode="rail" /></Wrapper>);
    const workFlyout = screen.getByRole('group', { name: 'Work' });
    expect(within(workFlyout).getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/tasks');
    expect(within(workFlyout).getByRole('link', { name: 'Kanban' })).toHaveAttribute('href', '/kanban');
  });

  it('keeps the footer quiet with only the Elowen version', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['tasks'], [{ id: 'tx', title: 'Refactor', status: 'closed', outcome: 'ok', result_summary: 'passed', closed_at: '2026-06-18 10:00:00' }]);
    client.setQueryData(['sessions'], [{ name: 'elowen-a', role: 'agent', agent: 'a' }, { name: 'elowen-b', role: 'agent', agent: 'b' }]);
    client.setQueryData(['session-signals'], { 'elowen-a': { type: 'needs_input', question: 'go?' } });
    render(<Wrapper><Sidebar /></Wrapper>);
    expect(screen.queryByText('2 live agents')).not.toBeInTheDocument();
    expect(screen.queryByText('Last: Refactor')).not.toBeInTheDocument();
    expect(screen.getByText(/Elowen —/)).toBeInTheDocument();
  });
});
