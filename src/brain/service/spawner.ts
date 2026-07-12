import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { isRetryableAssistantError } from '@earendil-works/pi-ai';
import type { PluginRegistry } from '../../plugins/registry.js';
import { PluginHookBus } from '../../plugins/hookBus.js';
import { logger } from '../../shared/logger.js';
import type { BrainRuntimeConfig } from '../providers.js';
import { buildBrainRegistry, resolveBrainModelRoute } from '../providers.js';
import { buildElowenTools, buildMemoryTools, BUILTIN_TOOL_ICONS } from '../tools/index.js';
import { makeToolIconResolver } from '../toolIcons.js';
import { composeSessionTools } from '../session/capabilities.js';
import { buildPromptTemplates } from '../slashCommands.js';
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { personalityText } from '../personality.js';
import type { BrainSessionFactory } from '../session/factory.js';
import type { LiveBrain, SpawnOpts, QueuedMsg } from '../session/liveBrain.js';
import { reconcileMirrors } from '../session/queueMirror.js';
import { isErroredContextOverflow, toBrainEvent, usageOf, withDescendantUsage } from '../events.js';
import type { BrainEvent } from '../events.js';
import type { BrainDeps } from '../brainDeps.js';
import { turnWorkDir } from './workDir.js';
import { modelCapabilities } from '../modelCapabilities.js';
import { LiveEventReplay } from '../session/liveEventReplay.js';

/** PI already classifies and retries transient provider failures. Reuse that same classifier after its
 * retry budget is exhausted so the final transcript never leaks a provider-specific transport or stream
 * error that PI itself treated as temporary. */
function publicProviderError(message: string, sessionId: string, provider: string, model: string): string {
  if (!isRetryableAssistantError({ role: 'assistant', stopReason: 'error', errorMessage: message } as never)) return message;
  logger('brain-provider').warn(`provider retries exhausted for ${provider}/${model} (${sessionId})`);
  return 'Provider request failed after automatic retries. Please retry the turn.';
}

interface SpawnerDeps {
  /** See the BrainDeps fields of the same names — the spawner receives the subset it composes from. */
  config: BrainDeps['config'];
  store: BrainDeps['store'];
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
    const route = resolveBrainModelRoute(registry, cfg, opts.selection);
    const { model } = route;
    const capabilities = modelCapabilities(model);
    const requestProfile = { fast: capabilities.fast && opts.fast === true };
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
    // elowen_* control-plane tools or owner API token) lives in composeSessionTools; the token is minted
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
    // The user's active personality profile (owner's per-platform pin) layers AFTER the persona as a
    // separate appended chunk — never the per-turn context (personality is stable system-prompt material,
    // so putting it per-turn would waste the prompt cache). Undefined when no enabled profile is pinned →
    // NOTHING appended, so the systemPrompt prefix stays byte-identical for users without one.
    const persoAppend = this.d.activePersonality?.(ownerUserId, opts.platform ?? 'web');
    // Skills awareness block (progressive disclosure): PI would render `<available_skills>` itself, but
    // ONLY when a tool literally named `read` is active (system-prompt.js) — our tools are `read_file`
    // etc., so PI never renders it. We therefore append it ourselves so the model learns which skills
    // exist; `skills` still flows to the factory's `skillsOverride` so PI expands `/skill:name` natively.
    // `formatSkillsForPrompt` already drops disable-model-invocation skills, so the toggle is honoured.
    const skillsBlock = skills.length ? formatSkillsForPrompt(skills) : '';
    const append = [skillsBlock, ...fragments, ...(opts.extraAppend ?? []), persoAppend ?? ''].filter((s) => s.length > 0);

    // Elowen identity: the editable `advisor` prompt (per-user override aware) becomes the system prompt,
    // so the brain knows it is Elowen — not the underlying model's default persona.
    const u = this.d.users.get(ownerUserId);
    const userName = u?.name || u?.username || 'Filip';
    const personality = personalityText(this.d.userSettings?.(ownerUserId)?.advisorStyle ?? '');
    const agentName = this.d.agentName?.() || 'Elowen';
    // Shared platform channels get their own persona: the senders are OTHER people, so the owner's
    // "personal advisor" prompt (owner-name identity, terminal/control-plane framing) would misaddress
    // everyone in the room. The channel prompt keeps the agent identity and speaks to bracketed senders.
    const persona = opts.channel
      ? this.d.prompts.render('advisor-channel', { ownerName: userName, personality, agentName }, ownerUserId)
      : this.d.prompts.render('advisor', { userName, personality, agentName }, ownerUserId);

