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
  autopilot: { model: string; overseerModel: string; apiUrl: string; apiKeySet: boolean; notes: string; prompt: string; pilotExec: string; overseerExec: string; reviewOnDone: boolean; prEnabled: boolean; prBaseBranch: string; prAutoOpen: boolean; prVerifyCommand: string; ghTokenSet: boolean };
  providers: Record<string, { bin: string; args: string; skipPermissions: boolean; resume: boolean }>;
  defaults: { exec: string; autonomy: string; maxSessions: number };
  security: { tokenTtlDays: number };
  autoUpdate: boolean;
  plugins?: { enabled: string[] };
  brain?: { providers: BrainProvider[]; agentName?: string };
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
export interface BrainModelOption { provider: string; providerLabel: string; model: string; exec: string; source: 'api-key' | 'oauth' | 'relay' }
/** One brain conversation in the session picker (web chat + CLI). */
export interface BrainSessionInfo { id: string; title: string; model: string; updated_at: string; running: boolean; active: boolean }
/** One fulltext-search match across the caller's brain conversations. */
export interface BrainSearchHit { sessionId: string; sessionTitle: string; role: string; snippet: string; ts: string }
/** A stored brain turn shaped for display. */
export type BrainSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string; diff?: string };
export interface BrainMessage { role: string; text: string; segments?: BrainSegment[] }
/** Live statusline numbers for the active conversation. */
export interface BrainUsage { tokens: number | null; contextWindow: number; percent: number | null; totalTokens: number; cost: number }
/** The statusline plugin's display toggles (null = plugin disabled). */
export interface StatuslineConfig { showModel?: boolean; showContext?: boolean; showTokens?: boolean; showCost?: boolean }
export interface BrainStatus { running: boolean; sessionId: string | null; model: string; usage: BrainUsage | null; statusline: StatuslineConfig | null }
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
  autopilot?: { model?: string; overseerModel?: string; apiUrl?: string; apiKey?: string; notes?: string; prompt?: string; pilotExec?: string; overseerExec?: string; reviewOnDone?: boolean; prEnabled?: boolean; prBaseBranch?: string; prAutoOpen?: boolean; prVerifyCommand?: string; ghToken?: string };
  providers?: Record<string, { bin: string; args: string }>;
  defaults?: { exec?: string; autonomy?: string; maxSessions?: number };
  security?: { tokenTtlDays?: number };
  autoUpdate?: boolean;
  /** Wholesale brain provider list; an entry may carry `apiKey` to (re)set that provider's secret. */
  brain?: { providers?: (Omit<BrainProvider, 'apiKeySet'> & { apiKey?: string })[]; agentName?: string };
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
export interface User { id: number; username: string; created_at: string; is_admin: boolean; allowed_execs: string[]; name: string; email: string; avatar: string; default_exec: string; advisor_exec: string; advisor_autostart: boolean }
export interface UserPatch { is_admin?: boolean; allowed_execs?: string[] }
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

/** Per-user CLI/brain settings surfaced in Account → CLI. `model` empty → the configured brain default
 *  (`serverDefault`, response-only). */
export interface CliSettings { model: string; modelProvider: string; visionModel: string; visionModelProvider: string; thinkingLevel: string; autoCompact: boolean; autoCompactAt: number; advisorStyle: string; discordUserId: string; serverDefault?: string }

/** One installed daemon plugin as listed by GET /plugins (admin). */
export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  provides: { tools?: string[]; skills?: string[]; hooks?: string[]; platforms?: string[] };
  source: 'bundled' | 'user';
  enabled: boolean;
  configurable: boolean;
  /** Per-locale manifest translations (from the plugin's `i18n/<lang>.json`). English lives in the
   *  manifest itself and is the fallback; a locale entry overrides `description` + per-field label/hint. */
  i18n?: Record<string, PluginI18n>;
}

/** Localized overrides for a plugin's manifest strings, keyed by config-field key. */
export interface PluginI18n {
  description?: string;
  fields?: Record<string, { label?: string; hint?: string }>;
}

/** One declared plugin config field (drives the per-plugin settings form). */
export interface PluginConfigField {
  key: string;
  label: string;
  type: 'string' | 'secret' | 'boolean' | 'number' | 'textarea' | 'rolePolicies' | 'model' | 'provider';
  hint?: string;
  required?: boolean;
  /** For `provider` fields: restrict the picker to configured providers of this type (e.g. `openai`). */
  providerType?: string;
}

/** One role → access mapping row in a plugin's `rolePolicies` config (the Discord pattern). */
export interface RolePolicy { roleId: string; name: string; projectIds: number[]; prompt: string; tools?: string[]; admin?: boolean }

/** GET /plugins/:name — the detail behind each plugin's own settings section. */
export interface PluginDetail extends PluginInfo {
  configSchema: PluginConfigField[];
  config: Record<string, unknown>;
  secretsSet: string[];
}

/** One scheduled job of the cronjob plugin (the raw jobs.json shape). `enabled: false` = paused;
 *  a one-shot job carries `runAt` instead of a recurring schedule. */
export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  /** Optional "H-H" active-hours window (e.g. "5-21") outside which the job stays quiet. */
  hours?: string;
  /** Discord channel/thread the result is delivered to; empty = the plugin's default channel. */
  notifyChannelId?: string;
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

/** Token/cost usage for a task's agent run, read from the executor CLI's local session storage. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number | null;
}

/** Total token/cost usage aggregated for one model (exec spec). */
export interface ModelUsage {
  exec: string;
  usage: TokenUsage;
}

/** Result of a usage reset: how many task_usage snapshot rows were wiped. */
export interface ResetUsageResult {
  ok: boolean;
  cleared: number;
}
