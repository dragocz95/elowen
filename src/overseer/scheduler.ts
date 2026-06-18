import type { TaskStore } from '../store/taskStore.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { EventBus } from '../api/sse.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import type { Clock } from '../shared/clock.js';
import { resolveExecutor } from './routing.js';

export interface SchedulerDeps {
  tasks: TaskStore; spawn: SpawnService; bus: EventBus;
  project: { id: number; path: string }; fallback: AgentSpec;
  nameAgent: () => string; clock: Clock;
}

/** Launches open, autostart tasks whose scheduled_at has arrived, then clears the schedule.
 *  Scheduled tasks without autostart are due-date markers only — never auto-launched. */
export class Scheduler {
  constructor(private d: SchedulerDeps) {}

  async tick(): Promise<void> {
    const nowIso = new Date(this.d.clock.now()).toISOString();
    const due = this.d.tasks
      .list({ project_id: this.d.project.id, status: 'open' })
      .filter((t) => t.autostart && t.scheduled_at != null && t.scheduled_at <= nowIso); // ISO-8601 UTC compares lexicographically
    for (const task of due) {
      const spec = resolveExecutor(task.labels, this.d.fallback);
      const named = task.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
      const agentName = named || this.d.nameAgent();
      this.d.tasks.update(task.id, { scheduled_at: null }); // consume so it fires once
      this.d.tasks.setAgent(task.id, agentName);            // link task → session for run controls
      this.d.tasks.setStatus(task.id, 'in_progress');
      await this.d.spawn.launch({
        projectId: this.d.project.id, projectPath: this.d.project.path, taskId: task.id,
        agentName, spec, taskTitle: task.title, taskDescription: task.description,
      });
      this.d.bus.publish({ type: 'task', taskId: task.id, status: 'in_progress' });
    }
  }
}
