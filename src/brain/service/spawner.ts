import { isChannelSession, isSubagentSession, skillOwnerForSession } from '../sessionId.js';
import { DEFAULT_BRAND } from '../../shared/brand.js';
import type { PluginRegistry } from '../../plugins/registry.js';
import { PluginHookBus } from '../../plugins/hookBus.js';
import { logger } from '../../shared/logger.js';
import type { BrainRuntimeConfig } from '../providers.js';
import { buildBrainRegistry, resolveBrainModelRoute } from '../providers.js';
import { buildMemoryTools, BUILTIN_TOOL_DEFER_LOADING, BUILTIN_TOOL_ICONS, BUILTIN_TOOL_PLAN_SAFE } from '../tools/index.js';
import { buildShareImageTool } from '../tools/shareImageTool.js';
import { makeToolIconResolver } from '../toolIcons.js';
import { composeSessionTools } from '../session/capabilities.js';
import { createToolSearchHandle, toolSearchTool, formatDeferredToolsBlock, formatHostedToolCatalogBlock, type ToolSearchHandle } from '../toolSearch/toolSearchTool.js';
import { buildPromptTemplates } from '../slashCommands.js';
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { personalityText } from '../personality.js';
import { currentWorkDir } from '../../plugins/policyContext.js';
import { globalMemoryRecallScope, memoryRecallScope } from '../memoryRecallScope.js';
import type { BrainSessionFactory } from '../session/factory.js';
import { resolveAutoCompactPct } from '../session/factory.js';
import type { LiveBrain, SpawnOpts, QueuedMsg, TurnContextBlocks } from '../session/liveBrain.js';
import type { BrainEvent } from '../events.js';
import type { BrainDeps } from '../brainDeps.js';
import { clientDir, turnWorkDir } from './workDir.js';
import { modelCapabilities, qwenThinkingWire } from '../modelCapabilities.js';
import { LiveEventReplay } from '../session/liveEventReplay.js';
import { resolveHostedToolSearchRoute } from '../session/hostedToolSearch.js';
import { createSpawnEventReducer } from './spawnEventReducer.js';
import { userInstructionsBlock } from '../../prompts/userInstructions.js';

interface SpawnerDeps {
  /** See the BrainDeps fields of the same names — the spawner receives the subset it composes from. */
  config: BrainDeps['config'];
  store: BrainDeps['store'];
  runtime: BrainDeps['runtime'];
  users: BrainDeps['users'];
  prompts: BrainDeps['prompts'];
  chatImagesDir: BrainDeps['chatImagesDir'];
  url: string;
  cwd?: string;
  projectPath?: () => string | undefined;
  userSettings?: BrainDeps['userSettings'];
  activeUserInstructions?: BrainDeps['activeUserInstructions'];
  brand?: BrainDeps['brand'];
  maxSteps?: () => number;
  runtimeConfig?: BrainDeps['runtimeConfig'];
  memoryStore?: BrainDeps['memoryStore'];
  memoryService?: BrainDeps['memoryService'];
  /** REQUIRED, though its own type is optional: this was declared optional once and BrainService simply
   *  never forwarded it, so every session silently ran on the zero fallback below and the whole feature
   *  was dead in production while every test passed. Making the property mandatory means a future
   *  wiring site cannot forget it without the compiler saying so. */
  liveRecallBudget: BrainDeps['liveRecallBudget'];
  memoryCategoryStore?: BrainDeps['memoryCategoryStore'];
  memoryCategorizer?: BrainDeps['memoryCategorizer'];
  /** Registered projects — the write path resolves the current turn's project id to a slug for the
   *  lazily created project category (see MemoryToolDeps.projects). */
  projects?: BrainDeps['projects'];
  /** The daemon-wide plugin registry (undefined when plugins aren't wired at all). */
  plugins(): Promise<PluginRegistry | undefined>;
  /** Shared session assembly (store row + rehydrate + resource loader + PI session). */
  factory: BrainSessionFactory;
  /** Every listener ClientAttachments still has attached to this session id (subscribe() AND
   *  tapSession()) — restored on every (re)spawn. Ownership lives entirely in ClientAttachments, so a
   *  respawn site never has to carry a particular LiveBrain's transient `listeners` Set by hand. */
  sessionTaps(sessionId: string): Iterable<(e: BrainEvent) => void>;
}

