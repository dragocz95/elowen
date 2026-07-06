export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'closed' | 'cancelled';
/** Outcome the daemon records when a task closes (`src/store/types.ts`). */
type TaskOutcome = 'ok' | 'fail';
export interface Task { id: string; title: string; status: TaskStatus; type?: string; priority?: string; labels?: string[]; description?: string; scheduled_at?: string | null; autostart?: number; result_summary?: string | null; outcome?: TaskOutcome | null; closed_at?: string | null; created_at?: string; parent_id?: string | null; project_id?: number; changed_files?: CommitFileChange[]; resume_note?: string | null }
type SessionRole = 'overseer' | 'pilot' | 'agent' | 'advisor';
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
export interface PlanInput { goal: string; name?: string; exec?: string; autoModel?: boolean; autonomy?: string; maxSessions?: number; engage?: boolean; phases?: { title: string; type?: string }[]; project_id?: number; prEnabled?: boolean | null }
export interface PlanResult { epic: Task; phases: Task[]; mission?: Mission }
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
export interface OrcaConfig {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  modelNotes: Record<string, string>;
  autopilot: { model: string; overseerModel: string; apiUrl: string; providerId: string; apiKeySet: boolean; notes: string; prompt: string; pilotExec: string; overseerExec: string; reviewOnDone: boolean; prEnabled: boolean; prBaseBranch: string; prAutoOpen: boolean; prVerifyCommand: string; ghTokenSet: boolean };
  providers: Record<string, { bin: string; args: string; skipPermissions: boolean; resume: boolean }>;
  defaults: { exec: string; autonomy: string; maxSessions: number };
  security: { tokenTtlDays: number };
  autoUpdate: boolean;
  plugins?: { enabled: string[]; removed?: string[] };
  brain?: { providers: BrainProvider[]; agentName?: string; maxSteps?: number; modelContextWindows?: Record<string, number> };
}

/** How a brain provider talks upstream: a custom endpoint (API key) or a connected OAuth account. */
export type BrainProviderType = 'openai' | 'anthropic' | 'oauth-anthropic' | 'oauth-github-copilot' | 'oauth-openai-codex';
export interface BrainProvider {
  id: string;
  label: string;
  type: BrainProviderType;
  baseUrl: string;
  models: string[];
  apiKeySet: boolean;
}
/** One Orca AI (brain) model. `source` = how its provider authenticates (drives the OAuth badge). */
export interface BrainModelOption { provider: string; providerLabel: string; model: string; exec: string; source: 'api-key' | 'oauth' | 'relay'; contextWindow: number; contextWindowSet: boolean }
/** One brain conversation in the session picker (web chat + CLI). */
export interface BrainSessionInfo { id: string; title: string; model: string; updated_at: string; running: boolean; active: boolean }
/** A row in the admin session-management panel (all brain sessions the operator anchors). */
export interface ManagedSession { id: string; title: string; model: string; updated_at: string; running: boolean; active: boolean; kind: 'conversation' | 'channel' | 'task'; tokens: number }
/** Mirror of the daemon's slash-command def (src/brain/slashCommands.ts) — published at GET /brain/commands. */
export interface SlashCommandDef { name: string; description: string; kind: 'action' | 'info' | 'picker'; adminOnly?: boolean }
/** One fulltext-search match across the caller's brain conversations. */
export interface BrainSearchHit { sessionId: string; sessionTitle: string; role: string; snippet: string; ts: string }
/** A stored brain turn shaped for display. */
export type BrainSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string; diff?: string };
export interface BrainMessage { role: string; text: string; segments?: BrainSegment[] }

/** ask_user_question wire shapes (mirror src/brain/events.ts). The `ask` SSE event carries `id` +
 *  `questions`; the client POSTs `answers` back to /brain/answer. */
export interface AskOption { label: string; description?: string }
export interface AskQuestion { question: string; header: string; multiSelect: boolean; options: AskOption[] }
export interface AskAnswer { header: string; selected: string[]; other?: string }

