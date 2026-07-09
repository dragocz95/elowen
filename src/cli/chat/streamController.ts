import { color } from './theme.js';
import { fromHistory, reduce, upsertCard } from '../../brain/transcript.js';
import type { BrainEvent } from '../../brain/events.js';
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

  const subagentStates = (): SubagentPanelEntry[] => {
    const seen = new Map<string, SubagentPanelEntry>();
    for (const turn of rt.view.turns) {
      if (turn.role !== 'elowen') continue;
      for (const seg of turn.segments) {
        if (seg.kind !== 'tools') continue;
        for (const item of seg.items) {
          if (!item.sub) continue;
          const s = item.sub;
          seen.set(s.sessionId, { sessionId: s.sessionId, task: s.task, status: s.status, detail: s.detail, tools: s.tools, tokens: s.tokens, seconds: s.seconds });
        }
      }
    }
    return [...seen.values()];
  };
  const subagentSessions = (): { sessionId: string; running: boolean }[] =>
    subagentStates().map((s) => ({ sessionId: s.sessionId, running: s.status === 'running' }));

  /** Open a sub-agent's session: history first, then its LIVE tap stream — text/tool/reasoning events
   *  fold into the child view exactly like the main conversation, so steering feels first-class. */
  const openSubagent = async (sessionId: string): Promise<void> => {
    const msgs = await client.history(sessionId).catch(() => null);
    if (!msgs) { rt.notice = color.error('could not load the sub-agent transcript'); rt.render(); return; }
    rt.childAc?.abort();
    const ac = new AbortController();
    rt.childAc = ac;
    rt.childView = { sessionId, view: fromHistory(msgs) };
    rt.render();
    void client.stream((e) => {
      if (ac.signal.aborted || rt.childView?.sessionId !== sessionId) return;
      // A child's parked ask_user_question is answerable from here — the registry is id-keyed globally.
      if (e.type === 'ask') { flows.launchAsk(e.id, e.questions, e.kind); return; }
      rt.childView.view = reduce(rt.childView.view, e);
      rt.render();
    }, ac.signal, 1000, undefined, sessionId).catch(() => { /* aborted/gone */ });
  };

  const closeSubagent = (): void => {
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
    if (ac !== rt.streamAc || ac.signal.aborted) return; // a newer switch owns the stream now
    // Passive-client idle rollover: while we refetch the fresh transcript, live events that arrive in
    // the same SSE batch after the `session` frame (or during the in-flight fetch) must NOT fold into
    // the stale pre-rollover view — they'd be silently discarded when fromHistory lands. Buffer them
    // and replay onto the refetched view once history resolves.
    let buffer: BrainEvent[] | null = null;
    // Refetch the persisted transcript and swap it in, buffering any live events that arrive DURING the
    // in-flight fetch so they replay onto the FRESH view instead of folding into (and being discarded
    // with) the stale one. Single source for the two async-history-swap paths below: the passive idle
    // rollover rebind AND the post-compaction collapse — both refetch history while the stream keeps
    // delivering (an auto-compact is immediately followed by a queued-flush turn whose `user`/text events
    // would otherwise race the fetch and be lost).
    const refetchHistory = (): void => {
      buffer = [];
      void client.history()
        .then((h) => { rt.view = fromHistory(h); })
        .catch(() => { /* best-effort: keep the stale view */ })
        .finally(() => {
          const queued = buffer ?? [];
          buffer = null;
          rt.render();
          for (const ev of queued) onEvent(ev); // replay onto the refetched view (buffer now null)
        });
    };
    const onEvent = (e: BrainEvent): void => {
      // ask_user_question parked the turn: drive the picker flow and skip the ChatView reducer (the
      // questions aren't a conversation segment). Handled even mid-rollover — it's view-independent.
      if (e.type === 'ask') { flows.launchAsk(e.id, e.questions, e.kind); return; }
      // The pending mid-turn message queue is a full snapshot tracked outside the ChatView (like cards),
      // so it applies immediately even mid-rollover — the `user` delivery event (folded below) is what
      // renders the eventual 'you' turn.
      if (e.type === 'queue') { rt.queued = e.items; rt.render(); return; }
      if (buffer) { buffer.push(e); return; } // rollover refetch in flight — replay after it resolves
      // A compaction was persisted server-side (manual /compact or the auto-compact path): the stored
      // transcript is now the "context compacted" divider + the kept tail. Refetch so the on-screen
      // conversation collapses to exactly what the model still holds. Buffered like the rollover rebind —
      // an auto-compact is immediately followed by the queued-flush turn, whose deltas must land on the
      // refetched view, not be thrown away when it resolves. The one-line status is handled separately by
      // the compaction `notice` — this event only rebuilds the transcript.
      if (e.type === 'compacted') { refetchHistory(); return; }
      if (e.type === 'idle') {
        if (e.usage) rt.usage = e.usage;
        // A finished turn may have just auto-titled a fresh conversation — pull the new title (and usage)
        // so the header stops showing "new conversation". Best-effort; a dropped daemon just leaves it.
        if (!rt.conversationTitle) void rt.refreshMeta().then(rt.render);
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
      // live tap stream, so nothing extra to do here.
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
        void rt.refreshMeta().then(rt.render);
      }
      rt.view = reduce(rt.view, e);
      rt.render();
    };
    void client.stream(onEvent, ac.signal).catch(() => { /* aborted/gone */ });
  };

  /** Switch conversations: retarget the server session, then swap history + the event stream. */
  const switchTo = async (target: { session?: string; fresh?: boolean }): Promise<void> => {
    rt.streamAc.abort();
    const ac = new AbortController();
    rt.streamAc = ac;
    await client.start(target);
    const hist = await client.history().catch(() => []);
    rt.view = fromHistory(hist);
    await rt.refreshMeta(); // also refreshes the card panel from the new conversation's status
    openStream(ac);
    rt.render();
  };

  return { subagentStates, subagentSessions, openSubagent, closeSubagent, cycleSubagent, openStream, switchTo };
}
