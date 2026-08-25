/** The daemon↔web wire contract: the shapes the daemon serves over its HTTP/SSE surfaces and the web
 *  dock renders — the display transcript (`GET /brain/messages`, the SSE stream) AND the REST DTOs the
 *  dock lists (user, memories, memory categories/events, brain limits/usage, git commit rows). This is
 *  the ONE definition both toolchains import, so a field added on the daemon can never be silently
 *  missing on the web mirror — the exact drift this file exists to end (ToolOutputView.notes, the
 *  workflow `wf` segment, the `kind`/`detail` event rows, the sub-agent state fields, and the /auth/me
 *  `User` all diverged while these were hand-copied).
 *
 *  It carries TYPES only and imports nothing, so:
 *   - the daemon (NodeNext) and web (Bundler) resolvers both accept `../shared/wireContract.js`;
 *   - a type-only import erases at build time, adding zero runtime code to the Next bundle.
 *
 *  The owning daemon modules (src/store/*, src/brain/events.ts, src/integrations/projectFiles.ts) and
 *  `web/lib/types.ts` re-export these to their own sides; none redeclares the shapes. */

export interface ToolOutputView {
  title: string;
  kind: 'console' | 'result';
  text: string;
  fullText?: string;
  command?: string;
  /** Working directory of a console run, lifted out of the terminal plugin's `(cwd: …)` framing line so
   *  the body carries only real output. Renderers show it as faint context under the command echo. */
  cwd?: string;
  status?: string;
  tone?: 'normal' | 'success' | 'warning' | 'danger';
  /** Hook-appended annotations lifted off `result.details.notes` (the `tools.call.after` contract —
   *  e.g. "formatted a.ts with prettier"). Rendered as faint suffix lines under the output body. */
  notes?: string[];
}

/** Durable latest state attached to a delegated tool call (a sub-agent `Task`). */
export interface BrainSubagentView {
  sessionId: string;
  status: 'running' | 'done' | 'error';
  task: string;
  detail?: string;
  tools: number;
  tokens?: number;
  seconds: number;
  model?: string;
  background?: boolean;
  autoDeliver?: boolean;
  resultDelivery?: 'pending' | 'acknowledged';
}

/** Durable latest state of a workflow DAG attached to its `WorkflowStart` call. */
export interface BrainWorkflowView {
  id: string;
  toolCallId: string;
  title?: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  nodes: {
    id: string;
    task: string;
    status: 'pending' | 'running' | 'done' | 'error';
    deps: string[];
    sessionId?: string;
    detail?: string;
    tokens?: number;
    seconds?: number;
    model?: string;
    /** Epoch ms of the node's launch — clients tick live elapsed time from it between snapshots. */
    startedAt?: number;
    /** Short preview of a terminal node's outcome (bounded by the engine and again on persist). */
    result?: string;
    error?: string;
  }[];
}

/** One display piece of an assistant turn, in the order it happened: a text block, or a tool call (with a
 *  short argument summary and, for edits, the display diff). The call id stays on the wire so a
 *  post-parent-idle background update can patch the already-settled row.
 *
 *  `plan` carries the markdown a finished ExitPlanMode call submitted, so the client can render the plan
 *  panel and raise the decision from the CALL rather than by pattern-matching the assistant's prose. It
 *  is a distinct field precisely because prose could never be trusted here: a model quoting a plan tag
 *  while merely discussing plan mode is indistinguishable from one proposing a plan. */
export type BrainSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; id?: string; detail?: string; diff?: string; output?: ToolOutputView; command?: string; sub?: BrainSubagentView; wf?: BrainWorkflowView; plan?: string }
  /** An image the agent shared on purpose (`ShareImage`). Its own segment rather than a field on the tool
   *  row, because the picture IS the message here — a reader wants to see it, not a pill saying a tool
   *  ran. A failed share stays an ordinary tool row so the error is still visible. */
  | { kind: 'image'; image: BrainMessageImage; caption?: string }
  /** A durable artifact shared on purpose (`ShareFile`). The web renders a download affordance rather than
   *  the tool pill; a failed share remains an ordinary tool row with its refusal visible. */
  | { kind: 'file'; file: BrainMessageFile; caption?: string };

/** An image in a conversation, kept next to the database so it still shows after a reload — a user's
 *  attachment or one the agent shared. `url` is a daemon path (`/brain/chat-images/<file>`) a browser
 *  loads directly: through the web proxy it carries the session cookie, so no signed link is involved. */
