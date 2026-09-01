import { resolvesContributionsPerTurn, contributionOwnerForSession, isChannelSession, isSubagentSession } from '../sessionId.js';
import { DEFAULT_BRAND } from '../../shared/brand.js';
import type { PluginRegistry } from '../../plugins/registry.js';
import { PluginHookBus } from '../../plugins/hookBus.js';
import { logger } from '../../shared/logger.js';
import type { BrainRuntimeConfig } from '../providers.js';
import { buildBrainRegistry, registryProviderName, resolveBrainModelRoute } from '../providers.js';
import { resolveFastModeRoute } from '../fastMode.js';
import { isOfferableBrainModel } from '../../shared/execs.js';
import { buildMemoryTools, BUILTIN_TOOL_DEFER_LOADING, BUILTIN_TOOL_ICONS, BUILTIN_TOOL_PLAN_SAFE } from '../tools/index.js';
import { buildShareFileTool } from '../tools/shareFileTool.js';
import { buildShareImageTool } from '../tools/shareImageTool.js';
import { makeToolIconResolver } from '../toolIcons.js';
import { composeSessionTools } from '../session/capabilities.js';
import { createToolSearchHandle, toolSearchTool, formatDeferredToolsBlock, formatHostedToolCatalogBlock, type ToolSearchHandle } from '../toolSearch/toolSearchTool.js';
import { buildPromptTemplates } from '../slashCommands.js';
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { personalityText } from '../personality.js';
import { currentWorkDir, toolPermitted, type ToolPolicy } from '../../plugins/policyContext.js';
import { globalMemoryRecallScope, memoryRecallScope } from '../memoryRecallScope.js';
import type { BrainSessionFactory } from '../session/factory.js';
import { resolveAutoCompactPct } from '../session/factory.js';
import { DEFAULT_AUTO_COMPACT_PCT, type LiveBrain, type SpawnOpts, type QueuedMsg, type TurnContextBlocks } from '../session/liveBrain.js';
import { renderTurnContextFrame } from '../session/turnContextFrame.js';
import { liveSkillCommandExtension } from '../session/turnSkills.js';
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
  fastMode?: BrainDeps['fastMode'];
  activeUserInstructions?: BrainDeps['activeUserInstructions'];
  /** The single account tool-authority resolver used by every turn surface. */
  toolAuthorityFor(userId: number): ToolPolicy | undefined;
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
const WORKSPACE_UNSUPPORTED_TOOLS = new Set([
  'LspDiagnostics', 'LspGoToDefinition', 'LspFindReferences', 'LspHover',
  'LspDocumentSymbol', 'LspWorkspaceSymbol',
  'CodebaseSearch', 'CodebaseReindex', 'CodebaseStatus',
  'SandboxListWorkspaces', 'SandboxCreateWorkspace', 'SandboxUseWorkspace', 'SandboxCommit', 'SandboxRemoveWorkspace',
  'ListMcpResources', 'ReadMcpResource',
]);
const WORKSPACE_PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'ListDir', 'Search', 'FileInfo', 'GitStatus', 'Glob', 'Grep', 'WorkflowStart']);

