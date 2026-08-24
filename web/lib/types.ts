export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'closed' | 'cancelled';
/** Outcome the daemon records when a task closes (`src/store/types.ts`). */
type TaskOutcome = 'ok' | 'fail';
export interface Task { id: string; title: string; status: TaskStatus; type?: string; priority?: string; labels?: string[]; description?: string; scheduled_at?: string | null; autostart?: number; result_summary?: string | null; outcome?: TaskOutcome | null; closed_at?: string | null; created_at?: string; parent_id?: string | null; project_id?: number; changed_files?: CommitFileChange[]; resume_note?: string | null }
type SessionRole = 'overseer' | 'pilot' | 'agent' | 'advisor' | 'chat';
/** Structured identity of a live agent session, classified by the daemon (single source of truth).
 *  Clients render from `role` — they never parse meaning out of the raw session name. */
export interface SessionInfo { name: string; role: SessionRole; agent: string; missionId?: string; projectId?: number; userId?: number }
/** Autonomy level the overseer runs a mission at (`L0` manual … `L3` fully autonomous). */
type Autonomy = 'L0' | 'L1' | 'L2' | 'L3';
/** Lifecycle state of a mission, set by the daemon (`src/overseer/missionEngine.ts`). */
type MissionState = 'active' | 'paused' | 'disengaged' | 'stalled';
export interface Mission { id: string; epic_id: string; autonomy: Autonomy; max_sessions: number; state: MissionState; pr?: MissionPrInfo | null }
export interface CreateTaskInput { title: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; autostart?: number; deps?: string[]; project_id?: number }
export interface UpdateTaskInput { title?: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; autostart?: number; deps?: string[]; addDep?: string; parent_id?: string }
export interface PlanInput { goal: string; name?: string; exec?: string; autoModel?: boolean; pilotExec?: string; overseerExec?: string; autonomy?: string; maxSessions?: number; engage?: boolean; phases?: { title: string; type?: string }[]; project_id?: number; prEnabled?: boolean | null }
interface PlanResult { epic: Task; phases: Task[]; mission?: Mission }
interface PlanPhase { title: string; type: string; agent?: string; details?: string }
type PlanJobStatus = 'planning' | 'done' | 'failed';
export interface PlanJob { id: string; epicId: string | null; goal: string; status: PlanJobStatus; phases: PlanPhase[]; error?: string; sessionName?: string }
/** Autopilot planning is async: the endpoint returns a job to poll. Manual mode still returns a PlanResult. */
export type PlanSubmitResult = { jobId: string; epicId?: string } | PlanResult;
export interface InsertPhasesInput { phases?: { title: string; type?: string; details?: string }[]; goal?: string; exec?: string; prompt?: string }
export interface InsertPhasesResult { epic: Task; phases: Task[] }
export interface EngageInput { epicId: string; autonomy: string; maxSessions: number }
export type PromptOption = { id: string; label: string };
export type DerivedSignal =
  | { type: 'working' }
  | { type: 'complete' }
  // `options` is present when the agent asked a multiple-choice question (the overseer escalated it):
  // the id is the option's 1-based list position, so the UI navigates with Down × (id-1) then Enter.
  | { type: 'needs_input'; question: string; options?: PromptOption[]; context?: string };
export interface ElowenConfig {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  modelNotes: Record<string, string>;
  autopilot: { model: string; overseerModel: string; apiUrl: string; providerId: string; apiKeySet: boolean; notes: string; prompt: string; pilotExec: string; overseerExec: string; reviewOnDone: boolean; tddMode: boolean; prEnabled: boolean; prBaseBranch: string; prAutoOpen: boolean; prVerifyCommand: string; ghTokenSet: boolean };
  providers: Record<string, { bin: string; args: string; skipPermissions: boolean; resume: boolean }>;
  defaults: { exec: string; autonomy: string; maxSessions: number };
  security: { tokenTtlDays: number; trustProxy: boolean };
  sessionRetention: { enabled: boolean; days: number };
  autoUpdate: boolean;
  webPushContact?: string;
  plugins?: { enabled: string[]; removed?: string[] };
  brain?: { providers: BrainProvider[]; agentName?: string; maxSteps?: number; modelContextWindows?: Record<string, number>; limits?: BrainLimits; hiddenOauth?: string[] };
  /** Operator-tunable runtime knobs — the sibling group of `brain.limits`; absent on an older daemon. */
  runtime?: RuntimeConfig;
}

// Operator-tunable brain limits — shared with the daemon via the wire contract (re-exported from it
// further down this file); every field is a whole number the daemon clamps to a sane range.

/** How a brain provider talks upstream: a custom endpoint (API key) or a connected OAuth account. */
export type BrainProviderType = 'openai' | 'anthropic' | 'oauth-anthropic' | 'oauth-github-copilot' | 'oauth-openai-codex' | 'oauth-kimi';
export interface BrainProvider {
  id: string;
  label: string;
  type: BrainProviderType;
  baseUrl: string;
  models: string[];
  /** Wire API for `openai`-type entries. Absent = auto (api.openai.com → Responses, else Completions). */
  api?: 'openai-completions' | 'openai-responses';
  apiKeySet: boolean;
  /** Sampling temperature. Absent = the field is not sent and the model's own default applies. */
  temperature?: number;
}
/** One Elowen AI (brain) model. `source` = how its provider authenticates (drives the OAuth badge). */
export interface BrainModelOption {
  provider: string; providerLabel: string; model: string; exec: string;
  /** Structured identity from GET /brain/models: `program` names the engine explicitly, so nothing has
   *  to infer it from the spec's shape, and `legacyExec` is the composite spec configs, task labels and
   *  allow-lists still store (`exec` is its alias, kept until the prefix migration's cleanup phase).
   *  Optional so a response from an older daemon still satisfies this type. */
  program?: 'elowen';
  legacyExec?: string;
  source: 'api-key' | 'oauth' | 'relay'; contextWindow: number; contextWindowSet: boolean;
  /** Model/provider-derived reasoning controls. Absent means the model must not receive an effort. */
  reasoningLevels?: string[];
  reasoningLabels?: Record<string, string>;
  fastAvailable?: boolean;
  default?: boolean;
}
/** One brain conversation in the session picker (web chat + CLI). */
export interface BrainSessionInfo { id: string; title: string; provider?: string; model: string; updated_at: string; running: boolean; active: boolean }
/** A row in the admin session-management panel (all brain sessions the operator anchors). `platform` says
 *  WHERE it happened (null for web/CLI) and `direct` whether `ownerId` is the person talking there or only
 *  the account hosting a shared room — see ManagedSessionView in src/brain/service/statusService.ts. */