export interface BrainMessageImage { url: string; mimeType: string }

/** A general file the agent shared. The URL is an authenticated daemon download route; `name` is the
 *  original basename the browser should save and `size` lets clients explain the download before fetching. */
export interface BrainMessageFile { url: string; name: string; size: number }

/** A durable display row (the `GET /brain/messages` payload). `id` is the SQLite message UUID when the
 *  source is a real store row; structural callers may omit it. The only non-row views served over HTTP are
 *  synthetic running-work anchors (see withSubagentAnchors/withWorkflowAnchors), whose derived ids are
 *  stable across refetches and marked with `synthetic: true` so a client can tell them from — and drop them
 *  in favour of — the real anchor row once paging loads that row. `text` is the flat reply; `segments`
 *  preserve the true order. `kind`/`detail` mark a non-message system row (a model/mode/rename/cwd event)
 *  rather than an assistant/user turn. `images` are a user row's surviving attachments. */
export interface BrainMessageView {
  id?: string; synthetic?: boolean; role: string; text: string; segments?: BrainSegment[];
  kind?: string; detail?: string; images?: BrainMessageImage[];
  /** Display metadata only. Legacy rows omit duration; every stored row may expose its timestamp. */
  createdAt?: string; durationMs?: number;
}

/** The mode a turn runs in: `build` (the default), `plan` (planning only, tools clamped) or `workflow`.
 *  Part of the wire contract because a surface stamps it per send AND reads it back off the daemon: the
 *  mode is otherwise per-client, so plan mode entered in one surface is invisible to every other. */
export type BrainWorkMode = 'build' | 'plan' | 'workflow';

/** A plan an `ExitPlanMode` call submitted that is still waiting on the user's implement/cancel decision.
 *  `id` is the submitting tool call's id — the key a client dedupes on so one plan raises one decision;
 *  it is absent only for a call PI minted no id for, where the plan text is the key instead. */
export interface BrainPendingPlan { id?: string; plan: string }

/** A chat platform a sender can write from. THE definition of the platform set, spelled out here only
 *  because this file must import nothing (see tests/contract/wireContractIsolation.test.ts) — every
 *  identity descriptor is typed against it, so a platform that is not listed here cannot have one, and
 *  tests/contract/platformIdentityContract.test.ts fails if the descriptor set and this union diverge. */
export type PlatformSurface = 'discord' | 'msteams' | 'telegram' | 'whatsapp';

/** The account-setting keys that carry a linked platform identity. This is a wire-visible type so the web
 *  can model `CliSettings` without importing the daemon's runtime identity descriptors. */
export type PlatformLinkKey = 'discordUserId' | 'msteamsUserId' | 'telegramUserId' | 'whatsappNumber';

/** Which chat surface exposes a slash command. Part of the wire contract because `GET /brain/commands`
 *  serves the filtered list to every surface (CLI, web dock, platform bots). The platform half follows
 *  the platform set, so the next platform reaches every slash-command surface from one declaration; the
 *  CLI and the web dock are named separately because neither has a platform identity. */
export type SlashSurface = 'cli' | 'web' | PlatformSurface;

/** How a surface handles a command once picked: `action` (server effect), `info` (fetch+render),
 *  `picker` (surface-local chooser), `mode` (local work-mode switch), `prompt` (plugin prompt macro). */
type SlashKind = 'action' | 'info' | 'picker' | 'mode' | 'prompt';

