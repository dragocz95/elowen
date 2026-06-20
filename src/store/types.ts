export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'closed' | 'cancelled';
export type MissionState = 'active' | 'stalled' | 'paused' | 'disengaged';
export interface Task {
  id: string; project_id: number; title: string; type: string;
  status: TaskStatus; priority: string; parent_id: string | null; labels: string[];
  description: string; scheduled_at: string | null;
  autostart: number; result_summary: string | null; outcome: string | null; closed_at: string | null;
  created_at?: string;
}
export interface CreateTaskInput {
  id: string; project_id: number; title: string;
  type?: string; priority?: string; parent_id?: string | null; labels?: string[];
  description?: string; scheduled_at?: string | null; autostart?: number;
}
