import { useRef } from 'react';
import { BASE, elowenClient } from '../../lib/elowenClient';
import { createReconnectController, type ReconnectController } from '../../lib/reconnect';
import { isStreamDataFrame, startStreamWatchdog } from '../../lib/streamWatchdog';
import { STALE_HIDE_MS } from '../../lib/useRevive';
import { HISTORY_PAGE } from './brainChatHistory';
import type {
  AskQuestion,
  BrainCard,
  BrainGoal,
  BrainMessageImage,
  BrainStreamSnapshotFrame,
  BrainUsage,
  ProcessInfo,
  ToolOutputView,
} from '../../lib/types';
import type { WorkflowState } from '../../lib/transcript';

/** How long a freshly opened stream may go without its guaranteed snapshot frame before it is retried. */
const SNAPSHOT_TIMEOUT_MS = 15_000;

type AskFrame = { id: string; questions: AskQuestion[]; kind?: 'approval' };
type SubagentFrame = { id: string; sessionId: string; status: 'running' | 'done' | 'error'; task: string; detail?: string; tools: number; tokens?: number; seconds: number; model?: string };
type WorkflowFrame = { id: string; toolCallId: string; title?: string; status: WorkflowState['status']; nodes: WorkflowState['nodes'] };

interface LiveStreamHandlers {
  connecting: () => void;
  ready: () => void;
  snapshotStart: () => void;
  snapshot: (snapshot: BrainStreamSnapshotFrame) => void;
  text: (delta: string) => void;
  notice: (message: string, done?: boolean) => void;
  error: (message: string) => void;
  session: (sessionId: string) => void;
  reasoning: (delta: string) => void;
  tool: (frame: { name: string; detail?: string; icon?: string; id?: string }) => void;
  toolProgress: (frame: { id: string; text: string }) => void;
  subagent: (frame: SubagentFrame) => void;
  workflow: (frame: WorkflowFrame) => void;
  goal: (goal: BrainGoal | null) => void;
  process: (processes: ProcessInfo[]) => void;
  card: (card: BrainCard) => void;
  queue: (items: { id: string; text: string }[]) => void;
  user: (frame: { text: string; durableId?: string; images?: BrainMessageImage[] }) => void;
  discardUser: (frame: { durableId: string; text: string }) => void;
  compacted: () => void;
  sessionEvent: () => void;
  diff: (diff: string) => void;
  toolOutput: (frame: { output: ToolOutputView; id?: string; plan?: string }) => void;
  toolEnd: (frame: { id?: string; plan?: string }) => void;
  image: (frame: { ref: string; id?: string; caption?: string }) => void;
  file: (frame: { ref: string; name: string; size: number; id?: string; caption?: string }) => void;
  ask: (frame: AskFrame) => void;
  askResolved: (id: string) => void;
  step: (usage?: BrainUsage) => void;
  idle: (usage?: BrainUsage) => void;
}

interface ReadOnlyStreamHandlers {
  snapshot: (snapshot: BrainStreamSnapshotFrame) => void;
  card: (card: BrainCard) => void;
  error: (message: string) => void;
  openError: () => void;
}

interface BrainChatStreamOptions {
  connectRef: { current: () => Promise<void> };
  getGeneration: () => number;
  setReady: (ready: boolean) => void;
  setReconnecting: (active: boolean) => void;
}

export interface BrainChatStream {
  close: () => void;
  openLive: (options: {
    generation: number;
    session: string;
    client: string;
    boundGeneration: number | undefined;
    handlers: LiveStreamHandlers;
  }) => void;
  openReadOnly: (options: {
    generation: number;
    session: string;
    handlers: ReadOnlyStreamHandlers;
  }) => void;
  revive: (hiddenMs: number, attached: boolean, reviveLimitMs: number) => void;
  watch: (attached: () => boolean, limitMs: number) => () => void;
  stop: () => void;
}

