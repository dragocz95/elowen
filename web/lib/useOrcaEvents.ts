'use client';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from './queries';
import { BASE } from './orcaClient';
import { withToken } from './token';
import type { DerivedSignal, PlanJob } from './types';

export interface ReviewEvent { missionId: string; taskId: string; approve: boolean; rationale: string }

/** Subscribe to the daemon SSE bus and keep the React Query cache fresh. `onReview` fires for every
 *  post-done review verdict (approve or escalate) — the caller (EventBridge) turns escalations into a
 *  toast. Kept as a callback so the data hook stays testable without a ToastProvider in scope. */
export function useOrcaEvents(opts?: { onReview?: (e: ReviewEvent) => void }): void {
  const qc = useQueryClient();
  // Hold the latest onReview in a ref so the SSE effect can call it WITHOUT listing it as a dependency.
  // The caller (EventBridge) passes a fresh inline arrow on every render — a toast re-renders it — and
  // depending on that identity would tear down and reopen the EventSource on every toast (dropping
  // events mid-reconnect). The connection's lifecycle depends only on the query client.
  const onReviewRef = useRef(opts?.onReview);
  onReviewRef.current = opts?.onReview;
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

    // Post-done review verdict: refresh tasks/missions/timeline (a self-heal re-spawn or a gate
    // release changes them), then hand the verdict to the caller so an escalation becomes a toast.
    const reviewHandler = (e: MessageEvent) => {
      let data: ReviewEvent & { type?: string };
      try { data = JSON.parse(e.data); } catch { return; } // skip malformed, keep the stream alive
      qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks });
      qc.invalidateQueries({ queryKey: ['mission'] });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.missions });
      qc.invalidateQueries({ queryKey: ['activity'] });
      if (data.taskId) onReviewRef.current?.({ missionId: data.missionId, taskId: data.taskId, approve: !!data.approve, rationale: data.rationale ?? '' });
    };

    es.addEventListener('task', taskHandler);
    es.addEventListener('mission', missionHandler);
    es.addEventListener('signal', signalHandler);
    es.addEventListener('plan', planHandler);
    es.addEventListener('review', reviewHandler);

    return () => es.close();
  }, [qc]);
}
