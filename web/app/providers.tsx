'use client';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ElowenApiError } from '../lib/elowenClient';
import { useElowenEvents } from '../lib/useElowenEvents';

// EventBridge is exported so LoginGate can render it only when authenticated.
// Mounting it while unauthenticated would open a tokenless SSE connection → 401,
// and EventSource has no retry hook to reconnect after login. It keeps the React Query
// cache live from the SSE bus. Review escalations are NOT toasted (the long rationale was
// noisy) — they surface on the Escalations page, the sidebar alert and the bell instead.
export function EventBridge() {
  useElowenEvents();
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
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
  }));
  return (
    <QueryClientProvider client={client}>
      {children}
    </QueryClientProvider>
  );
}
