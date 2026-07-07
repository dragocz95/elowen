import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { PluginRegistry } from '../../plugins/registry.js';
import { PluginHookBus } from '../../plugins/hookBus.js';
import { logger } from '../../shared/logger.js';
import type { BrainRuntimeConfig } from '../providers.js';
import { buildBrainRegistry, resolveBrainModel } from '../providers.js';
import { buildOrcaTools, buildMemoryTools, BUILTIN_TOOL_ICONS } from '../tools/index.js';
import { makeToolIconResolver } from '../toolIcons.js';
import { composeSessionTools } from '../session/capabilities.js';
import { personalityText } from '../personality.js';
import type { BrainSessionFactory } from '../session/factory.js';
import type { LiveBrain, SpawnOpts } from '../session/liveBrain.js';
import { toBrainEvent, usageOf } from '../events.js';
import type { BrainEvent } from '../events.js';
import type { BrainDeps } from '../brainDeps.js';
import { turnWorkDir } from './workDir.js';

interface SpawnerDeps {
  /** See the BrainDeps fields of the same names — the spawner receives the subset it composes from. */
  config: BrainDeps['config'];
  authStorage?: BrainDeps['authStorage'];
  users: BrainDeps['users'];
  prompts: BrainDeps['prompts'];
  url: string;
  cwd?: string;
  projectPath?: () => string | undefined;
  userSettings?: BrainDeps['userSettings'];
  activePersonality?: BrainDeps['activePersonality'];
  agentName?: () => string;
  maxSteps?: () => number;
  memoryStore?: BrainDeps['memoryStore'];
  memoryService?: BrainDeps['memoryService'];
  memoryCategoryStore?: BrainDeps['memoryCategoryStore'];
  memoryCategorizer?: BrainDeps['memoryCategorizer'];
  /** The daemon-wide plugin registry (undefined when plugins aren't wired at all). */
  plugins(): Promise<PluginRegistry | undefined>;
  /** Shared session assembly (store row + rehydrate + resource loader + PI session). */
  factory: BrainSessionFactory;
  /** Long-lived session taps to re-attach on every (re)spawn — owned by ClientAttachments. */
  sessionTaps(sessionId: string): Iterable<(e: BrainEvent) => void>;
}

/** Composes ONE live conversation out of config + plugins + persona + tools — everything shared by a
 *  user session and a channel session: registry + store row + rehydration + persona/plugins composition
 *  + PI session construction + persistence subscription. The single spawn source for the chat brain,
 *  its lifecycle respawns and the channel service. */
export class LiveSessionSpawner {
  constructor(private d: SpawnerDeps) {}

  /** The current provider set (live-resolved when a thunk was injected). */
  private runtimeConfig(): BrainRuntimeConfig {
    const cfg = typeof this.d.config === 'function' ? this.d.config() : this.d.config;
    if (!cfg || cfg.providers.length === 0) throw new Error('no brain provider configured — add one in Settings → Brain');
    return cfg;
  }

