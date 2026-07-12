import { createAgentSession, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ExtensionAPI, PromptTemplate, ResourceLoader, Skill, ToolDefinition, ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { BrainStore } from '../../store/brainStore.js';
import { createSessionPersistenceProjector, rehydrate } from '../persistence.js';
import { applyProviderRequestProfile, isCanonicalThinkingLevel, type ProviderRequestProfile } from '../modelCapabilities.js';
import type { DelegatedExecutionScope } from '../delegatedScope.js';
import { createCodexCompactionModelRoute, type CodexCompactionModelRoute } from './codexCompaction.js';

/** Everything one PI brain session needs, composed by the caller: the chat brain renders the Elowen
 *  persona and gates elowen_* tools by session kind; the task worker bakes in its close tool and the
 *  worker-brain prompt. The factory only assembles. */
export interface SessionSpec {
  sessionId: string;
  /** The Elowen user the store row belongs to (0 for ownerless task sessions). */
  ownerUserId: number;
  /** Parent conversation for delegated sessions; persisted for usage/navigation. */
  parentSessionId?: string;
  /** Immutable access boundary for a delegated child; verified on every respawn. */
  delegatedAccess?: DelegatedExecutionScope;
  registry: ModelRegistry;
  model: Model<Api>;
  /** Same-provider configured default used deterministically for PI-owned Codex compaction requests. */
  compactionFallbackModel?: Model<Api>;
  cwd: string;
  systemPrompt: string;
  /** Chunks appended after the system prompt (plugin fragments, role prompts). */
  appendSystemPrompt: string[];
  /** Plugin skills fed to PI's native path via the resource loader's `skillsOverride` — PI renders the
   *  progressive-disclosure block in the system prompt AND expands `/skill:name` in prompt/steer/followUp
   *  on its own, so we never format a skills block ourselves. */
  skills: Skill[];
  /** Plugin prompt-command macros fed to PI's native path via the resource loader's `promptsOverride`.
   *  PI exposes each as a `/name` slash command and expands its arguments in prompt()/steer()/followUp()
   *  on its own — the daemon never substitutes. Only the interactive chat spawner populates these; task
   *  workers (no user typing slashes) leave it empty. */
  promptTemplates?: PromptTemplate[];
  tools: ToolDefinition[];
  /** Reasoning effort for extended-thinking models (empty/undefined = the model default). */
  thinkingLevel?: string;
  /** Mutable provider switches (currently ChatGPT OAuth Fast) read before every request. */
  requestProfile?: ProviderRequestProfile;
  /** PI's built-in auto-compaction: on/off. When on, PI summarizes the context on its own once it fills
   *  past `autoCompactAtPct` — no separate trigger in our turn loop. */
  autoCompact: boolean;
  /** Context-window fill percentage (30–95) at which PI auto-compacts. Translated to PI's absolute
   *  `reserveTokens` = round(contextWindow · (1 − pct/100)) — `shouldCompact` fires when the context
   *  exceeds `contextWindow − reserveTokens`, i.e. once the window is `pct`% full. */
  autoCompactAtPct: number;
  /** Load the project's AGENTS.md/CLAUDE.md into the system prompt (PI walks `cwd` and its ancestors).
   *  OWNER-CHAT ONLY: shared channels and task workers must leave this off — the ancestor walk would
   *  pull internal instruction files into a prompt foreign senders talk to. */
  contextFiles?: boolean;
  /** Session title to set when the stored row has none yet (task sessions name themselves). */
  title?: string;
}

export interface SessionFactoryDeps {
  store: BrainStore;
  /** Injected for tests; defaults to PI's createAgentSession. */
  createSession?: typeof createAgentSession;
  /** Injected for tests; builds the resource loader that carries the system prompt. A test passes
   *  `() => undefined` so no disk-touching loader is constructed. */
  resourceLoaderFactory?: (o: BrainResourceLoaderOptions) => ResourceLoader | undefined;
}

/** Shared construction seam used by chat and embedded task-worker tests. Keeping this shape beside the
 * factory prevents either caller from silently dropping new session-level routing inputs. */
export interface BrainResourceLoaderOptions {
  cwd: string;
  systemPrompt: string;
  appendSystemPrompt?: string[];
  skills?: Skill[];
  prompts?: PromptTemplate[];
  contextFiles?: boolean;
  codexReasoningFix?: boolean;
  /** Marker hook for PI-owned compaction requests. The actual stream route is installed on AgentSession. */
  compactionModelRouteExtension?: CodexCompactionModelRoute['extension'];
  requestProfile?: ProviderRequestProfile;
  settingsManager: SettingsManager;
}

/** PI uses the same reserve both as the proactive threshold and as the summary-output budget during
 * overflow recovery. A zero reserve therefore cannot mean "overflow only": it produces a zero-token
 * summary and makes the recovery fail. Keep disabled proactive compaction at a small emergency margin
 * (5% of context, capped at 4k) so it triggers only at the cliff but still has room to summarize. */
export function compactionReserveTokens(contextWindow: number, proactive: boolean, atPercent: number): number {
  if (proactive) return Math.max(2, Math.round(contextWindow * (1 - atPercent / 100)));
  return Math.max(256, Math.min(4_096, Math.round(contextWindow * 0.05)));
}

/** The ChatGPT (Codex) backend returns reasoning-summary text ONLY for `reasoning.summary:"concise"`
 *  — with pi's default "auto" (and even "detailed") the reasoning item comes back EMPTY, so the UI
 *  never sees the model's thinking. Verified empirically against gpt-5.5 (auto/detailed → 0 summary
 *  chars, concise → text). pi offers no per-session summary option, so an inline extension patches the
 *  outgoing payload; registered only for openai-codex sessions (the official API honors "auto"). */
function codexReasoningSummary(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event) => {
    const payload = event.payload as { reasoning?: Record<string, unknown> } | null | undefined;
    if (!payload?.reasoning || typeof payload.reasoning !== 'object') return undefined;
    return { ...payload, reasoning: { ...payload.reasoning, summary: 'concise' } };
  });
}

