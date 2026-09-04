import { color } from './theme.js';
import { upsertCard } from '../../brain/transcript.js';
import { TranscriptModel } from '../../brain/transcriptModel.js';
import { SnapshotHydrator, SnapshotTimeoutError, type SnapshotLaneLease } from './snapshotHydrator.js';
import type { BrainEvent } from '../../brain/events.js';
import type { BrainMessageView } from '../../brain/messageView.js';
import type { BrainStreamSnapshot } from '../../brain/session/liveEventReplay.js';
import { usageProviderOf } from './brainClient.js';
import type { BrainStreamFrame } from './brainClient.js';
import type { SubagentPanelEntry } from './components.js';
import type { WorkflowState } from '../../brain/transcript.js';
import type { ChatState } from './chatState.js';
import type { ChatApplicationActions, ChatApplicationResources } from './chatCapabilities.js';
import type { Flows } from './flows.js';
import { HydrationNoticeOwner } from './hydrationNoticeOwner.js';
import { InlineArtifactCollection } from './inlineArtifacts.js';

const historyNotice = (scope: 'conversation' | 'sub-agent', error: unknown): string => {
  if (error instanceof SnapshotTimeoutError) return color.error(`${scope} transcript history timed out`);
  const message = error instanceof Error ? error.message : String(error);
  return color.error(`could not load the ${scope} transcript: ${message}`);
};

export interface StreamCoordinatorPort {
  subagentStates(): readonly SubagentPanelEntry[];
  workflowStates(): readonly WorkflowState[];
  openSubagent(sessionId: string): Promise<void>;
  closeSubagent(): void;
  cycleSubagent(): void;
  openStream(ac: AbortController): void;
  restartStream(): void;
  switchTo(target: { session?: string; fresh?: boolean }): Promise<void>;
  stop(): void;
}

/** The foreground work Ctrl+B can detach, counted per kind. Both the key guard (which decides whether to
 *  claim the chord at all, since it is also the editor's backward-character binding) and the action that
 *  runs on dispatch need this same predicate. Written out separately in each, the guard was never taught
 *  about workflows, so a running DAG left the chord falling through to a cursor move — the dispatch that
 *  knew how to detach it was simply never reached.
 *
 *  Only work still BLOCKING the turn counts. The plugin skips already-background items anyway, but
 *  counting them made a conversation whose only workflow was already detached take the "moving work to the
 *  background" path and then report that it had finished or moved — when the honest answer is that there
 *  was nothing in the foreground to move. */
export function foregroundWork(
  stream: StreamCoordinatorPort,
  processes: ChatState['processes'],
): { subagents: number; commands: number; workflows: number; total: number } {
  const subagents = stream.subagentStates().filter((agent) => agent.status === 'running' && agent.background !== true).length;
  const commands = processes.filter((proc) => proc.running && proc.completionMode === 'foreground').length;
  const workflows = stream.workflowStates().filter((workflow) => workflow.status === 'running' && workflow.background !== true).length;
  return { subagents, commands, workflows, total: subagents + commands + workflows };
}

/** Application-owned event/hydration coordinator. Parent and child use independent lanes of the one
 * explicitly injected bounded hydrator; all callbacks also capture their stream/session generation. */
export class StreamCoordinator implements StreamCoordinatorPort {
  readonly subagentStates: () => readonly SubagentPanelEntry[];
  readonly workflowStates: () => readonly WorkflowState[];
  readonly openSubagent: (sessionId: string) => Promise<void>;
  readonly closeSubagent: () => void;
  readonly cycleSubagent: () => void;
  readonly openStream: (ac: AbortController) => void;
  readonly restartStream: () => void;
  readonly switchTo: (target: { session?: string; fresh?: boolean }) => Promise<void>;
  readonly stop: () => void;

