import { randomUUID } from 'node:crypto';
import { withRepoLease } from './db.mjs';

const createScript = `set -eu
path=$1; branch=$2; base=$3; repo=$4
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
if [ -e "$path/.git" ]; then
 test "$(g -C "$path" symbolic-ref --short HEAD)" = "$branch"
 test "$(g -C "$path" rev-parse --path-format=absolute --git-common-dir)" = "$repo/.git"
elif g -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
 test "$(g -C "$repo" rev-parse "refs/heads/$branch")" = "$base"
 g -C "$repo" worktree add "$path" "$branch"
else
 g -C "$repo" worktree add -b "$branch" "$path" "$base"
fi
`;
const removeScript = `set -eu
path=$1; branch=$2; base=$3; repo=$4
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
fail() { printf '%s\\n' "$1" >&2; exit 1; }
if [ -e "$path" ]; then
 test "$(g -C "$path" symbolic-ref --short HEAD)" = "$branch" || fail 'Worktree branch changed'
 test -z "$(g -C "$path" status --porcelain --ignored --untracked-files=all)" || fail 'Preserve worktree files before removing it'
 head=$(g -C "$path" rev-parse HEAD)
else
 if ! g -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then exit 0; fi
 head=$(g -C "$repo" rev-parse "refs/heads/$branch")
fi
test "$(g -C "$repo" rev-list --count "$base..$head")" = 0 || fail 'Preserve worktree commits before removing it'
test "$(g -C "$repo" rev-list --count "$head" --not --exclude="refs/heads/$branch" --all)" = 0 || fail 'Worktree branch retains otherwise unreachable commits'
if [ -e "$path" ]; then g -C "$repo" worktree remove "$path"; fi
g -C "$repo" update-ref -d "refs/heads/$branch" "$head"
`;

export async function manageWorktrees({ db, runGuest, row, userId, action, root }) {
  if (typeof root !== 'string' || !root.startsWith('/')) throw new Error('Managed worktrees require the project mount point');
  if (!action || !['list', 'create', 'remove'].includes(action.kind)) throw new Error('Invalid managed worktree action');
  const projectId = row.project_id;
  return await withRepoLease(db, `managed-worktrees:${projectId}`, async () => {
    if (action.kind === 'create') {
      if (typeof action.label !== 'string' || !action.label.trim() || action.label.length > 80 || typeof action.baseRef !== 'string' || !action.baseRef || action.baseRef.startsWith('-') || action.baseRef.length > 200) throw new Error('Invalid managed worktree input');
      let record = db.prepare("SELECT * FROM p_sandbox_managed_worktrees WHERE project_id=? AND created_by=? AND label=? AND base_ref=? AND state='creating'").get(projectId, userId, action.label, action.baseRef);
      if (!record) {
        const resolved = await runGuest(row, userId, ['/usr/bin/git', '-C', root, 'rev-parse', '--verify', '--end-of-options', `${action.baseRef}^{commit}`], { kind: 'worktrees' });
        const base = resolved.stdout.trim();
        if (resolved.code !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) throw new Error('Worktree base does not resolve to a commit');
        const id = `mw_${randomUUID()}`;
        const slug = action.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'work';
        db.prepare('INSERT INTO p_sandbox_managed_worktrees(id,project_id,created_by,label,path,branch,base_ref,base_commit) VALUES(?,?,?,?,?,?,?,?)')
          .run(id, projectId, userId, action.label, `/worktrees/${id}`, `elowen/${slug}-${id.slice(-8)}`, action.baseRef, base);
        record = db.prepare('SELECT * FROM p_sandbox_managed_worktrees WHERE id=?').get(id);
      }
      const result = await runGuest(row, userId, ['/bin/bash', '-s', '--', record.path, record.branch, record.base_commit, root], { kind: 'worktrees', input: createScript });
      if (result.code !== 0) throw new Error(result.stderr || 'Guest worktree creation failed; its recovery record was retained');
      db.prepare("UPDATE p_sandbox_managed_worktrees SET state='active' WHERE id=?").run(record.id);
    } else if (action.kind === 'remove') {
      const record = db.prepare('SELECT * FROM p_sandbox_managed_worktrees WHERE id=? AND project_id=?').get(action.workspaceId, projectId);
      if (!record) throw new Error('Managed worktree not found');
      db.prepare("UPDATE p_sandbox_managed_worktrees SET state='removing' WHERE id=?").run(record.id);
      const result = await runGuest(row, userId, ['/bin/bash', '-s', '--', record.path, record.branch, record.base_commit, root], { kind: 'worktrees', input: removeScript });
      if (result.code !== 0) throw new Error(result.stderr || 'Guest worktree removal failed; its recovery record was retained');
      db.prepare('DELETE FROM p_sandbox_managed_worktrees WHERE id=? AND project_id=?').run(record.id, projectId);
    }
    return db.prepare('SELECT * FROM p_sandbox_managed_worktrees WHERE project_id=? ORDER BY id').all(projectId).map((item) => ({
      id: item.id, projectId, createdBy: item.created_by, path: item.path, branch: item.branch, baseRef: item.base_ref, label: item.label, state: item.state,
    }));
  });
}