  async spawn(opts: SpawnOpts): Promise<LiveBrain> {
    const { sessionId, ownerUserId } = opts;

    const cfg = this.runtimeConfig();
    const registry = buildBrainRegistry(cfg, this.d.authStorage);
    const model = resolveBrainModel(registry, cfg, opts.selection);
    // The CONFIG entry id this session runs on (mirror of resolveBrainModel's entry pick) — stored so a
    // turn can tell delegation "run the child on my provider+model" without re-deriving the default.
    const providerId = (opts.selection.provider && cfg.providers.some((p) => p.id === opts.selection.provider))
      ? opts.selection.provider : cfg.providers[0]?.id;
    // The session cwd is what pi advertises to the model ("Current working directory: …") and what
    // relative paths resolve against — it must be the USER'S project, never the brain's data dir
    // (the model would otherwise claim/act on that path). Same resolution as the per-turn workDir.
    const cwd = turnWorkDir(opts.policy, opts.clientCwd, this.d.projectPath) ?? this.d.cwd ?? process.cwd();
    // Enabled plugins contribute tools, skills, and system-prompt fragments. Their tools read the active
    // Policy at call time via AsyncLocalStorage (set around each prompt), no per-session construction.
    const plugins = await this.d.plugins();
    // The security invariant (a SHARED platform channel — trusted OR foreign — never gets the owner's
    // orca_* control-plane tools or owner API token) lives in composeSessionTools; the token is minted
    // lazily so it never exists for them. An admin-role Discord sender lands on 'trusted-channel', NOT
    // 'owner-chat', so the channel-keyed session can't leak the owner toolset to a later non-admin
    // sender in the same channel. Memory tools ride every interactive session but key per-user on the
    // acting orcaUserId (each caller reaches only their own memory). Built lazily; wired when deps exist.
    const memStore = this.d.memoryStore;
    const memService = this.d.memoryService;
    const memCats = this.d.memoryCategoryStore;
    const memCategorizer = this.d.memoryCategorizer;
    const pluginTools = plugins?.tools ?? [];
    // Plugin hook point: after a permitted plugin tool's execute resolves, fan the call out to
    // `tools.call.after` subscribers (e.g. the formatters plugin). AWAITED by the tool gate before the
    // result returns, so a hook that rewrites the written file finishes before the transcript diff /
    // next tool call — the bus stays fail-open and bounds each hook by the event's budget, so a broken
    // hook can never fail (only briefly delay) the tool result.
    const toolHookBus = plugins && plugins.hooks.length > 0
      ? new PluginHookBus({ hooks: plugins.hooks, hookOwners: plugins.hookOwners, capabilities: plugins.pluginCapabilities, logger: logger('plugin-hooks') })
      : undefined;
    const allTools = composeSessionTools({
      kind: opts.channel ? (opts.trustedChannel ? 'trusted-channel' : 'foreign-channel') : 'owner-chat',
      orcaTools: () => buildOrcaTools({ url: this.d.url, token: this.d.users.ensureAdvisorToken(ownerUserId) }),
      memoryTools: memStore && memService && memCats && memCategorizer
        ? () => buildMemoryTools({ store: memStore, service: memService, categories: memCats, categorizer: memCategorizer })
        : undefined,
      pluginTools,
      // Plugin tools are gated at EXECUTE time from the turn's ToolPolicy (set in runWithPolicy), not
      // filtered at compose — one shared mechanism for owner chat and shared channels alike.
      onToolResult: toolHookBus ? (e) => toolHookBus.emit('tools.call.after', e) : undefined,
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

    const { session } = await this.d.factory.create({
      sessionId, ownerUserId, registry, model, cwd,
      systemPrompt: persona, appendSystemPrompt: append,
      tools: allTools, thinkingLevel: opts.thinkingLevel,
    });

    // Resolve tool→icon once per session and stamp it on each tool event, so every client renders the
    // same icon without its own hardcoded map. Icons live with their owner: built-in tools declare them
    // co-located (BUILTIN_TOOL_ICONS), plugins in their manifest — a plugin entry overrides a built-in.
    const iconMap = new Map<string, string>(Object.entries(BUILTIN_TOOL_ICONS));
    for (const [k, v] of plugins?.toolIcons ?? []) iconMap.set(k, v);
    const iconOf = makeToolIconResolver(iconMap);
    const listeners = new Set<(e: BrainEvent) => void>();
    // Re-attach long-lived session taps (open sub-agent drill-in streams): a respawn (model switch,
    // LRU eviction + revival) builds a fresh listener set, and without this the tapped stream would
    // silently go dark while the client believes it is still following the session.
    for (const tap of this.d.sessionTaps(opts.sessionId)) listeners.add(tap);
    let steps = 0; // model round-trips in the current run — reset on agent_start, one per turn_start
    session.subscribe((e: AgentSessionEvent) => {
      const raw = (e as { type?: string }).type;
      // Step accounting + ceiling. Each run resets on agent_start; every turn_start is one step. The
      // limit is read fresh per turn (a config change applies without a session restart). Past the
      // ceiling the run is aborted so a wedged agent can't loop forever — it settles into agent_end/idle
      // like a normal stop. `maxSteps ≤ 0` means unlimited (no counter emitted, no enforcement).
      if (raw === 'agent_start') steps = 0;
      else if (raw === 'turn_start') {
        steps += 1;
        const maxSteps = this.d.maxSteps?.() ?? 0;
        if (maxSteps > 0 && steps > maxSteps) void session.abort().catch(() => { /* already settling */ });
        else for (const l of listeners) l({ type: 'step', step: steps, maxSteps, usage: usageOf(session) });
      }
      // A turn that settled on a provider error (stopReason 'error', no text) would otherwise wind down
      // as a bare idle — the web/CLI client shows NOTHING and the failure is invisible (the silent-reply
      // bug). Surface the provider's message as an error event ahead of the terminal idle. NOT when PI is
      // about to auto-retry (`willRetry`): a transient 429/5xx emits an errored agent_end per attempt, and
      // a premature error event would fail a headless run (exit 1) that the retry was about to rescue.
      if (raw === 'agent_end' && !(e as { willRetry?: boolean }).willRetry) {
        const msgs = (e as { messages?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown }[] }).messages ?? [];
        const last = [...msgs].reverse().find((m) => m.role === 'assistant');
        const text = Array.isArray(last?.content)
          ? (last.content as { type?: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
          : '';
        if (last?.stopReason === 'error' && !text.trim()) {
          const message = last.errorMessage?.trim() || 'the model returned no reply (provider error)';
          for (const l of listeners) l({ type: 'error', message });
        }
      }
      const be = toBrainEvent(e);
      if (!be) return;
      if (be.type === 'idle') { be.usage = usageOf(session); be.model = model.id; } // statusline data rides the idle event
      if (be.type === 'tool') be.icon = iconOf(be.name);
      for (const l of listeners) l(be);
    });

    // Ephemeral per-turn context (date/time, …) is injected into each user message — see send() — so it
    // stays fresh WITHOUT invalidating the cached system-prompt prefix.
    const providers = plugins?.turnContexts ?? [];
    const turnContext = (): string => {
      const parts = providers.map((f) => { try { return f(); } catch { return ''; } }).filter((x) => x && x.trim());
      return parts.length ? `<context>\n${parts.join('\n')}\n</context>\n\n` : '';
    };
    return { session, sessionId, model: model.id, providerId, thinkingLevel: opts.thinkingLevel, policy: opts.policy, autoCompact: opts.autoCompact, autoCompactAt: opts.autoCompactAt, listeners, turnContext, pluginToolNames: new Set(pluginTools.map((t) => t.name)), workDir: cwd };
  }
}