  constructor(
    rt: ChatState,
    resources: Pick<ChatApplicationResources, 'client' | 'editor'>,
    actions: Pick<ChatApplicationActions, 'render' | 'refreshMeta' | 'onTurnSettled' | 'onTurnActive' | 'invalidateAsyncState'>,
    flows: Flows,
    hydrator: SnapshotHydrator<BrainEvent>,
    hydrationNotices: HydrationNoticeOwner,
  ) {
    const { client, editor } = resources;
    const { render, refreshMeta, onTurnSettled, onTurnActive, invalidateAsyncState } = actions;
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
    const workflowStates = (): readonly WorkflowState[] => rt.transcript.workflows();
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
        // Settled elsewhere (answered in the web, timed out, or the turn was aborted) — the prompt fans
        // out to every client, so the one that did not answer has to be told to drop it.
        if (event.type === 'ask_resolved') { flows.closeAsk(event.id); return; }
        if (event.type === 'queue') { rt.queued = event.items; render('stream:queue'); return; }
        if (event.type === 'process') { rt.processes = event.processes; render('stream:process'); return; }
        if (event.type === 'goal') { rt.setGoal(event.goal); render('stream:goal'); return; }
        // The background titler landed the generated conversation name — routinely AFTER the idle branch
        // below took its one-shot title refresh (the provisional written at admission already satisfied
        // it). Metadata, not transcript: refetch status so the header and the terminal tab pick the final
        // name up through the same path every other metadata change uses.
        if (event.type === 'title') {
          void refreshMeta().then(() => { if (current() && lease.isCurrent()) render('metadata:title'); });
          return;
        }
        if (event.type === 'compacted') { if (!fromSnapshot) refetchHistory(); return; }
        // Boot recovery finished under this attached stream: whatever this client was shown in the boot
        // window (a workflow the read model could not yet vouch for, a sub-agent's claim) is refetched
        // exactly as on a reconnect — status for the header and rail, history for the transcript.
        if (event.type === 'resync') {
          if (!fromSnapshot) { refetchHistory(); void refreshMeta().then(() => { if (current() && lease.isCurrent()) render('metadata:resync'); }); }
          return;
        }

        // Binding is control state, not transcript state. Commit it before any hydration buffer can defer
        // or discard the visual reset; replay later applies only TranscriptModel's session semantics.
        if (event.type === 'session' && !sessionSideEffectApplied) {
          invalidateAsyncState();
          client.rebind(event.sessionId);
          pendingSessionReset = event.sessionId;
          rt.artifacts.replace([]);
          rt.setGoal(null);
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
          // Turn settled: refresh the rail's rate limits (throttled to the daemon's usage-cache TTL) and
          // stop the long-turn poll. The title branch's refreshMeta covers the first-turn case separately.
          onTurnSettled();
          if (!rt.conversationTitle) {
            void refreshMeta().then(() => { if (current() && lease.isCurrent()) render('metadata:idle-title'); });
          }
          // The decision follows an explicit ExitPlanMode call in the settled turn — prose that merely
          // quotes or discusses a plan can never raise it.
          // Deduplicated by call id inside, because `idle` is not a once-per-plan event: the live journal
          // keeps the terminal `idle` until the next run starts, so every snapshot replay — a reconnect,
          // `/model` restarting the stream, a client attaching after the turn finished — delivers it again
          // over a history that still carries the plan. Without that the picker reopens on a question
          // already answered, and stacks, since overlays opened this way are not deduplicated by name.
          maybeRaisePlanDecision();
        }
        // A parent step means a turn is running — arm the periodic poll for very long turns (idempotent).
        if (event.type === 'step') onTurnActive();
        if (event.type === 'step' && event.usage) rt.usage = event.usage;
        if (event.type === 'card') rt.cards = upsertCard(rt.cards, event.card);
        if (event.type === 'inline_artifact') {
          rt.artifacts.apply(event.artifact);
          render('stream:inline_artifact');
          return;
        }
        if (event.type === 'session-event') {
          void refreshMeta().then(() => { if (current() && lease.isCurrent()) render('metadata:session-event'); });
        }
        if (event.type === 'subagent' && event.status !== 'running') {
          void refreshMeta().then(() => { if (current() && lease.isCurrent()) render('metadata:subagent-settled'); });
        }
        // Esc/Stop-before-output discard: the transcript apply below pulls the 'you' bubble; here restore
        // its text to the composer for editing/resending — but only when the composer is empty, so a
        // discard never clobbers a draft the user already started (mirror of onQueueRecall's "edit wins").
        if (event.type === 'discard_user' && editor.getText().trim() === '') editor.setText(event.text);
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
          const hasIdle = snapshot.events.some((event) => event.type === 'idle');
          const terminal = hasIdle || snapshot.events.some((event) => event.type === 'error');
          if (terminal) truncatedSnapshotPending = false;
          else if (snapshot.truncated) truncatedSnapshotPending = true;
          if (snapshot.sessionId && snapshot.sessionId !== streamSessionAtOpen) {
            invalidateAsyncState();
            rt.artifacts.replace([]);
            rt.setGoal(null);
            rt.notice = color.dim('previous conversation was idle — continuing in a fresh one');
            void refreshMeta().then(() => { if (current() && lease.isCurrent()) render('metadata:snapshot-session'); });
          }
          rt.transcript.replaceHistory(snapshot.history);
          if (snapshot.artifacts) rt.artifacts.replace(snapshot.artifacts);
          for (const event of snapshot.events) onEvent(event, true, true);
          // The bounded replay can lose its terminal idle, but control is taken atomically with history and
          // the journal. Synthesize only that missed control edge: it clears stale Stop state and retires a
          // long-turn poll armed by a replayed step/error, without adding anything to the transcript.
          if (snapshot.control?.streaming === false && !hasIdle) {
            truncatedSnapshotPending = false;
            onEvent({ type: 'idle' }, true, true);
          }
          // Replay is the transient run tail; this top-level value is the durable authority and must win
          // even when the journal was cleared at beginRun()/settleRun(). Absence means an older daemon.
          if (Object.prototype.hasOwnProperty.call(snapshot, 'goal')) rt.setGoal(snapshot.goal ?? null);
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
      rt.childView = { sessionId, model: '', provider: '', providerLabel: '', usageProvider: '', transcript, processes: [], loading: true, usage: null, cards: [], artifacts: new InlineArtifactCollection() };
      render('child:opening');
      let processRevision = 0;

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
        if (event.type === 'ask_resolved') { flows.closeAsk(event.id); return; }
        if (!bypassHydration) {
          const buffered = lease.buffer(event);
          if (buffered !== 'passthrough') return;
        }
        const repairAtTerminal = truncatedSnapshotPending && (event.type === 'idle' || event.type === 'error');
        if (event.type === 'process') { processRevision += 1; rt.childView.processes = event.processes; }
        // Cards and inline artifacts are session sidecars, not transcript turns. Keep both on the child lane
        // so a drilled-in agent can never inherit the parent's panel or media state.
        else if (event.type === 'card') { rt.childView.cards = upsertCard(rt.childView.cards, event.card); }
        else if (event.type === 'inline_artifact') { rt.childView.artifacts.apply(event.artifact); }
        else {
          // The child's lane already carries its own context/cost on every step and idle — the parent lane
          // harvests the identical field. Taking it here is what lets the panel follow the focused agent;
          // the child's snapshot replays through this same fold, so opening one needs no extra fetch (and
          // no fetch is possible: /brain/status rejects a non-user session id).
          if ((event.type === 'idle' || event.type === 'step') && event.usage) rt.childView.usage = event.usage;
          rt.childView.transcript.apply(event);
        }
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
          if (snapshot.session) {
            rt.childView!.model = snapshot.session.model;
            // Public identity for the child's model line, internal pi provider for its usage rail — the
            // same split the parent gets from /brain/status. See BrainStatus.
            rt.childView!.provider = snapshot.session.provider;
            rt.childView!.providerLabel = snapshot.session.providerLabel ?? '';
            rt.childView!.usageProvider = usageProviderOf(snapshot.session);
          }
          rt.childView!.cards = snapshot.cards ?? [];
          if (snapshot.artifacts) rt.childView!.artifacts.replace(snapshot.artifacts);
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

      // Attach SSE first, then reconcile the REST snapshot. If a live process event wins while REST is
      // in flight, its newer revision remains authoritative instead of being overwritten by stale data.
      const requestedAtRevision = processRevision;
      const childProcesses = typeof client.processes === 'function' ? client.processes(sessionId) : Promise.resolve([]);
      void childProcesses.then((processes) => {
        if (!current() || processRevision !== requestedAtRevision || !rt.childView) return;
        rt.childView.processes = processes;
        render('child:processes');
      }).catch(() => { /* child transcript still works while process snapshot is unavailable */ });

      fallback = setTimeout(loadHistory, 2_000);
      childFallbacks.add(fallback);
      if (historyStarted) clearFallback();
      await hydrated;
    };