/** Composes ONE live conversation out of config + plugins + persona + tools — everything shared by a
 *  user session and a channel session: registry + store row + rehydration + persona/plugins composition
 *  + PI session construction + persistence subscription. The single spawn source for the chat brain,
 *  its lifecycle respawns and the channel service. */
/** Whether mid-turn recall may run for this session. This is the leak boundary, so it is a named,
 *  testable decision rather than an inline condition: a shared channel serves several senders and must
 *  never surface one person's memories to another, and an ownerless session has no memory to search.
 *  Sub-agent sessions are channel-keyed (`brain-ch-subagent-*`), so the same test excludes them. */
export function liveRecallAllowed(sessionId: string, ownerUserId: number): boolean {
  return ownerUserId > 0 && !isSubagentSession(sessionId);
}

/** WHOSE memories a mid-turn recall may search — the actual leak boundary now that shared channels are
 *  allowed through {@link liveRecallAllowed}.
 *
 *  An owner conversation is always its owner's. A channel serves several senders, so it is the VERIFIED
 *  sender of the turn in flight (`turnRecallUserId`, set per turn by the channel service) and nobody at
 *  all when that sender is unlinked — never the channel owner, whose memories would otherwise surface
 *  into a stranger's turn in a room they share. This mirrors the rule the channel's turn-start recall
 *  has always applied; the two must not drift apart. */
