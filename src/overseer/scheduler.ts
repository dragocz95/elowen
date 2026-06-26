import type { TaskStore } from '../store/taskStore.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { EventBus } from '../api/sse.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import type { Clock } from '../shared/clock.js';
import { KeyedMutex } from '../shared/keyedMutex.js';
import { resolveExecutor } from './routing.js';
import { parseResumeLabel } from '../spawn/resume/index.js';
import { projectHead } from '../integrations/projectFiles.js';
import { checkoutBusy, checkoutOf } from './checkout.js';
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
    const resolver = { projectPath: (id: number) => this.d.projects.get(id)?.path ?? '', worktreeFor: this.d.worktreeFor };
    for (const project of this.d.projects.list()) {
      // Compare as epochs (#39): `scheduled_at` is stored as the client sent it, which may carry a
      // non-UTC zone (e.g. `+02:00`). A lexical string compare against a UTC ISO `now` would then
      // misjudge the same instant. `Date.parse` collapses both to absolute time.
      const due = this.d.tasks
        .list({ project_id: project.id, status: 'open' })
        .filter((t) => t.autostart && t.scheduled_at != null && Date.parse(t.scheduled_at) <= now);
      for (const task of due) {
        const cwd = checkoutOf(resolver, task); // a standalone task's checkout is the shared project path
        // Shared (non-PR) checkouts are single-writer: at most one agent edits a project's tree at a
        // time, so each task's committed delta stays cleanly attributable. Read the occupied set FRESH
        // here (not a tick-start snapshot): the scheduler and the mission engine tick concurrently, so a
        // stale snapshot could miss a launch another tick made into this checkout during one of our
        // awaits. This is also the burst cap — co-scheduled tasks sharing a checkout fire one per tick.
        if (checkoutBusy(resolver, this.d.tasks.list({ status: 'in_progress' }), cwd)) continue;
        const spec = resolveExecutor(task.labels, this.d.fallback);
        const named = task.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
        const agentName = named || this.d.nameAgent();
        const originalSchedule = task.scheduled_at;
        // Everything from the fresh check above through setStatus runs synchronously (no await between),
        // so the check-and-claim is atomic: a concurrent tick that re-reads in_progress sees this task
        // the instant we yield at the gitLock await below, and can't double-occupy the checkout.
        this.d.tasks.update(task.id, { scheduled_at: null }); // consume so it fires once
        this.d.tasks.setAgent(task.id, agentName);            // link task → session for run controls
        this.d.tasks.markStarted(task.id, now); // precise spawn time → correct usage attribution under concurrency
        this.d.tasks.setStatus(task.id, 'in_progress');
        // Read HEAD + stamp the baseline under the checkout lock, so it lands AFTER any in-flight
        // commit on this checkout (a just-closed task still committing) and the snapshot range is exact.
        await this.gitLock.run(cwd, async () => this.d.tasks.markBase(task.id, await projectHead(cwd)));
        try {
          await this.d.spawn.launch({
            projectId: project.id, projectPath: cwd, taskId: task.id,
            agentName, spec, taskTitle: task.title, taskDescription: task.description,
            resumeNote: task.resume_note ?? undefined,
            epicId: task.parent_id ?? undefined,
            resume: parseResumeLabel(task.labels),
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
        this.d.bus.publish({ type: 'task', taskId: task.id, status: 'in_progress' });
      }
    }
  }
}