export interface ManagedSession { id: string; title: string; provider?: string; model: string; updated_at: string; running: boolean; active: boolean; kind: 'conversation' | 'channel' | 'task'; tokens: number; platform: string | null; direct: boolean; ownerId: number; ownerLabel: string; lastWriterId: number | null; lastWriterLabel: string | null }
/** Mirror of the daemon's slash-command def (src/brain/slashCommands.ts) — published at GET /brain/commands.
 *  `kind:'prompt'` is a plugin prompt macro: the surface sends the RAW `/name args` slash and PI expands
 *  the template's arguments ($ARGUMENTS/$1..$9) on the daemon; `prompt` is kept for menu/identification. */
/** One fulltext-search match across the caller's brain conversations. */
export interface BrainSearchHit { sessionId: string; sessionTitle: string; role: string; snippet: string; ts: string }
/** The display-transcript shapes AND the REST DTOs the dock lists are the daemon↔web wire contract,
 *  defined once in src/shared and imported (type-only, so nothing bundles) rather than re-declared —
 *  the web mirror can no longer drift from what the daemon serves (the /auth/me User actually drifted
 *  once). `BrainMessage` is the web's name for the daemon's `BrainMessageView`; the memory/category/
 *  event/goal DTOs likewise keep their web-side names (`Memory`, `MemoryCategory`, `MemoryEvent`,
 *  `BrainGoal`) as aliases of the shared rows. */
import type {
  ToolOutputView, BrainWorkflowView, BrainMessageView, BrainMessageImage, BrainMessageFile, SlashCommandDef, AskQuestion, BrainStreamControl,
  BrainWorkMode, BrainPendingPlan,
  User, BrainLimits, RuntimeConfig as WireRuntimeConfig, RuntimeLimits, ToolDeferralOverrides, BrainUsage, MemoryRow, MemoryCategoryRow, MemoryEventRow, BrainGoalState,
  MemoryVitalityHistory, MemoryVitalityPoint,
  BrainContextBreakdown, BrainForkedSession,
  BrainDebugPage, BrainDebugSessionPage, BrainDebugSessionItem, BrainDebugRequestItem, BrainDebugRequestDetail, BrainDebugSegmentManifestItem, BrainDebugSegmentPayload,
  BrainDebugRawPayload, BrainDebugLegacyTranscriptPage,
  CommitFileChange, CommitLogEntry,
} from '../../src/shared/wireContract.js';
// `BrainStreamControl` is only referenced by the snapshot frame below, so it is imported but not re-exported.
export type { ToolOutputView, BrainWorkflowView, BrainMessageImage, BrainMessageFile, SlashCommandDef, AskQuestion, BrainWorkMode, BrainPendingPlan, User, BrainLimits, RuntimeLimits, BrainUsage, CommitFileChange, CommitLogEntry };
export type {
  BrainContextBreakdown, BrainForkedSession,
  BrainDebugPage, BrainDebugSessionPage, BrainDebugSessionItem, BrainDebugRequestItem, BrainDebugRequestDetail, BrainDebugSegmentManifestItem, BrainDebugSegmentPayload,
  BrainDebugRawPayload, BrainDebugLegacyTranscriptPage,
};
export type BrainMessage = BrainMessageView;
/** One stored memory as served by `GET /memory` — the daemon's `MemoryRow` plus its server-computed
 *  vitality (0–100), attached by the route. The web only displays it; it never recomputes it (the
 *  half-life table lives daemon-side). */
export type Memory = MemoryRow & { vitality: number };
export type MemoryCategory = MemoryCategoryRow;
export type MemoryEvent = MemoryEventRow;
/** A memory's vitality over time, rebuilt daemon-side from its recall log. The web draws it as-is —
 *  reconstructing it here would mean shipping the half-life table to the browser. */
export type { MemoryVitalityHistory, MemoryVitalityPoint };
export type BrainGoal = BrainGoalState;

/** Memory auto-retention (`runtime.memoryRetention`), mirrored from `src/brain/memoryVitality.ts` — the
 *  daemon serves the block inside `runtime` and the web editor mirrors the shape here so the two stay in
 *  step (the wire contract deliberately does not import it, to avoid a cycle). `halfLifeByImportance`
 *  keys are 1..5 in days; 0 is the "never" sentinel. */
export interface MemoryRetentionConfig {
  enabled: boolean;
  graceDays: number;
  vitalityFloor: number;
  halfLifeByImportance: Record<number, number>;
}

/** The runtime block the daemon serves extends the wire shape with the retention group (see the daemon's
 *  `RuntimeConfigWithRetention` in src/store/configStore.ts). Optional like `brain.limits`: a daemon
 *  predating the feature serves the wire shape alone, and the editor seeds the defaults. */
export type RuntimeConfig = Omit<WireRuntimeConfig, 'toolDeferralOverrides' | 'hostedToolSearch' | 'providerRequestCaptureEnabled'> & {
  /** Optional while a web client may still receive a response from a daemon predating tool deferral overrides. */
  toolDeferralOverrides?: ToolDeferralOverrides;
  /** Optional while a web client may still receive a response from a daemon predating detailed request capture. */
  providerRequestCaptureEnabled?: boolean;
  /** Probe-owned server state; optional for compatibility and omitted from generic runtime PATCHes. */
  hostedToolSearch?: WireRuntimeConfig['hostedToolSearch'];
  memoryRetention?: MemoryRetentionConfig;
};

/** One backwards page of chat history (lazy-load). `nextBefore` is the cursor for the next older page —
 *  null once the oldest turn has been loaded, which is also when `hasMore` is false. */
export interface BrainMessagePage { items: BrainMessage[]; hasMore: boolean; nextBefore: number | null }

