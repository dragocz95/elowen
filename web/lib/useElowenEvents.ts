'use client';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from './queries';
import { BASE } from './elowenClient';
import { createReconnectController } from './reconnect';
import { subscribeRevive, STALE_HIDE_MS } from './useRevive';
import type { DerivedSignal, PlanJob } from './types';

export interface ReviewEvent { missionId: string; taskId: string; approve: boolean; rationale: string }

/** Subscribe to the daemon SSE bus and keep the React Query cache fresh. `onReview` fires for every
 *  post-done review verdict (approve or escalate) — the caller (EventBridge) turns escalations into a
 *  toast. Kept as a callback so the data hook stays testable without a ToastProvider in scope. */
export function useElowenEvents(opts?: { onReview?: (e: ReviewEvent) => void }): void {
  const qc = useQueryClient();
  // Hold the latest onReview in a ref so the SSE effect can call it WITHOUT listing it as a dependency.
  // The caller (EventBridge) passes a fresh inline arrow on every render — a toast re-renders it — and
  // depending on that identity would tear down and reopen the EventSource on every toast (dropping
  // events mid-reconnect). The connection's lifecycle depends only on the query client.
  const onReviewRef = useRef(opts?.onReview);
  onReviewRef.current = opts?.onReview;
  useEffect(() => {
    let es: EventSource | null = null;

    const makeHandler = (invalidate: () => void) => (e: MessageEvent) => {
      try { JSON.parse(e.data); } catch { return; } // skip malformed, keep the stream alive
      invalidate();
    };

    const taskHandler = makeHandler(() => { qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }); qc.invalidateQueries({ queryKey: ['activity'] }); });
    const missionHandler = makeHandler(() => { qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }); qc.invalidateQueries({ queryKey: ['activity'] }); });
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
      let data: { jobId?: string; status?: PlanJob['status']; epicId?: string; phases?: PlanJob['phases']; error?: string; sessionName?: string };
      try { data = JSON.parse(e.data); } catch { return; } // skip malformed, keep the stream alive
      if (!data.jobId || !data.status) return;
      qc.setQueryData<PlanJob>(['plan-job', data.jobId], (prev) => ({
        id: data.jobId!, goal: prev?.goal ?? '', epicId: data.epicId ?? prev?.epicId ?? null,
        status: data.status!, phases: data.phases ?? prev?.phases ?? [], error: data.error,
        // The Pilot session arrives via the GET poll; keep it across SSE updates so a `planning`
        // event (which carries no session) can't blank out the live-preview pane.
        sessionName: data.sessionName ?? prev?.sessionName,
      }));
      if (data.status === 'done') { qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }); qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }); }
    };

    // Post-done review verdict: refresh tasks/missions/timeline (a self-heal re-spawn or a gate
    // release changes them), then hand the verdict to the caller so an escalation becomes a toast.
    const reviewHandler = (e: MessageEvent) => {
      let data: ReviewEvent & { type?: string };
      try { data = JSON.parse(e.data); } catch { return; } // skip malformed, keep the stream alive
      qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.missions });
      qc.invalidateQueries({ queryKey: ['activity'] });
      if (data.taskId) qc.invalidateQueries({ queryKey: ['task-activity', data.taskId] }); // the task's conversation feed
      if (data.taskId) onReviewRef.current?.({ missionId: data.missionId, taskId: data.taskId, approve: !!data.approve, rationale: data.rationale ?? '' });
    };

    // An autopilot decision on an agent prompt/question — refresh the timeline and the affected task's
    // conversation feed (scoped by taskId so an unrelated task's open detail pane doesn't refetch).
    const decisionHandler = (e: MessageEvent) => {
      let data: { taskId?: string };
      try { data = JSON.parse(e.data); } catch { return; } // skip malformed, keep the stream alive
      qc.invalidateQueries({ queryKey: ['activity'] });
      if (data.taskId) qc.invalidateQueries({ queryKey: ['task-activity', data.taskId] });
    };
    // A free-text turn in the worker↔autopilot conversation (`elowen ask`) — refresh the affected task's
    // conversation feed so the new question/reply bubble appears live (scoped by taskId).
    const messageHandler = (e: MessageEvent) => {
      let data: { taskId?: string };
      try { data = JSON.parse(e.data); } catch { return; } // skip malformed, keep the stream alive
      qc.invalidateQueries({ queryKey: ['activity'] });
      if (data.taskId) qc.invalidateQueries({ queryKey: ['task-activity', data.taskId] });
    };
    // A worker's `elowen ask` was escalated to a human, or just got answered — refresh the Escalations inbox.
    const askHandler = () => qc.invalidateQueries({ queryKey: ['pending-asks'] });
    // A new commit landed in a running task's checkout — refresh its live git history and any open
    // per-commit file diff so the conversation feed updates live without a reload.
    const changeHandler = (e: MessageEvent) => {
      let data: { taskId?: string };
      try { data = JSON.parse(e.data); } catch { return; } // skip malformed, keep the stream alive
      qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks });
      if (data.taskId) {
        qc.invalidateQueries({ queryKey: ['task-commits', data.taskId] });
        qc.invalidateQueries({ queryKey: ['task-commit-diff', data.taskId] });
      }
    };

    // A recall delivered memories to the model, so their usage counters and vitality moved with no user
    // action to hang a refresh off. The daemon streams this only to the memories' owner.
    const memoryHandler = makeHandler(() => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.memories });
      qc.invalidateQueries({ queryKey: ['memory-vitality'] });
    });

    // The daemon swapped its plugin registry, so what the instance offers changed — nav worlds, plugin
    // pages, the installed list and the slash-command menu. The swap can land well after the toggle was
    // saved (it waits for running work), which is why this is an event and not the write's response.
    const pluginsHandler = makeHandler(() => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.pluginUi });
      qc.invalidateQueries({ queryKey: ['plugins'] });
      qc.invalidateQueries({ queryKey: ['marketplace'] });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.brainCommands });
    });

    // Someone acted somewhere on the instance — the team activity feed moved. Instance-wide by design,
    // so every browser gets it; the row carries no message content to scope.
    const activityHandler = makeHandler(() => {
      qc.invalidateQueries({ queryKey: ['activity'] });
      qc.invalidateQueries({ queryKey: ['activity-presence'] }); // someone started working
    });

    // Same-origin SSE through the /api proxy; the httpOnly session cookie rides along via credentials.
    // Reconnects itself with capped exponential backoff so a daemon restart / proxy timeout recovers on
    // its own — load-bearing now that cache freshness relies on SSE invalidation, not a polling fallback.
    function connect(): void {
      es?.close();
      es = new EventSource(`${BASE}/events`, { withCredentials: true });
      es.onopen = () => {
        reconnect.succeeded(); // a healthy stream resets the backoff
        // Catch up on whatever happened while the stream was down. SSE has no replay here, so a laptop
        // that slept would otherwise show a hole in the feed until the next event happened to arrive.
        qc.invalidateQueries({ queryKey: ['activity'] });
        qc.invalidateQueries({ queryKey: ['activity-presence'] });
      };

      // Native EventSource auto-reconnects on transport drops (browser-managed retry per HTML spec); we
      // only act on a terminal failure (readyState CLOSED) where it has given up — then retry ourselves
      // with backoff. Do NOT touch the auth token here: the EventSource API can't tell a 401 from a
      // benign drop (proxy/SSE timeout, daemon restart, a hard-reload race), so clearing the token on
      // CLOSED would log the user out spuriously. Real auth expiry is handled by the regular request
      // path (`req` clears the token on a 401), which drives the login gate.
      es.onerror = () => {
        if (!es || es.readyState !== EventSource.CLOSED) return;
        es.close();
        reconnect.retry();
      };

      es.addEventListener('task', taskHandler);
      es.addEventListener('mission', missionHandler);
      es.addEventListener('signal', signalHandler);
      es.addEventListener('plan', planHandler);
      es.addEventListener('review', reviewHandler);
      es.addEventListener('decision', decisionHandler);
      es.addEventListener('message', messageHandler);
      es.addEventListener('ask', askHandler);
      es.addEventListener('change', changeHandler);
      es.addEventListener('memory', memoryHandler);
      es.addEventListener('plugins', pluginsHandler);
      es.addEventListener('activity', activityHandler);
    }

    const reconnect = createReconnectController(connect);
    connect();
    // A phone that was locked comes back with a socket the browser may still call OPEN while nothing can
    // ever arrive on it again. Reopening is cheap here (the frames only invalidate caches), so a wake-up
    // after anything longer than a glance gets a fresh channel rather than a plausible-looking dead one.
    const offRevive = subscribeRevive(({ hiddenMs }) => {
      if (es?.readyState === EventSource.OPEN && hiddenMs <= STALE_HIDE_MS) return;
      reconnect.now();
    });

    return () => { offRevive(); reconnect.stop(); es?.close(); };
  }, [qc]);
}
