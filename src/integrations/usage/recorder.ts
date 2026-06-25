import type { OrcaEvent, EventBus } from '../../api/sse.js';
import type { TaskStore } from '../../store/taskStore.js';
import type { TaskUsageStore } from '../../store/taskUsageStore.js';
import type { AgentSpec } from '../../spawn/commandBuilder.js';
import type { Task } from '../../store/types.js';
import { readTaskUsage } from './index.js';
import { execOfLabels } from './byModel.js';
import type { TokenUsage } from './types.js';
import { logger } from '../../shared/logger.js';

const log = logger('usage-recorder');

type ReadUsage = (task: Pick<Task, 'id' | 'labels' | 'created_at'>, siblings: Pick<Task, 'id' | 'labels' | 'created_at'>[], projectPath: string, fallback: AgentSpec) => TokenUsage | null;

export interface UsageRecorderDeps {
  usage: TaskUsageStore;
  tasks: Pick<TaskStore, 'get' | 'list'>;
  /** Where the task's CLI logged usage (the mission worktree under PR-native, else the project path). */
  pathFor: (task: { project_id: number; parent_id: string | null }) => string;
  fallback: AgentSpec;
  /** Injectable for tests; defaults to the real CLI-session reader. */
  read?: ReadUsage;
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

  private handle(e: OrcaEvent): void {
    if (e.type !== 'task' || (e.status !== 'closed' && e.status !== 'cancelled')) return;
    const task = this.d.tasks.get(e.taskId);
    if (!task) return;
    const exec = execOfLabels(task.labels);
    if (!exec) return; // nothing to attribute (no exec label → no model)
    const siblings = this.d.tasks.list({ project_id: task.project_id });
    const usage = this.read(task, siblings, this.d.pathFor(task), this.d.fallback);
    if (!usage) return; // CLI session not found / not persisted — leave it unrecorded
    this.d.usage.record(task.id, task.project_id, exec, usage);
  }
}
