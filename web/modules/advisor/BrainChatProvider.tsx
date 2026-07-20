'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { useBrainSessions, useBrainCommands } from '../../lib/queries';
import { elowenClient, BASE } from '../../lib/elowenClient';
import type { AskAnswer, AskQuestion, BrainCard, BrainModelOption, BrainUsage, SlashCommandDef, StatuslineConfig } from '../../lib/types';
import { fromHistory, prependHistory, reduce, upsertCard, type ChatTurn, type TranscriptEvent } from '../../lib/transcript';
import { formatTokens, formatCost } from '../../lib/format';
import { getBrainClientId, buildBinding, type BrainBinding } from '../../lib/brainSession';
import {
  BRAIN_COMPOSE_EVENT,
  BRAIN_OPEN_EVENT,
  consumePendingBrainComposer,
  consumePendingBrainSession,
  mergeBrainComposerText,
  type BrainOpenRequest,
} from '../../lib/brainDock';

/** A staged attachment: images travel as base64 to the model's vision input; text files get their
 *  content inlined into the message (fenced), which works with any model. */
interface Attachment { name: string; kind: 'image' | 'text'; mimeType: string; data: string; preview?: string }

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;

async function readAttachment(file: File): Promise<Attachment | null> {
  if (file.type.startsWith('image/')) {
    if (file.size > MAX_IMAGE_BYTES) return null;
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { name: file.name || 'obrazek.png', kind: 'image', mimeType: file.type, data: base64, preview: dataUrl };
  }
  if (file.size > MAX_TEXT_BYTES) return null;
  const text = await file.text();
  if (text.includes('\u0000')) return null; // binary — not inlinable
  return { name: file.name, kind: 'text', mimeType: file.type || 'text/plain', data: text };
}

/** The transcript view-model + fold live in the shared `web/lib/transcript.ts` mirror (kept in lockstep
 *  with the daemon's `src/brain/transcript.ts`) — the SSE handlers fold events through `reduce`, history
 *  loads through `fromHistory`, and cards through `upsertCard`, exactly like the CLI TUI. The controller
 *  keeps its own `busy`/`notice` React state, so `fold` takes only the reducer's resulting turns. */
const fold = (turns: ChatTurn[], e: TranscriptEvent): ChatTurn[] => reduce({ turns, thinking: true }, e).turns;

type Ask = { id: string; questions: AskQuestion[]; kind?: 'approval' };
type SlashItem = { key: string; label: string; desc?: string; run: () => void };

/** The single chat controller value: transcript + draft + attachments + cards + queue + ask + usage +
 *  notice state PLUS the session-scoped mutations. Consumed identically by the dock surface (compact) and
 *  — in a later phase — the full /chat surface. Owned by BrainChatProvider so a Chat↔Terminál toggle or a
 *  route change (which only unmount the presentational surface) never tears down the SSE stream or draft. */
export interface BrainChatValue {
  turns: ChatTurn[];
  busy: boolean;
  ready: boolean;
  notice: string;
  ask: Ask | null;
  cards: BrainCard[];
  agentsOpen: boolean;
  setAgentsOpen: (v: boolean) => void;
  queued: { id: string; text: string }[];
  readOnly: string | null;
  activeSessionId: string | null;
  usage: BrainUsage | null;
  lineCfg: StatuslineConfig | null;
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  attachments: Attachment[];
  addFiles: (files: Iterable<File>) => Promise<void>;
  removeAttachment: (index: number) => void;
  submit: () => Promise<void>;
  switchSession: (opts: { session?: string; fresh?: boolean }) => Promise<void>;
  openReadOnly: (sessionId: string) => Promise<void>;
  exitReadOnly: () => void;
  deleteSession: (id: string, wasActive: boolean) => Promise<void>;
  onQueueRemove: (id: string) => void;
  onAnswer: (id: string, answers: AskAnswer[]) => void;
  /** Explicit Stop intent — aborts the streaming turn for ALL watchers of the bound conversation. Wired
   *  here in Fáze 1; the visible Stop button lands in a later phase (no UX change yet). */
  abort: () => void;
  /** Lazy first-connect: idempotently boots the stream (brainStart → history → status → EventSource). */
  ensureAttached: () => void;
  /** Lazy-load older history: fetches the next backwards page and prepends it. No-op (resolves immediately)
   *  when nothing older remains or a fetch is already in flight. The surface calls it on scroll-up. */
  loadOlder: () => Promise<void>;
  /** Whether an older page of stored history remains to lazy-load (drives the scroll-up sentinel). */
  hasMoreHistory: boolean;
  /** Bumped when the composer should take focus (compose bridge / seeded draft); the surface watches it. */
  focusNonce: number;
  /** The lazily-fetched model catalog (null until first load) — shared by the header ModelPicker and the
   *  composer `/model` slash. `[]` means the RBAC filter stripped every model for this user. */
  models: BrainModelOption[] | null;
  /** The active conversation's model id (from status / a switch) — the picker's trigger label + active mark. */
  currentModel: string;
  /** Switch this conversation to `m` in place (respawn under the same id; no SSE reconnect). */
  setModel: (m: BrainModelOption) => void;
  /** Fetch the catalog on first picker open (idempotent-cheap; re-invoked by the picker's error retry). */
  loadModels: () => void;
  modelsLoading: boolean;
  modelsError: boolean;
  slash: {
    items: SlashItem[];
    open: boolean;
    /** The model picker (level 1) is open — a composer change should dismiss it. */
    modelOptsOpen: boolean;
    clearModelOpts: () => void;
  };
  sessions: ReturnType<typeof useBrainSessions>;
}

