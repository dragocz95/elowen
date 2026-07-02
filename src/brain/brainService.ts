import { createAgentSession, DefaultResourceLoader, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { PluginRegistry } from '../plugins/registry.js';
import type { Policy } from '../plugins/policy.js';
import { runWithPolicy } from '../plugins/policyContext.js';
import type { TurnIdentity } from '../plugins/policyContext.js';
import type { AuthStorage } from '@earendil-works/pi-coding-agent';
import type { BrainStore, BrainSearchHit } from '../store/brainStore.js';
import type { BrainRuntimeConfig } from './providers.js';
import { buildBrainRegistry, resolveBrainModel } from './providers.js';
import { orcaExec } from '../shared/execs.js';
import { buildOrcaTools } from './tools/index.js';
import { personalityText } from './personality.js';
import { projectEvent, projectUserTurn, rehydrate } from './persistence.js';
import { shapeBrainMessages, toolDetail, extractText } from './messageView.js';
import type { BrainMessageView } from './messageView.js';

/** What a channel (web/terminal, later Discord) receives from the brain. Stable regardless of the
 *  underlying PI event shape — the mapping lives in one place (`toBrainEvent`). */
export type BrainEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'diff'; diff: string }
  /** A tool produced a stored image (`/api/brain/images/…`) — channels attach it even when the
   *  model's final text forgets to repeat the markdown link. */
  | { type: 'image'; ref: string }
  | { type: 'idle'; usage?: BrainUsage; model?: string }
  | { type: 'error'; message: string };

/** Statusline data for one live conversation: current context fill + session totals. */
export interface BrainUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  totalTokens: number;
  cost: number;
}

export type { BrainMessageView } from './messageView.js';

export interface BrainDeps {
  store: BrainStore;
  users: {
    ensureAdvisorToken(userId: number): string;
    get(userId: number): { name?: string; username?: string } | null | undefined;
  };
  /** The provider set, or a live resolver so provider/OAuth changes apply without a daemon restart.
   *  A resolver returning null means "nothing configured yet" — `start` fails with a clear error. */
  config: BrainRuntimeConfig | (() => BrainRuntimeConfig | null);
  /** Credential store for the brain's providers (OAuth tokens live here). Default: in-memory. */
  authStorage?: AuthStorage;
  /** Renders the brain's system prompt from the editable `advisor` template (per-user override aware). */
  prompts: { render(name: string, vars: Record<string, string>, userId?: number): string };
  /** Daemon REST base the brain's tools call (ORCA_URL). */
  url: string;
  /** Working dir for the in-memory session (not a repo checkout). Default: process.cwd(). */
  cwd?: string;
  /** Enabled plugins' aggregated contributions (tools/skills/prompt fragments). Absent → brain runs
   *  exactly as before plugins existed. Tests inject a ready registry directly. */
  plugins?: PluginRegistry;
  /** Production supplies a thunk (buildApp is sync, plugin loading is async) — resolved and memoized on
   *  first `start`, so the daemon stays synchronous while plugins load lazily on first brain use. */
  loadPlugins?: () => Promise<PluginRegistry>;
  /** Resolves the repo-access Policy for a user; carried into plugin tool execution via AsyncLocalStorage. */
  policy?: (userId: number) => Policy;
  /** Per-user CLI/brain settings: an optional model override (empty → configured default) + auto-compact
   *  toggle and its user-tunable threshold percentage. */
  userSettings?: (userId: number) => { model?: string; modelProvider?: string; visionModel?: string; visionModelProvider?: string; thinkingLevel?: string; autoCompact?: boolean; autoCompactAt?: number; advisorStyle?: string };
  /** The assistant's configured display identity (Settings → Orca AI). Absent → 'Orca'. */
  agentName?: () => string;
  /** Resolve a platform sender (e.g. a Discord id) to the Orca user who claimed it in their account
   *  settings. Lets channel turns carry a verified identity line for registered users. */
  resolvePlatformUser?: (platform: string, platformUserId: string) => { id: number; name: string; username?: string; admin: boolean } | null;
  /** Per-user brain-model permission, keyed by exec spec `orca:<provider>/<model>`. Absent → no
   *  restriction (open mode / tests). Enforced on explicit picks; a saved-but-revoked default
   *  silently falls back to the server default instead of erroring. */
  execAllowed?: (userId: number, exec: string) => boolean;
  /** Build a Policy from an explicit project-id set (platform role mappings resolve through this). */
  policyForProjects?: (projectIds: number[]) => Policy;
  /** The Orca user that anchors platform channel sessions (their token drives the tools) — the admin. */
  platformOwner?: () => number | undefined;
  /** Injected for tests; defaults to PI's createAgentSession. */
  createSession?: typeof createAgentSession;
  /** Injected for tests; builds the resource loader that carries the Orca system prompt. A test passes
   *  `() => undefined` so no disk-touching loader is constructed. */
  resourceLoaderFactory?: (o: { cwd: string; systemPrompt: string; appendSystemPrompt?: string[] }) => ResourceLoader | undefined;
}

