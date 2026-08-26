import type { Skill, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ZodTypeAny } from 'zod';
import type { SubagentCompletionEmitter, SubagentEmitter, TurnIdentity, TurnModel, WorkflowCompletionEmitter, WorkflowEmitter } from './policyContext.js';
import type { AskAnswer, AskQuestion, BrainCard, WorkflowCompletion, WorkflowUpdate } from '../brain/events.js';
import type { ProcessRegistry } from '../brain/processRegistry.js';
import type { NoninteractivePermissionBoundary } from '../brain/toolPermissions.js';
import type { DelegatingTurnAccess } from '../brain/delegatedScope.js';
import type { SlashArgument, SlashCommandDef, SlashExecution, SlashSurface } from '../brain/slashCommands.js';
import type { PlatformSurface } from '../shared/platformIdentity.js';
import type { DelegatedChildSummary } from '../store/brainDelegationStore.js';
import type { McpBridgeSnapshot } from './mcpSnapshot.js';
import type { ElowenEvent } from '../api/sse.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { Project } from '../store/projectStore.js';
import type { InferenceClient, RelayConfig } from '../inference/types.js';
import type { CommitFileChange, CommitLogEntry } from '../integrations/projectFiles.js';
import type { PushPayload } from '../push/messages.js';
import type { WorkflowAddNodesRpcResult, WorkflowExpansionRpc } from '../subagent/hostRpc.js';
import type { PluginSecretBag } from '../shared/pluginSecrets.js';
import type { ProjectGitSnapshot } from '../git/gitReader.js';

export type { DelegatedChildSummary, PluginSecretBag };

/** The host's bridge to the DURABLE side of delegation: which sub-agents a conversation already ran,
 *  reading their stored final replies, and continuing one of them. Every operation is keyed on the parent
 *  session the HOST resolves from the live turn — never on anything the plugin supplies — so a plugin
 *  cannot address another conversation's children. */
/** Low-frequency progress of a sub-agent turn — the subset of a BrainEvent a delegating plugin distils
 *  into its live progress row (tool starts, step/idle token usage, the child's session id). Passed to a
 *  continuation so a follow-up surfaces as a running sub-agent exactly like the first delegation did. The
 *  host narrows every child BrainEvent onto this exact shape at the boundary (see
 *  DelegatedSessionService), so the plugin never observes a raw event that outgrew this contract. */
export interface SubagentProgressEvent {
  type: string;
  name?: string;
  detail?: string;
  sessionId?: string;
  usage?: { totalTokens?: number };
}

/** How a sub-agent continuation ended. `reply` = the child was idle, ran the follow-up as its own turn
 *  and this is its answer. `steered` = the child was mid-turn and the message was injected into that
 *  RUNNING turn (confirmed in its context) — there is no separate reply; the child's result reaches the
 *  caller through the delegation's own result path (the blocking Delegate return / background delivery). */
export type DelegatedContinueResult = { status: 'reply'; reply: string } | { status: 'steered' };

export interface DelegatedChildBridge {
  runs(parentSessionId: string, limit?: number): DelegatedChildSummary[];
  read(parentSessionId: string, childSessionId: string): string;
  continue(
    parentSessionId: string,
    childSessionId: string,
    text: string,
    access: DelegatingTurnAccess,
    onEvent?: (e: SubagentProgressEvent) => void,
    model?: string,
    /** Lift the child out of read-only mode for this and every later turn, up to what `access` holds now.
     *  Refused unless the child was spawned read-only BY CHOICE and by this same principal — see
     *  promoteDelegatedScope, which owns every rule. */
    promote?: boolean,
  ): Promise<DelegatedContinueResult>;
  stop(parentSessionId: string, childSessionId: string): Promise<{ stopped: boolean }>;
}

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
 *  the files plugin and notes "formatted <file> with <name>".
 *
 *  `brain.session.afterSpawn` fires once a live session is assembled, with `{ sessionId, messages }`
 *  where `messages` is its REHYDRATED history, and is AWAITED before the caller may run a turn. It is
 *  the seam for per-conversation state that lives in daemon memory while its evidence lives in the
 *  transcript: the files plugin re-seeds its read-before-write guard there, so reopening a conversation
 *  after a restart does not make the agent re-read files it has already seen.
 *
 *  `tools.call.before` fires just before a PERMITTED plugin tool executes, with a
 *  `PluginToolCallEvent`-shaped payload `{ tool, params }`. A subscriber whose plugin declared
 *  `mutates:['tools']` may return `patch.denyToolCall` to block the call outright (a lint gate, a
 *  protected path, a guarded config); the reason reaches the model in place of the result. Fail-open
 *  like every other hook: one that throws or times out blocks nothing. */
export type PluginHookName =
  | 'platform.message.received' | 'platform.message.normalized'
  | 'brain.session.beforeSpawn' | 'brain.session.afterSpawn'
  | 'brain.turn.beforeContext' | 'brain.turn.contextBuilt'
  | 'brain.turn.beforeSend' | 'brain.turn.afterResponse'
  | 'tools.registry.build' | 'tools.call.before' | 'tools.call.after'
  | 'memory.retrieve.before' | 'memory.retrieve.after'
  | 'memory.write.before' | 'memory.write.after'
  | 'plugin.reload.before' | 'plugin.reload.after';

/** A patch a hook may return to change the live turn. Two are wired:
 *
 *  `appendContext` (needs `mutates:['turnContext']`) — the string is appended, UNTRUSTED-framed, to the
 *  live prompt in owner chat; never persisted, never the system prompt.
 *
 *  `denyToolCall` (needs `mutates:['tools']`) — returned from a `tools.call.before` hook, it BLOCKS the
 *  call: the tool never runs and the string is handed to the model as the reason, so it can adapt
 *  instead of retrying blindly. Deliberately runs AFTER the permission gate: permissions are the
 *  user's own policy and no plugin may widen or override them — a hook may only refuse further.
 *
 *  `prompt`/`memory` remain declarable capability VALUES without a patch shape yet. */
export interface HookPatch { appendContext?: string; denyToolCall?: string }

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
 *  with no capabilities block can mutate nothing. `mutates` gates runtime patches (only `turnContext`
 *  is patch-wired in v1); `network` is declarative intent for the audit/UI. `reads` lists read scopes
 *  the plugin claims — two are runtime-wired: `'providers'` permits `ctx.resolveProvider()` for provider
 *  ids beyond the plugin's own config (see PluginContext.resolveProvider), and `'embeddings'` permits
 *  `ctx.embeddings.embed*()` (the shared text→vector pipeline, see PluginContext.embeddings). Both are
 *  deny-by-default.
 *
 *  `mutates` also gates host SINKS handed to the plugin, not only hook patches: `'events'` for the
 *  event-bus writers and `'workflow-dag'` for `ctx.workflowExpansionRpc()` — the reverse client that
 *  mutates a LIVE daemon-owned workflow DAG from a runner turn. It is a declared capability rather than
 *  a hardcoded plugin name so ownership of the workflow surface can move, be renamed or be replaced
 *  without core knowing who holds it. */
export interface PluginCapabilities {
  mutates?: ('prompt' | 'turnContext' | 'tools' | 'memory' | 'events' | 'workflow-dag' | 'users')[];
  reads?: string[];
  network?: boolean;
}

/** The `mutates` values that reach past the live prompt and touch state the operator owns: the tool
 *  vocabulary, stored memory, the activity log, and the running sub-agent DAG. Enabling a plugin that
 *  claims one of these hands third-party code a key, so the API refuses to do it unless the caller names
 *  the keys it means. A red badge in the settings UI is not consent — nothing forces a reader to see it,
 *  and a marketplace install is one POST away from never showing it at all.
 *
 *  `prompt` and `turnContext` are deliberately absent: they ride the ephemeral prompt of a single turn
 *  and leave nothing behind, which is the reach any instruction in the chat already has. */
export const CONSENT_REQUIRED_MUTATES: readonly NonNullable<PluginCapabilities['mutates']>[number][] =
  ['tools', 'memory', 'events', 'workflow-dag', 'users'];

export interface PlatformHistoryMessage {
  /** Stable platform message id when the API exposes one. */
  id?: string;
  /** Only conversational roles are accepted. Platform system events must be filtered by the adapter. */
  role: 'user' | 'assistant';
  text: string;
  author?: { id?: string; name?: string };
  timestamp?: string;
  /** Historical attachments stay placeholders/metadata — never re-download binary data into context. */
  attachments?: { name?: string; mimeType?: string; kind?: 'image' | 'file' | 'audio' | 'video' | 'unknown' }[];
}

/** New adapters return individual transcript messages. A legacy string remains accepted during rollout,
 *  but core stores it as one explicitly-untrusted history item instead of prefixing the live user prompt. */
export type PlatformHistory = string | readonly PlatformHistoryMessage[];

/** Where a channel message came from and whether the adapter admitted it. A message without `access` is
 * ignored. For human platform turns, projects, tools and account-admin identity come only from the linked
 * Elowen account; role-derived fields remain room prompt/trust metadata and internal automation scope. */
