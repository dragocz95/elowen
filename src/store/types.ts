import type { CommitFileChange } from '../integrations/projectFiles.js';

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'closed' | 'cancelled';
export type MissionState = 'active' | 'stalled' | 'paused' | 'disengaged';
export interface Task {
  id: string; project_id: number; title: string; type: string;
  status: TaskStatus; priority: string; parent_id: string | null; labels: string[];
  description: string; scheduled_at: string | null;
  autostart: number; result_summary: string | null; outcome: string | null; closed_at: string | null;
  created_at?: string;
  /** Frozen per-task change list, captured at close: the files this task committed with +/− churn.
   *  Empty for tasks that committed nothing (or were closed by hand without an agent baseline). */
  changed_files: CommitFileChange[];
  /** The base/head SHAs the change list was diffed between, so a single file's diff can be regenerated
   *  on demand. Null until the task is closed with a snapshot. */
  base_sha: string | null; head_sha: string | null;
  /** Transient input for this task's next run — a review-reject rationale, or a stuck/manual relaunch
   *  reason — surfaced in the re-spawned agent's prompt. Null when there's nothing pending. */
  resume_note: string | null;
}
export interface CreateTaskInput {
  id: string; project_id: number; title: string;
  type?: string; priority?: string; parent_id?: string | null; labels?: string[];
  description?: string; scheduled_at?: string | null; autostart?: number;
}
