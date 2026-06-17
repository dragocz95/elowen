export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'closed' | 'cancelled';
export interface Task { id: string; title: string; status: TaskStatus; type?: string; priority?: string; labels?: string[] }
export interface Session { name: string }
export interface Mission { id: string; epic_id: string; autonomy: string; max_sessions: number; state: string }
export type DerivedSignal = { type: 'working' } | { type: 'complete' } | { type: 'needs_input'; question: string };
export type OrcaEvent =
  | { type: 'signal'; session: string; signal: DerivedSignal }
  | { type: 'mission'; missionId: string; state: string }
  | { type: 'task'; taskId: string; status: string };
