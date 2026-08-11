import type { ElowenEvent } from '../../../../src/api/sse.js';
import type { AgentsBus as EventBus } from '../lib/bus.js';
import type { TaskStore } from '../../../../src/store/taskStore.js';
import type { TaskUsageStore } from '../../../../src/store/taskUsageStore.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import type { Task } from '../../../../src/store/types.js';
import { readTaskUsage } from './index.js';
import { captureResumeLabel, type ResumeCaptureDeps } from './resumeCapture.js';
import { execOfLabels } from './byModel.js';
import type { TokenUsage } from './types.js';
import { logger } from '../lib/logger.js';

const log = logger('usage-recorder');

type RecorderTask = Pick<Task, 'id' | 'labels' | 'created_at'>;
type ReadUsage = (task: RecorderTask, siblings: RecorderTask[], projectPath: string, fallback: AgentSpec) => TokenUsage | null;

export interface UsageRecorderDeps {
  usage: TaskUsageStore;
  tasks: Pick<TaskStore, 'get' | 'list' | 'setResumeLabel'>;
  /** Where the task's CLI logged usage (the mission worktree under PR-native, else the project path). */
  pathFor: (task: { project_id: number; parent_id: string | null }) => string;
  fallback: AgentSpec;
  /** Injectable for tests; defaults to the real CLI-session reader. */
  read?: ReadUsage;
  /** Injectable for tests; defaults to the real CLI-session-id detector. */
  detect?: ResumeCaptureDeps['detect'];
}

/** The single EventBus subscriber that snapshots a task's token/cost usage into `task_usage` the
 *  moment it settles (closed/cancelled). Reading the CLI session store happens once, here, for one
 *  task — so the stats page never re-scans gigabytes of transcripts on a request. Every step is
 *  null-guarded and the handler is wrapped so a read miss or error can't abort the bus broadcast. */
export class UsageRecorder {
  private read: ReadUsage;
  constructor(private d: UsageRecorderDeps) {
    this.read = d.read ?? readTaskUsage;
  }

  /** Subscribe to the bus; returns the unsubscribe fn. */
  subscribe(bus: EventBus): () => void {
    return bus.subscribe((e) => {
      try { this.handle(e); } catch (err) { log.error('usage snapshot failed', err); }
    });
  }

  private handle(e: ElowenEvent): void {
    if (e.type !== 'task' || (e.status !== 'closed' && e.status !== 'cancelled')) return;
    const task = this.d.tasks.get(e.taskId);
    if (!task) return;
    const exec = execOfLabels(task.labels);
    if (!exec) return; // nothing to attribute (no exec label → no model)
    // Embedded-brain workers have no CLI session on disk: BrainWorkerService records their usage
    // itself at close, and there is nothing to capture for resume (rehydration is store-driven).
    if (exec.startsWith('elowen:')) return;
    const siblings = this.d.tasks.list({ project_id: task.project_id });
    const projectPath = this.d.pathFor(task);
    // Stamp the CLI session id for resume FIRST, independent of usage: even if token parsing comes up
    // empty (e.g. a codex rollout with no cumulative total), the session still exists and is resumable.
    // Isolated in its own try/catch so a resume-detection miss can never cost the usage snapshot below.
    try {
      captureResumeLabel({ tasks: this.d.tasks, pathFor: this.d.pathFor, fallback: this.d.fallback, detect: this.d.detect }, task, siblings);
    } catch (err) {
      log.error('resume-label capture failed', err);
    }
    const usage = this.read(task, siblings, projectPath, this.d.fallback);
    if (!usage) return; // CLI session not found / not persisted — leave it unrecorded
    this.d.usage.record(task.id, task.project_id, exec, usage);
  }
}
