import type { TaskStore } from '../../../../src/store/taskStore.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import type { Task } from '../../../../src/store/types.js';
import { detectSessionId, type DetectedSession } from './sessionId.js';
import type { UsageTask } from './rank.js';

type CaptureTask = Pick<Task, 'id' | 'labels' | 'created_at' | 'project_id' | 'parent_id'>;
type DetectSession = (task: UsageTask, siblings: UsageTask[], projectPath: string, fallback: AgentSpec) => DetectedSession | null;

export interface ResumeCaptureDeps {
  tasks: Pick<TaskStore, 'list' | 'setResumeLabel'>;
  /** Where the task's CLI logged its session (mission worktree under PR-native, else project path). */
  pathFor: (task: { project_id: number; parent_id: string | null }) => string;
  fallback: AgentSpec;
  /** Injectable for tests; defaults to the real CLI-session-id detector. */
  detect?: DetectSession;
}

/** Detect the CLI session a task's agent just ran under and stamp it as the task's `resume:` label, so
 *  a later re-spawn can `--resume` it (full context) instead of cold-starting. Single source shared by
 *  the usage recorder (at close/cancel) and the stuck detector (when it reverts a dead agent to open) —
 *  the two moments a task stops running and its session settles on disk. No-op when no session matches
 *  (CLI unused, not persisted, unsupported program). `siblings` may be passed to avoid a re-list. */
export function captureResumeLabel(d: ResumeCaptureDeps, task: CaptureTask, siblings?: UsageTask[]): void {
  const detect = d.detect ?? detectSessionId;
  const sibs = siblings ?? d.tasks.list({ project_id: task.project_id });
  const detected = detect(task, sibs, d.pathFor(task), d.fallback);
  if (detected) d.tasks.setResumeLabel(task.id, detected.program, detected.sessionId);
}