export interface SessionSource {
  platform: string;
  userId: string;
  /** Other immutable platform identifiers for the same sender. The identity resolver tries these after
   * `userId`; adapters must include only authenticated IDs for that person, never room or message IDs. */
  accountIds?: string[];
  /** The sender's display name, supplied structurally. Adapters must pass clean message text and must not
   *  interpolate this name into it; core serializes attribution only after validating the turn surface. */
  userName?: string;
  /** E-mail / UPN verified by the platform adapter for this sender. This identity evidence MUST come from
   *  the platform's authenticated directory or activity metadata, never from message text typed by a user. */
  verifiedEmail?: string;
  /** True only when the adapter recognized the text as a plugin prompt-command it intentionally passes to
   *  PI for native expansion. A leading slash by itself is ordinary user text. */
  promptCommand?: boolean;
  roleIds: string[];
  channelId: string;
  threadId?: string;
  /** This conversation is a DIRECT 1:1 chat between the bot and this one sender (a Teams personal chat,
   *  a Discord DM, a private Telegram chat), not a room other people can read. Only the adapter knows
   *  which it is — both shapes end up with a `brain-ch-*` session id — so it must say so explicitly.
   *
   *  Setting it lets the conversation behave as its sender's own: their personal skills load, and a job
   *  they schedule can report back into it. It therefore MUST be true only when the sender is genuinely
   *  the sole other participant; leave it unset when unsure, since everything downstream fails closed to
   *  the shared-room rules that apply today. */
  direct?: boolean;
  /** Channel metadata (adapter-fetched, cached): lets the brain know WHERE it is talking. Injected
   *  into the channel session's system prompt at spawn time. */
  channelName?: string;
  channelTopic?: string;
  /** Image attachments (base64), ready for a vision-capable model. Adapter-capped in count and size. */
  images?: { data: string; mimeType: string }[];
  /** Everything else the sender attached (base64), for the host to write into the verified writer's
   *  project so the agent gets a real path instead of a note saying a file arrived — the same thing a web
   *  upload produces. The adapter downloads and caps; the HOST sanitizes the name and owns the
   *  destination, so nothing here is trusted to describe where the bytes may go. An adapter that reports
   *  a file the host cannot place gets a thrown error to relay, never a silent drop. */
  attachments?: { name: string; data: string; mimeType?: string }[];
  /** Set when this message replays work scheduled FROM a conversation. Owner-chat origins use a bound
   *  send into `sessionId`. Direct platform origins also carry the opaque `deliveryTarget`: the host
   *  validates it against the direct session, runs through the channel path, and sends the reply through
   *  that platform's outbound adapter. Plugins persist/return the target but never parse or construct it.
   *
   *  With no `sessionId` the target is that account's DEFAULT conversation — the shape a scheduled job
   *  somebody OWNS uses: it was never created from a particular conversation, but its result still
   *  belongs in its owner's own chat rather than in a channel session only the admin can read. */
  origin?: { sessionId?: string; userId: number; deliveryTarget?: string };
  /** Lazy platform-history provider: called ONLY when this message opens a brand-new conversation.
   *  Individual role-preserving messages are preferred; a legacy string remains accepted during rollout. */
  history?: () => Promise<PlatformHistory>;
  /** `projectIds` is supplied only by a DELEGATED turn (the subagent plugin copies it from
   *  `ctx.currentAccess()`, which derives it from the resolved Policy). A platform role does not set it:
   *  project scope, like tool scope, comes from the verified sender's own account. */
  access?: { projectIds?: number[]; prompt?: string; admin?: boolean; model?: { provider?: string; model?: string }; thinkingLevel?: string; fast?: boolean;
    /** Optional background the delegating agent hands to a sub-agent (it cannot see the parent
     *  conversation). Added to the child's system-prompt prefix as stable, cache-friendly blocks. A LIST
     *  because each block is bounded on its own (MAX_PROMPT_CHARS in delegatedScope): passing a workflow
     *  node's dependency results as one string meant the per-chunk bound applied to all of them joined,
     *  and a wide fan-in lost most of its input to the clip. */
    context?: string | string[];
    /** True only when the ORIGINAL delegating turn belongs to an account administering this instance.
     *  `admin` is project scope and is deliberately insufficient: a foreign platform role may be admin
     *  without administering anything. */
    owner?: boolean;
    /** The Elowen account this automation turn acts FOR (a scheduled job somebody owns). The host uses
     *  it for account attribution and personal deny-lists; shared/delegated authority still comes from
     *  this access descriptor, while a verified direct conversation may use the account's own policy.
     *  Ignored when the sender is already linked to an account, and never a way to gain rights. */
    actAsUserId?: number;
    /** Exact execute-time plugin-tool policy inherited by a delegated child. Arrays preserve an empty
    *  allow-list, which really does mean "deny everything" — this is a captured boundary, not a role
    *  descriptor, so absence and emptiness are deliberately different answers. */
    toolPolicy?: { allow?: string[]; deny?: string[] };
    /** Effective ordered granular permission boundary captured by `ctx.currentAccess()` for a delegated
     * child. Explicit null means the parent turn had no permission gate wired; absence is rejected. */
    permissionBoundary?: NoninteractivePermissionBoundary | null;
    /** Delegated channel session's durable parent conversation. Host validates owner + existence. */
    parentSessionId?: string;
    /** The delegating turn's resolved working directory (from `ctx.currentWorkDir()`), inherited by the
     *  child so its tools and "Current working directory" advertise the SAME project the parent runs in —
     *  not the daemon's `/`. Validated against the child's policy at spawn like any client-reported cwd. */
    cwd?: string;
    /** Chosen built-in/custom sub-agent type (a `subagent_type` on the delegate call). The host resolves
     *  it against the agent registry into the child's role prompt, tool allow-list and (for a read-only
     *  type) a minted read-only permission boundary — see brain/platforms.ts. */
    agentType?: string;
    /** This turn is a scheduled/unattended run (a plugin fires timer-driven work — the bundled cronjob
     *  sets this). The host resolves it to the focused `scheduled` system prompt instead of the coding-agent
     *  base, keeping core agnostic to which plugin produced it. */
    scheduled?: boolean;
    /** A bare `read_only` delegation (no/other subagent_type). Selects the host-side read-only MODE — the
     *  READ_ONLY_AGENT_TOOLS preset intersected with the caller's scope, plus a minted read-only permission
     *  boundary — the exact path a read-only agent TYPE takes, so there is one read-only definition. */
    readOnly?: boolean;
    /** The `readOnly` above originates in the delegating turn's own PLAN mode rather than in what it asked
     *  for. Stamped by pathGuard.currentAccess and forwarded untouched by every spawner, so the host can
     *  tell a clamp the caller CHOSE (liftable by a later promotion) from one it was subject to (never). */
    planMode?: boolean;
    /** The principal running the delegating turn (see turnPrincipal), recorded on the child's durable scope
     *  so only that same identity can ever promote it out of read-only. */
    principal?: string;
    /** Account whose personal contributions, HOME and Sandbox workspaces the delegated child inherits. It is
     * host-resolved from the current turn, not guessed from the durable room owner. */
    contributionUserId?: number | null;
    /** Idle cutoff (ms) for THIS surface's channel session — forwarded to ChannelSessionService.send as
     *  `idleRolloverMs`. Set by cron (shorter than the default 30 min) so a frequent job whose gap between
     *  ticks exceeds the prompt-cache window starts a fresh session instead of re-sending a growing context
     *  at full price. Unset → the host default (SESSION_IDLE_ROLLOVER_MS). */
    sessionIdleMs?: number;
    /** Additional per-turn tool denies supplied by a platform. This can only NARROW the resolved account
     *  or role policy; synthetic relays use it to prevent autonomous agent-to-agent message loops. */
    denyTools?: string[] };
}
/** Names one of the host's own standing announcements so an adapter can say it in the user's language.
 *  The host has no language setting — the per-platform `language` config is the only place that knows
 *  one — so it sends the identity of the message alongside its English rendering and lets the adapter
 *  choose. `args` carries the values interpolated into the wording, in the order the phrasing takes
 *  them; a translation is free to arrange them differently. */
export interface ServiceNotice {
  key: string;
  args?: (string | number)[];
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
   *  simply omits it. Used for cron/tick echoes.
   *
   *  `notice` names WHICH standing announcement this is, for the ones the host words itself, so an
   *  adapter can render it in its configured language instead of shipping the host's English. It is
   *  absent for free-form text (a cron echo has nothing to translate). An adapter that ignores the
   *  argument — every external one, until it opts in — keeps delivering `text` exactly as before. */
  notify?(text: string, channelId?: string, notice?: ServiceNotice): Promise<void>;
  /** Optional out-of-band control the host wires right after `listen`, for slash commands that act on a
   *  channel SESSION (stop/status/compact) or the daemon (restart) instead of sending a message. Omit for
   *  a message-only adapter. */
  control?(api: PlatformControlApi): void;
}

/** A minimal, framework-agnostic inbound HTTP request handed to a plugin webhook handler. The daemon's
 *  hooks router builds it from the raw request; `body` is memoized so a handler may call it repeatedly. */
export interface PluginHttpRequest {
  method: string;
  /** Remainder AFTER the registered mount (no leading slash) — '' for an exact-mount hit. */
  path: string;
  query: Record<string, string>;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Raw request bytes — what a signature/JWT check must run over. */
  body: () => Promise<Buffer>;
  /** JSON.parse over `body()`; throws on invalid JSON. */
  json: <T = unknown>() => Promise<T>;
}
export interface PluginHttpResponse {
  /** Defaults to 200. */
  status?: number;
  headers?: Record<string, string>;
  /** An object body is JSON-serialized with a json content-type; string/bytes pass through. */
  body?: string | Uint8Array | object;
  /** Server-sent-events stream instead of a buffered body (authenticated plugin API only). The
   *  dispatcher opens the SSE response and runs this until it returns or the client disconnects
   *  (`signal` aborts). `send` writes one event frame. Ignored when `body` is also set. */
  sse?: (send: (data: string, event?: string) => Promise<void>, signal: AbortSignal) => Promise<void>;
}
/** An inbound webhook mount a plugin exposes on the daemon at `/hooks/<plugin>/<path>`. The mount is
 *  public at the bearer layer (an external service — a Teams bot callback — carries no Elowen token), so
 *  the handler OWNS its authentication (signature/JWT validation) and must reject anything unproven. */
export interface PluginHttpRoute {
  /** Mount path RELATIVE to `/hooks/<plugin>/` — lowercase segments, e.g. 'messages'. */
  path: string;
  handler: (req: PluginHttpRequest) => Promise<PluginHttpResponse>;
}

/** Who may call an authenticated plugin API route. `user` is any authenticated user; `admin` is the
 *  instance admin (setup-tolerant, like the core config routes). */
export type PluginApiAccess = 'admin' | 'user';

/** The verified caller identity the dispatcher attaches to an authenticated plugin API request. The
 *  daemon's global auth/tenancy middleware ran before the handler, so these values are trusted. */
