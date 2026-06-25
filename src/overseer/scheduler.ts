import type { TaskStore } from '../store/taskStore.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { EventBus } from '../api/sse.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import type { Clock } from '../shared/clock.js';
import { KeyedMutex } from '../shared/keyedMutex.js';
import { resolveExecutor } from './routing.js';
import { projectHead } from '../integrations/projectFiles.js';
import { busySharedCheckouts, checkoutOf } from './checkout.js';
import { logger } from '../shared/logger.js';

const log = logger('scheduler');

export interface SchedulerDeps {
  tasks: TaskStore; spawn: SpawnService; bus: EventBus;
  /** Every registered project — the scheduler launches due tasks across all of them. */
  projects: { list(): { id: number; path: string }[]; get(id: number): { id: number; path: string } | null };
  fallback: AgentSpec;
  nameAgent: () => string; clock: Clock;
  /** Serializes the spawn-time baseline read so a shared checkout's HEAD can't shift mid-snapshot.
   *  Must be the SAME instance shared with the mission engine and API server, or cross-component
   *  serialization breaks. Absent → a private lock (fine for isolated unit tests). */
  gitLock?: KeyedMutex;
  /** A PR mission's isolated worktree, used to tell a shared checkout apart from an isolated one when
   *  deciding whether a standalone task must wait for the checkout to free up. */
  worktreeFor?: (missionId: string) => string | null | undefined;
}

/** Launches open, autostart tasks whose scheduled_at has arrived, then clears the schedule.
 *  Scheduled tasks without autostart are due-date markers only — never auto-launched.
 *  Runs across every registered project. */
export class Scheduler {
  private readonly gitLock: KeyedMutex;
  constructor(private d: SchedulerDeps) { this.gitLock = d.gitLock ?? new KeyedMutex(); }

  async tick(): Promise<void> {
    const now = this.d.clock.now();
    // Shared (non-PR) checkouts are single-writer: a task waits for the checkout to free up so its
    // committed delta stays cleanly attributable. Track which are occupied across ALL projects/missions
    // (a non-PR mission phase and a standalone task can target the same project.path) and grow the set
    // as this tick launches more.
    const resolver = { projectPath: (id: number) => this.d.projects.get(id)?.path ?? '', worktreeFor: this.d.worktreeFor };
    const busy = busySharedCheckouts(resolver, this.d.tasks.list({ status: 'in_progress' }));
    for (const project of this.d.projects.list()) {
      // Compare as epochs (#39): `scheduled_at` is stored as the client sent it, which may carry a
      // non-UTC zone (e.g. `+02:00`). A lexical string compare against a UTC ISO `now` would then
      // misjudge the same instant. `Date.parse` collapses both to absolute time.
      const due = this.d.tasks
        .list({ project_id: project.id, status: 'open' })
        .filter((t) => t.autostart && t.scheduled_at != null && Date.parse(t.scheduled_at) <= now);
      for (const task of due) {
        const cwd = checkoutOf(resolver, task); // a standalone task's checkout is the shared project path
        // Shared-checkout serialization is itself the burst cap: every standalone task in a project
        // shares the project checkout, so once one launches the rest are `busy` and wait for the next
        // tick — a minute's worth of co-scheduled tasks can't spawn a swarm of parallel agents at once.
        if (busy.has(cwd)) continue; // shared checkout already has a live agent — serialize, retry next tick
        const spec = resolveExecutor(task.labels, this.d.fallback);
        const named = task.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
        const agentName = named || this.d.nameAgent();
        const originalSchedule = task.scheduled_at;
        this.d.tasks.update(task.id, { scheduled_at: null }); // consume so it fires once
        this.d.tasks.setAgent(task.id, agentName);            // link task → session for run controls
        this.d.tasks.markStarted(task.id, now); // precise spawn time → correct usage attribution under concurrency
        // Flip to in_progress BEFORE the first await: the busy-gate's cross-tick correctness depends on
        // it. A concurrent mission/scheduler tick computes `busy` from the in_progress list, so if we
        // yielded (at the gitLock await below) while still 'open', that tick could miss this task and
        // launch a second agent into the same shared checkout — re-opening the C1/H1 attribution race.
        this.d.tasks.setStatus(task.id, 'in_progress');
        // Read HEAD + stamp the baseline under the checkout lock, so it lands AFTER any in-flight
        // commit on this checkout (a just-closed task still committing) and the snapshot range is exact.
        await this.gitLock.run(cwd, async () => this.d.tasks.markBase(task.id, await projectHead(cwd)));
        try {
          await this.d.spawn.launch({
            projectId: project.id, projectPath: cwd, taskId: task.id,
            agentName, spec, taskTitle: task.title, taskDescription: task.description,
            epicId: task.parent_id ?? undefined,
          });
        } catch (e) {
          // Spawn failed (tmux down, bin missing): roll back so the schedule isn't silently lost (O9).
          // Restore status to open and the original scheduled_at so the next tick retries it.
          this.d.tasks.update(task.id, { scheduled_at: originalSchedule });
          this.d.tasks.setStatus(task.id, 'open');
          this.d.bus.publish({ type: 'task', taskId: task.id, status: 'open' });
          log.error(`spawn failed for task ${task.id} — schedule restored`, e);
          continue;
        }
        busy.add(cwd); // this checkout is now occupied — later tasks this tick wait for it
        this.d.bus.publish({ type: 'task', taskId: task.id, status: 'in_progress' });
      }
    }
  }
}
