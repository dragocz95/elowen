export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'closed' | 'cancelled';
/** Outcome the daemon records when a task closes (`src/store/types.ts`). */
type TaskOutcome = 'ok' | 'fail';
export interface Task { id: string; title: string; status: TaskStatus; type?: string; priority?: string; labels?: string[]; description?: string; scheduled_at?: string | null; autostart?: number; result_summary?: string | null; outcome?: TaskOutcome | null; closed_at?: string | null; created_at?: string; parent_id?: string | null; project_id?: number; changed_files?: CommitFileChange[] }
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
export interface UpdateTaskInput { title?: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; autostart?: number; deps?: string[] }
export interface PlanInput { goal: string; name?: string; exec?: string; autoModel?: boolean; autonomy?: string; maxSessions?: number; engage?: boolean; phases?: { title: string; type?: string }[]; project_id?: number; prEnabled?: boolean | null }
export interface PlanResult { epic: Task; phases: Task[]; mission?: Mission }
interface PlanPhase { title: string; type: string; agent?: string; details?: string }
type PlanJobStatus = 'planning' | 'done' | 'failed';
export interface PlanJob { id: string; epicId: string | null; goal: string; status: PlanJobStatus; phases: PlanPhase[]; error?: string; sessionName?: string }
/** Autopilot planning is async: the endpoint returns a job to poll. Manual mode still returns a PlanResult. */
export type PlanSubmitResult = { jobId: string; epicId?: string } | PlanResult;
export interface InsertPhasesInput { phases?: { title: string; type?: string }[]; goal?: string; exec?: string; prompt?: string }
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
  providers: Record<string, { bin: string; args: string; skipPermissions: boolean }>;
  defaults: { exec: string; autonomy: string; maxSessions: number };
  security: { tokenTtlDays: number };
  autoUpdate: boolean;
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
// Login no longer surfaces a token to the browser — the proxy sets it as an httpOnly cookie and
// returns only a success flag.
export type AuthResult = { ok: true };
export interface ActivityEvent { id: number; ts: string; type: string; target: string; detail: string; project_id: number | null; label: string }
export interface Project { id: number; slug: string; path: string; notes: string; icon: string; pr_enabled: boolean | null }
interface GitStatus { branch: string; ahead: number; behind: number; dirty: number; clean: boolean }
interface GitBranch { name: string; current: boolean }
interface GitCommit { hash: string; subject: string; author: string; relative: string }
export interface ProjectGit { isRepo: boolean; status: GitStatus | null; branches: GitBranch[]; commits: GitCommit[] }
export interface CommitFileChange { path: string; added: number; deleted: number }
export interface CommitLogEntry { hash: string; subject: string; author: string; timestamp: number; files: CommitFileChange[] }
/** A handoff note one agent left for later agents on the same mission. */
export interface Note { id: number; scope: string; target: string; author: string; body: string; created_at: string }

export interface HermesStatus {
  home: string;
  exists: boolean;
  registered: boolean;
  enabled: boolean;
}
export interface HermesInstallInput { home?: string; url: string; token: string }
export interface HermesInstallResult {
  mcpUrl: string;
  registered: boolean;
  enabled: boolean;
  envWritten: boolean;
  backedUp: boolean;
  status: HermesStatus;
}

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