/** The chat stream's first frame (`?snapshot=1`): the newest page of durable history plus the current
 *  run's not-yet-durable tail, captured on one event-loop tick. Mirror of the daemon's `BrainStreamSnapshot`
 *  (src/brain/session/liveEventReplay.ts), narrowed to what the web reads — the tail is kept as bare tagged
 *  frames because it also carries out-of-band events the transcript fold has no case for. */
export type BrainStreamTailEvent = { type: string } & Record<string, unknown>;
export interface BrainStreamSnapshotFrame {
  history: BrainMessage[];
  events: BrainStreamTailEvent[];
  /** The session actually tapped — differs from the requested one after an idle rollover the dead stream
   *  never saw. */
  sessionId?: string;
  /** Authoritative identity of the tapped session, including a child drill-in. */
  session?: { model: string; provider: string };
  /** Persisted display cards for reconnect and read-only drill-in hydration. */
  cards?: BrainCard[];
  /** The daemon's authoritative control state at snapshot time. The tail is transient — cleared at settle,
   *  bounded, and terminal-less across an internal retry — so this, not the tail's shape, decides whether a
   *  turn is running and whether a question is parked. Both fields are explicit, so hydrating from this
   *  frame CLEARS what the daemon no longer has. The shape comes from the shared wire contract. */
  control?: BrainStreamControl;
  /** The conversation's durable goal at snapshot time. It is independent of the transient run journal
   *  (cleared at settle), so this — explicit `null` included — is what lets a reconnecting client learn a
   *  goal it never saw, or clear one that ended while it was away. Absent means an older daemon. */
  goal?: BrainGoal | null;
  /** The live journal dropped part of the unsettled run; durable history must be refetched once it settles. */
  truncated?: true;
  hasMore?: boolean;
  nextBefore?: number | null;
}

/** `AskQuestion` comes from the shared wire contract (re-exported at the top of this file) rather than
 *  being mirrored here. The `ask` SSE event carries `id` + `questions`; the client POSTs `answers` back to
 *  /brain/answer, and that answer shape is web-side only. */
export interface AskAnswer { header: string; selected: string[]; other?: string }

/** ctx.emitCard display card (mirror src/brain/events.ts) — a live panel keyed by `id`. */
interface BrainCardItem { text: string; status?: 'pending' | 'in_progress' | 'completed' }
export interface BrainCard { id: string; title?: string; items?: BrainCardItem[]; body?: string; pinned?: boolean }

/** One background shell process (terminal plugin's `Bash(background:true)`). The transcript panel next to
 *  the todos lists the ones the open conversation owns; the telemetry rail lists those plus, in a separate
 *  section, everything it does not. Both read output for the modal and kill on demand. `sessionId` is the
 *  brain session it was started in, or null when it has none — the rail names the origin (sub-agent,
 *  channel, another chat) from it, and lib/processScope.ts decides ownership. `completionMode` is
 *  `foreground` while a still-in-flight `Bash` call can still be detached — not a background job yet, so
 *  live panels leave those out. */
export interface ProcessInfo { id: string; command: string; cwd: string; startedAt: string; sessionId: string | null; running: boolean; exitCode: number | null; completionMode?: 'job' | 'service' | 'foreground' }

// Durable state of one autonomous goal (the daemon's `BrainGoalState`, shared via the wire contract
// at the top of this file). The web renders only a few of its fields — the extra ones are simply not
// read. `subgoals` is the stored JSON array.

/** The statusline plugin's display toggles (null = plugin disabled). */
export interface StatuslineConfig { showModel?: boolean; showContext?: boolean; showTokens?: boolean; showCost?: boolean }
/** Where the conversation works: the live (or last stamped) directory and its git branch. Both null for
 *  a chat that never reported a directory — an ordinary web conversation has no client cwd. */
export interface BrainProject { cwd: string | null; branch: string | null }
/** One MCP server of this daemon. `mcp: null` (non-admin, or the plugin is off) hides the section. */
export interface McpServerStatus { name: string; status: string }
/** `thinkingLevel*` are the reasoning-effort controls of the conversation's CURRENT model — the levels it
 *  offers (empty when it has none), their provider-facing labels, and the one in force. They drive the
 *  `/reasoning` picker, which writes back through POST /brain/think. */
export interface BrainStatus { running: boolean; sessionId: string | null; model: string; provider?: string; usage: BrainUsage | null; statusline: StatuslineConfig | null; thinkingLevel?: string; thinkingLevels?: string[]; thinkingLevelLabels?: Record<string, string>; pendingAsk?: { id: string; questions: AskQuestion[]; kind?: 'approval' } | null; workMode?: BrainWorkMode; pendingPlan?: BrainPendingPlan | null; cards?: BrainCard[]; queued?: { id: string; text: string }[]; yolo?: boolean; project?: BrainProject; lspEnabled?: boolean; mcp?: McpServerStatus[] | null }
/** One subscription rate-limit window of a connected OAuth account (mirrors the daemon's providerUsage). */
interface UsageWindow { usedPercent: number; windowMinutes: number | null; resetsAt: number | null }
/** A connected OAuth account's usage rail: its windows (ordered shortest-first) plus plan/freshness meta. */
export interface ProviderUsage { provider: string; planType: string | null; windows: UsageWindow[]; fetchedAt: number; stale: boolean }
/** A running OAuth connect flow, as polled by the settings UI. */
export interface OAuthFlowState {
  id: string;
  provider: string;
  status: 'pending' | 'action-required' | 'success' | 'error';
  authUrl?: string;
  instructions?: string;
  userCode?: string;
  needsInput: boolean;
  error?: string;
}
export interface ConfigPatch {
  allowedExecs?: string[];
  customModels?: { label: string; exec: string }[];
  hiddenPresets?: string[];
  modelNotes?: Record<string, string>;
  autopilot?: { model?: string; overseerModel?: string; apiUrl?: string; providerId?: string; apiKey?: string; notes?: string; prompt?: string; pilotExec?: string; overseerExec?: string; reviewOnDone?: boolean; tddMode?: boolean; prEnabled?: boolean; prBaseBranch?: string; prAutoOpen?: boolean; prVerifyCommand?: string; ghToken?: string };
  providers?: Record<string, { bin: string; args: string }>;
  defaults?: { exec?: string; autonomy?: string; maxSessions?: number };
  security?: { tokenTtlDays?: number; trustProxy?: boolean };
  sessionRetention?: { enabled?: boolean; days?: number };
  autoUpdate?: boolean;
  webPushContact?: string;
  /** Wholesale brain provider list; an entry may carry `apiKey` to (re)set that provider's secret. */
  brain?: { providers?: (Omit<BrainProvider, 'apiKeySet'> & { apiKey?: string })[]; agentName?: string; maxSteps?: number; modelContextWindows?: Record<string, number>; limits?: Partial<BrainLimits>; hiddenOauth?: string[] };
  /** Runtime knobs merged per-field by the daemon, like the brain limits above. */
  runtime?: { limits?: Partial<RuntimeLimits>; toolDeferralEnabled?: boolean; toolDeferralOverrides?: ToolDeferralOverrides; providerRequestCaptureEnabled?: boolean; memoryRetention?: Partial<MemoryRetentionConfig> };
}
interface MissionPrInfo { branch: string; prNumber: number | null; prUrl: string | null; prState: string | null; fixRounds: number; lastFeedback: string | null }
export interface UserPatch { is_admin?: boolean; name?: string; username?: string; allowed_execs?: string[]; disabled_tools?: string[]; granted_plugins?: string[] }
export interface ProfilePatch { name?: string; email?: string; default_exec?: string }