export function workspaceToolDefinition<T extends { name: string; description?: string; parameters?: unknown }>(tool: T): T | undefined {
  if (WORKSPACE_UNSUPPORTED_TOOLS.has(tool.name)) return undefined;
  if (!WORKSPACE_PATH_TOOLS.has(tool.name) && tool.name !== 'Bash') return tool;
  const parameters = tool.parameters && typeof tool.parameters === 'object'
    ? structuredClone(tool.parameters) as Record<string, unknown>
    : tool.parameters;
  const properties = parameters && typeof parameters === 'object'
    ? ((parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>> | undefined)
    : undefined;
  if (properties?.path) properties.path.description = 'Workspace-relative logical path (for example "src/file.ts")';
  if (properties?.nodesFile) properties.nodesFile.description = 'Workspace-relative path to the JSON workflow definition';
  if (properties?.cwd) properties.cwd.description = 'Workspace-relative working directory; omit to use the workspace root';
  const description = tool.name === 'WorkflowStart'
    ? 'Run a DAG of sub-agents from a JSON definition inside this assigned workspace. nodesFile must be workspace-relative. Nodes may inherit this exact workspace or explicitly name the same/narrower workspaceId; they cannot widen to a sibling worktree.'
    : `${String(tool.description ?? '')
        .replace('The path must be absolute.', 'The path must be relative to the assigned workspace.')
        .replace('Use absolute paths — `cd` inside a compound command is unreliable and can shift context unexpectedly.', 'Use short workspace-relative paths. An absolute cwd or host path is refused.')}`;
  return { ...tool, description, ...(parameters ? { parameters } : {}) };
}

export function liveRecallAllowed(sessionId: string, ownerUserId: number): boolean {
  return ownerUserId > 0 && !isSubagentSession(sessionId);
}

/** WHOSE memories a mid-turn recall may search — the actual leak boundary now that shared channels are
 *  allowed through {@link liveRecallAllowed}.
 *
 *  An owner conversation is always its owner's. A channel serves several senders, so it is the VERIFIED
 *  sender of the turn in flight (`turnWriterUserId`, set per turn by the channel service) and nobody at
 *  all when that sender is unlinked — never the channel owner, whose memories would otherwise surface
 *  into a stranger's turn in a room they share. This mirrors the rule the channel's turn-start recall
 *  has always applied; the two must not drift apart. */
export function liveRecallUserId(
  sessionId: string,
  ownerUserId: number,
  turnWriterUserId: number | null | undefined,
): number | null {
  if (!isChannelSession(sessionId)) return ownerUserId > 0 ? ownerUserId : null;
  return turnWriterUserId != null && turnWriterUserId > 0 ? turnWriterUserId : null;
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
    // WHOSE personal preferences compose this session. A room belongs to whoever OPENED it, which is
    // bookkeeping and not a mandate: reading settings off that account made one colleague's personal
    // model, compaction model, thresholds, advisor style and private account instructions answer for
    // everyone else in the room. The caller therefore names the verified writer (channels.ts); a surface
    // with one sender omits the argument and its owner stands, as does an unlinked sender, a cron turn
    // or instance automation.
    //
    // That fallback is deliberately ASYMMETRIC with recall, which gives an unlinked sender NOTHING (see
    // `turnWriterUserId` in channels.ts): memories are one person's private content, so a stranger must
    // not be answered out of them, whereas a model, a style and a threshold are how the room is
    // CONFIGURED to answer and the opener's are the only ones a room without a verified writer has. It
    // does mean a stranger's turn runs on the opener's model and bill — the same bill that room already
    // ran on before they wrote. Settings are not permissions: nothing here grants anyone anything.
    //
    // Resolved ONCE, here, and spawn-fixed — for two different reasons, which are not interchangeable:
    //  · The model route (chat + compaction model) and the system prompt (advisor style, account
    //    instructions, per-user prompt overrides) are FORCED. They are inputs the session is built from,
    //    so re-resolving them per turn means disposing and rehydrating the room's whole transcript, a
    //    full prompt-cache re-warm, and breaking the coupling between a transcript and the model that
    //    produced it.
    //  · The auto-compact threshold is a CHOICE. It is not forced: BrainService.applyAutoCompactSettings
    //    already changes it on a running session in place, with no respawn at all, so it could be
    //    re-resolved per writer per turn for free. It is fixed here because compaction rewrites the
    //    SHARED transcript and its effect outlives the turn whose writer triggered it, so the budget
    //    belongs to the session, not to one sender — and `live.settingsUserId` is the single identity
    //    that in-place re-apply matches on, which a per-turn threshold would leave naming something
    //    untrue.
    // An explicit `/model` for the room still wins over all of this, and the room re-reads the current
    // writer's settings on every respawn (rollover, model switch, eviction, restart).
    const settingsUserId = opts.settingsUserId ?? ownerUserId;
    // The writer's per-user compaction-model choice (Account → Auto-compact). Empty → PI compacts on the
    // session model (or the provider's stable default). Validated at save time; resolved defensively here
    // so a since-revoked/removed pick never blocks the session.
    const settings = this.d.userSettings?.(settingsUserId);
    const compactSel = settings?.compactModel && settings.compactModelProvider
      ? { provider: settings.compactModelProvider, model: settings.compactModel }
      : undefined;
    // The writer's per-user chat-model choice fills in only when NO explicit selection is in play: an
    // empty selection would otherwise resolve to cfg.providers[0].models[0] — the first model of the
    // first provider in LIST order, not anyone's default — which once dropped a session on an
    // image-only model that cannot hold a conversation. Both parts must be set together: model ids are
    // not globally unique, so a bare model id could resolve under another provider's credentials.
    const storedSel = settings?.model && settings.modelProvider
      ? { provider: settings.modelProvider, model: settings.model }
      : undefined;
    // A STORED preference is a fallback, not an instruction for this run. When the model it names no longer
    // exists here — its provider was removed, or the provider survives but no longer lists that model — the
    // session must still open, on the instance default, instead of refusing to start. Same rule the
    // compaction pick above follows, and the reason editing Settings → Brain cannot lock anyone out of
    // their own conversation. An EXPLICIT `opts.selection` keeps the opposite treatment:
    // resolveBrainModelRoute refuses to substitute a provider someone actually named.
    //
    // Judged by the shared bound, not a local provider-id scan: a provider carrying a manual model list is
    // an allow-list, so a stale MODEL on a live provider is as gone as a stale provider — and a custom
    // endpoint would otherwise register that stale id ad hoc and quietly run it.
    //
    // Dropping it is never silent, and the stored row is deliberately left untouched: a model removed by
    // mistake (or re-added later) restores the account's own choice, whereas rewriting the row here would
    // spend the user's configuration on what may be a temporary state.
    const chatSel = storedSel && !isOfferableBrainModel(storedSel.provider, storedSel.model, cfg.providers)
      ? undefined
      : storedSel;
    if (storedSel && !chatSel) {
      logger('brain').warn(`account ${ownerUserId}: model preference ${storedSel.provider}/${storedSel.model} is no longer configured in Settings → Brain — starting this session on the default instead`);
    }
    const selection = opts.selection.provider || opts.selection.model ? opts.selection : chatSel;
    const route = resolveBrainModelRoute(registry, cfg, selection, compactSel);
    const { model } = route;
    // Per-model auto-compact threshold: the user's override for THIS model (keyed providerId/model) wins
    // over their global percentage, which in turn wins over the built-in default. Both halves are read
    // from the SAME settings id — resolving the global percentage at a call site (as every spawn caller
    // used to) is how a room ended up compacting at the opener's threshold with the writer's per-model
    // override layered on top of it. Each model's own contextWindow then turns the percentage into the
    // right absolute reserve down in the factory.
    const autoCompactAtPct = resolveAutoCompactPct(
      settings?.autoCompactAtByModel, route.providerId, model.id, settings?.autoCompactAt ?? DEFAULT_AUTO_COMPACT_PCT,
    );
    const capabilities = modelCapabilities(model);
    // Route capabilities consume the configured entry + exact wire model. Credential provenance alone is
    // never enough: a compatible relay must not inherit an upstream-only Fast field.
    const providerEntry = cfg.providers.find((provider) => provider.id === route.providerId);
    if (!providerEntry) throw new Error(`brain provider '${route.providerId}' is not configured`);
    const fastRoute = resolveFastModeRoute(providerEntry, model);
    const hostedRoute = resolveHostedToolSearchRoute(providerEntry, model, {
      toolDeferralEnabled: runtime?.toolDeferralEnabled ?? false,
      hostedToolSearch: runtime?.hostedToolSearch ?? {},
    });
    const hostedToolSearch = hostedRoute?.provider;
    const providerHostedToolSearch = hostedRoute !== undefined;
    // Temperature is the provider entry's own setting, read from the same route that chose the model, and
    // absent unless the operator set one — see ProviderRequestProfile on why absent must stay the default.
    const requestProfile = {
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
    const cwd = opts.pathView?.root
      ?? turnWorkDir(opts.policy, opts.clientCwd, this.d.projectPath) ?? this.d.cwd ?? process.cwd();
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
    // Tools and skills use the SAME resolver every surface resolves through, so what a session is composed
    // from and what a turn is authorised for cannot be two different answers. A SHARED room has no
    // session-wide owner (its writer changes turn to turn) and composes the instance set here; the writer's
    // own skills reach it per turn instead — see resolvesContributionsPerTurn below. A delegated child names the
    // writer of the turn that spawned it, which its caller read off the parent's live record.
    const contributionOwnerUserId = contributionOwnerForSession(sessionId, ownerUserId, {
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
      direct: opts.direct === true,
      ...(opts.contributionUserId != null ? { writerUserId: opts.contributionUserId } : {}),
    });
    const contributionOwnerUser = contributionOwnerUserId == null ? null : this.d.users.get(contributionOwnerUserId);
    // A platform session (Discord/Teams/WhatsApp/Telegram/cron) has no single account behind it, so it
    // cannot be composed against anyone's grants -- that is why a grant-gated tool like the shell was
    // absent there for everyone, the cron job's own admin owner included. Compose it and let the
    // execute-time gate refuse it per SENDER, which is what the line below already claims happens.
    //
    // A SHARED room additionally composes EVERY account's owner-scoped tools, because PI's registry is
    // fixed for the life of a session: this is the only moment a room can carry a colleague's personal
    // MCP server at all, and composing one writer's would serve it to whoever writes next. Which of them
    // the turn may SEE and CALL is decided per turn from `personalToolOwners` below, so nothing here is a
    // widening — before it, a room simply had none of them and nothing said why.
    const perTurnContributions = resolvesContributionsPerTurn(sessionId, opts.direct === true);
    const rawPluginTools = plugins?.toolsFor(contributionOwnerUserId, contributionOwnerUser, {
      grantsEnforcedPerTurn: opts.channel === true,
      allOwners: perTurnContributions,
    }) ?? [];
    const pluginTools = opts.pathView
      ? rawPluginTools
          .filter((tool) => !plugins?.hostFilesystemTools.has(tool.name)
            && plugins?.workspaceSafeTools.has(tool.name) === true
            && !plugins.workspaceUnsafeTools.has(tool.name))
          .map(workspaceToolDefinition)
          .filter((tool): tool is NonNullable<typeof tool> => !!tool)
      : rawPluginTools;
    const personalToolOwners = perTurnContributions
      ? plugins?.sharedRoomToolOwners() ?? new Map<string, ReadonlySet<number>>()
      : undefined;
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
        toolSearchHandle = createToolSearchHandle(deferred, undefined, personalToolOwners);
        return [toolSearchTool(toolSearchHandle)];
      },
      // Sharing needs a PERSON on the other end, and a sub-agent has none: whatever it shares lands in
      // that sub-agent's own panel, never in the conversation that delegated the work, so the tool could
      // not do what a model reaching for it intends. Withholding it also closes an escalation path — a
      // delegated child can hold all-access while a narrow `tools` allow-list keeps Read out of its set,
      // because an allow-list narrows only PLUGIN tools and these are built-ins (capabilities.ts:322-330),
      // so that child could publish any file on the host. The tools keep their own all-access guard too;
      // this is the half that removes the capability rather than refusing it.
      //
      // They also need somewhere to keep the bytes; an in-memory store has none, and the tool says so
      // rather than silently doing nothing.
      shareImage: isSubagentSession(sessionId) ? undefined : () => [
        buildShareImageTool({ store: this.d.store, imagesDir: this.d.chatImagesDir }),
        buildShareFileTool({ imagesDir: this.d.chatImagesDir }),
      ],
      pluginTools,
      // …and, in a room, which of them belong to ONE account. Absent everywhere else, where the whole
      // composed set already belongs to whoever the session was composed for.
      ...(personalToolOwners ? { personalToolOwners } : {}),
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
    // skill `/skill:` cannot expand, or hide one it still can. A cached announcement exists only in owner
    // chat; every platform/delegated turn renders under its live effective ToolPolicy in channels.ts.
    const staticSkillToolPolicy = contributionOwnerUserId == null
      ? { allow: new Set<string>() }
      : this.d.toolAuthorityFor(contributionOwnerUserId);
    const staticSkillLoadVisible = opts.channel !== true
      && plugins?.toolOwner.get('SkillLoad') === 'skills'
      && allTools.some((tool) => tool.name === 'SkillLoad')
      && toolPermitted('SkillLoad', staticSkillToolPolicy);
    const skills = plugins?.skillsFor(contributionOwnerUserId, contributionOwnerUser) ?? [];
    // Plugin prompt-command macros → PI PromptTemplate[]: PI exposes them as `/name` slash commands and
    // expands their arguments natively in prompt()/steer()/followUp(). Every surface just sends the raw
    // slash. All registered commands go in (surface filtering is only a menu concern, not expansion).
    const promptTemplates = buildPromptTemplates(plugins?.commands.values() ?? []);
    const fragments = plugins?.promptFragments ?? [];
    // The composing account's global instructions layer AFTER the persona as a separate appended chunk,
    // never the per-turn context (they are stable system-prompt material, so putting them per-turn would
    // waste the prompt cache). Undefined when empty → NOTHING appended, preserving the byte-identical
    // default prefix. XML escaping makes the account-data boundary explicit even when the text contains
    // tag-like markup.
    //
    // Keyed on settingsUserId, like every other personal preference above: these are Account → user
    // instructions, a STRONGER statement of how somebody wants to be answered than the advisor style
    // that lands in the very same prompt. Reading them off the room's opener rendered the writer's style
    // beside the opener's private instructions — and leaked one person's standing orders into a room they
    // merely opened.
    const rawUserInstructions = this.d.activeUserInstructions?.(settingsUserId);
    const userInstructionsAppend = rawUserInstructions ? userInstructionsBlock(rawUserInstructions) : undefined;
    // Skills awareness block (progressive disclosure): PI would render `<available_skills>` itself, but
    // ONLY when a tool literally named `read` is active (system-prompt.js) — our tools are `Read`
    // etc., so PI never renders it. We therefore append it ourselves so the model learns which skills
    // exist; `skills` still flows to the factory's `skillsOverride` so PI expands `/skill:name` natively.
    // `formatSkillsForPrompt` already drops disable-model-invocation skills, so the toggle is honoured.
    //
    // Every platform or delegated session omits it here and renders under the live turn policy in
    // ChannelSessionService. Shared rooms need the writer-specific catalog; a direct chat or child has one
    // contribution owner but may still carry a narrower allow/deny boundary than its composed tool superset.
    // Owner chat alone has one sender and a stable account policy, so it keeps the cheap cached block.
    const skillsBlock = !opts.pathView && staticSkillLoadVisible && skills.length && !perTurnContributions
      ? formatSkillsForPrompt(skills)
      : '';
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
    //
    // The DEFERRED block is not owner-chat-only (a room's model still needs to know what it can fetch), so
    // it carries the one narrowing that cannot wait for a turn: a personal tool is dropped from it. This
    // block is appended to the CACHED system prompt, which no per-turn pass rewrites — so a name left in it
    // is announced to every writer in the room forever, and in a room the name of somebody's personal MCP
    // server is itself private. What remains is the instance-wide set, which belongs to everybody.
    const deferredCandidates = personalToolOwners
      ? allTools.filter((tool) => !personalToolOwners.has(tool.name))
      : allTools;
    const deferredBlock = toolSearchHandle
      ? formatDeferredToolsBlock(deferredCandidates, toolSearchHandle.deferred)
      : providerHostedToolSearch
        ? formatHostedToolCatalogBlock(allTools, plugins?.toolOwner ?? new Map<string, string>(), sessionKind)
        : '';
    const append = [skillsBlock, deferredBlock, ...fragments, ...(opts.extraAppend ?? []), userInstructionsAppend ?? ''].filter((s) => s.length > 0);

    // Elowen identity: the editable `elowen` prompt (per-user override aware) becomes the system prompt,
    // so the brain knows it is Elowen — not the underlying model's default persona.
    //
    // The USER RECORD stays the owner's on purpose, and is the one thing here that does: `userName` is who
    // the instance belongs to (the platform overlay says so in as many words), not a preference of the
    // person writing, and `is_admin` below gates whether project instruction files may be read at all —
    // a security decision that must never follow a room's current writer.
    const u = this.d.users.get(ownerUserId);
    const userName = u?.name || u?.username || 'Filip';
    const personality = personalityText(settings?.advisorStyle ?? '');
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
    //
    // The per-user prompt OVERRIDE is a personal preference like the advisor style rendered into it, so it
    // reads from the same composing account — otherwise a room would render the writer's style through the
    // opener's edited template, one line away from the style itself.
    const persona = opts.scheduled
      ? this.d.prompts.render('scheduled', { userName, personality, agentName }, settingsUserId)
      : opts.channel
        ? this.d.prompts.render('elowen', { userName, personality, agentName, productName }, settingsUserId)
          + '\n\n' + this.d.prompts.render('elowen-platform', { ownerName: userName, agentName, productName }, settingsUserId)
        : this.d.prompts.render('elowen', { userName, personality, agentName, productName }, settingsUserId);

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
    const recallUserId = (): number | null => liveRecallUserId(sessionId, ownerUserId, live.turnWriterUserId);
    // Fast follows the account driving THIS request. An ordinary shared/direct channel without a verified
    // writer fails closed instead of borrowing the room owner's preference. A delegated child has no writer
    // of its own, so it uses the contribution account captured as settingsUserId and re-reads that account in
    // both in-process and runner execution.
    const fastUserId = (): number | null => opts.channel
      ? opts.parentSessionId ? settingsUserId : live.turnWriterUserId ?? null
      : settingsUserId;
    const fastEnabled = (): boolean => {
      const userId = fastUserId();
      return userId !== null && this.d.fastMode?.(userId) === true;
    };
    const fastRouteFor = (requestModel: Model<Api>) => {
      const entry = cfg.providers.find((provider) => registryProviderName(provider) === requestModel.provider);
      return entry ? resolveFastModeRoute(entry, requestModel) : undefined;
    };
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
      ...(opts.pathView ? { displayCwd: '.', contextRoot: opts.pathView.root, sanitizePaths: opts.pathView.sanitize } : {}),
      systemPrompt: persona, appendSystemPrompt: append,
      // Skill bodies are expanded by the live input extension below. Feeding PI this session-start snapshot
      // would let `/skill:name` survive a later grant revocation even though SkillLoad and the prompt catalog
      // already follow the live authority.
      skills: [], promptTemplates,
      ...(plugins ? {
        skillCommandExtension: liveSkillCommandExtension({ plugins: async () => plugins, users: this.d.users }),
      } : {}),
      tools: allTools, toolSearch: toolSearchHandle, hostedToolSearch,
      thinkingLevel: opts.thinkingLevel, requestProfile,
      fastMode: { enabled: fastEnabled, routeFor: fastRouteFor },
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
          sessionId,
          // Lazily created on the live session and shared with turn-start recall, so the two paths
          // cannot deliver the same memory twice into one context window.
          alreadyInContext: () => (live.injectedMemoryIds ??= new Set<number>()),
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
          onInjected: (ids, recall) => {
            const userId = recallUserId();
            if (userId !== null) memService.markRecalled(userId, ids, recall);
          },
        },
      } : {}),
      // Project AGENTS.md/CLAUDE.md ride the system prompt for an ADMIN's own chat only. Two guards,
      // both required: (1) not a shared channel (foreign senders must never see instruction files);
      // (2) admin owner — a non-admin account with no repo of its own resolves cwd to the daemon's
      // project path, and PI walks it plus every ancestor up to `/`, so a plain user's chat would
      // otherwise inhale the operator's private CLAUDE.md (internal hosts, prod credentials).
      contextFiles: opts.pathView ? true : !opts.channel && !!u?.is_admin,
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
      chatImagesDir: this.d.chatImagesDir,
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
      return {
        beforeUser: renderTurnContextFrame(beforeUser, 'before-user'),
        afterUser: renderTurnContextFrame(afterUser, 'after-user'),
      };
    };
    live = {
      session, sessionId, ownerUserId, settingsUserId, contributionUserId: contributionOwnerUserId,
      direct: opts.direct === true,
      model: model.id, providerId, provider: model.provider, thinkingLevel: opts.thinkingLevel,
      requestProfile, fastAvailable: fastRoute !== undefined,
      thinkingLabels: Object.fromEntries(capabilities.levels.map((level) => [level, capabilities.labels[level] ?? level])),
      policy: opts.policy, applyCompaction, assessColdCompaction, listeners, replay, turnContext,
      pluginToolNames: new Set(pluginTools.map((t) => t.name)),
      // Carried so each turn's visibility pass can hide the tools that belong to somebody else in the room
      // — the same map the execute gate above was built from, never a second copy of the ownership rule.
      ...(personalToolOwners ? { personalToolOwners } : {}),
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
