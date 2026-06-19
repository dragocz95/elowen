import type { TaskStore } from '../store/taskStore.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { EventBus } from '../api/sse.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import type { Clock } from '../shared/clock.js';
import { resolveExecutor } from './routing.js';

export interface SchedulerDeps {
  tasks: TaskStore; spawn: SpawnService; bus: EventBus;
  /** Every registered project — the scheduler launches due tasks across all of them. */
  projects: { list(): { id: number; path: string }[] };
  fallback: AgentSpec;
  nameAgent: () => string; clock: Clock;
}

/** Launches open, autostart tasks whose scheduled_at has arrived, then clears the schedule.
 *  Scheduled tasks without autostart are due-date markers only — never auto-launched.
 *  Runs across every registered project. */
export class Scheduler {
  constructor(private d: SchedulerDeps) {}

  async tick(): Promise<void> {
    const nowIso = new Date(this.d.clock.now()).toISOString();
    for (const project of this.d.projects.list()) {
      const due = this.d.tasks
        .list({ project_id: project.id, status: 'open' })
        .filter((t) => t.autostart && t.scheduled_at != null && t.scheduled_at <= nowIso); // ISO-8601 UTC compares lexicographically
      for (const task of due) {
        const spec = resolveExecutor(task.labels, this.d.fallback);
        const named = task.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
        const agentName = named || this.d.nameAgent();
        this.d.tasks.update(task.id, { scheduled_at: null }); // consume so it fires once
        this.d.tasks.setAgent(task.id, agentName);            // link task → session for run controls
        this.d.tasks.markStarted(task.id, this.d.clock.now()); // precise spawn time → correct usage attribution under concurrency
        this.d.tasks.setStatus(task.id, 'in_progress');
        await this.d.spawn.launch({
          projectId: project.id, projectPath: project.path, taskId: task.id,
          agentName, spec, taskTitle: task.title, taskDescription: task.description,
          epicId: task.parent_id ?? undefined,
        });
        this.d.bus.publish({ type: 'task', taskId: task.id, status: 'in_progress' });
      }
    }
  }
}
