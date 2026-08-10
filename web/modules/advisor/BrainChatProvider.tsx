'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../../lib/i18n';
import { usePersistentState } from '../../lib/usePersistentState';
import { downscaleImage } from '../../lib/imageDownscale';
import { useToast } from '../../components/ui/Toast';
import { useBrainSessions, useBrainCommands, useConfig } from '../../lib/queries';
import { elowenClient, BASE } from '../../lib/elowenClient';
import type { AskAnswer, AskQuestion, BrainCard, BrainGoal, BrainMessageImage, BrainModelOption, BrainPendingPlan, BrainProject, BrainStatus, BrainStreamSnapshotFrame, BrainUsage, BrainWorkMode, McpServerStatus, ProcessInfo, SlashCommandDef, StatuslineConfig, ToolOutputView } from '../../lib/types';
import { collectSubagents, collectWorkflows, emptyView, fromHistory, fromSnapshot, prependHistory, reduce, submittedPlan, upsertCard, type ChatTurn, type ChatView, type SubagentState, type TranscriptEvent, type WorkflowState } from '../../lib/transcript';
import { formatTokens, formatCost } from '../../lib/format';
import { getBrainClientId, buildBinding, type BrainBinding } from '../../lib/brainSession';
import { subscribeRevive, STALE_HIDE_MS } from '../../lib/useRevive';
import { createReconnectController, type ReconnectController } from '../../lib/reconnect';
import { isStreamDataFrame, startStreamWatchdog, resolveStreamSilence } from '../../lib/streamWatchdog';
import { Spinner } from '../../components/ui/states';
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

const THOUGHTS_VALUES = ['show', 'hide'] as const;

/** The `kind:'mode'` commands, in one place — the `/plan`, `/build`, `/workflow` slash names ARE the mode
 *  values, so this is what narrows a command name to a BrainWorkMode without a cast. */
const WORK_MODES: readonly BrainWorkMode[] = ['build', 'plan', 'workflow'];

/** What approving a submitted plan sends, verbatim from the CLI's plan follow-up (src/cli/chat/flows.ts)
 *  so both surfaces hand the model the same sentence. Model-facing, hence not translated. */
const IMPLEMENT_PLAN_PROMPT = 'Implement the plan you proposed above.';

/** djb2 — a short stable digest. Not a security hash; it only has to tell two plan bodies apart. */
function digest(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `t${(h >>> 0).toString(36)}`;
}

/** Stable identity of a submitted plan: its ExitPlanMode call id, or a digest of the plan text for a call
 *  PI minted no id for. Mirror of the key the CLI dedupes its own plan decision on
 *  (`planDecisionRaisedFor`). The fallback is DIGESTED rather than the raw body because this key is
 *  persisted: a plan runs to kilobytes, and storing whole ones would leave working content sitting in the
 *  browser and could quietly exhaust the storage quota, after which nothing persists at all. */
function planKey(plan: BrainPendingPlan | null): string | null {
  return plan ? plan.id ?? digest(plan.plan) : null;
}

/** localStorage slot: one decided-plan key per conversation id. Keyed by conversation because the same
 *  plan legitimately repeats across chats and a decision in one must not silence it in another. */
const PLAN_DECISIONS_KEY = 'elowen.chat.planDecided';

/** Decisions are only interesting for conversations still in reach; a browser that never clears this
 *  would otherwise grow one entry per conversation forever. Oldest-written entries drop out first. */
const MAX_PLAN_DECISIONS = 100;

/** Accept only a JSON object mapping session ids to string plan keys; anything else (a foreign app version,
 *  a corrupt write) must not poison the decision state. */
function isPlanDecisionsRecord(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && Object.values(parsed).every((v) => typeof v === 'string');
  } catch { return false; }
}

/** How long a freshly opened stream may go without its guaranteed snapshot frame before it is retried. */
const SNAPSHOT_TIMEOUT_MS = 15_000;

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
/** What the vision providers actually decode (Anthropic: png/jpeg/gif/webp) — mirrors imageSchema in
 *  src/api/schemas/brain.ts and cli/chat/mentions.ts' IMAGE_MIME_BY_EXT. A browser reports plenty of
 *  other "image/*" types (heic, bmp, avif, svg…) that pass this prefix but that the provider cannot
 *  decode — forwarding one gets an opaque "Could not process image" 400 instead of a clear local error. */
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** The same four types keyed by extension. A browser does NOT always report a type: a file dragged from
 *  certain apps, or one the OS has no association for, arrives with `type: ''`. Without this it fell
 *  through to the text branch, was read as text, hit a NUL byte and was rejected as "binary" — a perfectly
 *  ordinary PNG refused with a message about the wrong thing entirely. */
const IMAGE_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

/** Why an attachment was refused. Distinct values because the two need different messages: one is fixed
 *  by sending a smaller file, the other by converting it — and a single message for both told the user
 *  neither. */
type AttachRefusal = 'too-large' | 'unsupported';

/** The image type to send this file as, or null when it is not an image we can forward. */
function imageTypeOf(file: File): string | null {
  if (file.type.startsWith('image/')) return SUPPORTED_IMAGE_TYPES.has(file.type) ? file.type : null;
  if (file.type) return null; // a declared non-image type — text branch
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_TYPE_BY_EXTENSION[ext] ?? null;
}

async function readAttachment(file: File): Promise<Attachment | AttachRefusal> {
  const imageType = imageTypeOf(file);
  // Anything the browser calls an image is judged as one even when we cannot forward it, so an unusable
  // type (heic, avif, svg…) is named as such instead of being read as text and reported as binary.
  if (imageType || file.type.startsWith('image/')) {
    // A phone photo is routinely bigger than the provider accepts, and always has more pixels than it
    // keeps; a phone photo may also be in a format the provider cannot read at all (heic). Both are
    // handled by re-encoding here rather than refusing, because on a phone the user cannot convert or
    // resize anything by hand. Null means it was not needed, or the engine could not decode it either —
    // then the original is judged exactly as before.
    const smaller = await downscaleImage(file, {
      maxBytes: MAX_IMAGE_BYTES,
      sourceType: imageType ?? file.type,
      mustConvert: !imageType,
    }).catch(() => null);
    if (!imageType && !smaller) return 'unsupported';
    const source: Blob = smaller?.blob ?? file;
    const mimeType = smaller?.mimeType ?? imageType;
    if (!mimeType) return 'unsupported';
    if (source.size > MAX_IMAGE_BYTES) return 'too-large';
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(source);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { name: file.name || 'obrazek.png', kind: 'image', mimeType, data: base64, preview: dataUrl };
  }
  if (file.size > MAX_TEXT_BYTES) return 'too-large';
  const text = await file.text();
  if (text.includes('\u0000')) return 'unsupported'; // binary — not inlinable
  return { name: file.name, kind: 'text', mimeType: file.type || 'text/plain', data: text };
}

type Ask = { id: string; questions: AskQuestion[]; kind?: 'approval' };
type SlashItem = { key: string; label: string; desc?: string; run: () => void };

/** The non-numeric half of the daemon's status poll — everything the telemetry panel shows beside the
 *  usage numbers. A null section is one the daemon does not report (no directory, MCP off or hidden from
 *  this account, an older daemon) and the panel simply omits it. */
interface BrainTelemetry {
  project: BrainProject | null;
  lspEnabled: boolean | null;
  mcp: McpServerStatus[] | null;
}
const EMPTY_TELEMETRY: BrainTelemetry = { project: null, lspEnabled: null, mcp: null };
/** Read the telemetry sections off a status response, normalizing "absent" to null. */
const telemetryOf = (st: BrainStatus): BrainTelemetry => ({
  project: st.project ?? null,
  lspEnabled: st.lspEnabled ?? null,
  mcp: st.mcp ?? null,
});