/** Default resource loader: carries the Orca persona as the system prompt, appends plugin skills +
 *  fragments after it, and disables all disk discovery — the brain is a lean, in-process agent. */
function defaultResourceLoaderFactory(o: { cwd: string; systemPrompt: string; appendSystemPrompt?: string[] }): ResourceLoader {
  return new DefaultResourceLoader({
    cwd: o.cwd, agentDir: o.cwd, systemPrompt: o.systemPrompt, appendSystemPrompt: o.appendSystemPrompt,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
}

interface LiveBrain { session: AgentSession; sessionId: string; model: string; visionCapable: boolean; thinkingLevel?: string; policy: Policy; autoCompact: boolean; autoCompactAt: number; listeners: Set<(e: BrainEvent) => void>; turnContext: () => string; /** True while the session runs on the user's vision-fallback model (an image turn hopped onto it). */ visionFallback?: boolean }

/** Fallback auto-compact threshold (fraction of the context window) when the user set none. */
const DEFAULT_AUTO_COMPACT_AT = 0.8;

/** Translate a PI session event into the stable BrainEvent contract. Defensive: unknown event types
 *  are dropped. Streaming shapes are refined by the Task 8 smoke; the contract never changes. */

function toBrainEvent(e: AgentSessionEvent): BrainEvent | null {
  if (e.type === 'agent_end') return { type: 'idle' };
  const anyE = e as { type: string; toolName?: string; args?: unknown; result?: { details?: { diff?: unknown } }; delta?: string; assistantMessageEvent?: { type?: string; delta?: string } };
  if (anyE.type === 'message_update') {
    const delta = anyE.assistantMessageEvent?.type === 'text_delta' ? anyE.assistantMessageEvent.delta : undefined;
    return delta ? { type: 'text', delta } : null;
  }
  // Emit the tool name ONCE, when it starts — never the raw streamed output (_update noise).
  if (anyE.type === 'tool_execution_start' && typeof anyE.toolName === 'string') {
    return { type: 'tool', name: anyE.toolName, detail: toolDetail(anyE.args) };
  }
  // Edits carry a display diff in their result details — that's the one tool output worth showing.
  if (anyE.type === 'tool_execution_end') {
    const diff = anyE.result?.details?.diff;
    if (typeof diff === 'string' && diff.trim()) return { type: 'diff', diff };
    // Image tools return a markdown link to the stored file; surface it as a first-class event so
    // channel adapters can attach the real file (models often omit the link from their final text).
    const parts = (anyE.result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
    for (const part of Array.isArray(parts) ? parts : []) {
      const m = typeof part?.text === 'string' ? /\((\/api)?\/brain\/images\/([a-z0-9]+\.png)\)/.exec(part.text) : null;
      if (m) return { type: 'image', ref: `/api/brain/images/${m[2]}` };
    }
  }
  return null;
}

/** Snapshot a session's statusline numbers: context fill from PI plus per-message usage totals. */
function usageOf(session: AgentSession): BrainUsage {
  const ctx = session.getContextUsage();
  let totalTokens = 0;
  let cost = 0;
  for (const m of session.messages as { usage?: { totalTokens?: number; cost?: { total?: number } } }[]) {
    totalTokens += m.usage?.totalTokens ?? 0;
    cost += m.usage?.cost?.total ?? 0;
  }
  return { tokens: ctx?.tokens ?? null, contextWindow: ctx?.contextWindow ?? 0, percent: ctx?.percent ?? null, totalTokens, cost };
}

/** Per-user embedded brain lifecycle. Mirrors AdvisorService's shape so daemon wiring is familiar,
 *  but holds in-process PI AgentSessions (one per conversation) instead of spawning an external CLI. */
export class BrainService {
  /** Live user sessions keyed by session id; `active` points at each user's current conversation. */
  private live = new Map<string, LiveBrain>();
  private active = new Map<number, string>();
  private channels = new Map<string, LiveBrain>();
  private startedPlatforms: { name: string; disconnect?(): void; notify?(t: string, channelId?: string): Promise<void> }[] = [];
  private pluginsMemo?: PluginRegistry;
  /** Per-conversation exclusivity: PI sessions are single-conversation, so concurrent prompt()/spawn
   *  calls on one session id queue up here instead of corrupting turn state. */
  private locks = new Map<string, Promise<unknown>>();
  constructor(private d: BrainDeps) {}

  /** Whether `userId` is the instance operator. When a platform owner is configured (production), it is
   *  exactly that user; with none configured (single-user / tests) every user is treated as the owner,
   *  preserving the pre-identity behaviour where the owner's own store was always used. */
  private isOwner(userId: number | undefined): boolean {
    if (userId === undefined) return false;
    const owner = this.d.platformOwner?.();
    return owner === undefined ? true : userId === owner;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  /** The user's current conversation id: the explicit active pointer, else their most recent stored
   *  session, else the legacy default id (first-ever conversation). Channel sessions never count. */
  private activeSessionId(userId: number): string {
    const set = this.active.get(userId);
    if (set) return set;
    const recent = this.d.store.listSessions(userId).find((s) => !s.id.startsWith('brain-ch-') && !s.id.startsWith('brain-task-'));
    return recent?.id ?? `brain-${userId}`;
  }

  private activeLive(userId: number): LiveBrain | undefined {
    return this.live.get(this.activeSessionId(userId));
  }

  /** The current provider set (live-resolved when a thunk was injected). */
  private runtimeConfig(): BrainRuntimeConfig {
    const cfg = typeof this.d.config === 'function' ? this.d.config() : this.d.config;
    if (!cfg || cfg.providers.length === 0) throw new Error('no brain provider configured — add one in Settings → Brain');
    return cfg;
  }

  /** The plugin registry: a directly-injected one (tests) or the memoized result of the async loader. */
  private async resolvePlugins(): Promise<PluginRegistry | undefined> {
    if (this.d.plugins) return this.d.plugins;
    if (!this.d.loadPlugins) return undefined;
    if (!this.pluginsMemo) this.pluginsMemo = await this.d.loadPlugins();
    return this.pluginsMemo;
  }

  /** Manually compact the active conversation (the /compact command): summarize the history so the
   *  context shrinks while the session stays usable. Throws when nothing is running. */
  async compact(userId: number): Promise<BrainUsage> {
    const b = this.activeLive(userId);
    if (!b) throw new Error('brain not started');
    await b.session.compact();
    return usageOf(b.session);
  }

  /** Stop the streaming turn (the Esc key in chat clients). The agent settles into agent_end → the
   *  idle event, so subscribed clients wind down on their own. */
  async abort(userId: number): Promise<void> {
    const b = this.activeLive(userId);
    if (!b) throw new Error('brain not started');
    await b.session.abort();
  }

  /** Whether the user may run this provider+model pair. Only complete selections are judged —
   *  partial ones resolve to the server default, which stays admin-controlled by definition. */
  private selectionAllowed(userId: number, sel?: { provider?: string; model?: string }): boolean {
    if (!this.d.execAllowed || !sel?.provider || !sel.model) return true;
    return this.d.execAllowed(userId, orcaExec(sel.provider, sel.model));
  }

  /** Switch the active conversation to another configured model (the /model picker). Mirrors the
   *  channel pattern: dispose the live session and respawn on the new selection — history rehydrates
   *  from the store, so the conversation continues seamlessly. */
  async switchModel(userId: number, sel: { provider?: string; model?: string }): Promise<{ model: string }> {
    if (!this.selectionAllowed(userId, sel)) throw new Error('model not allowed for user');
    const sessionId = this.activeSessionId(userId);
    return this.serial(sessionId, async () => {
      const old = this.live.get(sessionId);
      if (old) { old.session.dispose(); this.live.delete(sessionId); }
      const userCfg = this.d.userSettings?.(userId);
      const live = await this.spawnLive({
        sessionId,
        ownerUserId: userId,
        selection: sel, // the explicit pick wins over the user's saved default
        policy: this.d.policy?.(userId) ?? { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
        autoCompact: !!userCfg?.autoCompact,
        autoCompactAt: userCfg?.autoCompactAt ? userCfg.autoCompactAt / 100 : DEFAULT_AUTO_COMPACT_AT,
      });
      this.live.set(sessionId, live);
      this.active.set(userId, sessionId);
      return { model: live.model };
    });
  }

  status(userId: number): { running: boolean; sessionId: string | null; model: string; usage: BrainUsage | null } {
    const b = this.activeLive(userId);
    return { running: !!b, sessionId: b?.sessionId ?? null, model: b?.model ?? '', usage: b ? usageOf(b.session) : null };
  }

  /** Delete one of the user's stored conversations (never a channel session, never someone else's).
   *  A live session is disposed first; deleting the active conversation just clears the pointer —
   *  the next start() falls back to the most recent remaining one. */
  deleteSession(userId: number, sessionId: string): void {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId || sessionId.startsWith('brain-ch-') || sessionId.startsWith('brain-task-')) throw new Error('unknown session');
    const live = this.live.get(sessionId);
    if (live) { live.session.dispose(); this.live.delete(sessionId); }
    if (this.active.get(userId) === sessionId) this.active.delete(userId);
    this.d.store.deleteSession(sessionId);
  }

  /** The user's conversations (channel sessions excluded), most recent first, with live/active flags. */
  listSessions(userId: number): { id: string; title: string; model: string; updated_at: string; running: boolean; active: boolean }[] {
    const activeId = this.activeSessionId(userId);
    return this.d.store.listSessions(userId)
      .filter((s) => !s.id.startsWith('brain-ch-') && !s.id.startsWith('brain-task-'))
      .map((s) => ({ id: s.id, title: s.title, model: s.model, updated_at: s.updated_at, running: this.live.has(s.id), active: s.id === activeId }));
  }

  /** Fulltext search across the user's stored conversations (channel sessions included — they carry
   *  the owner's user_id, so ownership scoping is the store's join). */
  searchMessages(userId: number, query: string): BrainSearchHit[] {
    return this.d.store.searchMessages(userId, query);
  }

  /** Everything shared by a user session and a channel session: registry + store row + rehydration +
   *  persona/plugins composition + PI session construction + persistence subscription. */
  private async spawnLive(opts: {
    sessionId: string;
    ownerUserId: number;
    selection: { provider?: string; model?: string };
    policy: Policy;
    /** Extra system-prompt chunks appended after the plugin fragments (e.g. a Discord role prompt). */
    extraAppend?: string[];
    /** Platform channel session (Discord, …): the sender is NOT an Orca user, so the owner's
     *  full-scope orca_* API tools are withheld — only Policy-guarded plugin tools load. */
    channel?: boolean;
    /** Per-role tool allowlist (tool names; '*' = everything). Undefined = no restriction. */
    toolFilter?: string[];
    /** Reasoning effort for extended-thinking models (empty/undefined = the model default). */
    thinkingLevel?: string;
    autoCompact: boolean;
    autoCompactAt: number;
  }): Promise<LiveBrain> {
    const { sessionId, ownerUserId } = opts;

    // Ensure the store row (sole source of truth) exists before rehydration.
    const cfg = this.runtimeConfig();
    const registry = buildBrainRegistry(cfg, this.d.authStorage);
    const model = resolveBrainModel(registry, cfg, opts.selection);
    if (!this.d.store.getSession(sessionId)) {
      this.d.store.createSession({ id: sessionId, userId: ownerUserId, model: model.id });
    } else {
      this.d.store.touchSession(sessionId, model.id);
    }

    const cwd = this.d.cwd ?? process.cwd();
    const sessionManager = rehydrate(this.d.store, sessionId, cwd);
    // Channel senders must never reach the owner's full-scope API token — no orca_* tools there.
    const tools = opts.channel ? [] : buildOrcaTools({ url: this.d.url, token: this.d.users.ensureAdvisorToken(ownerUserId) });

    // Enabled plugins contribute tools, skills, and system-prompt fragments. Their tools read the active
    // Policy at call time via AsyncLocalStorage (set around each prompt), no per-session construction.
    const plugins = await this.resolvePlugins();
    let pluginTools = plugins?.tools ?? [];
    if (opts.toolFilter && !opts.toolFilter.includes('*')) {
      const allow = new Set(opts.toolFilter);
      pluginTools = pluginTools.filter((t) => allow.has(t.name));
    }
    const allTools = [...tools, ...pluginTools];
    const skills = plugins?.skills ?? [];
    const skillsBlock = skills.length ? formatSkillsForPrompt(skills) : '';
    const fragments = plugins?.promptFragments ?? [];
    const append = [skillsBlock, ...fragments, ...(opts.extraAppend ?? [])].filter((s) => s.length > 0);

    // Orca identity: the editable `advisor` prompt (per-user override aware) becomes the system prompt,
    // so the brain knows it is Orca — not the underlying model's default persona.
    const u = this.d.users.get(ownerUserId);
    const userName = u?.name || u?.username || 'Filip';
    const personality = personalityText(this.d.userSettings?.(ownerUserId)?.advisorStyle ?? '');
    const agentName = this.d.agentName?.() || 'Orca';
    // Shared platform channels get their own persona: the senders are OTHER people, so the owner's
    // "personal advisor" prompt (owner-name identity, terminal/control-plane framing) would misaddress
    // everyone in the room. The channel prompt keeps the agent identity and speaks to bracketed senders.
    const persona = opts.channel
      ? this.d.prompts.render('advisor-channel', { ownerName: userName, personality, agentName }, ownerUserId)
      : this.d.prompts.render('advisor', { userName, personality, agentName }, ownerUserId);
    const resourceLoader = (this.d.resourceLoaderFactory ?? defaultResourceLoaderFactory)({ cwd, systemPrompt: persona, appendSystemPrompt: append });
    // A resource loader passed to createAgentSession is NOT auto-reloaded (only one it builds itself is),
    // so its system prompt stays empty unless we reload it here. Without this the brain falls back to
    // pi's default "coding assistant" persona and misidentifies itself.
    if (resourceLoader) await resourceLoader.reload();

    const create = this.d.createSession ?? createAgentSession;
    // Reasoning effort for extended-thinking models — PI clamps an unsupported level to the model's
    // range, so passing it for a non-thinking model is harmless. Empty → leave the model default.
    const thinkingLevel = (['minimal', 'low', 'medium', 'high', 'xhigh'] as const).find((l) => l === opts.thinkingLevel);
    const { session } = await create({
      cwd,
      sessionManager,
      modelRegistry: registry,
      model,
      resourceLoader,
      customTools: allTools,
      tools: allTools.map((t) => t.name),
      noTools: 'builtin',
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });

    const listeners = new Set<(e: BrainEvent) => void>();
    session.subscribe((e: AgentSessionEvent) => {
      projectEvent(this.d.store, sessionId, e); // persist settled turns (agent_end)
      const be = toBrainEvent(e);
      if (!be) return;
      if (be.type === 'idle') { be.usage = usageOf(session); be.model = model.id; } // statusline data rides the idle event
      for (const l of listeners) l(be);
    });

    // Ephemeral per-turn context (date/time, …) is injected into each user message — see send() — so it
    // stays fresh WITHOUT invalidating the cached system-prompt prefix.
    const providers = plugins?.turnContexts ?? [];
    const turnContext = (): string => {
      const parts = providers.map((f) => { try { return f(); } catch { return ''; } }).filter((x) => x && x.trim());
      return parts.length ? `<context>\n${parts.join('\n')}\n</context>\n\n` : '';
    };
    const visionCapable = Array.isArray((model as { input?: string[] }).input) ? ((model as { input?: string[] }).input as string[]).includes('image') : true;
    return { session, sessionId, model: model.id, visionCapable, thinkingLevel: opts.thinkingLevel, policy: opts.policy, autoCompact: opts.autoCompact, autoCompactAt: opts.autoCompactAt, listeners, turnContext };
  }

  /** Start (or resume) a conversation. `session` resumes that stored conversation (ownership checked);
   *  `fresh` opens a brand-new one. Either way it becomes the user's active conversation. Idempotent
   *  when the target is already live. */
  async start(userId: number, opts?: { provider?: string; model?: string; session?: string; fresh?: boolean }): Promise<{ sessionId: string }> {
    let sessionId: string;
    if (opts?.fresh) {
      sessionId = `brain-${userId}-${Date.now().toString(36)}`;
    } else if (opts?.session) {
      const row = this.d.store.getSession(opts.session);
      if (!row || row.user_id !== userId || opts.session.startsWith('brain-ch-') || opts.session.startsWith('brain-task-')) throw new Error('unknown session');
      sessionId = opts.session;
    } else {
      sessionId = this.activeSessionId(userId);
    }
    this.active.set(userId, sessionId);
    // Serialized per conversation: two concurrent starts would both spawn and leak one PI session.
    return this.serial(sessionId, async () => {
      if (this.live.has(sessionId)) return { sessionId }; // idempotent resume of a live conversation
      // Model selection: an explicit start option wins, else the user's saved provider+model override,
      // else the first configured provider's first model. A saved model the user is no longer
      // allowed to run falls back to the server default rather than blocking the brain.
      const userCfg = this.d.userSettings?.(userId);
      let selection: { provider?: string; model?: string } = { provider: opts?.provider ?? userCfg?.modelProvider, model: opts?.model ?? userCfg?.model };
      if (!this.selectionAllowed(userId, selection)) selection = {};
      const live = await this.spawnLive({
        sessionId,
        ownerUserId: userId,
        selection,
        policy: this.d.policy?.(userId) ?? { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
        thinkingLevel: userCfg?.thinkingLevel,
        autoCompact: !!userCfg?.autoCompact,
        autoCompactAt: userCfg?.autoCompactAt ? userCfg.autoCompactAt / 100 : DEFAULT_AUTO_COMPACT_AT,
      });
      this.live.set(sessionId, live);
      return { sessionId };
    });
  }

  subscribe(userId: number, listener: (e: BrainEvent) => void): () => void {
    const b = this.activeLive(userId);
    if (!b) throw new Error('brain not started for user');
    b.listeners.add(listener);
    return () => b.listeners.delete(listener);
  }

  async send(userId: number, text: string, images?: { data: string; mimeType: string }[]): Promise<void> {
    if (!this.activeLive(userId)) throw new Error('brain not started for user');
    // Serialized per USER for the whole turn: the vision-fallback respawn below disposes and recreates
    // the session, which MUST NOT race a concurrent send() (a double-submit would dispose a session
    // mid-prompt). This user-level lock guards the stop/start decision; the inner session lock still
    // guards the prompt itself. `start()` uses its own (session-keyed) lock, so there's no re-entrancy.
    await this.serial(`user-${userId}`, async () => {
    let b = this.activeLive(userId);
    if (!b) throw new Error('brain not started for user');
    // Vision fallback (Account → CLI): an image turn on a text-only model hops onto the user's
    // configured vision model — the session respawns there (history rehydrates from SQLite) and hops
    // back on the next text-only turn, so the fallback never silently becomes the permanent model.
    const vision = this.d.userSettings?.(userId)?.visionModel;
    if (images?.length && !b.visionCapable && vision) {
      this.stop(userId);
      await this.start(userId, { provider: this.d.userSettings?.(userId)?.visionModelProvider || undefined, model: vision });
      b = this.activeLive(userId);
      if (!b) throw new Error('brain not started for user');
      // Only mark the hop as active if it actually reached a vision-capable model — otherwise the
      // fallback model was unavailable/not allowed (start fell back to the default) and re-flagging
      // would pointlessly respawn on every following text turn.
      b.visionFallback = b.visionCapable;
    } else if (!images?.length && b.visionFallback) {
      this.stop(userId);
      await this.start(userId);
      b = this.activeLive(userId);
      if (!b) throw new Error('brain not started for user');
    }
    const live = b;
    // Serialized per conversation: concurrent prompt() calls on one PI session corrupt turn state.
    await this.serial(live.sessionId, async () => {
      // First user message names the conversation (once) so the session list reads naturally.
      const row = this.d.store.getSession(live.sessionId);
      if (row && !row.title) this.d.store.setTitle(live.sessionId, text.slice(0, 60));
      // History stores the text plus an attachment marker; the image bytes live only in the live
      // context (a rehydrated conversation keeps the marker, not the pixels).
      projectUserTurn(this.d.store, live.sessionId, images?.length ? `${text}\n[📎 ${images.length}× obrázek]` : text);
      const options = images?.length
        ? { images: images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })) }
        : undefined;
      // Establish the user's repo Policy for any plugin tool this turn invokes (read via currentPolicy()).
      // The turn-context prefix rides only in the live prompt (not stored history) → fresh + cache-safe.
      const prompted = live.turnContext() + text;
      // The turn's identity: the Orca account itself (memory and other per-user plugin state key on it).
      const identity = {
        platform: 'orca',
        userId: String(userId),
        orcaUsername: this.d.users.get(userId)?.username,
        admin: live.policy.allowedProjectIds === 'all',
        owner: this.isOwner(userId), // their own authenticated chat → operator
      };
      await runWithPolicy(live.policy, () => (options ? live.session.prompt(prompted, options) : live.session.prompt(prompted)), identity);
      // Auto-compact: once the conversation fills most of the context window, summarize it so the next
      // turn keeps room. Opt-in per user; failures are non-fatal (a full window still works, just tighter).
      if (live.autoCompact) {
        const usage = live.session.getContextUsage();
        if (usage?.tokens && usage.contextWindow > 0 && usage.tokens / usage.contextWindow >= live.autoCompactAt) {
          try { await live.session.compact(); } catch { /* best-effort; keep the session usable */ }
        }
      }
    });
    });
  }

  /** Restart a user's live session so changed settings (model override, plugins) apply immediately.
   *  No-op when not running. History survives — it rehydrates from SQLite on the fresh start. */
  async restart(userId: number): Promise<void> {
    const b = this.activeLive(userId);
    if (!b) return;
    await this.locks.get(b.sessionId); // let an in-flight turn settle before disposing the session
    this.stop(userId);
    await this.start(userId);
  }

  /** Drop the memoized plugin registry and restart every live session — called when the admin flips a
   *  plugin on/off so the change applies without a daemon restart. Channel sessions are simply dropped;
   *  the next inbound message re-opens them with the fresh registry. */
  async reloadPlugins(): Promise<void> {
    this.pluginsMemo = undefined;
    for (const userId of [...this.active.keys()]) await this.restart(userId);
    // Non-active live sessions just drop; they respawn with the new registry on next resume.
    for (const [id, b] of [...this.live]) {
      if (![...this.active.values()].includes(id)) { b.session.dispose(); this.live.delete(id); }
    }
    for (const [id, ch] of [...this.channels]) { ch.session.dispose(); this.channels.delete(id); }
    // Platform adapters were built by the old registry — disconnect them and start the fresh set.
    for (const p of this.startedPlatforms) { try { p.disconnect?.(); } catch { /* already down */ } }
    this.startedPlatforms = [];
    await this.startPlatforms();
  }

  /** Push a proactive message to every started platform that has a notification channel (Discord, …).
   *  Fail-open per adapter — a broken sink must not break the cron tick that triggered it. */
  async notify(text: string, channelId?: string): Promise<void> {
    for (const p of this.startedPlatforms) {
      const adapter = p as { notify?(t: string, channelId?: string): Promise<void> };
      if (typeof adapter.notify === 'function') {
        try { await adapter.notify(text, channelId); } catch { /* one sink down must not block the rest */ }
      }
    }
  }

  /** Start every plugin-contributed platform adapter (Discord bot, …): wire its messages into channel
   *  sessions and let it deliver the replies. Fail-open per adapter; called once at daemon startup and
   *  re-run by reloadPlugins. */
  async startPlatforms(log?: { info(m: string): void; error(m: string): void }): Promise<void> {
    const plugins = await this.resolvePlugins();
    for (const adapter of plugins?.platforms ?? []) {
      try {
        adapter.listen(async (src, text, onEvent) => {
          const owner = this.d.platformOwner?.();
          if (owner === undefined || !src.access) return undefined; // unmapped sender → stay silent
          // Owner-authored automation (cron) runs with the owner's full powers; foreign senders get
          // their role's project scope and no orca_* tools.
          const policy = src.access.admin
            ? { allowedProjectIds: 'all' as const, allowedPaths: () => [] }
            : this.d.policyForProjects?.(src.access.projectIds)
              ?? { allowedProjectIds: new Set(src.access.projectIds), allowedPaths: () => [] };
          const promptAppend = [
            ...(src.access.prompt ? [src.access.prompt] : []),
            ...(src.channelName ? [this.channelFragment(src, owner)] : []),
          ];
          // A sender who linked their platform id in Account settings gets a verified identity line —
          // the agent then KNOWS who this is (incl. recognizing the operator), not just a bracket name.
          // The display name is attacker-influenced (a user picks their own Orca name), so strip
          // brackets/newlines before splicing it into this trusted line — otherwise a name like
          // `x] SYSTEM: …` could forge instructions into the prompt.
          const linked = this.d.resolvePlatformUser?.(src.platform, src.userId);
          const safeName = linked ? linked.name.replace(/[[\]\r\n]/g, ' ').trim().slice(0, 80) : '';
          const sendText = linked
            ? `[Verified: this sender is the Orca user "${safeName}"${linked.id === owner ? ' — the operator of this instance' : ''}]\n${text}`
            : text;
          // Per-turn sender identity: a linked sender keys per-user plugin state (memory) by their Orca
          // account; an unknown sender by platform id. `owner` is stricter than `admin` — only the
          // operator (their linked account, or their own server-internal automation like cron/subagent)
          // counts, NEVER a foreign Discord member who merely holds an admin-mapped role. `admin` still
          // reflects all-access policy (project power tools); the two are deliberately separate.
          const internalAutomation = src.platform === 'cron' || src.platform === 'subagent';
          const identity = {
            platform: src.platform,
            userId: src.userId,
            orcaUsername: linked?.username || linked?.name,
            admin: src.access.admin === true || linked?.admin === true,
            owner: (linked?.id !== undefined && this.isOwner(linked.id)) || (internalAutomation && src.access.admin === true),
          };
          return this.channelSend({ channelId: `${src.platform}-${src.threadId ?? src.channelId}`, ownerUserId: owner, policy, promptAppend: promptAppend.length ? promptAppend : undefined, trusted: src.access.admin, model: src.access.model, thinkingLevel: src.access.thinkingLevel, tools: src.access.admin ? undefined : src.access.tools, images: src.images, identity, history: src.history, onEvent }, sendText);
        });
        await adapter.connect();
        this.startedPlatforms.push(adapter);
        log?.info(`platform connected: ${adapter.name}`);
      } catch (e) {
        log?.error(`platform failed: ${adapter.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Shared-channel system-prompt fragment: names the room (and its topic) and pins the multi-user
   *  etiquette — senders arrive `[name]`-prefixed and are usually NOT the instance owner, so the brain
   *  must never address a stranger as the owner. Applied only when the channel session spawns via
   *  `promptAppend` → `extraAppend`; a later channel-name/topic change takes effect once the session
   *  respawns (LRU eviction or a /new reset). */
  private channelFragment(src: { platform: string; channelName?: string; channelTopic?: string }, ownerUserId: number): string {
    const u = this.d.users.get(ownerUserId);
    const ownerName = u?.name || u?.username || 'the owner';
    const platform = src.platform.charAt(0).toUpperCase() + src.platform.slice(1);
    const topic = src.channelTopic?.trim() ? ` The channel topic is: "${src.channelTopic.trim()}".` : '';
    return `You are talking on ${platform} in #${src.channelName}.${topic}\n`
      + `This is a shared channel: each user message is prefixed with the sender's name in [brackets]. `
      + `Address each sender by their bracketed name — the person talking to you is usually NOT ${ownerName}, `
      + `whose Orca instance you run on. Never assume the sender is ${ownerName} unless the prefix says so.`;
  }

  /** Send one channel message (e.g. a Discord mention) into that channel's own conversation and return
   *  the final assistant text. The session is keyed by the channel — NOT the Orca user — and runs with
   *  the caller-resolved Policy (role → projects) plus optional role prompt fragments. Persisted like
   *  any brain conversation (`brain-ch-<id>`), owned by `ownerUserId` (whose token drives the tools). */
  /** Live channel sessions are capped: past this the least-recently-used one is disposed (its history
   *  stays in SQLite and rehydrates on the next message), so a busy server can't leak sessions. */
  private static readonly MAX_CHANNELS = 32;

  async channelSend(opts: { channelId: string; ownerUserId: number; policy: Policy; promptAppend?: string[]; trusted?: boolean; model?: { provider?: string; model?: string }; thinkingLevel?: string; tools?: string[]; images?: { data: string; mimeType: string }[]; identity?: TurnIdentity; history?: () => Promise<string>; onEvent?: (e: BrainEvent) => void }, text: string): Promise<string> {
    const sessionId = `brain-ch-${opts.channelId}`;
    // Serialized per channel: two rapid Discord messages must not prompt() one PI session concurrently
    // (and must not both spawn it).
    return this.serial(sessionId, async () => {
      // A BRAND-NEW conversation (no stored turns) may backfill what the platform channel said before
      // the brain joined — fetched lazily so an ongoing conversation never pays for it. Prepended to
      // the first user message (not the system prompt) so it persists as normal history.
      if (opts.history && this.d.store.getMessages(sessionId).length === 0) {
        const past = await opts.history().catch(() => '');
        if (past.trim()) text = `${past.trim()}\n\n${text}`;
      }
      let ch = this.channels.get(opts.channelId);
      // A model or reasoning-effort switch mid-conversation rebuilds the session (history rehydrates).
      const modelChanged = !!opts.model?.model && ch?.model !== opts.model.model;
      const thinkingChanged = !!ch && (ch.thinkingLevel ?? '') !== (opts.thinkingLevel ?? '');
      if (ch && (modelChanged || thinkingChanged)) { ch.session.dispose(); this.channels.delete(opts.channelId); ch = undefined; }
      if (!ch) {
        if (this.channels.size >= BrainService.MAX_CHANNELS) {
          const oldest = this.channels.entries().next().value;
          if (oldest) { oldest[1].session.dispose(); this.channels.delete(oldest[0]); }
        }
        ch = await this.spawnLive({
          sessionId,
          ownerUserId: opts.ownerUserId,
          selection: opts.model ?? {},
          policy: opts.policy,
          extraAppend: opts.promptAppend,
          channel: !opts.trusted, // foreign platform senders never get the orca_* control-plane tools
          toolFilter: opts.tools,
          thinkingLevel: opts.thinkingLevel,
          autoCompact: true, // channels are long-lived and unattended — keep their context bounded
          autoCompactAt: DEFAULT_AUTO_COMPACT_AT,
        });
      } else {
        this.channels.delete(opts.channelId); // re-insert below → Map order doubles as LRU order
      }
      this.channels.set(opts.channelId, ch);
      // Same image handling as send(): history keeps a marker, the pixels ride only the live prompt.
      projectUserTurn(this.d.store, sessionId, opts.images?.length ? `${text}\n[📎 ${opts.images.length}× obrázek]` : text);
      const prompted = ch.turnContext() + text;
      const options = opts.images?.length
        ? { images: opts.images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })) }
        : undefined;
      // Optional live streaming (Discord edit-in-place): forward this turn's events to the caller.
      const onEvent = opts.onEvent;
      const detach = onEvent ? (ch.listeners.add(onEvent), () => ch.listeners.delete(onEvent)) : undefined;
      try {
        await runWithPolicy(opts.policy, () => (options ? ch.session.prompt(prompted, options) : ch.session.prompt(prompted)), opts.identity);
      } finally { detach?.(); }
      const usage = ch.session.getContextUsage();
      if (usage?.tokens && usage.contextWindow > 0 && usage.tokens / usage.contextWindow >= ch.autoCompactAt) {
        try { await ch.session.compact(); } catch { /* best-effort */ }
      }
      // The reply = the last assistant message of the settled turn.
      const msgs = ch.session.messages as { role?: string }[];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      return last ? extractText(last) : '';
    });
  }

  stop(userId: number): void {
    const b = this.activeLive(userId);
    if (!b) return;
    b.session.dispose();
    this.live.delete(b.sessionId);
  }

  /** The user's stored conversation, shaped for display (channels render this on connect). Reads the
   *  sole store; no live session required, so it works before/independently of `start`. */
  history(userId: number): BrainMessageView[] {
    return shapeBrainMessages(this.d.store.getMessages(this.activeSessionId(userId)));
  }
}