export interface PluginApiAuth {
  /** The authenticated user id, or null in open (userless) mode. */
  userId: number | null;
  admin: boolean;
  tokenScope: 'user';
  /** Project ids the caller may see, or null for "not scoped". Null is a LIST-scoping answer, never an
   *  authorisation one: it covers the admin and open (userless) mode — where `admin` is true — but ALSO
   *  setup mode, where the users store exists with nobody in it yet and the request reaches the handler
   *  carrying no identity at all (`admin` false). A per-project gate must therefore read it as
   *  `accessibleProjects === null ? auth.admin : accessibleProjects.includes(id)`, which is what the
   *  core canAccessProject answered; taking a bare null for "allowed" hands an unauthenticated
   *  onboarding request every project on the instance. */
  accessibleProjects: number[] | null;
}

/** An authenticated inbound request to `/plugins/<plugin>/api/<path>`. */
export interface PluginApiRequest extends PluginHttpRequest {
  auth: PluginApiAuth;
  /** Values of ':param' segments when the route was registered with a PATTERN rootMount (e.g.
   *  '/items/:id' → { id }); empty object everywhere else. Already URL-decoded. */
  params: Record<string, string>;
}

/** An AUTHENTICATED API route a plugin exposes at `/plugins/<plugin>/api/<path>` — the first-class
 *  sibling of the public `/hooks` webhook surface. The daemon's bearer + tenancy middleware run before
 *  the handler and the declared `access` level is enforced by the dispatcher, so the handler starts from
 *  a verified identity instead of re-implementing auth. */
export interface PluginApiRoute {
  /** Mount path RELATIVE to `/plugins/<plugin>/api/` (or to `rootMount` when that is set) — lowercase
   *  segments; longest prefix wins. May be '' ONLY with rootMount (the mount itself). */
  path: string;
  /** Exact HTTP method (GET/POST/…); omitted = any method. */
  method?: string;
  access: PluginApiAccess;
  handler: (req: PluginApiRequest) => Promise<PluginHttpResponse>;
  /** Mount the route on the daemon's ROOT router at `<rootMount>/<path>` instead of under
   *  `/plugins/<plugin>/api/` — for a plugin that grandfathers a formerly-core API surface whose paths
   *  existing clients (web BFF, CLI) already call (for example a long-lived integration URL). Same auth/access mechanics as the
   *  namespaced surface. The full mount must be declared in the manifest's provides.apiRoutes (WITH the
   *  leading slash). A conflict with a core route or another plugin's mount is skipped with a warning —
   *  core always wins. Trust note: every installable plugin is admin-installed (bundled or via the
   *  admin-only marketplace), so a root mount does not cross a trust boundary the plugin surface does
   *  not already cross; there is deliberately no separate trust flag today. */
  rootMount?: string;
}

/** One editable prompt template a plugin contributes — the shape of a core catalog entry
 *  (src/prompts/catalog.ts). `name` is the bare template name (== `<name>.md` in the registered dir, and
 *  the per-user override key in `user_prompts`); `group` may extend the account UI's grouping. */
export interface PluginPromptEntry {
  name: string;
  group: string;
  /** Placeholders the template substitutes — surfaced in the editor so users keep them intact. */
  vars: string[];
  /** The model output is parsed as JSON downstream; the editor warns before an override. */
  jsonContract: boolean;
  /** The user's saved text is APPENDED to the default instead of replacing it. */
  appendOnly?: boolean;
}

/** A prepared statement over the shared main database, narrowed to what a plugin needs. Parameters are
 *  positional; results are untyped rows the plugin validates itself. */
export interface PluginDbStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
/** Raw SQL access over the shared main database (see {@link PluginDb}). */
export interface PluginDbHandle {
  exec(sql: string): void;
  prepare(sql: string): PluginDbStatement;
}
/** One ordered, run-exactly-once schema step. `up` runs inside an immediate transaction together with
 *  its bookkeeping row. Steps must be additive/idempotent-friendly — a rollback to an older plugin
 *  version simply ignores newer tables. */
export interface PluginDbMigrationStep { version: number; up(db: PluginDbHandle): void }
/** A plugin's handle on the MAIN SQLite database — gated by the `reads:['db']` capability. Tables the
 *  plugin creates should be namespaced `p_<plugin>_*` (convention; a grandfathered core-extraction
 *  plugin may keep its historical names). `migrate` is a no-op outside the daemon process. */
export interface PluginDb extends PluginDbHandle {
  migrate(steps: PluginDbMigrationStep[]): void;
  /** Highest applied migration version for this plugin (0 = none). */
  appliedVersion(): number;
  /** Run `fn` inside ONE transaction and return its value; nested calls nest as savepoints. A plugin
   *  that owns rows with invariants across several statements (create a parent, its children and their
   *  edges) needs this to make the sequence atomic — without it a partial write survives the failure of
   *  a later statement. Unlike better-sqlite3's `db.transaction`, this RUNS the function rather than
   *  returning a wrapped one, so a plugin cannot accidentally build a transaction and never call it. */
  transaction<T>(fn: () => T): T;
}

/** Core CLI invocation and daemon API reach-back for plugins that extend user-owned surfaces. */
export interface PluginElowenCli {
  /** Shell invocation of the CLI (`elowen`, or `node <path>` in a checkout). */
  cli: string;
  /** The same invocation as argv tokens, for direct `tmux -- <argv>` launches. */
  cliArgv: string[];
  /** Daemon base URL for API calls. */
  url: string;
  /** A token that acts as one real user, reused across restarts and undefined for an unknown id.
   *
   *  Read it at EXECUTE time from the acting identity and never capture it: a token captured at
   *  registration would let one user's turn act as whoever loaded the plugin. */
  tokenForUser(userId: number): string | undefined;
}

/** Read-only user view handed through host stores — identity only, no secrets, no mutation. */
export interface PluginUserView { id: number; username: string; isAdmin: boolean }

export interface PluginExternalUserInput {
  provider: string;
  tenantId: string;
  subjectId: string;
  preferredUsername: string;
  name?: string;
  email?: string;
}
export interface PluginExternalUserResult { user: PluginUserView; created: boolean }
export interface PluginExternalUserBinding {
  provider: string;
  tenantId: string;
  subjectId: string;
  user: PluginUserView;
  linkedAt: string;
}
export interface PluginExternalUserBindingInput {
  provider: string;
  tenantId: string;
  subjectId: string;
  userId: number;
  replace?: boolean;
}
/** Narrow account-write seam. External access/refresh tokens are deliberately absent from this contract. */
export interface PluginHostExternalUsers {
  /** Resolve the same platform identity chain the brain uses before a plugin starts a turn. Optional for
   * older/minimal hosts; callers must fall back to provider bindings only, never guess an account. */
  resolvePlatformUser?(platform: string, platformUserId: string, verifiedEmail?: string): PluginUserView | null;
  resolve(provider: string, tenantId: string, subjectId: string): PluginUserView | null;
  describe(provider: string, tenantId: string, subjectId: string): PluginExternalUserBinding | null;
  linkOrProvision(input: PluginExternalUserInput): PluginExternalUserResult;
  linkExisting(input: PluginExternalUserBindingInput): PluginExternalUserBinding;
}

/** Read-only platform stores exposed to plugins. These remain host infrastructure even when only a
 *  small number of plugins consume them: future integrations should reuse the core tenancy and identity
 *  decisions rather than query shared tables directly. */
export interface PluginHostStores {
  projects: { get(id: number): Project | null; list(): Project[] };
  /** The daemon's home project row (its own checkout). */
  homeProject(): Project;
  usersRead: {
    list(): PluginUserView[];
    isAdmin(id: number): boolean;
    /** The user's personal exec whitelist (empty = everything the global list allows), or null for an
     *  unknown user. Read-only — the identity view stays immutable by construction. */
    allowedExecs(userId: number): readonly string[] | null;
    /** Whether this account may use `plugin` right now — the core-owned decision, resolved live. */
    mayUsePlugin(userId: number, plugin: string): boolean;
  };
  eventsRead?: { list(opts: { target?: string; type?: string }): { detail: string }[] };
}

/** User-override-aware prompt rendering (the core PromptService): resolves a user's saved prompt
 *  override before the file default — the file default itself may come from this plugin's own
 *  registerPrompts() overlay. */
export interface PluginHostPrompts {
  render(name: string, vars?: Record<string, string>, userId?: number | null): string;
  rawTemplate(name: string): string;
  /** A user's SAVED override of a template, or null when they never edited it. Distinct from `render`,
   *  which resolves the override against the shipped default and substitutes vars. */
  userOverride(userId: number, name: string): string | null;
}

/** The project-file trust boundary kept in core. Plugins may implement file operations, but every path
 *  they receive must pass this exact lexical-and-symlink guard before touching disk. */
export interface PluginProjectFiles {
  safe(root: string, rel: string, forWrite?: boolean): string;
}

/** Narrow core infrastructure exposed to plugins. Every accessor is deny-by-default behind its own
 *  `reads` grant, and throws (never degrades) — a subsystem built on these cannot half-work. */
export interface PluginHost {
  // @platform-keep plugin-host-tmux :: tmux(): TmuxDriver
  /** Generic plugin platform retained for future github/sandblox consumers; zero in-repo callers is expected. */
  tmux(): TmuxDriver;
  // @platform-keep plugin-host-cli :: elowenCli(): PluginElowenCli && tokenForUser(userId: number): string | undefined
  /** Generic CLI/token platform retained for future github/sandblox consumers; zero in-repo callers is expected. */
  elowenCli(): PluginElowenCli;
  // @platform-keep plugin-host-identity-files-stores :: stores(): PluginHostStores && externalUsers(): PluginHostExternalUsers && projectFiles(): PluginProjectFiles && usersRead:
  /** Generic identity, project-file and read-store platform for future github/sandblox consumers; zero callers is expected. */
  stores(): PluginHostStores;
  externalUsers(): PluginHostExternalUsers;
  /** User-override-aware prompt rendering. Gated by `reads:['prompts']`. */
  prompts(): PluginHostPrompts;
  // @platform-keep plugin-host-relay :: relayClient(cfg: RelayConfig): InferenceClient
  /** Generic inference relay platform retained for future github/sandblox consumers; zero in-repo callers is expected. */
  relayClient(cfg: RelayConfig): InferenceClient;
  /** Read-only git helpers over a project checkout. Gated by `reads:['git']`. */
  git(): {
    /** Generic live checkout snapshot: sanitized remotes plus branch/head/upstream and worktree counts. */
    projectSnapshot(root: string): Promise<ProjectGitSnapshot>;
    projectHead(root: string): Promise<string>;
    projectRangeDiff(root: string, base: string, head: string): Promise<CommitFileChange[]>;
    /** The commits of `base..head` in that checkout. */
    projectRangeLog(root: string, base: string, head: string): Promise<CommitLogEntry[]>;
    /** Diff of ONE file across `base..head` — the click-through of a frozen change list. */
    projectRangeFileDiff(root: string, base: string, head: string, rel: string): Promise<string>;
    /** Diff of ONE file as introduced by a single commit (`git show <hash> -- <path>`). */
    projectCommitFileDiff(root: string, hash: string, rel: string): Promise<string>;
  };
  /** The web-push transport (send only — recipients are the plugin's own concern via usersRead).
   *  Gated by `reads:['push']`; wired late by bootstrap. */
  push(): PluginHostPush;
  // @platform-keep plugin-host-subagent-catalog :: subagentCatalog(): PluginSubagentCatalog
  /** Generic catalog platform retained for future github/sandblox delegation consumers; zero callers is expected. */
  subagentCatalog(): PluginSubagentCatalog;
  /** The canonical project path guard. Gated by `reads:['project-files']`; editor operations must use
   *  it instead of reproducing path traversal or symlink handling. */
  projectFiles(): PluginProjectFiles;
}

