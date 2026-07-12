import { color } from './theme.js';
import { upsertCard } from '../../brain/transcript.js';
import { TranscriptModel } from '../../brain/transcriptModel.js';
import { SnapshotHydrator, SnapshotTimeoutError, type SnapshotLaneLease } from './snapshotHydrator.js';
import type { BrainEvent } from '../../brain/events.js';
import type { BrainMessageView } from '../../brain/messageView.js';
import type { BrainStreamSnapshot } from '../../brain/session/liveEventReplay.js';
import type { BrainStreamFrame } from './brainClient.js';
import type { SubagentPanelEntry } from './components.js';
import type { ChatState } from './chatState.js';
import type { ChatApplicationActions, ChatApplicationResources } from './chatCapabilities.js';
import type { Flows } from './flows.js';
import { HydrationNoticeOwner } from './hydrationNoticeOwner.js';

const historyNotice = (scope: 'conversation' | 'sub-agent', error: unknown): string => {
  if (error instanceof SnapshotTimeoutError) return color.error(`${scope} transcript history timed out`);
  const message = error instanceof Error ? error.message : String(error);
  return color.error(`could not load the ${scope} transcript: ${message}`);
};

export interface StreamCoordinatorPort {
  subagentStates(): readonly SubagentPanelEntry[];
  openSubagent(sessionId: string): Promise<void>;
  closeSubagent(): void;
  cycleSubagent(): void;
  openStream(ac: AbortController): void;
  restartStream(): void;
  switchTo(target: { session?: string; fresh?: boolean }): Promise<void>;
  stop(): void;
}

/** Application-owned event/hydration coordinator. Parent and child use independent lanes of the one
 * explicitly injected bounded hydrator; all callbacks also capture their stream/session generation. */
export class StreamCoordinator implements StreamCoordinatorPort {
  readonly subagentStates: () => readonly SubagentPanelEntry[];
  readonly openSubagent: (sessionId: string) => Promise<void>;
  readonly closeSubagent: () => void;
  readonly cycleSubagent: () => void;
  readonly openStream: (ac: AbortController) => void;
  readonly restartStream: () => void;
  readonly switchTo: (target: { session?: string; fresh?: boolean }) => Promise<void>;
  readonly stop: () => void;