/** The single chat controller value: transcript + draft + attachments + cards + queue + ask + usage +
 *  notice state PLUS the session-scoped mutations. Consumed identically by the dock surface (compact) and
 *  — in a later phase — the full /chat surface. Owned by BrainChatProvider so a Chat↔Terminál toggle or a
 *  route change (which only unmount the presentational surface) never tears down the SSE stream or draft. */
export interface BrainChatValue {
  turns: ChatTurn[];
  busy: boolean;
  ready: boolean;
  /** A dropped stream is being recovered (the reconnect controller has an attempt in flight). Distinct from
   *  `ready`, which is also false on the very first load — this is only ever a RE-connect, so it drives the
   *  blur-and-spinner overlay without flashing it on initial boot. */
  reconnecting: boolean;
  /** Called by a chat surface on mount; the returned cleanup runs on unmount. The provider sits above every
   *  route, so without knowing whether any surface is actually on screen it blurred the whole app —
   *  dashboard and tasks included — whenever the stream dropped. */
  registerSurface: () => () => void;
  /** Whether at least one chat surface is currently mounted. */
  hasSurface: boolean;
  notice: string;
  ask: Ask | null;
  cards: BrainCard[];
  agentsOpen: boolean;
  setAgentsOpen: (v: boolean) => void;
  statsOpen: boolean;
  setStatsOpen: (v: boolean) => void;
  queued: { id: string; text: string }[];
  readOnly: string | null;
  activeSessionId: string | null;
  usage: BrainUsage | null;
  /** Project / LSP / MCP sections of the daemon's status poll — the telemetry panel's non-numeric half. */
  telemetry: BrainTelemetry;
  /** The conversation's autonomous goal, or null when none runs. Server-authoritative: the live `goal`
   *  event and the reconnect snapshot both replace it wholesale, so it can be cleared, never only set. */
  goal: BrainGoal | null;
  /** The delegated sub-agents of this transcript (latest state per child session) — the agents drill-in
   *  and the telemetry rail read this ONE projection instead of each folding the turns again. */
  subagents: SubagentState[];
  /** The workflows (DAGs) of this transcript, latest state per workflow id. */
  workflows: WorkflowState[];
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
  onAnswer: (id: string, answers: AskAnswer[]) => Promise<void>;
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
  /** The active conversation's provider, used to scope provider-specific telemetry cache. */
  provider: string;
  /** Switch this conversation to `m` in place (respawn under the same id; no SSE reconnect). */
  setModel: (m: BrainModelOption) => void;
  /** Fetch the catalog on first picker open (idempotent-cheap; re-invoked by the picker's error retry). */
  loadModels: () => void;
  modelsLoading: boolean;
  modelsError: boolean;
  /** Whether the transcript renders the model's reasoning segments. A CLIENT-SIDE display switch only:
   *  the daemon keeps streaming `reasoning` either way, so hidden thoughts stay in the transcript and
   *  reappear the moment it is switched back on. Persisted per browser. */
  showThoughts: boolean;
  setShowThoughts: (v: boolean) => void;
  /** The work mode every send FROM THIS TAB is stamped with (`/plan`, `/build`, `/workflow`). Session-scoped
   *  and kept in MEMORY only — a reload starts in 'build', exactly like a fresh CLI process. It says nothing
   *  about the mode the conversation is actually in; that is the daemon's, and it reaches the surface as
   *  `planDecision` rather than by overwriting the composer's own choice. */
  workMode: BrainWorkMode;
  setWorkMode: (m: BrainWorkMode) => void;
  /** The plan waiting on the user's implement/cancel decision, `null` when none is. Derived from the
   *  DAEMON's answer (mode + submitted plan, hydrated on connect and on every snapshot frame) and kept in
   *  step by the transcript, so the decision survives a reload, a second tab, and plan mode having been
   *  entered from another surface — none of which tab-local state could ever see. */
  planDecision: BrainPendingPlan | null;
  /** Approve the submitted plan: switch to build mode and send the CLI's implement prompt. Without it a web
   *  user who entered plan mode would have no way to act on the plan they just got. */
  implementPlan: () => void;
  /** Decline the decision without leaving plan mode (the CLI picker's Cancel): the plan stays in the
   *  transcript and another message keeps refining it. */
  dismissPlan: () => void;
  /** True while an approval is in flight — the button disables itself instead of firing twice. */
  planSubmitting: boolean;
  /** The `/rename` dialog's open state (the surface renders the modal; the controller owns the write). */
  renameOpen: boolean;
  closeRename: () => void;
  /** Rename the bound conversation and refresh the conversation list. */
  renameSession: (title: string) => Promise<void>;
  /** The surface-filtered command catalog (`GET /brain/commands`) — the single source every menu reads. */
  commands: SlashCommandDef[];
  /** Execute a catalog command exactly as the composer's slash menu does. Exposed so a second entry point
   *  (the telemetry mascot's command field) dispatches through THIS path instead of a parallel copy. */
  runSlash: (cmd: SlashCommandDef) => void;
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
  const { data: config } = useConfig();