/** Per-user CLI/brain settings surfaced in Account. `model` empty → the configured brain default.
 *  `userInstructions` is the semantic field; `personalityBody` is a temporary legacy-client alias. */
export interface CliSettings { model: string; modelProvider: string; visionModel: string; visionModelProvider: string; compactModel: string; compactModelProvider: string; thinkingLevel: string; autoCompact: boolean; autoCompactAt: number; autoCompactAtByModel: Record<string, number>; advisorStyle: string; userInstructions?: string; personalityBody?: string; discordUserId: string; whatsappNumber: string; telegramUserId?: string; msteamsUserId?: string; autoRecall: boolean; autoLiveRecall: boolean; autoSave: boolean; serverDefault?: string }

/** Per-user granular tool permissions (mirror src/brain/toolPermissions.ts): allow/ask/deny rule maps
 *  (`tools` keyed by tool-name pattern, `bash` by command pattern — insertion order decides precedence,
 *  last match wins), the persisted YOLO default that auto-approves "ask" rules, and what an "ask" does
 *  on unattended runs (cron/channels/sub-agents): auto-allow (default) or block (strict). */
export type PermissionAction = 'allow' | 'ask' | 'deny';
export interface PermissionSettings { tools: Record<string, PermissionAction>; bash: Record<string, PermissionAction>; yolo: boolean; unattendedAsks: 'allow' | 'deny' }

/** Full xterm ANSI palette exposed for per-user customization (mirrors `@xterm/xterm`'s ITheme colour
 *  fields). Each value is an `#rrggbb` string; applied only when the terminal theme is `custom`. */
export interface TerminalPalette {
  background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string;
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}
/** Per-user layout of the primary (left) navigation, persisted server-side. Both lists address entries
 *  by navigation id and cover only the "worlds" section; resolving them against the entries that exist
 *  right now is `lib/navLayout.ts`. */
export interface NavLayout {
  /** Ids the user hid. Hidden worlds stay reachable by URL and through the command palette. */
  hidden: string[];
  /** Preferred order, by id. Entries it does not mention keep their registry order, behind the rest. */
  order: string[];
}

export type TerminalFontFamily = 'system' | 'menlo' | 'ibm' | 'courier';
export type TerminalCursorStyle = 'block' | 'bar' | 'underline';
export type TerminalThemeMode = 'auto' | 'custom';

/** Per-user web-terminal appearance settings (Account → Terminal). `theme:'auto'` follows the app
 *  light/dark theme (the pre-feature default); `custom` uses `palette`. Persisted server-side. */
export interface TerminalSettings {
  fontSize: number;
  fontFamily: TerminalFontFamily;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  /** Render the model's Thought rows in the CLI chat (cross-device per-user toggle). */
  showThoughtsCli?: boolean;
  /** How many sent prompts the CLI chat keeps for ↑-recall, per project. */
  promptHistoryDepth: number;
  /** How long the first Esc stays armed in the CLI chat before a second press stops counting as the
   *  confirmation. Only the confirmation window — key decoding is unaffected. */
  interruptConfirmMs: number;
  scrollback: number;
  theme: TerminalThemeMode;
  palette: TerminalPalette;
}

/** One installed daemon plugin as listed by GET /plugins (admin). */
/** One row of GET /plugins/ui — an enabled plugin's browser UI: menu metadata (renderable before any
 *  bundle JS runs) plus the immutable content-hash bundle URL. */
export interface PluginUiListing {
  name: string;
  url: string;
  /** Immutable content-hash URL of the plugin's OWN stylesheet, when it ships one. The app is
   *  distributed PREBUILT, so its CSS carries only the utilities the host itself uses — a plugin that
   *  needs any other one has to bring it. Absent for a plugin (or a daemon) that ships none. */
  cssUrl?: string;
  apiVersion: number;
  /** Name of the plugin's world in the main navigation (manifest `web.label`, localized). Absent = the
   *  world borrows its first page's name. */
  label?: string;
  nav: { label: string; icon?: string; route?: string }[];
  /** `layout` picks the section's rendering: 'orbital' uses the constellation layout the core
   *  Settings sections use, anything else (or absent) the classic stacked rows. */
  settings: { id: string; label: string; icon?: string; layout?: 'classic' | 'orbital' }[];
  /** Localized flat view strings for the bundle (manifest `web.strings` merged with the locale's
   *  i18n overrides server-side). Optional so an older daemon's listing still parses. */
  strings?: Record<string, string>;
}

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  provides: { tools?: string[]; skills?: string[]; hooks?: string[]; platforms?: string[]; destinations?: string[] };
  source: 'bundled' | 'user';
  enabled: boolean;
  /** A soft-removed bundled plugin: hidden from the installed list, not loaded, restorable from the
   *  Available tab. Only ever true for `source: 'bundled'` (user plugins are uninstalled outright). */
  removed?: boolean;
  configurable: boolean;
  /** The plugin is handed out PER USER: non-admins reach it only once an admin grants it to them
   *  (`User.granted_plugins`). Drives the grant picker in the users panel. */
  userGrantable?: boolean;
  /** Per-locale manifest translations (from the plugin's `i18n/<lang>.json`). English lives in the
   *  manifest itself and is the fallback; a locale entry overrides `description` + per-field label/hint. */
  i18n?: Record<string, PluginI18n>;
  /** Derived from the plugin's log ring buffer: `error` when a recent error entry exists, else `ok`.
   *  Defaults to `ok` when the daemon has no log tap. */
  health?: 'ok' | 'error';
  /** True when the plugin ships a brand icon (`icon.svg`) on disk — the UI renders `<img>` from the
   *  icon route; otherwise it falls back to a lucide glyph. */
  hasIcon?: boolean;
}

