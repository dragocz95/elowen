'use client';
import { useQuery } from '@tanstack/react-query';
import { orcaClient } from './orcaClient';

/** Poll a session's tmux pane (ANSI-aware) for a lightweight live preview (last `lines` rows).
 *  An empty name disables the query so callers can pass a possibly-null session id safely.
 *  `enabled` lets callers stop polling a session that is no longer live (a dead tmux pane would
 *  otherwise 404 every 2s and spam the error log); it defaults to on. */
export function useSessionPane(name: string, lines = 8, enabled = true) {
  const q = useQuery({
    queryKey: ['session-pane', name, 'ansi'],
    queryFn: () => orcaClient.sessionPane(name, true),
    enabled: enabled && !!name,
    refetchInterval: 2000,
    refetchOnWindowFocus: false,
  });
  const pane = q.data?.pane ?? '';
  const tail = pane.split('\n').slice(-lines).join('\n');
  return { tail, isLoading: q.isLoading, isError: q.isError };
}