/** ChatGPT OAuth Fast mode is OpenAI's priority service tier. The state object is deliberately mutable:
 *  `/fast` changes it live and this hook reads the newest value on every model round-trip. */
function codexRequestProfile(profile: ProviderRequestProfile): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      if (!profile.fast) return undefined;
      const payload = event.payload as Record<string, unknown> | null | undefined;
      return payload ? applyProviderRequestProfile(payload, profile) : undefined;
    });
  };
}

/** Default resource loader: carries the composed system prompt, appends the extra chunks after it,
 *  and disables most disk discovery — the brain is a lean, in-process agent. `noExtensions` skips only
 *  DISCOVERED extensions; the inline factories below still load. Context files are OWNER-ONLY opt-in
 *  (`contextFiles`): PI reads the project's AGENTS.md/CLAUDE.md from `cwd` AND ITS ANCESTORS and renders
 *  them as `<project_instructions path="…">`. That ancestor walk makes it a leak vector on shared
 *  surfaces — a channel session whose cwd falls back to the daemon's project path would inhale internal
 *  instruction files into a prompt foreign senders talk to — so channels and task workers keep it off.
 *  It sits in a separate prompt block from the Elowen persona/appends, so there is no duplication. */
function defaultResourceLoaderFactory(o: BrainResourceLoaderOptions): ResourceLoader {
  const skills = o.skills ?? [];
  const prompts = o.prompts ?? [];
  return new DefaultResourceLoader({
    cwd: o.cwd, agentDir: o.cwd, systemPrompt: o.systemPrompt, appendSystemPrompt: o.appendSystemPrompt,
    settingsManager: o.settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: !o.contextFiles,
    // `noSkills` disables disk discovery; the override feeds PI our in-memory plugin skills instead. PI
    // then renders the progressive-disclosure block into the system prompt and expands `/skill:name`
    // itself — no manual skills block, no custom read tool.
    skillsOverride: () => ({ skills, diagnostics: [] }),
    // Same pattern for prompt-command macros: `noPromptTemplates` disables the disk scan; this override
    // feeds PI our in-memory plugin templates, which it exposes as `/name` slash commands and expands
    // ($1/$@/$ARGUMENTS/${N:-default}) itself in prompt()/steer()/followUp() — no daemon-side expansion.
    promptsOverride: () => ({ prompts, diagnostics: [] }),
    ...(o.codexReasoningFix || o.compactionModelRouteExtension || o.requestProfile ? {
      extensionFactories: [
        ...(o.codexReasoningFix ? [codexReasoningSummary] : []),
        ...(o.compactionModelRouteExtension ? [o.compactionModelRouteExtension] : []),
        ...(o.requestProfile ? [codexRequestProfile(o.requestProfile)] : []),
      ],
    } : {}),
  });
}

/** The shared session assembly behind both the chat brain (`spawnLive`) and the elowen-exec task
 *  workers: store row → history rehydration → resource loader → PI session → persistence
 *  subscription. One implementation, so the reload gotcha below can never drift out of sync. */
export class BrainSessionFactory {
  constructor(private d: SessionFactoryDeps) {}

