import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import type { AgentSessionEvent, ResourceLoader, createAgentSession } from '@earendil-works/pi-coding-agent';
import type { PluginRegistry } from '../plugins/registry.js';
import type { PluginRegistryProvider } from '../plugins/pluginsProvider.js';
import { PluginHookBus } from '../plugins/hookBus.js';
import type { Policy } from '../plugins/policy.js';
import { runWithPolicy } from '../plugins/policyContext.js';
import type { AuthStorage } from '@earendil-works/pi-coding-agent';
import type { BrainStore, BrainSearchHit } from '../store/brainStore.js';
import type { BrainRuntimeConfig } from './providers.js';
import { buildBrainRegistry, resolveBrainModel } from './providers.js';
import { orcaExec } from '../shared/execs.js';
import { buildOrcaTools } from './tools/index.js';
import { personalityText } from './personality.js';
import { projectUserTurn } from './persistence.js';
import { BrainSessionFactory } from './session/factory.js';
import { composeSessionTools } from './session/capabilities.js';
import { IdentityResolver } from './identity.js';
import { decideVisionHop } from './visionFallback.js';
import { LiveSessionRegistry } from './session/liveRegistry.js';
import { DEFAULT_AUTO_COMPACT_AT } from './session/liveBrain.js';
import type { LiveBrain, SpawnOpts } from './session/liveBrain.js';
import { ChannelSessionService } from './channels.js';
import type { ChannelSendOpts } from './channels.js';
import { PlatformOrchestrator } from './platforms.js';
import { shapeBrainMessages } from './messageView.js';
import type { BrainMessageView } from './messageView.js';
import { toBrainEvent, usageOf } from './events.js';
import type { BrainEvent, BrainUsage } from './events.js';
import { defaultUserSessionId, freshUserSessionId, isNonUserSession } from './sessionId.js';

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
  /** The daemon-wide shared plugin registry (lazy-loaded, memoized, invalidated on plugin toggles).
   *  Shared with the brain workers and platform adapters so ALL consumers reload together. Absent →
   *  brain runs exactly as before plugins existed. */
  plugins?: PluginRegistryProvider;
  /** Resolves the repo-access Policy for a user; carried into plugin tool execution via AsyncLocalStorage. */
  policy?: (userId: number) => Policy;
  /** Per-user CLI/brain settings: an optional model override (empty → configured default) + auto-compact
   *  toggle and its user-tunable threshold percentage. */
  userSettings?: (userId: number) => { model?: string; modelProvider?: string; visionModel?: string; visionModelProvider?: string; thinkingLevel?: string; autoCompact?: boolean; autoCompactAt?: number; advisorStyle?: string };
  /** The user's active personality profile as a ready-to-append system-prompt chunk, or undefined when
   *  none is pinned (delegates to PersonalityService.activeAppend). Appended AFTER the persona in
   *  appendSystemPrompt — the cache-safe seam. For Discord `userId` is the channel owner and `platform`
   *  is 'discord', so it resolves the owner's one Discord persona (the locked shared-channel decision). */
  activePersonality?: (userId: number, platform: string) => string | undefined;
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

/** Per-user embedded brain lifecycle. Mirrors AdvisorService's shape so daemon wiring is familiar,
 *  but holds in-process PI AgentSessions (one per conversation) instead of spawning an external CLI.
 *  A thin facade over the focused units: session state (LiveSessionRegistry), assembly
 *  (BrainSessionFactory), identities (IdentityResolver), channel turns (ChannelSessionService) and
 *  platform adapters (PlatformOrchestrator). */
export class BrainService {
  /** All mutable live-session state: user sessions, active pointers, channel LRU and the per-key
   *  locks (PI sessions are single-conversation — concurrent prompt()/spawn calls on one session id
   *  queue up instead of corrupting turn state). */
  private sessions = new LiveSessionRegistry<LiveBrain>();
  /** Shared session assembly (store row + rehydrate + resource loader + PI session) — the same
   *  factory the orca-exec brain workers use. */
  private factory: BrainSessionFactory;
  /** The ONE place turn identities (and the owner check) are minted. */
  private identity: IdentityResolver;
  private channelService: ChannelSessionService;
  private platforms: PlatformOrchestrator;
  constructor(private d: BrainDeps) {
    this.factory = new BrainSessionFactory({ store: d.store, createSession: d.createSession, resourceLoaderFactory: d.resourceLoaderFactory });
    this.identity = new IdentityResolver({ platformOwner: d.platformOwner, resolvePlatformUser: d.resolvePlatformUser, users: d.users });
    this.channelService = new ChannelSessionService({
      registry: this.sessions, store: d.store, users: d.users,
      spawn: (o) => this.spawnLive(o), // composition stays here — single source
    });
    this.platforms = new PlatformOrchestrator({
      plugins: () => this.resolvePlugins(),
      platformOwner: d.platformOwner,
      policyForProjects: d.policyForProjects,
      identity: this.identity,
      channels: this.channelService,
    });
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.sessions.withLock(key, fn);
  }

