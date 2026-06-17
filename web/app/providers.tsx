'use client';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useOrcaEvents } from '../lib/useOrcaEvents';

function EventBridge() { useOrcaEvents(); return null; }

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <EventBridge />
      {children}
    </QueryClientProvider>
  );
}
