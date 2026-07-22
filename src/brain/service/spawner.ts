import type { PluginRegistry } from '../../plugins/registry.js';
import { PluginHookBus } from '../../plugins/hookBus.js';
import { logger } from '../../shared/logger.js';
import type { BrainRuntimeConfig } from '../providers.js';
import { buildBrainRegistry, resolveBrainModelRoute } from '../providers.js';
import { buildElowenTools, buildMemoryTools, BUILTIN_TOOL_ICONS, BUILTIN_TOOL_PLAN_SAFE } from '../tools/index.js';
import { makeToolIconResolver } from '../toolIcons.js';
import { composeSessionTools } from '../session/capabilities.js';
import { buildPromptTemplates } from '../slashCommands.js';
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { personalityText } from '../personality.js';
import type { BrainSessionFactory } from '../session/factory.js';
import type { LiveBrain, SpawnOpts, QueuedMsg, TurnContextBlocks } from '../session/liveBrain.js';
import type { BrainEvent } from '../events.js';
import type { BrainDeps } from '../brainDeps.js';
import { turnWorkDir } from './workDir.js';
import { modelCapabilities, qwenThinkingWire } from '../modelCapabilities.js';
import { LiveEventReplay } from '../session/liveEventReplay.js';
import { createSpawnEventReducer } from './spawnEventReducer.js';