  // The transcript view-model + fold live in the shared `web/lib/transcript.ts` mirror (kept in lockstep
  // with the daemon's `src/brain/transcript.ts`): SSE events fold through `reduce`, history through
  // `fromHistory`, cards through `upsertCard` — exactly like the CLI TUI. The WHOLE `ChatView` is the
  // state, `thinking` included, because the CLI reads its own indicator off that same fold
  // (`rt.transcript.thinking`). A second React copy of it is what let the web hold a Stop button the CLI
  // had long dropped, so `busy` is derived here and never stored.
  const [view, setView] = useState<ChatView>(emptyView());
  const turns = view.turns;
  const busy = view.thinking;
  const applyEvent = (e: TranscriptEvent): void => setView((cur) => reduce(cur, e));
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
  const [ready, setReady] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // How many chat surfaces are mounted right now. The dock and /chat can both hold one, so this is a count
  // rather than a flag — the second to unmount is what takes the overlay away.
  const [surfaces, setSurfaces] = useState(0);
  const registerSurface = useCallback(() => {
    setSurfaces((n) => n + 1);
    return () => setSurfaces((n) => n - 1);
  }, []);
  const [usage, setUsageState] = useState<BrainUsage | null>(null);
  // Usage now has several writers: the live stream (`step`, `idle`) and a handful of REST snapshots
  // (connect, a settled sub-agent, session-event, the stats modal). The stream is authoritative and
  // ordered; a REST snapshot is a point-in-time read that can land LATE and undo it — the server samples
  // it, then a newer step/idle arrives, then the slow response commits an older number that nothing
  // corrects until the next round-trip. The connect `generation` guard does not catch this: these
  // refetches keep the same generation, and a rollover deliberately does not bump it either.
  // So stamp every stream write and let a REST write commit only if no stream write beat it — the same
  // shape as historyEpochRef above, applied to usage.
  const usageStampRef = useRef(0);
  /** Commit a usage value from the LIVE STREAM — always wins, and fences any REST read still in flight. */
  const setUsage = (u: BrainUsage | null): void => { usageStampRef.current += 1; setUsageState(u); };
  /** Commit a usage value from a REST snapshot, but only if the stream has not moved since `stamp`. */
  const setUsageIfFresh = (u: BrainUsage | null, stamp: number): void => {
    if (stamp === usageStampRef.current) setUsageState(u);
  };
  const [telemetry, setTelemetry] = useState<BrainTelemetry>(EMPTY_TELEMETRY);
  const [goal, setGoal] = useState<BrainGoal | null>(null);
  const [lineCfg, setLineCfg] = useState<StatuslineConfig | null>(null);
  const [notice, setNotice] = useState('');
  const [ask, setAsk] = useState<Ask | null>(null);
  const [cards, setCards] = useState<BrainCard[]>([]);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [queued, setQueued] = useState<{ id: string; text: string }[]>([]);
  // Ids whose DELETE is in flight. The optimistic remove HIDES the item instead of taking it out of the
  // list, so a failure only has to unhide it and there is no position left to reconstruct — reconstructing
  // one from an index captured at click time is what reordered the queue whenever two failing removes
  // overlapped, and this order is the order the agent is fed in. Every server-authoritative snapshot clears
  // the set: it is newer truth, and queue ids are POSITIONAL, so a stale id would hide a different message.
  const [removingQueue, setRemovingQueue] = useState<ReadonlySet<string>>(() => new Set());
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
  const [provider, setProvider] = useState('');
  const [focusNonce, setFocusNonce] = useState(0);
  // Work mode + the `/rename` dialog: plain in-memory state. This is what the composer STAMPS on its own
  // sends, so persisting it would make a reloaded tab claim a mode the user never re-chose.
  const [workMode, setWorkMode] = useState<BrainWorkMode>('build');
  // Plan mode's decision, as the DAEMON sees it — the mode it last ran a turn in plus the plan that turn
  // submitted. Both are hydrated from the server (status on connect, then every snapshot frame): the mode
  // above is this tab's own stamp and knows nothing about a plan entered in the CLI, and it resets to
  // 'build' on reload, which is exactly how the decision used to vanish from the page that had it.
  const [daemonMode, setDaemonMode] = useState<BrainWorkMode>('build');
  const [pendingPlan, setPendingPlan] = useState<BrainPendingPlan | null>(null);
  /** The plans this tab has already decided on (implemented or dismissed), one per conversation, keyed like
   *  the CLI's `planDecisionRaisedFor` so a re-hydration cannot raise the same decision twice. Persisted so
   *  a reload remembers a decision the daemon still reports as pending; keyed by conversation so a decision
   *  made in one chat can never suppress the same plan text in another. `usePersistentState` tolerates an
   *  unavailable localStorage (private mode) — then the decision lives for the tab's lifetime, as before. */
  const [planDecisionsRaw, setPlanDecisionsRaw] = usePersistentState<string>(PLAN_DECISIONS_KEY, '{}', isPlanDecisionsRecord);
  const planDecisions = useMemo(() => JSON.parse(planDecisionsRaw) as Record<string, string>, [planDecisionsRaw]);
  const planDecided = activeSessionId ? planDecisions[activeSessionId] ?? null : null;
  const [renameOpen, setRenameOpen] = useState(false);
  // Lives on the controller (mounted once) rather than the surface, so the choice survives the dock's
  // Chat↔Terminál toggle and every route change, exactly like the transcript itself.
  const [thoughts, setThoughts] = usePersistentState<'show' | 'hide'>('elowen.chat.thoughts', 'show', THOUGHTS_VALUES);

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
  /** One stop beacon per unload. Cleared again if the page turns out to come back (see the revive hook). */
  const stopSentRef = useRef(false);
  /** The last snapshot arrived with a truncated run journal: part of the STILL RUNNING turn was dropped by
   *  the bounded buffer. Durable history only becomes authoritative once the turn settles, so the refetch
   *  waits for the terminal event rather than replacing a live turn with a half-written one. */
  const truncatedPendingRef = useRef(false);
  /** When the stream last delivered anything — an event or the daemon's heartbeat. The silence watchdog and
   *  the wake-up path both read it off the wall clock, because a frozen page runs no timers. */
  const lastFrameAtRef = useRef(0);
  /** How long the stream may stay silent before it counts as dead, in either phase — operator-tunable
   *  (`runtime.limits`), floored at the heartbeat interval, and falling back to the built-in defaults until
   *  the config arrives, so a daemon that never answers behaves exactly as before. */
  const silence = useMemo(() => resolveStreamSilence(config?.runtime?.limits), [config?.runtime?.limits]);
  const silenceRef = useRef(silence);
  silenceRef.current = silence;
  /** Fires when a stream opened but its guaranteed first frame never arrived. */
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The ONE way back onto a dropped stream. A phone unlock triggers the wake-up, the watchdog and often a
   *  server error frame at once; without a single controller each would mint its own generation and race. */
  const reconnectRef = useRef<ReconnectController | null>(null);

  const nextGeneration = (): number => (genRef.current += 1);
  const binding = (): BrainBinding => buildBinding(boundSessionRef.current, boundGenRef.current, clientId());
  const bumpFocus = (): void => setFocusNonce((n) => n + 1);
  // Created on first use and kept in a ref, so the whole tab shares ONE controller across re-renders. It
  // always reconnects through `connectRef`, i.e. the freshest closure, never the one captured when the
  // recovery path was registered. A failed attempt is rethrown on purpose: that is what makes the
  // controller back off and try again instead of leaving the chat dead until the user reloads.
  const reconnect = (): ReconnectController => (reconnectRef.current ??= createReconnectController(async () => {
    try { await connectRef.current(); }
    catch (e) { setReady(true); throw e; }
  }, { onActive: setReconnecting }));

  // The newest page bootstraps the transcript; older pages lazy-load on scroll-up. A full refetch (compaction
  // / model-switch markers) re-runs this, which correctly RESETS the lazy-load window to the tail — the
  // stored transcript changed, so any older cursor is stale.
  const HISTORY_PAGE = 50;
  const loadHistory = async (generation: number): Promise<void> => {
    const epoch = ++historyEpochRef.current; // this reset invalidates any older page still in flight
    const page = await elowenClient.brainMessagesPage(boundSessionRef.current, { limit: HISTORY_PAGE });
    if (generation !== genRef.current || epoch !== historyEpochRef.current) return; // superseded — don't clobber
    // A refetch can land MID-TURN (an auto-compaction persists while the reply streams), and durable
    // history knows nothing about the running turn — so the refetch replaces the turns and leaves the
    // in-flight flag exactly where the stream put it.
    setView((cur) => ({ ...fromHistory(page.items), thinking: cur.thinking }));
    historyCursorRef.current = page.nextBefore;
    setHasMoreHistory(page.hasMore);
  };