export function useBrainChatStream({ connectRef, getGeneration, setReady, setReconnecting }: BrainChatStreamOptions): BrainChatStream {
  const esRef = useRef<EventSource | null>(null);
  /** When the stream last delivered anything — an event or the daemon's heartbeat. The silence watchdog and
   *  the wake-up path both read it off the wall clock, because a frozen page runs no timers. */
  const lastFrameAtRef = useRef(0);
  /** Fires when a stream opened but its guaranteed first frame never arrived. */
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The ONE way back onto a dropped stream. A phone unlock triggers the wake-up, the watchdog and often a
   *  server error frame at once; without a single controller each would mint its own generation and race. */
  const reconnectRef = useRef<ReconnectController | null>(null);

  // Created on first use and kept in a ref, so the whole tab shares ONE controller across re-renders. It
  // always reconnects through `connectRef`, i.e. the freshest closure, never the one captured when the
  // recovery path was registered. A failed attempt is rethrown on purpose: that is what makes the
  // controller back off and try again instead of leaving the chat dead until the user reloads.
  const reconnect = (): ReconnectController => (reconnectRef.current ??= createReconnectController(async () => {
    try { await connectRef.current(); }
    catch (e) { setReady(true); throw e; }
  }, { onActive: setReconnecting }));

  const openLive: BrainChatStream['openLive'] = ({ generation, session, client, boundGeneration, handlers }) => {
    // The identity rides purely as query params — native EventSource cannot set headers, and the daemon
    // parses session/client/generation off the URL (tapping the bound conversation, not the active pointer).
    // `snapshot=1` makes the FIRST frame the hydration: the newest history page plus the running turn's
    // tail, atomic on one server tick. It is what closes the gap a phone lock opens — a native EventSource
    // reconnect replays nothing, and pairing a separate history fetch with this frame would double every
    // steered 'you' bubble, since the server withholds exactly those rows from `history` to replay them as
    // ordering markers in `events`.
    // `heartbeat=1` upgrades the daemon's keep-alive comment to a named frame: SSE comment lines never
    // reach an EventSource, so without it a stream that silently died is indistinguishable from an idle one.
    const params = new URLSearchParams({
      session, client, generation: String(boundGeneration), snapshot: '1', history: String(HISTORY_PAGE), heartbeat: '1',
    });
    const es = new EventSource(`${BASE}/brain/stream?${params.toString()}`);
    // A reconnect mints a fresh stream the daemon assumes is being watched, and the revive path
    // reconnects while still hidden — so re-report presence here or the phone push goes quiet again.
    elowenClient.brainVisibility({ client, hidden: document.hidden });
    lastFrameAtRef.current = Date.now();
    // With `snapshot=1` the first frame is guaranteed, so "the stream opened" finally means "data arrived".
    // If it does not, the connection is broken in a way EventSource will not report — retry it.
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      if (generation !== getGeneration()) return; // a newer connect/switch already took over
      es.close();
      reconnect().retry();
    }, SNAPSHOT_TIMEOUT_MS);
    // The guaranteed first frame normally lands in milliseconds; until it does, the stream looks open but
    // delivers nothing, so the controller shows a reconnecting line until the snapshot retires it.
    handlers.connecting();
    // EVERY frame must prove it belongs to the stream that is still live before it touches anything.
    // `close()` does not unschedule a callback the browser already dispatched, so a frame from a superseded
    // conversation can still run after the next one is open. The identity check also keeps a dead stream
    // from closing the live one or clearing its snapshot timer. Registration is synchronous up to the
    // assignment below, so no frame can arrive before that assignment and the check is safe.
    const onFrame = (type: string, handler: (e: Event) => void): void => {
      es.addEventListener(type, (e) => {
        if (generation !== getGeneration() || es !== esRef.current) return;
        handler(e);
      });
    };
    // The heartbeat carries nothing: its only job is to prove the channel is still alive to the watchdog.
    onFrame('heartbeat', () => { lastFrameAtRef.current = Date.now(); });
    onFrame('snapshot', (e) => {
      lastFrameAtRef.current = Date.now();
      if (snapshotTimerRef.current) { clearTimeout(snapshotTimerRef.current); snapshotTimerRef.current = null; }
      handlers.snapshotStart();
      // A delivered first frame is the only proof the reconnect worked.
      reconnect().succeeded();
      handlers.snapshot(JSON.parse((e as MessageEvent).data) as BrainStreamSnapshotFrame);
    });
    onFrame('text', (e) => handlers.text((JSON.parse((e as MessageEvent).data) as { delta: string }).delta));
    // Runtime notices (retry/compaction) mirror the CLI: show while the phase runs, clear on done.
    onFrame('notice', (e) => { const frame = JSON.parse((e as MessageEvent).data) as { message: string; done?: boolean }; handlers.notice(frame.message, frame.done); });
    onFrame('error', (e) => {
      // EventSource fires generic `error` events on connection drops with no payload. Those are the
      // browser's own auto-reconnect and must be left alone so a plain SSE blip does not end the turn.
      const data = (e as MessageEvent).data;
      if (typeof data !== 'string') return;
      let message: string;
      try { message = (JSON.parse(data) as { message: string }).message; } catch { return; }
      // The server closes after a brain error frame. Close THIS stream by identity, surface the error once,
      // then retry the full connect so brainStart can revive the session. A superseded frame was fenced above.
      es.close();
      handlers.error(message);
      reconnect().retry();
    });
    // Idle rollover rebinds to a fresh conversation WITHOUT bumping the generation, matching BrainClient.
    onFrame('session', (e) => handlers.session((JSON.parse((e as MessageEvent).data) as { sessionId: string }).sessionId));
    onFrame('reasoning', (e) => handlers.reasoning((JSON.parse((e as MessageEvent).data) as { delta: string }).delta));
    // Keep the toolCallId: live progress and final output are folded onto the matching tool pill by id.
    onFrame('tool', (e) => handlers.tool(JSON.parse((e as MessageEvent).data) as { name: string; detail?: string; icon?: string; id?: string }));
    // Live Bash output is a bounded rolling tail; stored history supersedes it after reload.
    onFrame('tool_progress', (e) => handlers.toolProgress(JSON.parse((e as MessageEvent).data) as { id: string; text: string }));
    // Sub-agent and workflow frames attach live progress to their originating tool rows.
    onFrame('subagent', (e) => handlers.subagent(JSON.parse((e as MessageEvent).data) as SubagentFrame));
    onFrame('workflow', (e) => handlers.workflow(JSON.parse((e as MessageEvent).data) as WorkflowFrame));
    // Goal null is authoritative and must be applied unconditionally.
    onFrame('goal', (e) => handlers.goal((JSON.parse((e as MessageEvent).data) as { goal: BrainGoal | null }).goal));
    // Process events are full snapshots pushed on spawn/exit/kill, sharing the hydration query's shape.
    onFrame('process', (e) => handlers.process((JSON.parse((e as MessageEvent).data) as { processes: ProcessInfo[] }).processes));
    onFrame('card', (e) => handlers.card((JSON.parse((e as MessageEvent).data) as { card: BrainCard }).card));
    // Queue events are server-authoritative full snapshots, not deltas.
    onFrame('queue', (e) => handlers.queue((JSON.parse((e as MessageEvent).data) as { items: { id: string; text: string }[] }).items));
    // The daemon authoritatively renders every immediate or queued user turn; the composer never echoes it.
    onFrame('user', (e) => handlers.user(JSON.parse((e as MessageEvent).data) as { text: string; durableId?: string; images?: BrainMessageImage[] }));
    onFrame('discard_user', (e) => handlers.discardUser(JSON.parse((e as MessageEvent).data) as { durableId: string; text: string }));
    onFrame('compacted', handlers.compacted);
    onFrame('session-event', handlers.sessionEvent);
    onFrame('diff', (e) => handlers.diff((JSON.parse((e as MessageEvent).data) as { diff: string }).diff));
    // Final tool output supersedes any live progress tail and may carry a submitted plan.
    onFrame('tool_output', (e) => handlers.toolOutput(JSON.parse((e as MessageEvent).data) as { output: ToolOutputView; id?: string; plan?: string }));
    // A display-less ExitPlanMode carries the submitted plan only on tool_end.
    onFrame('tool_end', (e) => handlers.toolEnd(JSON.parse((e as MessageEvent).data) as { id?: string; plan?: string }));
    // Shared images/files are folded immediately in the same shape durable history later rebuilds.
    onFrame('image', (e) => handlers.image(JSON.parse((e as MessageEvent).data) as { ref: string; id?: string; caption?: string }));
    onFrame('file', (e) => handlers.file(JSON.parse((e as MessageEvent).data) as { ref: string; name: string; size: number; id?: string; caption?: string }));
    onFrame('ask', (e) => handlers.ask(JSON.parse((e as MessageEvent).data) as AskFrame));
    // Resolve by id so a late frame cannot clear the next question.
    onFrame('ask_resolved', (e) => handlers.askResolved((JSON.parse((e as MessageEvent).data) as { id: string }).id));
    // Step usage updates the statusline during a turn. A payload-less legacy frame leaves it unchanged.
    onFrame('step', (e) => {
      let usage: BrainUsage | undefined;
      try { usage = (JSON.parse((e as MessageEvent).data) as { usage?: BrainUsage }).usage; }
      catch { /* step without payload */ }
      handlers.step(usage);
    });
    onFrame('idle', (e) => {
      let usage: BrainUsage | undefined;
      try { usage = (JSON.parse((e as MessageEvent).data) as { usage?: BrainUsage }).usage; }
      catch { /* idle without payload */ }
      handlers.idle(usage);
    });
    esRef.current = es;
    handlers.ready();
  };

  const openReadOnly: BrainChatStream['openReadOnly'] = ({ generation, session, handlers }) => {
    // A drill-in is a READ-ONLY tap on an owned child, not this client's parent attachment. Carrying
    // client+generation would force the generation-bound owned-user branch and reject channel/task children.
    // Generation still fences this controller locally; it is deliberately not a server parameter.
    const params = new URLSearchParams({ session, snapshot: '1', heartbeat: '1' });
    const es = new EventSource(`${BASE}/brain/stream?${params.toString()}`);
    esRef.current = es;
    let snapshotSeen = false;
    // EventSource reuses this object across reconnects. A server error is an open failure unless THIS
    // connection already delivered its snapshot, even when an earlier connection had done so.
    es.addEventListener('open', () => {
      if (generation === getGeneration() && es === esRef.current) snapshotSeen = false;
    });
    const onFrame = (type: string, handler: (e: Event) => void): void => {
      es.addEventListener(type, (e) => {
        if (generation !== getGeneration() || es !== esRef.current) return;
        // Bare native transport errors have no data and prove no liveness. Counting them would let a failed
        // auto-reconnect refresh the silence watchdog forever while no server frame arrives.
        if (isStreamDataFrame(e)) lastFrameAtRef.current = Date.now();
        handler(e);
      });
    };
    onFrame('heartbeat', () => {});
    onFrame('snapshot', (e) => {
      snapshotSeen = true;
      handlers.snapshot(JSON.parse((e as MessageEvent).data) as BrainStreamSnapshotFrame);
    });
    onFrame('card', (e) => handlers.card((JSON.parse((e as MessageEvent).data) as { card: BrainCard }).card));
    onFrame('error', (e) => {
      // Native transport errors have no payload and must leave browser auto-reconnect running.
      const data = (e as MessageEvent).data;
      if (typeof data !== 'string') return;
      let message: string;
      try { message = (JSON.parse(data) as { message: string }).message; } catch { return; }
      // After hydration this is child transcript content. Before hydration it means the requested child could
      // not be resolved, so close the tap and return through the controller's freshest live connect closure.
      if (snapshotSeen) { handlers.error(message); return; }
      es.close();
      handlers.openError();
    });
  };

  return {
    close: () => esRef.current?.close(),
    openLive,
    openReadOnly,
    revive: (hiddenMs, attached, reviveLimitMs) => {
      if (!attached) return;
      const silentMs = Date.now() - lastFrameAtRef.current;
      if (hiddenMs <= STALE_HIDE_MS && silentMs <= reviveLimitMs && esRef.current?.readyState === EventSource.OPEN) return;
      reconnect().now();
    },
    watch: (attached, limitMs) => startStreamWatchdog({
      lastFrameAt: () => lastFrameAtRef.current,
      limitMs,
      onSilent: () => {
        if (!attached() || !esRef.current) return;
        esRef.current.close();
        reconnect().now();
      },
    }),
    stop: () => {
      reconnectRef.current?.stop();
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
      esRef.current?.close();
    },
  };
}
