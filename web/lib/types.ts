export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'closed' | 'cancelled';
export interface Task { id: string; title: string; status: TaskStatus; type?: string; priority?: string; labels?: string[]; description?: string; scheduled_at?: string | null }
export interface Session { name: string }
export interface Mission { id: string; epic_id: string; autonomy: string; max_sessions: number; state: string }
export interface CreateTaskInput { title: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; deps?: string[] }
export interface UpdateTaskInput { title?: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; deps?: string[] }
export interface PlanInput { goal: string; exec?: string; autonomy?: string; maxSessions?: number; engage?: boolean; phases?: { title: string; type?: string }[] }
export interface PlanResult { epic: Task; phases: Task[]; mission?: Mission }
export interface EngageInput { epicId: string; autonomy: string; maxSessions: number; clearedGuardrails: string[] }
export type DerivedSignal = { type: 'working' } | { type: 'complete' } | { type: 'needs_input'; question: string };
// Wire contract — must mirror the backend canonical definition in src/api/sse.ts
export type OrcaEvent =
  | { type: 'signal'; session: string; signal: DerivedSignal }
  | { type: 'mission'; missionId: string; state: string }
  | { type: 'task'; taskId: string; status: string };
export interface OrcaConfig {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  autopilot: { model: string; apiUrl: string; apiKeySet: boolean; notes: string; prompt: string };
  providers: Record<string, { bin: string; args: string }>;
  defaults: { exec: string; autonomy: string; maxSessions: number };
}
export interface ConfigPatch {
  allowedExecs?: string[];
  customModels?: { label: string; exec: string }[];
  hiddenPresets?: string[];
  autopilot?: { model?: string; apiUrl?: string; apiKey?: string; notes?: string; prompt?: string };
  providers?: Record<string, { bin: string; args: string }>;
  defaults?: { exec?: string; autonomy?: string; maxSessions?: number };
}
export interface MissionTask { id: string; title: string; status: TaskStatus; type: string; parent_id: string | null }
export interface MissionProgress { total: number; open: number; inProgress: number; blocked: number; closed: number; cancelled: number }
export interface MissionDeps { taskId: string; dependsOnId: string }
export interface MissionDetail {
  mission: Mission;
  epic: MissionTask | null;
  tasks: MissionTask[];
  deps: MissionDeps[];
  progress: MissionProgress;
}
export interface User { id: number; username: string; created_at: string }
export interface AuthResult { token: string; user: User }
export interface ActivityEvent { id: number; ts: string; type: string; target: string; detail: string }
export interface Project { id: number; slug: string; path: string; notes: string }
export interface GitStatus { branch: string; ahead: number; behind: number; dirty: number; clean: boolean }
export interface GitBranch { name: string; current: boolean }
export interface GitCommit { hash: string; subject: string; author: string; relative: string }
export interface ProjectGit { isRepo: boolean; status: GitStatus | null; branches: GitBranch[]; commits: GitCommit[] }
