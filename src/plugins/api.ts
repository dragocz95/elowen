import type { Skill, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { SubagentEmitter, TurnIdentity, TurnModel } from './policyContext.js';
import type { AskAnswer, AskQuestion, BrainCard } from '../brain/events.js';
import type { ProcessRegistry } from '../brain/processRegistry.js';

/** A skill contributed by a plugin. Reuses pi's file-backed `Skill` (name/description/filePath…), so it
 *  feeds PI's native path unchanged (the session factory's `skillsOverride` → progressive disclosure in
 *  the system prompt + `/skill:name` expansion) — skills are inherently markdown-file based. */
export type PluginSkill = Skill;

/** The observable lifecycle points a plugin hook can subscribe to. The union constrains only the NAME;
 *  payloads stay `unknown` in v1 so adding a hook site never churns the type. Grouped by subsystem:
 *  platform ingress, brain session/turn lifecycle, tool registry/calls, memory I/O, and plugin reloads.
 *  Wired sites: `tools.call.after` fires after each PERMITTED plugin tool execute resolves, with a
 *  `PluginToolResultEvent`-shaped payload `{ tool, params, result }` (see brain/session/capabilities.ts),
 *  and is AWAITED before the result travels onward (per-event budget — see hookBus EVENT_BUDGETS): a
 *  hook may mutate the written file and/or append short strings to `result.details.notes: string[]`
 *  (create if absent) to annotate the transcript — e.g. the formatters plugin formats files written by
 *  the files plugin and notes "formatted <file> with <name>". */
export type PluginHookName =
  | 'platform.message.received' | 'platform.message.normalized'
  | 'brain.session.beforeSpawn' | 'brain.session.afterSpawn'
  | 'brain.turn.beforeContext' | 'brain.turn.contextBuilt'
  | 'brain.turn.beforeSend' | 'brain.turn.afterResponse'
  | 'tools.registry.build' | 'tools.call.before' | 'tools.call.after'
  | 'memory.retrieve.before' | 'memory.retrieve.after'
  | 'memory.write.before' | 'memory.write.after'
  | 'plugin.reload.before' | 'plugin.reload.after';

/** A patch a hook may return to enrich the live turn. v1 wires ONLY `appendContext` (turnContext
 *  enrichment): the string is appended, UNTRUSTED-framed, to the live prompt in owner chat — never
 *  persisted, never the system prompt. prompt/tools/memory are declarable capability VALUES but not
 *  patch-wired yet, so the patch type stays minimal until they are. */
export interface HookPatch { appendContext?: string }

/** What a hook may return. `patch` is the runtime-wired mutation (gated by the owner's declared
 *  capabilities); `annotations`/`audit` are free-form observability the host may record. A hook that
 *  returns nothing (void) stays a pure observer — the common case. */
export interface HookResult { patch?: HookPatch; annotations?: Record<string, unknown>; audit?: string }

/** A hook's return: either nothing (observational) or a HookResult (may carry a mutation patch). */
export type HookOutcome = void | HookResult;

/** A named lifecycle callback. The concrete hook set stays intentionally minimal for the foundation.
 *  A hook returning void is a pure observer; a hook returning a HookResult may carry a `patch` that the
 *  bus applies ONLY when its owning plugin declared the matching capability (deny-by-default). */
export interface PluginHook { name: PluginHookName; run: (payload: unknown) => HookOutcome | Promise<HookOutcome> }

/** What a plugin is ALLOWED to do, declared in its manifest (`capabilities`). Deny-by-default: a plugin
 *  with no capabilities block can mutate nothing. `hooks` documents the lifecycle points it subscribes
 *  to; `mutates` gates runtime patches (only `turnContext` is patch-wired in v1); `network` is
 *  declarative intent for the audit/UI. `reads` lists read scopes the plugin claims — two are
 *  runtime-wired: `'providers'` permits `ctx.resolveProvider()` for provider ids beyond the plugin's own
 *  config (see PluginContext.resolveProvider), and `'embeddings'` permits `ctx.embeddings.embed*()` (the
 *  shared text→vector pipeline, see PluginContext.embeddings). Both are deny-by-default. */
export interface PluginCapabilities {
  hooks?: PluginHookName[];
  mutates?: ('prompt' | 'turnContext' | 'tools' | 'memory')[];
  reads?: string[];
  network?: boolean;
}

/** Where a channel message came from + what its sender may access. The adapter resolves `access` from
 *  its own role mapping (e.g. Discord role → projects + prompt); a message without `access` is ignored
 *  (an unmapped user gets no brain). `admin: true` runs the turn with the owner's full powers (all
 *  repos + elowen_* tools) — reserve it for owner-authored automation (cron), never for foreign senders. */
export interface SessionSource {
  platform: string;
  userId: string;
  /** The sender's display name. Channel sessions are shared (one conversation per channel), so the
   *  adapter also prefixes each message text with `[<userName>]` — this field carries it structurally. */
  userName?: string;
  roleIds: string[];
  channelId: string;
  threadId?: string;
  /** Channel metadata (adapter-fetched, cached): lets the brain know WHERE it is talking. Injected
   *  into the channel session's system prompt at spawn time. */
  channelName?: string;
  channelTopic?: string;
  /** Image attachments (base64), ready for a vision-capable model. Adapter-capped in count and size. */
  images?: { data: string; mimeType: string }[];
  /** Set when this message replays work scheduled FROM a user conversation (a cron wake-up's origin):
   *  the host then routes the turn as a BOUND send into that conversation — the reply lands (and
   *  streams) exactly where the schedule was created — instead of the platform's own channel session.
   *  The host verifies the session still exists and belongs to `userId`; on a mismatch it falls back
   *  to the normal channel path. */
  origin?: { sessionId: string; userId: number };
  /** Lazy platform-history provider: called ONLY when this message opens a brand-new conversation,
   *  so the brain can see what was said in the channel before it joined. Returns a ready context
   *  block (or '' when nothing is available). */
  history?: () => Promise<string>;
  access?: { projectIds: number[]; prompt?: string; admin?: boolean; model?: { provider?: string; model?: string }; thinkingLevel?: string; tools?: string[];
    /** Idle cutoff (ms) for THIS surface's channel session — forwarded to ChannelSessionService.send as
     *  `idleRolloverMs`. Set by cron (shorter than the default 30 min) so a frequent job whose gap between
     *  ticks exceeds the prompt-cache window starts a fresh session instead of re-sending a growing context
     *  at full price. Unset → the host default (SESSION_IDLE_ROLLOVER_MS). */
    sessionIdleMs?: number };
}
/** A messaging channel a plugin attaches (Discord, …). The host calls `listen` + `connect` at startup;
 *  the handler returns the brain's reply (or undefined to stay silent) and the adapter delivers it. */
export interface PlatformAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect?(): void;
  listen(onMessage: (src: SessionSource, text: string, onEvent?: (e: { type: string; delta?: string; name?: string; sessionId?: string }) => void) => Promise<string | undefined>): void;
  send(channelId: string, text: string): Promise<void>;
  /** Deliver a proactive (host-initiated) message — to `channelId` when given, else to this
   *  platform's configured notification channel. Optional — an adapter without a notify channel
   *  simply omits it. Used for cron/tick echoes. */
  notify?(text: string, channelId?: string): Promise<void>;
  /** Optional out-of-band control the host wires right after `listen`, for slash commands that act on a
   *  channel SESSION (stop/status/compact) or the daemon (restart) instead of sending a message. Omit for
   *  a message-only adapter. */
  control?(api: PlatformControlApi): void;
}