/** Localized overrides for a plugin's manifest strings, keyed by config-field key. */
interface PluginI18n {
  description?: string;
  fields?: Record<string, { label?: string; hint?: string; options?: Record<string, string> }>;
}

/** One row of the plugin marketplace catalog (GET /plugins/marketplace): a curated-registry entry plus
 *  its on-disk status. `available` — installable. `installed` — a user plugin, up to date. `updateAvailable`
 *  — a user plugin with a newer version in the registry. `bundled` — the name is a built-in, so it's never
 *  offered for install/update. */
export interface MarketplaceEntry {
  name: string;
  version: string;
  description: string;
  category?: string;
  author?: string;
  homepage?: string;
  provides?: { tools?: number; skills?: number; platforms?: number };
  status: 'available' | 'installed' | 'updateAvailable' | 'bundled';
  installedVersion?: string;
}

/** GET /plugins/marketplace. `registryError` is set when the registry couldn't be reached/refreshed, so
 *  the UI can distinguish "unavailable" from a genuinely empty catalog. */
export interface Marketplace {
  plugins: MarketplaceEntry[];
  registryError?: string;
}

/** One declared plugin config field (drives the per-plugin settings form). Mirrors the backend
 *  `PluginConfigField` in `src/plugins/manifest.ts` exactly. Field-type semantics:
 *  - `section` — a labeled group header carrying no value.
 *  - `enum` — a single choice from `options`; `multiSelect` — multiple choices from `options`.
 *  - `code` — a code editor body; `language` hints the syntax mode. `prompt` — a prompt/markdown body.
 *  - `json` — a JSON blob validated as text. `embeddingModel` — an embedding-model picker (parallels `model`).
 *  - `destination` — one proactive-notification target from enabled platform providers.
 *  - `projects`/`plugins`/`tools`/`models` — multiple values from the matching live core catalog. */
export interface PluginConfigField {
  key: string;
  label: string;
  type:
    | 'string' | 'secret' | 'boolean' | 'number' | 'textarea' | 'rolePolicies' | 'model' | 'provider'
    | 'section' | 'enum' | 'multiSelect' | 'code' | 'prompt' | 'json' | 'embeddingModel' | 'mcpServers' | 'destination'
    | 'projects' | 'plugins' | 'tools' | 'models';
  hint?: string;
  required?: boolean;
  /** For `number` fields: input bounds and step; `placeholder` typically shows the default value. */
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** Out-of-box value the settings form pre-fills when nothing is stored yet (mirrors the plugin's
   *  runtime fallback, so pre-filling never changes behavior). */
  default?: string | number | boolean;
  /** For `provider` fields: restrict the picker to configured providers of this type (e.g. `openai`). */
  providerType?: string;
  /** Choices for `enum`/`multiSelect` fields. */
  options?: { value: string; label: string }[];
  /** Syntax mode for `code` fields (e.g. `js`, `python`). */
  language?: string;
  /** Richer help text than the one-line `hint`. */
  help?: string;
  /** Per-field risk label surfaced in the UI. */
  risk?: 'low' | 'medium' | 'high';
  /** Presentational grouping only: render this field in the plugin workspace's Advanced tab. */
  advanced?: boolean;
  /** Give this field the settings row to itself rather than sharing it with the next field. For a short
   *  value behind a long LABEL, the shared half-row is what looks broken. Presentational only. */
  fullWidth?: boolean;
  /** Conditional visibility: render this field only when field `key` currently equals `equals`. */
  visibleWhen?: { key: string; equals: string | number | boolean };
}

/** One platform role policy: admission, platform-admin status, and room-specific instructions. */
export interface RolePolicy { roleId: string; name: string; prompt: string; admin?: boolean }

/** One external MCP server row in a plugin's `mcpServers` config (the MCP-bridge pattern). `transport`
 *  picks how to reach it: `stdio` launches a local process (`command` + `args`, `env` extra vars — the
 *  default, backward-compatible when absent); `http`/`sse` connect to a remote `url`. `enabled` gates it. */
export interface McpServerSpec { name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean; transport?: 'stdio' | 'http' | 'sse'; url?: string }

/** A plugin's declared manifest capabilities — the deny-by-default permission surface. A missing entry
 *  means the plugin CANNOT perform that action: `mutates` lists the runtime mutation targets it is allowed
 *  to touch (only `turnContext` is runtime-wired in v1), `network` flags outbound access, `reads` names the
 *  data surfaces it reads, `hooks` the hook points it subscribes to. `{}` = declares nothing → mutates nothing. */
interface PluginCapabilities {
  hooks?: string[];
  mutates?: ('prompt' | 'turnContext' | 'tools' | 'memory' | 'events' | 'workflow-dag')[];
  reads?: string[];
  network?: boolean;
}

/** GET /plugins/:name — the detail behind each plugin's own settings section. */
export interface PluginDetail extends PluginInfo {
  configSchema: PluginConfigField[];
  config: Record<string, unknown>;
  secretsSet: string[];
  /** Summary of the plugin's persistent data directory (`pluginDataRoot/<name>`). `path` is `''` and
   *  `exists:false` when the data root is unset or the name is unsafe; `files`/`bytes` are recursive totals. */
  data: { path: string; exists: boolean; files: number; bytes: number };
  /** The plugin's declared manifest capabilities, or `{}` (deny-all) when the manifest omits them. */
  capabilities?: PluginCapabilities;
}

