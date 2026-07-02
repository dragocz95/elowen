import { createAgentSession, DefaultResourceLoader, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { PluginRegistry } from '../plugins/registry.js';
import type { Policy } from '../plugins/policy.js';
import { runWithPolicy } from '../plugins/policyContext.js';
import type { AuthStorage } from '@earendil-works/pi-coding-agent';
import type { BrainStore } from '../store/brainStore.js';
import type { BrainRuntimeConfig } from './providers.js';
import { buildBrainRegistry, resolveBrainModel } from './providers.js';
import { buildOrcaTools } from './tools/index.js';
import { projectEvent, projectUserTurn, rehydrate } from './persistence.js';

/** What a channel (web/terminal, later Discord) receives from the brain. Stable regardless of the
 *  underlying PI event shape — the mapping lives in one place (`toBrainEvent`). */
export type BrainEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'idle' }
  | { type: 'error'; message: string };

/** A stored turn shaped for display (the `GET /brain/messages` payload consumed by channels). */
export interface BrainMessageView { role: string; text: string }

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
  userSettings?: (userId: number) => { model?: string; modelProvider?: string; autoCompact?: boolean; autoCompactAt?: number };
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

interface LiveBrain { session: AgentSession; sessionId: string; model: string; policy: Policy; autoCompact: boolean; autoCompactAt: number; listeners: Set<(e: BrainEvent) => void> }

/** Fallback auto-compact threshold (fraction of the context window) when the user set none. */
const DEFAULT_AUTO_COMPACT_AT = 0.8;

/** Translate a PI session event into the stable BrainEvent contract. Defensive: unknown event types
 *  are dropped. Streaming shapes are refined by the Task 8 smoke; the contract never changes. */
function toBrainEvent(e: AgentSessionEvent): BrainEvent | null {
  if (e.type === 'agent_end') return { type: 'idle' };
  const anyE = e as { type: string; toolName?: string; delta?: string; assistantMessageEvent?: { type?: string; delta?: string } };
  if (anyE.type === 'message_update') {
    const delta = anyE.assistantMessageEvent?.type === 'text_delta' ? anyE.assistantMessageEvent.delta : undefined;
    return delta ? { type: 'text', delta } : null;
  }
  if (typeof anyE.toolName === 'string') return { type: 'tool', name: anyE.toolName };
  return null;
}

/** Per-user embedded brain lifecycle. Mirrors AdvisorService's shape so daemon wiring is familiar,
 *  but holds an in-process PI AgentSession instead of spawning an external CLI. One conversation per
 *  user for step #1 (session id `brain-<userId>`); multi-conversation is a later sub-project. */
export class BrainService {
  private live = new Map<number, LiveBrain>();
  private channels = new Map<string, LiveBrain>();
  private startedPlatforms: { name: string; disconnect?(): void }[] = [];
  private pluginsMemo?: PluginRegistry;
  constructor(private d: BrainDeps) {}

  private sessionIdFor(userId: number): string { return `brain-${userId}`; }

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