/** A channel-scoped conversation reference — the SAME identity an adapter reports to `listen` (so a slash
 *  command targets the exact session a message from that channel would). */
export interface ChannelRef { platform: string; channelId: string; threadId?: string }

/** The control surface the host grants an adapter. Channel-scoped ops no-op on an unknown/idle channel. */
export interface PlatformControlApi {
  /** Live model, whether a turn is in flight, and context usage of the channel's session — or null when
   *  nothing is spawned. */
  status(ref: ChannelRef): { model: string; streaming: boolean; usage: { tokens: number | null; contextWindow: number; percent: number | null } } | null;
  /** Abort the channel's in-flight turn (no-op when idle). */
  abort(ref: ChannelRef): void;
  /** Compact the channel session's context; resolves to `{ usage, compacted }` (null if no session).
   *  `compacted:false` is a benign no-op (nothing to compact yet), not an error — only a real compaction
   *  failure rejects, so the caller can tell "no session" from "nothing to do" from a genuine error. */
  compact(ref: ChannelRef): Promise<{ usage: { tokens: number | null; contextWindow: number; percent: number | null }; compacted: boolean; message?: string } | null>;
  /** Admin-only daemon restart (attributed to the instance operator); rejects when restart isn't
   *  available on this deployment. The caller is responsible for its own admin gate. */
  restart(): Promise<void>;
}

