'use client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from './queries';
import { BASE } from './orcaClient';
import { withToken } from './token';
import type { DerivedSignal, PlanJob } from './types';

export function useOrcaEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource(withToken(`${BASE}/events`));

    // Native EventSource auto-reconnects on transport drops (browser-managed retry per HTML spec).
    // On a terminal failure (readyState CLOSED) just stop — do NOT touch the auth token here: the
    // EventSource API can't tell a 401 from a benign drop (proxy/SSE timeout, daemon restart, a
    // hard-reload race), so clearing the token on CLOSED would log the user out spuriously. Real
    // auth expiry is handled by the regular request path (`req` clears the token on a 401), which
    // drives the login gate. Closing here only avoids a retry storm against a dead endpoint.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) es.close();
    };

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

    // Plan job updates: push the latest job state into the per-job cache (the usePlanJob poll is the
    // fallback), and refresh tasks/missions when a plan resolves into an epic.
    const planHandler = (e: MessageEvent) => {
      let data: { jobId?: string; status?: PlanJob['status']; epicId?: string; phases?: PlanJob['phases']; error?: string };
      try { data = JSON.parse(e.data); } catch { return; } // skip malformed, keep the stream alive
      if (!data.jobId || !data.status) return;
      qc.setQueryData<PlanJob>(['plan-job', data.jobId], (prev) => ({
        id: data.jobId!, goal: prev?.goal ?? '', epicId: data.epicId ?? prev?.epicId ?? null,
        status: data.status!, phases: data.phases ?? prev?.phases ?? [], error: data.error,
      }));
      if (data.status === 'done') { qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }); qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }); }
    };

    es.addEventListener('task', taskHandler);
    es.addEventListener('mission', missionHandler);
    es.addEventListener('signal', signalHandler);
    es.addEventListener('plan', planHandler);

    return () => es.close();
  }, [qc]);
}