/** WHICH MECHANISM runs a command — the question `kind` does NOT answer. `kind` is presentation (how a
 *  surface renders the command and its result); `execution` is who performs the effect. The two are
 *  independent, and every pair in this catalog is real: the platforms' `/context` is a `picker` (its UI is
 *  a chooser) driven by a daemon-side channel operation, while `/maskot` is an `action` that never leaves
 *  the CLI process.
 *
 *  - `session-control` — a control operation on the ADDRESSED SESSION, whose semantics belong to the
 *    daemon. The HTTP surfaces (CLI, web dock) reach it through `POST /brain/command`
 *    (src/api/routes/brainChat.ts) or the command's dedicated endpoint, addressing the CALLER's own
 *    conversation. A chat adapter cannot use either: it has no user-authenticated HTTP client and its
 *    target is the CHANNEL's session, so it goes through `PlatformControlApi` against its `ChannelRef`
 *    (src/plugins/api.ts) — today by way of `runControlCommand` in elowen-plugin-shared.
 *  - `surface-local` — the surface owns the execution end to end: its own overlay or modal, its own local
 *    process/preferences, or its own dedicated endpoint driven by its own UI. There is nothing here for a
 *    generic dispatcher to route, and nothing that another surface could run on its behalf.
 *  - `adapter-state` — owned by a chat adapter's local per-channel state end to end; the daemon has no
 *    operation behind it. `voice` and `display` are declared this way in src/brain/slashCommands.ts so
 *    the catalog is the ONE place a command is declared, but they are withheld from the published
 *    projection while the adapters still register them themselves.
 *  - `plugin-prompt` — a plugin's prompt macro (`kind:'prompt'`), expanded by PI itself when the raw
 *    slash arrives. Never a catalog entry; carried by the merged menu.
 *
 *  Core DISPATCHES on this field: `POST /brain/command` executes exactly the `session-control` actions
 *  (src/api/routes/brainChat.ts). It rides `ctx.chatCommands()` too, which is how the chat adapters stopped
 *  dispatching on a hardcoded name set: each derives its control set from this field (`controlCommandsFrom`
 *  in elowen-plugin-shared), so there is no second registry left to drift. */
export type SlashExecution = 'session-control' | 'surface-local' | 'adapter-state' | 'plugin-prompt';

/** What a command accepts after its name, when that value set is the SAME on every surface that publishes
 *  the command. Transport-specific option schemas (Discord's option definitions, Telegram's BotFather
 *  syntax, WhatsApp's numbered menus) stay in the adapters — they are presentation, not contract.
 *
 *  Declared arguments are always optional: every command that takes one also has a defined bare
 *  invocation (toggle, unsteered compaction, open the picker), so there is no `required` flag to honour. */
export type SlashArgument =
  /** A fixed set of portable literal values (`/fast on|off`). `open` marks a set that is deliberately NOT
   *  exhaustive because every surface resolves additional values from equivalent live data. */
  | { kind: 'enum'; values: readonly string[]; open?: boolean }
  /** Free text, once every surface publishing the command forwards it with the same meaning. */
  | { kind: 'text' };

/** A chat slash command as served over `GET /brain/commands`. Defined ONCE here so the daemon's
 *  canonical list (src/brain/slashCommands.ts) and the web dock's menu can never drift — the web copy had
 *  silently lost `surfaces` (which gates visibility) and `plugin` (menu attribution). */
export interface SlashCommandDef {
  name: string;
  /** One-line help shown in every surface's menu. English (surfaces localize their own chrome only). */
  description: string;
  kind: SlashKind;
  /** Gated to admins (server-side check is `user.is_admin`). e.g. `restart`. */
  adminOnly?: boolean;
  /** Which surfaces expose it. Omitted → all. */
  surfaces?: SlashSurface[];
  /** For `kind:'prompt'` (plugin) commands: the prompt template PI expands when the raw slash arrives. */
  prompt?: string;
  /** For plugin commands: the owning plugin's name (menu attribution + provenance). */
  plugin?: string;
  /** For a BUILT-IN command whose work is done by a plugin (`/skills`, `/mcp`): the plugin that must be
   *  running for it to do anything. The command is dropped from a surface's menu while that plugin is
   *  absent — it would otherwise open a picker that can only report an error, and a plugin living in the
   *  marketplace rather than the package is absent on a perfectly healthy install. Distinct from
   *  `plugin` above: that one MARKS a command as contributed by a plugin, this one GATES a core command
   *  on one. */
  requiresPlugin?: string;
  /** Which mechanism executes the command. Optional HERE (an older client's copy of this shape stays
   *  valid, and the field is additive on the wire) but REQUIRED of every entry the daemon publishes: both
   *  the canonical catalog and the plugin-macro projection are typed as {@link SlashExecution}-carrying in
   *  src/brain/slashCommands.ts, so a producer cannot omit it. */
  execution?: SlashExecution;
  /** What the command accepts after its name, when the accepted values are surface-independent. Absent
   *  means the catalog states nothing about arguments — NOT that the command refuses them. */
  argument?: SlashArgument;
}

