import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
vi.mock('next/navigation', () => ({ usePathname: () => '/dash', useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LanguageProvider } from '../../lib/i18n';
import { ToastProvider } from '../../components/ui/Toast';
import { LoginGate } from '../../components/auth/LoginGate';
import { AUTH_CLEARED_EVENT } from '../../lib/token';

function Wrap({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <ToastProvider>{children}</ToastProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}

// EventBridge (rendered when the gate is open) opens an SSE stream; stub EventSource so jsdom doesn't choke.
class FakeES { onmessage = null; addEventListener() {} close() {} constructor(public url: string) {} }
(globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); });
afterAll(() => server.close());

const passwordInput = () => document.querySelector('input[type="password"]');

describe('LoginGate', () => {
  it('shows the login form when there is no valid session (me() 401, setup done)', async () => {
    // The httpOnly cookie is absent/invalid → the proxy answers 401; setup is already complete.
    server.use(
      http.get('*/api/auth/me', () => new HttpResponse(null, { status: 401 })),
      http.get('*/api/setup', () => HttpResponse.json({ needsSetup: false })),
    );

    render(<Wrap><LoginGate><span>secret-content</span></LoginGate></Wrap>);

    await waitFor(() => expect(passwordInput()).toBeTruthy());
    expect(screen.queryByText('secret-content')).toBeNull();
  });

  it('opens the shell when the session cookie is valid (me() 200)', async () => {
    server.use(http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin' } })));

    render(<Wrap><LoginGate><span>secret-content</span></LoginGate></Wrap>);
    await waitFor(() => expect(screen.getByText('secret-content')).toBeInTheDocument());
  });

  it('flips to login when an AUTH_CLEARED_EVENT fires mid-session (no reload)', async () => {
    server.use(http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin' } })));

    render(<Wrap><LoginGate><span>secret-content</span></LoginGate></Wrap>);
    await waitFor(() => expect(screen.getByText('secret-content')).toBeInTheDocument());

    // A later 401 elsewhere clears the session and dispatches the event; the gate must react.
    window.dispatchEvent(new Event(AUTH_CLEARED_EVENT));
    await waitFor(() => expect(passwordInput()).toBeTruthy());
    expect(screen.queryByText('secret-content')).toBeNull();
  });
});