/** GET /plugins/:name/contributions — the runtime contribution report filtered to entries OWNED by the
 *  requested plugin (every `plugin` field equals that name). Powers both the Tools and Hooks detail sections. */
export interface PluginContributions {
  tools: { name: string; plugin: string }[];
  skills: { name: string; plugin: string }[];
  platforms: { name: string; plugin: string }[];
  promptFragments: { plugin: string }[];
  turnContexts: { plugin: string }[];
  hooks: { name: string; plugin: string }[];
}

/** One entry of a plugin's bounded log ring buffer (scope-stripped, oldest-first). */
interface PluginLogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/** GET /plugins/:name/logs — the tail of the plugin's log ring buffer plus the derived health. */
export interface PluginLogs {
  entries: PluginLogEntry[];
  health: 'ok' | 'error';
}

/** One daily log file on disk (daemon or web), as listed by GET /system/logs. */
interface LogFile {
  name: string;
  source: 'daemon' | 'web';
  bytes: number;
  /** Epoch millis of the last write — the list arrives sorted by it, newest first. */
  modifiedAt: number;
}

/** GET /system/logs — the daily log files plus the directory they live in. */
export interface LogFileList {
  dir: string;
  files: LogFile[];
}

/** GET /system/logs/:name — a bounded tail of one log file. `truncated` means older lines were dropped
 *  (the viewer then offers to load the whole file). */
export interface LogFileContent {
  name: string;
  lines: string[];
  totalLines: number;
  truncated: boolean;
  bytes: number;
}

/** One recorded run of a plugin hook (the shared HookAuditBuffer). `outcome`: `ok` = a context patch was
 *  accepted (`changed === 'turnContext'`); `rejected` = the capability gate denied the patch (deny-by-default,
 *  no `changed`); `threw`/`timeout` = fail-open, the hook produced no patch (no `changed`). `ts` is epoch ms. */
export interface PluginHookExecution {
  ts: number;
  plugin: string;
  hook: string;
  durationMs: number;
  outcome: 'ok' | 'threw' | 'timeout' | 'rejected';
  changed?: string;
}

/** GET /plugins/:name/hook-executions — the plugin's hook-run audit, NEWEST-FIRST. Empty when the
 *  hook-audit buffer isn't wired. */
export interface PluginHookExecutions {
  entries: PluginHookExecution[];
}

/** One scheduled job of the cronjob plugin (the raw jobs.json shape). `enabled: false` = paused;
 *  a one-shot job carries `runAt` instead of a recurring schedule. */
export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  /** Optional cheap shell guard run before the prompt — if it prints nothing (or fails) the brain turn
   *  is skipped (no LLM call); if it prints output, the brain runs and receives it. */
  check?: string;
  /** Optional "H-H" active-hours window (e.g. "5-21") outside which the job stays quiet. */
  hours?: string;
  /** Discord channel/thread the result is delivered to; empty = the plugin's default channel. */
  notifyChannelId?: string;
  /** true = deliver the reply as-is, without the "⏰ job name" header line. */
  plain?: boolean;
  /** Brain model the job runs on; empty = the server default. */
  model?: { provider: string; model: string };
  enabled?: boolean;
  /** The account this job belongs to. Absent/null = an instance job: created by an admin, running with
   *  admin powers and reporting to the notification channel. An owned job runs with its owner's rights
   *  and reports into that person's own conversation. */
  ownerUserId?: number | null;
  runAt?: string;
  createdAt?: string;
  lastRun?: string;
  lastResult?: string;
}

/** One admin-selectable proactive-notification target from an enabled platform plugin. `value` is the
 * opaque persisted routing token; callers display metadata but never construct or parse it. */
export interface NotificationDestinationOption {
  value: string;
  id: string;
  platform: string;
  kind: 'channel' | 'thread' | 'chat' | 'person';
  label: string;
  group?: string;
  subtitle?: string;
}

/** One admin-selectable tool from the live built-in + enabled-plugin registry catalog. */
export interface ToolCatalogOption {
  name: string;
  label: string;
  icon: string | null;
  plugin: string | null;
  group: 'memory' | 'image' | 'plugin';
}
/** Live WhatsApp pairing state for the plugin "Pair" modal: a QR rendered as a PNG data URL, the phone
 *  pairing code (phoneNumber flow), and whether the device is already linked. */

export interface SessionTask {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  metadata: Record<string, unknown>;
  blockedBy: string[];
  blocks: string[];
}

/** One markdown skill of the skills plugin (GET /plugins/skills/list). Bundled skills ship with the
 *  install and are read-only; user skills are created at runtime and can be edited or deleted.
 *  `disableModelInvocation` mirrors PI's `disable-model-invocation` frontmatter flag — when set the
 *  skill is hidden from progressive disclosure and reachable only via `/skill:name`. `version` mirrors
 *  the optional `metadata.version` frontmatter field (null when the skill carries none). */
/** One skill of the skills plugin. `owner` is the account it belongs to: null for a bundled or an
 *  instance-wide skill (everyone's), a user id for a personal one. Two accounts may hold the same name,
 *  so a write addresses a skill by name AND owner. `scope`/`active` are the resolver's own view of the
 *  row (where it comes from, and whether the skills plugin is actually loading it) — the `/skills` modal
 *  reports them so a skill that cannot currently be invoked never looks loadable. */
export interface PluginSkill { name: string; description: string; source: 'bundled' | 'user'; owner: number | null; canDelete: boolean; disableModelInvocation: boolean; version?: number | null; content?: string; scope?: string; active?: boolean; missingRequirement?: string }
/** One typed sub-agent of the subagent plugin (GET /plugins/agents/list). Built-in explore/plan ship
 *  with the install and are read-only; user agents are one `.md` each and can be edited or deleted.
 *  `tools` is the frontmatter spec: a preset keyword (`read-only`/`all`/`inherit`) or an explicit tool
 *  allow-list. `body` (the system prompt) is present only for user agents, so the editor can prefill. */