  status(userId: number): { running: boolean; sessionId: string | null; model: string } {
    const b = this.live.get(userId);
    return { running: !!b, sessionId: b?.sessionId ?? null, model: b?.model ?? '' };
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
    const token = this.d.users.ensureAdvisorToken(ownerUserId);
    const tools = buildOrcaTools({ url: this.d.url, token });

    // Enabled plugins contribute tools, skills, and system-prompt fragments. Their tools read the active
    // Policy at call time via AsyncLocalStorage (set around each prompt), no per-session construction.
    const plugins = await this.resolvePlugins();
    const pluginTools = plugins?.tools ?? [];
    const allTools = [...tools, ...pluginTools];
    const skills = plugins?.skills ?? [];
    const skillsBlock = skills.length ? formatSkillsForPrompt(skills) : '';
    const fragments = plugins?.promptFragments ?? [];
    const append = [skillsBlock, ...fragments, ...(opts.extraAppend ?? [])].filter((s) => s.length > 0);

    // Orca identity: the editable `advisor` prompt (per-user override aware) becomes the system prompt,
    // so the brain knows it is Orca — not the underlying model's default persona.
    const u = this.d.users.get(ownerUserId);
    const userName = u?.name || u?.username || 'Filip';
    const persona = this.d.prompts.render('advisor', { userName }, ownerUserId);
    const resourceLoader = (this.d.resourceLoaderFactory ?? defaultResourceLoaderFactory)({ cwd, systemPrompt: persona, appendSystemPrompt: append });
    // A resource loader passed to createAgentSession is NOT auto-reloaded (only one it builds itself is),
    // so its system prompt stays empty unless we reload it here. Without this the brain falls back to
    // pi's default "coding assistant" persona and misidentifies itself.
    if (resourceLoader) await resourceLoader.reload();

    const create = this.d.createSession ?? createAgentSession;
    const { session } = await create({
      cwd,
      sessionManager,
      modelRegistry: registry,
      model,
      resourceLoader,
      customTools: allTools,
      tools: allTools.map((t) => t.name),
      noTools: 'builtin',
    });

    const listeners = new Set<(e: BrainEvent) => void>();
    session.subscribe((e: AgentSessionEvent) => {
      projectEvent(this.d.store, sessionId, e); // persist settled turns (agent_end)
      const be = toBrainEvent(e);
      if (be) for (const l of listeners) l(be);
    });

    return { session, sessionId, model: model.id, policy: opts.policy, autoCompact: opts.autoCompact, autoCompactAt: opts.autoCompactAt, listeners };
  }