interface SpawnerDeps {
  /** See the BrainDeps fields of the same names — the spawner receives the subset it composes from. */
  config: BrainDeps['config'];
  store: BrainDeps['store'];
  runtime: BrainDeps['runtime'];
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
    const registry = buildBrainRegistry(cfg, this.d.runtime);
    // The owner's per-user compaction-model choice (Account → Auto-compact). Empty → PI compacts on the
    // session model (or the provider's stable default). Validated at save time; resolved defensively here
    // so a since-revoked/removed pick never blocks the session.
    const settings = this.d.userSettings?.(ownerUserId);
    const compactSel = settings?.compactModel && settings.compactModelProvider
      ? { provider: settings.compactModelProvider, model: settings.compactModel }
      : undefined;
    const route = resolveBrainModelRoute(registry, cfg, opts.selection, compactSel);
    const { model } = route;
    const capabilities = modelCapabilities(model);
    // Temperature is the provider entry's own setting, read from the same route that chose the model, and
    // absent unless the operator set one — see ProviderRequestProfile on why absent must stay the default.
    const requestProfile = {
      fast: capabilities.fast && opts.fast === true,
      // A Qwen thinking model on a DashScope endpoint takes its effort as `thinking_budget`, not
      // `reasoning_effort` — the hook rewrites each request's current effort into that wire shape.
      ...(model.reasoning && qwenThinkingWire(model.baseUrl, model.id) ? { qwenThinking: true } : {}),
      ...(() => {
        const t = cfg.providers.find((p) => p.id === route.providerId)?.temperature;
        return t === undefined ? {} : { temperature: t };
      })(),
    };
    // The CONFIG entry id this session runs on comes from the same authoritative route as the descriptor,
    // so delegation never has to re-derive which provider won default/explicit selection.
    const providerId = route.providerId;
    // The session cwd is what pi advertises to the model ("Current working directory: …") and what
    // relative paths resolve against — it must be the USER'S project, never the brain's data dir
    // (the model would otherwise claim/act on that path). Same resolution as the per-turn workDir.
    const cwd = turnWorkDir(opts.policy, opts.clientCwd, this.d.projectPath) ?? this.d.cwd ?? process.cwd();
    // Enabled plugins contribute tools, skills, and system-prompt fragments. Their tools read the active
    // Policy at call time via AsyncLocalStorage (set around each prompt), no per-session construction.
    const plugins = await this.d.plugins();
    // The security invariant (a SHARED platform channel — trusted OR foreign — never gets the owner's
    // Elowen* control-plane tools or owner API token) lives in composeSessionTools; the token is minted
    // lazily so it never exists for them. An admin-role Discord sender lands on 'trusted-channel', NOT
    // 'owner-chat', so the channel-keyed session can't leak the owner toolset to a later non-admin
    // sender in the same channel. Memory tools ride every interactive session but key per-user on the
    // acting elowenUserId (each caller reaches only their own memory). Built lazily; wired when deps exist.
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
      elowenTools: () => buildElowenTools({ url: this.d.url, token: this.d.users.ensureAdvisorToken(ownerUserId) }),
      memoryTools: memStore && memService && memCats && memCategorizer
        ? () => buildMemoryTools({ store: memStore, service: memService, categories: memCats, categorizer: memCategorizer })
        : undefined,
      pluginTools,
      // Plugin tools are gated at EXECUTE time from the turn's ToolPolicy (set in runWithPolicy), not
      // filtered at compose — one shared mechanism for owner chat and shared channels alike.
      onToolResult: toolHookBus ? (e) => toolHookBus.emit('tools.call.after', e) : undefined,
    });
    const skills = plugins?.skills ?? [];
    // Plugin prompt-command macros → PI PromptTemplate[]: PI exposes them as `/name` slash commands and
    // expands their arguments natively in prompt()/steer()/followUp(). Every surface just sends the raw
    // slash. All registered commands go in (surface filtering is only a menu concern, not expansion).
    const promptTemplates = buildPromptTemplates(plugins?.commands.values() ?? []);
    const fragments = plugins?.promptFragments ?? [];
    // The user's global personality body — one persona, identical on every platform — layers AFTER the
    // persona as a separate appended chunk, never the per-turn context (personality is stable system-prompt
    // material, so putting it per-turn would waste the prompt cache). Undefined when the body is empty →
    // NOTHING appended, so the systemPrompt prefix stays byte-identical for users without one.
    const persoAppend = this.d.activePersonality?.(ownerUserId);
    // Skills awareness block (progressive disclosure): PI would render `<available_skills>` itself, but
    // ONLY when a tool literally named `read` is active (system-prompt.js) — our tools are `Read`
    // etc., so PI never renders it. We therefore append it ourselves so the model learns which skills
    // exist; `skills` still flows to the factory's `skillsOverride` so PI expands `/skill:name` natively.
    // `formatSkillsForPrompt` already drops disable-model-invocation skills, so the toggle is honoured.
    const skillsBlock = skills.length ? formatSkillsForPrompt(skills) : '';
    const append = [skillsBlock, ...fragments, ...(opts.extraAppend ?? []), persoAppend ?? ''].filter((s) => s.length > 0);

    // Elowen identity: the editable `elowen` prompt (per-user override aware) becomes the system prompt,
    // so the brain knows it is Elowen — not the underlying model's default persona.
    const u = this.d.users.get(ownerUserId);
    const userName = u?.name || u?.username || 'Filip';
    const personality = personalityText(this.d.userSettings?.(ownerUserId)?.advisorStyle ?? '');
    const agentName = this.d.agentName?.() || 'Elowen';
    // A scheduled (cron/wake-up) turn gets its OWN focused system prompt — identity, channel-only
    // delivery, outcome reporting — instead of the coding-agent `elowen` base + platform overlay: a
    // timer-driven report is not an interactive coding session and does not need the engineering rules
    // or the multi-user channel framing. The personality chunk still appends normally (persona jobs).
    // Otherwise: shared platform channels (Discord, WhatsApp) get a thin overlay appended to the base
    // prompt, since the senders are OTHER people and the base single-user framing would misaddress the
    // room; owner chat gets the base alone.
    const persona = opts.scheduled
      ? this.d.prompts.render('scheduled', { userName, personality, agentName }, ownerUserId)
      : opts.channel
        ? this.d.prompts.render('elowen', { userName, personality, agentName }, ownerUserId)
          + '\n\n' + this.d.prompts.render('elowen-platform', { ownerName: userName, agentName }, ownerUserId)
        : this.d.prompts.render('elowen', { userName, personality, agentName }, ownerUserId);

    // Create the image-carrying queue mirrors before the PI session. The boundary compaction adapter reads
    // these exact arrays just before every next-turn provider request, so queued text AND attachments are
    // included in the context budget without reaching into PI's private PendingMessageQueue internals.
    const queuedSteer: QueuedMsg[] = [];
    const queuedFollowUp: QueuedMsg[] = [];
    const pendingCompactionMessages = () => [...queuedSteer, ...queuedFollowUp].map((message) => ({
      text: message.queuedText ?? message.text,
      images: message.images,
    }));
    const { session } = await this.d.factory.create({
      sessionId, ownerUserId, parentSessionId: opts.parentSessionId, delegatedAccess: opts.delegatedAccess,
      runtime: this.d.runtime, model, compactionFallbackModel: route.compactionFallback, cwd,
      systemPrompt: persona, appendSystemPrompt: append, skills, promptTemplates,
      tools: allTools, thinkingLevel: opts.thinkingLevel, requestProfile,
      autoCompact: opts.autoCompact, autoCompactAtPct: opts.autoCompactAtPct,
      pendingCompactionMessages,
      // Project AGENTS.md/CLAUDE.md ride the system prompt for an ADMIN's own chat only. Two guards,
      // both required: (1) not a shared channel (foreign senders must never see instruction files);
      // (2) admin owner — a non-admin account with no repo of its own resolves cwd to the daemon's
      // project path, and PI walks it plus every ancestor up to `/`, so a plain user's chat would
      // otherwise inhale the operator's private CLAUDE.md (internal hosts, prod credentials).
      contextFiles: !opts.channel && !!u?.is_admin,
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
    const replay = new LiveEventReplay(listeners);
    // Image-carrying mirror of PI's mid-turn queue — the SAME array instances returned on the LiveBrain, so
    // reconciling them here (in place) keeps the live wrapper's queue in sync. PI's public queue is text-only.
    let live!: LiveBrain;
    // The stateful event reducer that projects raw PI events into the store and fans the BrainEvent
    // contract to clients. Extracted into spawnEventReducer.ts (its own deferred terminal state per
    // session); `getLive` defers the `live` capture because it is assigned below, after subscribe — and
    // events only fire once the session is running, by which point it is set.
    session.subscribe(createSpawnEventReducer({
      replay,
      getLive: () => live,
      model,
      sessionId,
      session,
      store: this.d.store,
      providerId,
      iconOf,
      queuedSteer,
      queuedFollowUp,
      maxSteps: this.d.maxSteps,
    }));

    // Ephemeral per-turn context (date/time, …) is injected into each user message — see send() — so it
    // stays fresh WITHOUT invalidating the cached system-prompt prefix.
    const providers = plugins?.turnContexts ?? [];
    const turnContext = (): TurnContextBlocks => {
      const beforeUser: string[] = [];
      const afterUser: string[] = [];
      for (const provider of providers) {
        let value = '';
        try { value = provider.render(); } catch { /* A broken optional provider must not fail the turn. */ }
        if (!value?.trim()) continue;
        (provider.placement === 'after-user' ? afterUser : beforeUser).push(value);
      }
      const frame = (parts: string[], placement: 'before-user' | 'after-user'): string => parts.length
        ? `<context placement="${placement}">\n${parts.join('\n')}\n</context>\n\n`
        : '';
      return {
        beforeUser: frame(beforeUser, 'before-user'),
        afterUser: frame(afterUser, 'after-user'),
      };
    };
    live = {
      session, sessionId, model: model.id, providerId, provider: model.provider, thinkingLevel: opts.thinkingLevel,
      requestProfile, fastAvailable: capabilities.fast,
      thinkingLabels: Object.fromEntries(capabilities.levels.map((level) => [level, capabilities.labels[level] ?? level])),
      policy: opts.policy, listeners, replay, turnContext,
      pluginToolNames: new Set(pluginTools.map((t) => t.name)),
      // Read-only-ness is declared with the tool, exactly like its icon above: the core co-locates its
      // own, a plugin states its own in the manifest. Assembled once per session so a plugin toggle
      // applies on the next spawn without a daemon restart.
      planSafeToolNames: new Set([...BUILTIN_TOOL_PLAN_SAFE, ...(plugins?.toolPlanSafe ?? [])]),
      workDir: cwd,
      queuedSteer, queuedFollowUp, deliveringUserEchoes: [],
      // Baseline for owner mode-switch detection: left undefined so the FIRST turn on a fresh live (new
      // session or a respawn after a model switch) only records the mode without emitting a marker — a
      // marker means the user changed mode BETWEEN turns, not that a turn ran in a given mode.
      lastMode: undefined,
    };
    return live;
  }
}
