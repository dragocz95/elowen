import { color } from './theme.js';
import { upsertCard } from '../../brain/transcript.js';
import { TranscriptModel } from '../../brain/transcriptModel.js';
import { SnapshotHydrator, SnapshotTimeoutError, type SnapshotLaneLease } from './snapshotHydrator.js';
import type { BrainEvent } from '../../brain/events.js';
import type { BrainMessageView } from '../../brain/messageView.js';
import type { BrainStreamSnapshot } from '../../brain/session/liveEventReplay.js';
import type { BrainStreamFrame } from './brainClient.js';
import type { SubagentPanelEntry } from './components.js';
import type { ChatRuntime } from './runtime.js';
import type { Flows } from './flows.js';
import { HydrationNoticeOwner } from './hydrationNoticeOwner.js';

export interface StreamController {
  subagentStates(): readonly SubagentPanelEntry[];
  subagentSessions(): { sessionId: string; running: boolean }[];
  openSubagent(sessionId: string): Promise<void>;
  closeSubagent(): void;
  cycleSubagent(): void;
  openStream(ac: AbortController): void;
  switchTo(target: { session?: string; fresh?: boolean }): Promise<void>;
  /** Cancels parent/child streams, history operations and child fallback timers as one lifecycle unit. */
  stop(): void;
}

const historyNotice = (scope: 'conversation' | 'sub-agent', error: unknown): string => {
  if (error instanceof SnapshotTimeoutError) return color.error(`${scope} transcript history timed out`);
  const message = error instanceof Error ? error.message : String(error);
  return color.error(`could not load the ${scope} transcript: ${message}`);
};

/** Owns the event/hydration side of chat. Parent and child use independent lanes of the same bounded
 * SnapshotHydrator; all callbacks additionally capture their stream/session generation. */