export function liveRecallUserId(
  sessionId: string,
  ownerUserId: number,
  turnRecallUserId: number | null | undefined,
): number | null {
  if (!isChannelSession(sessionId)) return ownerUserId > 0 ? ownerUserId : null;
  return turnRecallUserId != null && turnRecallUserId > 0 ? turnRecallUserId : null;
}

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
    // One spawn-time snapshot: hosted routing and local deferral must agree on the same kill switch and
    // Azure capability map. A settings change applies on the next respawn, never mid-turn.
    const runtime = this.d.runtimeConfig?.();
    const registry = buildBrainRegistry(cfg, this.d.runtime);
    // The owner's per-user compaction-model choice (Account → Auto-compact). Empty → PI compacts on the
    // session model (or the provider's stable default). Validated at save time; resolved defensively here
    // so a since-revoked/removed pick never blocks the session.
    const settings = this.d.userSettings?.(ownerUserId);
    const compactSel = settings?.compactModel && settings.compactModelProvider
      ? { provider: settings.compactModelProvider, model: settings.compactModel }
      : undefined;
    // The owner's per-user chat-model choice fills in only when NO explicit selection is in play: an
    // empty selection would otherwise resolve to cfg.providers[0].models[0] — the first model of the
    // first provider in LIST order, not anyone's default — which once dropped a session on an
    // image-only model that cannot hold a conversation. Both parts must be set together: model ids are
    // not globally unique, so a bare model id could resolve under another provider's credentials.
    const chatSel = settings?.model && settings.modelProvider
      ? { provider: settings.modelProvider, model: settings.model }
      : undefined;
    const selection = opts.selection.provider || opts.selection.model ? opts.selection : chatSel;
    const route = resolveBrainModelRoute(registry, cfg, selection, compactSel);
    const { model } = route;
    // Per-model auto-compact threshold: the user's override for THIS model (keyed providerId/model) wins
    // over the global percentage carried in opts. Each model's own contextWindow then turns the percentage
    // into the right absolute reserve down in the factory.
    const autoCompactAtPct = resolveAutoCompactPct(settings?.autoCompactAtByModel, route.providerId, model.id, opts.autoCompactAtPct);
    const capabilities = modelCapabilities(model);
    // One resolver owns OAuth, official API-key and probe-backed Azure classification. It consumes the
    // config entry (auth + URL), never guesses from PI's registry provider name.
    const providerEntry = cfg.providers.find((provider) => provider.id === route.providerId);
    if (!providerEntry) throw new Error(`brain provider '${route.providerId}' is not configured`);
    const hostedRoute = resolveHostedToolSearchRoute(providerEntry, model, {
      toolDeferralEnabled: runtime?.toolDeferralEnabled ?? false,
      hostedToolSearch: runtime?.hostedToolSearch ?? {},
    });
    const hostedToolSearch = hostedRoute?.provider;
    const providerHostedToolSearch = hostedRoute !== undefined;
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
    const memProjects = this.d.projects;
    // Tools and skills use the SAME proven session owner. A delegated child inherits personal
    // contributions only when its parent is an owner/direct conversation; shared or unknown parents
    // fail closed to the instance set.
    const contributionOwnerUserId = skillOwnerForSession(sessionId, ownerUserId, opts.parentSessionId, opts.direct === true);
    const contributionOwnerUser = contributionOwnerUserId == null ? null : this.d.users.get(contributionOwnerUserId);
    const pluginTools = plugins?.toolsFor(contributionOwnerUserId, contributionOwnerUser) ?? [];
    // Plugin hook point: after a permitted plugin tool's execute resolves, fan the call out to
    // `tools.call.after` subscribers (e.g. the formatters plugin). AWAITED by the tool gate before the
    // result returns, so a hook that rewrites the written file finishes before the transcript diff /
    // next tool call — the bus stays fail-open and bounds each hook by the event's budget, so a broken
    // hook can never fail (only briefly delay) the tool result.
    const toolHookBus = plugins && plugins.hooks.length > 0
      ? new PluginHookBus({ hooks: plugins.hooks, hookOwners: plugins.hookOwners, capabilities: plugins.pluginCapabilities, logger: logger('plugin-hooks') })
      : undefined;
    const toolDeferralOverrides = runtime?.toolDeferralOverrides;
    const planSafeToolNames = new Set([...BUILTIN_TOOL_PLAN_SAFE, ...(plugins?.toolPlanSafe ?? [])]);
    let toolSearchHandle: ToolSearchHandle | undefined;
    const sessionKind = opts.channel ? (opts.trustedChannel ? 'trusted-channel' : 'foreign-channel') : 'owner-chat';
    const allTools = composeSessionTools({
      kind: sessionKind,
      memoryTools: memStore && memService && memCats && memCategorizer && memProjects
        ? () => buildMemoryTools({ store: memStore, service: memService, categories: memCats, categorizer: memCategorizer, projects: memProjects })
        : undefined,
      // composeSessionTools first builds every other group once, then resolves policy over that exact set.
      // The callback creates the one shared handle only when something is actually withheld and returns
      // ToolSearch to its historical stable position in the ordered definitions.
      toolDeferral: {
        toolOwner: plugins?.toolOwner ?? new Map(),
        toolDeferLoading: plugins?.toolDeferLoading ?? new Set(),
        planSafeToolNames,
        builtinDeferLoading: BUILTIN_TOOL_DEFER_LOADING,
        overrides: toolDeferralOverrides,
        options: runtime ? { enabled: runtime.toolDeferralEnabled, threshold: runtime.limits.toolDeferThreshold } : undefined,
      },
      toolSearch: (deferred) => {
        // Hosted mode keeps every sender-visible application tool active in PI's execution registry, then
        // the provider module marks the final payload definitions deferred. Execute-time plan/permission
        // denials stay gates rather than visibility changes, preserving the established cache contract. Do not
        // add the local search tool or a local handle: mixing both paths costs the extra model round again
        // and lets historical `addedToolNames` trigger pi's additional_tools replay.
        if (providerHostedToolSearch) return [];
        toolSearchHandle = createToolSearchHandle(deferred);
        return [toolSearchTool(toolSearchHandle)];
      },
      // Needs somewhere to keep the bytes; an in-memory store has none, and the tool says so rather than
      // silently doing nothing.
      shareImage: () => [buildShareImageTool({ store: this.d.store, imagesDir: this.d.chatImagesDir })],
      pluginTools,
      // Plugin tools are gated at EXECUTE time from the turn's ToolPolicy (set in runWithPolicy), not
      // filtered at compose — one shared mechanism for owner chat and shared channels alike.
      onToolResult: toolHookBus ? (e) => toolHookBus.emit('tools.call.after', e) : undefined,
      // The matching veto point: a `tools.call.before` subscriber may refuse a call outright. Same bus
      // and the same fail-open guarantees, but a much shorter budget — this one is latency the user
      // waits through in FRONT of every call, not after it.
      onToolCall: toolHookBus
        ? async (e) => (await toolHookBus.emitBlocking('tools.call.before', e)).deny
        : undefined,
    });
    // WHOSE skills this session may see. The SAME list has to reach both the awareness block and the
    // factory's skillsOverride below: feeding the model one set and PI another would either advertise a
    // skill `/skill:` cannot expand, or hide one it still can.
    const skills = plugins?.skillsFor(contributionOwnerUserId, contributionOwnerUser) ?? [];
    // Plugin prompt-command macros → PI PromptTemplate[]: PI exposes them as `/name` slash commands and
    // expands their arguments natively in prompt()/steer()/followUp(). Every surface just sends the raw
    // slash. All registered commands go in (surface filtering is only a menu concern, not expansion).
    const promptTemplates = buildPromptTemplates(plugins?.commands.values() ?? []);
    const fragments = plugins?.promptFragments ?? [];
    // The account owner's global instructions layer AFTER the persona as a separate appended chunk, never
    // the per-turn context (they are stable system-prompt material, so putting them per-turn would waste the
    // prompt cache). Undefined when empty → NOTHING appended, preserving the byte-identical default prefix.
    // XML escaping makes the account-data boundary explicit even when the text contains tag-like markup.
    const rawUserInstructions = this.d.activeUserInstructions?.(ownerUserId);
    const userInstructionsAppend = rawUserInstructions ? userInstructionsBlock(rawUserInstructions) : undefined;
    // Skills awareness block (progressive disclosure): PI would render `<available_skills>` itself, but
    // ONLY when a tool literally named `read` is active (system-prompt.js) — our tools are `Read`
    // etc., so PI never renders it. We therefore append it ourselves so the model learns which skills
    // exist; `skills` still flows to the factory's `skillsOverride` so PI expands `/skill:name` natively.
    // `formatSkillsForPrompt` already drops disable-model-invocation skills, so the toggle is honoured.
    const skillsBlock = skills.length ? formatSkillsForPrompt(skills) : '';
    // Deferred-tools awareness: names (+ short descriptions) of the withheld MCP tools so the model knows
    // what it can fetch via ToolSearch. Stable for the session (the MCP set is fixed at spawn) → sits in the
    // cache-friendly append region, not the per-turn context. Empty string when nothing is deferred.
    // Hosted search installs no local handle, so there is no deferred block — but Anthropic's BM25 variant
    // also withholds the tool LIST, leaving the model to guess which words might match something. Both
    // vendors recommend naming the available categories in the system prompt; names only, so deferral still
    // pays for itself.
    //
    // OWNER CHAT ONLY, deliberately. The block is built once at spawn from the session-wide tool set, but
    // real visibility is per-SENDER: `applyToolVisibility` narrows the active tools to the acting sender's
    // ToolPolicy on every turn. A shared channel has many senders with different roles, so a static list
    // would name tools the current sender may not use — and the block's own wording promises the opposite.
    // Owner chat has exactly one sender, who owns everything in it. Execute-time policy is unchanged
    // either way; this is about what the prompt ADVERTISES.
    const deferredBlock = toolSearchHandle
      ? formatDeferredToolsBlock(allTools, toolSearchHandle.deferred)
      : providerHostedToolSearch
        ? formatHostedToolCatalogBlock(allTools, plugins?.toolOwner ?? new Map<string, string>(), sessionKind)
        : '';
    const append = [skillsBlock, deferredBlock, ...fragments, ...(opts.extraAppend ?? []), userInstructionsAppend ?? ''].filter((s) => s.length > 0);

    // Elowen identity: the editable `elowen` prompt (per-user override aware) becomes the system prompt,
    // so the brain knows it is Elowen — not the underlying model's default persona.
    const u = this.d.users.get(ownerUserId);
    const userName = u?.name || u?.username || 'Filip';
    const personality = personalityText(this.d.userSettings?.(ownerUserId)?.advisorStyle ?? '');
    const brand = this.d.brand?.() ?? DEFAULT_BRAND;
    const agentName = brand.agentName;
    const productName = brand.productName;
    // A scheduled (cron/wake-up) turn gets its OWN focused system prompt — identity, channel-only
    // delivery, outcome reporting — instead of the coding-agent `elowen` base + platform overlay: a
    // timer-driven report is not an interactive coding session and does not need the engineering rules
    // or the multi-user channel framing. The personality chunk still appends normally (persona jobs).
    // Otherwise: shared platform channels (Discord, WhatsApp) get a thin overlay appended to the base
    // prompt, since the senders are OTHER people and the base single-user framing would misaddress the
    // room; owner chat gets the base alone.
    // `scheduled` deliberately gets no productName: its template never mentions the product (that keeps
    // its render byte-stable), and the prompt-editor catalog advertises exactly the vars passed here.
    const persona = opts.scheduled
      ? this.d.prompts.render('scheduled', { userName, personality, agentName }, ownerUserId)
      : opts.channel
        ? this.d.prompts.render('elowen', { userName, personality, agentName, productName }, ownerUserId)
          + '\n\n' + this.d.prompts.render('elowen-platform', { ownerName: userName, agentName, productName }, ownerUserId)
        : this.d.prompts.render('elowen', { userName, personality, agentName, productName }, ownerUserId);

    // Create the image-carrying queue mirrors before the PI session. The boundary compaction adapter reads
    // these exact arrays just before every next-turn provider request, so queued text AND attachments are
    // included in the context budget without reaching into PI's private PendingMessageQueue internals.
    const queuedSteer: QueuedMsg[] = [];
    const queuedFollowUp: QueuedMsg[] = [];
    const pendingCompactionMessages = () => [...queuedSteer, ...queuedFollowUp].map((message) => ({
      text: message.queuedText ?? message.text,
      images: message.images,
    }));
    // Declared here (assigned far below, after subscribe) so the mid-turn recall wiring can read the
    // running turn's identity off it. Same deferred-capture pattern as the event reducer's `getLive`.
    let live!: LiveBrain;
    // Resolved per pass rather than captured once: on a channel the identity belongs to the turn, not to
    // the session. Safe because the channel lock serializes turns, so it cannot change under a running
    // retrieval. The rule itself lives in liveRecallUserId, where a test can pin it.
    const recallUserId = (): number | null => liveRecallUserId(sessionId, ownerUserId, live.turnRecallUserId);
    const listeners = new Set<(e: BrainEvent) => void>();
    // Re-attach every listener ClientAttachments still has on this session id — direct subscribe()
    // subscribers and drill-in taps alike. A respawn (model switch, restart, vision hop, idle rollover,
    // LRU eviction + revival) always builds a fresh listener set here; without this every one of them
    // would silently go dark while the client believes it is still attached.
    for (const tap of this.d.sessionTaps(opts.sessionId)) listeners.add(tap);
    // Built before the session so the compaction circuit breaker (installed inside the factory) has a
    // channel to report on; nothing publishes until the session actually runs.
    const replay = new LiveEventReplay(listeners);
    const { session, applyCompaction, assessColdCompaction } = await this.d.factory.create({
      sessionId, ownerUserId, parentSessionId: opts.parentSessionId, delegatedAccess: opts.delegatedAccess,
      seedMessages: opts.seedMessages,
      runtime: this.d.runtime, model, providerId, compactionFallbackModel: route.compactionFallback, cwd,
      systemPrompt: persona, appendSystemPrompt: append, skills, promptTemplates,
      tools: allTools, toolSearch: toolSearchHandle, hostedToolSearch,
      thinkingLevel: opts.thinkingLevel, requestProfile,
      autoCompact: opts.autoCompact, autoCompactAtPct,
      // Read per call rather than from the `runtime` snapshot above: the operator can turn provider-side
      // compaction off while a long conversation is running, and the next request must already follow it.
      remoteCompactionEnabled: () => this.d.runtimeConfig?.().remoteCompactionEnabled === true,
      providerRequestCaptureEnabled: () => this.d.runtimeConfig?.().providerRequestCaptureEnabled !== false,
      pendingCompactionMessages,
      // Recall again mid-turn. `enabled` and the budget are read per pass, so both the user's toggle and
      // the operator's limits take effect on a conversation that is already running.
      ...(memService && liveRecallAllowed(sessionId, ownerUserId) ? {
        liveRecall: {
          budget: () => this.d.liveRecallBudget?.() ?? { passes: 0, count: 0, bytes: 0 },
          enabled: () => {
            const userId = recallUserId();
            return userId !== null && this.d.userSettings?.(userId)?.autoLiveRecall !== false;
          },
          retrieve: async (query: string, maxCount: number, byteBudget: number) => {
            const userId = recallUserId();
            if (userId === null) return []; // an unlinked sender in a shared room recalls nothing
            // The retrieval continues after the context hook returns, so its AsyncLocalStorage scope is not
            // a reliable recall boundary. Resolve and pass the current turn's scope before awaiting it.
            const storedWorkDir = this.d.store.getSession(sessionId)?.work_dir || undefined;
            const recallCwd = clientDir(opts.policy, currentWorkDir() ?? storedWorkDir);
            // A channel has no project of its own — its cwd is the policy root, not the sender's work —
            // so it searches global categories only, exactly like its turn-start recall.
            const scope = memCats && memProjects
              ? (isChannelSession(sessionId)
                ? globalMemoryRecallScope(userId, memCats)
                : memoryRecallScope(userId, recallCwd, memCats, memProjects))
              : { projectId: null, categoryIds: new Set<number>() };
            const found = await memService.retrieve(userId, query, { maxCount, byteBudget, scope });
            return found.memories.map((m) => ({
              id: m.id, body: m.body, kind: m.kind, importance: m.importance, updatedAt: m.updated_at,
            }));
          },
          // Marked here rather than inside retrieve(): a turn issues several passes whose results
          // overlap, and only the ones that survive the dedup actually reach the model.
          onInjected: (ids) => {
            const userId = recallUserId();
            if (userId !== null) memService.markRecalled(userId, ids);
          },
        },
      } : {}),
      // Project AGENTS.md/CLAUDE.md ride the system prompt for an ADMIN's own chat only. Two guards,
      // both required: (1) not a shared channel (foreign senders must never see instruction files);
      // (2) admin owner — a non-admin account with no repo of its own resolves cwd to the daemon's
      // project path, and PI walks it plus every ancestor up to `/`, so a plain user's chat would
      // otherwise inhale the operator's private CLAUDE.md (internal hosts, prod credentials).
      contextFiles: !opts.channel && !!u?.is_admin,
      // A conversation that gave up on compacting cannot recover on its own, so it goes out on the same
      // channel as any other terminal session failure rather than staying a log line nobody reads.
      onCompactionStopped: (message) => replay.publish({ type: 'error', message }),
      onSpawned: toolHookBus ? (e) => toolHookBus.emit('brain.session.afterSpawn', e) : undefined,
    });

    // Resolve tool→icon once per session and stamp it on each tool event, so every client renders the
    // same icon without its own hardcoded map. Icons live with their owner: built-in tools declare them
    // co-located (BUILTIN_TOOL_ICONS), plugins in their manifest — a plugin entry overrides a built-in.
    const iconMap = new Map<string, string>(Object.entries(BUILTIN_TOOL_ICONS));
    for (const [k, v] of plugins?.toolIcons ?? []) iconMap.set(k, v);
    const iconOf = makeToolIconResolver(iconMap);
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
      session, sessionId, ownerUserId, direct: opts.direct === true,
      model: model.id, providerId, provider: model.provider, thinkingLevel: opts.thinkingLevel,
      requestProfile, fastAvailable: capabilities.fast,
      thinkingLabels: Object.fromEntries(capabilities.levels.map((level) => [level, capabilities.labels[level] ?? level])),
      policy: opts.policy, applyCompaction, assessColdCompaction, listeners, replay, turnContext,
      pluginToolNames: new Set(pluginTools.map((t) => t.name)),
      // The deferred-tool handle (undefined when nothing is deferred). Carried on the live so each turn's
      // visibility pass keeps already-fetched tools advertised and withheld ones hidden.
      toolSearch: toolSearchHandle,
      // Read-only-ness is declared with the tool, exactly like its icon above: the core co-locates its
      // own, a plugin states its own in the manifest. Assembled once per session so a plugin toggle
      // applies on the next spawn without a daemon restart.
      planSafeToolNames,
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