  /** Put the submitted plan's implement/cancel decision to the user, at most once per ExitPlanMode
   *  call. Called both when a turn settles and when a sub-agent panel closes: a plan that settled
   *  while the panel was open would otherwise never be asked about, because the `idle` that carried
   *  it is long gone by the time the user comes back.
   *
   *  Deliberately NOT gated on the local `rt.workMode`. That mirror is seeded 'build' at boot and only
   *  local keystrokes write it, so it disagrees with the daemon after a CLI restart, a /resume, a
   *  mid-turn mode toggle, or plan mode driven from another surface — and every one of those swallowed
   *  the decision. The plan itself is the proof of plan-pending: a `plan` only ever rides a successful
   *  ExitPlanMode result (the tool refuses outside plan mode with no `details.plan`), the same evidence
   *  statusService.planState trusts on the daemon. Raising the decision realigns the local mode instead,
   *  so "Cancel stays in plan mode for further refinement" holds on every path. */
  const maybeRaisePlanDecision = (): void => {
    if (rt.childView) return;
    const submitted = rt.transcript.lastSubmittedPlan();
    const key = submitted && (submitted.id ?? submitted.plan);
    if (!key || key === rt.planDecisionRaisedFor) return;
    rt.planDecisionRaisedFor = key;
    // The daemon is plan-pending, so the composer's mode chip must say so BEFORE the picker opens: a
    // Cancel (Esc) then leaves the next send stamped 'plan', not whatever the local toggle last held.
    rt.workMode = 'plan';
    if (!stopped) render('stream:plan-decision');
    flows.openPlanDecision();
  };

    const closeSubagent = (): void => {
      teardownChild();
      if (!stopped) render('child:closed');
      maybeRaisePlanDecision();
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
      rt.setGoal(null);
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
    this.workflowStates = workflowStates;
    this.openSubagent = openSubagent;
    this.closeSubagent = closeSubagent;
    this.cycleSubagent = cycleSubagent;
    this.openStream = openStream;
    this.restartStream = restartStream;
    this.switchTo = switchTo;
    this.stop = stop;
  }
}
