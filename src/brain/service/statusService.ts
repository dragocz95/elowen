import { createAgentSession, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import type { BrainStore, BrainSearchHit } from '../../store/brainStore.js';
import type { BrainRuntimeConfig } from '../providers.js';
import { buildBrainRegistry, resolveBrainModel } from '../providers.js';
import { extractText, shapeBrainMessages } from '../messageView.js';
import type { BrainMessageView } from '../messageView.js';
import { usageOf, queueItems, withDescendantUsage } from '../events.js';
import type { AskQuestion, BrainCard, BrainUsage } from '../events.js';
import type { LiveSessionRegistry } from '../session/liveRegistry.js';
import type { LiveBrain } from '../session/liveBrain.js';
import type { ElicitationRegistry } from '../elicitation.js';
import type { CardRegistry } from '../cards.js';
import { isNonUserSession } from '../sessionId.js';
import type { BrainDeps } from '../brainDeps.js';
import type { ClientAttachments } from './attachments.js';
import type { ConversationLifecycle } from './lifecycle.js';
import type { PermissionApprovalService } from './permissionApproval.js';
import type { BrainStreamSnapshot } from '../session/liveEventReplay.js';

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
  authStorage?: BrainDeps['authStorage'];
  /** Injected for tests; defaults to PI's createAgentSession (smoke test only). */
  createSession?: typeof createAgentSession;
  /** Working dir for the throwaway smoke-test session. Default: process.cwd(). */
  cwd?: string;
}

/** Read-only views over the brain: chat-client status, session lists, history, message search, and the
 *  model-readiness helpers (resolvableModel + the connectivity smoke test). */
