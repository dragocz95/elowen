import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useMissions, usePendingAsks, useSessions, useSessionInfos, usePluginUi } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { createWrapper } from '../test-utils';
import type { PluginUiListing } from '../../lib/types';

const AGENTS: PluginUiListing = { name: 'agents', url: '/p/agents/index.js', apiVersion: 1, nav: [], settings: [] };

let listing: PluginUiListing[] = [];
const hits = { missions: 0, sessions: 0, asks: 0 };

// A root mount whose plugin is disabled answers 503 — the exact response these hooks used to keep
// asking for. The handlers count, so the test can assert on requests rather than on rendered output.
const server = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json(listing)),
  http.get('*/api/missions', () => { hits.missions += 1; return new HttpResponse(null, { status: 503 }); }),
  http.get('*/api/sessions', () => { hits.sessions += 1; return new HttpResponse(null, { status: 503 }); }),
  http.get('*/api/asks/pending', () => { hits.asks += 1; return new HttpResponse(null, { status: 503 }); }),
);

beforeAll(() => server.listen());
afterAll(() => server.close());
beforeEach(() => { listing = []; hits.missions = 0; hits.sessions = 0; hits.asks = 0; });
afterEach(() => server.resetHandlers());

function useProbe() {
  const { locale } = useTranslation();
  return {
    listing: usePluginUi(locale),
    missions: useMissions(),
    sessions: useSessions(),
    // Shares the ['sessions'] key with useSessions, so it needs the same gate or it re-opens the hole
    // on its own — the sidebar and the dashboard read sessions through this one.
    sessionInfos: useSessionInfos(),
    asks: usePendingAsks(),
  };
}

/** `/missions`, `/sessions` and `/asks/pending` are root mounts the agents plugin owns. The sidebar, the
 *  notification bell and the Kanban board read them on ordinary pages, so on an instance without the
 *  plugin every cache invalidation (the SSE bus fires them constantly) and every window focus re-ran a
 *  request that can only ever 503. The UI already hid the affordances; only the fetch was unconditional. */
describe('agents-domain reads', () => {
  it('stop once the plugin listing shows no owner for the domain', async () => {
    const { wrapper, client } = createWrapper();
    const { result } = renderHook(useProbe, { wrapper });
    await waitFor(() => expect(result.current.listing.isSuccess).toBe(true));
    await waitFor(() => {
      expect(result.current.missions.fetchStatus).toBe('idle');
      expect(result.current.sessions.fetchStatus).toBe('idle');
      expect(result.current.asks.fetchStatus).toBe('idle');
    });

    const before = { ...hits };
    // What actually happens on a live instance: something invalidates the key. A disabled query does
    // not refetch; an ungated one goes straight back to the 503.
    await client.invalidateQueries();
    await waitFor(() => expect(result.current.listing.isFetching).toBe(false));
    expect(hits).toEqual(before);
  });

  it('still fetch when the plugin is there', async () => {
    listing = [AGENTS];
    const { wrapper } = createWrapper();
    const { result } = renderHook(useProbe, { wrapper });
    await waitFor(() => expect(result.current.listing.isSuccess).toBe(true));
    await waitFor(() => {
      expect(hits.missions).toBeGreaterThan(0);
      expect(hits.sessions).toBeGreaterThan(0);
      expect(hits.asks).toBeGreaterThan(0);
    });
  });
});
