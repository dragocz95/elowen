import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import type { PluginUiListing } from '../../lib/types';

vi.mock('next/navigation', () => ({ usePathname: () => '/dash', useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { Shell } from '../../components/shell/Shell';

class FakeES { onmessage = null; addEventListener() {} close() {} constructor(public url: string) {} }
(globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;

const LISTING: PluginUiListing[] = [
  { name: 'salon', url: '/plugins/salon/bundle.js', apiVersion: 1, label: 'Salon', nav: [{ label: 'Bookings' }], settings: [] },
];

// The /plugins/ui handler NEVER resolves. Any plugin world visible in the rail therefore came from the
// server-rendered seed, not from a settled client fetch — a test that lets the query resolve would pass
// just as well without the prefetch and prove nothing.
let pluginUiRequests = 0;
const hangingPluginUi = http.get('*/api/plugins/ui', () => {
  pluginUiRequests += 1;
  return new Promise<Response>(() => {});
});

const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin' } })),
  // Ambient shell fan-out the assertions don't read — handled only to keep the output quiet.
  http.get('*/api/health', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.get('*/api/activity', () => HttpResponse.json([])),
  http.get('*/api/asks/pending', () => HttpResponse.json([])),
  // A 401 on the session probe makes the client clear its session, which posts a logout.
  http.post('*/api/auth/logout', () => HttpResponse.json({ ok: true })),
  hangingPluginUi,
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); pluginUiRequests = 0; });
afterAll(() => server.close());

describe('plugin nav server prefetch', () => {
  it('renders the plugin worlds on the FIRST paint, before any client fetch could have resolved', async () => {
    render(<Shell pluginUiSeed={{ locale: 'en', listing: LISTING }}><span>page-body</span></Shell>);
    expect(await screen.findByText('Salon')).toBeInTheDocument();
    // The seed is fresh within the query's staleTime, so the client does not even ASK for the listing
    // it already rendered — the request the hanging handler would never answer never fires.
    expect(pluginUiRequests).toBe(0);
  });

  it('keeps the seeded worlds across the post-mount locale switch instead of dropping the layout', async () => {
    // A stored 'cs' choice applies only after mount (localStorage is invisible to the server), so the
    // client switches key from the seeded ['plugin-ui','en'] to ['plugin-ui','cs'] — whose fetch hangs
    // here. placeholderData keeps the previous listing visible; without it the worlds would vanish for
    // the round-trip — the very flash the prefetch removes.
    localStorage.setItem('elowen-locale', 'cs');
    render(<Shell pluginUiSeed={{ locale: 'en', listing: LISTING }}><span>page-body</span></Shell>);
    expect(await screen.findByText('Salon')).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.lang).toBe('cs'));
    expect(screen.getByText('Salon')).toBeInTheDocument();
  });

  it('renders the core rail unchanged without a seed (daemon down / logged out: the client refills it)', async () => {
    render(<Shell pluginUiSeed={null}><span>page-body</span></Shell>);
    expect(await screen.findByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByText('Salon')).not.toBeInTheDocument();
  });

  it('an unauthenticated visitor gets the login screen, not a thrown render', async () => {
    server.use(http.get('*/api/auth/me', () => HttpResponse.json({ error: 'unauthorized' }, { status: 401 })));
    render(<Shell pluginUiSeed={null}><span>page-body</span></Shell>);
    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });
});