export function createStreamController(
  rt: ChatRuntime,
  flows: Flows,
  hydrator = new SnapshotHydrator<BrainEvent>(),
  hydrationNotices = new HydrationNoticeOwner({ external: rt.notice }),
): StreamController {
  const { client } = rt;
  let childGeneration = 0;
  let switchGeneration = 0;
  let stopped = false;
  const childFallbacks = new Set<ReturnType<typeof setTimeout>>();
  const publishHydrationNotice = (lane: 'parent' | 'child', scope: 'conversation' | 'sub-agent', error: unknown): void => {
    rt.notice = hydrationNotices.publish(lane, historyNotice(scope, error), rt.notice);
  };
  const clearHydrationNotice = (lane: 'parent' | 'child'): void => {
    rt.notice = hydrationNotices.clear(lane, rt.notice);
  };

  const subagentStates = (): readonly SubagentPanelEntry[] => rt.transcript.subagents();
  const subagentSessions = (): { sessionId: string; running: boolean }[] =>
    subagentStates().map((s) => ({ sessionId: s.sessionId, running: s.status === 'running' }));

  const replayParent = (
    events: readonly BrainEvent[],
    apply: (event: BrainEvent, fromSnapshot?: boolean, bypassHydration?: boolean, sessionSideEffectApplied?: boolean) => void,
  ): void => {
    for (const event of events) apply(event, false, true, true);
  };

  const openStream = (ac: AbortController): void => {
    const current = (): boolean => !stopped && ac === rt.streamAc && !ac.signal.aborted;
    if (!current()) return;
    const streamSessionAtOpen = client.boundSession;
    let truncatedSnapshotPending = false;
    let pendingSessionReset: string | null = null;
    let lease!: SnapshotLaneLease<BrainEvent>;

    const reconnectForSnapshot = (): void => {
      if (!current()) return;
      const next = new AbortController();
      rt.streamAc = next;
      ac.abort();
      openStream(next);
    };
    lease = hydrator.openLane('parent', ac.signal, { onOverflow: reconnectForSnapshot });

    let refetchHistory = (): void => {};
    const onEvent = (
      event: BrainEvent,
      fromSnapshot = false,
      bypassHydration = false,
      sessionSideEffectApplied = false,
    ): void => {
      if (!current() || !lease.isCurrent()) return;

      // Control snapshots are state outside the transcript and must remain responsive while history is
      // hydrating. They are still fenced by this stream generation before mutation/render.
      if (event.type === 'ask') { flows.launchAsk(event.id, event.questions, event.kind); return; }
      if (event.type === 'queue') { rt.queued = event.items; rt.render('stream:queue'); return; }
      if (event.type === 'process') { rt.processes = event.processes; rt.render('stream:process'); return; }
      if (event.type === 'compacted') { if (!fromSnapshot) refetchHistory(); return; }

      // Binding is control state, not transcript state. Commit it before any hydration buffer can defer
      // or discard the visual reset; replay later applies only TranscriptModel's session semantics.
      if (event.type === 'session' && !sessionSideEffectApplied) {
        rt.invalidateAsyncState?.();
        client.rebind(event.sessionId);
        pendingSessionReset = event.sessionId;
        rt.notice = color.dim('previous conversation was idle — continuing in a fresh one');
        void rt.refreshMeta().then(() => { if (current() && lease.isCurrent()) rt.render('metadata:session-rollover'); });
        rt.render('stream:session-binding');
      }

      if (!bypassHydration) {
        const buffered = lease.buffer(event);
        if (buffered !== 'passthrough') return;
      }

      const repairTruncatedAtIdle = event.type === 'idle' && truncatedSnapshotPending;
      if (event.type === 'idle') {
        if (event.usage) rt.usage = event.usage;
        if (!rt.conversationTitle) {
          void rt.refreshMeta().then(() => { if (current() && lease.isCurrent()) rt.render('metadata:idle-title'); });
        } else void rt.refreshRateLimits();
        if (rt.workMode === 'plan' && !rt.childView) {
          const text = rt.transcript.lastAssistantText();
          if (/<proposed_plan>/i.test(text)) flows.openPlanDecision();
        }
      }
      if (event.type === 'step' && event.usage) rt.usage = event.usage;
      if (event.type === 'card') rt.cards = upsertCard(rt.cards, event.card);
      if (event.type === 'subagent' && event.status !== 'running') {
        void rt.refreshMeta().then(() => { if (current() && lease.isCurrent()) rt.render('metadata:subagent-settled'); });
      }
      rt.transcript.apply(event);
      if (event.type === 'session') pendingSessionReset = null;
      rt.render(`stream:${event.type}`);
      if (repairTruncatedAtIdle) {
        truncatedSnapshotPending = false;
        refetchHistory();
      }
    };

    refetchHistory = (): void => {
      if (!current() || !lease.isCurrent()) return;
      const requestedSession = client.boundSession;
      void lease.hydrate(
        (signal) => client.history(requestedSession, signal),
        {
          commit: (history, replay) => {
            if (!current() || !lease.isCurrent()) return;
            rt.transcript.replaceHistory(history);
            if (pendingSessionReset
              && requestedSession !== pendingSessionReset
              && !replay.some((event) => event.type === 'session')) {
              rt.transcript.apply({ type: 'session', sessionId: pendingSessionReset });
            }
            replayParent(replay, onEvent);
            pendingSessionReset = null;
            clearHydrationNotice('parent');
            rt.render('history:committed');
          },
          retain: (replay, error) => {
            if (!current() || !lease.isCurrent()) return;
            if (pendingSessionReset && !replay.some((event) => event.type === 'session')) {
              rt.transcript.apply({ type: 'session', sessionId: pendingSessionReset });
            }
            replayParent(replay, onEvent);
            pendingSessionReset = null;
            publishHydrationNotice('parent', 'conversation', error);
            rt.render('history:retained');
          },
        },
      );
    };

    const applySnapshot = (snapshot: BrainStreamSnapshot): void => {
      if (!current() || !lease.isCurrent()) return;
      lease.applySnapshot(() => {
        clearHydrationNotice('parent');
        pendingSessionReset = null;
        const terminal = snapshot.events.some((event) => event.type === 'idle' || event.type === 'error');
        if (terminal) truncatedSnapshotPending = false;
        else if (snapshot.truncated) truncatedSnapshotPending = true;
        if (snapshot.sessionId && snapshot.sessionId !== streamSessionAtOpen) {
          rt.invalidateAsyncState?.();
          rt.notice = color.dim('previous conversation was idle — continuing in a fresh one');
          void rt.refreshMeta().then(() => { if (current() && lease.isCurrent()) rt.render('metadata:snapshot-session'); });
        }
        rt.transcript.replaceHistory(snapshot.history);
        for (const event of snapshot.events) onEvent(event, true, true);
        rt.render('stream:snapshot');
      });
    };
    const onFrame = (frame: BrainStreamFrame): void => {
      if (frame.type === 'snapshot') applySnapshot(frame);
      else onEvent(frame);
    };
    const onOpen = (): void => {
      if (!current() || !lease.isCurrent()) return;
      void client.processes().then((processes) => {
        if (!current() || !lease.isCurrent()) return;
        rt.processes = processes;
        rt.render('metadata:processes');
      }).catch(() => { /* offline/403 */ });
    };
    void client.stream(onFrame, ac.signal, 1000, onOpen, undefined, true).catch(() => { /* abort/reconnect owner */ });
  };

  const openSubagent = async (sessionId: string): Promise<void> => {
    if (stopped) return;
    const generation = ++childGeneration;
    rt.childAc?.abort();
    const ac = new AbortController();
    rt.childAc = ac;
    const transcript = new TranscriptModel();
    rt.childView = { sessionId, transcript, get view() { return transcript.view; }, loading: true };
    rt.render('child:opening');

    let resolveHydrated!: () => void;
    let resolved = false;
    const hydrated = new Promise<void>((resolve) => { resolveHydrated = resolve; });
    const finish = (): void => { if (!resolved) { resolved = true; resolveHydrated(); } };
    const current = (): boolean => !stopped
      && !ac.signal.aborted
      && generation === childGeneration
      && rt.childView?.sessionId === sessionId;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    const clearFallback = (): void => {
      if (!fallback) return;
      clearTimeout(fallback);
      childFallbacks.delete(fallback);
      fallback = null;
    };

    let lease!: SnapshotLaneLease<BrainEvent>;
    lease = hydrator.openLane('child', ac.signal, {
      awaitingSnapshot: true,
      onOverflow: () => {
        if (!current()) return;
        finish();
        void openSubagent(sessionId);
      },
    });
    ac.signal.addEventListener('abort', () => { clearFallback(); finish(); }, { once: true });

    let truncatedSnapshotPending = false;
    let loadHistory = (_force?: boolean): void => {};
    const fold = (event: BrainEvent, bypassHydration = false): void => {
      if (!current() || !lease.isCurrent() || !rt.childView) return;
      if (event.type === 'ask') { flows.launchAsk(event.id, event.questions, event.kind); return; }
      if (!bypassHydration) {
        const buffered = lease.buffer(event);
        if (buffered !== 'passthrough') return;
      }
      const repairAtTerminal = truncatedSnapshotPending && (event.type === 'idle' || event.type === 'error');
      rt.childView.transcript.apply(event);
      rt.render(`child:${event.type}`);
      if (repairAtTerminal) {
        truncatedSnapshotPending = false;
        loadHistory(true);
      }
    };

    let historyStarted = false;
    const runChildHistory = (candidate?: BrainMessageView[], prefix: readonly BrainEvent[] = []): void => {
      void lease.hydrate(
        (signal) => client.history(sessionId, signal),
        {
          commit: (history, replay) => {
            if (!current() || !lease.isCurrent() || !rt.childView) return;
            const combined = [...prefix, ...replay];
            const terminal = combined.findLastIndex((event) => event.type === 'idle' || event.type === 'error');
            if (terminal >= 0) {
              // Once a child settled, its buffered run may already be represented by the first GET.
              // Refetch from the newer durable boundary and carry forward only a subsequent run.
              runChildHistory(history, combined.slice(terminal + 1));
              return;
            }
            rt.childView.transcript.replaceHistory(history);
            for (const event of combined) fold(event, true);
            rt.childView.loading = false;
            clearHydrationNotice('child');
            rt.render('child:history');
            finish();
          },
          retain: (replay, error) => {
            if (!current() || !lease.isCurrent() || !rt.childView) return;
            if (candidate) rt.childView.transcript.replaceHistory(candidate);
            for (const event of [...prefix, ...replay]) fold(event, true);
            rt.childView.loading = false;
            publishHydrationNotice('child', 'sub-agent', error);
            rt.render('child:history-retained');
            finish();
          },
        },
      );
    };
    loadHistory = (force = false): void => {
      if ((!force && historyStarted) || !current() || !lease.isCurrent()) return;
      historyStarted = true;
      clearFallback();
      runChildHistory();
    };

    const applySnapshot = (snapshot: BrainStreamSnapshot): void => {
      if (!current() || !lease.isCurrent() || !rt.childView) return;
      lease.applySnapshot(() => {
        clearHydrationNotice('child');
        historyStarted = true;
        clearFallback();
        const terminal = snapshot.events.some((event) => event.type === 'idle' || event.type === 'error');
        if (terminal) truncatedSnapshotPending = false;
        else if (snapshot.truncated) truncatedSnapshotPending = true;
        rt.childView!.transcript.replaceHistory(snapshot.history);
        rt.childView!.loading = false;
        for (const event of snapshot.events) fold(event, true);
        rt.render('child:snapshot');
        finish();
      });
    };

    void client.stream((frame) => {
      if (!current() || !lease.isCurrent()) return;
      if (frame.type === 'snapshot') applySnapshot(frame);
      else fold(frame);
    }, ac.signal, 1000, undefined, sessionId, true).catch(() => {
      if (current()) loadHistory();
    });

    fallback = setTimeout(loadHistory, 2_000);
    childFallbacks.add(fallback);
    if (historyStarted) clearFallback();
    await hydrated;
  };

  const closeSubagent = (): void => {
    childGeneration += 1;
    rt.childAc?.abort();
    rt.childAc = null;
    hydrator.stopLane('child');
    rt.childView = null;
    if (!stopped) rt.render('child:closed');
  };

  const cycleSubagent = (): void => {
    const ring = subagentSessions();
    if (ring.length === 0) { rt.notice = color.dim('no sub-agent in this conversation yet'); rt.render(); return; }
    const at = rt.childView ? ring.findIndex((row) => row.sessionId === rt.childView!.sessionId) : -1;
    const next = ring[at + 1];
    if (next) void openSubagent(next.sessionId);
    else closeSubagent();
  };

  const switchTo = async (target: { session?: string; fresh?: boolean }): Promise<void> => {
    if (stopped) return;
    const generation = ++switchGeneration;
    rt.invalidateAsyncState?.();
    rt.streamAc.abort();
    const ac = new AbortController();
    rt.streamAc = ac;
    const current = (): boolean => !stopped
      && generation === switchGeneration
      && rt.streamAc === ac
      && !ac.signal.aborted;
    let started: { sessionId: string };
    try { started = await client.start(target); }
    catch (error) {
      if (!current()) return;
      // The old stream was paused before selection to prevent cross-session events. A rejected start did
      // not change BrainClient's binding, so reconnect that last valid conversation before surfacing it.
      openStream(ac);
      throw error;
    }
    if (!current()) return;

    const lease = hydrator.openLane('parent', ac.signal, { onOverflow: () => {} });
    await lease.hydrate(
      (signal) => client.history(started.sessionId, signal),
      {
        commit: (history) => { if (current() && lease.isCurrent()) rt.transcript.replaceHistory(history); },
        retain: (_replay, error) => {
          if (!current() || !lease.isCurrent()) return;
          publishHydrationNotice('parent', 'conversation', error);
          rt.render('history:switch-retained');
        },
      },
    );
    if (!current()) return;
    await rt.refreshMeta();
    if (!current()) return;
    openStream(ac);
    rt.render('session:switch');
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    switchGeneration += 1;
    childGeneration += 1;
    rt.streamAc.abort();
    rt.childAc?.abort();
    rt.childAc = null;
    for (const timer of childFallbacks) clearTimeout(timer);
    childFallbacks.clear();
    hydrator.stop();
  };

  return { subagentStates, subagentSessions, openSubagent, closeSubagent, cycleSubagent, openStream, switchTo, stop };
}
