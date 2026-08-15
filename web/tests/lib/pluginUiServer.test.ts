import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginUiListing } from '../../lib/types';

// The module under test reads the caller's Cookie header through next/headers; each test sets what the
// "current request" carries.
let cookieHeader: string | null = null;
vi.mock('next/headers', () => ({
  headers: async () => new Headers(cookieHeader ? { cookie: cookieHeader } : {}),
}));

const LISTING: PluginUiListing[] = [
  { name: 'salon', url: '/plugins/salon/bundle.js', apiVersion: 1, label: 'Salon', nav: [{ label: 'Bookings' }], settings: [] },
];

// fetchPluginUiListing holds module state (failure backoff), so each test imports a FRESH module
// instance — and fetch is always stubbed: a test hitting the real daemon would silently change
// meaning with whatever happens to run on the box.
describe('fetchPluginUiListing', () => {
  beforeEach(() => { vi.resetModules(); cookieHeader = null; });
  afterEach(() => vi.unstubAllGlobals());

  const importFresh = async () => (await import('../../lib/pluginUiServer')).fetchPluginUiListing;
  const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

  it('fetches nothing for a logged-out request — no cookie, no daemon call, no noise', async () => {
    const fetchMock = vi.fn(async () => okResponse(LISTING));
    vi.stubGlobal('fetch', fetchMock);
    expect(await (await importFresh())('en')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the CALLER's session as the daemon bearer, with the locale as lang", async () => {
    cookieHeader = 'elowen_session=token-of-alice';
    const fetchMock = vi.fn(async () => okResponse(LISTING));
    vi.stubGlobal('fetch', fetchMock);
    expect(await (await importFresh())('en')).toEqual(LISTING);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/plugins/ui?lang=en');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-of-alice');
  });

  it('never caches across callers: two users get their own listings, each fetched with their own token', async () => {
    // Tenancy is the whole point of the per-caller fetch — a shared last-known-good (as the theme
    // payload legitimately uses) would render one user's plugin list into another user's HTML.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const bearer = (init.headers as Record<string, string>).authorization;
      return okResponse([{ ...LISTING[0], label: bearer === 'Bearer token-of-alice' ? 'Alice Salon' : 'Bob CRM' }]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fetchPluginUiListing = await importFresh();
    cookieHeader = 'elowen_session=token-of-alice';
    expect((await fetchPluginUiListing('en'))?.[0].label).toBe('Alice Salon');
    cookieHeader = 'elowen_session=token-of-bob';
    expect((await fetchPluginUiListing('en'))?.[0].label).toBe('Bob CRM');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves nothing to a second caller when the daemon fails after another caller succeeded', async () => {
    const fetchMock = vi.fn(async () => okResponse(LISTING));
    vi.stubGlobal('fetch', fetchMock);
    const fetchPluginUiListing = await importFresh();
    cookieHeader = 'elowen_session=token-of-alice';
    expect(await fetchPluginUiListing('en')).toEqual(LISTING);
    // The daemon dies between the two page loads: Bob's document must render WITHOUT plugins (his own
    // client query refills them), never with Alice's listing.
    fetchMock.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
    cookieHeader = 'elowen_session=token-of-bob';
    expect(await fetchPluginUiListing('en')).toBeNull();
  });

  it('treats 401 and 403 as a normal "no plugin nav", not a failure — and does not trip the backoff', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const fetchPluginUiListing = await importFresh();
    cookieHeader = 'elowen_session=stale-token';
    expect(await fetchPluginUiListing('en')).toBeNull();
    // A 401 is per-session, not a daemon outage: the next caller must still get a live fetch.
    fetchMock.mockImplementation(async () => okResponse(LISTING));
    cookieHeader = 'elowen_session=token-of-alice';
    expect(await fetchPluginUiListing('en')).toEqual(LISTING);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to null on a daemon failure and backs off instead of paying the timeout per document', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('down'); });
    vi.stubGlobal('fetch', fetchMock);
    const fetchPluginUiListing = await importFresh();
    cookieHeader = 'elowen_session=token-of-alice';
    expect(await fetchPluginUiListing('en')).toBeNull();
    expect(await fetchPluginUiListing('en')).toBeNull();
    expect(await fetchPluginUiListing('en')).toBeNull();
    // Only the FIRST call may touch the network inside the backoff window — a hanging daemon otherwise
    // adds its full abort timeout to the TTFB of every page, the login screen included.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed body instead of seeding garbage into the navigation', async () => {
    cookieHeader = 'elowen_session=token-of-alice';
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ hello: 'world' })));
    expect(await (await importFresh())('en')).toBeNull();
  });
});