/** Which approval choice an option IS, independent of the English label carried beside it. The label stays
 *  the wire value a client posts back (`approvalDecision` matches on it), so a surface that wants to show
 *  the choice in the user's own language keys its wording on this instead of parsing the label text.
 *  Present only on an approval prompt; ordinary AskUserQuestion options have no fixed identity. */
export type ApprovalOptionId = 'once' | 'always' | 'deny';

/** One option of an `AskUserQuestion` choice, as it rides the `ask` SSE event. Referenced only through
 *  `AskQuestion`, so it stays unexported — both former copies were file-local too. */
interface AskOption { label: string; description?: string; preview?: string; id?: ApprovalOptionId }

/** The facts an approval prompt is composed FROM, carried alongside the rendered English question so a
 *  client can compose its own wording without taking the English apart. Without it the only way to
 *  localize "always allow \"git status*\"" would be to regex the pattern back out of a sentence this
 *  repo also owns — which works right up until the sentence changes. */
export interface ApprovalPrompt { tool: string; command?: string; alwaysPattern?: string }

/** One question of a parked `AskUserQuestion`. Clients POST the picked labels back to `/brain/answer`. */
export interface AskQuestion { question: string; header: string; multiSelect: boolean; custom?: boolean; options: AskOption[]; approval?: ApprovalPrompt }

/** Authoritative control state of the tapped conversation, carried on the snapshot frame and read on the
 *  same event-loop tick as the run journal. The journal alone cannot answer either question: it is cleared
 *  at settle, bounded, and deliberately holds no terminal event across an internal retry — so "is a turn
 *  running" and "is a question parked" come from the live session and the elicitation registry instead of
 *  being guessed from the tail's shape.
 *
 *  Every field is EXPLICIT: omitted-means-unchanged is what let a client keep showing a question the daemon
 *  had already settled, because a set-only hydration can never clear anything. Defined here so the daemon's
 *  snapshot and the web's reader cannot drift on the one contract that decides whether the Stop button and
 *  the question card are live. */
export interface BrainStreamControl {
  /** A turn is in flight right now — PI streaming, or a delegated child still working. */
  streaming: boolean;
  /** The question parked for this conversation, `null` when none is. */
  pendingAsk: { id: string; questions: AskQuestion[]; kind?: 'approval' } | null;
  /** Mode of the last turn the daemon ran for this conversation. The mode is stamped per send and kept
   *  nowhere else, so this is the ONLY way a client learns that another surface put the conversation in
   *  plan mode — without it a plan submitted from the CLI reaches a web tab as an ordinary tool call. */
  workMode: BrainWorkMode;
  /** The submitted plan awaiting an implement/cancel decision, `null` when none is. Explicit for the same
   *  reason as `pendingAsk`: a set-only hydration could never clear a decision the daemon has moved past. */
  pendingPlan: BrainPendingPlan | null;
}

/* ─── REST DTOs (the dock's lists and forms) ───────────────────────────────── */

/** The user as served by `GET /auth/me` — the shape that actually drifted once: the daemon grew
 *  `advisor_exec`/`advisor_autostart` and the web mirror silently rendered `undefined` until an AST
 *  mirror test caught it (see web/tests/lib/dtoMirror.test.ts). */
export interface User { id: number; username: string; created_at: string; is_admin: boolean; allowed_execs: string[]; disabled_tools: string[]; allowed_tools: string[]; granted_plugins: string[]; name: string; email: string; avatar: string; default_exec: string; advisor_exec: string; advisor_autostart: boolean }

/** A durable RAW memory row (v1: user-scoped; `GET /memory`). Deletes are SOFT (`status='deleted'`).
 *  `status` is a closed set because the daemon's own API schema enums exactly these three
 *  (api/schemas/memory.ts) and the web switches over them. */
export interface MemoryRow {
  id: number;
  user_id: number;
  body: string;
  kind: string;
  importance: number;
  confidence: number;
  source: string;
  status: 'active' | 'archived' | 'deleted';
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
  category_id: number | null;
}

/** A user-scoped memory category (`GET /memory/categories`). `is_builtin` is 0/1; `icon` is a lucide
 *  name from the shared allowlist the daemon clamps to (src/store/memoryCategoryStore.ts), which the UI
 *  badge renders. */
export interface MemoryCategoryRow {
  id: number;
  user_id: number;
  name: string;
  description: string;
  color: string;
  icon: string;
  is_builtin: number;
  /** Null keeps the category global; a value binds it to one project by stable id. */
  projectId: number | null;
  created_at: string;
}

