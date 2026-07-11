import { color } from './theme.js';
import { emptyView, fromHistory, reduce, upsertCard } from '../../brain/transcript.js';
import type { BrainEvent } from '../../brain/events.js';
import type { BrainStreamSnapshot } from '../../brain/session/liveEventReplay.js';
import type { BrainStreamFrame } from './brainClient.js';
import type { SubagentPanelEntry } from './components.js';
import type { ChatRuntime } from './runtime.js';
import type { Flows } from './flows.js';

export interface StreamController {
  /** Latest known state of every delegated sub-agent in the parent transcript, in first-seen order —
   *  feeds the live Sub-agents panel and the ctrl+o cycle ring. */
  subagentStates(): SubagentPanelEntry[];
  subagentSessions(): { sessionId: string; running: boolean }[];
  openSubagent(sessionId: string): Promise<void>;
  closeSubagent(): void;
  cycleSubagent(): void;
  openStream(ac: AbortController): void;
  switchTo(target: { session?: string; fresh?: boolean }): Promise<void>;
}

/** The BrainEvent stream side of the chat: the live event fold into the view, session switching and
 *  idle-rollover rebinds, and the interactive sub-agent tap streams (drill-in, cycle, steer). */
export function createStreamController(rt: ChatRuntime, flows: Flows): StreamController {
  const { client } = rt;
  // Monotonic selection token for child drill-in. History requests and stream callbacks can finish out
  // of order; only the newest open/close operation may publish a child view.
  let childGeneration = 0;
  // Same rule for parent conversation switches. /new and session-picker actions are fire-and-forget and
  // can overlap; a late A response must never overwrite the later B selection's bound view or stream.
  let switchGeneration = 0;

  const collectSubagentStates = (): SubagentPanelEntry[] => {
    const seen = new Map<string, SubagentPanelEntry>();
    for (const turn of rt.view.turns) {
      if (turn.role !== 'elowen') continue;
      for (const seg of turn.segments) {
        if (seg.kind !== 'tools') continue;
        for (const item of seg.items) {
          if (!item.sub) continue;
          const s = item.sub;
          seen.set(s.sessionId, { sessionId: s.sessionId, task: s.task, status: s.status, detail: s.detail, tools: s.tools, tokens: s.tokens, seconds: s.seconds, model: s.model });
        }
      }
    }
    return [...seen.values()];
  };
  let subagentProjection = collectSubagentStates();
  const rebuildSubagentProjection = (): void => { subagentProjection = collectSubagentStates(); };
  const updateSubagentProjection = (event: Extract<BrainEvent, { type: 'subagent' }>): void => {
    const next: SubagentPanelEntry = {
      sessionId: event.sessionId,
      task: event.task,
      status: event.status,
      detail: event.detail,
      tools: event.tools,
      tokens: event.tokens,
      seconds: event.seconds,
      model: event.model,
    };
    const index = subagentProjection.findIndex((entry) => entry.sessionId === event.sessionId);
    if (index < 0) subagentProjection = [...subagentProjection, next];
    else {
      subagentProjection = subagentProjection.slice();
      subagentProjection[index] = next;
    }
  };
  const subagentStates = (): SubagentPanelEntry[] => subagentProjection;
  const subagentSessions = (): { sessionId: string; running: boolean }[] =>
    subagentStates().map((s) => ({ sessionId: s.sessionId, running: s.status === 'running' }));

  /** Open a sub-agent's session without a blind history gap. The opt-in SSE's first frame atomically
   *  combines durable history with the bounded, not-yet-persisted live tail. Reconnect snapshots replace
   *  the child view, so replay is idempotent; a generation guard prevents a late A snapshot overwriting B.
   *  The separate history path remains as compatibility fallback for an older daemon/broken stream. */
  const openSubagent = async (sessionId: string): Promise<void> => {
    const generation = ++childGeneration;
    rt.childAc?.abort();
    const ac = new AbortController();
    rt.childAc = ac;
    rt.childView = { sessionId, view: emptyView(), loading: true };
    rt.render();

    let hydrating = true;
    let historyStarted = false;
    let snapshotApplied = false;
    const buffered: BrainEvent[] = [];
    let truncatedSnapshotPending = false;
    let durableRefreshBuffer: BrainEvent[] | null = null;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    let resolveHydrated!: () => void;
    const hydrated = new Promise<void>((resolve) => { resolveHydrated = resolve; });
    ac.signal.addEventListener('abort', () => {
      if (fallback) { clearTimeout(fallback); fallback = null; }
      resolveHydrated();
    }, { once: true });

    const current = (): boolean => !ac.signal.aborted
      && generation === childGeneration
      && rt.childView?.sessionId === sessionId;

    let refreshDurableHistory = (): void => {};

    const fold = (e: BrainEvent): void => {
      if (!current() || !rt.childView) return;
      // A child's parked ask_user_question is answerable from here — the registry is id-keyed globally.
      if (e.type === 'ask') { flows.launchAsk(e.id, e.questions, e.kind); return; }
      if (durableRefreshBuffer) { durableRefreshBuffer.push(e); return; }
      const repairTruncatedAtTerminal = truncatedSnapshotPending && (e.type === 'idle' || e.type === 'error');
      rt.childView.view = reduce(rt.childView.view, e);
      rt.render();
      if (repairTruncatedAtTerminal) {
        truncatedSnapshotPending = false;
        refreshDurableHistory();
      }
    };

    refreshDurableHistory = (): void => {
      if (durableRefreshBuffer || !current()) return;
      durableRefreshBuffer = [];
      void client.history(sessionId, ac.signal)
        .then((history) => {
          if (!current() || !rt.childView) return;
          const replay = durableRefreshBuffer ?? [];
          durableRefreshBuffer = null;
          rt.childView.view = fromHistory(history);
          for (const event of replay) fold(event);
          rt.render();
        })
        .catch(() => {
          // Keep the current (possibly partial) view on a transient GET failure, but do not discard live
          // events that arrived while it was in flight. They still represent newer state than the view.
          const replay = durableRefreshBuffer ?? [];
          durableRefreshBuffer = null;
          for (const event of replay) fold(event);
        });
    };

    const applySnapshot = (snapshot: BrainStreamSnapshot): void => {
      if (!current() || !rt.childView) return;
      snapshotApplied = true;
      historyStarted = true;
      if (fallback) { clearTimeout(fallback); fallback = null; }
      const terminalSnapshot = snapshot.events.some((event) => event.type === 'idle' || event.type === 'error');
      if (terminalSnapshot) truncatedSnapshotPending = false;
      else if (snapshot.truncated) truncatedSnapshotPending = true;
      rt.childView.view = fromHistory(snapshot.history);
      hydrating = false;
      rt.childView.loading = false;
      for (const event of snapshot.events) fold(event);
      rt.render();
      resolveHydrated();
    };

    const loadHistory = (): void => {
      if (historyStarted) return;
      historyStarted = true;
      if (fallback) { clearTimeout(fallback); fallback = null; }
      void client.history(sessionId, ac.signal)
        .then(async (msgs) => {
          if (!current() || snapshotApplied) return;
          let history = msgs;
          let replay = buffered;
          // If the child settled while the first GET was in flight, agent_end may now have persisted the
          // same buffered deltas. Refetch the authoritative settled rows and replay only events AFTER the
          // last idle boundary, avoiding a doubled assistant turn while preserving a subsequent new turn.
          const lastIdle = buffered.findLastIndex((e) => e.type === 'idle');
          if (lastIdle >= 0) {
            history = await client.history(sessionId, ac.signal);
            replay = buffered.slice(lastIdle + 1);
          }
          if (!current() || snapshotApplied || !rt.childView) return;
          rt.childView.view = fromHistory(history);
          hydrating = false;
          rt.childView.loading = false;
          for (const e of replay) fold(e);
          rt.render();
        })
        .catch((e: Error) => {
          if (!current() || snapshotApplied) return;
          hydrating = false;
          if (rt.childView) rt.childView.loading = false;
          // The live tap can still be useful when the stored snapshot failed. Fold what arrived and keep
          // the view open instead of snapping back to the parent with no explanation.
          for (const event of buffered) fold(event);
          rt.notice = color.error(`could not load the sub-agent transcript: ${e.message}`);
          rt.render();
        })
        .finally(resolveHydrated);
    };

    void client.stream((e) => {
      if (!current()) return;
      if (e.type === 'snapshot') { applySnapshot(e); return; }
      if (e.type === 'ask') { flows.launchAsk(e.id, e.questions, e.kind); return; }
      if (hydrating) { buffered.push(e); return; }
      fold(e);
    }, ac.signal, 1000, undefined, sessionId, true).catch(() => {
      // A stream that fails before its first byte must not leave the child stuck on "loading" forever.
      if (current()) loadHistory();
    });
    // Proxies normally flush `: connected` immediately after the server installs the tap. Keep a bounded
    // fallback for broken proxies: history is preferable to an eternal loading screen, while the normal
    // path still guarantees tap-before-history.
    fallback = setTimeout(loadHistory, 2_000);
    // A test/in-memory transport may deliver the snapshot synchronously. In that valid case hydration
    // finished before the fallback assignment above, so cancel the now-redundant timer explicitly.
    if (historyStarted && fallback) { clearTimeout(fallback); fallback = null; }
    await hydrated;
  };

  const closeSubagent = (): void => {
    childGeneration++;
    rt.childAc?.abort();
    rt.childAc = null;
    rt.childView = null;
    rt.render();
  };

  /** ctrl+o: cycle main conversation → sub-agent 1 → sub-agent 2 → … → back to main. */
  const cycleSubagent = (): void => {
    const ring = subagentSessions();
    if (ring.length === 0) { rt.notice = color.dim('no sub-agent in this conversation yet'); rt.render(); return; }
    const at = rt.childView ? ring.findIndex((r) => r.sessionId === rt.childView!.sessionId) : -1;
    const next = ring[at + 1];
    if (next) void openSubagent(next.sessionId);
    else closeSubagent();
  };

  // `ac` is captured by the CALLER at switch time: two rapid switches (`/new` + `/model` mid-roundtrip)
  // both pass their own controller, and the superseded one bails here instead of opening a second live
  // stream on the current signal — which would reduce every event twice (doubled text/cards).
  const openStream = (ac: AbortController): void => {
    const current = (): boolean => ac === rt.streamAc && !ac.signal.aborted;
    if (!current()) return; // a newer switch owns the stream now
    const streamSessionAtOpen = client.boundSession;
    // Passive-client idle rollover: while we refetch the fresh transcript, live events that arrive in
    // the same SSE batch after the `session` frame (or during the in-flight fetch) must NOT fold into
    // the stale pre-rollover view — they'd be silently discarded when fromHistory lands. Buffer them
    // and replay onto the refetched view once history resolves.
    let buffer: BrainEvent[] | null = null;
    // A reconnect snapshot is newer than any in-flight `history()` read. Keep an epoch instead of
    // aborting the read: Browser/undici transports do not consistently cancel a completed response, but
    // an old result must never replace the atomic snapshot that just arrived.
    let historyEpoch = 0;
    // A bounded live replay can omit unsettled entries. The snapshot still gives us the latest usable
    // view, but after its terminal idle the store is the only complete source; refresh then instead of
    // leaving a permanently shortened transcript until the user manually reconnects.
    let truncatedSnapshotPending = false;
    // Refetch the persisted transcript and swap it in, buffering any live events that arrive DURING the
    // in-flight fetch so they replay onto the FRESH view instead of folding into (and being discarded
    // with) the stale one. Single source for the two async-history-swap paths below: the passive idle
    // rollover rebind AND the post-compaction collapse — both refetch history while the stream keeps
    // delivering (an auto-compact is immediately followed by a queued-flush turn whose `user`/text events
    // would otherwise race the fetch and be lost).
    const refetchHistory = (): void => {
      const epoch = ++historyEpoch;
      buffer = [];
      void client.history()
        .then((h) => {
          if (current() && epoch === historyEpoch) {
            rt.view = fromHistory(h);
            rebuildSubagentProjection();
          }
        })
        .catch(() => { /* best-effort: keep the stale view */ })
        .finally(() => {
          if (!current() || epoch !== historyEpoch) return;
          const queued = buffer ?? [];
          buffer = null;
          rt.render();
          for (const ev of queued) onEvent(ev); // replay onto the refetched view (buffer now null)
        });
    };
    const onEvent = (e: BrainEvent, fromSnapshot = false): void => {
      // Abort can race buffered bytes already read from the old socket. Guard every frame, especially a
      // stale rollover `session` event that would otherwise rebind the newly selected conversation.
      if (!current()) return;
      // ask_user_question parked the turn: drive the picker flow and skip the ChatView reducer (the
      // questions aren't a conversation segment). Handled even mid-rollover — it's view-independent.
      if (e.type === 'ask') { flows.launchAsk(e.id, e.questions, e.kind); return; }
      // The pending mid-turn message queue is a full snapshot tracked outside the ChatView (like cards),
      // so it applies immediately even mid-rollover — the `user` delivery event (folded below) is what
      // renders the eventual 'you' turn.
      if (e.type === 'queue') { rt.queued = e.items; rt.render(); return; }
      // Live background-process snapshot (spawn/exit/kill) — a full replace tracked outside the ChatView
      // (like cards/queue), so it applies immediately even mid-rollover. The panel shows only running ones.
      if (e.type === 'process') { rt.processes = e.processes; rt.render(); return; }
      if (buffer) { buffer.push(e); return; } // rollover refetch in flight — replay after it resolves
      // A compaction was persisted server-side (manual /compact or the auto-compact path): the stored
      // transcript is now the "context compacted" divider + the kept tail. Refetch so the on-screen
      // conversation collapses to exactly what the model still holds. Buffered like the rollover rebind —
      // an auto-compact is immediately followed by the queued-flush turn, whose deltas must land on the
      // refetched view, not be thrown away when it resolves. The one-line status is handled separately by
      // the compaction `notice` — this event only rebuilds the transcript.
      // A snapshot already carries the post-compaction durable history. Refetching it again would race
      // that replacement and can discard the snapshot tail; ordinary live compaction events still use
      // the established history-refetch path.
      if (e.type === 'compacted') { if (!fromSnapshot) refetchHistory(); return; }
      const repairTruncatedAtIdle = e.type === 'idle' && truncatedSnapshotPending;
      if (e.type === 'idle') {
        if (e.usage) rt.usage = e.usage;
        // A finished turn may have just auto-titled a fresh conversation — pull the new title (and usage)
        // so the header stops showing "new conversation". Best-effort; a dropped daemon just leaves it.
        // refreshMeta starts the independent rate-limit refresh too; otherwise update only those windows.
        if (!rt.conversationTitle) void rt.refreshMeta().then(() => rt.render('metadata:idle-title'));
        else void rt.refreshRateLimits();
        // Plan mode: the agent just delivered a <proposed_plan> — offer to implement it right away
        // instead of leaving the user to flip modes and phrase the follow-up themselves.
        if (rt.workMode === 'plan' && !rt.childView) {
          const last = rt.view.turns[rt.view.turns.length - 1];
          const text = last?.role === 'elowen' ? last.segments.filter((s) => s.kind === 'text').map((s) => (s as { text: string }).text).join('') : '';
          if (/<proposed_plan>/i.test(text)) flows.openPlanDecision();
        }
      }
      if (e.type === 'step' && e.usage) rt.usage = e.usage;
      if (e.type === 'card') rt.cards = upsertCard(rt.cards, e.card); // update the persistent panel (not part of the ChatView)
      // Sub-agent progress folds into the delegate tool row below; the open child view has its own
      // live tap stream. Once a child settles, refresh status so its now-persisted token cost rolls into
      // the parent's session meter immediately instead of waiting for the next parent turn.
      if (e.type === 'subagent' && e.status !== 'running') void rt.refreshMeta().then(() => rt.render('metadata:subagent-settled'));
      // Idle rollover: the server continued this message in a FRESH conversation. Rebind to the id the
      // event carries so every later call targets the replacement — the OPEN stream needs no reopen (the
      // server carries both the listener and the session tap onto the new session, so events keep flowing
      // without a gap; a reconnect then taps the rebound id). The fold resets the transcript to the empty
      // fresh conversation; the daemon re-emits the triggering message as a `user` event and streams its
      // reply, so both the sending and any passively-connected client rebuild purely from the stream (no
      // history refetch — the fresh session has nothing to refetch, and the `user` event would race it).
      if (e.type === 'session') {
        client.rebind(e.sessionId);
        rt.notice = color.dim('previous conversation was idle — continuing in a fresh one');
        void rt.refreshMeta().then(() => rt.render('metadata:session-rollover'));
      }
      const previousView = rt.view;
      rt.view = reduce(rt.view, e);
      if (e.type === 'subagent' && rt.view !== previousView) updateSubagentProjection(e);
      else if (e.type === 'session') rebuildSubagentProjection();
      rt.render(`stream:${e.type}`);
      if (repairTruncatedAtIdle) {
        truncatedSnapshotPending = false;
        refetchHistory();
      }
    };
    /** A reconnect's first frame is authoritative: replace, never append. Its events are the current
     *  non-durable run tail, so folding them through the normal reducer preserves user/tool ordering and
     *  makes repeated snapshots idempotent. */
    const applySnapshot = (snapshot: BrainStreamSnapshot): void => {
      if (!current()) return;
      // Invalidate any pre-snapshot compaction/rollover fetch and drop the events it was holding: the
      // snapshot was captured after the server installed this tap, and the route forwards every later
      // event after it, so replaying the old local buffer would duplicate output.
      historyEpoch++;
      buffer = null;
      const terminalSnapshot = snapshot.events.some((event) => event.type === 'idle' || event.type === 'error');
      // A terminal snapshot's durable history was captured after agent_end persistence, so it is already
      // whole even if a previous in-flight snapshot was truncated. A running truncated snapshot needs the
      // idle-triggered repair above.
      if (terminalSnapshot) truncatedSnapshotPending = false;
      else if (snapshot.truncated) truncatedSnapshotPending = true;
      if (snapshot.sessionId && snapshot.sessionId !== streamSessionAtOpen) {
        rt.notice = color.dim('previous conversation was idle — continuing in a fresh one');
        void rt.refreshMeta().then(() => rt.render('metadata:snapshot-session'));
      }
      rt.view = fromHistory(snapshot.history);
      rebuildSubagentProjection();
      for (const event of snapshot.events) onEvent(event, true);
      rt.render('stream:snapshot');
    };
    const onFrame = (frame: BrainStreamFrame): void => {
      if (frame.type === 'snapshot') applySnapshot(frame);
      else onEvent(frame);
    };
    // On every (re)connect: the `process` snapshot is push-on-change only, so a spawn/exit that happened
    // during a dropped connection would leave the panel stale — refetch it whenever the stream opens.
    const onOpen = (): void => {
      if (!current()) return;
      void client.processes().then((p) => {
        if (!current()) return;
        rt.processes = p;
        rt.render();
      }).catch(() => { /* offline/403 */ });
    };
    // Parent streams opt into a snapshot on EVERY connection. It closes the otherwise permanent hole
    // between a dropped SSE and the next live event; the child drill-in keeps its independent hydration
    // flow above.
    void client.stream(onFrame, ac.signal, 1000, onOpen, undefined, true).catch(() => { /* aborted/gone */ });
  };

  /** Switch conversations: retarget the server session, then swap history + the event stream. */
  const switchTo = async (target: { session?: string; fresh?: boolean }): Promise<void> => {
    const generation = ++switchGeneration;
    rt.streamAc.abort();
    const ac = new AbortController();
    rt.streamAc = ac;
    const current = (): boolean => generation === switchGeneration && rt.streamAc === ac && !ac.signal.aborted;
    let started: { sessionId: string };
    try { started = await client.start(target); }
    catch (error) { if (!current()) return; throw error; }
    if (!current()) return;
    const hist = await client.history(started.sessionId).catch(() => []);
    if (!current()) return;
    rt.view = fromHistory(hist);
    rebuildSubagentProjection();
    await rt.refreshMeta(); // also refreshes the card panel from the new conversation's status
    if (!current()) return;
    openStream(ac);
    rt.render();
  };

  return { subagentStates, subagentSessions, openSubagent, closeSubagent, cycleSubagent, openStream, switchTo };
}