export interface PluginSubagent { name: string; description: string; tools: 'read-only' | 'all' | 'inherit' | string[]; source: 'builtin' | 'user'; canDelete: boolean; body?: string }
// Login no longer surfaces a token to the browser — the proxy sets it as an httpOnly cookie and
// returns only a success flag.
export type AuthResult = { ok: true };
/** One hour of the dashboard heatmap. Counts only -- who did what is the feed's job. */
export interface HeatmapBucket { day: string; hour: number; count: number }

/** Somebody on the presence rail. `working` is the daemon's LIVE view of a running turn; `lastTs` is
 *  when they were last seen, which is what keeps the rail populated the rest of the day. */
export interface PresenceEntry {
  userId: number;
  label: string;
  /** Raw username + avatar handle, so the rail can draw the real picture through the shared Avatar
   *  component instead of a monogram. Sent from the presence row's already-resolved account rather than
   *  fetched client-side: the accounts list is admin-only, and the dashboard is not. */
  username: string;
  avatar?: string;
  working: boolean;
  lastTs: string;
}

export interface ActivityEvent {
  id: number; ts: string; type: string; target: string; detail: string; project_id: number | null; label: string;
  /** Team-feed attribution. `actor_label` is resolved server-side by JOIN (display name, username
   *  fallback), so it follows a rename; an event whose account is gone simply has none. */
  actor_user_id: number | null;
  actor_label: string;
  /** From the same JOIN as the label, so a feed row can draw the person's avatar. Null when the row has
   *  no account behind it (unattributable, or the account was deleted). */
  actor_username: string | null;
  actor_avatar: string | null;
  surface: string;
  /** How many identical events this row folds, and when the last landed. `ts` is the first occurrence. */
  count: number;
  last_ts: string | null;
}
/** A worker's `elowen ask` question parked on a human (overseer escalated / none), shown in the Escalations inbox. */
export interface PendingAsk { askId: string; taskId: string; question: string; since: number; title: string; epicId: string | null; projectId: number }
export interface Project { id: number; slug: string; path: string; notes: string; icon: string; pr_enabled: boolean | null }
interface GitStatus { branch: string; ahead: number; behind: number; dirty: number; clean: boolean }
interface GitBranch { name: string; current: boolean }
interface GitCommit { hash: string; subject: string; author: string; relative: string }
export interface ProjectGit { isRepo: boolean; status: GitStatus | null; branches: GitBranch[]; commits: GitCommit[] }
/** A handoff note one agent left for later agents on the same mission. */
export interface Note { id: number; scope: string; target: string; author: string; body: string; created_at: string }


/** One entry in a project's file tree. */
export interface FileNode { path: string; type: 'file' | 'dir' }
/** A shallow directory listing for the new-project path picker (server-side filesystem browse). */
export interface DirListing { path: string; parent: string | null; entries: { name: string; path: string }[] }

/** Elowen's own version + update posture for the System settings panel. `latest` is null when the npm
 *  registry can't be reached; `updateAvailable` is then false. */
export interface SystemInfo {
  version: string;
  latest: string | null;
  updateAvailable: boolean;
  autoUpdate: boolean;
  /** When this build was last installed (package.json mtime, ISO); null if unreadable. */
  lastUpdatedAt: string | null;
  diagnostics: {
    cpuPercent: number;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    uptimeSeconds: number;
  };
}

/** One first-run readiness row from GET /system/readiness — a subsystem the onboarding UI reports on
 *  (chat/tasks/missions/memory/platforms/plugins). `ok=false` on `chat` means no provider resolves, so
 *  the agent cannot answer. Admin-only endpoint. */
interface ReadinessCheck { id: string; label: string; ok: boolean; detail: string; hint?: string }
export interface SystemReadiness { checks: ReadinessCheck[] }

/** Per-provider install status of the `elowen-workflow` agent skill (Settings → System). The backend also
 *  returns a parsed `version`, but the panel renders only the derived state below, so it's omitted here. */
interface SkillStatus {
  provider: string;
  present: boolean;
  installed: boolean;
  upToDate: boolean;
}
export interface SkillsInfo {
  skills: SkillStatus[];
}
export interface SkillInstallResult {
  results: Array<{ provider: string; installed: boolean; skipped: boolean; error?: string }>;
}

// One stored memory — the daemon's `MemoryRow`, shared via the wire contract (re-exported at the top
// of this file). Per-user and private — every route derives identity from the session, never a
// body/param id. `status` is closed to what the daemon's API schema enums.

// One user-defined (or built-in) memory category (the daemon's `MemoryCategoryRow`, shared via the
// wire contract). Per-user. `is_builtin` is 0/1 and `color` is a hex/token string used by the UI badge.

/** Body for POST /memory/categories — only `name` is required (409 on duplicate name). */
export interface MemoryCategoryCreate { name: string; description?: string; color?: string; icon?: string; projectId?: number | null }
/** Any subset of the mutable fields for PATCH /memory/categories/:cid (409 on duplicate name). */
export interface MemoryCategoryPatch { name?: string; description?: string; color?: string; icon?: string; projectId?: number | null }

/** Workspace-level categorization provider settings (GET /memory/categorization). `configured` reflects
 *  whether provider/model/baseUrl are complete enough to classify. */
export interface CategorizationSettings {
  providerId: string;
  model: string;
  baseUrl: string;
  configured: boolean;
}
/** Patch for PUT /memory/categorization (admin-gated). */
export interface CategorizationSettingsPatch {
  providerId?: string;
  model?: string;
  baseUrl?: string;
}

// One entry of a memory's audit trail (the daemon's `MemoryEventRow`, shared via the wire contract).
// `memory_id` is null for events whose memory was hard-removed; `before_json`/`after_json` are raw JSON
// snapshots.

/** Body for POST /memory — only `body` is required. */
export interface MemoryCreate { body: string; kind?: string; importance?: number; confidence?: number }
/** Any subset of the mutable fields for PATCH /memory/:id. Category assignment is NOT here — it's a
 *  separate audited write via PUT /memory/:id/category (elowenClient.setMemoryCategory). */