  // A snapshot whose run journal had overflowed left the transcript possibly missing part of that turn.
  // At the terminal boundary (idle, or an error frame ending a turn that never settled) the durable
  // history is authoritative again, so replace the view from it — the alternative is a silently
  // inconsistent transcript no later event would ever correct.
  const repairTruncatedHistory = (): void => {
    if (!truncatedPendingRef.current) return;
    truncatedPendingRef.current = false;
    void loadHistory(genRef.current).catch(() => { /* transcript refetch is best-effort */ });
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
      setView((cur) => prependHistory(cur, page.items));
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
    setReadOnly(null); // every explicit reconnect returns to the live parent; native EventSource retries stay in the child
    setReady(false);
    setNotice(''); // a fresh connection (mount / session switch) starts without a stale runtime line
    setAsk(null); // drop any parked question from the previous conversation
    setPendingPlan(null); // a pending plan belongs to the conversation being left; the decided key derives from the session id and follows the rehydration below
    setCards([]); // and any cards from the previous conversation
    setQueued([]); // and any pending mid-turn queue from the previous conversation
    setRemovingQueue(new Set()); // its in-flight removes name ids that mean something else here
    setGoal(null); // a goal belongs to ONE conversation; the snapshot frame hydrates this one's own
    const generation = nextGeneration();
    const previousSession = boundSessionRef.current;
    const started = await elowenClient.brainStart(opts, { client: clientId(), generation });
    if (generation !== genRef.current) return; // a newer connect/switch superseded this one
    // Commit the binding only when still current (out-of-order A/B switch guard, mirror BrainClient :168).
    boundSessionRef.current = started.sessionId;
    boundGenRef.current = generation;
    // The stream's snapshot frame hydrates the transcript (see the `snapshot` listener), so there is no
    // history fetch here. The view is cleared up front only when what it currently shows does NOT belong to
    // the conversation being connected — another conversation, or a read-only preview of a foreign session.
    // A plain reconnect keeps its turns on screen until the frame replaces them, with no blank flash.
    if (readOnly || (previousSession && previousSession !== started.sessionId)) setView(emptyView());
    const st = await elowenClient.brainStatus(boundSessionRef.current).catch(() => null);
    if (generation !== genRef.current) return;
    // Every field here is hydration from the server, so each one is applied UNCONDITIONALLY: a
    // `if (st.x) setX(st.x)` can only ever set, which leaves a question the daemon already settled on
    // screen (and unanswerable) instead of clearing it.
    if (st) { setUsage(st.usage); setTelemetry(telemetryOf(st)); setLineCfg(st.statusline); setActiveSessionId(st.sessionId); setCurrentModel(st.model); setProvider(st.provider ?? ''); setAsk(st.pendingAsk ?? null); setDaemonMode(st.workMode ?? 'build'); setPendingPlan(st.pendingPlan ?? null); setCards(st.cards ?? []); setQueued(st.queued ?? []); }
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
      session: boundSessionRef.current, client: clientId(), generation: String(boundGenRef.current),
      snapshot: '1', history: String(HISTORY_PAGE), heartbeat: '1',
    });
    const es = new EventSource(`${BASE}/brain/stream?${params.toString()}`);
    // A reconnect mints a fresh stream the daemon assumes is being watched, and the revive path
    // reconnects while still hidden — so re-report presence here or the phone push goes quiet again.
    elowenClient.brainVisibility({ client: clientId(), hidden: document.hidden });
    lastFrameAtRef.current = Date.now();
    // With `snapshot=1` the first frame is guaranteed, so "the stream opened" finally means "data arrived".
    // If it does not, the connection is broken in a way EventSource will not report — retry it.
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      if (generation !== genRef.current) return; // a newer connect/switch already took over
      es.close();
      reconnect().retry();
    }, SNAPSHOT_TIMEOUT_MS);
    // The guaranteed first frame normally lands in milliseconds; until it does, the stream looks open but
    // delivers nothing — say so instead of leaving an enabled composer silently waiting on data. The
    // snapshot handler (the frame itself) retires the line; a daemon `notice` frame can only arrive after
    // the snapshot, so it overwrites this safely.
    setNotice(t.brainChat.reconnecting);
    // EVERY frame must prove it belongs to the stream that is still live before it touches anything.
    // `close()` does not unschedule a callback the browser already dispatched, so a frame from a superseded
    // conversation can still run after the next one is open — and these handlers share refs with it. Left
    // unguarded, a dead stream folded its text into the new conversation and, through `esRef`, closed the
    // live stream outright; its snapshot also cleared the NEW stream's watchdog timer and reported the
    // reconnect as succeeded. Registration is synchronous up to `esRef.current = es` below, so no frame can
    // arrive before that assignment and the identity check is safe. `esRef` is null while a read-only
    // session is open, where dropping the frame is exactly right.
    const onFrame = (type: string, handler: (e: Event) => void): void => {
      es.addEventListener(type, (e) => {
        if (generation !== genRef.current || es !== esRef.current) return;
        handler(e);
      });
    };
    // The heartbeat carries nothing: its only job is to prove the channel is still alive to the watchdog.
    onFrame('heartbeat', () => { lastFrameAtRef.current = Date.now(); });
    onFrame('snapshot', (e) => {
      lastFrameAtRef.current = Date.now();
      if (snapshotTimerRef.current) { clearTimeout(snapshotTimerRef.current); snapshotTimerRef.current = null; }
      setNotice(''); // the first frame retires the "connecting" line armed with the stream
      reconnect().succeeded(); // a delivered first frame is the only proof the reconnect worked
      const snap = JSON.parse((e as MessageEvent).data) as BrainStreamSnapshotFrame;
      // An idle rollover this stream never saw retargeted the binding server-side; follow it, or the
      // lazy-load and every send would keep naming the retired conversation.
      if (snap.sessionId && snap.sessionId !== boundSessionRef.current) {
        boundSessionRef.current = snap.sessionId;
        setActiveSessionId(snap.sessionId);
      }
      historyEpochRef.current++; // the frame REPLACES the transcript — discard any older page in flight
      historyCursorRef.current = snap.nextBefore ?? null;
      setHasMoreHistory(snap.hasMore ?? false);
      const folded = fromSnapshot(snap);
      // The daemon's control state wins over anything the tail's shape suggests: the journal is cleared at
      // settle, bounded, and carries no terminal event across an internal retry, so reading "a turn is
      // running" out of it drifts in BOTH directions — a stuck Stop button on a non-transcript tail, a
      // dead one on a retry. Absent `control` means an older daemon; then the fold is all there is.
      const control = snap.control;
      const streaming = control ? control.streaming : folded.thinking;
      setView({ ...folded, thinking: streaming });
      // Explicit null included — this frame is the one moment the client can learn a question it never
      // saw is parked, or that one it still shows is long gone. The plan decision rides the same rule:
      // this frame is what tells a reloaded page, a second tab, or a surface that never entered plan mode
      // that the conversation is waiting on a plan.
      if (control) {
        setAsk(control.pendingAsk);
        setDaemonMode(control.workMode);
        setPendingPlan(control.pendingPlan);
      }
      // The goal rides beside the journal because it OUTLIVES it: the journal is cleared at settle, so a
      // client that connects between turns would otherwise show no goal while one is plainly running. The
      // presence check (not `?? null`) is what distinguishes an older daemon from an explicit "none".
      if (Object.prototype.hasOwnProperty.call(snap, 'goal')) setGoal(snap.goal ?? null);
      truncatedPendingRef.current = streaming && snap.truncated === true;
    });
    onFrame('text', (e) => {
      const { delta } = JSON.parse((e as MessageEvent).data) as { delta: string };
      setNotice(''); // first answer text clears any transient runtime notice
      applyEvent({ type: 'text', delta });
    });
    // Runtime notices (retry/compaction) — mirror the CLI: show while the phase runs, clear on done.
    onFrame('notice', (e) => {
      const { message, done } = JSON.parse((e as MessageEvent).data) as { message: string; done?: boolean };
      setNotice(done ? '' : message);
    });
    onFrame('error', (e) => {
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
      // Close THIS stream by identity, never `esRef.current`: a frame from a superseded stream would
      // otherwise tear down whichever stream happens to be live now.
      es.close();
      setNotice(message);
      // Folding the error ENDS the streaming turn — the tool row's spinner stops and, since the indicator
      // is the fold's own output, so does the thinking indicator. A successful reconnect refetches history
      // and replaces this line.
      applyEvent({ type: 'error', message });
      repairTruncatedHistory(); // a turn that died without settling is still a truncated transcript
      reconnect().retry();
    });
    // Idle rollover: the server continued the just-sent message in a FRESH conversation (the previous one
    // sat idle past the cutoff). REBIND to the replacement WITHOUT bumping the generation (mirror
    // BrainClient.rebind) so a reconnect after rollover taps the new conversation. Every client — sender
    // and passive alike — resets to the empty fresh conversation and rebuilds from the stream, because the
    // daemon re-emits the triggering message as a `user` event and streams its reply.
    onFrame('session', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as { sessionId: string };
      boundSessionRef.current = ev.sessionId; // rebind (generation preserved)
      setActiveSessionId(ev.sessionId); // the conversation rolled over — the panel's local/foreign split moves with it
      setCards([]); // display cards belonged to the previous conversation
      setGoal(null); // so did the goal (mirror of the CLI's rollover reset)
      // The rollover empties the transcript and rebuilds the fresh conversation purely from the stream, so
      // close the lazy-load window (+ bump the epoch to discard any older page in flight). Otherwise a stale
      // cursor would page the NEW session's own just-shown turns and double them.
      historyCursorRef.current = null;
      setHasMoreHistory(false);
      historyEpochRef.current++;
      applyEvent({ type: 'session', sessionId: ev.sessionId });
      setNotice(t.brainChat.freshConversation);
      void qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    });
    onFrame('reasoning', (e) => {
      const { delta } = JSON.parse((e as MessageEvent).data) as { delta: string };
      applyEvent({ type: 'reasoning', delta });
    });
    onFrame('tool', (e) => {
      // Keep `id` (the toolCallId): it keys the live `tool_progress` tail onto its in-progress tool pill.
      const { name, detail, icon, id } = JSON.parse((e as MessageEvent).data) as { name: string; detail?: string; icon?: string; id?: string };
      applyEvent({ type: 'tool', name, detail, icon, id });
    });
    // Live streamed output of a running Bash (bounded rolling tail): fold onto its tool pill by id so a
    // long build/test shows output as it runs. The stored history's final output supersedes it on reload.
    onFrame('tool_progress', (e) => {
      const { id, text } = JSON.parse((e as MessageEvent).data) as { id: string; text: string };
      applyEvent({ type: 'tool_progress', id, text });
    });
    // Live sub-agent progress (delegate): fold onto its tool item so the agents table + drill-in read it.
    onFrame('subagent', (e) => {
      const s = JSON.parse((e as MessageEvent).data) as { id: string; sessionId: string; status: 'running' | 'done' | 'error'; task: string; detail?: string; tools: number; tokens?: number; seconds: number; model?: string };
      applyEvent({ type: 'subagent', ...s });
      // The child usage is persisted before its terminal progress event. Refresh the parent status now
      // so the session price includes delegated work immediately, not only after the next parent turn.
      // Fenced against the live stream: this read can settle after a newer step/idle and must not undo it.
      if (s.status !== 'running') { const stamp = usageStampRef.current; void elowenClient.brainStatus(boundSessionRef.current).then((status) => { if (generation === genRef.current) setUsageIfFresh(status.usage, stamp); }).catch(() => { /* best-effort */ }); }
    });
    // Whole-DAG snapshot of a running workflow. Folded onto its WorkflowStart tool row (like `subagent`),
    // which is also what makes it durable — history carries the same attachment after a reload.
    onFrame('workflow', (e) => {
      const w = JSON.parse((e as MessageEvent).data) as { id: string; toolCallId: string; title?: string; status: WorkflowState['status']; nodes: WorkflowState['nodes'] };
      applyEvent({ type: 'workflow', ...w });
    });
    // Authoritative goal snapshot — `null` means the goal was cleared, so it is applied unconditionally.
    onFrame('goal', (e) => {
      const { goal: next } = JSON.parse((e as MessageEvent).data) as { goal: BrainGoal | null };
      setGoal(next);
    });
    // Full snapshot of the owner's background processes, pushed out of turn on every spawn/exit/kill. It
    // seeds the SAME query the process panels read (`GET /brain/processes` is their hydration path after a
    // reconnect), so the live push and the poll can never disagree about what is running.
    onFrame('process', (e) => {
      const { processes } = JSON.parse((e as MessageEvent).data) as { processes: ProcessInfo[] };
      qc.setQueryData(['brain-processes'], processes);
    });
    onFrame('card', (e) => {
      const { card } = JSON.parse((e as MessageEvent).data) as { card: BrainCard };
      // The terminal plugin's background-process card is rendered by ProcessPanel (API-driven, with kill +
      // output modal), not as a plain CardBlock — use it only as a signal to refresh the process list.
      if (card.id === 'bg-processes') { void qc.invalidateQueries({ queryKey: ['brain-processes'] }); return; }
      setCards((cur) => upsertCard(cur, card));
    });
    // Full-snapshot pending mid-turn queue (messages sent while a turn streams). Server-authoritative:
    // replace wholesale — the optimistic remove must never fight an incoming snapshot.
    onFrame('queue', (e) => {
      const { items } = JSON.parse((e as MessageEvent).data) as { items: { id: string; text: string }[] };
      setRemovingQueue(new Set()); // this snapshot supersedes every optimistic remove still in flight
      setQueued(items);
    });
    // The daemon's authoritative render of the user's turn (every real send — immediate or a queued
    // delivery). The composer never echoes optimistically, so THIS folds the 'you' bubble — and the fold
    // marks the turn in flight, which is what raises the thinking indicator.
    onFrame('user', (e) => {
      const { text, durableId, images } = JSON.parse((e as MessageEvent).data) as { text: string; durableId?: string; images?: BrainMessageImage[] };
      applyEvent({ type: 'user', text, ...(durableId ? { durableId } : {}), ...(images?.length ? { images } : {}) });
    });
    // The daemon cancelled a just-sent user turn before it produced output (Esc/Stop): pull its 'you'
    // bubble (the fold, by durableId) and restore the text to the composer for editing/resending — but only
    // when the composer is empty, so a discard never clobbers a draft the user already started typing.
    onFrame('discard_user', (e) => {
      const { durableId, text } = JSON.parse((e as MessageEvent).data) as { durableId: string; text: string };
      applyEvent({ type: 'discard_user', durableId, text });
      setInput((current) => (current.trim() ? current : text));
      bumpFocus();
    });
    // A context compaction was persisted server-side (manual /compact or the auto-compact path): the
    // stored transcript is now a "context compacted" divider + the kept tail. Refetch so the surface
    // collapses to exactly what the model still holds. The one-line status rides the `notice` event.
    onFrame('compacted', () => {
      void loadHistory(genRef.current).catch(() => { /* transcript refetch is best-effort */ });
    });
    // An owner-driven in-place session change (model switch, mode, reasoning, rename): the server persisted
    // a display marker + respawned the session under the SAME id, so the stream stays open. Refetch history
    // (renders the "model → X" marker + any drained partial turn) and status (model/usage label), WITHOUT
    // reconnecting — this is exactly what keeps every attached client on one stream through a model switch.
    onFrame('session-event', () => {
      void loadHistory(genRef.current).catch(() => { /* transcript refetch is best-effort */ });
      const stamp = usageStampRef.current; // usage is fenced against the stream; the rest is snapshot-only data
      void elowenClient.brainStatus(boundSessionRef.current)
        .then((st) => { if (generation === genRef.current) { setUsageIfFresh(st.usage, stamp); setTelemetry(telemetryOf(st)); setLineCfg(st.statusline); setCurrentModel(st.model); setProvider(st.provider ?? ''); } })
        .catch(() => { /* status refresh is best-effort */ });
    });
    onFrame('diff', (e) => {
      const { diff } = JSON.parse((e as MessageEvent).data) as { diff: string };
      applyEvent({ type: 'diff', diff });
    });
    // The final result block of a completed tool call (Bash output, a Read preview, …): fold it onto its
    // tool pill by id so a finished tool's stand-alone output renders LIVE, not only after a history reload
    // (parity with `diff`; the reducer's `tool_output` case supersedes any live `tool_progress` tail).
    onFrame('tool_output', (e) => {
      // A submitted plan rides this event too when the result carries a displayable block (a hook-annotated
      // ExitPlanMode), so it is threaded through exactly as on `tool_end`.
      const { output, id, plan } = JSON.parse((e as MessageEvent).data) as { output: ToolOutputView; id?: string; plan?: string };
      applyEvent({ type: 'tool_output', output, id, plan });
    });
    // A tool that settled with nothing to display. Folded ONLY for its `plan`: an `ExitPlanMode` result is
    // addressed to the model and withheld from the transcript, so this is the submitted plan's only live
    // event — without it the plan panel appears solely after a history reload. A plain `tool_end` is a
    // no-op in the reducer.
    onFrame('tool_end', (e) => {
      const { id, plan } = JSON.parse((e as MessageEvent).data) as { id?: string; plan?: string };
      applyEvent({ type: 'tool_end', id, plan });
    });
    // An image the agent shared on purpose (ShareImage), or one an image tool produced. Folded as its own
    // segment so the picture appears the moment it lands; the `ref` is normalized by the fold into the
    // exact shape stored history rebuilds after a reload, so nothing on screen changes when it settles.
    onFrame('image', (e) => {
      const { ref, id, caption } = JSON.parse((e as MessageEvent).data) as { ref: string; id?: string; caption?: string };
      applyEvent({ type: 'image', ref, id, caption });
    });
    // AskUserQuestion parked the turn — render the inline choice card until the user answers.
    onFrame('ask', (e) => {
      const { id, questions, kind } = JSON.parse((e as MessageEvent).data) as { id: string; questions: AskQuestion[]; kind?: 'approval' };
      setAsk({ id, questions, kind });
    });
    // That question is settled — answered on another surface, timed out, or the turn was aborted. The
    // `ask` frame fans out to every client of the conversation, so without this the surface that did not
    // answer keeps showing a card whose POST can no longer match anything. Compared by id so a late
    // frame cannot clear the NEXT question.
    onFrame('ask_resolved', (e) => {
      const { id } = JSON.parse((e as MessageEvent).data) as { id: string };
      setAsk((cur) => (cur && cur.id === id ? null : cur));
    });
    // Every step boundary carries a fresh usage snapshot, so context fill, token totals and cost move
    // DURING the turn instead of jumping once at the end. The daemon has always sent this (see the
    // `step` event in brain/events.ts) and the CLI has always read it (chat/streamCoordinator.ts); the
    // web client simply had no handler, so the frame arrived and was dropped and the statusline showed
    // the PREVIOUS turn's numbers until idle landed.
    onFrame('step', (e) => {
      try {
        const { usage: u } = JSON.parse((e as MessageEvent).data) as { usage?: BrainUsage };
        if (u) setUsage(u);
      } catch { /* step without payload — statusline just stays put */ }
    });
    onFrame('idle', (e) => {
      setNotice(''); // turn settled → drop any transient runtime line
      // A parked question is NOT cleared here. Only the daemon knows whether one is still waiting, and it
      // says so on the snapshot frame; guessing it from a turn boundary is what made the picker vanish
      // before the user could answer it.
      applyEvent({ type: 'idle' }); // finalize the streaming turn (parity with the CLI fold)
      repairTruncatedHistory();
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
    try { await elowenClient.brainSend(text, images, shown, binding(), workMode); }
    catch {
      setInput((current) => current || submittedInput);
      setAttachments((current) => current.length ? current : submittedAttachments);
      toast(t.brainChat.sendError, 'error');
    }
  };

  // View a non-continuable session (a shared Discord channel or a task worker) read-only. Its snapshot is
  // the authoritative child transcript, identity and cards; parent status/cache must never leak into it.
  const openReadOnly = async (sessionId: string): Promise<void> => {
    esRef.current?.close();
    const generation = nextGeneration();
    setAsk(null); setNotice('');
    // The composer is about to be replaced by the read-only banner, so drop the in-flight marker at once.
    setView((cur) => ({ ...cur, thinking: false }));
    setReadOnly(sessionId);
    // The parent identity is wrong for every child-specific control while the snapshot is in flight. Clear
    // it and address the child immediately; the atomic snapshot below fills the authoritative pair.
    setCurrentModel('');
    setProvider('');
    setActiveSessionId(sessionId);
    historyCursorRef.current = null;
    setHasMoreHistory(false);
    historyEpochRef.current++;
    // A drill-in is a READ-ONLY tap on an owned child (sub-agent / shared Discord channel / task worker),
    // NOT this client's parent attachment. Carrying `client`+`generation` sends the request down
    // resolveStreamSession's generation-bound branch, which validates the target as an OWNED USER session
    // and so rejects a channel child as `unknown session`. The CLI omits them here for the same reason
    // (brainClient.stream identifies only the bound parent stream). `generation` still guards THIS
    // controller's frame handlers locally, below — it is a client-side race fence, not the server param.
    const params = new URLSearchParams({ session: sessionId, snapshot: '1', heartbeat: '1' });
    const es = new EventSource(`${BASE}/brain/stream?${params.toString()}`);
    esRef.current = es;
    let snapshotSeen = false;
    // EventSource reuses this object across reconnects. A server error is an open failure unless THIS
    // connection already delivered its snapshot, even when an earlier connection had done so.
    es.addEventListener('open', () => {
      if (generation === genRef.current && es === esRef.current) snapshotSeen = false;
    });
    const onFrame = (type: string, handler: (e: Event) => void): void => {
      es.addEventListener(type, (e) => {
        if (generation !== genRef.current || es !== esRef.current) return;
        // Bare native transport errors have no data and prove no liveness. Counting them would let a failed
        // auto-reconnect refresh the silence watchdog forever while no server frame arrives.
        if (isStreamDataFrame(e)) lastFrameAtRef.current = Date.now();
        handler(e);
      });
    };
    onFrame('heartbeat', () => {});
    onFrame('snapshot', (e) => {
      const snap = JSON.parse((e as MessageEvent).data) as BrainStreamSnapshotFrame;
      snapshotSeen = true;
      historyEpochRef.current++;
      historyCursorRef.current = snap.nextBefore ?? null;
      setHasMoreHistory(snap.hasMore ?? false);
      const folded = fromSnapshot(snap);
      setView({ ...folded, thinking: snap.control ? snap.control.streaming : folded.thinking });
      setCards(snap.cards ?? []);
      if (snap.session) { setCurrentModel(snap.session.model); setProvider(snap.session.provider); }
      if (snap.sessionId) setActiveSessionId(snap.sessionId);
      if (snap.control) { setAsk(snap.control.pendingAsk); setDaemonMode(snap.control.workMode); setPendingPlan(snap.control.pendingPlan); }
      if (Object.prototype.hasOwnProperty.call(snap, 'goal')) setGoal(snap.goal ?? null);
      setReady(true);
    });
    onFrame('card', (e) => {
      const { card } = JSON.parse((e as MessageEvent).data) as { card: BrainCard };
      setCards((cur) => upsertCard(cur, card));
    });
    onFrame('error', (e) => {
      // EventSource also emits a bare native `error` when the transport drops. It has no payload and the
      // browser is already reconnecting it; closing here would turn a transient wifi/daemon blip into a
      // permanent exit from the child view.
      const data = (e as MessageEvent).data;
      if (typeof data !== 'string') return;
      let message: string;
      try { message = (JSON.parse(data) as { message: string }).message; } catch { return; }
      // Once the snapshot established the tap, an error frame belongs to the CHILD's own turn. It is
      // transcript content, not a failure to open the child, so keep the read-only view and fold it normally.
      if (snapshotSeen) {
        applyEvent({ type: 'error', message });
        return;
      }
      // Before the first snapshot the route sends exactly this frame when the requested child cannot be
      // resolved, then closes. Fall back through the freshest connect closure: this listener was created by
      // an older render whose `readOnly` value may still be null.
      es.close();
      toast(t.brainChat.searchOpenError, 'error');
      setReadOnly(null);
      setView(emptyView());
      void connectRef.current();
    });
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
      const a = await readAttachment(f).catch((): AttachRefusal => 'unsupported');
      if (a === 'unsupported') { toast(t.brainChat.attachUnsupportedType, 'error'); continue; }
      if (a === 'too-large') { toast(t.brainChat.attachTooBig, 'error'); continue; }
      setAttachments((cur) => {
        if (a.kind === 'image' && cur.filter((x) => x.kind === 'image').length >= MAX_IMAGES) return cur;
        return [...cur, a];
      });
    }
  };
  const removeAttachment = (index: number): void => setAttachments((cur) => cur.filter((_, j) => j !== index));

  // Optimistic remove: the item disappears immediately, but on failure it is still queued server-side, so
  // it comes back rather than leaving the UI claiming it was removed. Hiding it (instead of splicing the
  // list) is what makes the rollback exact — it restores the item's own position, never a remembered one.
  const onQueueRemove = (id: string): void => {
    if (removingQueue.has(id) || !queued.some((x) => x.id === id)) return;
    const generation = genRef.current;
    const session = boundSessionRef.current;
    setRemovingQueue((cur) => new Set(cur).add(id));
    void elowenClient.brainQueueRemove(id, session).catch(() => {
      // Another conversation is on screen (a switch bumped the generation, or an idle rollover rebound the
      // session without one): unhiding would plant a ghost chip pointing at a stranger's message, and the
      // error concerns a queue the user is no longer looking at.
      if (generation !== genRef.current || session !== boundSessionRef.current) return;
      // A newer snapshot cleared the set meanwhile: it is authoritative and already carries this item if the
      // server still holds it, so the delete below is a no-op and only the failure is reported.
      setRemovingQueue((cur) => { const next = new Set(cur); return next.delete(id) ? next : cur; });
      toast(t.brainChat.queueRemoveError, 'error');
    });
  };
  // Awaited by AskQuestionCard: the question is only removed from the UI once the server actually
  // accepted the answer. On failure the agent is STILL waiting server-side, so the question must stay
  // on screen (and the card's form re-enable) — losing it here would leave no way to answer without a
  // reconnect or reload.
  const onAnswer = async (id: string, answers: AskAnswer[]): Promise<void> => {
    try {
      await elowenClient.brainAnswer(id, answers);
      setAsk(null);
    } catch (e) {
      toast(t.brainChat.askError, 'error');
      throw e;
    }
  };
  const abort = (): void => { void elowenClient.brainAbort(boundSessionRef.current).catch(() => undefined); };

  // What the surface renders: the server's queue minus the items whose removal is in flight.
  const visibleQueue = useMemo(() => (removingQueue.size ? queued.filter((x) => !removingQueue.has(x.id)) : queued), [queued, removingQueue]);

  // Both projections are pure folds of the transcript, so they survive a reconnect for free: history
  // carries the same `sub`/`wf` attachments the live events wrote.
  const subagents = useMemo(() => collectSubagents(turns), [turns]);
  const workflows = useMemo(() => collectWorkflows(turns), [turns]);

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
  // Switch the mode every following send is stamped with (the CLI's /plan|/build|/workflow, whose mode is
  // likewise client state). Nothing is sent here — the mode takes effect on the NEXT turn.
  const runMode = (mode: BrainWorkMode): void => {
    setWorkMode(mode);
    toast(`${t.brainChat.modeSwitched} ${t.brainChat.workMode[mode]}`, 'ok');
  };
  // The transcript carries the same submitted plan the daemon does — live on `tool_end`, and rebuilt from
  // history on every hydration — so it is what keeps the hydrated decision in step between snapshots, in
  // BOTH directions: it raises a plan submitted while this tab is attached, and drops one the conversation
  // has since moved past. Keyed on the turns rather than on the scan's result: two consecutive "no plan"
  // answers are both null and would leave a stale decision standing. Reconciled by plan key, so the common
  // case (a text delta) settles to the same state object and re-renders nothing.
  useEffect(() => {
    const scanned = submittedPlan(turns);
    setPendingPlan((cur) => (planKey(cur) === planKey(scanned) ? cur : scanned));
  }, [turns]);
  // A decision is open while the daemon is in plan mode, the turn that submitted the plan has settled, and
  // this tab has not already answered for that plan. Read-only previews are somebody else's conversation.
  const openPlanKey = planKey(pendingPlan);
  const planDecision = daemonMode === 'plan' && !busy && !readOnly && openPlanKey && openPlanKey !== planDecided
    ? pendingPlan
    : null;
  const [planSubmitting, setPlanSubmitting] = useState(false);
  const planInFlightRef = useRef(false);
  /** Persist a decided plan under its conversation, so a reload does not re-raise it. The caller names the
   *  session the plan belongs to — for implement that is the one captured at click time, not whatever a
   *  mid-flight rollover switched to. */
  const recordPlanDecision = (sessionId: string, key: string): void => {
    // Re-inserting the session id puts it last in insertion order, so trimming from the front drops the
    // least recently decided conversations rather than an arbitrary one.
    const { [sessionId]: _replaced, ...rest } = planDecisions;
    const entries = [...Object.entries(rest), [sessionId, key] as const].slice(-MAX_PLAN_DECISIONS);
    setPlanDecisionsRaw(JSON.stringify(Object.fromEntries(entries)));
  };
  const dismissPlan = (): void => { if (openPlanKey && activeSessionId) recordPlanDecision(activeSessionId, openPlanKey); };
  const implementPlan = (): void => {
    // The mode follows the daemon's ACCEPTANCE, never the click. Switching to `build` up front removed the
    // decision row — the only control that can approve the plan — the instant a send failed, leaving the
    // plan parked with no way to act on it and only a toast to explain why.
    if (planInFlightRef.current) return; // a ref, not the state: two fast clicks would race a setState
    planInFlightRef.current = true;
    setPlanSubmitting(true);
    // Capture the plan and its conversation at click time: the send is async, and the conversation can
    // roll over while it is in flight — the decision must land under the conversation the plan belonged to.
    const key = openPlanKey;
    const sessionId = activeSessionId;
    void elowenClient.brainSend(IMPLEMENT_PLAN_PROMPT, undefined, undefined, binding(), 'build')
      .then(() => { setWorkMode('build'); if (key && sessionId) recordPlanDecision(sessionId, key); })
      .catch(() => toast(t.brainChat.sendError, 'error'))
      .finally(() => { planInFlightRef.current = false; setPlanSubmitting(false); });
  };
  const renameSession = async (title: string): Promise<void> => {
    setRenameOpen(false);
    const next = title.trim();
    const id = boundSessionRef.current ?? activeSessionId;
    if (!next || !id) return;
    try {
      await elowenClient.brainRenameSession(id, next);
      await qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    } catch { toast(t.chat.renameError, 'error'); }
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
      if (cmd.name === 'stats') {
        setStatsOpen(true);
        // Refresh usage data for the modal — fenced, so opening it mid-turn cannot roll the statusline
        // back to a figure the stream has already moved past.
        { const stamp = usageStampRef.current; void elowenClient.brainStatus(boundSessionRef.current).then((s) => { if (s) setUsageIfFresh(s.usage, stamp); }).catch(() => undefined); }
        return;
      }
      // Inspect loaded skills — list the invocable /skill:name commands (PI expands them on send).
      if (cmd.name === 'skills') { const sk = await elowenClient.pluginSkills(); toast(sk.length ? sk.map((s) => `/skill:${s.name}`).join('  ') : t.skills.empty, 'ok'); return; }
      if (cmd.kind === 'mode') {
        const mode = WORK_MODES.find((m) => m === cmd.name);
        if (mode) { runMode(mode); return; }
      }
      if (cmd.name === 'rename') { setRenameOpen(true); return; }
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
  const connectRef = useRef<() => Promise<void>>(async () => {});
  connectRef.current = () => connect();
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

  // Release this client's binding when the tab really goes away. TWO independent locks keep a phone lock
  // from being read as a close: `persisted` is set when the page is only FROZEN into the bfcache (the iOS
  // screen lock), and the beacon that does go out carries `detachOnly`, so the daemon releases the binding
  // but refuses to tear down a session with work in flight. The second lock matters because an open
  // WebSocket (the terminal) makes the page bfcache-ineligible, and iOS then reports `persisted: false`
  // for the very same lock. The abandoned runtime is collected by the daemon's idle reaper.
  useEffect(() => {
    const onPageHide = (e: Event) => {
      if ((e as PageTransitionEvent).persisted) return; // frozen, not closed — the page is coming back
      if (stopSentRef.current || !attachedRef.current || !boundSessionRef.current) return;
      stopSentRef.current = true;
      elowenClient.brainSessionStop({ session: boundSessionRef.current, client: clientId(), generation: genRef.current, detachOnly: true });
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Report whether this tab is on screen. The daemon holds an SSE stream open behind a locked phone, so
  // being attached says nothing about whether the answer is being read — without this the "turn finished"
  // push assumes someone is watching and never fires. Also reported on every (re)attach, because a
  // reconnect mints a fresh stream that starts out assumed-visible: a tab that reconnects while hidden
  // (the daemon's own revive path does exactly that) would otherwise silence the notification again.
  useEffect(() => {
    const report = (): void => {
      if (!attachedRef.current) return;
      elowenClient.brainVisibility({ client: clientId(), hidden: document.hidden });
    };
    // `pagehide` is the one event iOS fires reliably when an installed PWA goes to the background or the
    // phone locks; `visibilitychange` alone can be skipped there, which left the daemon believing the
    // conversation was still being read. `pageshow` is its counterpart on the way back, because a page
    // restored from the bfcache does not re-run this effect.
    const hide = (): void => { if (attachedRef.current) elowenClient.brainVisibility({ client: clientId(), hidden: true }); };
    report();
    document.addEventListener('visibilitychange', report);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', report);
    return () => {
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', report);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Waking up (unlock, tab return, bfcache restore, network back) must ACTIVELY recover the stream: the
  // native EventSource reconnect only reopens the same URL, still carrying the generation the daemon has
  // tombstoned, and it never refetches the history written while we were away. A full connect() mints a
  // new generation — the only legitimate way to clear that tombstone — and reloads the transcript.
  useEffect(() => subscribeRevive(({ hiddenMs }) => {
    stopSentRef.current = false; // the page came back, so a LATER real close must still be able to send
    if (!attachedRef.current) return;
    // The watchdog cannot have run while the page slept — its timers were frozen — so the staleness is
    // decided here from the wall clock. A momentary hide over a stream that is still being fed needs
    // nothing; anything longer, or any silence past the wake limit, may have lost frames.
    const silentMs = Date.now() - lastFrameAtRef.current;
    // Through a ref, because this subscription is made once: a limit edited mid-session must reach the next
    // wake-up without re-subscribing (which would drop the wake-ups that arrive while React re-runs it).
    if (hiddenMs <= STALE_HIDE_MS && silentMs <= silenceRef.current.reviveLimitMs && esRef.current?.readyState === EventSource.OPEN) return;
    reconnect().now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // A dropped SSE connection can sit in readyState OPEN forever with nothing arriving on it — no error, no
  // close. The daemon's named heartbeat makes that state observable: silence past the limit means dead.
  // Unlike the wake-up path this one is re-armed when the operator changes the limit, since the interval
  // reads it once at start; the watchdog holds no state worth preserving across that restart.
  useEffect(() => startStreamWatchdog({
    lastFrameAt: () => lastFrameAtRef.current,
    limitMs: silence.limitMs,
    onSilent: () => {
      if (!attachedRef.current || !esRef.current) return;
      esRef.current.close();
      reconnect().now();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [silence.limitMs]);

  // Tear the stream down when the whole provider unmounts (app teardown), matching today's cleanup.
  useEffect(() => () => {
    reconnectRef.current?.stop();
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    esRef.current?.close();
  }, []);

  return {
    turns, busy, ready, reconnecting, registerSurface, hasSurface: surfaces > 0, notice, ask, cards, agentsOpen, setAgentsOpen, statsOpen, setStatsOpen, queued: visibleQueue, readOnly, activeSessionId,
    usage, telemetry, goal, subagents, workflows, lineCfg, input, setInput, attachments, addFiles, removeAttachment, submit, switchSession,
    openReadOnly, exitReadOnly, deleteSession, onQueueRemove, onAnswer, abort, ensureAttached, loadOlder, hasMoreHistory, focusNonce,
    models, currentModel, provider, setModel: (m) => void runModel(m), loadModels: () => void loadModels(), modelsLoading, modelsError,
    showThoughts: thoughts === 'show',
    setShowThoughts: (v) => setThoughts(v ? 'show' : 'hide'),
    workMode, setWorkMode: runMode, planDecision, implementPlan, dismissPlan, planSubmitting,
    renameOpen, closeRename: () => setRenameOpen(false), renameSession,
    commands, runSlash: (cmd) => void runSlash(cmd),
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
  // The reconnect overlay lives HERE, not in BrainChatSurface: a phone with the dock open on /chat mounts
  // two surfaces sharing this one provider, and a per-surface fixed-fullscreen overlay would then render
  // twice (doubled backdrop, two aria-live "reconnecting" announcements). One provider → one overlay.
  // But the provider spans every route, so it also needs to know a surface is actually on screen —
  // otherwise a dropped stream blurred and froze the dashboard, tasks and settings, where there is no
  // chat to protect from acting on stale state.
  return (
    <BrainChatContext.Provider value={value}>
      {children}
      {value.reconnecting && value.hasSurface ? <ReconnectOverlay /> : null}
    </BrainChatContext.Provider>
  );
}

/** Recovering a dropped stream: blur everything behind a centered spinner rather than let the user act on
 *  state that may be out of date. Rendered once at the provider so it can never double up across surfaces.
 *  It covers the whole viewport, including the navigation and the phone's history drawer, so it carries its
 *  own way out: a daemon that stays down would otherwise lock the reader inside a chat they cannot leave. */
function ReconnectOverlay() {
  const { t } = useTranslation();
  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-bg/60 backdrop-blur-md"
      role="status"
      aria-live="polite"
    >
      <Spinner size="lg" />
      <span className="text-base text-text-muted">{t.brainChat.reconnecting}</span>
      <Link
        href="/dash"
        className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-text-muted transition-colors hover:bg-elevated hover:text-text"
      >
        <ArrowLeft size={16} aria-hidden />
        <span>{t.nav.dashboard}</span>
      </Link>
    </div>
  );
}