/** One row of the typed sub-agent catalog (see PluginHost.subagentCatalog). */
export interface SubagentCatalogEntry {
  name: string;
  description: string;
  /** The frontmatter tools spec: a preset keyword ('read-only' | 'all' | 'inherit') or a tool list. */
  tools: string | string[];
  source: 'builtin' | 'user';
  canDelete: boolean;
  /** User agents only — the body prompt, so an editor can prefill. */
  body?: string;
}

/** Outcome of a catalog write: ok, or a refusal with the HTTP status the editor surface should map
 *  it to (400 invalid, 404 unknown, 503 no writable dir). */
export type SubagentCatalogResult = { ok: true } | { error: string; status: 400 | 404 | 503 };

/** Editor over the typed sub-agent catalog (see PluginHost.subagentCatalog). Validation — name shape,
 *  built-in shadowing, size bounds, tools-spec + frontmatter parse — lives core-side with the
 *  registry parser that consumes these files. */
export interface PluginSubagentCatalog {
  list(): SubagentCatalogEntry[];
  /** Create or overwrite a user agent. Async: an explicit tool list is validated against the live
   *  merged registry. */
  save(name: string, input: { description?: unknown; tools?: unknown; body?: unknown }): Promise<SubagentCatalogResult>;
  remove(name: string): SubagentCatalogResult;
}

/** The request function a daemon-MCP tool handler receives — the shared `callElowenApi` core already
 *  bound to the CALLING MCP client's bearer token, throwing on a non-ok response with the same
 *  `elowen <status>: …` text agents have always seen. A tool can never act with wider rights than
 *  the client that invoked it. */
export type PluginMcpRequest = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** A tool contributed to the DAEMON'S OWN /mcp server — the endpoint spawned agents and the advisor
 *  connect to. (NOT the `mcp` bridge plugin, which CONSUMES external MCP servers.) The declaration
 *  carries the full MCP surface (name/description/zod input shape); `run` is a pure REST proxy over
 *  {@link PluginMcpRequest}, so the handler holds no state and works identically in the stateless
 *  per-request server. A disabled plugin's tools simply vanish from `tools/list` — the correct MCP
 *  semantics for an absent capability. */
export interface PluginMcpTool {
  /** Snake_case tool name (e.g. `external_search`) — unique across core + plugins. */
  name: string;
  description: string;
  /** Zod RAW shape — exactly what `McpServer.registerTool` takes as `inputSchema`. */
  inputSchema: Record<string, ZodTypeAny>;
  /** Pure REST proxy: parsed arguments + a request fn bound to the caller's token. */
  run(args: Record<string, unknown>, req: PluginMcpRequest): Promise<unknown>;
}

/** One row of the first-run readiness report (see PluginContext.registerReadinessCheck). */
export interface PluginReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

/** One persisted activity-log row (see PluginContext.registerEventRowResolver). `label` is an optional
 * human-readable snapshot for a target whose stable audit key is not useful presentation on its own. */
export interface EventPersistenceRow {
  type: string;
  target: string;
  detail: string;
  label?: string;
}

/** Send-only view of the core PushSender (see PluginHost.push). */
export interface PluginHostPush { sendToUsers(userIds: number[], payload: PushPayload): Promise<unknown> }

/** One compact plugin-owned status projected into the core Project register. The host bounds and
 * validates these values before returning them to the browser, and stamps the owning plugin itself. */
export interface PluginProjectIndicator {
  projectId: number;
  label: string;
  value?: string;
  icon?: string;
  tone?: 'muted' | 'accent' | 'success' | 'warning' | 'danger';
}

/** Batch request for Project indicators. `projects` is already tenancy-filtered by core, so a provider
 * never receives a Project the caller cannot see. `user` lets integrations resolve account-scoped state
 * without relying on ambient identity. */
export interface PluginProjectIndicatorRequest {
  projects: readonly Project[];
  user: { id: number; isAdmin: boolean } | null;
}
export type PluginProjectIndicatorProvider = (
  request: PluginProjectIndicatorRequest,
) => readonly PluginProjectIndicator[] | Promise<readonly PluginProjectIndicator[]>;

/** A plugin's browser UI (manifest `web` block, resolved by the loader): the built bundle on disk, its
 *  content hash (pins the immutable serving URL — a stale hash 404s), and the manifest's menu metadata. */
export interface PluginWebUi {
  plugin: string;
  /** Absolute path of the built ESM bundle on disk. */
  file: string;
  /** Short content hash of the bundle — part of the serving URL, so clients cache immutably. */
  hash: string;
  /** Absolute path of the plugin's OWN compiled stylesheet, when the manifest declared one and the file
   *  exists. Absent = the plugin paints with the host's utilities alone (how every plugin worked before
   *  this existed), which is unstyled for anything the prebuilt host CSS does not happen to carry. */
  cssFile?: string;
  /** Content hash of that stylesheet — its own immutable serving URL, independent of the bundle's. */
  cssHash?: string;
  requiresApiVersion: number;
  /** Browser navigation and assets are visible only to administrator accounts. */
  adminOnly?: boolean;
  /** Name of the plugin's world in the main navigation; absent = the world borrows its first page's. */
  label?: string;
  nav: { label: string; icon?: string; route?: string }[];
  account: { id: string; label: string; icon?: string }[];
  /** Administrator-only panels mounted for a selected core User. */
  user: { id: string; label: string; icon?: string }[];
  project: { id: string; label: string; icon?: string }[];
  settings: { id: string; label: string; icon?: string }[];
  /** Flat English view strings from the manifest `web.strings` block (bundle labels/hints). */
  strings?: Record<string, string>;
  /** Localized menu labels + view strings from `i18n/<lang>.json` `web` blocks: nav keyed by route,
   *  account/user/project/settings by id, strings by the manifest's own string keys. */
  i18n?: Record<string, { label?: string; nav?: Record<string, string>; account?: Record<string, string>; user?: Record<string, string>; project?: Record<string, string>; settings?: Record<string, string>; strings?: Record<string, string> }>;
}

/** Which of a plugin's OWN declared panels an account may see. An omitted key means "that surface is
 *  untouched" (every declared panel stays visible); an empty array hides all of them. Returning `null` from
 *  the probe means the same as registering none: everything visible.
 *
 *  Deliberately SYNCHRONOUS. The probe runs on every listing request, i.e. on every page load, so it must
 *  answer from state the plugin already holds — its own table, its config — and must never reach the
 *  network. An async signature would invite exactly the call that makes the whole menu wait on a third
 *  party. */
export type PluginUiVisibility = (req: { userId: number | null; isAdmin: boolean }) =>
  { account?: readonly string[]; project?: readonly string[] } | null;

/** A long-running background worker a plugin contributes — sweepers, watchers, pollers. The host
 *  owns the lifecycle: started after boot reconcile on a full daemon start (never in a sub-agent
 *  runner), stopped and restarted around a plugin reload, and abandoned at process exit (the daemon
 *  drains turns, not plugin loops). `stop` must be prompt — a stop that exceeds the host's grace window
 *  is logged and abandoned so one plugin cannot wedge a reload. */