  async create(spec: SessionSpec): Promise<{ session: AgentSession }> {
    // Ensure the store row (sole source of truth) exists before rehydration.
    const existing = this.d.store.getSession(spec.sessionId);
    if (!existing) {
      this.d.store.createSession({
        id: spec.sessionId, userId: spec.ownerUserId, model: spec.model.id,
        parentSessionId: spec.parentSessionId, delegatedAccess: spec.delegatedAccess,
      });
    } else {
      // A durable delegated child never accepts a replacement scope after its first spawn. In
      // particular, a legacy/corrupt child with no scope cannot be upgraded by an owner continuation.
      if (spec.parentSessionId) {
        if (existing.parent_session_id !== spec.parentSessionId
          || !spec.delegatedAccess
          || !this.d.store.hasDelegatedAccess(spec.sessionId, spec.delegatedAccess)) {
          throw new Error('delegated access unavailable');
        }
      } else if (spec.delegatedAccess) {
        throw new Error('delegated access requires a parent session');
      }
      this.d.store.touchSession(spec.sessionId, spec.model.id);
    }
    if (spec.title && !this.d.store.getSession(spec.sessionId)?.title) {
      this.d.store.setTitle(spec.sessionId, spec.title.slice(0, 60));
    }

    const sessionManager = rehydrate(this.d.store, spec.sessionId, spec.cwd);
    // Each session owns its own IN-MEMORY SettingsManager so its compaction threshold is per-conversation
    // (the owner's per-user %, the channel default) — shared by createAgentSession (which reads compaction
    // at check time) and the resource loader. It MUST be in-memory, never file-backed: SettingsManager.create
    // would read the user's project `.pi/settings.json` from cwd (letting a checked-in file override Elowen's
    // per-user config) and a PI-side write (e.g. /reasoning → setDefaultThinkingLevel) would persist a
    // settings.json INTO the working repo. inMemory reads nothing from disk and writes nowhere; only the
    // compaction override below (and any session-local PI setting) lives here, dying with the session.
    // `projectTrusted` lets those session-local writes land in the in-memory store instead of erroring.
    const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: true });
    const compactionModelRoute = createCodexCompactionModelRoute(spec.compactionFallbackModel);
    const resourceLoader = (this.d.resourceLoaderFactory ?? defaultResourceLoaderFactory)({
      cwd: spec.cwd, systemPrompt: spec.systemPrompt, appendSystemPrompt: spec.appendSystemPrompt,
      skills: spec.skills, prompts: spec.promptTemplates, contextFiles: spec.contextFiles,
      codexReasoningFix: spec.model.provider === 'openai-codex',
      compactionModelRouteExtension: compactionModelRoute?.extension,
      requestProfile: spec.requestProfile, settingsManager,
    });
    // A resource loader passed to createAgentSession is NOT auto-reloaded (only one it builds itself
    // is), so its system prompt stays empty unless we reload it here. Without this the brain falls
    // back to pi's default "coding assistant" persona and misidentifies itself.
    if (resourceLoader) await resourceLoader.reload();

    const create = this.d.createSession ?? createAgentSession;
    // Reasoning effort for extended-thinking models — PI clamps an unsupported level to the model's
    // range, so passing it for a non-thinking model is harmless. Empty → leave the model default.
    const thinkingLevel = spec.thinkingLevel && isCanonicalThinkingLevel(spec.thinkingLevel) ? spec.thinkingLevel : undefined;
    const { session } = await create({
      cwd: spec.cwd,
      sessionManager,
      modelRegistry: spec.registry,
      model: spec.model,
      resourceLoader,
      settingsManager,
      customTools: spec.tools,
      tools: spec.tools.map((t) => t.name),
      noTools: 'builtin',
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    // Install after PI has built the Agent so the wrapper delegates to the exact SDK-native stream
    // pipeline created for this session. The extension above has already been loaded and only marks
    // PI's own compaction signal; it never executes or returns a custom compaction.
    compactionModelRoute?.install(session);
    // Compaction is PI-native: our per-user % maps to PI's absolute reserveTokens (shouldCompact fires
    // once contextTokens > contextWindow − reserveTokens). Applied AFTER create — createAgentSession reads
    // compaction lazily (getCompactionSettings at each check), so an in-memory override here takes effect;
    // the loader's earlier reload() only rebuilds the system prompt and never touches settings.
    //
    // We keep compaction `enabled` ALWAYS on, because PI's `_checkCompaction` gates BOTH the threshold
    // pass AND context-overflow recovery behind `enabled` — turning it off would leave an overflowing
    // conversation hard-erroring on every turn until a manual /compact. "Proactive off" therefore uses
    // only the small emergency reserve described above, rather than PI's normal early threshold.
    const reserveTokens = compactionReserveTokens(spec.model.contextWindow, spec.autoCompact, spec.autoCompactAtPct);
    settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens } });

    // Persist settled turns (agent_end) AND every PI compaction (auto at the threshold, manual /compact,
    // overflow recovery) — PI shrinks the live context but writes NOTHING to the store, so without this
    // the token savings evaporate on the next rehydrate. Only a REAL compaction (result present, not
    // aborted) mirrors; a no-op/failed run leaves the store untouched. Callers layer their own
    // subscriptions on top (the `compacted` client-notify in the chat brain, liveness in the worker).
    session.subscribe(createSessionPersistenceProjector(
      this.d.store, session, spec.sessionId, spec.model.contextWindow,
    ));
    return { session };
  }
}
