import type { Skill, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TurnIdentity } from './policyContext.js';
import type { AskAnswer, AskQuestion, BrainCard } from '../brain/events.js';

/** A skill contributed by a plugin. Reuses pi's file-backed `Skill` (name/description/filePath…), so it
 *  flows straight into `formatSkillsForPrompt` — skills are inherently markdown-file based. */
export type PluginSkill = Skill;

/** The observable lifecycle points a plugin hook can subscribe to. The union constrains only the NAME;
 *  payloads stay `unknown` in v1 so adding a hook site never churns the type. Grouped by subsystem:
 *  platform ingress, brain session/turn lifecycle, tool registry/calls, memory I/O, and plugin reloads. */
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
 *  declarative intent for the audit/UI. `reads` lists read scopes the plugin claims — `'providers'`
 *  is runtime-wired: it permits `ctx.resolveProvider()` for provider ids beyond the plugin's own
 *  config (see PluginContext.resolveProvider). */
export interface PluginCapabilities {
  hooks?: PluginHookName[];
  mutates?: ('prompt' | 'turnContext' | 'tools' | 'memory')[];
  reads?: string[];
  network?: boolean;
}

/** Where a channel message came from + what its sender may access. The adapter resolves `access` from
 *  its own role mapping (e.g. Discord role → projects + prompt); a message without `access` is ignored
 *  (an unmapped user gets no brain). `admin: true` runs the turn with the owner's full powers (all
 *  repos + orca_* tools) — reserve it for owner-authored automation (cron), never for foreign senders. */
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
  /** Lazy platform-history provider: called ONLY when this message opens a brand-new conversation,
   *  so the brain can see what was said in the channel before it joined. Returns a ready context
   *  block (or '' when nothing is available). */
  history?: () => Promise<string>;
  access?: { projectIds: number[]; prompt?: string; admin?: boolean; model?: { provider?: string; model?: string }; thinkingLevel?: string; tools?: string[] };
}
/** A messaging channel a plugin attaches (Discord, …). The host calls `listen` + `connect` at startup;
 *  the handler returns the brain's reply (or undefined to stay silent) and the adapter delivers it. */
export interface PlatformAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect?(): void;
  listen(onMessage: (src: SessionSource, text: string, onEvent?: (e: { type: string; delta?: string; name?: string }) => void) => Promise<string | undefined>): void;
  send(channelId: string, text: string): Promise<void>;
  /** Deliver a proactive (host-initiated) message — to `channelId` when given, else to this
   *  platform's configured notification channel. Optional — an adapter without a notify channel
   *  simply omits it. Used for cron/tick echoes. */
  notify?(text: string, channelId?: string): Promise<void>;
}

/** Scoped logger handed to a plugin (prefixed with the plugin name by the registry). */
export interface PluginLogger { info(msg: string): void; warn(msg: string): void; error(msg: string): void }

/** A configured brain provider's usable credentials, resolved by id from the central provider list —
 *  so a plugin (voice STT/TTS, image gen) reads ONE shared key instead of duplicating it. `apiKey` is
 *  null for OAuth providers (no static key). */
export interface ProviderCredentials { id: string; label: string; type: string; baseUrl: string; apiKey: string | null }

/** What a plugin's `register(ctx)` receives. Every `register*` call feeds the shared PluginRegistry. */
export interface PluginContext {
  registerTool(tool: ToolDefinition): void;
  registerSkill(skill: PluginSkill): void;
  /** Append a chunk of instructions to the brain's system prompt, after the Orca persona. */
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
  /** Per-plugin writable data directory (created on first call) — cron job files, generated images… */
  dataDir(): string;
  /** Whether the CURRENT turn runs with the owner's all-access policy (admin chat session). Tools that
   *  manage shared state (cron jobs, skills) gate on this so channel senders can't reach them. */
  isAdminSession(): boolean;
  /** The current turn's access (admin flag + project ids) — a plugin forwards this when delegating to
   *  a sub-agent so the child inherits exactly the caller's scope, never more. */
  currentAccess(): { projectIds: number[]; admin: boolean };
  /** Who is driving the current turn (platform sender, resolved Orca account, admin flag) — plugins
   *  that persist per-user state (long-term memory) key it on this. Null outside a prompt turn. */
  currentIdentity(): TurnIdentity | null;
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
  /** This plugin's own config slice (`config.plugins.config[name]`), secrets included daemon-side. */
  readonly config: Record<string, unknown>;
  readonly logger: PluginLogger;
}

/** The module shape a plugin's built ESM entry must export. */
export interface PluginModule { register(ctx: PluginContext): void | Promise<void> }