export interface PluginService {
  /** Short name for logs, unique within the plugin (e.g. 'sync-loop'). */
  name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

/** A channel-scoped conversation reference — the SAME identity an adapter reports to `listen` (so a slash
 *  command targets the exact session a message from that channel would). */
export interface ChannelRef { platform: string; channelId: string; threadId?: string }

/** The control surface the host grants an adapter. Channel-scoped ops no-op on an unknown/idle channel. */
export interface PlatformControlApi {
  /** Live model, whether a turn is in flight, and context usage of the channel's session — or null when
   *  nothing is spawned. */
  status(ref: ChannelRef): { provider?: string; model: string; streaming: boolean; usage: { tokens: number | null; contextWindow: number; percent: number | null }; fast: boolean; fastAvailable: boolean } | null;
  /** Abort the channel's in-flight turn (no-op when idle). */
  abort(ref: ChannelRef): Promise<void>;
  /** Compact the channel session's context; resolves to `{ usage, compacted }` (null if no session).
   *  `compacted:false` is a benign no-op (nothing to compact yet), not an error — only a real compaction
   *  failure rejects, so the caller can tell "no session" from "nothing to do" from a genuine error. */
  compact(ref: ChannelRef): Promise<{ usage: { tokens: number | null; contextWindow: number; percent: number | null }; compacted: boolean; message?: string } | null>;
  /** Set/toggle ChatGPT OAuth priority processing for this channel. */
  setFast(ref: ChannelRef, on?: boolean): { fast: boolean; fastAvailable: boolean } | null;
  /** Admin-only daemon restart (attributed to the instance operator); rejects when restart isn't
   *  available on this deployment. The caller is responsible for its own admin gate. */
  restart(): Promise<void>;
  /** The invoking sender's OWN conversations eligible to bind into this channel (the /context picker),
   *  paginated. Identity-scoped to the sender's linked Elowen account (resolved from `senderPlatformId`);
   *  null when that sender is not linked to any account (they have no bindable sessions). The bare default
   *  conversation is excluded server-side. */
  listContext(ref: ChannelRef, senderPlatformId: string, opts: { limit?: number; offset?: number }): {
    items: { id: string; title: string; model: string; updated_at: string }[]; total: number; hasMore: boolean;
  } | null;
  /** Bind (MOVE) one of the sender's OWN conversations into this channel slot so the next channel turn
   *  continues in it. Resolves with the bound conversation's title (so the adapter can confirm which conversation was bound), or rejects on
   *  a guard failure (foreign/unknown/non-bindable session) or an unlinked sender. The caller is
   *  responsible for its own operator gate. */
  bindContext(ref: ChannelRef, senderPlatformId: string, sessionId: string): Promise<{ title: string }>;
  /** Run a synthetic platform message through the SAME identity, policy, durable session and locking path
   *  as inbound traffic. The adapter remains responsible for delivering the returned reply. */
  relay(src: SessionSource, text: string): Promise<string | undefined>;
}

/** Scoped logger handed to a plugin (prefixed with the plugin name by the registry). */
export interface PluginLogger { info(msg: string): void; warn(msg: string): void; error(msg: string): void }

/** A configured brain provider's usable credentials, resolved by id from the central provider list —
 *  so a plugin (voice STT/TTS, image gen) reads ONE shared key instead of duplicating it. `apiKey` is
 *  null for OAuth providers (no static key). */
export interface ProviderCredentials { id: string; label: string; type: string; baseUrl: string; apiKey: string | null }

export interface PluginModelOption {
  provider: string;
  providerLabel: string;
  model: string;
  default?: boolean;
  reasoningLevels?: string[];
  reasoningLabels?: Record<string, string>;
  fastAvailable?: boolean;
}

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

/** Shared shape of a plugin control that detaches a foreground wait (a delegate or a command) into
 *  background work. Both the subagent and terminal plugins register one under their own control key, so
 *  core calls them through the same typed contract instead of an `as unknown as` cast at each call site. */
export interface DetachControl {
  detachForeground(input: { sessionId: string; principal: string }): { detached: number };
}

/** Whole-lifecycle work held inside a plugin closure, including gaps between actual child turns. Core waits
 *  for this count to reach zero before replacing the registry during a hot reload. */
export interface ActiveCountControl {
  activeCount(): number;
}

/** The terminal plugin's stop-escalation seam: SIGKILL the process group of every still-foreground Bash
 *  run bound to this session+principal. Complements DetachControl — Ctrl+B moves the wait aside and keeps
 *  the command alive, this ends it so an already-aborted turn parked on the Bash tool can unwind (PI's
 *  agent loop only re-checks its abort signal between tool calls). The settled run reads as `[killed]`. */
export interface KillForegroundControl {
  killForeground(input: { sessionId: string; principal: string }): { killed: number };
}

/** The cronjob plugin's retention seam: the ids of a user's conversations that still have a PENDING
 *  one-shot wake-up scheduled INTO them (jobs recorded with that origin which have not fired yet —
 *  firing consumes the job, so presence in the plugin's store IS pendingness). The retention janitor
 *  excludes these ids from its stale sweep: purging the origin conversation would strand the wake-up's
 *  context and demote its reply to the notification channel. */
export interface PendingWakeupControl {
  pendingWakeupOriginSessionIds(userId: number): string[];
}

/** The workflow engine's abort seam. Aborting a parent turn tears down the node child sessions that are
 *  RUNNING (they sit in the abort tree), but the in-plugin engine would otherwise keep launching every
 *  node whose dependencies had already finished — fresh children born after the abort, which nothing
 *  tears down. Core calls this with the aborted origin session so the engine stops the DAG instead.
 *
 *  The same control also carries `detachForeground` (Ctrl+B): the engine and the sub-agent jobs live in
 *  ONE plugin, but the `workflow` control name is already taken here, so the workflow detach rides this
 *  control rather than a second registration. */
export interface WorkflowCancelControl {
  cancelForSession(input: { sessionId: string }): { cancelled: number };
}

/** The workflow engine's liveness seam: whether the in-plugin engine still holds this DAG (running, not
 *  finished). The durable workflow row is not authoritative for "running" — a failed terminal snapshot or
 *  a missed boot reconcile leaves it claiming `running` while the engine dropped the workflow long ago —
 *  and the origin PI session's liveness proves nothing about one specific DAG. Status reads consult this
 *  to decide whether a `running` row still deserves a synthetic transcript anchor. */
export interface WorkflowLivenessControl {
  isWorkflowLive(input: { workflowId: string }): boolean;
}

/** The exact delegable authorization boundary of the node requesting workflow expansion. */
export interface WorkflowExpansionCallerAccess {
  admin: boolean;
  projectIds: number[];
  owner: boolean;
  toolPolicy?: { allow?: string[]; deny?: string[] };
  permissionBoundary: NoninteractivePermissionBoundary | null;
  readOnly?: boolean;
}

/** Daemon-owned endpoint for a runner node's dynamic workflow expansion. Both caller fields are trusted only
 * because SubagentRunnerHost derives them from its own active turn table before invoking this control. */
export interface WorkflowExpansionControl {
  addNodesFromSession(input: {
    callerSessionId: string;
    callerAccess: WorkflowExpansionCallerAccess;
    callerModel?: { provider?: string; model?: string; thinkingLevel?: string };
    workflowId: string;
    nodes: unknown[];
  }): WorkflowAddNodesRpcResult;
}

/** Boot resume of a restart-orphaned workflow. Core claims the durable `running` DAG row at boot
 *  (reconcileDelegationsOnBoot) and asks the engine to take it back from the engine's own recovery
 *  journal — the durable row alone cannot drive a resume, its previews are clipped for display. The hooks
 *  replace the turn-scoped emitters a live WorkflowStart would have provided: `emit` persists fresh DAG
 *  snapshots, `complete` delivers the final summary through the durable delegated-result inbox (the
 *  origin's blocking turn did not survive the restart, so every resumed workflow completes as background
 *  work), `stopChild` is the ownership-guarded node teardown WorkflowStop needs. `{ resumed: false }`
 *  (missing/invalid journal, run handler not connected) tells core to terminalize the row exactly as the
 *  pre-resume boot sweep always did. */
export interface WorkflowRecoveryControl {
  resumeInterrupted(input: {
    workflowId: string;
    parentSessionId: string;
    toolCallId: string;
    hooks: {
      emit: (update: WorkflowUpdate) => void;
      complete: (completion: WorkflowCompletion) => void;
      stopChild: (childSessionId: string) => Promise<{ stopped: boolean }>;
      /** The journal lives on DISK, writable by the same uid the agent's tools run as, so a boundary read
       *  from it is UNTRUSTED authority. Core re-validates every journaled boundary (the workflow's
       *  parentAccess and each dynamically-added node's) against the origin user's authority AS IT STANDS
       *  AT BOOT — the engine must refuse the whole resume on the first `ok: false` and may never widen
       *  from disk. Fail closed: an origin user who no longer exists, or no longer holds what the journal
       *  claims, terminates the workflow instead of replaying stale (or tampered) authority. */
      validateBoundary: (access: unknown) => { ok: boolean; reason?: string };
    };
  }): Promise<{ resumed: boolean; reason?: string }>;
}

/** One MCP server as the plugin's live table reports it. Core reads only the two fields a chat client's
 *  telemetry rail renders; the plugin's own admin surface serves the full record (tools, last error). */
export interface McpServerState { name: string; status: string }

/** The MCP plugin's read-only listing seam: which servers this daemon is configured to talk to, and
 *  whether each is currently connected. Daemon-global state, so every caller applies its own gate. */
export interface McpListControl {
  listServers(): McpServerState[];
  /** The bridged tool DEFINITIONS this process currently holds, for a forked sub-agent runner to declare
   *  the identical tool set without connecting anything (see plugins/mcpSnapshot.ts). Read at fork time,
   *  never cached: a runner then mirrors the daemon's live registry by construction. */
  bridgeSnapshot(): McpBridgeSnapshot;
}

/** The lsp plugin's read-only state seam — the ONE thing core still asks the extracted LSP subsystem:
 *  whether live diagnostics are currently on, so GET /brain/status can carry the Active/Inactive flag a
 *  chat client renders next to its `/lsp` toggle. No control is offered (the toggle is a write to the
 *  plugin's own config slice, which hot-reloads it), and an absent control — the plugin disabled —
 *  makes core omit the field entirely, which every client already renders as "no LSP row". */
export interface LspStateControl {
  diagnosticsEnabled(): boolean;
}

/** One account-owned Sandbox worktree root. Core consumes only the ownership tuple needed to extend the
 * canonical path policy; richer Git state stays live in the owning plugin. */
export interface SandboxWorkspaceRoot {
  workspaceId: string;
  projectId: number;
  path: string;
}

/** The active workspace metadata another domain (notably GitHub) needs without reading Sandbox tables. */
export interface SandboxWorkspace extends SandboxWorkspaceRoot {
  label: string;
  branch: string;
  baseRef: string;
}

/** A durable execution lease minted before a child is spawned. The caller owns its actual process lifecycle:
 * heartbeat while the child is alive, transfer the same handle when foreground work detaches, and release it
 * only on spawn failure or real exit/error/kill. Implementations persist the row in shared SQLite so daemon
 * and forked runners observe the same blockers. */
export interface SandboxExecutionLease {
  id: string;
  accountUserId: number | null;
  workspaceId: string | null;
  homeGeneration: number | null;
  heartbeat(): void | Promise<void>;
  release(): void | Promise<void>;
}

export type SandboxExecutionCommand =
  | { type: 'shell'; command: string }
  | { type: 'argv'; file: string; args: string[] };

/** Fully prepared launch. `launch` is the only process shape a consumer spawns; HOME, roots and confinement
 * policy have already been applied by Sandbox. */
export interface SandboxPreparedExecution {
  mode: 'confined' | 'direct';
  cwd: string;
  home: string;
  roots: string[];
  launch:
    | { type: 'shell'; command: string; env: Record<string, string> }
    | { type: 'argv'; file: string; args: string[]; env: Record<string, string> };
  workspace: SandboxWorkspace | null;
  lease: SandboxExecutionLease;
}

/** Live Sandbox domain seam. Consumers resolve it on every use; retaining a value across plugin reloads is
 * invalid because its DB/runtime generation may already have been replaced. */
export interface SandboxControl {
  workspaceRoots(input: { projectIds: readonly number[] }): SandboxWorkspaceRoot[];
  /** The same lookup for an EXPLICITLY named account, for callers that have no ambient identity to read.
   *  `workspaceRoots` resolves the account from the current contribution/identity scope, which is exactly
   *  what a background service does not have: `registerInterval` and `registerService` run with
   *  `currentIdentity()` and `currentContributionUserId()` both null. A worker that must act on behalf of
   *  many accounts therefore cannot use the ambient form at all, and passing the account explicitly is the
   *  only honest way to say whose workspaces are meant. Omitting `projectIds` means every project. */
  workspacesFor(input: { userId: number; projectIds?: readonly number[] }): SandboxWorkspace[];
  activeWorkspace(input: { sessionId: string; projectId: number }): SandboxWorkspace | null;
  prepareExecution(input: {
    command: SandboxExecutionCommand;
    cwd: string;
    leaseKind: 'terminal' | 'github';
  }): SandboxPreparedExecution | Promise<SandboxPreparedExecution>;
}

/** Options a Microsoft Graph call accepts, mirroring the delegated client the Teams plugin already owns. */
export interface MicrosoftGraphRequestOptions {
  body?: unknown;
  contentType?: string;
  accept?: string;
  ifMatch?: string;
  headers?: Record<string, string>;
  maxBytes?: number;
}

/** A delegated Graph client already NARROWED to the signed-in person's drive namespace. Paths are relative
 *  to the Graph version root (`/me/drive/...`, `/drives/...`); anything outside that namespace is refused by
 *  the implementation, so holding this object cannot become a way to read someone's mail, calendar or
 *  directory. The identity owner decides the blast radius — a consumer never sees the access token. */
export interface MicrosoftDriveGraph {
  json(method: string, path: string, options?: MicrosoftGraphRequestOptions): Promise<unknown>;
  binary(path: string, options?: MicrosoftGraphRequestOptions): Promise<{ body: Uint8Array; contentType: string }>;
  request(method: string, path: string, options?: MicrosoftGraphRequestOptions): Promise<Response>;
}

/** Whether an Elowen account is bound to a verified Microsoft identity, and who that is. */
export interface MicrosoftIdentity {
  linked: boolean;
  upn?: string;
  displayName?: string;
}

/** Live Microsoft identity seam, owned by whichever plugin holds the tenant's delegated connection.
 *
 *  Both methods take the account EXPLICITLY rather than reading an ambient scope, because the callers that
 *  need them are background workers and HTTP routes, neither of which carries a turn identity. That makes
 *  this a different authorization model from the chat tools, which stay bound to the person actually
 *  talking: reaching it requires plugin code inside the daemon's trust domain, and what it hands back is
 *  already narrowed to drive paths. */
export interface MicrosoftIdentityControl {
  /** Cheap and LOCAL — no network. Safe to call on a request path that renders a page. */
  identityFor(elowenUserId: number): MicrosoftIdentity;
  /** A fresh delegated client, or null when the account is unlinked, the connection is not configured, or
   *  the person must sign in again. Never throws for the ordinary "not connected" case. */
  driveGraphFor(elowenUserId: number): Promise<MicrosoftDriveGraph | null>;
}

/** The controls whose shape core needs to CALL by key. `registerControl` stays generic (a plugin may
 *  register any control), but `PluginRegistry.control(name)` returns these known keys already typed —
 *  the single place the registry narrows an opaque `PluginControl` to a usable contract. */
export interface KnownControls {
  subagent: DetachControl & ActiveCountControl;
  terminal: DetachControl & KillForegroundControl;
  cron: PendingWakeupControl;
  workflow: WorkflowCancelControl & DetachControl & ActiveCountControl & WorkflowLivenessControl & WorkflowExpansionControl & WorkflowRecoveryControl;
  mcp: McpListControl;
  lsp: LspStateControl;
  sandbox: SandboxControl;
  microsoftIdentity: MicrosoftIdentityControl;
}

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
  surfaces?: SlashSurface[];
}