/** ctx.emitCard display card (mirror src/brain/events.ts) — a live panel keyed by `id`. */
export interface BrainCardItem { text: string; status?: 'pending' | 'in_progress' | 'completed' }
export interface BrainCard { id: string; title?: string; items?: BrainCardItem[]; body?: string; pinned?: boolean }
/** Live statusline numbers for the active conversation. */
export interface BrainUsage { tokens: number | null; contextWindow: number; percent: number | null; totalTokens: number; cost: number }
/** The statusline plugin's display toggles (null = plugin disabled). */
export interface StatuslineConfig { showModel?: boolean; showContext?: boolean; showTokens?: boolean; showCost?: boolean }
export interface BrainStatus { running: boolean; sessionId: string | null; model: string; usage: BrainUsage | null; statusline: StatuslineConfig | null; pendingAsk?: { id: string; questions: AskQuestion[] } | null; cards?: BrainCard[] }
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
  autopilot?: { model?: string; overseerModel?: string; apiUrl?: string; providerId?: string; apiKey?: string; notes?: string; prompt?: string; pilotExec?: string; overseerExec?: string; reviewOnDone?: boolean; prEnabled?: boolean; prBaseBranch?: string; prAutoOpen?: boolean; prVerifyCommand?: string; ghToken?: string };
  providers?: Record<string, { bin: string; args: string }>;
  defaults?: { exec?: string; autonomy?: string; maxSessions?: number };
  security?: { tokenTtlDays?: number };
  autoUpdate?: boolean;
  /** Wholesale brain provider list; an entry may carry `apiKey` to (re)set that provider's secret. */
  brain?: { providers?: (Omit<BrainProvider, 'apiKeySet'> & { apiKey?: string })[]; agentName?: string; maxSteps?: number; modelContextWindows?: Record<string, number> };
}
export interface MissionTask { id: string; title: string; status: TaskStatus; type: string; parent_id: string | null; labels?: string[]; outcome?: TaskOutcome | null }
interface MissionProgress { total: number; open: number; inProgress: number; blocked: number; closed: number; cancelled: number }
export interface MissionDeps { taskId: string; dependsOnId: string }
export interface MissionPrInfo { branch: string; prNumber: number | null; prUrl: string | null; prState: string | null; fixRounds: number; lastFeedback: string | null }
export interface MissionDetail {
  mission: Mission;
  epic: MissionTask | null;
  tasks: MissionTask[];
  deps: MissionDeps[];
  progress: MissionProgress;
  pr?: MissionPrInfo | null;
}
export interface User { id: number; username: string; created_at: string; is_admin: boolean; allowed_execs: string[]; disabled_tools: string[]; name: string; email: string; avatar: string; default_exec: string; advisor_exec: string; advisor_autostart: boolean }
export interface UserPatch { is_admin?: boolean; allowed_execs?: string[]; disabled_tools?: string[] }
export interface ProfilePatch { name?: string; email?: string; default_exec?: string }

/** A user-editable agent prompt: the shipped default plus this user's override (null = using default).
 *  `vars` lists the `{{placeholders}}` the template substitutes; `jsonContract` flags prompts whose
 *  model output is parsed as JSON (shown with a warning in the editor). */
export interface UserPrompt {
  name: string;
  group: 'workers' | 'pilot' | 'overseer' | 'advisor';
  vars: string[];
  jsonContract: boolean;
  /** System-managed template: the user's text appends to it instead of replacing it (default hidden). */
  appendOnly?: boolean;
  default: string;
  override: string | null;
}

/** A named personality profile: a prompt body a user pins active per platform ('web'/'discord'/'cli').
 *  Scoped per (user, platform); `enabled` gates whether the pinned profile actually applies. The active
 *  pointer lives server-side — the UI derives which profile is active from the preview's append layer. */