const BrainChatContext = createContext<BrainChatValue | null>(null);

/** Read the single chat controller. Throws when used outside <BrainChatProvider> so a missing mount is a
 *  loud programmer error, never a silent dead surface. */
export function useBrainChat(): BrainChatValue {
  const v = useContext(BrainChatContext);
  if (!v) throw new Error('useBrainChat must be used within <BrainChatProvider>');
  return v;
}

/** The controller: owns the whole network + transcript lifecycle for the tab's single chat. Mirrors the
 *  CLI's session binding (src/cli/chat/brainClient.ts) — a stable per-tab clientId, a monotonic generation
 *  bumped on every (re)connect / switch, the bound session threaded through every session-scoped call, and
 *  stale-generation discard on late responses so a superseded A/B switch can't clobber the live view. */
function useBrainChatController(): BrainChatValue {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const sessions = useBrainSessions();
  const { data: commands = [] } = useBrainCommands();

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  // Lazy-load history state: `hasMoreHistory` is reactive (drives the scroll-up sentinel); the cursor and
  // the in-flight guard are refs — they change across async fetches and must not each trigger a re-render.
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const historyCursorRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  // Bumped by EVERY transcript reset/refetch (loadHistory, idle-rollover, read-only). A loadOlder captures
  // it and discards its result if it changed while the fetch was in flight — the connect `generation` guard
  // alone is not enough, because compaction/model-switch/rollover refetch WITHOUT bumping the generation
  // (they keep the one SSE stream), which would otherwise let a stale older page tear a hole in the reset
  // transcript or double the rolled-over turns.
  const historyEpochRef = useRef(0);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [usage, setUsage] = useState<BrainUsage | null>(null);
  const [lineCfg, setLineCfg] = useState<StatuslineConfig | null>(null);
  const [notice, setNotice] = useState('');
  const [ask, setAsk] = useState<Ask | null>(null);
  const [cards, setCards] = useState<BrainCard[]>([]);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [queued, setQueued] = useState<{ id: string; text: string }[]>([]);
  const [readOnly, setReadOnly] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // The model catalog (lazily fetched, RBAC-filtered server-side) — the single source shared by the header
  // ModelPicker and the composer `/model` slash. `modelSlashOpen` is only the composer slash view's toggle,
  // decoupled from the catalog so opening the header picker never pops the composer dropdown.
  const [models, setModels] = useState<BrainModelOption[] | null>(null);
  const [modelSlashOpen, setModelSlashOpen] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(false);
  const [currentModel, setCurrentModel] = useState('');
  const [focusNonce, setFocusNonce] = useState(0);

  // --- Session binding (mirror BrainClient): stable per-tab clientId, monotonic generation, bound id. ---
  const clientIdRef = useRef<string>('');
  const clientId = (): string => clientIdRef.current || (clientIdRef.current = getBrainClientId());
  /** Highest start generation issued this tab (mirror BrainClient.startGeneration). */
  const genRef = useRef(0);
  /** The generation that committed `boundSession` (mirror BrainClient.boundGeneration). */
  const boundGenRef = useRef<number | undefined>(undefined);
  /** The conversation this controller is bound to (mirror BrainClient.bound). */
  const boundSessionRef = useRef<string | undefined>(undefined);
  const esRef = useRef<EventSource | null>(null);
  /** ensureAttached idempotency: once true the stream stays live for the tab's life. */
  const attachedRef = useRef(false);

  const nextGeneration = (): number => (genRef.current += 1);
  const binding = (): BrainBinding => buildBinding(boundSessionRef.current, boundGenRef.current, clientId());
  const bumpFocus = (): void => setFocusNonce((n) => n + 1);

  // The newest page bootstraps the transcript; older pages lazy-load on scroll-up. A full refetch (compaction
  // / model-switch markers) re-runs this, which correctly RESETS the lazy-load window to the tail — the
  // stored transcript changed, so any older cursor is stale.
  const HISTORY_PAGE = 50;
  const loadHistory = async (generation: number): Promise<void> => {
    const epoch = ++historyEpochRef.current; // this reset invalidates any older page still in flight
    const page = await elowenClient.brainMessagesPage(boundSessionRef.current, { limit: HISTORY_PAGE });
    if (generation !== genRef.current || epoch !== historyEpochRef.current) return; // superseded — don't clobber
    setTurns(fromHistory(page.items).turns);
    historyCursorRef.current = page.nextBefore;
    setHasMoreHistory(page.hasMore);
  };

  // Fetch the next older page and prepend it. Guarded against concurrent runs (a fast scroll fires scroll
  // events in bursts), a stale generation (session switch), AND a stale epoch (a compaction/rollover refetch
  // reset the transcript mid-fetch — those keep the generation, so the epoch is what discards this page
  // instead of tearing a hole in the reset transcript). `prependHistory` dedupes by id and leaves the live
  // streaming tail untouched, so a prepend mid-turn is safe.
  const loadOlder = async (): Promise<void> => {
    if (loadingOlderRef.current || historyCursorRef.current === null) return;
    loadingOlderRef.current = true;
    const generation = genRef.current;
    const epoch = historyEpochRef.current;
    const before = historyCursorRef.current;
    try {
      const page = await elowenClient.brainMessagesPage(boundSessionRef.current, { limit: HISTORY_PAGE, before });
      if (generation !== genRef.current || epoch !== historyEpochRef.current) return; // switch/reset superseded this
      setTurns((cur) => prependHistory({ turns: cur, thinking: false }, page.items).turns);
      historyCursorRef.current = page.nextBefore;
      setHasMoreHistory(page.hasMore);
    } finally {
      loadingOlderRef.current = false;
    }
  };

  // Boot (resume) the brain, load history, open the stream — bound to the conversation start() resolves.
  // Re-runs on every session switch / reconnect. `opts` selects which conversation (default: resume the
  // caller's active one). Late responses from a superseded generation are discarded (stale-gen guard).
  const connect = async (opts: { session?: string; fresh?: boolean } = {}): Promise<void> => {
    esRef.current?.close();
    setReady(false);
    setNotice(''); // a fresh connection (mount / session switch) starts without a stale runtime line
    setAsk(null); // drop any parked question from the previous conversation
    setCards([]); // and any cards from the previous conversation
    setQueued([]); // and any pending mid-turn queue from the previous conversation
    const generation = nextGeneration();
    const started = await elowenClient.brainStart(opts, { client: clientId(), generation });
    if (generation !== genRef.current) return; // a newer connect/switch superseded this one
    // Commit the binding only when still current (out-of-order A/B switch guard, mirror BrainClient :168).
    boundSessionRef.current = started.sessionId;
    boundGenRef.current = generation;
    await loadHistory(generation);
    if (generation !== genRef.current) return;
    const st = await elowenClient.brainStatus(boundSessionRef.current).catch(() => null);
    if (generation !== genRef.current) return;
    if (st) { setUsage(st.usage); setLineCfg(st.statusline); setActiveSessionId(st.sessionId); setCurrentModel(st.model); if (st.pendingAsk) setAsk(st.pendingAsk); setCards(st.cards ?? []); setQueued(st.queued ?? []); }
    // The identity rides purely as query params — native EventSource cannot set headers, and the daemon
    // parses session/client/generation off the URL (tapping the bound conversation, not the active pointer).
    const params = new URLSearchParams({ session: boundSessionRef.current, client: clientId(), generation: String(boundGenRef.current) });
    const es = new EventSource(`${BASE}/brain/stream?${params.toString()}`);
    es.addEventListener('text', (e) => {
      const { delta } = JSON.parse((e as MessageEvent).data) as { delta: string };
      setNotice(''); // first answer text clears any transient runtime notice
      setTurns((cur) => fold(cur, { type: 'text', delta }));
    });
    // Runtime notices (retry/compaction) — mirror the CLI: show while the phase runs, clear on done.
    es.addEventListener('notice', (e) => {
      const { message, done } = JSON.parse((e as MessageEvent).data) as { message: string; done?: boolean };
      setNotice(done ? '' : message);
    });
    es.addEventListener('error', (e) => {
      // EventSource fires generic 'error' events on connection drops with no payload — those are the
      // browser's own auto-reconnect, leave them be (a plain SSE blip must let the turn survive). Only the
      // brain's error frames carry a JSON body.
      const data = (e as MessageEvent).data;
      if (typeof data !== 'string') return;
      let message: string;
      try { message = (JSON.parse(data) as { message: string }).message; } catch { return; }
      // The server closes the stream after an error frame (e.g. "brain not started" post-restart); close
      // our side too so EventSource stops re-firing the same frame, surface it once as a notice, and retry
      // the full connect (which re-runs brainStart and revives the session) shortly. A superseded
      // reconnect (a newer switch bumped the generation meanwhile) is discarded so it can't revive a dead
      // session's view. If the brain is still down, brainStart throws and the retry stops — no tight loop.
      esRef.current?.close();
      setBusy(false);
      setNotice(message);
      setTimeout(() => {
        if (generation !== genRef.current) return; // a newer connect/switch already took over
        void connect().then(() => setNotice('')).catch(() => setReady(true));
      }, 2000);
    });
    // Idle rollover: the server continued the just-sent message in a FRESH conversation (the previous one
    // sat idle past the cutoff). REBIND to the replacement WITHOUT bumping the generation (mirror
    // BrainClient.rebind) so a reconnect after rollover taps the new conversation. Every client — sender
    // and passive alike — resets to the empty fresh conversation and rebuilds from the stream, because the
    // daemon re-emits the triggering message as a `user` event and streams its reply.
    es.addEventListener('session', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as { sessionId: string };
      boundSessionRef.current = ev.sessionId; // rebind (generation preserved)
      setActiveSessionId(ev.sessionId); // the conversation rolled over — the panel's local/foreign split moves with it
      setCards([]); // display cards belonged to the previous conversation
      // The rollover empties the transcript and rebuilds the fresh conversation purely from the stream, so
      // close the lazy-load window (+ bump the epoch to discard any older page in flight). Otherwise a stale
      // cursor would page the NEW session's own just-shown turns and double them.
      historyCursorRef.current = null;
      setHasMoreHistory(false);
      historyEpochRef.current++;
      setTurns((cur) => fold(cur, { type: 'session', sessionId: ev.sessionId }));
      setNotice(t.brainChat.freshConversation);
      void qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    });
    es.addEventListener('reasoning', (e) => {
      const { delta } = JSON.parse((e as MessageEvent).data) as { delta: string };
      setTurns((cur) => fold(cur, { type: 'reasoning', delta }));
    });
    es.addEventListener('tool', (e) => {
      // Keep `id` (the toolCallId): it keys the live `tool_progress` tail onto its in-progress tool pill.
      const { name, detail, icon, id } = JSON.parse((e as MessageEvent).data) as { name: string; detail?: string; icon?: string; id?: string };
      setTurns((cur) => fold(cur, { type: 'tool', name, detail, icon, id }));
    });
    // Live streamed output of a running Bash (bounded rolling tail): fold onto its tool pill by id so a
    // long build/test shows output as it runs. The stored history's final output supersedes it on reload.
    es.addEventListener('tool_progress', (e) => {
      const { id, text } = JSON.parse((e as MessageEvent).data) as { id: string; text: string };
      setTurns((cur) => fold(cur, { type: 'tool_progress', id, text }));
    });
    // Live sub-agent progress (delegate): fold onto its tool item so the agents table + drill-in read it.
    es.addEventListener('subagent', (e) => {
      const s = JSON.parse((e as MessageEvent).data) as { id: string; sessionId: string; status: 'running' | 'done' | 'error'; task: string; detail?: string; tools: number; tokens?: number; seconds: number; model?: string };
      setTurns((cur) => fold(cur, { type: 'subagent', ...s }));
      // The child usage is persisted before its terminal progress event. Refresh the parent status now
      // so the session price includes delegated work immediately, not only after the next parent turn.
      if (s.status !== 'running') void elowenClient.brainStatus(boundSessionRef.current).then((status) => { if (generation === genRef.current) setUsage(status.usage); }).catch(() => { /* best-effort */ });
    });
    es.addEventListener('card', (e) => {
      const { card } = JSON.parse((e as MessageEvent).data) as { card: BrainCard };
      // The terminal plugin's background-process card is rendered by ProcessPanel (API-driven, with kill +
      // output modal), not as a plain CardBlock — use it only as a signal to refresh the process list.
      if (card.id === 'bg-processes') { void qc.invalidateQueries({ queryKey: ['brain-processes'] }); return; }
      setCards((cur) => upsertCard(cur, card));
    });
    // Full-snapshot pending mid-turn queue (messages sent while a turn streams). Server-authoritative:
    // replace wholesale — the optimistic remove must never fight an incoming snapshot.
    es.addEventListener('queue', (e) => {
      const { items } = JSON.parse((e as MessageEvent).data) as { items: { id: string; text: string }[] };
      setQueued(items);
    });
    // The daemon's authoritative render of the user's turn (every real send — immediate or a queued
    // delivery). The composer never echoes optimistically, so THIS folds the 'you' bubble; a reply is now
    // streaming, so flip busy on for the thinking indicator.
    es.addEventListener('user', (e) => {
      const { text } = JSON.parse((e as MessageEvent).data) as { text: string };
      setBusy(true);
      setTurns((cur) => fold(cur, { type: 'user', text }));
    });
    // A context compaction was persisted server-side (manual /compact or the auto-compact path): the
    // stored transcript is now a "context compacted" divider + the kept tail. Refetch so the surface
    // collapses to exactly what the model still holds. The one-line status rides the `notice` event.
    es.addEventListener('compacted', () => {
      void loadHistory(genRef.current).catch(() => { /* transcript refetch is best-effort */ });
    });
    // An owner-driven in-place session change (model switch, mode, reasoning, rename): the server persisted
    // a display marker + respawned the session under the SAME id, so the stream stays open. Refetch history
    // (renders the "model → X" marker + any drained partial turn) and status (model/usage label), WITHOUT
    // reconnecting — this is exactly what keeps every attached client on one stream through a model switch.
    es.addEventListener('session-event', () => {
      void loadHistory(genRef.current).catch(() => { /* transcript refetch is best-effort */ });
      void elowenClient.brainStatus(boundSessionRef.current)
        .then((st) => { if (generation === genRef.current) { setUsage(st.usage); setLineCfg(st.statusline); setCurrentModel(st.model); } })
        .catch(() => { /* status refresh is best-effort */ });
    });
    es.addEventListener('diff', (e) => {
      const { diff } = JSON.parse((e as MessageEvent).data) as { diff: string };
      setTurns((cur) => fold(cur, { type: 'diff', diff }));
    });
    // AskUserQuestion parked the turn — render the inline choice card until the user answers.
    es.addEventListener('ask', (e) => {
      const { id, questions, kind } = JSON.parse((e as MessageEvent).data) as { id: string; questions: AskQuestion[]; kind?: 'approval' };
      setAsk({ id, questions, kind });
    });
    es.addEventListener('idle', (e) => {
      setBusy(false);
      setNotice(''); // turn settled → drop any transient runtime line
      setAsk(null); // a settled turn can't still be waiting on a question
      setTurns((cur) => fold(cur, { type: 'idle' })); // finalize the streaming turn (parity with the CLI fold)
      try {
        const { usage: u } = JSON.parse((e as MessageEvent).data) as { usage?: BrainUsage };
        if (u) setUsage(u);
      } catch { /* idle without payload — statusline just stays put */ }
      void qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    });
    esRef.current = es;
    setReady(true);
  };

  // Route a "open this session" request: a continuable one (own web/CLI conversation) is resumed live;
  // a non-continuable one (shared Discord channel / task worker) opens read-only.
  const openRequest = (req: BrainOpenRequest): Promise<void> =>
    req.continuable ? switchSession({ session: req.sessionId }) : openReadOnly(req.sessionId);

  const switchSession = async (opts: { session?: string; fresh?: boolean }): Promise<void> => {
    setReadOnly(null); // leaving any read-only preview
    await connect(opts);
    await qc.invalidateQueries({ queryKey: ['brain-sessions'] });
  };

  const submit = async (): Promise<void> => {
    const typed = input.trim();
    // A message sent mid-turn is STEERED into the running turn via PI's steering queue — the composer
    // stays live. The DAEMON renders every user turn authoritatively (the `user` stream event), so there
    // is NO optimistic local echo — a mid-turn send that queues can't drop or double-render.
    if (!typed && attachments.length === 0) return;
    const textFiles = attachments.filter((a) => a.kind === 'text');
    const images = attachments.filter((a) => a.kind === 'image').map((a) => ({ data: a.data, mimeType: a.mimeType }));
    // A plugin prompt command (`/review auth…`) rides RAW: the daemon hands the slash to PI, which expands
    // the template's arguments natively — same contract as the CLI. Built-ins/plain text pass through too.
    const text = [
      typed || t.brainChat.attachOnly,
      ...textFiles.map((a) => `\n\`${a.name}\`:\n\`\`\`\n${a.data}\n\`\`\``),
    ].join('\n');
    const shown = [typed || t.brainChat.attachOnly, ...attachments.map((a) => `📎 ${a.name}`)].join('\n');
    const submittedInput = input;
    const submittedAttachments = attachments;
    setInput('');
    setAttachments([]);
    // No optimistic bubble: the daemon streams a `user` event (which flips busy on + renders the 'you'
    // turn) for both an immediate run and a queued delivery. `shown` rides as the clean display. The
    // binding lands the turn in THIS controller's conversation regardless of the server's active pointer.
    // If the daemon rejects the request, restore this draft unless the user already started a newer one.
    try { await elowenClient.brainSend(text, images, shown, binding()); }
    catch {
      setInput((current) => current || submittedInput);
      setAttachments((current) => current.length ? current : submittedAttachments);
      toast(t.brainChat.sendError, 'error');
    }
  };

  // View a non-continuable session (a shared Discord channel or a task worker) read-only: load its stored
  // history, show it, and swap the composer for an exit banner. No live stream is opened. Bumping the
  // generation discards any in-flight connect so it can't clobber the read-only view.
  const openReadOnly = async (sessionId: string): Promise<void> => {
    esRef.current?.close();
    nextGeneration();
    setAsk(null); setCards([]); setBusy(false); setNotice('');
    setReadOnly(sessionId);
    // Read-only previews (a channel / task worker) load their full stored history in one shot — no scroll-up
    // lazy-load — so close the window: null cursor + no "more" (+ bump the epoch to discard an in-flight page).
    historyCursorRef.current = null;
    setHasMoreHistory(false);
    historyEpochRef.current++;
    const msgs = await elowenClient.brainMessages(sessionId);
    setTurns(fromHistory(msgs).turns);
    setReady(true);
  };

  // Leave the read-only preview and return to the live active conversation.
  const exitReadOnly = (): void => { setReadOnly(null); void connect(); };

  const deleteSession = async (id: string, wasActive: boolean): Promise<void> => {
    await elowenClient.brainDeleteSession(id).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    // Deleting the open conversation re-targets to the most recent remaining one (or a fresh state).
    if (wasActive) await connect();
  };

  const addFiles = async (files: Iterable<File>): Promise<void> => {
    for (const f of files) {
      const a = await readAttachment(f).catch(() => null);
      if (!a) { toast(t.brainChat.attachTooBig, 'error'); continue; }
      setAttachments((cur) => {
        if (a.kind === 'image' && cur.filter((x) => x.kind === 'image').length >= MAX_IMAGES) return cur;
        return [...cur, a];
      });
    }
  };
  const removeAttachment = (index: number): void => setAttachments((cur) => cur.filter((_, j) => j !== index));

  const onQueueRemove = (id: string): void => {
    setQueued((cur) => cur.filter((x) => x.id !== id));
    void elowenClient.brainQueueRemove(id, boundSessionRef.current).catch(() => undefined);
  };
  const onAnswer = (id: string, answers: AskAnswer[]): void => { void elowenClient.brainAnswer(id, answers).catch(() => undefined); setAsk(null); };
  const abort = (): void => { void elowenClient.brainAbort(boundSessionRef.current).catch(() => undefined); };

  // --- Slash menu (mirrors the CLI palette; single source of truth = GET /brain/commands). ---
  const slashQuery = input.startsWith('/') && !/\s/.test(input) ? input.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery !== null ? commands.filter((c) => c.name.startsWith(slashQuery)) : [];
  // Fetch the model catalog once for either entry point (header picker / `/model` slash). Never throws:
  // an empty catalog is the RBAC "no allowed model" state, a rejection is the provider-error state.
  const loadModels = async (): Promise<void> => {
    setModelsError(false);
    setModelsLoading(true);
    try { setModels(await elowenClient.brainModels()); }
    catch { setModels(null); setModelsError(true); }
    finally { setModelsLoading(false); }
  };
  // Switch this conversation's model IN PLACE: the daemon respawns under the same id and pushes a
  // `session-event` that reconciles every attached client — so NO connect()/EventSource teardown here.
  // The initiator updates its own model label immediately (covers an empty conversation that emits no
  // marker). The bound session is unchanged, so the SSE stream stays open on the same generation.
  // The composer draft is left untouched: this runs from the header/dock picker too, where the user may
  // have unsent text typed — only the slash entry clears the input (when it opens the picker list).
  const runModel = async (m: BrainModelOption): Promise<void> => {
    setModelSlashOpen(false);
    try {
      const { model } = await elowenClient.brainSetModel({ provider: m.provider, model: m.model }, boundSessionRef.current);
      setCurrentModel(model);
      toast(`${t.brainChat.modelSwitched} ${model}`, 'ok');
    } catch (e) { toast((e as Error).message ?? 'error', 'error'); }
  };
  const runSlash = async (cmd: SlashCommandDef): Promise<void> => {
    if (cmd.name === 'model') { setInput(''); setModelSlashOpen(true); void loadModels(); return; }
    setInput('');
    try {
      if (cmd.name === 'new') { await switchSession({ fresh: true }); return; }
      if (cmd.name === 'status') {
        const s = await elowenClient.brainStatus(boundSessionRef.current); const u = s.usage;
        const parts = [s.model && `model: ${s.model}`, u?.percent != null && `context ${Math.round(u.percent)}%`, u && `Σ ${formatTokens(u.totalTokens)} tok`, u && formatCost(u.cost, 2)].filter(Boolean) as string[];
        toast(parts.join('  ·  ') || t.brainChat.noSession, 'ok'); return;
      }
      if (cmd.name === 'help') { toast(commands.map((c) => `/${c.name}`).join('  '), 'ok'); return; }
      // Inspect loaded skills — list the invocable /skill:name commands (PI expands them on send).
      if (cmd.name === 'skills') { const sk = await elowenClient.pluginSkills(); toast(sk.length ? sk.map((s) => `/skill:${s.name}`).join('  ') : t.skills.empty, 'ok'); return; }
      // A prompt macro usually wants arguments — picking it pre-fills the composer (`/review `) so the
      // user types them and submits; the submit path expands the template (args or not).
      if (cmd.kind === 'prompt') { setInput(`/${cmd.name} `); return; }
      if (cmd.kind === 'action') { const r = await elowenClient.brainCommand(cmd.name, boundSessionRef.current); toast(r.message ?? `/${cmd.name}`, 'ok'); return; }
      toast(`/${cmd.name}`, 'ok');
    } catch (e) { toast((e as Error).message ?? String(e), 'error'); }
  };
  const slashItems: SlashItem[] = modelSlashOpen
    ? (models ?? []).map((m) => ({ key: `${m.provider}/${m.model}`, label: m.model, desc: m.providerLabel, run: () => void runModel(m) }))
    : slashMatches.map((c) => ({ key: c.name, label: `/${c.name}`, desc: c.description, run: () => void runSlash(c) }));

  // --- Lazy attach + the cross-mount bridge (session/composer requests + live BRAIN_* events). ---
  const ensureAttached = (): boolean => {
    if (attachedRef.current) return false;
    attachedRef.current = true;
    // If another view asked to open a specific session (Sessions → open in chat), open THAT one instead of
    // the default active conversation; otherwise boot the active conversation as usual. A pending composer
    // draft (dashboard/launcher) seeds the input + focuses.
    const pending = consumePendingBrainSession();
    const pendingText = consumePendingBrainComposer();
    if (pendingText !== null) { setInput(pendingText); requestAnimationFrame(bumpFocus); }
    const boot = pending ? openRequest(pending) : connect();
    void boot.catch(() => setReady(true)); // surface the input even if the brain is unwired
    return true;
  };

  // Keep the live event handlers pointed at the freshest closures (state like readOnly / t) without
  // re-registering the window listeners on every render.
  const onOpenRef = useRef<(req: BrainOpenRequest | undefined) => void>(() => {});
  onOpenRef.current = (req) => {
    // If this is the first open (nothing mounted yet), ensureAttached boots WITH the pending request.
    if (ensureAttached()) return;
    consumePendingBrainSession(); // this controller handles it live → clear the pending bridge
    if (req?.sessionId) void openRequest(req).catch(() => toast(t.brainChat.searchOpenError, 'error'));
  };
  const onComposeRef = useRef<(text: string | undefined) => void>(() => {});
  onComposeRef.current = (detailText) => {
    if (ensureAttached()) return; // first open boots with the pending composer draft + focus
    const bridged = consumePendingBrainComposer();
    const requestedText = bridged ?? detailText ?? '';
    // An empty launcher request means "focus". A non-empty dashboard request is appended to an existing
    // draft so opening the shared composer can never silently destroy unsent text.
    if (requestedText) setInput((current) => mergeBrainComposerText(current, requestedText));
    if (readOnly) {
      // A read-only preview has closed its EventSource and replaced the personal transcript. Reconnect
      // before showing the composer so the seeded draft and the stream target the same conversation.
      setReadOnly(null);
      void connect().then(bumpFocus).catch(() => { setReady(true); bumpFocus(); });
    } else {
      bumpFocus();
    }
  };

  useEffect(() => {
    const onOpen = (e: Event) => onOpenRef.current((e as CustomEvent<BrainOpenRequest>).detail);
    const onCompose = (e: Event) => onComposeRef.current((e as CustomEvent<{ text?: string }>).detail?.text);
    window.addEventListener(BRAIN_OPEN_EVENT, onOpen);
    window.addEventListener(BRAIN_COMPOSE_EVENT, onCompose);
    return () => {
      window.removeEventListener(BRAIN_OPEN_EVENT, onOpen);
      window.removeEventListener(BRAIN_COMPOSE_EVENT, onCompose);
    };
  }, []);

  // Detach-unless-last on tab close: abort THIS client's run and dispose the live session only when it is
  // the final attachment. Only a genuine unload (pagehide) fires it — a tab switch or a plain SSE blip
  // must NOT stop the session, so the streaming turn survives. A missed beacon just leaves an orphan live
  // session, which Fáze 0 accepts (idle-rollover / restart reaps it).
  useEffect(() => {
    const onPageHide = () => {
      if (!attachedRef.current || !boundSessionRef.current) return;
      elowenClient.brainSessionStop({ session: boundSessionRef.current, client: clientId(), generation: genRef.current });
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tear the stream down when the whole provider unmounts (app teardown), matching today's cleanup.
  useEffect(() => () => esRef.current?.close(), []);

  return {
    turns, busy, ready, notice, ask, cards, agentsOpen, setAgentsOpen, queued, readOnly, activeSessionId,
    usage, lineCfg, input, setInput, attachments, addFiles, removeAttachment, submit, switchSession,
    openReadOnly, exitReadOnly, deleteSession, onQueueRemove, onAnswer, abort, ensureAttached, loadOlder, hasMoreHistory, focusNonce,
    models, currentModel, setModel: (m) => void runModel(m), loadModels: () => void loadModels(), modelsLoading, modelsError,
    slash: { items: slashItems, open: slashItems.length > 0, modelOptsOpen: modelSlashOpen, clearModelOpts: () => setModelSlashOpen(false) },
    sessions,
  };
}

/** Mount ONCE (in ShellLayout, above the route content and the dock) so the single chat controller — SSE
 *  stream, transcript, draft, attachments, queue — outlives dock open/close, the Chat↔Terminál toggle and
 *  route changes. It is inert until the first chat open (ensureAttached), so a page that never opens chat
 *  never starts the brain. */
export function BrainChatProvider({ children }: { children: ReactNode }) {
  const value = useBrainChatController();
  // `value` is rebuilt each render — like today's single BrainChat component, whose consumers all re-render
  // together on any state change. A useMemo over its identity was dead (the nested handlers/slash literal are
  // fresh every render), so the value is passed straight through; single-mount + single-SSE is what matters.
  return <BrainChatContext.Provider value={value}>{children}</BrainChatContext.Provider>;
}
