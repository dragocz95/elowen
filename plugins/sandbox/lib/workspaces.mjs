import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { activeExecutionLeases, waitForExecutionLeases, withRepoLease } from './db.mjs';
import { assertRelativePath, runPrepared, userWorkspacesRoot } from './execution.mjs';

const GIT_BASE_ARGS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'diff.external=',
];

const coded = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

function rowWorkspace(row) {
  return {
    id: String(row.id),
    userId: Number(row.user_id),
    projectId: Number(row.project_id),
    label: String(row.label),
    path: String(row.path),
    branch: String(row.branch),
    baseRef: String(row.base_ref),
    lifecycle: row.lifecycle === 'orphaned' ? 'orphaned' : 'active',
    orphanReason: row.orphan_reason == null ? null : String(row.orphan_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: String(row.last_used_at),
  };
}

function slug(value) {
  // NFKD splits `ř` into `r` + a combining mark; the mark must be DROPPED, not turned into a dash,
  // or a Czech label reads `pojmenova-ni` instead of `pojmenovani`.
  const clean = String(value).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  return clean || 'workspace';
}

function accessibleProjectIds(ctx, explicit) {
  if (explicit) return explicit;
  const access = ctx.currentAccess();
  return access.admin ? ctx.host.stores().projects.list().map((project) => project.id) : access.projectIds;
}

function assertProjectAccess(ctx, projectId, explicit) {
  const project = ctx.host.stores().projects.get(projectId);
  if (!project) throw coded('project not found', 'project_not_found', 404);
  if (!accessibleProjectIds(ctx, explicit).includes(projectId)) throw coded('project is not accessible to this account', 'project_forbidden', 403);
  return project;
}

export function createWorkspaceService({ ctx, db, dataDir, execution }) {
  const listWorkspaces = (filters = {}) => {
    const clauses = [];
    const params = [];
    if (filters.userId !== undefined) { clauses.push('user_id = ?'); params.push(filters.userId); }
    if (filters.projectId !== undefined) { clauses.push('project_id = ?'); params.push(filters.projectId); }
    if (filters.lifecycle !== undefined) { clauses.push('lifecycle = ?'); params.push(filters.lifecycle); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM p_sandbox_workspaces${where} ORDER BY last_used_at DESC, created_at DESC`).all(...params).map(rowWorkspace);
  };

  const workspaceById = (id) => {
    const row = db.prepare('SELECT * FROM p_sandbox_workspaces WHERE id = ?').get(id);
    return row ? rowWorkspace(row) : null;
  };

  const currentAccount = () => ctx.currentContributionUserId() ?? ctx.currentIdentity()?.elowenUserId ?? null;
  const requireAccount = (override) => {
    const userId = override ?? currentAccount();
    if (!Number.isSafeInteger(userId) || userId <= 0) throw coded('a linked Elowen account is required', 'account_required', 401);
    return userId;
  };

  const safeGit = async (cwd, args, roots, options = {}) => {
    const prepared = await execution.prepare({
      command: { type: 'argv', file: 'git', args: [...GIT_BASE_ARGS, ...args] },
      cwd,
      leaseKind: options.leaseKind ?? 'github',
    }, { roots, accountUserId: options.accountUserId, owner: options.owner, skipHomeLock: options.skipHomeLock });
    Object.assign(prepared.launch.env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(prepared.home, '.gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
    });
    return runPrepared(prepared, { allowFailure: options.allowFailure, outputCap: options.outputCap });
  };

  const gitText = async (cwd, args, roots, options) => (await safeGit(cwd, args, roots, options)).output.trim();

  const commonDir = async (root, roots, options) => {
    const raw = await gitText(root, ['-C', root, 'rev-parse', '--git-common-dir'], roots, options);
    const absolute = resolve(root, raw);
    return realpathSync(absolute);
  };

  const activeWorkspace = ({ accountUserId, sessionId, projectId }) => {
    const row = db.prepare(`SELECT w.* FROM p_sandbox_session_bindings b
      JOIN p_sandbox_workspaces w ON w.id = b.workspace_id
      WHERE b.session_id = ? AND b.user_id = ? AND b.project_id = ? AND w.lifecycle = 'active'`)
      .get(sessionId, accountUserId, projectId);
    return row ? rowWorkspace(row) : null;
  };

  // The same question asked WITHOUT a project: which workspace is this conversation currently working in,
  // anywhere the account may reach? A chooser offers every accessible project, so the binding a switch
  // writes may name a project the caller's cwd says nothing about. The most recently bound project wins,
  // which is exactly what the last switch chose. Bindings are written only by useWorkspace, so the
  // ordering column is the switch time itself.
  const activeSessionWorkspace = ({ accountUserId, sessionId, projectIds }) => {
    const session = String(sessionId ?? '').trim();
    if (!Number.isSafeInteger(accountUserId) || !session || !Array.isArray(projectIds)) return null;
    const ids = [...new Set(projectIds.map(Number))].filter((id) => Number.isSafeInteger(id));
    if (ids.length === 0) return null;
    const row = db.prepare(`SELECT w.* FROM p_sandbox_session_bindings b
      JOIN p_sandbox_workspaces w ON w.id = b.workspace_id
      WHERE b.session_id = ? AND b.user_id = ? AND w.lifecycle = 'active'
        AND b.project_id IN (${ids.map(() => '?').join(',')})
      ORDER BY b.updated_at DESC, b.rowid DESC LIMIT 1`)
      .get(session, accountUserId, ...ids);
    return row ? rowWorkspace(row) : null;
  };

  const resolveWorkspace = ({ accountUserId, workspace, accessibleProjectIds }) => {
    const userId = requireAccount(accountUserId);
    const row = workspaceById(String(workspace?.workspaceId ?? ''));
    if (!row || row.userId !== userId) throw coded('workspace not found', 'workspace_not_found', 404);
    if (row.projectId !== Number(workspace?.projectId)) throw coded('workspace project mismatch', 'project_mismatch', 409);
    if (row.lifecycle !== 'active') throw coded('workspace is not active', 'workspace_orphaned', 409);
    const project = ctx.host.stores().projects.get(row.projectId);
    if (!project) throw coded('project not found', 'project_not_found', 404);
    const allowed = accessibleProjectIds === 'all' ? null : new Set((accessibleProjectIds ?? []).map(Number));
    if (allowed && !allowed.has(row.projectId)) throw coded('workspace project is outside the delegated scope', 'project_forbidden', 403);
    const root = userWorkspacesRoot(dataDir, userId);
    // The directory is named after the label (older rows: after the id), so the stored path is the
    // identity — what must hold is that it sits DIRECTLY under this account's workspace root.
    const expected = resolve(row.path);
    if (dirname(expected) !== resolve(root)) throw coded('workspace path no longer matches its Sandbox identity', 'workspace_path_mismatch', 409);
    let actual;
    let canonicalRoot;
    try {
      if (lstatSync(expected).isSymbolicLink()) throw new Error('workspace root is a symlink');
      actual = realpathSync(expected);
      canonicalRoot = realpathSync(root);
    } catch {
      throw coded('workspace path is missing or unsafe', 'workspace_path_missing', 409);
    }
    if (dirname(actual) !== canonicalRoot || !actual.startsWith(`${canonicalRoot}${sep}`)) {
      throw coded('workspace path no longer matches its Sandbox identity', 'workspace_path_mismatch', 409);
    }
    return { workspaceId: row.id, projectId: row.projectId, accountUserId: userId, path: actual };
  };

  const workspaceRoots = ({ accountUserId, projectIds }) => {
    if (!Number.isSafeInteger(accountUserId) || !Array.isArray(projectIds) || projectIds.length === 0) return [];
    const allowed = new Set(projectIds.map(Number));
    return listWorkspaces({ userId: accountUserId, lifecycle: 'active' })
      .filter((workspace) => allowed.has(workspace.projectId) && existsSync(workspace.path))
      .map((workspace) => ({ workspaceId: workspace.id, projectId: workspace.projectId, path: workspace.path }));
  };

  // The same lookup for a caller that NAMES the account instead of standing inside its scope. Background
  // services run with no identity at all, so the ambient form above cannot answer for them. Returns the
  // full workspace shape because a consumer mirroring a worktree needs its label to name the destination,
  // not just the path. `projectIds` omitted means every project the account owns a workspace in.
  const workspacesFor = ({ userId, projectIds }) => {
    if (!Number.isSafeInteger(userId)) return [];
    const allowed = Array.isArray(projectIds) ? new Set(projectIds.map(Number)) : null;
    return listWorkspaces({ userId, lifecycle: 'active' })
      .filter((workspace) => (allowed === null || allowed.has(workspace.projectId)) && existsSync(workspace.path))
      .map((workspace) => ({
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        path: workspace.path,
        label: workspace.label,
        branch: workspace.branch,
        baseRef: workspace.baseRef,
      }));
  };

  const statusFor = async (workspace, options = {}) => {
    if (!existsSync(workspace.path)) return { isRepo: false, status: null, files: [], diff: '', uniqueCommits: 0 };
    const snapshot = await ctx.host.git().projectSnapshot(workspace.path);
    if (!snapshot.isRepo) return { isRepo: false, status: null, files: [], diff: '', uniqueCommits: 0 };
    const roots = [workspace.path];
    const raw = await gitText(workspace.path, ['-C', workspace.path, 'status', '--porcelain=v1', '-z'], roots, { ...options, allowFailure: true });
    const tokens = raw ? raw.split('\0').filter(Boolean) : [];
    const files = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      const code = token.slice(0, 2);
      const path = token.slice(3);
      files.push({ path, code, untracked: code === '??' });
      if (code[0] === 'R' || code[0] === 'C') i += 1;
    }
    const diff = await gitText(workspace.path, ['-C', workspace.path, 'diff', '--no-ext-diff', 'HEAD', '--'], roots, { ...options, allowFailure: true, outputCap: 1_500_000 });
    const uniqueRaw = await gitText(workspace.path, ['-C', workspace.path, 'rev-list', '--count', `${workspace.baseRef}..HEAD`], roots, { ...options, allowFailure: true });
    const uniqueCommits = /^\d+$/.test(uniqueRaw) ? Number(uniqueRaw) : 0;
    return { isRepo: true, status: snapshot.status, remotes: snapshot.remotes, files, diff, uniqueCommits };
  };

  const createWorkspace = async (input, options = {}) => {
    const userId = requireAccount(options.userId);
    const projectId = Number(input.projectId);
    const project = assertProjectAccess(ctx, projectId, options.accessibleProjects);
    // The binding written at the end of this call names a CALLER-SUPPLIED conversation, so ownership is
    // verified HERE — before a worktree exists on disk and before any row is written. A refused
    // cross-account create must leave no side effect behind to clean up.
    const sessionId = String(input.sessionId ?? '').trim();
    if (sessionId && options.verifySessionOwner) options.verifySessionOwner(sessionId, userId);
    const label = String(input.label ?? '').trim();
    if (!label || label.length > 80) throw coded('workspace label must be 1-80 characters', 'invalid_label');
    const baseRef = String(input.baseRef ?? '').trim();
    if (!baseRef || baseRef.length > 200 || baseRef.startsWith('-')) throw coded('a valid base ref is required', 'invalid_base_ref');
    const snapshot = await ctx.host.git().projectSnapshot(project.path);
    if (!snapshot.isRepo) throw coded('the selected Project is not a Git repository', 'not_git_repo');

    const workspaceRoot = userWorkspacesRoot(dataDir, userId);
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    const roots = [project.path, workspaceRoot];
    await safeGit(project.path, ['-C', project.path, 'rev-parse', '--verify', `${baseRef}^{commit}`], roots, { accountUserId: userId });
    const common = await commonDir(project.path, roots, { accountUserId: userId });

    return withRepoLease(db, common, async () => {
      // The directory and the branch carry the LABEL, not the id: `ws_<uuid>` in a path or a `git
      // worktree list` says nothing about what is being worked on, and the caller already named it. The
      // id stays the opaque database key. A name that is taken — by a live workspace, a leftover
      // directory or a branch that outlived its worktree — gets a numeric suffix rather than a random one.
      const name = slug(label);
      let id;
      let branch;
      let path;
      for (let attempt = 0; attempt < 20 && !path; attempt += 1) {
        const candidate = attempt === 0 ? name : `${name}-${attempt + 1}`;
        const candidateBranch = `elowen/u${userId}/${candidate}`;
        const candidatePath = resolve(workspaceRoot, candidate);
        const exists = db.prepare('SELECT 1 FROM p_sandbox_workspaces WHERE user_id = ? AND project_id = ? AND branch = ?').get(userId, projectId, candidateBranch);
        if (exists || existsSync(candidatePath)) continue;
        const taken = await gitText(project.path, ['-C', project.path, 'branch', '--list', candidateBranch], roots, { accountUserId: userId });
        if (taken) continue;
        id = `ws_${randomUUID()}`;
        branch = candidateBranch;
        path = candidatePath;
      }
      if (!id || !branch || !path) throw coded('could not allocate a unique workspace', 'workspace_collision', 409);
      await safeGit(project.path, ['-C', project.path, 'worktree', 'add', '-b', branch, path, baseRef], roots, { accountUserId: userId });
      try {
        db.prepare(`INSERT INTO p_sandbox_workspaces
          (id, user_id, project_id, label, path, branch, base_ref) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, userId, projectId, label, path, branch, baseRef);
        if (sessionId) useWorkspace({ workspaceId: id, sessionId, projectId }, options);
      } catch (error) {
        await safeGit(project.path, ['-C', project.path, 'worktree', 'remove', '--force', path], roots, { accountUserId: userId, allowFailure: true });
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      return workspaceById(id);
    });
  };

  const useWorkspace = (input, options = {}) => {
    const userId = requireAccount(options.userId);
    const sessionId = String(input.sessionId ?? '').trim();
    if (!sessionId) throw coded('a conversation is required', 'session_required');
    const workspace = workspaceById(String(input.workspaceId));
    if (!workspace || workspace.userId !== userId) throw coded('workspace not found', 'workspace_not_found', 404);
    if (workspace.lifecycle !== 'active') throw coded('orphaned workspaces cannot be activated', 'workspace_orphaned', 409);
    assertProjectAccess(ctx, workspace.projectId, options.accessibleProjects);
    if (Number(input.projectId ?? workspace.projectId) !== workspace.projectId) throw coded('workspace project mismatch', 'project_mismatch', 409);
    if (options.verifySessionOwner) options.verifySessionOwner(sessionId, userId);
    // This column ORDERS one conversation's bindings against each other — it is how "the workspace this
    // conversation last switched to" is answered across projects — so it must be strictly increasing per
    // write, not merely current. CURRENT_TIMESTAMP resolves to whole seconds and even milliseconds tie for
    // two switches in the same tick, which would let an OLDER binding win. Each write therefore takes the
    // later of now and one millisecond past this conversation's newest binding. The format stays
    // lexicographically comparable with the whole-second values older rows carry.
    db.prepare(`INSERT INTO p_sandbox_session_bindings (session_id, user_id, project_id, workspace_id, updated_at)
      VALUES (?, ?, ?, ?, max(
        strftime('%Y-%m-%d %H:%M:%f', 'now'),
        COALESCE((SELECT strftime('%Y-%m-%d %H:%M:%f', max(updated_at), '+0.001 seconds')
          FROM p_sandbox_session_bindings WHERE session_id = ? AND user_id = ?), '0')))
      ON CONFLICT(session_id, user_id, project_id) DO UPDATE SET
        workspace_id = excluded.workspace_id, updated_at = excluded.updated_at`)
      .run(sessionId, userId, workspace.projectId, workspace.id, sessionId, userId);
    db.prepare("UPDATE p_sandbox_workspaces SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workspace.id);
    return workspace;
  };

  // Give a conversation its Project directory back. This is the only way a binding is undone without
  // destroying something: `useWorkspace` is the sole writer of these rows, and until now the sole way to
  // clear one was to delete the workspace, orphan its Project or delete the account. Every workspace
  // resource is PRESERVED — no workspace row, no branch, no directory is touched, so the worktree can be
  // switched back into at any time and only the binding rows go.
  //
  // `keepProjectId` releases every binding EXCEPT that Project's. That is what an explicit move into a
  // Project means: the latest explicit intent wins, while a workspace belonging to the Project being
  // entered keeps working. It is one narrow option rather than a second function because the guards,
  // the transaction and the refusal are identical either way.
  const releaseSessionWorkspaces = (input, options = {}) => {
    const userId = requireAccount(options.userId);
    const sessionId = String(input.sessionId ?? '').trim();
    if (!sessionId) throw coded('a conversation is required', 'session_required');
    if (options.verifySessionOwner) options.verifySessionOwner(sessionId, userId);
    const keep = input.keepProjectId === undefined || input.keepProjectId === null ? null : Number(input.keepProjectId);
    if (keep !== null && !Number.isSafeInteger(keep)) throw coded('a valid Project id is required', 'invalid_project');
    // A Project this account can no longer reach keeps its binding untouched: a caller who has lost the
    // grant has no business editing rows for it, exactly as it may not read or switch them.
    const scope = accessibleProjectIds(ctx, options.accessibleProjects)
      .map(Number).filter((projectId) => Number.isSafeInteger(projectId) && projectId !== keep);
    if (scope.length === 0) return { released: 0, workspaceIds: [] };
    const placeholders = scope.map(() => '?').join(',');
    return db.transaction(() => {
      const rows = db.prepare(`SELECT project_id, workspace_id FROM p_sandbox_session_bindings
        WHERE session_id = ? AND user_id = ? AND project_id IN (${placeholders})`).all(sessionId, userId, ...scope);
      if (rows.length === 0) return { released: 0, workspaceIds: [] };
      // The busy-turn rejection, and the same hazard removal refuses for: a lease means a process is live
      // in that worktree right now, and moving the conversation out from under it would leave the running
      // command writing into a directory the conversation has already left.
      for (const row of rows) {
        if (activeExecutionLeases(db, { workspaceId: String(row.workspace_id) }).length > 0) {
          throw coded('workspace is in use by an active process', 'workspace_in_use', 409);
        }
      }
      db.prepare(`DELETE FROM p_sandbox_session_bindings
        WHERE session_id = ? AND user_id = ? AND project_id IN (${placeholders})`).run(sessionId, userId, ...scope);
      return { released: rows.length, workspaceIds: rows.map((row) => String(row.workspace_id)) };
    });
  };

  const commitWorkspace = async (input, options = {}) => {
    const userId = requireAccount(options.userId);
    const workspace = workspaceById(String(input.workspaceId));
    if (!workspace || workspace.userId !== userId) throw coded('workspace not found', 'workspace_not_found', 404);
    if (workspace.lifecycle !== 'active') throw coded('orphaned workspaces cannot be committed', 'workspace_orphaned', 409);
    assertProjectAccess(ctx, workspace.projectId, options.accessibleProjects);
    const paths = [...new Set((Array.isArray(input.paths) ? input.paths : []).map(assertRelativePath))];
    if (paths.length === 0) throw coded('commit requires at least one explicit path', 'paths_required');
    for (const path of paths) ctx.host.projectFiles().safe(workspace.path, path, true);
    const message = String(input.message ?? '').trim();
    if (!message || message.length > 500) throw coded('commit message must be 1-500 characters', 'invalid_commit_message');
    const project = ctx.host.stores().projects.get(workspace.projectId);
    if (!project) throw coded('project not found', 'project_not_found', 404);
    const common = await commonDir(workspace.path, [workspace.path], { accountUserId: userId });
    return withRepoLease(db, common, async () => {
      await safeGit(workspace.path, ['-C', workspace.path, 'add', '--', ...paths], [workspace.path], { accountUserId: userId });
      const staged = await safeGit(workspace.path, ['-C', workspace.path, 'diff', '--cached', '--quiet', '--'], [workspace.path], { accountUserId: userId, allowFailure: true });
      if (staged.code === 0) throw coded('the selected paths contain no changes to commit', 'nothing_to_commit', 409);
      if (staged.code !== 1) throw coded(staged.output.trim() || 'could not inspect staged changes', 'git_status_failed', 500);
      await safeGit(workspace.path, ['-C', workspace.path, 'commit', '-m', message, '--', ...paths], [workspace.path], { accountUserId: userId });
      const head = await gitText(workspace.path, ['-C', workspace.path, 'rev-parse', 'HEAD'], [workspace.path], { accountUserId: userId });
      const remaining = await statusFor(workspace, { accountUserId: userId });
      db.prepare("UPDATE p_sandbox_workspaces SET updated_at = CURRENT_TIMESTAMP, last_used_at = CURRENT_TIMESTAMP WHERE id = ?").run(workspace.id);
      return { workspace, head, remaining };
    });
  };

  const removalPreview = async (workspace) => {
    const state = await statusFor(workspace, { accountUserId: workspace.userId });
    const active = activeExecutionLeases(db, { workspaceId: workspace.id });
    const payload = {
      workspaceId: workspace.id,
      head: state.status?.head ?? '',
      dirty: state.status?.dirty ?? 0,
      untracked: state.status?.untracked ?? 0,
      uniqueCommits: state.uniqueCommits,
      activeProcesses: active.length,
      files: state.files.map((file) => `${file.code}:${file.path}`),
    };
    const previewHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return { ...payload, previewHash, phrase: `discard ${workspace.label}` };
  };

  const removeWorkspace = async (input, options = {}) => {
    const userId = requireAccount(options.userId);
    const workspace = workspaceById(String(input.workspaceId));
    if (!workspace || workspace.userId !== userId) throw coded('workspace not found', 'workspace_not_found', 404);
    const project = ctx.host.stores().projects.get(workspace.projectId);
    if (!project) throw coded('the source Project no longer exists; the orphaned workspace is preserved on disk', 'workspace_orphaned', 409);
    const roots = [project.path, workspace.path, dirname(workspace.path)];
    const common = await commonDir(project.path, roots, { accountUserId: userId });
    return withRepoLease(db, common, async () => {
      const preview = await removalPreview(workspace, options);
      const destructive = options.allowDiscard === true;
      if (preview.activeProcesses > 0) throw coded('workspace is in use by an active process', 'workspace_in_use', 409);
      if (!destructive && (preview.dirty > 0 || preview.untracked > 0 || preview.uniqueCommits > 0)) {
        throw coded('workspace removal requires a clean tree with no unpushed commits', 'workspace_not_clean', 409);
      }
      if (destructive) {
        if (input.previewHash !== preview.previewHash) throw coded('workspace changed since the removal preview', 'workspace_changed', 409);
        if (String(input.phrase ?? '') !== preview.phrase) throw coded('the typed confirmation phrase does not match', 'confirmation_mismatch', 400);
      }
      await safeGit(project.path, ['-C', project.path, 'worktree', 'remove', ...(destructive ? ['--force'] : []), workspace.path], roots, { accountUserId: userId });
      await safeGit(project.path, ['-C', project.path, 'branch', '-D', workspace.branch], [project.path], { accountUserId: userId, allowFailure: true });
      db.transaction(() => {
        db.prepare('DELETE FROM p_sandbox_session_bindings WHERE workspace_id = ?').run(workspace.id);
        db.prepare('DELETE FROM p_sandbox_workspaces WHERE id = ?').run(workspace.id);
      });
      rmSync(workspace.path, { recursive: true, force: true });
      return { removed: workspace.id };
    });
  };

  const markProjectOrphaned = (projectId, reason = 'project_removed') => {
    db.prepare(`UPDATE p_sandbox_workspaces SET lifecycle = 'orphaned', orphan_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ?`).run(reason, projectId);
    db.prepare('DELETE FROM p_sandbox_session_bindings WHERE project_id = ?').run(projectId);
  };

  const reconcile = async () => {
    const users = new Set(ctx.host.stores().usersRead.list().map((user) => user.id));
    const projects = new Set(ctx.host.stores().projects.list().map((project) => project.id));
    for (const workspace of listWorkspaces()) {
      if (!users.has(workspace.userId)) continue;
      if (!projects.has(workspace.projectId)) { markProjectOrphaned(workspace.projectId); continue; }
      if (!existsSync(workspace.path)) {
        db.prepare(`UPDATE p_sandbox_workspaces SET lifecycle = 'orphaned', orphan_reason = 'path_missing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(workspace.id);
        db.prepare('DELETE FROM p_sandbox_session_bindings WHERE workspace_id = ?').run(workspace.id);
      }
    }
    db.prepare('DELETE FROM p_sandbox_session_bindings WHERE workspace_id NOT IN (SELECT id FROM p_sandbox_workspaces)').run();
    return { users, projects };
  };

  const removeAccount = async (userId) => withRepoLease(db, `home:${userId}`, async () => {
    const owned = listWorkspaces({ userId });
    const active = await waitForExecutionLeases(db, { accountUserId: userId }, 5_000);
    if (active.length > 0) throw coded('account sandbox data is in use by an active process', 'account_in_use', 409);
    for (const workspace of owned) {
      const project = ctx.host.stores().projects.get(workspace.projectId);
      if (!project) continue;
      const roots = [project.path, workspace.path, dirname(workspace.path)];
      try {
        const common = await commonDir(project.path, roots, { accountUserId: userId, owner: true, skipHomeLock: true });
        await withRepoLease(db, common, () => safeGit(project.path, ['-C', project.path, 'worktree', 'remove', '--force', workspace.path], roots, { accountUserId: userId, owner: true, skipHomeLock: true, allowFailure: true }));
      } catch { /* filesystem cleanup below remains authoritative for a deleted account */ }
    }
    db.transaction(() => {
      db.prepare('DELETE FROM p_sandbox_session_bindings WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM p_sandbox_workspaces WHERE user_id = ?').run(userId);
    });
  });

  const sessionListForUser = (userId) => db.prepare(`SELECT id, title, updated_at FROM brain_sessions
    WHERE user_id = ? AND parent_session_id IS NULL ORDER BY updated_at DESC LIMIT 50`).all(userId)
    .map((row) => ({ id: String(row.id), title: String(row.title || 'Untitled conversation'), updatedAt: String(row.updated_at) }));

  const verifySessionOwner = (sessionId, userId) => {
    const row = db.prepare('SELECT user_id FROM brain_sessions WHERE id = ?').get(sessionId);
    if (!row || Number(row.user_id) !== userId) throw coded('conversation not found for this account', 'session_forbidden', 403);
  };

  return {
    listWorkspaces, workspaceById, resolveWorkspace, workspaceRoots, workspacesFor, activeWorkspace,
    activeSessionWorkspace, statusFor,
    createWorkspace, useWorkspace, releaseSessionWorkspaces, commitWorkspace, removalPreview, removeWorkspace,
    markProjectOrphaned, reconcile, removeAccount, sessionListForUser, verifySessionOwner,
  };
}