  /** The user's current conversation id: the explicit active pointer, else their most recent stored
   *  session, else the legacy default id (first-ever conversation). Channel sessions never count. */
  private activeSessionId(userId: number): string {
    const set = this.sessions.activeIdFor(userId);
    if (set) return set;
    const recent = this.d.store.listSessions(userId).find((s) => !isNonUserSession(s.id));
    return recent?.id ?? defaultUserSessionId(userId);
  }

  private activeLive(userId: number): LiveBrain | undefined {
    return this.sessions.get(this.activeSessionId(userId));
  }

  /** The current provider set (live-resolved when a thunk was injected). */
  private runtimeConfig(): BrainRuntimeConfig {
    const cfg = typeof this.d.config === 'function' ? this.d.config() : this.d.config;
    if (!cfg || cfg.providers.length === 0) throw new Error('no brain provider configured — add one in Settings → Brain');
    return cfg;
  }

  /** The daemon-wide plugin registry (undefined when plugins aren't wired at all). */
  private async resolvePlugins(): Promise<PluginRegistry | undefined> {
    return this.d.plugins?.get();
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
      this.sessions.dispose(sessionId);
      const userCfg = this.d.userSettings?.(userId);
      const live = await this.spawnLive({
        sessionId,
        ownerUserId: userId,
        selection: sel, // the explicit pick wins over the user's saved default
        policy: this.d.policy?.(userId) ?? { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
        autoCompact: !!userCfg?.autoCompact,
        autoCompactAt: userCfg?.autoCompactAt ? userCfg.autoCompactAt / 100 : DEFAULT_AUTO_COMPACT_AT,
      });
      this.sessions.set(sessionId, live);
      this.sessions.setActive(userId, sessionId);
      return { model: live.model };
    });
  }

  /** Set the reasoning effort of the ACTIVE conversation live (the /think command) — PI applies it to
   *  the running session without a respawn, unlike a model switch. A level the current model doesn't
   *  support is clamped by PI. Returns the effective level. Session-scoped (like /model): the saved
   *  per-user default in Account → CLI is unchanged. */
  async setThinkingLevel(userId: number, level: string): Promise<{ thinkingLevel: string }> {
    const b = this.activeLive(userId);
    if (!b) throw new Error('brain not started');
    const sess = b.session as { setThinkingLevel?: (l: string) => void; thinkingLevel?: string; getAvailableThinkingLevels?: () => string[] };
    const available = new Set(sess.getAvailableThinkingLevels?.() ?? ['minimal', 'low', 'medium', 'high', 'xhigh']);
    if (!available.has(level)) throw new Error(`model does not support reasoning effort "${level}"`);
    sess.setThinkingLevel?.(level);
    b.thinkingLevel = level;
    return { thinkingLevel: (sess.thinkingLevel as string) ?? level };
  }

  status(userId: number): { running: boolean; sessionId: string | null; model: string; usage: BrainUsage | null; thinkingLevel: string; thinkingLevels: string[] } {
    const b = this.activeLive(userId);
    const sess = b?.session as { thinkingLevel?: string; supportsThinking?: () => boolean; getAvailableThinkingLevels?: () => string[] } | undefined;
    const supports = sess?.supportsThinking?.() ?? false;
    return {
      running: !!b, sessionId: b?.sessionId ?? null, model: b?.model ?? '', usage: b ? usageOf(b.session) : null,
      thinkingLevel: (sess?.thinkingLevel as string) ?? b?.thinkingLevel ?? '',
      thinkingLevels: supports ? (sess?.getAvailableThinkingLevels?.() ?? []) : [],
    };
  }

  /** Delete one of the user's stored conversations (never a channel session, never someone else's).
   *  A live session is disposed first; deleting the active conversation just clears the pointer —
   *  the next start() falls back to the most recent remaining one. */
  deleteSession(userId: number, sessionId: string): void {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId || isNonUserSession(sessionId)) throw new Error('unknown session');
    this.sessions.dispose(sessionId);
    if (this.sessions.activeIdFor(userId) === sessionId) this.sessions.clearActive(userId);
    this.d.store.deleteSession(sessionId);
  }

  /** The user's conversations (channel sessions excluded), most recent first, with live/active flags. */
  listSessions(userId: number): { id: string; title: string; model: string; updated_at: string; running: boolean; active: boolean }[] {
    const activeId = this.activeSessionId(userId);
    return this.d.store.listSessions(userId)
      .filter((s) => !isNonUserSession(s.id))
      .map((s) => ({ id: s.id, title: s.title, model: s.model, updated_at: s.updated_at, running: this.sessions.has(s.id), active: s.id === activeId }));
  }

  /** Fulltext search across the user's stored conversations (channel sessions included — they carry
   *  the owner's user_id, so ownership scoping is the store's join). */
  searchMessages(userId: number, query: string): BrainSearchHit[] {
    return this.d.store.searchMessages(userId, query);
  }

  /** Everything shared by a user session and a channel session: registry + store row + rehydration +
   *  persona/plugins composition + PI session construction + persistence subscription. */
  private async spawnLive(opts: SpawnOpts): Promise<LiveBrain> {
    const { sessionId, ownerUserId } = opts;

    const cfg = this.runtimeConfig();
    const registry = buildBrainRegistry(cfg, this.d.authStorage);
    const model = resolveBrainModel(registry, cfg, opts.selection);
    const cwd = this.d.cwd ?? process.cwd();
    // Enabled plugins contribute tools, skills, and system-prompt fragments. Their tools read the active
    // Policy at call time via AsyncLocalStorage (set around each prompt), no per-session construction.
    const plugins = await this.resolvePlugins();
    // The security invariant (foreign channels never get the owner's orca_* control-plane tools)
    // lives in composeSessionTools; the orca token is minted lazily so it never exists for them.
    const allTools = composeSessionTools({
      kind: opts.channel ? 'foreign-channel' : 'owner-chat',
      orcaTools: () => buildOrcaTools({ url: this.d.url, token: this.d.users.ensureAdvisorToken(ownerUserId) }),
      pluginTools: plugins?.tools ?? [],
      toolFilter: opts.toolFilter,
    });
    const skills = plugins?.skills ?? [];
    const skillsBlock = skills.length ? formatSkillsForPrompt(skills) : '';
    const fragments = plugins?.promptFragments ?? [];
    // The user's active personality profile (owner's per-platform pin) layers AFTER the persona as a
    // separate appended chunk — never the per-turn context (personality is stable system-prompt material,
    // so putting it per-turn would waste the prompt cache). Undefined when no enabled profile is pinned →
    // NOTHING appended, so the systemPrompt prefix stays byte-identical for users without one.
    const persoAppend = this.d.activePersonality?.(ownerUserId, opts.platform ?? 'web');
    const append = [skillsBlock, ...fragments, ...(opts.extraAppend ?? []), persoAppend ?? ''].filter((s) => s.length > 0);

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

    const { session } = await this.factory.create({
      sessionId, ownerUserId, registry, model, cwd,
      systemPrompt: persona, appendSystemPrompt: append,
      tools: allTools, thinkingLevel: opts.thinkingLevel,
    });

    const listeners = new Set<(e: BrainEvent) => void>();
    session.subscribe((e: AgentSessionEvent) => {
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
      sessionId = freshUserSessionId(userId);
    } else if (opts?.session) {
      const row = this.d.store.getSession(opts.session);
      if (!row || row.user_id !== userId || isNonUserSession(opts.session)) throw new Error('unknown session');
      sessionId = opts.session;
    } else {
      sessionId = this.activeSessionId(userId);
    }
    this.sessions.setActive(userId, sessionId);
    // Serialized per conversation: two concurrent starts would both spawn and leak one PI session.
    return this.serial(sessionId, async () => {
      if (this.sessions.has(sessionId)) return { sessionId }; // idempotent resume of a live conversation
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
      this.sessions.set(sessionId, live);
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
    const settings = this.d.userSettings?.(userId);
    const hop = decideVisionHop({
      hasImages: !!images?.length, visionCapable: b.visionCapable, onFallback: !!b.visionFallback,
      visionModel: settings?.visionModel, visionModelProvider: settings?.visionModelProvider,
    });
    if (hop.action !== 'none') {
      this.stop(userId);
      await this.start(userId, hop.action === 'hop' ? { provider: hop.provider, model: hop.model } : undefined);
      b = this.activeLive(userId);
      if (!b) throw new Error('brain not started for user');
      // Only mark the hop as active if it actually reached a vision-capable model — otherwise the
      // fallback model was unavailable/not allowed (start fell back to the default) and re-flagging
      // would pointlessly respawn on every following text turn.
      if (hop.action === 'hop') b.visionFallback = b.visionCapable;
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
      const identity = this.identity.forOwnerChat(userId, live.policy);
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
    await this.sessions.settled(b.sessionId); // let an in-flight turn settle before disposing the session
    this.stop(userId);
    await this.start(userId);
  }

  /** A user changed their active personality profile: respawn so the new persona chunk lands in the
   *  system prompt. The user's own owner-chat session restarts (per-user, safe), AND every channel
   *  session is dropped so a Discord room respawns on the owner's fresh 'discord' persona — the channel
   *  session is owner-anchored and shared, so it must not keep the stale persona. History rehydrates from
   *  SQLite on respawn. Rare operation; serialized on its own key so it never interleaves a reload. */
  async applyPersonalityChange(userId: number): Promise<void> {
    await this.serial(`personality-${userId}`, async () => {
      await this.restart(userId);
      this.sessions.channelDisposeAll();
    });
  }

  /** Invalidate the shared plugin registry and restart every live session — called when the admin flips
   *  a plugin on/off so the change applies without a daemon restart. Channel sessions are simply dropped;
   *  the next inbound message re-opens them with the fresh registry. The shared invalidation also covers
   *  the orca-exec brain workers — their next launch composes from the fresh registry. */
  async reloadPlugins(): Promise<void> {
    // Serialized: two rapid plugin toggles must not interleave stopAll()/startAll() and leave
    // duplicate connected adapters (a distinct lock key from any session, so it never blocks a turn).
    await this.serial('plugins-reload', async () => {
      // Let plugins observe the reload boundary. Observational only (fail-open, no mutation) — fires on
      // the CURRENT registry's hooks before we swap it out.
      const before = await this.d.plugins?.get();
      if (before) await new PluginHookBus({ hooks: before.hooks }).emit('plugin.reload.before', {});
      this.d.plugins?.invalidate();
      for (const userId of this.sessions.activeUserIds()) await this.restart(userId);
      // Non-active live sessions just drop; they respawn with the new registry on next resume.
      const activeIds = this.sessions.activeIds();
      for (const [id] of this.sessions.liveEntries()) {
        if (!activeIds.includes(id)) this.sessions.dispose(id);
      }
      this.sessions.channelDisposeAll();
      // Platform adapters were built by the old registry — disconnect them and start the fresh set.
      this.platforms.stopAll();
      await this.platforms.startAll();
      // reload.after fires against the freshly rebuilt registry so plugins can re-prime state.
      const after = await this.d.plugins?.get();
      if (after) await new PluginHookBus({ hooks: after.hooks }).emit('plugin.reload.after', {});
    });
  }

  /** Push a proactive message out through the platform adapters (cron/tick echoes). */
  async notify(text: string, channelId?: string): Promise<void> {
    await this.platforms.notify(text, channelId);
  }

  /** Start every plugin-contributed platform adapter — see PlatformOrchestrator. */
  async startPlatforms(log?: { info(m: string): void; error(m: string): void }): Promise<void> {
    await this.platforms.startAll(log);
  }

  /** Send one channel message (e.g. a Discord mention) — see ChannelSessionService. */
  async channelSend(opts: ChannelSendOpts, text: string): Promise<string> {
    return this.channelService.send(opts, text);
  }

  stop(userId: number): void {
    const b = this.activeLive(userId);
    if (b) this.sessions.dispose(b.sessionId);
  }

  /** The user's stored conversation, shaped for display (channels render this on connect). Reads the
   *  sole store; no live session required, so it works before/independently of `start`. */
  history(userId: number): BrainMessageView[] {
    return shapeBrainMessages(this.d.store.getMessages(this.activeSessionId(userId)));
  }
}

