'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../../lib/i18n';
import { usePersistentState } from '../../lib/usePersistentState';
import { useToast } from '../../components/ui/Toast';
import { useBrainSessions, useBrainCommands, useConfig } from '../../lib/queries';
import { elowenClient } from '../../lib/elowenClient';
import type { AskAnswer, AskQuestion, BrainCard, BrainGoal, BrainModelOption, BrainPendingPlan, BrainProject, BrainStatus, BrainUsage, BrainWorkMode, McpServerStatus, SessionTask, SlashCommandDef, StatuslineConfig } from '../../lib/types';
import { collectSubagents, collectWorkflows, emptyView, fromSnapshot, reduce, submittedPlan, upsertCard, type ChatTurn, type ChatView, type SubagentState, type TranscriptEvent, type WorkflowState } from '../../lib/transcript';
import { getBrainClientId, buildBinding, type BrainBinding } from '../../lib/brainSession';
import { subscribeRevive } from '../../lib/useRevive';
import { resolveStreamSilence } from '../../lib/streamWatchdog';
import { Spinner } from '../../components/ui/states';
import { brainModelQualifiedLabel } from '../../lib/modelProvider';
import {
  BRAIN_COMPOSE_EVENT,
  BRAIN_OPEN_EVENT,
  consumePendingBrainComposer,
  consumePendingBrainSession,
  mergeBrainComposerText,
  type BrainOpenRequest,
} from '../../lib/brainDock';
import { uploadAttachment, type AttachRefusal, type Attachment } from './brainChatAttachments';
import { useBrainChatHistory } from './brainChatHistory';
import { useBrainChatStream } from './brainChatStream';

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
  /** `/reasoning` — the effort picker plus the Thought-rows switch (the CLI's `/reasoning show`). */
  reasoningOpen: boolean;
  setReasoningOpen: (v: boolean) => void;
  /** `/skills` — the loaded-skill overview (filter, load into the conversation, delete a user skill). */
  skillsOpen: boolean;
  setSkillsOpen: (v: boolean) => void;
  /** `/tasks` — the current conversation's task descriptions, statuses and delete controls. */
  tasksOpen: boolean;
  setTasksOpen: (v: boolean) => void;
  syncSessionTasks: (tasks: SessionTask[]) => void;
  /** `/help` — the command catalog with descriptions (it used to be a toast of bare names). */
  helpOpen: boolean;
  setHelpOpen: (v: boolean) => void;
  /** `/model` — the catalog overlay. The slash used to take over the composer's suggestion dropdown, so
   *  the same pick was offered in two different shapes depending on where it was started from. */
  modelOpen: boolean;
  setModelOpen: (v: boolean) => void;
  /** Push a skill into THIS conversation as PI's native `/skill:name`, exactly as the CLI's skills picker
   *  does — the daemon expands it to the skill's full instructions on the way in. */
  loadSkill: (name: string) => void;
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
  const {
    hasMoreHistory,
    loadHistory,
    loadOlder,
    replaceWindow: replaceHistoryWindow,
    clearWindow: clearHistoryWindow,
  } = useBrainChatHistory({
    getGeneration: () => genRef.current,
    getSession: () => boundSessionRef.current,
    setView,
  });
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
  // shape as the history epoch fence, applied to usage.
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
  const syncSessionTasks = useCallback((tasks: SessionTask[]): void => {
    const completed = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id));
    const card: BrainCard = {
      id: 'todos', title: 'Todos', pinned: true,
      items: tasks.map((task) => {
        const blockers = task.blockedBy.filter((id) => !completed.has(id));
        const blocked = blockers.length ? ` (blocked by ${blockers.map((id) => `#${id}`).join(', ')})` : '';
        const owner = task.owner ? ` — ${task.owner}` : '';
        const text = task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject;
        return { text: `${text}${owner}${blocked}`, status: task.status };
      }),
    };
    setCards((current) => upsertCard(current, card));
  }, []);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
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
  // ModelPicker and the `/model` overlay, both of which render it through ModelOptionList.
  const [models, setModels] = useState<BrainModelOption[] | null>(null);
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
  // Keep stream recovery pointed at the freshest connect closure without recreating its controller.
  const connectRef = useRef<() => Promise<void>>(async () => {});
  /** ensureAttached idempotency: once true the stream stays live for the tab's life. */
  const attachedRef = useRef(false);
  /** One stop beacon per unload. Cleared again if the page turns out to come back (see the revive hook). */
  const stopSentRef = useRef(false);
  /** The last snapshot arrived with a truncated run journal: part of the STILL RUNNING turn was dropped by
   *  the bounded buffer. Durable history only becomes authoritative once the turn settles, so the refetch
   *  waits for the terminal event rather than replacing a live turn with a half-written one. */
  const truncatedPendingRef = useRef(false);
  /** Per-field stream freshness. Status starts before the stream, so any overlapping frame that lands first
   *  is newer truth for that field and must not be overwritten by the older read. */
  const hydrationStampRef = useRef({ session: 0, model: 0, control: 0, cards: 0, queue: 0 });
  /** How long the stream may stay silent before it counts as dead, in either phase — operator-tunable
   *  (`runtime.limits`), floored at the heartbeat interval, and falling back to the built-in defaults until
   *  the config arrives, so a daemon that never answers behaves exactly as before. */
  const silence = useMemo(() => resolveStreamSilence(config?.runtime?.limits), [config?.runtime?.limits]);
  const silenceRef = useRef(silence);
  silenceRef.current = silence;
  const stream = useBrainChatStream({
    connectRef,
    getGeneration: () => genRef.current,
    setReady,
    setReconnecting,
  });

  const nextGeneration = (): number => (genRef.current += 1);
  const binding = (): BrainBinding => buildBinding(boundSessionRef.current, boundGenRef.current, clientId());
  const bumpFocus = (): void => setFocusNonce((n) => n + 1);

  // A snapshot whose run journal had overflowed left the transcript possibly missing part of that turn.
  // At the terminal boundary (idle, or an error frame ending a turn that never settled) the durable
  // history is authoritative again, so replace the view from it — the alternative is a silently
  // inconsistent transcript no later event would ever correct.
  const repairTruncatedHistory = (): void => {
    if (!truncatedPendingRef.current) return;
    truncatedPendingRef.current = false;
    void loadHistory(genRef.current).catch(() => { /* transcript refetch is best-effort */ });
  };

  // Boot (resume) the brain, load history, open the stream — bound to the conversation start() resolves.
  // Re-runs on every session switch / reconnect. `opts` selects which conversation (default: resume the
  // caller's active one). Late responses from a superseded generation are discarded (stale-gen guard).
  const connect = async (opts: { session?: string; fresh?: boolean } = {}): Promise<void> => {
    stream.close();
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
    setActiveSessionId(started.sessionId);
    // The stream's snapshot frame hydrates the transcript (see the `snapshot` listener), so there is no
    // history fetch here. The view is cleared up front only when what it currently shows does NOT belong to
    // the conversation being connected — another conversation, or a read-only preview of a foreign session.
    // A plain reconnect keeps its turns on screen until the frame replaces them, with no blank flash.
    if (readOnly || (previousSession && previousSession !== started.sessionId)) setView(emptyView());
    // Status and the atomic history snapshot are independent reads. Start status now, but open the stream
    // immediately: status includes cumulative descendant usage and used to hold the transcript empty for
    // seconds before the browser was even allowed to request its first history frame.
    const statusHydrationStamp = { ...hydrationStampRef.current };
    const statusUsageStamp = usageStampRef.current;
    const status = elowenClient.brainStatus(boundSessionRef.current).catch(() => null);
    stream.openLive({
      generation,
      session: boundSessionRef.current,
      client: clientId(),
      boundGeneration: boundGenRef.current,
      handlers: {
        connecting: () => setNotice(t.brainChat.reconnecting),
        ready: () => setReady(true),
        snapshotStart: () => setNotice(''),
        snapshot: (snap) => {
          // An idle rollover this stream never saw retargeted the binding server-side. Follow it so lazy-load
          // and every later send name the replacement conversation.
          if (snap.sessionId && snap.sessionId !== boundSessionRef.current) {
            hydrationStampRef.current.session += 1;
            boundSessionRef.current = snap.sessionId;
            setActiveSessionId(snap.sessionId);
          }
          // The snapshot replaces the transcript, so discard any older history page still in flight.
          replaceHistoryWindow(snap.nextBefore ?? null, snap.hasMore ?? false);
          const folded = fromSnapshot(snap);
          // Daemon control state wins over journal shape: the bounded journal may omit terminal events or
          // survive an internal retry. Older daemons have no control field, where the fold remains authoritative.
          const control = snap.control;
          const streaming = control ? control.streaming : folded.thinking;
          setView({ ...folded, thinking: streaming });
          if (snap.session) {
            hydrationStampRef.current.model += 1;
            setCurrentModel(snap.session.model);
            setProvider(snap.session.provider);
          }
          if (Object.prototype.hasOwnProperty.call(snap, 'cards')) {
            hydrationStampRef.current.cards += 1;
            setCards(snap.cards ?? []);
          }
          // Explicit nulls matter here: the snapshot can clear a question or plan that another surface settled.
          if (control) {
            hydrationStampRef.current.control += 1;
            setAsk(control.pendingAsk);
            setDaemonMode(control.workMode);
            setPendingPlan(control.pendingPlan);
          }
          // Goal outlives the journal. Presence distinguishes an older daemon from an explicit cleared goal.
          if (Object.prototype.hasOwnProperty.call(snap, 'goal')) setGoal(snap.goal ?? null);
          truncatedPendingRef.current = streaming && snap.truncated === true;
        },
        text: (delta) => { setNotice(''); applyEvent({ type: 'text', delta }); },
        notice: (message, done) => setNotice(done ? '' : message),
        error: (message) => {
          setNotice(message);
          // Folding the error ends the streaming turn and its tool/thinking indicators. A successful
          // reconnect replaces it from durable history.
          applyEvent({ type: 'error', message });
          repairTruncatedHistory();
        },
        session: (sessionId) => {
          // Rebind without changing generation. The fresh conversation is rebuilt solely from stream events.
          hydrationStampRef.current.session += 1;
          hydrationStampRef.current.cards += 1;
          boundSessionRef.current = sessionId;
          setActiveSessionId(sessionId);
          setCards([]);
          setGoal(null);
          // Close the lazy-load window and bump its epoch so an older page cannot duplicate the new session.
          clearHistoryWindow();
          applyEvent({ type: 'session', sessionId });
          setNotice(t.brainChat.freshConversation);
          void qc.invalidateQueries({ queryKey: ['brain-sessions'] });
        },
        reasoning: (delta) => applyEvent({ type: 'reasoning', delta }),
        toolAuthoring: ({ name, detail, reason }) => applyEvent({ type: 'tool_authoring', name, detail, reason }),
        tool: ({ name, detail, icon, id }) => applyEvent({ type: 'tool', name, detail, icon, id }),
        toolProgress: ({ id, text }) => applyEvent({ type: 'tool_progress', id, text }),
        subagent: (subagent) => {
          applyEvent({ type: 'subagent', ...subagent });
          // Child usage is persisted before terminal progress. Refresh immediately, fenced so a late read
          // cannot overwrite a newer step or idle snapshot.
          if (subagent.status !== 'running') {
            const stamp = usageStampRef.current;
            void elowenClient.brainStatus(boundSessionRef.current)
              .then((status) => { if (generation === genRef.current) setUsageIfFresh(status.usage, stamp); })
              .catch(() => { /* best-effort */ });
          }
        },
        workflow: (workflow) => applyEvent({ type: 'workflow', ...workflow }),
        goal: setGoal,
        // Seed the same query used by process panels so live push and API hydration cannot diverge.
        process: (processes) => qc.setQueryData(['brain-processes'], processes),
        card: (card) => {
          // The background-process card is rendered by ProcessPanel; use it only as a refresh signal.
          if (card.id === 'bg-processes') { void qc.invalidateQueries({ queryKey: ['brain-processes'] }); return; }
          hydrationStampRef.current.cards += 1;
          setCards((cur) => upsertCard(cur, card));
        },
        // A queue frame supersedes every optimistic removal still in flight.
        queue: (items) => {
          hydrationStampRef.current.queue += 1;
          setRemovingQueue(new Set());
          setQueued(items);
        },
        user: ({ text, durableId, images, createdAt }) => applyEvent({
          type: 'user', text, ...(durableId ? { durableId } : {}), ...(images?.length ? { images } : {}),
          ...(createdAt ? { createdAt } : {}),
        }),
        // A cancelled just-sent turn is removed by durable id and restored only into an empty composer.
        discardUser: ({ durableId, text }) => {
          applyEvent({ type: 'discard_user', durableId, text });
          setInput((current) => (current.trim() ? current : text));
          bumpFocus();
        },
        // Compaction rewrites durable history to a divider plus kept tail, so refetch the exact model context.
        compacted: () => { void loadHistory(genRef.current).catch(() => { /* best-effort */ }); },
        // In-place model/mode/reasoning changes keep the same stream. Refresh history and status without
        // reconnecting; usage stays fenced against a newer stream event.
        sessionEvent: () => {
          void loadHistory(genRef.current).catch(() => { /* best-effort */ });
          const stamp = usageStampRef.current;
          void elowenClient.brainStatus(boundSessionRef.current)
            .then((status) => {
              if (generation !== genRef.current) return;
              setUsageIfFresh(status.usage, stamp);
              setTelemetry(telemetryOf(status));
              setLineCfg(status.statusline);
              hydrationStampRef.current.model += 1;
              setCurrentModel(status.model);
              setProvider(status.provider ?? '');
            })
            .catch(() => { /* best-effort */ });
        },
        diff: (diff) => applyEvent({ type: 'diff', diff }),
        toolOutput: ({ output, id, plan }) => applyEvent({ type: 'tool_output', output, id, plan }),
        toolEnd: ({ id, plan }) => applyEvent({ type: 'tool_end', id, plan }),
        image: ({ ref, id, caption }) => applyEvent({ type: 'image', ref, id, caption }),
        file: ({ ref, name, size, id, caption }) => applyEvent({ type: 'file', ref, name, size, id, caption }),
        // Ask stays visible until the daemon resolves this exact id; idle alone cannot prove it is settled.
        ask: ({ id, questions, kind }) => {
          hydrationStampRef.current.control += 1;
          setAsk({ id, questions, kind });
        },
        askResolved: (id) => {
          hydrationStampRef.current.control += 1;
          setAsk((cur) => (cur && cur.id === id ? null : cur));
        },
        step: (nextUsage) => { if (nextUsage) setUsage(nextUsage); },
        idle: (nextUsage) => {
          setNotice('');
          // Do not clear ask here. Only snapshot/ask_resolved can say whether the parked question remains.
          applyEvent({ type: 'idle' });
          repairTruncatedHistory();
          if (nextUsage) setUsage(nextUsage);
          void qc.invalidateQueries({ queryKey: ['brain-sessions'] });
        },
      },
    });
    const st = await status;
    if (generation !== genRef.current || !st) return;
    const fresh = hydrationStampRef.current;
    // A rollover retargeted the stream while this explicit-session status read was in flight; every field in
    // that response belongs to the conversation we already left.
    if (fresh.session !== statusHydrationStamp.session) return;
    setUsageIfFresh(st.usage, statusUsageStamp);
    setTelemetry(telemetryOf(st));
    setLineCfg(st.statusline);
    if (fresh.model === statusHydrationStamp.model) {
      setCurrentModel(st.model);
      setProvider(st.provider ?? '');
    }
    if (fresh.control === statusHydrationStamp.control) {
      setAsk(st.pendingAsk ?? null);
      setDaemonMode(st.workMode ?? 'build');
      setPendingPlan(st.pendingPlan ?? null);
    }
    if (fresh.cards === statusHydrationStamp.cards) setCards(st.cards ?? []);
    if (fresh.queue === statusHydrationStamp.queue) setQueued(st.queued ?? []);
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
    // A plugin prompt command (`/review auth…`) rides RAW: the daemon hands the slash to PI, which expands
    // the template's arguments natively — same contract as the CLI. Built-ins/plain text pass through too.
    //
    // An attachment rides as its PATH, not its content. The file is already in the user's project by the
    // time this runs, so the agent opens it with its ordinary file tools — which handle every type,
    // including images, better than inlining ever did.
    const text = [
      typed || t.brainChat.attachOnly,
      ...attachments.map((a) => `\n[📎 ${t.brainChat.attachedFile}: ${a.path}]`),
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
    // No inline images any more: an attachment is a real file the agent opens, so the vision payload
    // stays empty here. The parameter itself remains — other surfaces still deliver images inline.
    try { await elowenClient.brainSend(text, [], shown, binding(), workMode); }
    catch {
      setInput((current) => current || submittedInput);
      setAttachments((current) => current.length ? current : submittedAttachments);
      toast(t.brainChat.sendError, 'error');
    }
  };

  // View a non-continuable session (a shared Discord channel or a task worker) read-only. Its snapshot is
  // the authoritative child transcript, identity and cards; parent status/cache must never leak into it.
  const openReadOnly = async (sessionId: string): Promise<void> => {
    stream.close();
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
    clearHistoryWindow();
    stream.openReadOnly({
      generation,
      session: sessionId,
      handlers: {
        snapshot: (snap) => {
          replaceHistoryWindow(snap.nextBefore ?? null, snap.hasMore ?? false);
          const folded = fromSnapshot(snap);
          setView({ ...folded, thinking: snap.control ? snap.control.streaming : folded.thinking });
          setCards(snap.cards ?? []);
          if (snap.session) { setCurrentModel(snap.session.model); setProvider(snap.session.provider); }
          if (snap.sessionId) setActiveSessionId(snap.sessionId);
          if (snap.control) {
            setAsk(snap.control.pendingAsk);
            setDaemonMode(snap.control.workMode);
            setPendingPlan(snap.control.pendingPlan);
          }
          if (Object.prototype.hasOwnProperty.call(snap, 'goal')) setGoal(snap.goal ?? null);
          setReady(true);
        },
        text: (delta) => applyEvent({ type: 'text', delta }),
        reasoning: (delta) => applyEvent({ type: 'reasoning', delta }),
        toolAuthoring: ({ name, detail, reason }) => applyEvent({ type: 'tool_authoring', name, detail, reason }),
        tool: ({ name, detail, icon, id }) => applyEvent({ type: 'tool', name, detail, icon, id }),
        toolProgress: ({ id, text }) => applyEvent({ type: 'tool_progress', id, text }),
        subagent: (subagent) => applyEvent({ type: 'subagent', ...subagent }),
        workflow: (workflow) => applyEvent({ type: 'workflow', ...workflow }),
        diff: (diff) => applyEvent({ type: 'diff', diff }),
        toolOutput: ({ output, id, plan }) => applyEvent({ type: 'tool_output', output, id, plan }),
        toolEnd: ({ id, plan }) => applyEvent({ type: 'tool_end', id, plan }),
        image: ({ ref, id, caption }) => applyEvent({ type: 'image', ref, id, caption }),
        file: ({ ref, name, size, id, caption }) => applyEvent({ type: 'file', ref, name, size, id, caption }),
        idle: () => applyEvent({ type: 'idle' }),
        card: (card) => setCards((cur) => upsertCard(cur, card)),
        error: (message) => applyEvent({ type: 'error', message }),
        openError: () => {
          toast(t.brainChat.searchOpenError, 'error');
          setReadOnly(null);
          setView(emptyView());
          void connectRef.current();
        },
      },
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
    // Uploaded on attach rather than on send, so a large file is already on disk by the time the user
    // finishes typing instead of stalling the send, and a failure is reported while they can still act.
    for (const f of files) {
      const a = await uploadAttachment(f).catch((): AttachRefusal => 'failed');
      if (a === 'failed') { toast(t.brainChat.attachFailed, 'error'); continue; }
      setAttachments((cur) => [...cur, a]);
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
  // have unsent text typed — only the slash entry clears the input (when it opens the overlay).
  // Closing the `/model` overlay lives here rather than only in its own row handler, so a switch started
  // from any other entry point still leaves no stale picker standing over the conversation.
  const runModel = async (m: BrainModelOption): Promise<void> => {
    setModelOpen(false);
    try {
      const { model } = await elowenClient.brainSetModel({ provider: m.provider, model: m.model }, boundSessionRef.current);
      setCurrentModel(model);
      setProvider(m.provider);
      toast(`${t.brainChat.modelSwitched} ${brainModelQualifiedLabel({ provider: m.provider, model })}`, 'ok');
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
  // The CLI's skills picker submits `/skill:name` through the ordinary send path, and so does this: the
  // daemon recognizes the prefix and hands the slash to PI RAW, which expands it to the skill's full
  // instructions. The DAEMON renders the user turn (the `user` stream event), so nothing is echoed here.
  const loadSkill = (name: string): void => {
    void elowenClient.brainSend(`/skill:${name}`, [], undefined, binding(), workMode)
      .catch(() => toast(t.brainChat.sendError, 'error'));
  };
  const runSlash = async (cmd: SlashCommandDef): Promise<void> => {
    if (cmd.name === 'model') { setInput(''); setModelOpen(true); void loadModels(); return; }
    setInput('');
    try {
      if (cmd.name === 'new') { await switchSession({ fresh: true }); return; }
      if (cmd.name === 'help') { setHelpOpen(true); return; }
      if (cmd.name === 'stats') {
        setStatsOpen(true);
        // Refresh usage data for the modal — fenced, so opening it mid-turn cannot roll the statusline
        // back to a figure the stream has already moved past.
        { const stamp = usageStampRef.current; void elowenClient.brainStatus(boundSessionRef.current).then((s) => { if (s) setUsageIfFresh(s.usage, stamp); }).catch(() => undefined); }
        return;
      }
      if (cmd.name === 'reasoning') { setReasoningOpen(true); return; }
      if (cmd.name === 'skills') { setSkillsOpen(true); return; }
      if (cmd.name === 'tasks') { setTasksOpen(true); return; }
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
  const slashItems: SlashItem[] = slashMatches.map(
    (c) => ({ key: c.name, label: `/${c.name}`, desc: c.description, run: () => void runSlash(c) }),
  );

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
    // Through a ref, because this subscription is made once: a limit edited mid-session must reach the next
    // wake-up without re-subscribing (which would drop the wake-ups that arrive while React re-runs it).
    stream.revive(hiddenMs, attachedRef.current, silenceRef.current.reviveLimitMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // A dropped SSE connection can sit in readyState OPEN forever with nothing arriving on it — no error, no
  // close. The daemon's named heartbeat makes that state observable: silence past the limit means dead.
  // Unlike the wake-up path this one is re-armed when the operator changes the limit, since the interval
  // reads it once at start; the watchdog holds no state worth preserving across that restart.
  // Stream methods only read refs; re-running for the hook object's render-time identity would reset the timer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => stream.watch(() => attachedRef.current, silence.limitMs), [silence.limitMs]);

  // Tear the stream down when the whole provider unmounts (app teardown), matching today's cleanup.
  // Stream stop only reads refs; this cleanup intentionally belongs to the provider lifetime, not each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => stream.stop(), []);

  return {
    turns, busy, ready, reconnecting, registerSurface, hasSurface: surfaces > 0, notice, ask, cards, agentsOpen, setAgentsOpen, statsOpen, setStatsOpen,
    reasoningOpen, setReasoningOpen, skillsOpen, setSkillsOpen, tasksOpen, setTasksOpen, syncSessionTasks, helpOpen, setHelpOpen, modelOpen, setModelOpen, loadSkill,
    queued: visibleQueue, readOnly, activeSessionId,
    usage, telemetry, goal, subagents, workflows, lineCfg, input, setInput, attachments, addFiles, removeAttachment, submit, switchSession,
    openReadOnly, exitReadOnly, deleteSession, onQueueRemove, onAnswer, abort, ensureAttached, loadOlder, hasMoreHistory, focusNonce,
    models, currentModel, provider, setModel: (m) => void runModel(m), loadModels: () => void loadModels(), modelsLoading, modelsError,
    showThoughts: thoughts === 'show',
    setShowThoughts: (v) => setThoughts(v ? 'show' : 'hide'),
    workMode, setWorkMode: runMode, planDecision, implementPlan, dismissPlan, planSubmitting,
    renameOpen, closeRename: () => setRenameOpen(false), renameSession,
    commands, runSlash: (cmd) => void runSlash(cmd),
    slash: { items: slashItems, open: slashItems.length > 0 },
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