export interface PersonalityProfile {
  id: number;
  user_id: number;
  platform: string;
  name: string;
  description: string;
  tone: string;
  style: string;
  prompt: string;
  enabled: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Body for POST /personality/profiles — platform/name/prompt are required, the rest optional. */
export interface PersonalityCreate {
  platform: string;
  name: string;
  prompt: string;
  description?: string;
  tone?: string;
  style?: string;
  enabled?: boolean;
}

/** Any subset of the mutable fields for PATCH /personality/profiles/:id. */
export type PersonalityPatch = Partial<Omit<PersonalityCreate, 'platform'>> & { platform?: string };

/** Per-user CLI/brain settings surfaced in Account → CLI. `model` empty → the configured brain default
 *  (`serverDefault`, response-only). */
export interface CliSettings { model: string; modelProvider: string; visionModel: string; visionModelProvider: string; thinkingLevel: string; autoCompact: boolean; autoCompactAt: number; advisorStyle: string; discordUserId: string; whatsappNumber: string; autoRecall: boolean; autoSave: boolean; serverDefault?: string }

/** One installed daemon plugin as listed by GET /plugins (admin). */
export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  provides: { tools?: string[]; skills?: string[]; hooks?: string[]; platforms?: string[] };
  source: 'bundled' | 'user';
  enabled: boolean;
  /** A soft-removed bundled plugin: hidden from the installed list, not loaded, restorable from the
   *  Available tab. Only ever true for `source: 'bundled'` (user plugins are uninstalled outright). */
  removed?: boolean;
  configurable: boolean;
  /** Per-locale manifest translations (from the plugin's `i18n/<lang>.json`). English lives in the
   *  manifest itself and is the fallback; a locale entry overrides `description` + per-field label/hint. */
  i18n?: Record<string, PluginI18n>;
  /** Derived from the plugin's log ring buffer: `error` when a recent error entry exists, else `ok`.
   *  Defaults to `ok` when the daemon has no log tap. */
  health?: 'ok' | 'error';
  /** True when the plugin ships a brand icon (`icon.svg`) on disk — the UI renders `<img>` from the
   *  icon route; otherwise it falls back to a lucide glyph. */
  hasIcon?: boolean;
  /** True when the plugin ships a hero illustration (`illustration.png`) — shown big on the detail page. */
  hasIllustration?: boolean;
}

