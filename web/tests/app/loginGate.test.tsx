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
import { useMe } from '../../lib/queries';
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

  it('points at the terminal installer when the box has no account yet, and keeps the shell closed', async () => {
    // Setup lives in the terminal installer, so a box with no admin has no credentials to offer: showing
    // the login form would strand the visitor, and opening the shell would hand out an unauthenticated app.
    server.use(
      http.get('*/api/auth/me', () => new HttpResponse(null, { status: 401 })),
      http.get('*/api/setup', () => HttpResponse.json({ needsSetup: true })),
    );

    render(<Wrap><LoginGate><span>secret-content</span></LoginGate></Wrap>);

    await waitFor(() => expect(screen.getByText('elowen setup')).toBeInTheDocument());
    expect(screen.queryByText('secret-content')).toBeNull();
    expect(passwordInput()).toBeNull();
  });

  it('resolves the first run from CORE endpoints only — never a plugin route', async () => {
    // The first run must not depend on any plugin being installed. It used to be decided by
    // /integrations/cli-status, which belongs to the `agents` plugin: on an install without it that
    // probe answers 503 and the fresh-install branch silently stopped working. `/setup` is core and
    // exists on every install, so first-run routing is now derived from it alone.
    const paths: string[] = [];
    server.use(
      http.get('*/api/*', ({ request }) => {
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (path === '/api/auth/me') return new HttpResponse(null, { status: 401 });
        if (path === '/api/setup') return HttpResponse.json({ needsSetup: true });
        return HttpResponse.json({});
      }),
    );

    render(<Wrap><LoginGate><span>secret-content</span></LoginGate></Wrap>);
    await waitFor(() => expect(screen.getByText('elowen setup')).toBeInTheDocument());

    expect(paths).toContain('/api/setup');
    expect(paths.every((p) => p === '/api/auth/me' || p === '/api/setup')).toBe(true);
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

  it('renders the shell while the session probe is still in flight', async () => {
    // Hold /auth/me open: whatever renders before it resolves is what the user sees during the probe.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    server.use(http.get('*/api/auth/me', async () => {
      await held;
      return HttpResponse.json({ user: { id: 1, username: 'admin' } });
    }));

    render(<Wrap><LoginGate><span>secret-content</span></LoginGate></Wrap>);

    // The shell is up before the probe answers, so the page's own queries race it instead of queueing
    // behind it — that is what makes the dashboard fill progressively instead of after a full round trip.
    expect(screen.getByText('secret-content')).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.getByText('secret-content')).toBeInTheDocument());
  });

  it('seeds the probe result so a user-dependent hook never re-requests /auth/me', async () => {
    let calls = 0;
    server.use(http.get('*/api/auth/me', () => {
      calls += 1;
      return HttpResponse.json({ user: { id: 1, username: 'admin' } });
    }));

    function NeedsUser() {
      const me = useMe();
      return <span>{me.data?.user?.username ?? 'pending'}</span>;
    }

    render(<Wrap><LoginGate><NeedsUser /></LoginGate></Wrap>);
    await waitFor(() => expect(screen.getByText('admin')).toBeInTheDocument());

    // Without the cache seed the gate's probe and useMe() are two separate fetches of the same endpoint,
    // and the hooks gated on `is_admin` wait for the second one before they even start.
    expect(calls).toBe(1);
  });
});