/** Scoped logger handed to a plugin (prefixed with the plugin name by the registry). */
export interface PluginLogger { info(msg: string): void; warn(msg: string): void; error(msg: string): void }

/** A configured brain provider's usable credentials, resolved by id from the central provider list —
 *  so a plugin (voice STT/TTS, image gen) reads ONE shared key instead of duplicating it. `apiKey` is
 *  null for OAuth providers (no static key). */
export interface ProviderCredentials { id: string; label: string; type: string; baseUrl: string; apiKey: string | null }

/** The SHARED text→vector embedder handed to a plugin (`ctx.embeddings`), gated deny-by-default by a
 *  `reads:['embeddings']` capability. It is the SAME EmbeddingService + Settings→Memory embedding config
 *  the memory subsystem uses (single source of truth) — the operator configures ONE embedding model and
 *  a plugin (semantic code index, RAG…) reuses it; there is no second provider field or HTTP client. The
 *  bound config is applied internally, so a plugin embeds `(text)` only and can never re-point the shared
 *  key at a different model/endpoint. `embed`/`embedBatch` REJECT when the capability is absent or no
 *  embedding model is configured — a plugin must gate on `isConfigured()` first. */
export interface PluginEmbeddings {
  /** True only when the plugin declared `reads:['embeddings']` AND the operator has configured an
   *  embedding model (Settings → Memory). Read live, so a config change applies on the next call. */
  isConfigured(): boolean;
  /** The active embedding model's identity, or null when unconfigured/undeclared. `dimensions` is null
   *  when the provider doesn't pin a width. A plugin persists this alongside stored vectors so it can
   *  detect a model/dimension switch and re-embed (an old-width vector cosines to 0 otherwise). */
  descriptor(): { provider: string; model: string; dimensions: number | null } | null;
  /** Embed one string → one Float32 vector, via the shared pipeline. Rejects when not configured. */
  embed(text: string): Promise<Float32Array>;
  /** Embed N strings in ONE request → N vectors in input order. Rejects when not configured. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

/** Plugin-owned runtime control surface. Routes may read these from the live merged registry, but the
 *  shape stays plugin-specific so core does not need to import plugin modules or duplicate their state. */
export type PluginControl = Record<string, unknown>;

/** A plugin-contributed chat slash command (a reusable prompt macro, opencode-style). Invoking `/name args`
 *  sends `prompt` to the agent as a normal user turn; PI's native prompt-template engine substitutes the
 *  argument placeholders — `$ARGUMENTS`/`$@` (everything typed after the command), `$1`..`$9` (positionals),
 *  `${N:-default}`, `${@:N}`. Surfaces render it in their command menu alongside the built-ins and send the
 *  slash RAW. This is how a plugin adds a new `/command` to the CLI without touching core. */
export interface PluginCommand {
  /** kebab-case, unique across plugins and not shadowing a built-in command. */
  name: string;
  /** One-line help shown in the command menu. */
  description: string;
  /** The prompt sent to the agent; PI substitutes `$ARGUMENTS`/`$@`, `$1`..`$9`, `${N:-default}`. */
  prompt: string;
  /** Which surfaces expose it (default: all). */
  surfaces?: ('cli' | 'discord' | 'web')[];
}

/** What a plugin's `register(ctx)` receives. Every `register*` call feeds the shared PluginRegistry. */
export interface PluginContext {
  registerTool(tool: ToolDefinition): void;
  registerSkill(skill: PluginSkill): void;
  /** Register an admin/runtime control surface for this plugin. Unlike tools, controls are called by
   *  daemon routes and operate on the LIVE loaded plugin instance. */
  registerControl(name: string, control: PluginControl): void;
  /** Contribute a chat slash command (a prompt macro) that shows up in every surface's command menu.
   *  Refused (and warned) if the name is not kebab-case, shadows a built-in, or collides with another
   *  plugin's command. */
  registerCommand(command: PluginCommand): void;
  /** Append a chunk of instructions to the brain's system prompt, after the Elowen persona. */
  registerSystemPromptFragment(fragment: string): void;
  registerHook(hook: PluginHook): void;
  /** Register a provider of EPHEMERAL per-turn context (date/time, live status…). Its string is injected
   *  into each user message — NOT the system prompt — so the cacheable prompt prefix stays stable. */
  registerTurnContext(fn: () => string): void;
  /** STUB: record a platform adapter (not started by the foundation). */
  registerPlatform(adapter: PlatformAdapter): void;
  /** Resolve + assert a filesystem path is inside the current user's accessible repos, returning the
   *  absolute path (throws otherwise). File/terminal tools call this before any disk access. Evaluated at
   *  tool-call time against the per-session Policy carried on AsyncLocalStorage. */
  assertPathAllowed(path: string): string;
  /** The repo roots the current session may operate in (empty for an admin's all-access). Used to default
   *  a tool's working directory. */
  allowedRoots(): string[];
  /** The working directory an exec/file tool uses when the caller names none: the project path the
   *  current turn's session is bound to (a task worker's checkout), else the first allowed root, else
   *  the daemon's own cwd. Evaluated per tool call against the per-run turn scope, so a directory the
   *  agent moved to in an earlier run never leaks into the next one. */
  defaultCwd(): string;
  /** Per-plugin writable data directory (created on first call) — cron job files, generated images… */
  dataDir(): string;
  /** Whether the CURRENT turn runs with the owner's all-access policy (admin chat session). Tools that
   *  manage shared state (cron jobs, skills) gate on this so channel senders can't reach them. */
  isAdminSession(): boolean;
  /** The current turn's access (admin flag + project ids) — a plugin forwards this when delegating to
   *  a sub-agent so the child inherits exactly the caller's scope, never more. */
  currentAccess(): { projectIds: number[]; admin: boolean };
  /** Who is driving the current turn (platform sender, resolved Elowen account, admin flag) — plugins
   *  that persist per-user state (long-term memory) key it on this. Null outside a prompt turn. */
  currentIdentity(): TurnIdentity | null;
  /** The persisted brain-session id the current turn runs in (`brain-…`), or undefined outside a
   *  prompt turn. Lets a plugin bind scheduled work back to the exact conversation it was created
   *  from (a cron wake-up records it as the job's origin and the reply lands there). */
  currentSessionId(): string | undefined;
  /** The current turn's resolved working directory (the project the CLI was launched in, a channel's
   *  policy root, the daemon's primary project as fallback) — plugins that persist per-PROJECT state
   *  (e.g. a todo checklist) key on this alongside the identity. Undefined outside a prompt turn. */
  currentWorkDir(): string | undefined;
  /** Push a proactive message out to every platform that has a notification channel configured (e.g.
   *  Discord). Fire-and-forget; no-op when nothing is wired. Used by cron/tick to echo results. */
  notify(text: string, channelId?: string): Promise<void>;
  /** Ask the current user one or more multiple-choice questions and await their pick(s). PARKS the turn
   *  until the user answers (or a timeout elapses), then resolves with one AskAnswer per question. Only
   *  valid inside a prompt turn driven by an interactive transport (chat/Discord); throws otherwise. */
  askUser(questions: AskQuestion[]): Promise<AskAnswer[]>;
  /** Deliver a user's answer to a parked ask_user_question back to its waiting turn — for interactive
   *  transports (Discord) that receive the pick out-of-band via their own event loop rather than through
   *  /brain/answer. Returns whether a pending question matched (false for an unknown/expired id). */
  answerQuestion(id: string, answers: AskAnswer[]): boolean;
  /** Push a structured display card to the current conversation's clients — a live panel keyed by
   *  `card.id` so re-emitting the same id replaces it and an empty card (no items/body) removes it. The
   *  generic, reusable way for a plugin to show a checklist / status panel without touching core
   *  rendering. Web and Discord render every card; the CLI shows only `pinned` cards (in its fixed panel
   *  above the status bar) — a non-pinned card won't surface there. No-op outside an interactive prompt
   *  turn (cron/worker sessions wire no emitter). */
  emitCard(card: BrainCard): void;
  /** The daemon-level background-process registry (`run_command(background:true)` children). The terminal
   *  plugin registers a handle here per spawn so the CLI + web can list/read/kill them from a panel next
   *  to the todos, without going through an agent turn. Process-global (not turn-scoped) — see
   *  processRegistry. */
  processes: ProcessRegistry;
  /** The current turn's live sub-agent progress emitter, or null when the transport wired none
   *  (worker/cron sessions, platforms without a live stream). A delegating plugin MUST capture this
   *  BEFORE spawning its child: callbacks fired from the child's turn run inside the CHILD's scope,
   *  where the accessor no longer resolves to the delegating conversation. Each update fans out to the
   *  parent's clients as a `subagent` BrainEvent (live row in the CLI transcript). */
  subagentEmitter(): SubagentEmitter | null;
  /** The provider entry id + model the CURRENT turn's session runs on, or null outside a prompt turn —
   *  a delegating plugin uses it to default the child to "the same model as me". */
  currentModel(): TurnModel | null;
  /** Pickable brain models across every configured provider (feeds the Discord /model dropdown).
   *  Empty when nothing is wired. */
  listModels(): Promise<{ provider: string; providerLabel: string; model: string }[]>;
  /** Resolve a configured brain provider's credentials (baseUrl + apiKey) by id — lets a plugin reuse
   *  the operator's central provider key (voice STT/TTS, image gen) instead of its own secret field.
   *  Null when the id is unknown. Reads live config, so a key change applies on the next call.
   *  DENY-BY-DEFAULT: a plugin may resolve only a provider id wired into its OWN config, or one it
   *  covers with a `providers` read capability — any other id returns null (a plugin can't lift an
   *  unrelated central key). */
  resolveProvider(id: string): ProviderCredentials | null;
  /** The SHARED text→vector embedder — the SAME EmbeddingService + Settings→Memory embedding config the
   *  memory subsystem uses (single source of truth). Gated deny-by-default by `reads:['embeddings']`:
   *  without that capability `isConfigured()` is false and `embed*()` reject, so an already-installed
   *  plugin gains nothing. Lets a semantic-index/RAG plugin reuse the operator's ONE embedding model
   *  instead of forking a second provider/HTTP client. See PluginEmbeddings. */
  readonly embeddings: PluginEmbeddings;
  /** This plugin's own config slice (`config.plugins.config[name]`), secrets included daemon-side. */
  readonly config: Record<string, unknown>;
  readonly logger: PluginLogger;
}

/** The module shape a plugin's built ESM entry must export. */
export interface PluginModule { register(ctx: PluginContext): void | Promise<void> }