/** Localized overrides for a plugin's manifest strings, keyed by config-field key. */
export interface PluginI18n {
  description?: string;
  fields?: Record<string, { label?: string; hint?: string }>;
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
 *  - `json` — a JSON blob validated as text. `embeddingModel` — an embedding-model picker (parallels `model`). */
export interface PluginConfigField {
  key: string;
  label: string;
  type:
    | 'string' | 'secret' | 'boolean' | 'number' | 'textarea' | 'rolePolicies' | 'model' | 'provider'
    | 'section' | 'enum' | 'multiSelect' | 'code' | 'prompt' | 'json' | 'embeddingModel' | 'mcpServers';
  hint?: string;
  required?: boolean;
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
  /** Conditional visibility: render this field only when field `key` currently equals `equals`. */
  visibleWhen?: { key: string; equals: string | number | boolean };
}

/** One role → access mapping row in a plugin's `rolePolicies` config (the Discord pattern). */
export interface RolePolicy { roleId: string; name: string; projectIds: number[]; prompt: string; tools?: string[]; admin?: boolean }

/** One external MCP server row in a plugin's `mcpServers` config (the MCP-bridge pattern). `transport`
 *  picks how to reach it: `stdio` launches a local process (`command` + `args`, `env` extra vars — the
 *  default, backward-compatible when absent); `http`/`sse` connect to a remote `url`. `enabled` gates it. */
export interface McpServerSpec { name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean; transport?: 'stdio' | 'http' | 'sse'; url?: string }

/** A plugin's declared manifest capabilities — the deny-by-default permission surface. A missing entry
 *  means the plugin CANNOT perform that action: `mutates` lists the runtime mutation targets it is allowed
 *  to touch (only `turnContext` is runtime-wired in v1), `network` flags outbound access, `reads` names the
 *  data surfaces it reads, `hooks` the hook points it subscribes to. `{}` = declares nothing → mutates nothing. */
export interface PluginCapabilities {
  hooks?: string[];
  mutates?: ('prompt' | 'turnContext' | 'tools' | 'memory')[];
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
export interface PluginLogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/** GET /plugins/:name/logs — the tail of the plugin's log ring buffer plus the derived health. */
export interface PluginLogs {
  entries: PluginLogEntry[];
  health: 'ok' | 'error';
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
  runAt?: string;
  createdAt?: string;
  lastRun?: string;
  lastResult?: string;
}

/** One text-capable Discord destination (GET /plugins/discord/channels) for the cron channel picker. */
export interface DiscordChannelOption { id: string; name: string; type: 'channel' | 'thread'; parentName?: string }
/** Live WhatsApp pairing state for the plugin "Pair" modal: a QR rendered as a PNG data URL, the phone
 *  pairing code (phoneNumber flow), and whether the device is already linked. */
export interface WhatsAppPairing { qrImage: string | null; code: string | null; connected: boolean }

/** One markdown skill of the skills plugin (GET /plugins/skills/list). Bundled skills ship with the
 *  install and are read-only; user skills are created at runtime and can be deleted. */
export interface PluginSkill { name: string; description: string; source: 'bundled' | 'user' }
// Login no longer surfaces a token to the browser — the proxy sets it as an httpOnly cookie and
// returns only a success flag.
export type AuthResult = { ok: true };
export interface ActivityEvent { id: number; ts: string; type: string; target: string; detail: string; project_id: number | null; label: string }
/** A worker's `orca ask` question parked on a human (overseer escalated / none), shown in the Escalations inbox. */
export interface PendingAsk { askId: string; taskId: string; question: string; since: number; title: string; epicId: string | null; projectId: number }
export interface Project { id: number; slug: string; path: string; notes: string; icon: string; pr_enabled: boolean | null }
interface GitStatus { branch: string; ahead: number; behind: number; dirty: number; clean: boolean }
interface GitBranch { name: string; current: boolean }
interface GitCommit { hash: string; subject: string; author: string; relative: string }
export interface ProjectGit { isRepo: boolean; status: GitStatus | null; branches: GitBranch[]; commits: GitCommit[] }
export interface CommitFileChange { path: string; added: number; deleted: number }
export interface CommitLogEntry { hash: string; subject: string; author: string; timestamp: number; files: CommitFileChange[] }
/** A handoff note one agent left for later agents on the same mission. */
export interface Note { id: number; scope: string; target: string; author: string; body: string; created_at: string }


export interface CliStatus {
  name: string;
  installed: boolean;
  functional: boolean;
  version: string | null;
  error: string | null;
}

interface FreshInstallInfo {
  noConfigPersisted: boolean;
  noApiKey: boolean;
  noCustomSetup: boolean;
}

export interface CliDetectionResult {
  tools: CliStatus[];
  summary: { allInstalled: boolean; allFunctional: boolean };
  freshInstall: FreshInstallInfo;
}

/** GitHub auth posture for the PR-native workflow. `method` is what a push would actually use. */
export interface GithubAuthStatus {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  account: string | null;
  tokenSet: boolean;
  ready: boolean;
  method: 'token' | 'gh' | 'none';
}

/** One entry in a project's file tree. */
export interface FileNode { path: string; type: 'file' | 'dir' }
/** A shallow directory listing for the new-project path picker (server-side filesystem browse). */
export interface DirListing { path: string; parent: string | null; entries: { name: string; path: string }[] }

/** Orca's own version + update posture for the System settings panel. `latest` is null when the npm
 *  registry can't be reached; `updateAvailable` is then false. */
export interface SystemInfo {
  version: string;
  latest: string | null;
  updateAvailable: boolean;
  autoUpdate: boolean;
  /** When this build was last installed (package.json mtime, ISO); null if unreadable. */
  lastUpdatedAt: string | null;
}

/** Per-provider install status of the `orca-workflow` agent skill (Settings → System). The backend also
 *  returns a parsed `version`, but the panel renders only the derived state below, so it's omitted here. */
export interface SkillStatus {
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

/** One stored memory (mirrors the daemon's MemoryRow). Per-user and private — every route derives
 *  identity from the session, never a body/param id. */
export interface Memory {
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

/** One user-defined (or built-in) memory category (mirrors the daemon's MemoryCategoryRow). Per-user.
 *  `is_builtin` is 0/1 and `color` is a hex/token string used by the UI badge. */
export interface MemoryCategory {
  id: number;
  user_id: number;
  name: string;
  description: string;
  color: string;
  /** One of the shared lucide icon allowlist (see web/lib/categoryIcons.tsx). Empty string → Folder. */
  icon: string;
  is_builtin: number;
  created_at: string;
}

/** Body for POST /memory/categories — only `name` is required (409 on duplicate name). */
export interface MemoryCategoryCreate { name: string; description?: string; color?: string; icon?: string }
/** Any subset of the mutable fields for PATCH /memory/categories/:cid (409 on duplicate name). */
export interface MemoryCategoryPatch { name?: string; description?: string; color?: string; icon?: string }

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

/** One entry of a memory's audit trail (mirrors the daemon's MemoryEventRow). `memory_id` is null for
 *  events whose memory was hard-removed; `before_json`/`after_json` are raw JSON snapshots. */
export interface MemoryEvent {
  id: number;
  memory_id: number | null;
  user_id: number;
  action: string;
  before_json: string | null;
  after_json: string | null;
  actor: string;
  reason: string;
  /** Inference model that performed the action (curator/categorizer), or null for user/system events. */
  model: string | null;
  created_at: string;
}

/** Body for POST /memory — only `body` is required. */
export interface MemoryCreate { body: string; kind?: string; importance?: number; confidence?: number }
/** Any subset of the mutable fields for PATCH /memory/:id. Category assignment is NOT here — it's a
 *  separate audited write via PUT /memory/:id/category (orcaClient.setMemoryCategory). */
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

/** POST /memory/retrieve result — the picked memories plus the scoring trace. `fallback` is true when
 *  embeddings are unconfigured and the daemon fell back to keyword matching. */
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
export type CostSource = 'provider_reported' | 'calculated' | 'unavailable';

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
}

/** Total token/cost usage aggregated for one model (exec spec). */
export interface ModelUsage {
  exec: string;
  usage: TokenUsage;
}

/** Whether a user can reach a tool. `allowed` = they can invoke it; `inherited` = granted by session
 *  role (e.g. memory tools every session gets), not a per-user grant; `disabled` = an admin switched
 *  this plugin tool off for the user; `unavailable` = out of reach (e.g. the operator-only orca_*
 *  control plane for a non-admin). */
export type UserToolState = 'allowed' | 'inherited' | 'disabled' | 'unavailable';

/** One tool on the users-panel access overview. `icon` is a manifest/built-in emoji, or null → the
 *  client renders a fallback glyph. `plugin` is the owning plugin id, or null for built-ins.
 *  `toggleable` is true for plugin tools the admin can switch on/off per user (built-ins are fixed). */
export interface UserToolPill {
  name: string;
  label: string;
  icon: string | null;
  plugin: string | null;
  group: 'orca' | 'memory' | 'plugin';
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

/** Result of a usage reset: how many task_usage snapshot rows were wiped. */
export interface ResetUsageResult {
  ok: boolean;
  cleared: number;
}
