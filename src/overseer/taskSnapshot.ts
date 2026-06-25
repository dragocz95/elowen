import type { TaskStore } from '../store/taskStore.js';
import { projectHead, projectRangeDiff } from '../integrations/projectFiles.js';
import { logger } from '../shared/logger.js';

const log = logger('snapshot');

/** Freeze the per-task change list at close: the files THIS task committed, as `git diff base..HEAD`
 *  in the agent's checkout (`cwd`). `base` is the `base:<sha>` label stamped at spawn; HEAD is read now,
 *  so the snapshot only sees commits this task landed (in PR-native mode Orca commits each phase before
 *  this runs). No baseline (a hand-closed task) or no commits → empty list, never the live working tree.
 *  Best-effort: a git failure logs and leaves the task without a snapshot rather than blocking the close. */
export async function snapshotTaskChanges(tasks: TaskStore, taskId: string, cwd: string): Promise<void> {
  const t = tasks.get(taskId);
  if (!t) return;
  const base = t.labels.find((l) => l.startsWith('base:'))?.slice('base:'.length);
  if (!base) return; // closed without an agent baseline (manual close) — nothing to diff against
  const head = await projectHead(cwd);
  if (!head) return; // non-repo / no commits
  try {
    const files = await projectRangeDiff(cwd, base, head);
    tasks.saveChangedFiles(taskId, files, base, head);
  } catch (e) {
    log.error(`task snapshot failed for ${taskId}`, e);
  }
}