/** One entry of a memory's audit trail (`GET /memory/:id/events`). `memory_id` is null for events whose
 *  memory was hard-removed; before/after_json are raw JSON snapshots. `model` names the model that
 *  inferred the change and is null for a user or system action — that is what tells an automatic edit
 *  apart from a deliberate one when the trail is read back. */
export interface MemoryEventRow {
  id: number;
  memory_id: number | null;
  user_id: number;
  action: string;
  before_json: string | null;
  after_json: string | null;
  actor: string;
  reason: string;
  model: string | null;
  created_at: string;
}

/** One sample of a memory's vitality (`GET /memory/:id/vitality-history`). Timestamps are ISO-8601 UTC;
 *  `vitality` is the same 0-100 scale the list column shows. */
export interface MemoryVitalityPoint {
  at: string;
  vitality: number;
}

/** A memory's vitality over time. `points` is the PAST, reconstructed by replaying the recall log, and
 *  is empty when the counters cannot be resolved back (a memory used before logging existed). `forecast`
 *  runs from now forward assuming it is never recalled again, which is what makes `evictAt` meaningful.
 *  The web only draws this — the half-life table stays daemon-side, like `vitality` itself. */
export interface MemoryVitalityHistory {
  points: MemoryVitalityPoint[];
  forecast: MemoryVitalityPoint[];
  recalls: string[];
  floor: number;
  evictAt: string | null;
  historyFrom: string | null;
  now: string;
}

/** Operator-tunable brain limits (Settings → Elowen AI → Limits): each a whole number the daemon clamps
 *  to a sane range. Served inside `ElowenConfig.brain.limits` and PATCHed back as a partial. */
export interface BrainLimits {
  toolOutputMaxLines: number;
  toolOutputMaxChars: number;
  toolResultInlineBytes: number;
  /** Aggregate byte cap on ONE wire-level tool-result message — the provider coalesces a turn's parallel
   *  tool results into a single block, so this is what a fan-out actually costs. Members are spilled
   *  largest-first until the block fits; never applied below `toolResultInlineBytes`. */
  toolResultGroupBudgetBytes: number;
  /** Consecutive failed AUTOMATIC compactions after which a conversation stops attempting them. A context
   *  that cannot be summarized fails identically on every retry, and the threshold is re-checked after
   *  every turn, so without a stop each further turn spends a doomed summarization request. */
  compactionFailureLimit: number;
  elicitationTimeoutMs: number;
  memoryRecallCount: number;
  memoryRecallChars: number;
  /** Maximum background memory searches in one turn. 0 disables recall while working. */
  memoryLiveRecallPasses: number;
  /** Maximum memories one mid-turn retrieval may inject. */
  memoryLiveRecallCount: number;
  /** Byte budget all mid-turn recall injections share across one turn. */
  memoryLiveRecallBytes: number;
  goalTurnBudget: number;
  goalMaxTurns: number;
  channelSessionCap: number;
  delegateContextChars: number;
}

export type BrainDebugSurface = 'conversation' | 'channel' | 'subagent';
export type BrainDebugRequestKind = 'chat' | 'compaction' | 'remote_compaction';
export type BrainDebugRequestStatus = 'pending' | 'succeeded' | 'error' | 'interrupted';

export interface BrainDebugPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface BrainDebugSessionPage extends BrainDebugPage<BrainDebugSessionItem> {
  /** Earliest exact provider request retained anywhere in the debug store, independent of page filters. */
  captureStartedAt: number | null;
}

export interface BrainDebugSessionItem {
  id: string;
  userId: number;
  username: string;
  userName: string;
  title: string;
  surface: BrainDebugSurface;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  captureStartedAt: number | null;
  requestCount: number;
  errorCount: number;
  firstRequestAt: number | null;
  lastRequestAt: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  costedRequestCount: number;
  latestRequestStatus: BrainDebugRequestStatus | null;
}

export interface BrainDebugRequestItem {
  requestId: string;
  sessionId: string;
  seq: number;
  turnId: string;
  retryOf: string | null;
  kind: BrainDebugRequestKind;
  configuredProvider: string;
  wireProvider: string;
  api: string;
  model: string;
  startedAt: number;
  responseAt: number | null;
  finishedAt: number | null;
  status: BrainDebugRequestStatus;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
}

