import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><Sidebar /></Wrapper>);
    expect(screen.getByAltText('Orca')).toBeInTheDocument();
    expect(screen.getByText('Operate')).toBeInTheDocument();
    expect(screen.getByText('Config')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dash/ }).className).toContain('border-accent');
  });

  it('shows the ops status bar counts: needs attention, live agents and last outcome', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['tasks'], [{ id: 'tx', title: 'Refactor', status: 'closed', outcome: 'ok', result_summary: 'passed', closed_at: '2026-06-18 10:00:00' }]);
    client.setQueryData(['sessions'], ['orca-a', 'orca-b']);
    client.setQueryData(['session-signals'], { 'orca-a': { type: 'needs_input', question: 'go?' } });
    render(<Wrapper><Sidebar /></Wrapper>);
    expect(screen.getByText('1 needs attention')).toBeInTheDocument();
    expect(screen.getByText('2 live agents')).toBeInTheDocument();
    expect(screen.getByText('Last: Refactor')).toBeInTheDocument();
  });
});
