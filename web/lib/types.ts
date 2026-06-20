export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'closed' | 'cancelled';
export interface Task { id: string; title: string; status: TaskStatus; type?: string; priority?: string; labels?: string[]; description?: string; scheduled_at?: string | null; autostart?: number; result_summary?: string | null; outcome?: string | null; closed_at?: string | null; created_at?: string; parent_id?: string | null }
export interface Session { name: string }
export type SessionRole = 'overseer' | 'pilot' | 'agent';
/** Structured identity of a live agent session, classified by the daemon (single source of truth).
 *  Clients render from `role` — they never parse meaning out of the raw session name. */
export interface SessionInfo { name: string; role: SessionRole; agent: string; missionId?: string }
export interface Mission { id: string; epic_id: string; autonomy: string; max_sessions: number; state: string }
export interface CreateTaskInput { title: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; autostart?: number; deps?: string[] }
export interface UpdateTaskInput { title?: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; autostart?: number; deps?: string[] }
export interface PlanInput { goal: string; exec?: string; autonomy?: string; maxSessions?: number; engage?: boolean; phases?: { title: string; type?: string }[] }
export interface PlanResult { epic: Task; phases: Task[]; mission?: Mission }
export interface PlanPhase { title: string; type: string; agent?: string; details?: string }
export type PlanJobStatus = 'planning' | 'done' | 'failed';
export interface PlanJob { id: string; epicId: string | null; goal: string; status: PlanJobStatus; phases: PlanPhase[]; error?: string }
/** Autopilot planning is async: the endpoint returns a job to poll. Manual mode still returns a PlanResult. */
export type PlanSubmitResult = { jobId: string; epicId?: string } | PlanResult;
export interface InsertPhasesInput { phases?: { title: string; type?: string }[]; goal?: string; exec?: string; prompt?: string }
export interface InsertPhasesResult { epic: Task; phases: Task[] }
export interface EngageInput { epicId: string; autonomy: string; maxSessions: number; clearedGuardrails: string[] }
export type DerivedSignal = { type: 'working' } | { type: 'complete' } | { type: 'needs_input'; question: string };
export interface OrcaConfig {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  autopilot: { model: string; overseerModel: string; apiUrl: string; apiKeySet: boolean; notes: string; prompt: string; pilotExec: string; overseerExec: string; reviewOnDone: boolean };
  providers: Record<string, { bin: string; args: string }>;
  defaults: { exec: string; autonomy: string; maxSessions: number };
}
export interface ConfigPatch {
  allowedExecs?: string[];
  customModels?: { label: string; exec: string }[];
  hiddenPresets?: string[];
  autopilot?: { model?: string; overseerModel?: string; apiUrl?: string; apiKey?: string; notes?: string; prompt?: string; pilotExec?: string; overseerExec?: string; reviewOnDone?: boolean };
  providers?: Record<string, { bin: string; args: string }>;
  defaults?: { exec?: string; autonomy?: string; maxSessions?: number };
}
export interface MissionTask { id: string; title: string; status: TaskStatus; type: string; parent_id: string | null; labels?: string[]; outcome?: string | null }
export interface MissionProgress { total: number; open: number; inProgress: number; blocked: number; closed: number; cancelled: number }
export interface MissionDeps { taskId: string; dependsOnId: string }
export interface MissionDetail {
  mission: Mission;
  epic: MissionTask | null;
  tasks: MissionTask[];
  deps: MissionDeps[];
  progress: MissionProgress;
}
export interface User { id: number; username: string; created_at: string; is_admin: boolean; allowed_execs: string[]; name: string; email: string; avatar: string; default_exec: string }
export interface UserPatch { is_admin?: boolean; allowed_execs?: string[] }
export interface ProfilePatch { name?: string; email?: string; default_exec?: string }
export interface AuthResult { token: string; user: User }
export interface ActivityEvent { id: number; ts: string; type: string; target: string; detail: string }
export interface Project { id: number; slug: string; path: string; notes: string }
export interface GitStatus { branch: string; ahead: number; behind: number; dirty: number; clean: boolean }
export interface GitBranch { name: string; current: boolean }
export interface GitCommit { hash: string; subject: string; author: string; relative: string }
export interface ProjectGit { isRepo: boolean; status: GitStatus | null; branches: GitBranch[]; commits: GitCommit[] }

export interface HermesStatus {
  home: string;
  exists: boolean;
  pluginsDir: boolean;
  pluginInstalled: boolean;
  enabled: boolean;
}
export interface HermesInstallInput { home?: string; url: string; token: string; timeout?: number }
export interface HermesInstallResult {
  pluginDir: string;
  copied: boolean;
  alreadyEnabled: boolean;
  enabled: boolean;
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

export interface FreshInstallInfo {
  noConfigPersisted: boolean;
  noApiKey: boolean;
  noCustomSetup: boolean;
}

export interface CliDetectionResult {
  tools: CliStatus[];
  summary: { allInstalled: boolean; allFunctional: boolean };
  freshInstall: FreshInstallInfo;
}

/** One entry in a project's file tree. */
export interface FileNode { path: string; type: 'file' | 'dir' }

/** Token/cost usage for a task's agent run, read from the executor CLI's local session storage. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number | null;
}