  async start(userId: number, opts?: { provider?: string }): Promise<{ sessionId: string }> {
    const existing = this.live.get(userId);
    if (existing) return { sessionId: existing.sessionId }; // idempotent

    // Model selection: an explicit start option wins, else the user's saved provider+model override,
    // else the first configured provider's first model.
    const userCfg = this.d.userSettings?.(userId);
    const live = await this.spawnLive({
      sessionId: this.sessionIdFor(userId),
      ownerUserId: userId,
      selection: { provider: opts?.provider ?? userCfg?.modelProvider, model: userCfg?.model },
      policy: this.d.policy?.(userId) ?? { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
      autoCompact: !!userCfg?.autoCompact,
      autoCompactAt: userCfg?.autoCompactAt ? userCfg.autoCompactAt / 100 : DEFAULT_AUTO_COMPACT_AT,
    });
    this.live.set(userId, live);
    return { sessionId: live.sessionId };
  }

  subscribe(userId: number, listener: (e: BrainEvent) => void): () => void {
    const b = this.live.get(userId);
    if (!b) throw new Error('brain not started for user');
    b.listeners.add(listener);
    return () => b.listeners.delete(listener);
  }

  async send(userId: number, text: string): Promise<void> {
    const b = this.live.get(userId);
    if (!b) throw new Error('brain not started for user');
    projectUserTurn(this.d.store, b.sessionId, text);
    // Establish the user's repo Policy for any plugin tool this turn invokes (read via currentPolicy()).
    await runWithPolicy(b.policy, () => b.session.prompt(text));
    // Auto-compact: once the conversation fills most of the context window, summarize it so the next
    // turn keeps room. Opt-in per user; failures are non-fatal (a full window still works, just tighter).
    if (b.autoCompact) {
      const usage = b.session.getContextUsage();
      if (usage?.tokens && usage.contextWindow > 0 && usage.tokens / usage.contextWindow >= b.autoCompactAt) {
        try { await b.session.compact(); } catch { /* best-effort; keep the session usable */ }
      }
    }
  }

  /** Restart a user's live session so changed settings (model override, plugins) apply immediately.
   *  No-op when not running. History survives — it rehydrates from SQLite on the fresh start. */
  async restart(userId: number): Promise<void> {
    if (!this.live.has(userId)) return;
    this.stop(userId);
    await this.start(userId);
  }

  /** Drop the memoized plugin registry and restart every live session — called when the admin flips a
   *  plugin on/off so the change applies without a daemon restart. Channel sessions are simply dropped;
   *  the next inbound message re-opens them with the fresh registry. */
  async reloadPlugins(): Promise<void> {
    this.pluginsMemo = undefined;
    for (const userId of [...this.live.keys()]) await this.restart(userId);
    for (const [id, ch] of [...this.channels]) { ch.session.dispose(); this.channels.delete(id); }
    // Platform adapters were built by the old registry — disconnect them and start the fresh set.
    for (const p of this.startedPlatforms) { try { p.disconnect?.(); } catch { /* already down */ } }
    this.startedPlatforms = [];
    await this.startPlatforms();
  }

  /** Start every plugin-contributed platform adapter (Discord bot, …): wire its messages into channel
   *  sessions and let it deliver the replies. Fail-open per adapter; called once at daemon startup and
   *  re-run by reloadPlugins. */
  async startPlatforms(log?: { info(m: string): void; error(m: string): void }): Promise<void> {
    const plugins = await this.resolvePlugins();
    for (const adapter of plugins?.platforms ?? []) {
      try {
        adapter.listen(async (src, text) => {
          const owner = this.d.platformOwner?.();
          if (owner === undefined || !src.access) return undefined; // unmapped sender → stay silent
          const policy = this.d.policyForProjects?.(src.access.projectIds)
            ?? { allowedProjectIds: new Set(src.access.projectIds), allowedPaths: () => [] };
          const promptAppend = src.access.prompt ? [src.access.prompt] : undefined;
          return this.channelSend({ channelId: `${src.platform}-${src.threadId ?? src.channelId}`, ownerUserId: owner, policy, promptAppend }, text);
        });
        await adapter.connect();
        this.startedPlatforms.push(adapter);
        log?.info(`platform connected: ${adapter.name}`);
      } catch (e) {
        log?.error(`platform failed: ${adapter.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Send one channel message (e.g. a Discord mention) into that channel's own conversation and return
   *  the final assistant text. The session is keyed by the channel — NOT the Orca user — and runs with
   *  the caller-resolved Policy (role → projects) plus optional role prompt fragments. Persisted like
   *  any brain conversation (`brain-ch-<id>`), owned by `ownerUserId` (whose token drives the tools). */
  async channelSend(opts: { channelId: string; ownerUserId: number; policy: Policy; promptAppend?: string[] }, text: string): Promise<string> {
    const sessionId = `brain-ch-${opts.channelId}`;
    let ch = this.channels.get(opts.channelId);
    if (!ch) {
      ch = await this.spawnLive({
        sessionId,
        ownerUserId: opts.ownerUserId,
        selection: {},
        policy: opts.policy,
        extraAppend: opts.promptAppend,
        autoCompact: true, // channels are long-lived and unattended — keep their context bounded
        autoCompactAt: DEFAULT_AUTO_COMPACT_AT,
      });
      this.channels.set(opts.channelId, ch);
    }
    projectUserTurn(this.d.store, sessionId, text);
    await runWithPolicy(opts.policy, () => ch.session.prompt(text));
    const usage = ch.session.getContextUsage();
    if (usage?.tokens && usage.contextWindow > 0 && usage.tokens / usage.contextWindow >= ch.autoCompactAt) {
      try { await ch.session.compact(); } catch { /* best-effort */ }
    }
    // The reply = the last assistant message of the settled turn.
    const msgs = ch.session.messages as { role?: string }[];
    const last = [...msgs].reverse().find((m) => m.role === 'assistant');
    return last ? extractText(last) : '';
  }

  stop(userId: number): void {
    const b = this.live.get(userId);
    if (!b) return;
    b.session.dispose();
    this.live.delete(userId);
  }

  /** The user's stored conversation, shaped for display (channels render this on connect). Reads the
   *  sole store; no live session required, so it works before/independently of `start`. */
  history(userId: number): BrainMessageView[] {
    return this.d.store.getMessages(this.sessionIdFor(userId)).map((row) => {
      let text = '';
      try { text = extractText(JSON.parse(row.content)); } catch { /* malformed row → empty text */ }
      return { role: row.role, text };
    });
  }
}

/** Pull display text out of a stored message's content JSON. Content is either a plain string or an
 *  array of parts ({type:'text', text}); anything else yields an empty string. */
function extractText(msg: unknown): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('');
  }
  return '';
}