export interface BrainDebugSegmentManifestItem {
  index: number;
  section: 'system' | 'input' | 'tool' | 'options' | 'response';
  key: string | null;
  kind: string;
  digest: string;
  canonicalizationVersion: number;
  byteLength: number;
  estimatedTokens: number;
  /** Small semantic hints captured beside the immutable payload so the request timeline stays readable without downloading every segment. */
  role?: string;
  label?: string;
  preview?: string;
}

export interface BrainDebugRequestDetail extends BrainDebugRequestItem {
  canonicalizationVersion: number;
  assistantMessageId: string | null;
  segments: BrainDebugSegmentManifestItem[];
  /** Sum of stored request-segment bytes; exact reconstructed JSON size is returned only by the lazy raw endpoint. */
  segmentBytes: number;
}

export interface BrainDebugSegmentPayload extends BrainDebugSegmentManifestItem {
  payload: unknown;
}

export interface BrainDebugPayloadPage {
  items: BrainDebugSegmentPayload[];
  nextCursor: string | null;
  loadedBytes: number;
}

export interface BrainDebugRawPayload {
  payload: unknown;
  byteLength: number;
}

export interface BrainDebugLegacyTranscriptItem {
  cursor: number;
  id: string;
  role: string;
  content: unknown;
  createdAt: string;
  byteLength: number;
}

export interface BrainDebugLegacyTranscriptPage {
  items: BrainDebugLegacyTranscriptItem[];
  nextCursor: string | null;
  loadedBytes: number;
  exact: false;
}

export type ToolLoadingMode = 'immediate' | 'deferred';

export interface ToolDeferralOverrides {
  sources: Record<string, ToolLoadingMode>;
  tools: Record<string, Record<string, ToolLoadingMode>>;
}

/** Wire version of the probe handshake a persisted capability was recorded under, so a stored verdict from
 *  an older protocol is ignored rather than trusted. The literal lives here as a TYPE only — this file must
 *  stay free of runtime values so the web bundle never executes it — and the value the daemon compares
 *  against is `HOSTED_TOOL_SEARCH_PROTOCOL` in `hostedToolSearchProtocol.ts`, which is typed against this
 *  and therefore cannot drift from it. */
export type HostedToolSearchProtocol = 'hosted-tool-search-v1';
export type HostedToolSearchCapabilityStatus = 'supported' | 'unsupported';
export interface HostedToolSearchCapability {
  status: HostedToolSearchCapabilityStatus;
  fingerprint: string;
  checkedAt: number;
  protocol: HostedToolSearchProtocol;
}
/** Nested rather than slash-delimited: provider/model ids may themselves contain `/`. Missing = unknown. */
export type HostedToolSearchCapabilities = Record<string, Record<string, HostedToolSearchCapability>>;

/** Operator-tunable runtime limits (Settings → Elowen AI → Runtime): each a whole number the daemon
 *  clamps to a sane range. A SIBLING of `BrainLimits` rather than more fields on it: these govern the
 *  daemon's surrounding runtime — the CLI's `!` escape, the memory relevance floor, the deferred-tool
 *  policy, activity-log retention and the web client's stream watchdog — not the per-turn brain budget,
 *  and `BrainLimits` already mixes more domains than one editor should. Served inside
 *  `ElowenConfig.runtime` and PATCHed as a partial.
 *
 *  `memorySemanticFloorPerMille` is a cosine threshold carried in PER MILLE (300 = 0.30) because every
 *  value in these groups is rounded to a whole number on save — a float would round to 0 and floor
 *  nothing. `MemoryService` divides it back by 1000. */
