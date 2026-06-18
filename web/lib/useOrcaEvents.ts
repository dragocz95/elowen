'use client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from './queries';
import { BASE } from './orcaClient';
import { withToken } from './token';
import type { DerivedSignal } from './types';

export function useOrcaEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource(withToken(`${BASE}/events`));

    // Native EventSource auto-reconnects on transport drops (browser-managed retry with
    // exponential backoff per HTML spec §9.2.6), which satisfies spec §8 for the common
    // case. Explicit capped backoff with jitter is deferred.

    const makeHandler = (invalidate: () => void) => (e: MessageEvent) => {
      try { JSON.parse(e.data); } catch { return; } // skip malformed, keep the stream alive
      invalidate();
    };

    const taskHandler = makeHandler(() => { qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }); qc.invalidateQueries({ queryKey: ['mission'] }); qc.invalidateQueries({ queryKey: ['activity'] }); });
    const missionHandler = makeHandler(() => { qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }); qc.invalidateQueries({ queryKey: ['mission'] }); qc.invalidateQueries({ queryKey: ['activity'] }); });
    const signalHandler = (e: MessageEvent) => {
      let data: { session?: string; signal?: DerivedSignal };
      try { data = JSON.parse(e.data); } catch { return; } // skip malformed, keep the stream alive
      if (data.session && data.signal) {
        qc.setQueryData<Record<string, DerivedSignal>>(QUERY_KEYS.sessionSignals, (prev) => ({ ...(prev ?? {}), [data.session!]: data.signal! }));
      }
      qc.invalidateQueries({ queryKey: QUERY_KEYS.sessions });
      qc.invalidateQueries({ queryKey: ['activity'] });
    };

    es.addEventListener('task', taskHandler);
    es.addEventListener('mission', missionHandler);
    es.addEventListener('signal', signalHandler);

    return () => es.close();
  }, [qc]);
}