/** Placement of volatile plugin context relative to the user's own text. Context is always ephemeral:
 *  it is sent to the model for the current turn but is never persisted into conversation history. */
export type TurnContextPlacement = 'before-user' | 'after-user';

/** Options for a per-turn context provider. Existing plugins remain before-user by default. */
export interface TurnContextOptions {
  placement?: TurnContextPlacement;
}

/** One registered per-turn context provider plus its stable prompt placement. */
export interface TurnContextContribution {
  render: () => string;
  placement: TurnContextPlacement;
}

/** One notification target returned by a platform plugin. `id` is the platform's opaque delivery id;
 * core adds the encoded `value` used by config and cron storage before serving the row to the web UI. */
export interface NotificationDestination {
  id: string;
  kind: 'channel' | 'thread' | 'chat' | 'person';
  label: string;
  group?: string;
  subtitle?: string;
}

/** Admin-facing normalized destination row served by `GET /plugins/destinations`. */
export interface NotificationDestinationOption extends NotificationDestination {
  value: string;
  platform: string;
}

/** A platform plugin's live destination catalog. Listing may call the upstream platform and is therefore
 * asynchronous; failures are isolated per provider by the registry. */
export interface NotificationDestinationProvider {
  platform: string;
  list(): NotificationDestination[] | Promise<NotificationDestination[]>;
}

