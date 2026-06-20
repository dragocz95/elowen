import type { TaskStore } from '../store/taskStore.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { EventBus } from '../api/sse.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import type { Clock } from '../shared/clock.js';
import { resolveExecutor } from './routing.js';
import { detectGuardrails } from './guardrails.js';

export interface SchedulerDeps {
  tasks: TaskStore; spawn: SpawnService; bus: EventBus;
  /** Every registered project — the scheduler launches due tasks across all of them. */
  projects: { list(): { id: number; path: string }[] };
  fallback: AgentSpec;
  nameAgent: () => string; clock: Clock;
  /** Max autostart tasks to launch per project in a single tick. Caps a burst of co-scheduled tasks
   *  (e.g. 50 due at the same minute) from spawning 50 parallel agents at once and exhausting API
   *  quota/resources; the rest stay due and fire on the next tick. */
  maxPerProjectPerTick?: number;
}

const DEFAULT_MAX_PER_PROJECT_PER_TICK = 5;

/** Launches open, autostart tasks whose scheduled_at has arrived, then clears the schedule.
 *  Scheduled tasks without autostart are due-date markers only — never auto-launched.
 *  Runs across every registered project. */
export class Scheduler {
  constructor(private d: SchedulerDeps) {}

  async tick(): Promise<void> {
    const now = this.d.clock.now();
    const limit = this.d.maxPerProjectPerTick ?? DEFAULT_MAX_PER_PROJECT_PER_TICK;
    for (const project of this.d.projects.list()) {
      // Compare as epochs (#39): `scheduled_at` is stored as the client sent it, which may carry a
      // non-UTC zone (e.g. `+02:00`). A lexical string compare against a UTC ISO `now` would then
      // misjudge the same instant. `Date.parse` collapses both to absolute time.
      const due = this.d.tasks
        .list({ project_id: project.id, status: 'open' })
        .filter((t) => t.autostart && t.scheduled_at != null && Date.parse(t.scheduled_at) <= now);
      let launched = 0;
      for (const task of due) {
        if (launched >= limit) break; // per-project burst cap — the rest stay due for the next tick
        // Guardrail gate: a scheduled autostart task fires with no autonomy level and no overseer in
        // the loop, so — unlike a mission spawn — nothing would catch a sensitive one. If its title
        // trips a guardrail, leave it open (don't consume the schedule) so it can't auto-run
        // unattended; a human can launch it manually.
        if (detectGuardrails(task.title).length > 0) continue;
        const spec = resolveExecutor(task.labels, this.d.fallback);
        const named = task.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
        const agentName = named || this.d.nameAgent();
        const originalSchedule = task.scheduled_at;
        this.d.tasks.update(task.id, { scheduled_at: null }); // consume so it fires once
        this.d.tasks.setAgent(task.id, agentName);            // link task → session for run controls
        this.d.tasks.markStarted(task.id, now); // precise spawn time → correct usage attribution under concurrency
        this.d.tasks.setStatus(task.id, 'in_progress');
        try {
          await this.d.spawn.launch({
            projectId: project.id, projectPath: project.path, taskId: task.id,
            agentName, spec, taskTitle: task.title, taskDescription: task.description,
            epicId: task.parent_id ?? undefined,
          });
        } catch (e) {
          // Spawn failed (tmux down, bin missing): roll back so the schedule isn't silently lost (O9).
          // Restore status to open and the original scheduled_at so the next tick retries it.
          this.d.tasks.update(task.id, { scheduled_at: originalSchedule });
          this.d.tasks.setStatus(task.id, 'open');
          this.d.bus.publish({ type: 'task', taskId: task.id, status: 'open' });
          console.error(`[orca] scheduler: spawn failed for task ${task.id} — schedule restored: ${String(e)}`);
          continue;
        }
        this.d.bus.publish({ type: 'task', taskId: task.id, status: 'in_progress' });
        launched++;
      }
    }
  }
}
