import type { TaskStoreContract } from '../../../../src/store/taskStoreContract.js';
import type { CommitFileChange } from '../../../../src/integrations/projectFiles.js';
import type { PluginLogger } from '../../../../src/plugins/api.js';

/** The collaborators a snapshot needs, injected (the plugin compile unit cannot runtime-import the core
 *  git helpers or logger): the read-only git pair from `ctx.host.git()`, and the plugin's own logger. */
export interface SnapshotDeps {
  git: {
    projectHead(root: string): Promise<string>;
    projectRangeDiff(root: string, base: string, head: string): Promise<CommitFileChange[]>;
  };
  log: PluginLogger;
}

/** Freeze the per-task change list at close: the files THIS task committed, as `git diff base..HEAD`
 *  in the agent's checkout (`cwd`). `base` is the `base:<sha>` label stamped at spawn; HEAD is read now,
 *  so the snapshot only sees commits this task landed (in PR-native mode Elowen commits each phase before
 *  this runs). No baseline (a hand-closed task) or no commits → empty list, never the live working tree.
 *  Best-effort: a git failure logs and leaves the task without a snapshot rather than blocking the close. */
export async function snapshotTaskChanges(deps: SnapshotDeps, tasks: TaskStoreContract, taskId: string, cwd: string): Promise<void> {
  const t = tasks.get(taskId);
  if (!t) return;
  const base = t.labels.find((l) => l.startsWith('base:'))?.slice('base:'.length);
  if (!base) return; // closed without an agent baseline (manual close) — nothing to diff against
  const head = await deps.git.projectHead(cwd);
  if (!head) return; // non-repo / no commits
  try {
    const files = await deps.git.projectRangeDiff(cwd, base, head);
    tasks.saveChangedFiles(taskId, files, base, head);
  } catch (e) {
    deps.log.error(`task snapshot failed for ${taskId} — ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
}
