import { createAgentSession, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import type { BrainStore, BrainSearchHit, BrainMessageRow, BrainWorkflowRun } from '../../store/brainStore.js';
import type { BrainRuntimeConfig } from '../providers.js';
import { buildBrainRegistry, resolveBrainModel } from '../providers.js';
import { extractText, shapeBrainMessages, withWorkflowAnchors, lastAssistant, pendingSubmittedPlan } from '../messageView.js';
import type { BrainMessageView } from '../messageView.js';
import type { BrainContextBreakdown, BrainPendingPlan, BrainWorkMode } from '../../shared/wireContract.js';
import { buildContextBreakdown, contextSnapshotOf } from '../contextBreakdown.js';
import { sessionUsageSnapshot } from '../events.js';
import type { AskQuestion, BrainCard, BrainUsage } from '../events.js';
import type { LiveSessionRegistry } from '../session/liveRegistry.js';
import type { LiveBrain } from '../session/liveBrain.js';
import { queuedWithPending } from '../session/queueMirror.js';
import type { ElicitationRegistry } from '../elicitation.js';
import type { CardRegistry } from '../cards.js';
import { isNonUserSession, isChannelSession, isTaskSession, channelIdOf, defaultUserSessionId } from '../sessionId.js';
import { terminalizeWorkflow } from '../workflowRuns.js';
import type { BrainDeps } from '../brainDeps.js';
import type { ClientAttachments } from './attachments.js';
import type { ConversationLifecycle } from './lifecycle.js';
import type { PermissionApprovalService } from './permissionApproval.js';
import type { BrainStreamSnapshot } from '../session/liveEventReplay.js';
import { abortSessionWork } from '../session/abortSessionWork.js';
import { gitBranch } from './gitBranch.js';
import { clientDir } from './workDir.js';

/** One row in the caller's conversation list (the pickers' "attached" marker rides `attached`). */
export interface SessionListItem { id: string; title: string; provider: string; model: string; updated_at: string; running: boolean; active: boolean; attached: number }

/** Opt-in slice for the session listings. Both fields are already clamped to non-negative ints by the
 *  route; absent → the full unpaginated list (the historical bare-array response). */
export interface SessionPageOpts { limit?: number; offset?: number }

/** A paginated listing: the requested window plus the totals a client needs to page. */
export interface SessionPage<T> { items: T[]; total: number; hasMore: boolean }

/** Slice `all` by `opts` (offset/limit already non-negative ints; missing limit means "to the end").
 *  `hasMore` is computed from the real slice length so an out-of-range offset reports false, not a lie. */
function paginate<T>(all: T[], opts?: SessionPageOpts): SessionPage<T> {
  const offset = opts?.offset ?? 0;
  const items = opts?.limit === undefined ? all.slice(offset) : all.slice(offset, offset + opts.limit);
  return { items, total: all.length, hasMore: offset + items.length < all.length };
}

/** A backwards window over a conversation's history: the newest `limit` display turns, then older ones as
 *  the reader scrolls up. `before` is the exclusive upper bound — an index into the FULL shaped view array
 *  (what a previous page returned as `nextBefore`). Windowing over the SHAPED views, not raw store rows, is
 *  deliberate: shaping lifts each toolResult onto its assistant toolCall and interleaves compaction / event
 *  markers by time, so a raw-row cut could orphan a diff or a marker. Shaping is cheap; correctness wins. */
export interface MessagePageOpts { limit: number; before?: number }

/** One page of display history plus the cursor for the next (older) page. `nextBefore` is null once the
 *  oldest turn is loaded, which is also exactly when `hasMore` is false. */
export interface MessagePage { items: BrainMessageView[]; hasMore: boolean; nextBefore: number | null }

/** Chat-client status of a conversation — returned by both {@link BrainStatusService.status} and the
 *  BrainService facade that delegates to it. Named once so the ~15-field shape can't drift between them. */
export interface BrainStatusView {
  running: boolean;
  sessionId: string | null;
  title: string;
  model: string;
  provider: string;
  usage: BrainUsage | null;
  thinkingLevel: string;
  thinkingLevels: string[];
  thinkingLevelLabels: Record<string, string>;
  fast: boolean;
  fastAvailable: boolean;
  pendingAsk: { id: string; questions: AskQuestion[]; kind?: 'approval' } | null;
  workMode: BrainWorkMode;
  pendingPlan: BrainPendingPlan | null;
  cards: BrainCard[];
  queued: { id: string; text: string }[];
  yolo: boolean;
  project: BrainProjectView;
}

/** Where the conversation works: the live session's directory (else the stamped one) and its git branch.
 *  Both null for a conversation that never reported a directory — a web chat has no client cwd. Scoped by
 *  the same session resolution as the rest of {@link BrainStatusView}, so it can only ever describe a
 *  conversation the caller owns. */
interface BrainProjectView { cwd: string | null; branch: string | null }

/** One row of the admin session-management panel ({@link BrainStatusService.listManagedSessions}). */
export interface ManagedSessionView {
  id: string;
  title: string;
  provider: string;
  model: string;
  updated_at: string;
  running: boolean;
  active: boolean;
  kind: 'conversation' | 'channel' | 'task';
  tokens: number;
}

/** Answers "does the workflow ENGINE still hold this DAG?" — true/false from the engine, undefined when
 *  the engine cannot be asked (registry not loaded yet, control absent, unwired test harness). */
export type WorkflowLivenessProbe = (workflowId: string) => boolean | undefined;

/** Module-level like the messageView caps setters, because the status service is constructed deep inside
 *  BrainService while the plugin registry lives beside it in the daemon core — threading the probe through
 *  every intermediate constructor would touch each of them for one read-only lookup. */
let workflowEngineHolds: WorkflowLivenessProbe = () => undefined;
export function setWorkflowLivenessProbe(probe: WorkflowLivenessProbe): void { workflowEngineHolds = probe; }

/** The CURRENT probe's answer for one workflow — the single read path `workflowRuns` consults, exported
 *  so the daemon wiring test can observe what buildBrainCore actually installed (the setter alone is
 *  write-only, and a deleted production call would otherwise be invisible to every test). */
export function probeWorkflowLiveness(workflowId: string): boolean | undefined { return workflowEngineHolds(workflowId); }

/** The daemon wiring for the probe: ask the loaded plugin registry's `workflow` control whether the
 *  engine still holds the DAG. `registry` is a live getter (the registry is loaded lazily and replaced on
 *  every plugin reload); before the first load it yields undefined and the probe honestly answers "cannot
 *  tell" instead of guessing. Kept here, next to its consumer, so the closure is a testable unit rather
 *  than an inline lambda in brainCore no test can reach. */
export function workflowEngineProbeFrom(
  registry: () => { control(name: 'workflow'): { isWorkflowLive(input: { workflowId: string }): boolean } | undefined } | undefined,
): WorkflowLivenessProbe {
  return (workflowId) => registry()?.control('workflow')?.isWorkflowLive({ workflowId });
}

/** Take the `limit` views ending just before `before` (default: the tail = newest). `start` is clamped so
 *  an out-of-range `before` still yields a valid window, and `nextBefore` points at this window's start so
 *  the next fetch continues seamlessly older. */
function windowViews(all: BrainMessageView[], opts: MessagePageOpts): MessagePage {
  const end = opts.before === undefined ? all.length : Math.max(0, Math.min(opts.before, all.length));
  const start = Math.max(0, end - opts.limit);
  return { items: all.slice(start, end), hasMore: start > 0, nextBefore: start > 0 ? start : null };
}

interface StatusServiceDeps {
  store: BrainStore;
  /** The shared live-session state (owned by the BrainService facade). */
  sessions: LiveSessionRegistry<LiveBrain>;
  attachments: ClientAttachments;
  elicitation: ElicitationRegistry;
  cards: CardRegistry;
  lifecycle: ConversationLifecycle;
  permissions: PermissionApprovalService;
  config: BrainDeps['config'];
  runtime: BrainDeps['runtime'];
  /** The caller's repo access, re-resolved per request so the project section reflects CURRENT project
   *  assignments. Absent (tests) → all-access. */
  policy?: BrainDeps['policy'];
  /** Injected for tests; defaults to PI's createAgentSession (smoke test only). */
  createSession?: typeof createAgentSession;
  /** Working dir for the throwaway smoke-test session. Default: process.cwd(). */
  cwd?: string;
}

/** Read-only views over the brain: chat-client status, session lists, history, message search, and the
 *  model-readiness helpers (resolvableModel + the connectivity smoke test). */
export class BrainStatusService {
  constructor(private d: StatusServiceDeps) {}

  private subagentRuns(sessionId: string) {
    // Restart orphans are repaired durably at boot (BrainService.reconcileDelegationsOnBoot), so this is
    // NOT that fix — it is the read-time fallback for a row that goes stale WITHIN a process run: a child
    // whose live registration is already gone while its terminal upsert has not landed. Hiding it keeps a
    // dead child from rendering a phantom running spinner in the meantime.
    //
    // A boot-claimed recovery is the one durable exception. Claiming precedes platform startup, while the
    // in-memory child edge is raised only when the recovery turn enters ChannelSessionService.send. Without
    // this second liveness source, a reconnect snapshot taken in that window drops the running child from
    // the transcript projection, and recovery emits no plugin progress event that could add it later.
    const active = new Set([
      ...this.d.sessions.childrenOf(sessionId),
      ...this.d.store.recoveringSubagentSessionIds(sessionId),
    ]);
    return this.d.store.getSubagentRuns(sessionId)
      .filter((run) => run.status !== 'running' || active.has(run.sessionId));
  }

  /** The conversation's durable DAGs. Same read-time fallback as subagentRuns, but a TRANSFORM rather than
   *  a filter: a workflow row is the only thing that renders its transcript marker, so hiding it would lose
   *  the record of what ran — it is terminalized for display instead.
   *
   *  A `running` row is verified against the ENGINE first (the workflow control's liveness probe): the
   *  row is not authoritative — a failed terminal snapshot or missed boot reconcile leaves it claiming
   *  `running` while the engine dropped the DAG long ago, and with a live origin session that stale row
   *  would keep synthesizing a phantom anchor until the next restart. The engine's answer wins in BOTH
   *  directions (a background DAG keeps running after its origin session is reaped).
   *
   *  Only when the engine cannot be asked (registry not loaded, unwired tests) does this fall back to the
   *  origin session's liveness — and deliberately not childrenOf: a genuinely running workflow has real
   *  windows with zero live children (between one node ending and tick() launching the next), which a
   *  children-based check would misread as an orphan and flicker. */
  private workflowRuns(sessionId: string): BrainWorkflowRun[] {
    const sessionLive = this.d.sessions.has(sessionId)
      || (isChannelSession(sessionId) && !!this.d.sessions.channelGet(channelIdOf(sessionId)));
    return this.d.store.getWorkflowRuns(sessionId).map((run) => {
      if (run.status !== 'running') return run;
      const live = probeWorkflowLiveness(run.id) ?? sessionLive;
      return live ? run : terminalizeWorkflow(run);
    });
  }

  /** The one place a conversation's durable history is shaped: rows plus every sidecar. Callers pass rows
   *  only when they have already filtered them (streamSnapshot). Keeping the sidecar list here is what
   *  stops the same three-argument call being copied to each read path. */
  private shapedHistory(sessionId: string, rows = this.d.store.getMessages(sessionId)): BrainMessageView[] {
    return shapeBrainMessages(
      rows,
      this.subagentRuns(sessionId),
      this.d.store.getSessionEvents(sessionId),
      this.workflowRuns(sessionId),
    );
  }

  /** Plan mode's state for one conversation: the mode the daemon last ran a turn in, plus the plan that
   *  turn submitted and is now waiting on the user. Published so a client stops having to guess either —
   *  the mode is stamped per send and kept nowhere else, so a plan entered from the CLI was invisible to
   *  the web, and a tab that reloaded lost the decision entirely.
   *
   *  The plan is read ONLY in plan mode: outside it there is no decision to raise (the model calls
   *  ExitPlanMode nowhere else), and the gate is also what keeps every ordinary status call off the
   *  history read. `rows` lets a caller that already loaded them (the snapshot) skip a second query. */
  private planState(live: LiveBrain | undefined, sessionId: string | null, rows?: BrainMessageRow[]): { workMode: BrainWorkMode; pendingPlan: BrainPendingPlan | null } {
    if (!sessionId) return { workMode: live?.lastTurnMode ?? 'build', pendingPlan: null };
    // A LIVE conversation whose last turn ran in build mode has no pending plan — ExitPlanMode is called in
    // no other mode — so trust the in-memory stamp and skip the history read entirely. This keeps the hot
    // status poll (build mode is the common case) off the DB, where the only index is on session_id.
    if (live && live.lastTurnMode !== 'plan') return { workMode: 'build', pendingPlan: null };
    // Otherwise the plan is read from durable history, not from live.lastTurnMode: that stamp lives only in
    // memory and a daemon restart resets it to 'build', which would strand a decision the transcript still
    // holds (the modal that never came back after a redeploy). A submitted, still-undecided ExitPlanMode IS
    // the proof we are plan-pending, so it also fixes the reported work mode when the live stamp is gone —
    // a cold session after a restart (no live to trust) falls through here. `rows` lets the snapshot reuse
    // the history it already loaded; the status poll reads only the newest turn, never the full history.
    const pendingPlan = pendingSubmittedPlan(rows ?? this.d.store.getLatestTurn(sessionId));
    return { workMode: pendingPlan ? 'plan' : (live?.lastTurnMode ?? 'build'), pendingPlan };
  }

  /** The current provider config, or null when nothing is configured (never throws). Shared by the
   *  readiness helpers below so they can report "not configured" instead of blowing up. */
  private currentConfig(): BrainRuntimeConfig | null {
    const cfg = typeof this.d.config === 'function' ? this.d.config() : this.d.config;
    return cfg && cfg.providers.length > 0 ? cfg : null;
  }

  /** The model id `resolveBrainModel` would pick from the CURRENT config (server default selection), or
   *  null when no provider resolves. Cheap + synchronous — the single source of truth /system/readiness
   *  reuses so the chat-readiness check and the brain agree on what "runnable" means. */
  resolvableModel(): string | null {
    const cfg = this.currentConfig();
    if (!cfg) return null;
    try {
      const registry = buildBrainRegistry(cfg, this.d.runtime);
      return resolveBrainModel(registry, cfg).id;
    } catch { return null; }
  }

  /** Prove the configured brain actually answers: run ONE minimal, non-streaming turn on a throwaway,
   *  tool-less, disk-free PI session and capture the reply. Never persists a conversation, never touches
   *  a user session, and swallows every failure into `{ ok:false, error }` — it must never throw. Reuses
   *  the exact model-invocation path a chat turn uses (buildBrainRegistry → resolveBrainModel →
   *  createAgentSession → session.prompt), just without plugin tools, memory, personas or the store. */
  async smokeTest(sel?: { providerId?: string; model?: string }): Promise<{ ok: boolean; model?: string; reply?: string; error?: string }> {
    const cfg = this.currentConfig();
    if (!cfg) return { ok: false, error: 'no brain provider configured — add one in Settings → Brain' };
    let session: import('@earendil-works/pi-coding-agent').AgentSession | undefined;
    try {
      const registry = buildBrainRegistry(cfg, this.d.runtime);
      const selection = sel?.providerId || sel?.model ? { provider: sel?.providerId, model: sel?.model } : undefined;
      const resolved = resolveBrainModel(registry, cfg, selection);
      // Cap the output tiny — a connectivity probe needs one word, not a paragraph.
      const model = { ...resolved, maxTokens: 512 }; // headroom so reasoning models that spend tokens thinking still emit a reply
      const cwd = this.d.cwd ?? process.cwd();
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir: cwd, systemPrompt: 'You are a connectivity probe. Reply with just: OK',
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      });
      await resourceLoader.reload();
      const create = this.d.createSession ?? createAgentSession;
      ({ session } = await create({
        cwd, sessionManager: SessionManager.inMemory(cwd),
        modelRuntime: this.d.runtime, model, resourceLoader,
        customTools: [], tools: [], noTools: 'all',
      }));
      const live = session;
      // ~20s ceiling: a wedged endpoint must not hang the admin request. On timeout we abort the run.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('brain did not respond within 20s')), 20_000); });
      try { await Promise.race([live.prompt('Reply with just: OK'), timeout]); }
      finally { if (timer) clearTimeout(timer); }
      const last = lastAssistant(live.messages as { role?: string }[]);
      const reply = (last ? extractText(last) : '').trim();
      if (!reply) return { ok: false, model: resolved.id, error: 'brain returned an empty reply' };
      return { ok: true, model: resolved.id, reply: reply.slice(0, 200) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      if (session) { try { await abortSessionWork(session); } catch { /* already settled */ } session.dispose(); }
    }
  }

  /** Chat-client status — of the active conversation, or of the caller's explicit `session` (a bound
   *  CLI), so a client bound elsewhere never renders another conversation's model/title/pending ask. */
  status(userId: number, session?: string): BrainStatusView {
    const explicit = session ? this.d.lifecycle.ownedUserSession(userId, session) : undefined;
    const b = explicit ? this.d.sessions.get(explicit) : this.d.lifecycle.activeLive(userId);
    const sess = b?.session as { thinkingLevel?: string; supportsThinking?: () => boolean; getAvailableThinkingLevels?: () => string[] } | undefined;
    const supports = sess?.supportsThinking?.() ?? false;
    // The conversation's title (from the store, so it's present even before a live session exists)
    // — drives the CLI header and any client that wants to name the current chat.
    const activeId = explicit ?? b?.sessionId ?? this.d.lifecycle.activeSessionId(userId);
    const row = activeId ? this.d.store.getSession(activeId) : undefined;
    const title = row?.title || '';
    // The live directory wins over the stored stamp: `/cd` moves the live conversation first. `gitBranch`
    // reads `.git/HEAD` behind a short-lived cache, so this hot poll never forks a process.
    //
    // Both the directory and the branch are re-authorized against the policy resolved NOW, never trusted
    // from the stored stamp: a directory stamped while the user still had the project must stop being
    // reported the moment that access is revoked.
    const policy = this.d.policy?.(userId) ?? { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
    const cwd = clientDir(policy, b?.workDir ?? row?.work_dir ?? undefined) ?? null;
    return {
      running: !!b, sessionId: b?.sessionId ?? null, title, model: b?.model ?? '', provider: b?.provider ?? '',
      usage: b ? sessionUsageSnapshot(b.session, this.d.store, b.sessionId) : null,
      thinkingLevel: (sess?.thinkingLevel as string) ?? b?.thinkingLevel ?? '',
      thinkingLevels: supports ? (sess?.getAvailableThinkingLevels?.() ?? []) : [],
      thinkingLevelLabels: b?.thinkingLabels ?? {},
      fast: b?.requestProfile.fast ?? false,
      fastAvailable: b?.fastAvailable ?? false,
      // A question parked for the active conversation, so a client reconnecting mid-question (refresh, SSE
      // drop) restores the picker instead of hanging until the timeout.
      pendingAsk: b ? this.d.elicitation.pendingForSession(b.sessionId) : null,
      // Plan mode's mode + parked decision, for the same reason as the question above: a client that was
      // not attached when the plan was submitted (a reload, a second tab, a surface that never entered
      // plan mode itself) can only learn about it here.
      ...this.planState(b, activeId),
      // The conversation's display cards (ctx.emitCard) so a client restores them on connect. Keyed on the
      // CONVERSATION, not the live session: reopening a chat the user closed has no live brain yet, and
      // that is exactly when the todo checklist has to come back rather than show up empty.
      cards: activeId ? this.d.cards.forSession(activeId) : [],
      // PI's transient pending backlog (steered + follow-up) plus any message waiting under a manual
      // /compact, so a reconnecting/booting client restores its pending chips — kept in step with the live
      // `queue` event mapped from PI's `queue_update` and the compaction-pending publishes.
      queued: b ? queuedWithPending(b) : [],
      // Effective YOLO for the active conversation (session override, else the persisted default) —
      // drives the CLI's warning-toned indicator.
      yolo: this.d.permissions.effectiveYolo(userId, b),
      project: { cwd, branch: cwd ? gitBranch(cwd, policy) : null },
    };
  }

  /** What is currently filling the conversation's context window, category by category — the reporting
   *  companion to {@link status}'s single fill percentage. Same session resolution, so a bound client asks
   *  about ITS conversation. Null when no live session holds the conversation: the breakdown describes the
   *  prompt PI would send right now, and a stored transcript alone has neither a system prompt nor a tool
   *  set. Read-only — it never touches what the next request sends. */
  contextBreakdown(userId: number, session?: string): BrainContextBreakdown | null {
    const explicit = session ? this.d.lifecycle.ownedUserSession(userId, session) : undefined;
    const b = explicit ? this.d.sessions.get(explicit) : this.d.lifecycle.activeLive(userId);
    return b ? buildContextBreakdown(contextSnapshotOf(b.session, b.model)) : null;
  }

  /** The user's conversations (channel sessions excluded), most recent first, with live/active flags and
   *  how many client streams currently hold each one — the shared, unpaginated source for the public
   *  listings below. A conversation begins when the user says something, not when a client opens one: the
   *  CLI mints a session the moment it launches, and listing that row would put an empty, untitled
   *  conversation in the picker for a chat nobody had typed into yet, so unspoken shells are withheld. */
  private ownedSessions(userId: number): SessionListItem[] {
    const activeId = this.d.lifecycle.activeSessionId(userId);
    const unspoken = this.d.store.unspokenSessionIds(userId);
    return this.d.store.listSessions(userId)
      .filter((s) => !isNonUserSession(s.id) && !unspoken.has(s.id))
      .map((s) => ({ id: s.id, title: s.title, provider: s.provider, model: s.model, updated_at: s.updated_at, running: this.d.sessions.has(s.id), active: s.id === activeId, attached: this.d.attachments.attachedCount(s.id) }));
  }

  /** The user's conversations, most recent first (pickers show an "attached" marker so the user sees
   *  which conversations another terminal/dock is working in). Pagination is opt-in and applied AFTER the
   *  identity/unspoken filter: omit `opts` for the historical bare array (every current caller relies on
   *  it), pass it for a `{ items, total, hasMore }` window. */
  listSessions(userId: number): SessionListItem[];
  listSessions(userId: number, opts: SessionPageOpts): SessionPage<SessionListItem>;
  listSessions(userId: number, opts?: SessionPageOpts): SessionListItem[] | SessionPage<SessionListItem> {
    const all = this.ownedSessions(userId);
    return opts ? paginate(all, opts) : all;
  }

  /** The caller's conversations eligible to bind into a channel (the /context picker). Same identity
   *  scoping as listSessions, minus the bare default `brain-<uid>` — re-keying it into a channel slot
   *  would strip the user's default id for their next fresh start, so it is never offered. Always
   *  paginated (the picker's only consumer). bindChannelContext re-checks the exclusion server-side. */
  listContextSessions(userId: number, opts?: SessionPageOpts): SessionPage<SessionListItem> {
    const all = this.ownedSessions(userId).filter((s) => s.id !== defaultUserSessionId(userId));
    return paginate(all, opts);
  }

  /** Fulltext search across the user's stored conversations (channel sessions included — they carry
   *  the owner's user_id, so ownership scoping is the store's join). */
  searchMessages(userId: number, query: string): BrainSearchHit[] {
    return this.d.store.searchMessages(userId, query);
  }

  /** ADMIN session-management view (the sessions/ panel): EVERY brain session this owner anchors — their
   *  own conversations PLUS the platform channel sessions (Discord) and task-worker sessions. Only the
   *  never-spoken-in shells are withheld (same rule as listSessions — an open CLI is not a conversation
   *  yet); each surviving row is tagged with its `kind` so the UI can group + icon it. */
  listManagedSessions(userId: number): ManagedSessionView[] {
    const activeId = this.d.lifecycle.activeSessionId(userId);
    const tokens = this.d.store.tokenTotals(userId);
    const unspoken = this.d.store.unspokenSessionIds(userId);
    return this.d.store.listSessions(userId).filter((s) => !unspoken.has(s.id)).map((s) => {
      const channel = isChannelSession(s.id);
      const running = channel ? !!this.d.sessions.channelGet(channelIdOf(s.id)) : this.d.sessions.has(s.id);
      return {
        id: s.id, title: s.title, provider: s.provider, model: s.model, updated_at: s.updated_at, running, active: s.id === activeId,
        kind: channel ? 'channel' as const : isTaskSession(s.id) ? 'task' as const : 'conversation' as const,
        tokens: tokens[s.id] ?? 0,
      };
    });
  }

  /** The user's stored conversation, shaped for display (channels render this on connect). Reads the
   *  sole store; no live session required, so it works before/independently of `start`. */
  history(userId: number): BrainMessageView[] {
    const id = this.d.lifecycle.activeSessionId(userId);
    return withWorkflowAnchors(this.shapedHistory(id), this.workflowRuns(id));
  }

  /** ANY of the owner's stored sessions, shaped for display — including the channel (Discord) and
   *  task-worker sessions that `start()` refuses to resume. Ownership-checked; used by the read-only
   *  history view (Sessions → open in web chat). Throws for an unknown or foreign session. */
  messagesOf(userId: number, sessionId: string): BrainMessageView[] {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    return withWorkflowAnchors(this.shapedHistory(sessionId), this.workflowRuns(sessionId));
  }

  /** A backwards-paged window over a conversation's history for the chat's lazy-load: the newest `limit`
   *  turns on first fetch, then older ones as `before` walks back. Defaults to the caller's active
   *  conversation; an explicit `sessionId` is ownership-checked exactly like {@link messagesOf}. Shapes the
   *  full history then windows it (see {@link windowViews}) so folding/marker interleaving stays intact. */
  messagesPage(userId: number, sessionId: string | undefined, opts: MessagePageOpts): MessagePage {
    if (sessionId !== undefined) {
      const row = this.d.store.getSession(sessionId);
      if (!row || row.user_id !== userId) throw new Error('unknown session');
    }
    const id = sessionId ?? this.d.lifecycle.activeSessionId(userId);
    const page = windowViews(this.shapedHistory(id), opts);
    // Anchors are pinned AFTER windowing, and only into the FIRST (newest) page: the window can cut a
    // running workflow's WorkflowStart row out of view, and without it the panel and every subsequent
    // live snapshot are lost (see withWorkflowAnchors). Older pages are skipped so paging back never
    // duplicates the pin, and the cursor is untouched — synthetic views carry no window position.
    return opts.before === undefined
      ? { ...page, items: withWorkflowAnchors(page.items, this.workflowRuns(id)) }
      : page;
  }

  /** Atomic, idempotent first frame for an opt-in fixed-session SSE stream. Reads the clean durable
   *  history and the live run journal synchronously on the same event-loop turn, so an event cannot
   *  fall between the two halves. The route installs its tap immediately before calling this method. */
  streamSnapshot(userId: number, sessionId: string, history?: MessagePageOpts): BrainStreamSnapshot {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    const live = this.d.sessions.get(sessionId)
      ?? (isChannelSession(sessionId) ? this.d.sessions.channelGet(channelIdOf(sessionId)) : undefined);
    const replay = live?.replay.transportSnapshot() ?? { cursor: 0, events: [], run: 0, eventCursors: [] };
    const orderedUserRows = new Set(replay.events.flatMap((event) =>
      event.type === 'user' && event.durableId ? [event.durableId] : []));
    // Journaled users are already durable, but replaying them is what preserves their position among
    // pre/post-steer deltas. Remove exactly those id-matched rows from the history prefix (no text
    // guessing: display text may differ from persisted image/mention framing).
    const rows = this.d.store.getMessages(sessionId);
    const clean = this.shapedHistory(
      sessionId,
      rows.filter((message) => !orderedUserRows.has(message.id)),
    );
    // Window AFTER the removal, never before: cutting first would let a journaled row consume a slot of
    // the window and drop a real turn out of the page. The removed rows all belong to the UNSETTLED run,
    // i.e. the very tail, so everything before `nextBefore` is identical in the unfiltered array the
    // lazy-load pages through — the cursor stays valid across the two endpoints.
    const page = history ? windowViews(clean, history) : undefined;
    // Same first-page pinning as messagesPage: a reconnect hydrates from THIS frame, so a running
    // workflow whose anchor row was compacted or windowed away would otherwise vanish from the panel
    // and drop every later live snapshot (no row to attach to).
    const views = page ? page.items : clean;
    const anchoredViews = history?.before === undefined
      ? withWorkflowAnchors(views, this.workflowRuns(sessionId))
      : views;
    return {
      type: 'snapshot',
      sessionId,
      session: { model: live?.model ?? row.model, provider: live?.providerId ?? row.provider },
      cards: this.d.cards.forSession(sessionId),
      goal: this.d.store.getGoal(sessionId) ?? null,
      history: anchoredViews,
      control: {
        streaming: !!live && (live.session.isStreaming || this.d.sessions.hasActiveChildren(live.sessionId)),
        pendingAsk: live ? this.d.elicitation.pendingForSession(live.sessionId) : null,
        ...this.planState(live, sessionId, rows),
      },
      ...(page ? { hasMore: page.hasMore, nextBefore: page.nextBefore } : {}),
      ...replay,
    };
  }
}