export interface RuntimeLimits {
  localShellTimeoutMs: number;
  memorySemanticFloorPerMille: number;
  /** Cosine (per mille, same reason as the floor above) at which a NEW memory counts as a near-duplicate
   *  of an existing one, so the curator updates that one instead of adding a paraphrase and MemoryAdd
   *  names it alongside the memory it stored. Deliberately separate from the recall-side threshold below:
   *  a false positive here REWRITES a stored memory, whereas there it only drops a search result, so this
   *  one is set the more cautious of the two. It is tied to the embedding model AND to how large and how
   *  uniform the store has grown — see the measurement note on the default in configStore. */
  memoryDuplicatePerMille: number;
  /** Cosine (per mille) at which an already-picked memory makes a lower-ranked one redundant, so recall
   *  does not spend two of its slots on two write-ups of the same fact. */
  memoryParaphrasePerMille: number;
  /** How much of the recall score is importance, and how much is vitality, in per mille. Semantic
   *  similarity takes whatever is left (1000 − the two), so raising either lowers the weight of the
   *  question itself. Vitality especially: it grows from use_count, which recall increments on its own,
   *  so a high value here feeds a loop where recalled memories keep being recalled. */
  memoryImportanceWeightPerMille: number;
  memoryVitalityWeightPerMille: number;
  /** Upper bound on how many memory writes the post-turn curator may apply from one exchange. 0 turns
   *  automatic memory writing off entirely; the explicit Memory* tools keep working. */
  memoryCuratorMaxOps: number;
  toolDeferThreshold: number;
  eventRetentionDays: number;
  /** How long a recorded client IP stays readable in the origin-usage rollup before the hourly janitor
   *  replaces it with `redacted` and merges its bucket. The totals survive the redaction; only the
   *  address goes. The row itself is deleted later, on `eventRetentionDays` — so this is the
   *  personal-data horizon and that one is the accounting horizon. */
  originIpRetentionDays: number;
  /** The two below are a PAIR — both answer "how long may a chat stream go without a sign of life before
   *  the browser gives up on it", differing only in which moment asks. They are read by the WEB client
   *  (which cannot import daemon code, hence the trip through this contract), and neither may reach down
   *  to the 30 s heartbeat interval: see the shared floor in `RUNTIME_LIMIT_BOUNDS`.
   *
   *  Silence on a page the user is watching, polled by the stream watchdog. */
  streamSilenceLimitMs: number;
  /** Silence discovered at a WAKE-UP (unlock, tab return, bfcache restore) — a frozen page runs no timers,
   *  so the watchdog tick that should have caught this never happened and the wall clock is read instead.
   *  Tighter than its twin by default: nobody was watching, so a lost stream is likelier here. */
  streamReviveSilenceLimitMs: number;
  /** How long a web toast holds the screen before dismissing itself. Read by the WEB client, same trip
   *  through this contract as the stream pair above — it has no daemon-side reader at all. */
  toastDurationMs: number;
}

/** The runtime block as served/patched: the numeric limits plus the boolean switches (each its own field
 *  because the limits group is uniformly numeric — one clamp loop, one slider table). */
export interface RuntimeConfig {
  limits: RuntimeLimits;
  /** Global kill switch for deferred tools. `false` → nothing is ever withheld from the prompt. */
  toolDeferralEnabled: boolean;
  /** Owner-qualified loading decisions. Missing keys inherit the source's default; maps replace wholesale
   *  so removing a key restores that inheritance. */
  toolDeferralOverrides: ToolDeferralOverrides;
  /** Probe-backed hosted-search capabilities (currently Azure OpenAI). Missing entry = unknown/fallback. */
  hostedToolSearch: HostedToolSearchCapabilities;
  /** Execute delegated sub-agent turns in a forked runner process instead of on the daemon's own event
   *  loop. OFF by default, and `false` is literally the old in-process path — which is what makes this
   *  the operator's rollback with no redeploy. Read live, so the next delegated turn follows it. */
  subagentRunnerEnabled: boolean;
  /** THE one knob over the sub-agent runner POOL's size. `null` = auto, and auto is the point: the pool
   *  measures the machine (cores minus one for the daemon; total memory divided by a live runner's real
   *  resident size) so the same build sizes itself correctly on a 2-core VPS and a 16-core server without
   *  being told which it is.
   *
   *  `0` disables the pool entirely and every delegated turn runs in-process. `N >= 1` is a HARD CAP and
   *  can only ever NARROW what the machine allows — it exists for the cases where the machine's own
   *  numbers lie (a cgroup CPU quota `availableParallelism()` cannot see, a container memory limit
   *  `totalmem()` reports straight past), or where the operator simply wants Elowen below its fair share.
   *  `ELOWEN_SUBAGENT_POOL_MAX` overrides it, which is how a lying container is fixed without a DB write. */
  subagentRunnerPoolMax: number | null;
  /** Compact a ChatGPT-account conversation through the provider's own opaque compaction instead of a
   *  text summary written by a model. OFF by default: it rides an undocumented beta endpoint, and it
   *  trades the readable summary the clients render today for a marker nobody can read. `false` is the
   *  pre-feature path exactly, so it is also the operator's rollback with no redeploy. */
  remoteCompactionEnabled: boolean;
  /** Persist exact post-transform model request bodies for admin diagnostics. */
  providerRequestCaptureEnabled: boolean;
}

