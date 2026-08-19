import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import type { PluginUiListing, User } from '../../lib/types';

vi.mock('next/navigation', () => ({ usePathname: () => '/dash', useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { Shell } from '../../components/shell/Shell';

class FakeES { onmessage = null; addEventListener() {} close() {} constructor(public url: string) {} }
(globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;

const asUser = (over: Partial<User>): User => ({
  id: 1, username: 'admin', created_at: '2026-01-01', is_admin: false, allowed_execs: [], disabled_tools: [],
  granted_plugins: [], name: '', email: '', avatar: '', default_exec: '', advisor_exec: '', advisor_autostart: false,
  ...over,
});
const ADMIN_SEED = { user: asUser({ is_admin: true }) };

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
  // The rail stays inert until it knows the arrangement, so an unanswered read leaves it empty.
  http.get('*/api/auth/me/nav-settings', () => HttpResponse.json({ hidden: [], order: [] })),
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

describe('identity server prefetch', () => {
  // The /auth/me handler NEVER resolves, so any admin destination in the rail came from the seed. The
  // system group renders Settings and Users only once is_admin is known, which is why the rail kept
  // growing after first paint even once the plugin worlds were seeded.
  let meRequests = 0;
  const hangingMe = http.get('*/api/auth/me', () => {
    meRequests += 1;
    return new Promise<Response>(() => {});
  });
  const ADMIN = ADMIN_SEED;

  afterEach(() => { meRequests = 0; });

  it('renders the admin destinations on the FIRST paint, before any client fetch could have resolved', async () => {
    server.use(hangingMe);
    render(<Shell meSeed={ADMIN} pluginUiSeed={null}><span>page-body</span></Shell>);
    expect(await screen.findByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Users' })).toBeInTheDocument();
    // Fresh within useMe's staleTime, so the client does not even ASK for what the server rendered.
    expect(meRequests).toBe(0);
  });

  it('shows a non-admin only their own destinations — the seed decides, and it must not over-grant', async () => {
    server.use(hangingMe);
    render(<Shell meSeed={{ user: asUser({ id: 2, username: 'bob' }) }} pluginUiSeed={null}><span>page-body</span></Shell>);
    expect(await screen.findByRole('link', { name: 'Account' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('without a seed the admin destinations arrive only after the client fetch — the flash this removes', async () => {
    // The pre-fix behaviour, pinned deliberately: with no seed the first paint has no identity, so the
    // rail starts without Settings and grows it when /auth/me resolves. If this ever renders Settings
    // synchronously, the seeded assertions above would pass for a reason that has nothing to do with
    // the seed, and this suite would stop proving anything.
    server.use(http.get('*/api/auth/me', () => HttpResponse.json(ADMIN)));
    render(<Shell meSeed={null} pluginUiSeed={null}><span>page-body</span></Shell>);
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });
});

describe('locale server prefetch', () => {
  it('renders the FIRST paint in the server-resolved language, with no English pass first', async () => {
    // Before the locale rode a cookie, the server could only ever render English: a Czech user got an
    // English document and watched every label be rewritten once hydration read localStorage. Nothing
    // moved — which is why CLS stayed near zero and the flash was invisible to layout metrics — but the
    // whole interface changed words in front of them.
    localStorage.setItem('elowen-locale', 'cs');
    render(<Shell initialLocale="cs" meSeed={ADMIN_SEED} pluginUiSeed={null}><span>page-body</span></Shell>);
    expect(screen.getByRole('link', { name: 'Nastavení' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('still honours a stored choice the server never saw, and writes the cookie so the next load is right', async () => {
    // A session that predates the cookie has localStorage only. It must keep working — one repaint, as
    // before — and must leave the cookie behind so the NEXT document is server-rendered correctly.
    localStorage.setItem('elowen-locale', 'cs');
    render(<Shell initialLocale="en" meSeed={ADMIN_SEED} pluginUiSeed={null}><span>page-body</span></Shell>);
    expect(await screen.findByRole('link', { name: 'Nastavení' })).toBeInTheDocument();
    await waitFor(() => expect(document.cookie).toContain('elowen-locale=cs'));
  });
});

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
