'use client';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useOrcaEvents } from '../lib/useOrcaEvents';

// EventBridge is exported so LoginGate can render it only when authenticated.
// Mounting it while unauthenticated would open a tokenless SSE connection → 401,
// and EventSource has no retry hook to reconnect after login.
export function EventBridge() { useOrcaEvents(); return null; }

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      {children}
    </QueryClientProvider>
  );
}
