import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ensurePluginUiRuntime } from '../../lib/pluginUi';
import { SessionsView } from '../../../plugins/agents/web-src/sessions/SessionsView';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

// The moved view resolves everything through window.ElowenUiRuntime — install the REAL runtime (the
// same components/hooks/utils the app hands to bundles), so this exercises the production contract.
ensurePluginUiRuntime();

vi.mock('../../components/terminal/StreamTerminal', () => ({ StreamTerminal: ({ name }: { name: string }) => <div data-testid="term">{name}</div> }));

// next/dynamic is async in real Next.js; in tests mock it as a synchronous passthrough
// so that vi.mock on the target module is respected and components render immediately
vi.mock('next/dynamic', () => ({
  default: <P extends object>(
    loader: () => Promise<{ default?: React.ComponentType<P> } | React.ComponentType<P>>,
    _opts?: unknown,
  ): React.ComponentType<P> => {
    // Run the loader eagerly — vitest module registry returns the mocked module
    // synchronously in the same microtask when the mock is already registered
    let resolved: React.ComponentType<P> | null = null;
    void loader().then((mod) => {
      const m = mod as Record<string, unknown>;
      resolved = (typeof m.default === 'function' ? m.default : mod) as React.ComponentType<P>;
    });
    return function DynamicWrapper(props: P) {
      if (!resolved) return null;
      return React.createElement(resolved, props);
    };
  },
}));

let killed = false;
const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'user', is_admin: false } })),
  http.get('*/api/tasks', () => HttpResponse.json([])),
  http.get('*/api/config', () => HttpResponse.json({ autopilot: {} })),
  http.get('*/api/projects', () => HttpResponse.json([{ id: 1, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '', pr_enabled: null }])),
  http.get('*/api/projects/1/git', () => HttpResponse.json({ isRepo: false, status: null, branches: [], commits: [] })),
  http.get('*/api/sessions', () => HttpResponse.json([{ name: 'elowen-SwiftLake', role: 'agent', agent: 'SwiftLake' }])),
  http.get('*/api/sessions/elowen-SwiftLake/pane', () => HttpResponse.json({ pane: 'line a\nline b' })),
  http.delete('*/api/sessions/elowen-SwiftLake', () => { killed = true; return HttpResponse.json({ ok: true }); }),
);
beforeEach(() => { killed = false; });
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('agents plugin SessionsView', () => {
  it('uses the spatial workspace shell with one mascot and primary rail navigation', async () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SessionsView /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('SwiftLake')).toBeInTheDocument());
    expect(screen.getByTestId('spatial-workspace-layout')).toBeInTheDocument();
    expect(screen.getAllByTestId('workspace-hero-mascot')).toHaveLength(1);
    expect(container.querySelector('.workspace-tabs')).toBeNull();
    expect(container.querySelector('[data-control-surface]')).toBeInTheDocument();
    expect(screen.getByTestId('live-sessions-list').closest('.control-surface-register')).toBeInTheDocument();
  });

  it('kills a session', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SessionsView /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('SwiftLake')).toBeInTheDocument());
    expect(screen.getByTestId('live-sessions-list').firstElementChild).not.toHaveClass('rounded-lg');
    // Kill lives in the action menu and requires explicit confirmation.
    fireEvent.click(screen.getByRole('button', { name: 'Kill session' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Kill session' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Kill SwiftLake?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Kill session' }));
    await waitFor(() => expect(killed).toBe(true));
  });

  it('carries no Conversations tab, only the signpost to the Chat page register', async () => {
    // The conversation register (BrainSessionsPanel) is core data and moved to /chat — the plugin
    // page keeps live agents only, plus a hero link pointing at the register's new home.
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SessionsView /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('SwiftLake')).toBeInTheDocument());
    expect(screen.queryByRole('radio', { name: 'Conversations' })).toBeNull();
    expect(screen.queryByTestId('brain-sessions-list')).toBeNull();
    expect(screen.getByRole('button', { name: 'Conversation history' })).toBeInTheDocument();
  });

  it('opens terminal in modal and closes via modal close button', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SessionsView /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('SwiftLake')).toBeInTheDocument());
    // Terminal not yet visible
    expect(screen.queryByTestId('term')).not.toBeInTheDocument();
    // Click Terminal button → modal opens with terminal inside
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByTestId('term')).toHaveTextContent('elowen-SwiftLake');
    // Close via modal's Close button
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('term')).not.toBeInTheDocument();
  });
});