  constructor(
    rt: ChatState,
    resources: Pick<ChatApplicationResources, 'client'>,
    actions: Pick<ChatApplicationActions, 'render' | 'refreshMeta' | 'refreshRateLimits' | 'invalidateAsyncState'>,
    flows: Flows,
    hydrator: SnapshotHydrator<BrainEvent>,
    hydrationNotices: HydrationNoticeOwner,
  ) {
    const { client } = resources;
    const { render, refreshMeta, refreshRateLimits, invalidateAsyncState } = actions;
    let childGeneration = 0;
    let sessionGeneration = 0;
    let switchingSessionGeneration: number | null = null;
    let stopped = false;
    const childFallbacks = new Set<ReturnType<typeof setTimeout>>();
    const publishHydrationNotice = (lane: 'parent' | 'child', scope: 'conversation' | 'sub-agent', error: unknown): void => {
      rt.notice = hydrationNotices.publish(lane, historyNotice(scope, error), rt.notice);
    };
    const clearHydrationNotice = (lane: 'parent' | 'child'): void => {
      rt.notice = hydrationNotices.clear(lane, rt.notice);
    };
    const teardownChild = (): void => {
      childGeneration += 1;
      rt.childAc?.abort();
      rt.childAc = null;
      hydrator.stopLane('child');
      for (const timer of [...childFallbacks]) clearTimeout(timer);
      childFallbacks.clear();
      rt.childView = null;
      clearHydrationNotice('child');
    };

    const subagentStates = (): readonly SubagentPanelEntry[] => rt.transcript.subagents();
    const subagentSessions = (): { sessionId: string }[] =>
      subagentStates().map(({ sessionId }) => ({ sessionId }));

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
        if (event.type === 'queue') { rt.queued = event.items; render('stream:queue'); return; }
        if (event.type === 'process') { rt.processes = event.processes; render('stream:process'); return; }
        if (event.type === 'compacted') { if (!fromSnapshot) refetchHistory(); return; }

        // Binding is control state, not transcript state. Commit it before any hydration buffer can defer
        // or discard the visual reset; replay later applies only TranscriptModel's session semantics.
        if (event.type === 'session' && !sessionSideEffectApplied) {
          invalidateAsyncState();
          client.rebind(event.sessionId);
          pendingSessionReset = event.sessionId;
          rt.notice = color.dim('previous conversation was idle — continuing in a fresh one');
          void refreshMeta().then(() => { if (current() && lease.isCurrent()) render('metadata:session-rollover'); });
          render('stream:session-binding');
        }

        if (!bypassHydration) {
          const buffered = lease.buffer(event);
          if (buffered !== 'passthrough') return;
        }

        const repairTruncatedAtIdle = event.type === 'idle' && truncatedSnapshotPending;
        if (event.type === 'idle') {
          if (event.usage) rt.usage = event.usage;
          if (!rt.conversationTitle) {
            void refreshMeta().then(() => { if (current() && lease.isCurrent()) render('metadata:idle-title'); });
          } else void refreshRateLimits();
          if (rt.workMode === 'plan' && !rt.childView) {
            const text = rt.transcript.lastAssistantText();
            if (/<proposed_plan>/i.test(text)) flows.openPlanDecision();
          }
        }
        if (event.type === 'step' && event.usage) rt.usage = event.usage;
        if (event.type === 'card') rt.cards = upsertCard(rt.cards, event.card);
        if (event.type === 'subagent' && event.status !== 'running') {
          void refreshMeta().then(() => { if (current() && lease.isCurrent()) render('metadata:subagent-settled'); });
        }
        rt.transcript.apply(event);
        if (event.type === 'session') pendingSessionReset = null;
        render(`stream:${event.type}`);
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
              render('history:committed');
            },
            retain: (replay, error) => {
              if (!current() || !lease.isCurrent()) return;
              if (pendingSessionReset && !replay.some((event) => event.type === 'session')) {
                rt.transcript.apply({ type: 'session', sessionId: pendingSessionReset });
              }
              replayParent(replay, onEvent);
              pendingSessionReset = null;
              publishHydrationNotice('parent', 'conversation', error);
              render('history:retained');
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
            invalidateAsyncState();
            rt.notice = color.dim('previous conversation was idle — continuing in a fresh one');
            void refreshMeta().then(() => { if (current() && lease.isCurrent()) render('metadata:snapshot-session'); });
          }
          rt.transcript.replaceHistory(snapshot.history);
          for (const event of snapshot.events) onEvent(event, true, true);
          render('stream:snapshot');
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
          render('metadata:processes');
        }).catch(() => { /* offline/403 */ });
      };
      void client.stream(onFrame, ac.signal, 1000, onOpen, undefined, true).catch(() => { /* abort/reconnect owner */ });
    };

    const restartStream = (): void => {
      if (stopped) return;
      rt.streamAc.abort();
      const ac = new AbortController();
      rt.streamAc = ac;
      openStream(ac);
    };

    const openSubagent = async (sessionId: string): Promise<void> => {
      if (stopped || switchingSessionGeneration !== null) return;
      const parentGeneration = sessionGeneration;
      teardownChild();
      const generation = childGeneration;
      const ac = new AbortController();
      rt.childAc = ac;
      const transcript = new TranscriptModel();
      rt.childView = { sessionId, transcript, loading: true };
      render('child:opening');

      let resolveHydrated!: () => void;
      let resolved = false;
      const hydrated = new Promise<void>((resolve) => { resolveHydrated = resolve; });
      const finish = (): void => { if (!resolved) { resolved = true; resolveHydrated(); } };
      const current = (): boolean => !stopped
        && !ac.signal.aborted
        && switchingSessionGeneration === null
        && parentGeneration === sessionGeneration
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
        render(`child:${event.type}`);
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
              render('child:history');
              finish();
            },
            retain: (replay, error) => {
              if (!current() || !lease.isCurrent() || !rt.childView) return;
              if (candidate) rt.childView.transcript.replaceHistory(candidate);
              for (const event of [...prefix, ...replay]) fold(event, true);
              rt.childView.loading = false;
              publishHydrationNotice('child', 'sub-agent', error);
              render('child:history-retained');
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
          render('child:snapshot');
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
      teardownChild();
      if (!stopped) render('child:closed');
    };

    const cycleSubagent = (): void => {
      if (stopped || switchingSessionGeneration !== null) return;
      const ring = subagentSessions();
      if (ring.length === 0) { rt.notice = color.dim('no sub-agent in this conversation yet'); render(); return; }
      const at = rt.childView ? ring.findIndex((row) => row.sessionId === rt.childView!.sessionId) : -1;
      const next = ring[at + 1];
      if (next) void openSubagent(next.sessionId);
      else closeSubagent();
    };

    const switchTo = async (target: { session?: string; fresh?: boolean }): Promise<void> => {
      if (stopped) return;
      const generation = ++sessionGeneration;
      switchingSessionGeneration = generation;
      teardownChild();
      invalidateAsyncState();
      rt.streamAc.abort();
      const ac = new AbortController();
      rt.streamAc = ac;
      const current = (): boolean => !stopped
        && generation === sessionGeneration
        && switchingSessionGeneration === generation
        && rt.streamAc === ac
        && !ac.signal.aborted;
      const finishSwitch = (): boolean => {
        if (!current()) return false;
        // A child request can be triggered by input callbacks at any await boundary. Close it again at
        // the commit boundary before child navigation is released for the newly selected parent.
        teardownChild();
        switchingSessionGeneration = null;
        return true;
      };
      let started: { sessionId: string };
      try { started = await client.start(target); }
      catch (error) {
        if (!finishSwitch()) return;
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
          commit: (history) => {
            if (!current() || !lease.isCurrent()) return;
            rt.transcript.replaceHistory(history);
            clearHydrationNotice('parent');
          },
          retain: (_replay, error) => {
            if (!current() || !lease.isCurrent()) return;
            publishHydrationNotice('parent', 'conversation', error);
            render('history:switch-retained');
          },
        },
      );
      if (!current()) return;
      await refreshMeta();
      if (!finishSwitch()) return;
      openStream(ac);
      render('session:switch');
    };

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      sessionGeneration += 1;
      switchingSessionGeneration = null;
      teardownChild();
      rt.streamAc.abort();
      hydrator.stop();
    };

    this.subagentStates = subagentStates;
    this.openSubagent = openSubagent;
    this.closeSubagent = closeSubagent;
    this.cycleSubagent = cycleSubagent;
    this.openStream = openStream;
    this.restartStream = restartStream;
    this.switchTo = switchTo;
    this.stop = stop;
  }
}
