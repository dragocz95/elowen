import { resolveExecutor } from '../../overseer/routing.js';
import { checkoutBusy, checkoutOf } from '../../overseer/checkout.js';
import { parseResumeLabel } from '../../spawn/resume/index.js';
import { resolveOwnerId } from '../../prompts/owner.js';
import { projectHead } from '../../integrations/projectFiles.js';
import { uniqueName } from '../../daemon/uniqueName.js';
import type { KeyedMutex } from '../../shared/keyedMutex.js';
import type { Task } from '../../store/types.js';
import type { ServerDeps } from '../deps.js';

/** Outcome of a manual launch: the live session name, or a typed reason the controller maps to a
 *  status code (busy → 409, spawn-failed → 500). Keeps HTTP concerns out of the service. */
type LaunchOutcome =
  | { ok: true; session: string }
  | { ok: false; reason: 'busy' | 'spawn-failed'; message: string };

export interface SessionService {
  /** Manually (re)launch a worker for a task into its project checkout: claim the shared checkout
   *  atomically, baseline the per-task change snapshot, pin a manual-restart resume note and spawn,
   *  reverting the claim if the spawn fails. The caller has already gated exec/project access. */
  launchManual(task: Task, exec: string | undefined): Promise<LaunchOutcome>;
}

/** Manual session launch orchestration, extracted from the POST /sessions handler so the
 *  check-and-claim sequence (the atomic single-writer guard + snapshot baseline + spawn revert) can be
 *  reasoned about and tested without the HTTP surface. `pathFor` is shared with the route context so a
 *  re-homed project resolves identically here and at the scheduler's baseline read. */
export function createSessionService(d: ServerDeps, gitLock: KeyedMutex, pathFor: (projectId: number) => string): SessionService {
  async function launchManual(task: Task, exec: string | undefined): Promise<LaunchOutcome> {
    const spec = resolveExecutor(exec ? [`exec:${exec}`] : [], d.fallback);
    const projectId = task.project_id;
    const taskId = task.id;
    if (exec) d.tasks.setExec(taskId, exec); // remember which model ran it — drives the model icon
    // Single-writer: a manual launch targets the shared project checkout, so refuse it when another
    // agent (a scheduler task or a non-PR mission phase) is already live there — a second writer would
    // corrupt per-task change attribution. Read in_progress FRESH and flip status synchronously right
    // after, so the check-and-claim is atomic against the concurrent scheduler/engine ticks.
    const resolver = { projectPath: pathFor, worktreeFor: (mid: string) => d.missionGit?.worktreeFor(mid) };
    // A task that belongs to a PR-native mission runs in that mission's ISOLATED worktree, not the
    // shared project checkout. Resolve its real cwd the same way the scheduler/engine do (checkoutOf)
    // so a manual (re)launch lands in the SAME tree the autopilot used — using pathFor here would
    // silently run the agent in the main checkout and strand its edits outside the mission.
    const cwd = checkoutOf(resolver, task);
    if (checkoutBusy(resolver, d.tasks.list({ status: 'in_progress' }), cwd)) return { ok: false, reason: 'busy', message: 'checkout busy' };
    const agentName = uniqueName();
    d.tasks.setAgent(taskId, agentName);     // link task → orca-<agentName> session for run controls
    d.tasks.markStarted(taskId, d.clock.now()); // precise spawn time → correct usage attribution under concurrency
    d.tasks.setStatus(taskId, 'in_progress'); // claim synchronously after the fresh check above
    // Baseline for the per-task change snapshot, under the checkout lock so it lands after any in-flight commit.
    await gitLock.run(cwd, async () => d.tasks.markBase(taskId, await projectHead(cwd)));
    // When this is a resume (the task ran before), pin a note so the resumed agent knows it was
    // restarted on purpose and should continue rather than wonder why it's running again. Re-read the
    // description afterwards so the note rides along into the worker-resume prompt.
    const resume = parseResumeLabel(task.labels);
    // Only pin the generic manual-restart note when nothing more specific is already there — a
    // review-reject rationale or a stuck-relaunch reason carries actionable context the user is
    // restarting to address, so don't clobber it with boilerplate.
    if (resume && !d.tasks.get(taskId)?.resume_note) d.tasks.setResumeNote(taskId, 'Manually restarted — continue from where you left off and finish the task.');
    const resumeNote = d.tasks.get(taskId)?.resume_note ?? undefined;
    let session: string;
    try {
      ({ session } = await d.spawn.launch({ projectId, projectPath: cwd, taskId, agentName, spec, taskTitle: task.title, taskDescription: task.description, resumeNote, epicId: task.parent_id ?? undefined, resume, ownerId: resolveOwnerId(d, { taskId }) }));
    } catch (e) {
      // The task was already flipped to in_progress above; a spawn failure (bad cwd, missing tmux,
      // name collision) would otherwise leave it stuck with no live session until the stuck detector
      // reverts it 120s later. Revert immediately so the mission/scheduler can re-pick it.
      d.tasks.setStatus(taskId, 'open');
      d.bus.publish({ type: 'task', taskId, status: 'open' });
      return { ok: false, reason: 'spawn-failed', message: (e as Error).message };
    }
    d.bus.publish({ type: 'task', taskId, status: 'in_progress' });
    return { ok: true, session };
  }
  return { launchManual };
}