export class BrainStatusService {
  constructor(private d: StatusServiceDeps) {}

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
      const registry = buildBrainRegistry(cfg, this.d.authStorage);
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
      const registry = buildBrainRegistry(cfg, this.d.authStorage);
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
        modelRegistry: registry, model, resourceLoader,
        customTools: [], tools: [], noTools: 'all',
      }));
      const live = session;
      // ~20s ceiling: a wedged endpoint must not hang the admin request. On timeout we abort the run.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('brain did not respond within 20s')), 20_000); });
      try { await Promise.race([live.prompt('Reply with just: OK'), timeout]); }
      finally { if (timer) clearTimeout(timer); }
      const last = [...(live.messages as { role?: string }[])].reverse().find((m) => m.role === 'assistant');
      const reply = (last ? extractText(last) : '').trim();
      if (!reply) return { ok: false, model: resolved.id, error: 'brain returned an empty reply' };
      return { ok: true, model: resolved.id, reply: reply.slice(0, 200) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      if (session) { try { await session.abort(); } catch { /* already settled */ } session.dispose(); }
    }
  }

  /** Chat-client status — of the active conversation, or of the caller's explicit `session` (a bound
   *  CLI), so a client bound elsewhere never renders another conversation's model/title/pending ask. */
  status(userId: number, session?: string): { running: boolean; sessionId: string | null; title: string; model: string; usage: BrainUsage | null; thinkingLevel: string; thinkingLevels: string[]; thinkingLevelLabels: Record<string, string>; fast: boolean; fastAvailable: boolean; pendingAsk: { id: string; questions: AskQuestion[]; kind?: 'approval' } | null; cards: BrainCard[]; queued: { id: string; text: string }[]; yolo: boolean } {
    const explicit = session ? this.d.lifecycle.ownedUserSession(userId, session) : undefined;
    const b = explicit ? this.d.sessions.get(explicit) : this.d.lifecycle.activeLive(userId);
    const sess = b?.session as { thinkingLevel?: string; supportsThinking?: () => boolean; getAvailableThinkingLevels?: () => string[] } | undefined;
    const supports = sess?.supportsThinking?.() ?? false;
    // The conversation's title (from the store, so it's present even before a live session exists)
    // — drives the CLI header and any client that wants to name the current chat.
    const activeId = explicit ?? b?.sessionId ?? this.d.lifecycle.activeSessionId(userId);
    const title = (activeId && this.d.store.getSession(activeId)?.title) || '';
    return {
      running: !!b, sessionId: b?.sessionId ?? null, title, model: b?.model ?? '',
      usage: b ? withDescendantUsage(usageOf(b.session), this.d.store.descendantUsage(b.sessionId)) : null,
      thinkingLevel: (sess?.thinkingLevel as string) ?? b?.thinkingLevel ?? '',
      thinkingLevels: supports ? (sess?.getAvailableThinkingLevels?.() ?? []) : [],
      thinkingLevelLabels: b?.thinkingLabels ?? {},
      fast: b?.requestProfile.fast ?? false,
      fastAvailable: b?.fastAvailable ?? false,
      // A question parked for the active conversation, so a client reconnecting mid-question (refresh, SSE
      // drop) restores the picker instead of hanging until the timeout.
      pendingAsk: b ? this.d.elicitation.pendingForSession(b.sessionId) : null,
      // The active conversation's live display cards (ctx.emitCard) so a reconnecting client restores them.
      cards: b ? this.d.cards.forSession(b.sessionId) : [],
      // PI's transient pending backlog (steered + follow-up) so a reconnecting/booting client restores its
      // pending chips — kept in step with the live `queue` event mapped from PI's `queue_update`.
      queued: b ? queueItems(b.session.getSteeringMessages(), b.session.getFollowUpMessages()) : [],
      // Effective YOLO for the active conversation (session override, else the persisted default) —
      // drives the CLI's warning-toned indicator.
      yolo: this.d.permissions.effectiveYolo(userId, b),
    };
  }

  /** The user's conversations (channel sessions excluded), most recent first, with live/active flags
   *  and how many client streams currently hold each one (pickers show an "attached" marker so the
   *  user sees which conversations another terminal/dock is working in). */
  listSessions(userId: number): { id: string; title: string; model: string; updated_at: string; running: boolean; active: boolean; attached: number }[] {
    const activeId = this.d.lifecycle.activeSessionId(userId);
    return this.d.store.listSessions(userId)
      .filter((s) => !isNonUserSession(s.id))
      .map((s) => ({ id: s.id, title: s.title, model: s.model, updated_at: s.updated_at, running: this.d.sessions.has(s.id), active: s.id === activeId, attached: this.d.attachments.attachedCount(s.id) }));
  }

  /** Fulltext search across the user's stored conversations (channel sessions included — they carry
   *  the owner's user_id, so ownership scoping is the store's join). */
  searchMessages(userId: number, query: string): BrainSearchHit[] {
    return this.d.store.searchMessages(userId, query);
  }

  /** ADMIN session-management view (the sessions/ panel): EVERY brain session this owner anchors — their
   *  own conversations PLUS the platform channel sessions (Discord) and task-worker sessions. Nothing is
   *  filtered out (unlike listSessions); each row is tagged with its `kind` so the UI can group + icon it. */
  listManagedSessions(userId: number): { id: string; title: string; model: string; updated_at: string; running: boolean; active: boolean; kind: 'conversation' | 'channel' | 'task'; tokens: number }[] {
    const activeId = this.d.lifecycle.activeSessionId(userId);
    const tokens = this.d.store.tokenTotals(userId);
    return this.d.store.listSessions(userId).map((s) => {
      const channel = s.id.startsWith('brain-ch-');
      const running = channel ? !!this.d.sessions.channelGet(s.id.slice('brain-ch-'.length)) : this.d.sessions.has(s.id);
      return {
        id: s.id, title: s.title, model: s.model, updated_at: s.updated_at, running, active: s.id === activeId,
        kind: channel ? 'channel' as const : s.id.startsWith('brain-task-') ? 'task' as const : 'conversation' as const,
        tokens: tokens[s.id] ?? 0,
      };
    });
  }

  /** The user's stored conversation, shaped for display (channels render this on connect). Reads the
   *  sole store; no live session required, so it works before/independently of `start`. */
  history(userId: number): BrainMessageView[] {
    const sessionId = this.d.lifecycle.activeSessionId(userId);
    return shapeBrainMessages(this.d.store.getMessages(sessionId), this.d.store.getSubagentRuns(sessionId));
  }

  /** ANY of the owner's stored sessions, shaped for display — including the channel (Discord) and
   *  task-worker sessions that `start()` refuses to resume. Ownership-checked; used by the read-only
   *  history view (Sessions → open in web chat). Throws for an unknown or foreign session. */
  messagesOf(userId: number, sessionId: string): BrainMessageView[] {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    return shapeBrainMessages(this.d.store.getMessages(sessionId), this.d.store.getSubagentRuns(sessionId));
  }

  /** Atomic, idempotent first frame for an opt-in fixed-session SSE stream. Reads the clean durable
   *  history and the live run journal synchronously on the same event-loop turn, so an event cannot
   *  fall between the two halves. The route installs its tap immediately before calling this method. */
  streamSnapshot(userId: number, sessionId: string): BrainStreamSnapshot {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    const live = this.d.sessions.get(sessionId)
      ?? (sessionId.startsWith('brain-ch-') ? this.d.sessions.channelGet(sessionId.slice('brain-ch-'.length)) : undefined);
    const replay = live?.replay.transportSnapshot() ?? { cursor: 0, events: [], run: 0, eventCursors: [] };
    const orderedUserRows = new Set(replay.events.flatMap((event) =>
      event.type === 'user' && event.durableId ? [event.durableId] : []));
    return {
      type: 'snapshot',
      sessionId,
      goal: this.d.store.getGoal(sessionId) ?? null,
      // Journaled users are already durable, but replaying them is what preserves their position among
      // pre/post-steer deltas. Remove exactly those id-matched rows from the history prefix (no text
      // guessing: display text may differ from persisted image/mention framing).
      history: shapeBrainMessages(
        this.d.store.getMessages(sessionId).filter((message) => !orderedUserRows.has(message.id)),
        this.d.store.getSubagentRuns(sessionId),
      ),
      ...replay,
    };
  }
}
