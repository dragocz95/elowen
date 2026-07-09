import { createAgentSession, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, ExtensionAPI, PromptTemplate, ResourceLoader, Skill, ToolDefinition, ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { BrainStore } from '../../store/brainStore.js';
import { persistCompaction, projectEvent, rehydrate } from '../persistence.js';

/** Everything one PI brain session needs, composed by the caller: the chat brain renders the Elowen
 *  persona and gates elowen_* tools by session kind; the task worker bakes in its close tool and the
 *  worker-brain prompt. The factory only assembles. */
export interface SessionSpec {
  sessionId: string;
  /** The Elowen user the store row belongs to (0 for ownerless task sessions). */
  ownerUserId: number;
  registry: ModelRegistry;
  model: Model<Api>;
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
  resourceLoaderFactory?: (o: { cwd: string; systemPrompt: string; appendSystemPrompt?: string[]; skills?: Skill[]; prompts?: PromptTemplate[]; contextFiles?: boolean; codexReasoningFix?: boolean; settingsManager: SettingsManager }) => ResourceLoader | undefined;
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

/** Default resource loader: carries the composed system prompt, appends the extra chunks after it,
 *  and disables most disk discovery — the brain is a lean, in-process agent. `noExtensions` skips only
 *  DISCOVERED extensions; the inline factories below still load. Context files are OWNER-ONLY opt-in
 *  (`contextFiles`): PI reads the project's AGENTS.md/CLAUDE.md from `cwd` AND ITS ANCESTORS and renders
 *  them as `<project_instructions path="…">`. That ancestor walk makes it a leak vector on shared
 *  surfaces — a channel session whose cwd falls back to the daemon's project path would inhale internal
 *  instruction files into a prompt foreign senders talk to — so channels and task workers keep it off.
 *  It sits in a separate prompt block from the Elowen persona/appends, so there is no duplication. */
function defaultResourceLoaderFactory(o: { cwd: string; systemPrompt: string; appendSystemPrompt?: string[]; skills?: Skill[]; prompts?: PromptTemplate[]; contextFiles?: boolean; codexReasoningFix?: boolean; settingsManager: SettingsManager }): ResourceLoader {
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
    ...(o.codexReasoningFix ? { extensionFactories: [codexReasoningSummary] } : {}),
  });
}

/** The shared session assembly behind both the chat brain (`spawnLive`) and the elowen-exec task
 *  workers: store row → history rehydration → resource loader → PI session → persistence
 *  subscription. One implementation, so the reload gotcha below can never drift out of sync. */
export class BrainSessionFactory {
  constructor(private d: SessionFactoryDeps) {}

  async create(spec: SessionSpec): Promise<{ session: AgentSession }> {
    // Ensure the store row (sole source of truth) exists before rehydration.
    if (!this.d.store.getSession(spec.sessionId)) {
      this.d.store.createSession({ id: spec.sessionId, userId: spec.ownerUserId, model: spec.model.id });
    } else {
      this.d.store.touchSession(spec.sessionId, spec.model.id);
    }
    if (spec.title && !this.d.store.getSession(spec.sessionId)?.title) {
      this.d.store.setTitle(spec.sessionId, spec.title.slice(0, 60));
    }

    const sessionManager = rehydrate(this.d.store, spec.sessionId, spec.cwd);
    // Each session owns its own SettingsManager so its compaction threshold is per-conversation (the
    // owner's per-user %, the channel default) — shared by createAgentSession (which reads compaction at
    // check time) and the resource loader. Reads the user's project settings but is NEVER flushed, so the
    // applyOverrides below stays in-memory and never writes to their .pi/settings.json.
    const settingsManager = SettingsManager.create(spec.cwd, spec.cwd);
    const resourceLoader = (this.d.resourceLoaderFactory ?? defaultResourceLoaderFactory)({
      cwd: spec.cwd, systemPrompt: spec.systemPrompt, appendSystemPrompt: spec.appendSystemPrompt,
      skills: spec.skills, prompts: spec.promptTemplates, contextFiles: spec.contextFiles,
      codexReasoningFix: spec.model.provider === 'openai-codex', settingsManager,
    });
    // A resource loader passed to createAgentSession is NOT auto-reloaded (only one it builds itself
    // is), so its system prompt stays empty unless we reload it here. Without this the brain falls
    // back to pi's default "coding assistant" persona and misidentifies itself.
    if (resourceLoader) await resourceLoader.reload();

    const create = this.d.createSession ?? createAgentSession;
    // Reasoning effort for extended-thinking models — PI clamps an unsupported level to the model's
    // range, so passing it for a non-thinking model is harmless. Empty → leave the model default.
    const thinkingLevel = (['minimal', 'low', 'medium', 'high', 'xhigh'] as const).find((l) => l === spec.thinkingLevel);
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
    // Compaction is PI-native: our per-user % maps to PI's absolute reserveTokens (shouldCompact fires
    // once contextTokens > contextWindow − reserveTokens). Applied AFTER create — createAgentSession reads
    // compaction lazily (getCompactionSettings at each check), so an in-memory override here takes effect;
    // the loader's earlier reload() only rebuilds the system prompt and never touches settings.
    settingsManager.applyOverrides({
      compaction: { enabled: spec.autoCompact, reserveTokens: Math.round(spec.model.contextWindow * (1 - spec.autoCompactAtPct / 100)) },
    });

    // Persist settled turns (agent_end) AND every PI compaction (auto at the threshold, manual /compact,
    // overflow recovery) — PI shrinks the live context but writes NOTHING to the store, so without this
    // the token savings evaporate on the next rehydrate. Only a REAL compaction (result present, not
    // aborted) mirrors; a no-op/failed run leaves the store untouched. Callers layer their own
    // subscriptions on top (the `compacted` client-notify in the chat brain, liveness in the worker).
    session.subscribe((e: AgentSessionEvent) => {
      projectEvent(this.d.store, spec.sessionId, e);
      if (e.type === 'compaction_end' && e.result != null && e.aborted !== true) {
        persistCompaction(this.d.store, session, spec.sessionId);
      }
    });
    return { session };
  }
}
