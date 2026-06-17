import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import SessionsPage from '../../app/sessions/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

vi.mock('../../components/terminal/Terminal', () => ({ Terminal: ({ name }: { name: string }) => <div data-testid="term">{name}</div> }));

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
  http.get('http://localhost:4400/sessions', () => HttpResponse.json(['orca-SwiftLake'])),
  http.delete('http://localhost:4400/sessions/orca-SwiftLake', () => { killed = true; return HttpResponse.json({ ok: true }); }),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('SessionsPage', () => {
  it('kills a session', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SessionsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('orca-SwiftLake')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
    await waitFor(() => expect(killed).toBe(true));
  });

  it('opens terminal in modal and closes via modal close button', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SessionsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('orca-SwiftLake')).toBeInTheDocument());
    // Terminal not yet visible
    expect(screen.queryByTestId('term')).not.toBeInTheDocument();
    // Click Terminal button → modal opens with terminal inside
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByTestId('term')).toHaveTextContent('orca-SwiftLake');
    // Close via modal's Close button
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('term')).not.toBeInTheDocument();
  });
});
