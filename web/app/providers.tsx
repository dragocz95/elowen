'use client';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ElowenApiError } from '../lib/elowenClient';
import { QUERY_KEYS } from '../lib/queries';
import { useElowenEvents } from '../lib/useElowenEvents';
import type { PluginUiListing, User } from '../lib/types';

/** The server-prefetched /plugins/ui listing (root layout), handed over so the client's first paint
 *  already carries the plugin worlds instead of popping them in when the client fetch resolves. Null
 *  for logged-out visitors and every daemon/auth failure — the client query then fills it in as
 *  before. The key is the EXACT key usePluginUi reads, locale included, or the seed would populate a
 *  key nothing subscribes to and the flash would remain while tests look green. */
export interface PluginUiSeed {
  locale: string;
  listing: PluginUiListing[];
}

/** The server-prefetched /auth/me (root layout). The system nav group renders admin destinations only
 *  once `is_admin` is known, so without this seed the rail paints with Account alone and grows
 *  Settings/Users when the client's own /auth/me resolves. Null for logged-out visitors and every
 *  daemon/auth failure — the client query then fills it in as before. */
export interface MeSeed {
  user: User;
}

// EventBridge is exported so LoginGate can render it only when authenticated.
// Mounting it while unauthenticated would open a tokenless SSE connection → 401,
// and EventSource has no retry hook to reconnect after login. It keeps the React Query
// cache live from the SSE bus. Review escalations are NOT toasted (the long rationale was
// noisy) — they surface on the Escalations page, the sidebar alert and the bell instead.
export function EventBridge() {
  useElowenEvents();
  return null;
}

export function Providers({ children, pluginUiSeed = null, meSeed = null }: { children: ReactNode; pluginUiSeed?: PluginUiSeed | null; meSeed?: MeSeed | null }) {
  const [client] = useState(() => {
    const client = new QueryClient({
    defaultOptions: {
      queries: {
        // The SSE bus drives freshness (useElowenEvents invalidates on every relevant event), so treat
        // data as fresh for 10s and skip the refetch-on-focus stampede — a tab regaining focus would
        // otherwise re-run every mounted query at once for no new data. SSE invalidation bypasses
        // staleTime, so live updates still land immediately.
        staleTime: 10_000,
        refetchOnWindowFocus: false,
        // Don't retry client errors (4xx): a 401 has already cleared the token (req() in elowenClient),
        // and 400/403/404 won't change on a retry — retrying only delays the error UI and re-hammers
        // the daemon. 503 is the daemon's DELIBERATE "plugin is disabled" degradation on declared
        // plugin mounts — deterministic until an admin flips the plugin, so retrying is pure noise.
        // Transient faults (network drop / other 5xx) still get a couple of attempts.
        retry: (failureCount, error) => {
          const status = error instanceof ElowenApiError ? error.status : undefined;
          if (status != null && ((status >= 400 && status < 500) || status === 503)) return false;
          return failureCount < 2;
        },
      },
    },
    });
    // Seed once, at client construction: fresh at mount, so the 60s staleTime on usePluginUi keeps the
    // client from refetching what the server just rendered. The SSE bus still invalidates the key on a
    // plugin toggle, so live updates are unaffected.
    if (pluginUiSeed) client.setQueryData([...QUERY_KEYS.pluginUi, pluginUiSeed.locale], pluginUiSeed.listing);
    // Same reasoning for the identity: seeded fresh at construction, so the 5-minute staleTime on
    // useMe keeps the client from re-asking for what the server just rendered.
    if (meSeed) client.setQueryData(QUERY_KEYS.me, meSeed);
    return client;
  });
  return (
    <QueryClientProvider client={client}>
      {children}
    </QueryClientProvider>
  );
}