    const { session } = await this.d.factory.create({
      sessionId, ownerUserId, parentSessionId: opts.parentSessionId, delegatedAccess: opts.delegatedAccess,
      registry, model, compactionFallbackModel: route.compactionFallback, cwd,
      systemPrompt: persona, appendSystemPrompt: append, skills, promptTemplates,
      tools: allTools, thinkingLevel: opts.thinkingLevel, requestProfile,
      autoCompact: opts.autoCompact, autoCompactAtPct: opts.autoCompactAtPct,
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
    const queuedSteer: QueuedMsg[] = [];
    const queuedFollowUp: QueuedMsg[] = [];
    // PI decides overflow compact-and-retry only after emitting the errored agent_end. Hold that error
    // until compaction_end tells us whether recovery really failed; otherwise headless clients would
    // exit 1 while the same turn was already compacting and about to succeed.
    let deferredOverflowError: string | null = null;
    let terminalIdleDeferred = false;
    let steps = 0; // model round-trips in the current run — reset on agent_start, one per turn_start
    session.subscribe((e: AgentSessionEvent) => {
      const raw = (e as { type?: string }).type;
      let suppressAgentEndIdle = raw === 'agent_end' && (e as { willRetry?: boolean }).willRetry === true;
      let emitFailedRecoveryIdle = false;
      // Canonical fallback: PI can settle without a second agent_end when retry backoff is cancelled, or
      // without compaction_end when an overflow has nothing summarizable. Flush the deferred terminal
      // state here so no client remains spinning and a genuine overflow failure is still visible.
      if (raw === 'agent_settled') {
        if (deferredOverflowError) {
          replay.publish({ type: 'error', message: deferredOverflowError });
          deferredOverflowError = null;
          terminalIdleDeferred = true;
        }
        if (terminalIdleDeferred) {
          replay.publish({
            type: 'idle', model: model.id,
            usage: withDescendantUsage(usageOf(session), this.d.store.descendantUsage(sessionId)),
          });
          terminalIdleDeferred = false;
        }
        return;
      }
      // Step accounting + ceiling. Each run resets on agent_start; every turn_start is one step. The
      // limit is read fresh per turn (a config change applies without a session restart). Past the
      // ceiling the run is aborted so a wedged agent can't loop forever — it settles into agent_end/idle
      // like a normal stop. `maxSteps ≤ 0` means unlimited (no counter emitted, no enforcement).
      if (raw === 'agent_start') { replay.beginRun(); steps = 0; }
      else if (raw === 'turn_start') {
        steps += 1;
        const maxSteps = this.d.maxSteps?.() ?? 0;
        if (maxSteps > 0 && steps > maxSteps) void session.abort().catch(() => { /* already settling */ });
        else {
          const usage = withDescendantUsage(usageOf(session), this.d.store.descendantUsage(sessionId));
          replay.publish({ type: 'step', step: steps, maxSteps, usage });
        }
      }
      if (suppressAgentEndIdle) terminalIdleDeferred = true;
      // BrainSessionFactory subscribed before this spawner and persists `agent_end` synchronously. At
      // this exact boundary the journal is redundant with SQLite, so clear it before terminal events.
      if (raw === 'agent_end') replay.settleRun();
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
          const rawMessage = last.errorMessage?.trim() || 'the model returned no reply (provider error)';
          if (isErroredContextOverflow(last, model.contextWindow)) {
            deferredOverflowError = rawMessage;
            suppressAgentEndIdle = true;
          } else {
            const message = publicProviderError(rawMessage, sessionId, providerId ?? model.provider, model.id);
            replay.publish({ type: 'error', message });
          }
        }
      }
      // A PI compaction just settled (auto at the threshold, manual /compact, overflow recovery): the
      // factory's own subscription has already mirrored the shrunk context into the store (it runs FIRST,
      // subscribed during create()), so tell attached clients to refetch history and collapse. Only a REAL
      // compaction (result present, not aborted) — a no-op/failed run leaves the transcript as-is.
      if (raw === 'compaction_end' && (e as { result?: unknown }).result != null && (e as { aborted?: boolean }).aborted !== true) {
        replay.publish({ type: 'compacted' });
      }
      if (raw === 'compaction_end' && (e as { reason?: string }).reason === 'overflow') {
        const ce = e as { result?: unknown; aborted?: boolean; willRetry?: boolean; errorMessage?: string };
        const recovering = ce.result != null && ce.aborted !== true && ce.willRetry === true;
        if (recovering) deferredOverflowError = null;
        else if (deferredOverflowError) {
          replay.publish({ type: 'error', message: ce.errorMessage?.trim() || deferredOverflowError });
          deferredOverflowError = null;
          emitFailedRecoveryIdle = true;
        }
      }
      // Keep the image-carrying queue mirror aligned with PI's native queue on every enqueue/delivery/clear.
      if (raw === 'queue_update') {
        const qe = e as { steering?: readonly string[]; followUp?: readonly string[] };
        reconcileMirrors(queuedSteer, queuedFollowUp, qe.steering ?? [], qe.followUp ?? []);
      }
      const be = toBrainEvent(e);
      if (!be) return;
      // PI emits this intermediate agent_end before ordinary retry / overflow recovery. It is not a
      // terminal idle: headless must keep waiting and interactive clients must keep their spinner alive.
      if (suppressAgentEndIdle && be.type === 'idle') return;
      if (be.type === 'idle') {
        be.usage = withDescendantUsage(usageOf(session), this.d.store.descendantUsage(sessionId));
        be.model = model.id;
        terminalIdleDeferred = false;
      } // statusline data rides the idle event
      if (be.type === 'tool') be.icon = iconOf(be.name);
      replay.publish(be);
      if (emitFailedRecoveryIdle) {
        replay.publish({
          type: 'idle', model: model.id,
          usage: withDescendantUsage(usageOf(session), this.d.store.descendantUsage(sessionId)),
        });
        terminalIdleDeferred = false;
      }
    });

    // Ephemeral per-turn context (date/time, …) is injected into each user message — see send() — so it
    // stays fresh WITHOUT invalidating the cached system-prompt prefix.
    const providers = plugins?.turnContexts ?? [];
    const turnContext = (): string => {
      const parts = providers.map((f) => { try { return f(); } catch { return ''; } }).filter((x) => x && x.trim());
      return parts.length ? `<context>\n${parts.join('\n')}\n</context>\n\n` : '';
    };
    return {
      session, sessionId, model: model.id, providerId, thinkingLevel: opts.thinkingLevel,
      requestProfile, fastAvailable: capabilities.fast,
      thinkingLabels: Object.fromEntries(capabilities.levels.map((level) => [level, capabilities.labels[level] ?? level])),
      policy: opts.policy, listeners, replay, turnContext,
      pluginToolNames: new Set(pluginTools.map((t) => t.name)), workDir: cwd,
      queuedSteer, queuedFollowUp,
    };
  }
}
