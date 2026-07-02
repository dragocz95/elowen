import type { Skill, ToolDefinition } from '@earendil-works/pi-coding-agent';

/** A skill contributed by a plugin. Reuses pi's file-backed `Skill` (name/description/filePath…), so it
 *  flows straight into `formatSkillsForPrompt` — skills are inherently markdown-file based. */
export type PluginSkill = Skill;

/** A named lifecycle callback. The concrete hook set stays intentionally minimal for the foundation. */
export interface PluginHook { name: string; run: (payload: unknown) => void | Promise<void> }

/** Where a channel message came from + what its sender may access. The adapter resolves `access` from
 *  its own role mapping (e.g. Discord role → projects + prompt); a message without `access` is ignored
 *  (an unmapped user gets no brain). `admin: true` runs the turn with the owner's full powers (all
 *  repos + orca_* tools) — reserve it for owner-authored automation (cron), never for foreign senders. */
export interface SessionSource {
  platform: string;
  userId: string;
  roleIds: string[];
  channelId: string;
  threadId?: string;
  access?: { projectIds: number[]; prompt?: string; admin?: boolean; model?: { provider?: string; model?: string } };
}
/** A messaging channel a plugin attaches (Discord, …). The host calls `listen` + `connect` at startup;
 *  the handler returns the brain's reply (or undefined to stay silent) and the adapter delivers it. */
export interface PlatformAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect?(): void;
  listen(onMessage: (src: SessionSource, text: string, onEvent?: (e: { type: string; delta?: string; name?: string }) => void) => Promise<string | undefined>): void;
  send(channelId: string, text: string): Promise<void>;
  /** Deliver a proactive (host-initiated) message to this platform's configured notification channel.
   *  Optional — an adapter without a notify channel simply omits it. Used for cron/tick echoes. */
  notify?(text: string): Promise<void>;
}

/** Scoped logger handed to a plugin (prefixed with the plugin name by the registry). */
export interface PluginLogger { info(msg: string): void; warn(msg: string): void; error(msg: string): void }

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
  /** Push a proactive message out to every platform that has a notification channel configured (e.g.
   *  Discord). Fire-and-forget; no-op when nothing is wired. Used by cron/tick to echo results. */
  notify(text: string): Promise<void>;
  /** Pickable brain models across every configured provider (feeds the Discord /model dropdown).
   *  Empty when nothing is wired. */
  listModels(): Promise<{ provider: string; providerLabel: string; model: string }[]>;
  /** This plugin's own config slice (`config.plugins.config[name]`), secrets included daemon-side. */
  readonly config: Record<string, unknown>;
  readonly logger: PluginLogger;
}

/** The module shape a plugin's built ESM entry must export. */
export interface PluginModule { register(ctx: PluginContext): void | Promise<void> }