/** Statusline data for one live conversation: current context fill + session totals. The breakdown
 *  fields are the session's own cumulative sums; optional because tests and custom producers build
 *  partial literals — treat absence as 0/unknown. */
export interface BrainUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  totalTokens: number;
  cost: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Reasoning tokens (a SUBSET of `output`, display only). */
  reasoning?: number;
  /** Average output tokens/sec across the session's measured generations; null when none measured yet. */
  outputTps?: number | null;
}

/** One measured slice of a conversation's context window. The id set is closed because every surface
 *  switches over it to pick a label and an order. `free` is NOT one of them — it is the remainder, not a
 *  measurement, and lives in its own field on the breakdown. */
export type BrainContextCategoryId = 'system' | 'tools' | 'user' | 'assistant' | 'toolResults' | 'other';

/** A category's estimated cost and its share of the window (0-100). Referenced only through the
 *  breakdown below, so it stays unexported — clients read it off `categories`/`free`. */
interface BrainContextSlice { tokens: number; percent: number }

export interface BrainContextCategory extends BrainContextSlice { id: BrainContextCategoryId }

/** What one tool costs the window: its advertised schema (only while the tool is active), the arguments
 *  of its calls still in history, and the results those calls returned. `tokens` is the sum — the figure
 *  the ranking sorts on. A tool with no active schema but heavy results stays listed: its output is what
 *  occupies the window. */
export interface BrainContextToolCost {
  name: string;
  schemaTokens: number;
  callTokens: number;
  resultTokens: number;
  tokens: number;
  percent: number;
  /** Whether the tool's schema is currently advertised to the model (a deferred tool costs nothing). */
  active: boolean;
}

/** What is filling a conversation's context window right now (`GET /brain/context-usage`).
 *
 *  EVERY token figure except `reportedTokens` is an ESTIMATE: the daemon has no tokenizer for the
 *  provider's vocabulary, so categories are measured with the same chars/4 heuristic PI's own compaction
 *  uses. `reportedTokens` is the provider's authoritative count for the last request and is the number a
 *  client should trust for "how full"; the categories answer "of what". They are not expected to match. */
export interface BrainContextBreakdown {
  model: string;
  contextWindow: number;
  /** Provider-reported context tokens of the last request; null before anything has been sent. */
  reportedTokens: number | null;
  /** Sum of every measured category (estimated). */
  estimatedTokens: number;
  /** `estimatedTokens` as a share of the window (0-100; 0 when the window is unknown). */
  percent: number;
  /** Measured categories in display order, zero-token ones omitted. */
  categories: BrainContextCategory[];
  /** The window still free after the estimate, never negative. */
  free: BrainContextSlice;
  /** The biggest tool consumers, largest first. */
  tools: BrainContextToolCost[];
  /** Context tokens at which auto-compaction fires; null when the session reports no threshold. */
  compactAtTokens: number | null;
}

/** The conversation created by `POST /brain/sessions/:id/fork` — a peer of the source that starts with a
 *  copy of its history. `forkedFrom` is the source id, kept so a client can report what it branched off. */
export interface BrainForkedSession { id: string; title: string; forkedFrom: string }

/** Durable state of one autonomous goal, served in the stream snapshot frame (`goal`). The store row
 *  and every client view use the same shape so lifecycle transitions cannot drift between polling and
 *  live streams. */
export interface BrainGoalState {
  session_id: string;
  user_id: number;
  status: 'active' | 'draft' | 'paused' | 'done';
  goal: string;
  draft: string;
  subgoals: string;
  turns_used: number;
  turn_budget: number;
  last_verdict: string;
  last_evidence: string;
  paused_reason: string;
  created_at: string;
  updated_at: string;
}

/** One file's +added/−deleted churn within a commit — a project's git log rows and a frozen
 *  change list both render from this. */
export interface CommitFileChange { path: string; added: number; deleted: number }

/** One commit of a project's git log (newest first). */
export interface CommitLogEntry { hash: string; subject: string; author: string; timestamp: number; files: CommitFileChange[] }