/** What a plugin's `register(ctx)` receives. Every `register*` call feeds the shared PluginRegistry. */
export interface PluginContext {
  /** Contribute a tool. `ownerUserId` scopes it to ONE Elowen account: it is then composed only into
   * that account's own/direct/delegated sessions. Omitted → instance-wide, as before. */
  registerTool(tool: ToolDefinition, opts?: { ownerUserId?: number }): void;
  /** Contribute a skill. `ownerUserId` scopes it to ONE Elowen account: it is then advertised (and
   *  `/skill:` expandable) only in that user's own sessions. Omitted → instance-wide, as before. */
  registerSkill(skill: PluginSkill, opts?: { ownerUserId?: number }): void;
  /** Ask the host to reload the plugin set so a runtime change a tool just made to disk (e.g. the skills
   *  plugin's CreateSkill/DeleteSkill writing to its data dir) is applied live. Deferred + coalesced: the
   *  host re-scans and respawns sessions once the current turn settles, so the new/removed skill is in
   *  the model's available-skills block on the next message. No-op when the host wires no reloader. */
  requestReload(): void;
  /** Register an admin/runtime control surface for this plugin. Unlike tools, controls are called by
   *  daemon routes and operate on the LIVE loaded plugin instance.
   *
   *  `opts.requires` names another control this one is BUILT ON. While that dependency has no valid owner,
   *  this control
   *  does not resolve at all: `PluginRegistry.control()` answers undefined, exactly as it does for a
   *  disabled plugin, and every consumer degrades down the path it already has for that case. Without it
   *  a dependent subsystem stays reachable and answers with half a runtime instead of reporting that its
   *  required capability is unavailable. */
  registerControl(name: string, control: PluginControl, opts?: { requires?: string }): void;
  /** Hide some of THIS plugin's own `web.account` / `web.project` panels from an account that has no use
   *  for them. The manifest still declares every panel the plugin can ever show; this decides, per account,
   *  which of them are real right now — a panel whose whole purpose depends on a connection that account
   *  does not have should not advertise itself as an empty tab.
   *
   *  Filtering happens SERVER-side in the listing the web builds its menus from, so a hidden panel is not
   *  merely unpainted: its id never reaches the browser. It is presentation, not authorization — a hidden
   *  panel's API routes keep their own `access` checks, because a client can still call them directly.
   *
   *  A probe that throws is treated as "hide this plugin's panels" and warned, never as a reason to fail
   *  the listing: one plugin's bad probe must not empty everybody's menu. */
  registerUiVisibility(fn: PluginUiVisibility): void;
  /** Resolve ANOTHER plugin's registered control — the one supported way one plugin reaches a capability
   *  a sibling owns. Gated by `reads:['controls']`.
   *
   *  Returns `undefined` — never throws — when nobody registered that control or the registration does
   *  not carry the whole contract: "the owner is switched off" is a legitimate runtime state the caller
   *  must degrade honestly for (refuse the operation, report the subsystem unavailable), not an error to
   *  swallow. Resolution happens AT CALL TIME against the merged registry, so plugin load order does not
   *  matter and a reload is picked up automatically. For exactly that reason the result must NEVER be
   *  cached in a variable: call it again on every use, or you are holding a dead generation. */
  control<K extends keyof KnownControls>(name: K): KnownControls[K] | undefined;
  /** Contribute a chat slash command (a prompt macro) that shows up in every surface's command menu.
   *  Refused (and warned) if the name is not kebab-case, shadows a built-in, or collides with another
   *  plugin's command. */
  registerCommand(command: PluginCommand): void;
  /** Core chat command metadata for a platform: built-ins + plugin prompt commands, each with its `kind`
   *  (how to render it) AND its `execution` (which mechanism runs it) — together the whole answer to
   *  "do I accept this command, and how?", so an adapter needs no name list of its own to decide. A
   *  `session-control` non-picker is a control command for the shared control core; a `prompt` macro is
   *  routed RAW to the brain; a `surface-local` picker is the adapter's own chooser.
   *
   *  Adapters own presentation only; names/help/kind/execution live once in the canonical slash-command
   *  catalog (src/brain/slashCommands.ts). `argument` rides along only where the accepted values are the
   *  same on every surface publishing the command, so an adapter can build its option schema from it
   *  instead of restating the values. */
  chatCommands(surface: PlatformSurface): {
    name: string;
    description: string;
    kind: SlashCommandDef['kind'];
    execution: SlashExecution;
    adminOnly?: boolean;
    argument?: SlashArgument;
  }[];
  /** Append a chunk of instructions to the brain's system prompt, after the Elowen persona. */
  registerSystemPromptFragment(fragment: string): void;
  registerHook(hook: PluginHook): void;
  /** Register a provider of EPHEMERAL per-turn context (date/time, live status…). Its string is injected
   *  into each user message — NOT the system prompt — so the cacheable prompt prefix stays stable.
   *  Defaults before the user's text; use `placement: 'after-user'` for adjacent reminders that should
   *  follow the request they qualify. */
  registerTurnContext(fn: () => string, options?: TurnContextOptions): void;
  /** STUB: record a platform adapter (not started by the foundation). */
  registerPlatform(adapter: PlatformAdapter): void;
  /** Contribute admin-selectable proactive-notification targets for this platform. Deny-by-default: the
   *  platform must be declared in `manifest.provides.destinations`. */
  registerNotificationDestinationProvider(provider: NotificationDestinationProvider): void;
  /** Expose an inbound webhook on the daemon at `/hooks/<plugin>/<path>`. Deny-by-default: the path must
   *  be declared in the manifest's `provides.httpRoutes`. The mount skips bearer auth — the handler owns
   *  its own authentication (see {@link PluginHttpRoute}). */
  registerHttpRoute(route: PluginHttpRoute): void;
  /** Expose an AUTHENTICATED API route on the daemon at `/plugins/<plugin>/api/<path>`. Deny-by-default:
   *  the path must be declared in the manifest's `provides.apiRoutes`. The daemon's bearer + tenancy
   *  middleware run first and the dispatcher enforces the declared access level, so the handler receives
   *  a verified {@link PluginApiAuth} instead of re-implementing auth (see {@link PluginApiRoute}). */
  registerApiRoute(route: PluginApiRoute): void;
  /** Contribute a host-managed background service (see {@link PluginService}): started after boot
   *  reconcile on a full daemon start, stopped/restarted around plugin reloads. The first-class home for
   *  what plugins used to smuggle into fake platform adapters' connect/disconnect. */
  registerService(service: PluginService): void;
  /** The shared main database (see {@link PluginDb}). Throws unless the manifest declares the
   *  `reads:['db']` capability — DB reach is a real grant, not a default. */
  db(): PluginDb;
  /** Host capabilities for core-subsystem extraction (see {@link PluginHost}). Each accessor carries
   *  its own deny-by-default `reads` grant. */
  host: PluginHost;
  // @platform-keep plugin-prompts :: setPluginPromptSources && registerPrompts(opts:
  /** Generic prompt platform retained for future github/sandblox consumers; zero in-repo callers is expected. */
  registerPrompts(opts: { dir: string; entries: PluginPromptEntry[] }): void;
  // @platform-keep plugin-events :: publishEvent(event: ElowenEvent) && deleteEventsForTarget(target: string) && registerEventRowResolver(resolve:
  /** Generic event platform retained for future github/sandblox consumers; zero in-repo callers is expected.
   *
   * Publish an event onto the daemon's event bus (SSE + activity log). Core-shaped events keep their
   *  exact core contract (consumers cannot tell the publisher moved into a plugin); a `type:'plugin'`
   *  event carries its own tenancy in `projectId` (null = admins only) and its `plugin` field is
   *  overwritten with the publishing plugin's name. Gated by `mutates:['events']`; throws unwired. */
  publishEvent(event: ElowenEvent): void;
  /** Purge the activity-log rows of one target — what a plugin owes the feed when it deletes the thing
   *  those rows describe, so a removed row leaves no history pointing at
   *  nothing. The write twin of `host.stores().eventsRead`, and gated by the same `mutates:['events']`
   *  grant as publishing: both decide what a tenant sees in the feed. A no-op in a process without an
   *  event store. */
  deleteEventsForTarget(target: string): void;
  /** Contribute a resolver mapping an event this plugin owns to its persisted activity-log row.
   *  Consulted only for events core does not persist itself; first claim
   *  wins, exceptions are skipped, and returning null/undefined leaves the event unpersisted. Keep
   *  the emitted `type` strings stable: old rows are read back by the same names. Gated by
   *  `mutates:['events']`. */
  registerEventRowResolver(resolve: (event: ElowenEvent) => EventPersistenceRow | null | undefined): void;
  /** Contribute compact Project-register status in one server-side batch. Core supplies only Projects the
   * caller may see and bounds the returned labels/values, so plugins never need a browser request per row. */
  registerProjectIndicators(provider: PluginProjectIndicatorProvider): void;
  /** Contribute a row to GET /system/readiness — the onboarding "does each subsystem actually work"
   *  report. Runs on every readiness request while the plugin is enabled (a disabled plugin's checks
   *  disappear with it, which is itself the honest answer); return null to skip, and a throwing check
   *  is dropped for that request. Keep it cheap and synchronous-ish: this rides a UI read. */
  registerReadinessCheck(check: () => PluginReadinessCheck | null | Promise<PluginReadinessCheck | null>): void;
  /** Contribute a tool to the daemon's OWN /mcp server (see {@link PluginMcpTool}). STRICT
   *  deny-by-default: the name must be declared in the manifest's `provides.mcpTools` — the manifest
   *  stays the single audit surface for what a plugin exposes to connected MCP clients. The /mcp
   *  server is composed per request from the LIVE registry, so a reload or disable applies to the
   *  very next `tools/list` without any cache to invalidate. */
  registerMcpTool(tool: PluginMcpTool): void;
  /** Subscribe to the daemon's event bus (usage recording, push dispatch — bus CONSUMERS that moved
   *  into a plugin). Gated by `mutates:['events']`. Returns the unsubscribe; the host also detaches
   *  every subscription of the OLD registry on a plugin reload, so a stale closure can never
   *  double-handle events beside its replacement. */
  subscribeEvents(fn: (event: ElowenEvent) => void): () => void;
  /** Run once BEFORE the daemon starts serving platform turns — and again after every plugin reload —
   *  to reconcile durable state with reality (re-park watchers, terminalize orphans). Must be
   *  idempotent. Reconciles run sequentially, in registration order; a throw is logged and does not
   *  block the boot (same contract as the core boot reconciles). */
  registerBootReconcile(fn: () => void | Promise<void>): void;
  /** Drop everything the plugin keeps for an Elowen ACCOUNT that is being deleted — its schedules, its
   *  files under `dataDir()`, its rows. Called with the account's id while the user row still exists,
   *  so a handler may still read it; a throw is logged and the remaining handlers still run.
   *
   *  Registering this is mandatory for any plugin that stores per-user state. Nothing else ever reaps it:
   *  the id is never handed out twice (see the user-sequence guard in store/db.ts), so a leftover folder
   *  or row is unreachable rather than misattributed — it simply keeps that person's files, secrets and
   *  schedules on the operator's machine forever, and a schedule keeps costing model calls. */
  registerUserRemoved(fn: (userId: number) => void | Promise<void>): void;
  /** React to removal of a core Project while its id is still known. Plugin-owned boot reconciliation is
   * still required because a plugin that was disabled when the deletion happened cannot receive this. */
  registerProjectRemoved(fn: (projectId: number) => void | Promise<void>): void;
  /** Sugar over {@link registerService} for the common periodic-tick shape: the host owns a real timer
   *  (unref'd — a plugin tick must not keep the process alive), starts it with the services and clears
   *  it on stop/reload. A tick that throws is logged and the interval keeps running. */
  registerInterval(name: string, fn: () => void | Promise<void>, ms: number): void;
  /** Resolve + assert a filesystem path is inside the current user's accessible repos, returning the
   *  absolute path (throws otherwise). File/terminal tools call this before any disk access. Evaluated at
   *  tool-call time against the per-session Policy carried on AsyncLocalStorage. */
  assertPathAllowed(path: string): string;
  /** The repo roots the current session may operate in (empty for an admin's all-access). Used to default
   *  a tool's working directory. */
  allowedRoots(): string[];
  /** Every tool name currently registered across ALL plugins (the live merged registry, read lazily — so
   *  it is complete by tool-execute time even though plugins register one at a time). A plugin that
   *  accepts tool names as INPUT validates them against this, so a typo becomes an error the model can fix
   *  instead of a silently narrower toolset (see the subagent plugin's `tools` allow-list). */
  toolNames(): string[];
  /** The operator's configured IANA timezone — the ONE place "what time is it for this user" is answered.
   *  Everything that reasons about wall-clock time reads it from here (the injected date/time context, and
   *  every cron schedule), so a job set for "daily 07:30" fires at 07:30 where the USER lives, not wherever
   *  the server happens to be hosted. Falls back to the host's own zone when unset. Read live, so an
   *  operator changing it applies on the next call. */
  timezone(): string;
  /** Total characters of parent-supplied context a plugin may attach to a delegated child (Settings →
   *  Elowen AI → Limits). The delegating plugin owns HOW it spends the budget — how many chunks, and how
   *  it divides them between a workflow node's dependencies — but the ceiling is the operator's, so
   *  raising it does not mean editing a plugin. Read live, so a change applies on the next delegation
   *  without a restart. Falls back to the configured default when nothing is wired. */
  delegateContextChars(): number;
  /** Bridged MCP tool definitions handed down by the process that forked this one, or undefined when
   *  nothing was handed down (every normal daemon). Present ONLY in a sub-agent runner: the `mcp` plugin
   *  registers exactly these instead of connecting every configured server at boot, and connects a server
   *  on the first call to one of its tools. Read once, at register time — it describes the forking
   *  process's registry at the instant of the fork. */
  mcpBridgeSnapshot?: McpBridgeSnapshot;
  /** The working directory an exec/file tool uses when the caller names none: the project path the
   *  current turn's session is bound to, else the first allowed root, else
   *  the daemon's own cwd. Evaluated per tool call against the per-run turn scope, so a directory the
   *  agent moved to in an earlier run never leaks into the next one. */
  defaultCwd(): string;
  /** The project path the current turn's session is BOUND to, or undefined when it is bound to none —
   *  the first term of {@link defaultCwd}, without its fallbacks. A plugin that needs to know whether
   *  the turn actually names a directory (rather than "some directory to run in") must read this: the
   *  fallbacks answer with an allowed root, or the daemon's own cwd (`/` under systemd), and a plugin
   *  treating either as "the caller's project" reasons about a scope the turn never chose. */
  workDir(): string | undefined;
  /** Per-plugin writable data directory (created on first call) — cron job files, generated images… */
  dataDir(): string;
  /** Whether the CURRENT turn has all-project policy. This may come from a foreign platform admin role;
   *  owner-only shared state must gate on `currentIdentity().owner`, not this predicate. */
  isAdminSession(): boolean;
  /** The current turn's complete delegable authorization descriptor. `owner` is independent from admin,
   *  toolPolicy carries exact allow+deny sets, and permissionBoundary carries the effective unattended
   *  granular-rule context so a child inherits exactly the caller's scope. `readOnly` is stamped by the
   *  host when the caller's turn is PLANNING — forward it untouched; never clear it. */
  currentAccess(): { projectIds: number[]; admin: boolean; owner: boolean; toolPolicy?: { allow?: string[]; deny?: string[] }; permissionBoundary: NoninteractivePermissionBoundary | null; contributionUserId?: number | null; readOnly?: boolean };
  /** Who is driving the current turn (platform sender, resolved Elowen account, admin flag) — plugins
   *  that persist per-user state (long-term memory) key it on this. Null outside a prompt turn. */
  currentIdentity(): TurnIdentity | null;
  /** WHOSE owner-scoped contributions the current turn may reach — the account id a plugin holding
   *  per-account content (personal skills) must resolve its caller through, or null for the instance-wide
   *  set. The host decides it once per turn from the session and its verified writer, and the SAME answer
   *  drives what the host advertises to the model, so a tool reading this can never offer less (or more)
   *  than the model was told about. Deliberately not `currentIdentity().elowenUserId`: a delegated child
   *  carries no account identity yet legitimately inherits its delegating turn's contributions. */
  currentContributionUserId(): number | null;
  /** The persisted brain-session id the current turn runs in (`brain-…`), or undefined outside a
   *  prompt turn. Lets a plugin bind scheduled work back to the exact conversation it was created
   *  from (a cron wake-up records it as the job's origin and the reply lands there). */
  currentSessionId(): string | undefined;
  /** Opaque outbound destination for the current verified direct platform chat. Persist and return it to
   *  the host for scheduled delivery; never parse or construct it. Undefined elsewhere. */
  currentDeliveryTarget(): string | undefined;
  /** The sub-agents THIS conversation already delegated, newest first — its own durable record of what
   *  it ran, surviving daemon restarts and the delegating plugin's in-memory job table. Scoped by the
   *  host to the current turn's session: the plugin names no parent and cannot widen it, so a sibling
   *  conversation's or another account's children are not merely hidden but unaddressable. Empty outside
   *  a prompt turn, or when nothing is wired. */
  subagentRuns(limit?: number): DelegatedChildSummary[];
  /** Translate a delegation JOB id (`dlg-…`, the handle Delegate returns) into the child SESSION id the
   *  durable calls above take. The delegating plugin holds the job→session map only in memory, so a
   *  follow-up by job id stops resolving after a restart; the session id is a pure function of the job id
   *  (the host owns that shape), so this rebuilds it without the plugin hard-coding the prefix. Pure
   *  string derivation — it does NOT assert the session exists; {@link readSubagent}/{@link continueSubagent}
   *  still apply the ownership guard, exactly as when the caller passes a session id straight. */
  subagentSessionForJob(jobId: string): string;
  /** Read the final stored assistant text of a sub-agent listed by {@link subagentRuns}. The host anchors
   *  the lookup to the current turn's session; the plugin supplies only the child id and cannot widen the
   *  parent scope. Throws for unknown/foreign children, invalid delegated scope, or no final text yet. */
  readSubagent(sessionId: string): string;
  /** Send a follow-up to a sub-agent listed by {@link subagentRuns}. The child resumes its own transcript
   *  with full context preserved — this is how a delegating agent refines a finished sub-agent's work
   *  instead of respawning one that has to rediscover everything.
   *
   *  An IDLE child runs the follow-up as its own turn and the call resolves `{status:'reply'}` with that
   *  turn's answer. A child whose turn is IN FLIGHT is not refused: the message is steered into the
   *  running turn (the same primitive a user steering their agent rides) and the call resolves
   *  `{status:'steered'}` once the message has provably entered the child's context — the child folds it
   *  into the work in progress and its (updated) result arrives through the delegation's normal result
   *  path, so no separate reply exists.
   *
   *  Rejects when the id is not a child of this conversation, when its captured scope would now grant
   *  more than this conversation itself holds, when a `model` switch targets a mid-turn child (a running
   *  turn cannot change model), or when the child is busy between model steps (starting up, or collecting
   *  background work) — that state cannot take a steer and a retry moments later succeeds. A continuation
   *  replays the child's ORIGINAL immutable boundary, narrowed by the caller's current denies — it can
   *  never widen access.
   *
   *  `promote` is the single exception, and it is never implicit: it lifts a child that was spawned
   *  read-only BY THE CALLER'S OWN CHOICE up to exactly what this turn holds right now (see
   *  promoteDelegatedScope for every rule, and note that this rewrites the child's durable scope, so the
   *  widening persists for its later turns too). Rejected for a mid-turn child — a running turn keeps the
   *  toolset it started with — and for a clamp the caller did not choose or did not create.
   *
   *  `onEvent` receives the child's live progress (tool starts, token usage) so the follow-up shows as a
   *  running sub-agent in the CLI rail / web table, the same way the first delegation does — omit it and
   *  the continuation still runs, just invisibly.
   *
   *  `model` optionally overrides the model the sub-agent runs on, as a `provider/model` string (value
   *  from {@link listModels}); omit it to resume on the model recorded on the child's session row. */
  continueSubagent(sessionId: string, text: string, onEvent?: (e: SubagentProgressEvent) => void, model?: string, promote?: boolean): Promise<DelegatedContinueResult>;
  /** Stop a DIRECT sub-agent listed by {@link subagentRuns} — a runaway or no-longer-needed one — without
   *  touching its parent or siblings. The host anchors the lookup to the current turn's session, exactly
   *  like {@link readSubagent}; the plugin supplies only the child id and cannot widen the parent scope.
   *  Stopping a child also tears down whatever it itself delegated (the same recursive teardown a platform
   *  `/stop` does), so a foreground-blocked middle agent and the grandchild it is stuck on come down
   *  together. Resolves `{stopped: false}` rather than throwing when the child already finished or never
   *  started — there is nothing to stop, which is not an error. Throws for an unknown/foreign child. */
  stopSubagent(sessionId: string): Promise<{ stopped: boolean }>;
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
  /** Deliver a user's answer to a parked AskUserQuestion back to its waiting turn — for interactive
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
  /** The daemon-level background-process registry (`Bash(background:true)` children). The terminal
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
  /** Host-only durable completion sink. Capture it in the parent turn before spawning a child. */
  subagentCompletionEmitter(): SubagentCompletionEmitter | null;
  /** The current turn's live workflow-snapshot emitter, or null when the transport wired none. The
   *  workflow engine MUST capture this BEFORE scheduling nodes: each update fans out to the parent's
   *  clients as a `workflow` BrainEvent (the CLI/web Workflow panel + drill-in modal). */
  workflowEmitter(): WorkflowEmitter | null;
  /** Host-only durable completion sink for a detached/background workflow. Capture it in the parent
   *  turn before scheduling nodes, mirroring subagentCompletionEmitter. */
  workflowCompletionEmitter(): WorkflowCompletionEmitter | null;
  /** True when a delegated child turn dispatched from THIS process may execute in a forked sub-agent
   *  runner process (Settings → runtime.subagentRunnerEnabled, pool usable). Read live per delegation. */
  delegatedTurnsOutOfProcess(): boolean;
  /** Whether such a remote child has the reverse workflow-expansion RPC. A false answer is load-bearing:
   *  the workflow engine denies WorkflowAddNodes in the child's effective tool policy. */
  delegatedWorkflowExpansionAvailable(): boolean;
  /** Runner-only client for the reverse RPC. Null in the daemon and in ordinary in-process contexts, and
   *  null for any plugin that did not declare `mutates:['workflow-dag']` in its manifest. */
  workflowExpansionRpc(): WorkflowExpansionRpc | null;
  /** The provider entry id + model the CURRENT turn's session runs on, or null outside a prompt turn —
   *  a delegating plugin uses it to default the child to "the same model as me". */
  currentModel(): TurnModel | null;
  /** Pickable brain models across every configured provider (feeds the Discord /model dropdown).
   *  Empty when nothing is wired. */
  listModels(): Promise<PluginModelOption[]>;
  /** The available typed sub-agents (built-in explore/plan + user `.md` types) — name + one-line
   *  description. SYNCHRONOUS on purpose: the subagent plugin composes its Delegate tool description from
   *  this at register time. Empty when nothing is wired (e.g. direct-contextFor unit tests). */
  subagentTypes(): { name: string; description: string }[];
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
  /** The CURRENT account's own values for this plugin (its `userConfigSchema` fields), secrets included
   *  daemon-side. Resolved from the turn/request identity — a plugin cannot name a user and read someone
   *  else's values. Returns `null` when the caller is not acting as an account (a system turn, an
   *  unlinked platform sender), which is a real state and NOT the same as "configured nothing": there is
   *  deliberately no fallback to the instance-wide config, because a per-account credential that silently
   *  becomes the operator's would act on the wrong person's behalf. */
  userConfig(): Record<string, unknown> | null;
  /** This plugin's encrypted instance secret namespace. The plugin name is bound by the context. */
  instanceSecrets(): PluginSecretBag;
  /** This plugin's encrypted secret namespace for the current contribution account. Delegated turns use
   * their delegator's contribution account; authenticated API calls fall back to currentIdentity(). */
  userSecrets(): PluginSecretBag | null;
  /** Canonical deployment URL from trusted install metadata. Never derived from request headers. */
  publicWebUrl(): string | null;
  /* Read account-scoped state AT THE TOP of the work that needs it. The account is carried on async
   * context, so un-awaited background work would retain whichever account triggered it. */
  readonly logger: PluginLogger;
}

/** The module shape a plugin's built ESM entry must export. */
export interface PluginModule { register(ctx: PluginContext): void | Promise<void> }