export interface MemoryPatch { body?: string; kind?: string; importance?: number; confidence?: number; status?: 'active' | 'archived' | 'deleted' }
/** Query filters for GET /memory. A non-blank `q` switches the daemon to fulltext search. `categoryId`
 *  present-and-null/empty lists uncategorized, a number lists that category, absent (key omitted) lists all. */
export interface MemoryFilters { status?: string; kind?: string; q?: string; limit?: number; offset?: number; categoryId?: number | null }

/** Workspace-level embedding provider settings (GET /memory/embedding). `configured` reflects whether the
 *  provider/model/baseUrl are complete enough to embed. */
export interface EmbeddingSettings {
  providerId: string;
  model: string;
  baseUrl: string;
  dimensions: number | null;
  configured: boolean;
}

/** Patch for PUT /memory/embedding (admin-gated). */
export interface EmbeddingSettingsPatch {
  providerId?: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number | null;
}

/** One scored retrieval candidate in the debug breakdown. `picked` marks the memories actually returned. */
export interface RetrievalScore {
  id: number;
  score: number;
  semantic: number;
  importanceWeight: number;
  recencyWeight: number;
  usageWeight: number;
  picked: boolean;
}

/** POST /memory/retrieve result — the picked memories plus the scoring trace. `fallback` is true whenever
 *  the keyword path answered instead of the vector one — either embeddings are unconfigured (then `provider`
 *  is null) or they ran but nothing cleared the relevance floor (then `provider` is set). The UI keys the
 *  "unconfigured" warning off `provider`, not off `fallback` alone. */
export interface RetrievalResult {
  memories: Memory[];
  debug: {
    query: string;
    fallback: boolean;
    provider: string | null;
    model: string | null;
    candidates: number;
    scores: RetrievalScore[];
  };
}

/** Where a cost figure came from, so the UI never presents an estimate as billed truth. */
type CostSource = 'provider_reported' | 'calculated' | 'unavailable';

/** Token/cost usage for a task's agent run, read from the executor CLI's local session storage or the
 *  embedded brain's session (+ the provider's reported cost, when it sends one). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Reasoning tokens — a subset of `output` (display only). Absent on legacy rows. */
  reasoning?: number;
  costUsd: number | null;
  /** Currency of `costUsd` (practically always 'USD'); null when there's no cost. Absent on legacy rows. */
  currency?: string | null;
  /** Provenance of `costUsd`. Absent on legacy rows (treat as unknown). */
  costSource?: CostSource;
  /** Average output tokens/sec over measured generations (brain sessions only); null when unmeasured. */
  outputTps?: number | null;
  /** The output tokens `outputTps` was measured over — a subset of `output`. Weight an average across
   *  buckets by this (their seconds are measuredOutput / outputTps), never by `output`. 0 when nothing was
   *  measured; absent on older daemons, which makes the bucket unweightable → keep it out of the average. */
  measuredOutput?: number;
}

/** Total token/cost usage aggregated for one executor identity. `exec` is the backward-compatible id. */
export interface ModelUsage {
  id?: string;
  exec: string;
  program?: string | null;
  provider?: string | null;
  model?: string;
  usage: TokenUsage;
}

/** Whether a user can reach a tool. `allowed` = they can invoke it; `inherited` = granted by session
 *  role (e.g. memory tools every session gets), not a per-user grant; `disabled` = an admin switched
 *  this plugin tool off for the user; `unavailable` = the plugin providing it was never granted to
 *  this user, so it cannot reach their session at all and there is nothing to toggle. */
type UserToolState = 'allowed' | 'inherited' | 'disabled' | 'unavailable';

/** One tool on the users-panel access overview. `icon` is a manifest/built-in emoji, or null → the
 *  client renders a fallback glyph. `plugin` is the owning plugin id, or null for built-ins.
 *  `toggleable` is true for plugin tools the admin can switch on/off per user (built-ins are fixed). */
export interface UserToolPill {
  name: string;
  label: string;
  icon: string | null;
  plugin: string | null;
  group: 'memory' | 'image' | 'plugin';
  state: UserToolState;
  toggleable: boolean;
}

/** Compact per-user overview stats for the users panel. `topModel` is the model used in the most brain
 *  sessions over the whole history, or null when the user has no sessions with a recorded model. */
export interface UserStats {
  memoryCount: number;
  sessionCount: number;
  topModel: string | null;
}

/** One day's rolled-up spend, for the dashboard's 7-day trend. `day` is `YYYY-MM-DD` (UTC, by task
 *  settlement date); `cost` is null when no task closed that day carried a cost (claude/codex → "—").
 *  Only days with settled tasks are returned — the client pads the gaps with zero. */
export interface DayUsage {
  day: string;
  tokens: number;
  cost: number | null;
}

/** Result of a usage reset: how many rows each of the three independent counters lost. */
export interface ResetUsageResult {
  ok: boolean;
  cleared: number;
  chatCleared?: number;
  originsCleared?: number;
}

/** Which axis GET /usage/by-origin collapses: per account, per address, or the raw pair of both. */
export type UsageOriginGroup = 'user' | 'origin' | 'pair';

/** One row of the admin origin view. `userId`/`origin` is null on whichever axis the grouping collapsed.
 *  `trusted` is false when any contributing turn's address was a claim the daemon could not verify —
 *  render it, never hide the row. `cost` is null when nothing in the bucket reported a price: that is
 *  "unknown", not $0. `originKind` distinguishes a real address (`ip`) from a loopback client (`local`),
 *  work no HTTP request ordered (`internal`), a chat bridge (`platform`) and an aged-out, redacted
 *  address (`redacted`). */
interface UsageOriginRow {
  userId: number | null;
  username: string | null;
  origin: string | null;
  originKind: 'ip' | 'local' | 'internal' | 'platform' | 'redacted' | null;
  trusted: boolean;
  origins: number;
  turns: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  costSource: CostSource;
  costedTurns: number;
  firstAt: number;
  lastAt: number;
}

/** GET /usage/by-origin. `trackingSince` is the oldest day the rollup holds (null = nothing recorded
 *  yet); everything the instance spent before it has no origin and never will, so the UI must state the
 *  window rather than let the numbers read as the whole history. */
export interface UsageByOriginResult {
  rows: UsageOriginRow[];
  group: UsageOriginGroup;
  trackingSince: string | null;
}
