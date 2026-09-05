import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { openDb } from '../../src/store/db.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { RealGitReader } from '../../src/git/gitReader.js';
import { realPathWithin } from '../../src/plugins/pathGuard.js';
import { runWithContributionUser, runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import { resolvePolicy, type Policy } from '../../src/plugins/policy.js';
import { effectiveTurnWorkDir, releaseWorkspacesForMove } from '../../src/brain/service/workDir.js';
import { processRegistry } from '../../src/brain/processRegistry.js';
import { bubblewrapProbe, ensureUserHome, migrateLegacyHomes, resetUserHome, runPrepared } from '../../plugins/sandbox/lib/execution.mjs';
import { activeExecutionLeases, createExecutionLease, heartbeatRepoLease, processIdentity, reconcileStaleLeases, withRepoLease } from '../../plugins/sandbox/lib/db.mjs';
import { createWorkspacePathView } from '../../src/plugins/pathView.js';
import { commandsWithPlugins } from '../../src/brain/slashCommands.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = { info() {}, warn() {}, error() {} };
const nonOperator = (userId: number): TurnIdentity => ({ platform: 'elowen', userId: String(userId), elowenUserId: userId, admin: false, owner: false, conversation: 'own' });
const operator = (userId: number): TurnIdentity => ({ platform: 'elowen', userId: String(userId), elowenUserId: userId, admin: true, owner: true, conversation: 'own' });
const policy = (projectPath: string): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => [projectPath] });
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

let roots: string[] = [];
const temp = (tag: string) => { const path = mkdtempSync(join(tmpdir(), `elowen-sandbox-${tag}-`)); roots.push(path); return path; };
afterEach(() => { for (const proc of processRegistry.list()) processRegistry.kill(proc.id); });
afterAll(() => { for (const path of roots) rmSync(path, { recursive: true, force: true }); roots = []; });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function createRepository(branch = 'main'): string {
  const root = temp('repo');
  git(root, 'init', '-b', branch);
  git(root, 'config', 'user.name', 'Sandbox Test');
  git(root, 'config', 'user.email', 'sandbox@example.test');
  writeFileSync(join(root, 'README.txt'), 'base\n');
  git(root, 'add', 'README.txt');
  git(root, 'commit', '-m', 'initial');
  return root;
}

/** `extraBranches` adds one further registered Project per entry, each a real repository created on that
 *  branch name — what a second accessible Project and a repository whose trunk is not `main` both need. */
async function setup(enabled = ['sandbox'], confineNonOperators = false, extraBranches: string[] = []) {
  const paths = [createRepository(), ...extraBranches.map((branch) => createRepository(branch))];
  const dataRoot = temp('data');
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (1, 'amy', 'x', 0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (2, 'bob', 'x', 0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (3, 'admin', 'x', 1)").run();
  const projects = paths.map((path, index) => ({ id: index + 1, slug: `demo-${index + 1}`, path, notes: '', icon: '' }));
  for (const entry of projects) db.prepare('INSERT INTO projects (id, slug, path, notes) VALUES (?, ?, ?, ?)').run(entry.id, entry.slug, entry.path, '');
  const userProjects = new UserProjectStore(db);
  for (const project of projects) {
    for (const userId of [1, 2]) userProjects.assign(userId, project.id);
  }
  const projectPath = paths[0]!;
  const users = new Set([1, 2, 3]);
  const reader = new RealGitReader();
  const host = {
    stores: {
      userProjects,
      projects: { get: (id: number) => projects.find((entry) => entry.id === id) ?? null, list: () => projects },
      homeProject: () => projects[0]!,
      usersRead: {
        list: () => [...users].map((id) => ({ id, username: id === 1 ? 'amy' : id === 2 ? 'bob' : 'admin', isAdmin: id === 3 })),
        isAdmin: (id: number) => id === 3,
        allowedExecs: () => [],
        mayUsePlugin: () => true,
      },
    },
    git: {
      projectSnapshot: (root: string) => reader.snapshot(root),
      projectHead: async (root: string) => git(root, 'rev-parse', 'HEAD'),
      projectRangeDiff: async () => [],
      projectRangeLog: async () => [],
      projectRangeFileDiff: async () => '',
      projectCommitFileDiff: async () => '',
    },
    projectFiles: {
      safe(root: string, rel: string) {
        const path = resolve(root, rel);
        const safe = realPathWithin(path, [root]);
        if (!safe) throw new Error('path escapes workspace');
        return safe;
      },
    },
  };
  const registry = await loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled, logger: log,
    config: { sandbox: { confineNonOperators } }, dataRoot,
    pluginDb: (name) => makePluginDb(db, name, { canMigrate: true }),
    host,
    delegatedTurnsOutOfProcess: () => false,
  });
  return { registry, db, dataRoot, projectPath, projects, users, userProjects };
}

/** Stand-in for the GitHub plugin, which lives in the plugin registry rather than this repo. Installed
 *  straight into the merged registry because that is exactly what `ctx.control('github')` resolves
 *  against — Sandbox asks for it at launch time, so an owner that appears later is the normal case. */
const GITHUB_TOKEN = 'gho_sandbox_test_token_0123456789';
function connectGitHub(
  registry: Awaited<ReturnType<typeof loadPlugins>>,
  sessionCredential: (input: { accountUserId: number }) => { token: string; login: string } | null,
) {
  registry.controls.set('github', { sessionCredential } as never);
  registry.controlOwner.set('github', 'github');
}

function tool(registry: Awaited<ReturnType<typeof loadPlugins>>, name: string) {
  const found = registry.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found as unknown as { execute(id: string, input: Record<string, unknown>): Promise<{ content: { text: string }[]; details: Record<string, any> }> };
}

async function runAs(registry: Awaited<ReturnType<typeof loadPlugins>>, projectPath: string, userId: number, sessionId: string, name: string, input: Record<string, unknown>) {
  return runWithPolicy(policy(projectPath), () => tool(registry, name).execute('t', input), {
    identity: nonOperator(userId), contributionUserId: userId, sessionId, workDir: projectPath,
  });
}

function pluginRequest(
  method: string,
  query: Record<string, string>,
  value: unknown = {},
  auth: { userId: number; admin: boolean; tokenScope: 'user'; accessibleProjects: number[] | null }
    = { userId: 3, admin: true, tokenScope: 'user', accessibleProjects: null },
) {
  const raw = Buffer.from(JSON.stringify(value));
  return {
    method, path: '', query, headers: {}, params: {},
    body: async () => raw,
    json: async <T>() => value as T,
    auth,
  };
}

const waitUntil = async (check: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
};

describe('sandbox plugin workspaces', () => {
  /** The directory and branch are the caller's label, so `git worktree list` and a path in a task brief
   *  read as what is being worked on — never `ws_<uuid>`. A name already in use (a second workspace
   *  with the same label, or a branch that outlived its removed worktree) steps to `-2`, `-3`, … */
  it('names the worktree and branch after the label and steps past taken names', async () => {
    const { registry, projectPath } = await setup();
    execFileSync('git', ['-C', projectPath, 'branch', 'elowen/u1/same-name-2']);
    const accented = (await runAs(registry, projectPath, 1, 'brain-n0', 'SandboxCreateWorkspace', { projectId: 1, label: 'Přehled účtů', baseRef: 'main' })).details.workspace;
    expect(accented.branch).toBe('elowen/u1/prehled-uctu');
    const first = (await runAs(registry, projectPath, 1, 'brain-n1', 'SandboxCreateWorkspace', { projectId: 1, label: 'Same name', baseRef: 'main' })).details.workspace;
    const second = (await runAs(registry, projectPath, 1, 'brain-n2', 'SandboxCreateWorkspace', { projectId: 1, label: 'Same name', baseRef: 'main' })).details.workspace;
    expect(first.branch).toBe('elowen/u1/same-name');
    expect(first.path.endsWith('/same-name')).toBe(true);
    expect(second.branch).toBe('elowen/u1/same-name-3');
    expect(second.path.endsWith('/same-name-3')).toBe(true);
    expect(first.id).toMatch(/^ws_/);
    expect(existsSync(second.path)).toBe(true);
  });

  it('creates, binds and exposes a workspace root only for currently accessible Projects', async () => {
    const { registry, projectPath } = await setup();
    const created = await runAs(registry, projectPath, 1, 'brain-amy', 'SandboxCreateWorkspace', { projectId: 1, label: 'Feature Alpha', baseRef: 'main' });
    const workspace = created.details.workspace;
    expect(workspace.branch).toBe('elowen/u1/feature-alpha');
    expect(workspace.path.endsWith('/feature-alpha')).toBe(true);
    expect(existsSync(workspace.path)).toBe(true);
    const control = registry.control('sandbox')!;
    const asAccount = <T>(userId: number, run: () => T) => runWithPolicy(policy(projectPath), run, {
      identity: nonOperator(userId), contributionUserId: userId, sessionId: `brain-${userId}`, workDir: projectPath,
    });
    expect(asAccount(1, () => control.activeWorkspace({ sessionId: 'brain-amy', projectId: 1 }))?.path).toBe(workspace.path);
    expect(asAccount(1, () => control.workspaceRoots({ projectIds: [1] }))).toEqual([{ workspaceId: workspace.id, projectId: 1, path: workspace.path }]);
    expect(asAccount(1, () => control.workspaceRoots({ projectIds: [] }))).toEqual([]);
    expect(asAccount(2, () => control.workspaceRoots({ projectIds: [1] }))).toEqual([]);
    // The explicit-account form answers with NO ambient scope at all — deliberately called outside
    // `asAccount`, because that is the only condition a background service ever runs in. If this needed a
    // policy/identity scope it would be useless to the callers it exists for.
    expect(control.workspacesFor({ userId: 1 }).map((w) => w.path)).toEqual([workspace.path]);
    expect(control.workspacesFor({ userId: 1, projectIds: [1] })).toEqual([{
      workspaceId: workspace.id, projectId: 1, path: workspace.path,
      label: workspace.label, branch: workspace.branch, baseRef: workspace.baseRef,
    }]);
    expect(control.workspacesFor({ userId: 1, projectIds: [2] })).toEqual([]);
    expect(control.workspacesFor({ userId: 2 })).toEqual([]);
  });

  it('commits only explicit paths and leaves unrelated changes in place', async () => {
    const { registry, projectPath, dataRoot } = await setup();
    const created = await runAs(registry, projectPath, 1, 'brain-commit', 'SandboxCreateWorkspace', { projectId: 1, label: 'Commit', baseRef: 'main' });
    const workspace = created.details.workspace;
    git(projectPath, 'config', '--unset', 'user.name');
    git(projectPath, 'config', '--unset', 'user.email');
    writeFileSync(join(dataRoot, 'sandbox', 'users', '1', 'home', '.gitconfig'), '[user]\n\tname = Account Author\n\temail = account@example.test\n');
    writeFileSync(join(workspace.path, 'selected.txt'), 'selected\n');
    writeFileSync(join(workspace.path, 'left.txt'), 'left\n');
    const committed = await runAs(registry, workspace.path, 1, 'brain-commit', 'SandboxCommit', { projectId: 1, paths: ['selected.txt'], message: 'add selected' });
    expect(committed.content[0]!.text).toContain('Remaining:');
    expect(git(workspace.path, 'show', '--name-only', '--format=', 'HEAD')).toBe('selected.txt');
    expect(git(workspace.path, 'status', '--porcelain')).toContain('?? left.txt');
  });

  it('refuses model removal for dirty, untracked, unique-commit and active-process state', async () => {
    const { registry, projectPath } = await setup(['sandbox', 'terminal']);
    const created = await runAs(registry, projectPath, 1, 'brain-remove', 'SandboxCreateWorkspace', { projectId: 1, label: 'Removal', baseRef: 'main' });
    const workspace = created.details.workspace;
    writeFileSync(join(workspace.path, 'dirty.txt'), 'dirty\n');
    const dirty = await runAs(registry, workspace.path, 1, 'brain-remove', 'SandboxRemoveWorkspace', { workspaceId: workspace.id });
    expect(dirty.content[0]!.text).toMatch(/clean tree/);

    rmSync(join(workspace.path, 'dirty.txt'));
    const started = await runAs(registry, workspace.path, 1, 'brain-remove', 'Bash', { command: 'sleep 30', background: true });
    const processId = /process (\S+):/.exec(started.content[0]!.text)?.[1];
    expect(processId).toBeTruthy();
    const active = await runAs(registry, workspace.path, 1, 'brain-remove', 'SandboxRemoveWorkspace', { workspaceId: workspace.id });
    expect(active.content[0]!.text).toMatch(/active process/);
    await runAs(registry, workspace.path, 1, 'brain-remove', 'KillProcess', { id: processId! });
  });

  it('marks Project workspaces orphaned without deleting local files', async () => {
    const { registry, projectPath } = await setup();
    const created = await runAs(registry, projectPath, 1, 'brain-orphan', 'SandboxCreateWorkspace', { projectId: 1, label: 'Orphan', baseRef: 'main' });
    const workspace = created.details.workspace;
    const handler = registry.projectRemovedHandlers.find((entry) => entry.plugin === 'sandbox');
    expect(handler).toBeTruthy();
    await handler!.fn(1);
    expect(existsSync(workspace.path)).toBe(true);
    expect(runWithPolicy(policy(projectPath), () => registry.control('sandbox')!.activeWorkspace({ sessionId: 'brain-orphan', projectId: 1 }), {
      identity: nonOperator(1), contributionUserId: 1, sessionId: 'brain-orphan', workDir: projectPath,
    })).toBeNull();
  });

  it('boot reconciliation removes account data left while the plugin was disabled', async () => {
    const { registry, projectPath, dataRoot, users } = await setup();
    const created = await runAs(registry, projectPath, 1, 'brain-account-reconcile', 'SandboxCreateWorkspace', { projectId: 1, label: 'Account cleanup', baseRef: 'main' });
    const workspace = created.details.workspace;
    users.delete(1);
    const reconcile = registry.bootReconciles.find((entry) => entry.plugin === 'sandbox');
    expect(reconcile).toBeTruthy();
    await reconcile!.fn();
    expect(existsSync(workspace.path)).toBe(false);
    expect(existsSync(join(dataRoot, 'sandbox', 'users', '1'))).toBe(false);
  });

  it('removes a clean workspace and its generated branch', async () => {
    const { registry, projectPath } = await setup();
    const created = await runAs(registry, projectPath, 1, 'brain-clean', 'SandboxCreateWorkspace', { projectId: 1, label: 'Clean', baseRef: 'main' });
    const workspace = created.details.workspace;
    const removed = await runAs(registry, workspace.path, 1, 'brain-clean', 'SandboxRemoveWorkspace', { workspaceId: workspace.id });
    expect(removed.content[0]!.text).toContain('Removed workspace');
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(projectPath, 'branch', '--list', workspace.branch)).toBe('');
  });

  it('rejects a symlink path escape in an explicit commit path', async () => {
    const { registry, projectPath } = await setup();
    const outside = temp('outside');
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    const created = await runAs(registry, projectPath, 1, 'brain-link', 'SandboxCreateWorkspace', { projectId: 1, label: 'Link', baseRef: 'main' });
    const workspace = created.details.workspace;
    execFileSync('ln', ['-s', outside, join(workspace.path, 'escape')]);
    const result = await runAs(registry, workspace.path, 1, 'brain-link', 'SandboxCommit', { projectId: 1, paths: ['escape/secret.txt'], message: 'escape' });
    expect(result.content[0]!.text).toMatch(/escapes workspace/);
  });

  it('resolves workspace refs by account/project and holds removal with a delegation lease', async () => {
    const { registry, projectPath } = await setup();
    const created = await runAs(registry, projectPath, 1, 'brain-ref', 'SandboxCreateWorkspace', { projectId: 1, label: 'Ref', baseRef: 'main' });
    const workspace = created.details.workspace;
    const control = registry.control('sandbox')!;
    expect(control.resolveWorkspace({
      accountUserId: 1,
      workspace: { workspaceId: workspace.id, projectId: 1 },
      accessibleProjectIds: [1],
    })).toMatchObject({ accountUserId: 1, workspaceId: workspace.id, projectId: 1, path: workspace.path });
    expect(() => control.resolveWorkspace({
      accountUserId: 2,
      workspace: { workspaceId: workspace.id, projectId: 1 },
      accessibleProjectIds: [1],
    })).toThrow('workspace not found');
    expect(() => control.resolveWorkspace({
      accountUserId: 1,
      workspace: { workspaceId: workspace.id, projectId: 1 },
      accessibleProjectIds: [],
    })).toThrow('outside the delegated scope');

    const lease = control.acquireDelegationLease({ accountUserId: 1, workspace: { workspaceId: workspace.id, projectId: 1 } });
    const blocked = await runAs(registry, workspace.path, 1, 'brain-ref', 'SandboxRemoveWorkspace', { workspaceId: workspace.id });
    expect(blocked.content[0]!.text).toContain('active process');
    await lease.release();
  });

  it('rejects a workspace root replaced by a symlink', async () => {
    const { registry, projectPath } = await setup();
    const created = await runAs(registry, projectPath, 1, 'brain-ref-link', 'SandboxCreateWorkspace', { projectId: 1, label: 'Ref link', baseRef: 'main' });
    const workspace = created.details.workspace;
    const outside = mkdtempSync(join(tmpdir(), 'elowen-workspace-outside-'));
    roots.push(outside);
    rmSync(workspace.path, { recursive: true, force: true });
    symlinkSync(outside, workspace.path);
    expect(() => registry.control('sandbox')!.resolveWorkspace({
      accountUserId: 1,
      workspace: { workspaceId: workspace.id, projectId: 1 },
      accessibleProjectIds: [1],
    })).toThrow('missing or unsafe');
  });

  it('forces an admin workspace child into a short confined guest root and hides the worktree git pointer', async () => {
    const { registry, projectPath, dataRoot } = await setup(['sandbox', 'terminal', 'files'], false);
    const created = await runAs(registry, projectPath, 1, 'brain-confined', 'SandboxCreateWorkspace', { projectId: 1, label: 'Confined', baseRef: 'main' });
    const workspace = created.details.workspace;
    writeFileSync(join(dataRoot, 'sandbox', 'users', '1', 'home', 'shared-secret'), 'private');
    const pathView = createWorkspacePathView({ accountUserId: 1, workspaceId: workspace.id, projectId: 1, path: workspace.path });
    const result = await runWithPolicy(adminPolicy, () => tool(registry, 'Bash').execute('t', {
      command: 'pwd; printf scoped > scoped.txt; cat scoped.txt; cat .git; test ! -e /home/elowen/shared-secret; echo home-isolated; test ! -e /root/host-secret',
    }), {
      identity: operator(3), contributionUserId: 1, sessionId: 'brain-confined-child',
      workDir: workspace.path, pathView,
    });
    expect(result.content[0]!.text).toContain('/workspace');
    expect(result.content[0]!.text).toContain('scoped');
    expect(result.content[0]!.text).toContain('gitdir: /run/elowen-git-unavailable');
    expect(result.content[0]!.text).toContain('home-isolated');
    expect(result.content[0]!.text).not.toContain(workspace.path);
    expect(readFileSync(join(workspace.path, 'scoped.txt'), 'utf8')).toBe('scoped');
    const status = await runWithPolicy(adminPolicy, () => tool(registry, 'GitStatus').execute('g', { path: '.' }), {
      identity: operator(3), contributionUserId: 1, sessionId: 'brain-confined-child',
      workDir: workspace.path, pathView,
    });
    expect(status.content[0]!.text).toContain('root .');
    expect(status.content[0]!.text).toContain('scoped.txt');
    expect(JSON.stringify(status)).not.toContain(workspace.path);
  });

  it('persists a workspace cwd through the real PathView resolver', async () => {
    const { registry, projectPath } = await setup(['sandbox', 'terminal'], false);
    const created = await runAs(registry, projectPath, 1, 'brain-workspace-cwd', 'SandboxCreateWorkspace', {
      projectId: 1, label: 'Workspace cwd', baseRef: 'main',
    });
    const workspace = created.details.workspace;
    mkdirSync(join(workspace.path, 'nested'));
    const pathView = createWorkspacePathView({ accountUserId: 1, workspaceId: workspace.id, projectId: 1, path: workspace.path });
    const scope = {
      identity: operator(3), contributionUserId: 1, sessionId: 'brain-workspace-cwd',
      workDir: workspace.path, pathView,
    };

    const changed = await runWithPolicy(adminPolicy, () => tool(registry, 'Bash').execute('t', {
      command: 'cd nested',
    }), scope);
    expect(changed.content[0]!.text).toContain('[exit 0]');
    expect(changed.content[0]!.text).not.toContain('working directory was not persisted');
    const next = await runWithPolicy(adminPolicy, () => tool(registry, 'Bash').execute('t', {
      command: 'pwd',
    }), scope);
    expect(next.content[0]!.text).toContain('/workspace/nested');
    expect(next.content[0]!.text).not.toContain(workspace.path);
  });
});

describe('sandbox execution HOME and leases', () => {
  it('exposes target-user environment operations only through admin routes', async () => {
    const { registry, projectPath } = await setup();
    for (const [path, method] of [['environment', 'GET'], ['environment/author', 'POST'], ['environment/reset-preview', 'POST'], ['environment/reset', 'POST']] as const) {
      expect(registry.apiRoute('sandbox', path, method)?.access).toBe('admin');
    }
    const route = registry.apiRoute('sandbox', 'environment', 'GET');
    expect(route).toBeTruthy();
    const response = await runWithPolicy(adminPolicy, () => route!.handler(pluginRequest('GET', { userId: '2' })), {
      identity: operator(3), contributionUserId: 3, sessionId: 'brain-admin-environment', workDir: projectPath,
    });
    expect(response.status ?? 200).toBe(200);
    expect((response.body as { home: { path: string } }).home.path).toContain('/sandbox/users/2/home');

    const unknown = await runWithPolicy(adminPolicy, () => route!.handler(pluginRequest('GET', { userId: '999' })), {
      identity: operator(3), contributionUserId: 3, sessionId: 'brain-admin-environment', workDir: projectPath,
    });
    expect(unknown.status).toBe(404);

    const previewRoute = registry.apiRoute('sandbox', 'environment/reset-preview', 'POST')!;
    const resetRoute = registry.apiRoute('sandbox', 'environment/reset', 'POST')!;
    const preview = await runWithPolicy(adminPolicy, () => previewRoute.handler(pluginRequest('POST', { userId: '1' })), {
      identity: operator(3), contributionUserId: 3, sessionId: 'brain-admin-environment', workDir: projectPath,
    });
    const previewHash = (preview.body as { previewHash: string }).previewHash;
    const crossUserReset = await runWithPolicy(adminPolicy, () => resetRoute.handler(pluginRequest('POST', { userId: '2' }, { previewHash, phrase: 'RESET HOME' })), {
      identity: operator(3), contributionUserId: 3, sessionId: 'brain-admin-environment', workDir: projectPath,
    });
    expect(crossUserReset.status).toBe(409);
  });

  it('gives operators and non-operators distinct persistent account HOME directories', async () => {
    const { registry, projectPath } = await setup(['sandbox', 'terminal']);
    const amy = await runAs(registry, projectPath, 1, 'brain-home-a', 'Bash', { command: 'printf %s "$HOME"' });
    const bob = await runAs(registry, projectPath, 2, 'brain-home-b', 'Bash', { command: 'printf %s "$HOME"' });
    const admin = await runWithPolicy(adminPolicy, () => tool(registry, 'Bash').execute('t', { command: 'printf %s "$HOME"', cwd: projectPath }), { identity: operator(1), contributionUserId: 1, sessionId: 'brain-home-admin', workDir: projectPath });
    expect(amy.content[0]!.text).toContain('/sandbox/users/1/home');
    expect(bob.content[0]!.text).toContain('/sandbox/users/2/home');
    expect(admin.content[0]!.text).toContain('/sandbox/users/1/home');
  });

  /** The account HOME deliberately holds NO GitHub state — no hosts.yml, no credential helper in a
   *  .gitconfig. Everything that signs the child in travels in its environment for that one launch, which
   *  is what makes disconnecting take effect on the next command with nothing left to clean up. */
  it('starts a confined child already signed in to GitHub for an account that connected an identity', async () => {
    const { registry, projectPath } = await setup(['sandbox', 'terminal'], true);
    connectGitHub(registry, ({ accountUserId }) => accountUserId === 1 ? { token: GITHUB_TOKEN, login: 'octocat' } : null);
    const prepared = await runWithPolicy(policy(projectPath), () => registry.control('sandbox')!.prepareExecution({
      command: { type: 'shell', command: 'true' }, cwd: projectPath, leaseKind: 'terminal',
    }), { identity: nonOperator(1), contributionUserId: 1, sessionId: 'brain-github', workDir: projectPath });
    expect(prepared.launch.env).toMatchObject({
      GH_TOKEN: GITHUB_TOKEN,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    });
    await prepared.lease.release();

    // Real git, reading the real launch environment: the pairs above are only worth anything if git
    // resolves them into the helper it will actually run, so the child is asked rather than the shape.
    const helper = await runAs(registry, projectPath, 1, 'brain-github', 'Bash', {
      command: `git config --get-all 'credential.https://github.com.helper'`,
    });
    expect(helper.content[0]!.text).toContain('!gh auth git-credential');

    // And inside a namespace, which is where a non-operator account actually runs. bwrap passes its own
    // environment through, so the injected variables survive the confinement — and `gh` itself has to be
    // reachable in there, or the helper git resolves would be a command the child cannot run.
    const confined = await registry.control('sandbox')!.prepareExecution(
      { command: { type: 'shell', command: `git config --get-all 'credential.https://github.com.helper'; command -v gh` }, cwd: projectPath, leaseKind: 'terminal' },
      { accountUserId: 1, roots: [projectPath] },
    );
    expect(confined.mode).toBe('confined');
    const inside = await runPrepared(confined);
    expect(inside.output).toContain('!gh auth git-credential');
    expect(inside.output).toContain('/gh');
  });

  it('confines an operator whose cwd is an active workspace and authenticates GitHub there', async () => {
    const { registry, projectPath } = await setup(['sandbox', 'terminal'], true);
    const created = await runAs(registry, projectPath, 1, 'brain-github-owner-workspace', 'SandboxCreateWorkspace', {
      projectId: 1, label: 'Owner GitHub', baseRef: 'main',
    });
    const workspace = created.details.workspace;
    connectGitHub(registry, ({ accountUserId }) => accountUserId === 1 ? { token: GITHUB_TOKEN, login: 'octocat' } : null);

    const prepared = await runWithPolicy(adminPolicy, () => registry.control('sandbox')!.prepareExecution({
      command: { type: 'shell', command: 'true' }, cwd: workspace.path, leaseKind: 'terminal',
    }), {
      identity: operator(1), contributionUserId: 1, sessionId: 'brain-github-owner-workspace', workDir: workspace.path,
    });

    expect(prepared.mode).toBe('confined');
    expect(prepared.workspace?.workspaceId).toBe(workspace.id);
    expect(prepared.launch.env.GH_TOKEN).toBe(GITHUB_TOKEN);
    expect(JSON.stringify(prepared.launch)).not.toContain(GITHUB_TOKEN);
    await prepared.lease.release();
  });

  it('leaves the child unauthenticated for an account, an owner and a seam that cannot answer', async () => {
    const { registry, projectPath } = await setup();
    const prepare = (userId: number) => runWithPolicy(policy(projectPath), () => registry.control('sandbox')!.prepareExecution({
      command: { type: 'shell', command: 'true' }, cwd: projectPath, leaseKind: 'terminal',
    }), { identity: nonOperator(userId), contributionUserId: userId, sessionId: `brain-github-${userId}`, workDir: projectPath });

    // No GitHub plugin at all — the ordinary state on an instance that never installed it.
    const withoutOwner = await prepare(1);
    expect(withoutOwner.launch.env).not.toHaveProperty('GH_TOKEN');
    expect(withoutOwner.launch.env).not.toHaveProperty('GIT_CONFIG_COUNT');
    await withoutOwner.lease.release();

    // Present, but this account has not connected: nothing is injected, and the launch is otherwise
    // identical — no half-configured credential helper pointing at a token that is not there.
    connectGitHub(registry, ({ accountUserId }) => accountUserId === 1 ? { token: GITHUB_TOKEN, login: 'octocat' } : null);
    const unconnected = await prepare(2);
    expect(unconnected.launch.env).not.toHaveProperty('GH_TOKEN');
    expect(unconnected.launch.env).not.toHaveProperty('GIT_CONFIG_COUNT');
    await unconnected.lease.release();

    // A broken owner must not turn every shell command into an error: the command runs, unauthenticated.
    connectGitHub(registry, () => { throw new Error('credential seam is down'); });
    const broken = await prepare(1);
    expect(broken.launch.env).not.toHaveProperty('GH_TOKEN');
    await broken.lease.release();

    // An instance/owner-less run has no account to ask about, so the seam is never consulted for one.
    let asked = 0;
    connectGitHub(registry, () => { asked += 1; return { token: GITHUB_TOKEN, login: 'octocat' }; });
    const owned = temp('github-service-root');
    const service = await registry.control('sandbox')!.prepareExecution(
      { command: { type: 'shell', command: 'true' }, cwd: owned, leaseKind: 'sites' },
      { accountUserId: null, roots: [owned] },
    );
    expect(asked).toBe(0);
    expect(service.launch.env).not.toHaveProperty('GH_TOKEN');
    await service.lease.release();
  });

  it.each([operator, nonOperator])('never gives a direct process a daemon or account GitHub credential (%#)', async (identity) => {
    const { registry, projectPath } = await setup();
    connectGitHub(registry, () => ({ token: GITHUB_TOKEN, login: 'octocat' }));
    const inherited = {
      GH_TOKEN: 'daemon-gh-token',
      GITHUB_TOKEN: 'daemon-github-token',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer daemon-header-token',
      GIT_CONFIG_PARAMETERS: "'credential.helper=daemon-helper'",
      GIT_CONFIG: '/daemon/gitconfig',
      GIT_CONFIG_GLOBAL: '/daemon/global-gitconfig',
      GIT_CONFIG_SYSTEM: '/daemon/system-gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
    Object.assign(process.env, inherited);
    try {
      const prepared = await runWithPolicy(policy(projectPath), () => registry.control('sandbox')!.prepareExecution({
        command: { type: 'argv', file: process.execPath, args: ['-e',
          'console.log(JSON.stringify(Object.keys(process.env).filter(key => key.startsWith("GIT_CONFIG") || key === "GH_TOKEN" || key === "GITHUB_TOKEN")))',
        ] }, cwd: projectPath, leaseKind: 'terminal',
      }), { identity: identity(1), contributionUserId: 1, sessionId: 'brain-github-direct', workDir: projectPath });
      try {
        expect(prepared.mode).toBe('direct');
        for (const key of Object.keys(inherited)) {
          if (key === 'GIT_CONFIG_NOSYSTEM') expect(prepared.launch.env[key]).toBe('1');
          else expect(prepared.launch.env).not.toHaveProperty(key);
        }
        const ran = await runPrepared(prepared);
        expect(JSON.parse(ran.output)).toEqual(['GIT_CONFIG_NOSYSTEM']);
      } finally {
        await prepared.lease.release();
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('keeps the injected GitHub token out of everything a caller can read back', async () => {
    const { registry, projectPath } = await setup(['sandbox', 'terminal'], true);
    connectGitHub(registry, () => ({ token: GITHUB_TOKEN, login: 'octocat' }));
    const prepared = await runWithPolicy(policy(projectPath), () => registry.control('sandbox')!.prepareExecution({
      command: { type: 'shell', command: 'true' }, cwd: projectPath, leaseKind: 'terminal',
    }), { identity: nonOperator(1), contributionUserId: 1, sessionId: 'brain-github-redact', workDir: projectPath });
    // The redaction lives on the launch value itself, so a diagnostic that serialises a prepared launch —
    // this one, or one added later — cannot forget to apply it, while `spawn` still receives the real
    // token because `toJSON` is not part of the environment it reads.
    expect(JSON.stringify(prepared.launch)).not.toContain(GITHUB_TOKEN);
    expect(JSON.stringify(prepared.launch)).toContain('[redacted]');
    expect(JSON.stringify(prepared)).not.toContain(GITHUB_TOKEN);
    expect(prepared.launch.env.GH_TOKEN).toBe(GITHUB_TOKEN);
    expect(prepared.sanitizeOutput(`leaked ${GITHUB_TOKEN} here`)).toBe('leaked [redacted] here');
    await prepared.lease.release();

    // The other escape route: a command that simply prints its own environment.
    const echoed = await runAs(registry, projectPath, 1, 'brain-github-redact', 'Bash', { command: 'printf %s "$GH_TOKEN"' });
    expect(echoed.content[0]!.text).not.toContain(GITHUB_TOKEN);
    expect(echoed.content[0]!.text).toContain('[redacted]');

    // The shared runner is the third route. Its callers — the workspace git plumbing and the account
    // gitconfig route — hand the result straight to an API response, so it sanitises there rather than
    // trusting each of them to remember.
    const echoing = await runWithPolicy(policy(projectPath), () => registry.control('sandbox')!.prepareExecution({
      command: { type: 'shell', command: 'printf %s "$GH_TOKEN"' }, cwd: projectPath, leaseKind: 'terminal',
    }), { identity: nonOperator(1), contributionUserId: 1, sessionId: 'brain-github-redact', workDir: projectPath });
    const ran = await runPrepared(echoing);
    expect(ran.output).not.toContain(GITHUB_TOKEN);
    expect(ran.output).toBe('[redacted]');
  });

  it('keeps a lease through background execution and releases it only after kill exits', async () => {
    const { registry, db, projectPath } = await setup(['sandbox', 'terminal']);
    const started = await runAs(registry, projectPath, 1, 'brain-lease-bg', 'Bash', { command: 'sleep 30', background: true });
    const id = /process (\S+):/.exec(started.content[0]!.text)?.[1];
    expect(id).toBeTruthy();
    expect((db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get() as { n: number }).n).toBe(1);
    await runAs(registry, projectPath, 1, 'brain-lease-bg', 'KillProcess', { id: id! });
    await waitUntil(() => (db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get() as { n: number }).n === 0);
  });

  it('keeps the same lease when Ctrl+B detaches until the real process exits', async () => {
    const { registry, db, projectPath } = await setup(['sandbox', 'terminal']);
    const running = runAs(registry, projectPath, 1, 'brain-lease-detach', 'Bash', { command: 'sleep 1' });
    await waitUntil(() => processRegistry.listForSession('brain-lease-detach').length === 1);
    const terminal = registry.control('terminal')!;
    expect(terminal.detachForeground({ sessionId: 'brain-lease-detach', principal: 'elowen:1' })).toEqual({ detached: 1 });
    await running;
    expect((db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get() as { n: number }).n).toBe(1);
    await waitUntil(() => (db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get() as { n: number }).n === 0);
  });

  it('rejects a control consumer cwd outside the current account roots', async () => {
    const { registry, projectPath } = await setup();
    const outside = temp('control-cwd');
    await expect(runWithPolicy(policy(projectPath), () => registry.control('sandbox')!.prepareExecution({
      command: { type: 'shell', command: 'pwd' }, cwd: outside, leaseKind: 'terminal',
    }), { identity: nonOperator(1), contributionUserId: 1, sessionId: 'brain-control-cwd', workDir: projectPath }))
      .rejects.toThrow(/outside the current account/);
  });

  it('prepares execution for a background service that names its own account and roots', async () => {
    // No policy, no identity, no session: exactly what registerService and registerInterval run with.
    // Without the explicit form such a caller cannot prepare anything at all, because the ambient
    // lookup answers with no account and no roots.
    const { registry, db } = await setup();
    const owned = temp('service-root');
    const prepared = await registry.control('sandbox')!.prepareExecution(
      { command: { type: 'shell', command: 'pwd' }, cwd: owned, leaseKind: 'sites' },
      { accountUserId: 1, roots: [owned] },
    );
    expect(prepared.cwd).toBe(realPathWithin(owned, [owned]));
    // setup() leaves confineNonOperators false, which is the instance-wide shortcut into direct
    // execution. An explicit request must ignore it, so asserting the mode here is the point of the
    // test rather than a detail of it.
    expect(prepared.mode).toBe('confined');
    expect(db.prepare("SELECT kind FROM p_sandbox_execution_leases WHERE id = ?").get(prepared.lease.id))
      .toEqual({ kind: 'sites' });
    await prepared.lease.release();
  });

  it('can isolate a site runtime from the host and other loopback listeners', async () => {
    const { registry } = await setup();
    const owned = temp('service-netns');
    const prepared = await registry.control('sandbox')!.prepareExecution(
      { command: { type: 'shell', command: 'pwd' }, cwd: owned, leaseKind: 'sites', network: 'isolated' },
      { accountUserId: 1, roots: [owned] },
    );
    expect(JSON.stringify(prepared.launch)).toContain('--unshare-net');
    await prepared.lease.release();
  });

  it('never hands a plugin unconfined execution, even inside an operator turn', async () => {
    // `owner` selects DIRECT execution: no bubblewrap, and the daemon's whole environment passed to the
    // child. It follows from who is driving the turn and must never follow from what a plugin asked
    // for — otherwise a plugin's background work is a way to launder the operator's own reach.
    // Not skipped when bubblewrap is missing: the guarantee under test is "confined or nothing", so a
    // host that cannot confine must make the call FAIL rather than quietly hand back direct execution.
    const probe = bubblewrapProbe();
    const { registry, projectPath } = await setup();
    const prepare = () => runWithPolicy(adminPolicy, () => registry.control('sandbox')!.prepareExecution(
      { command: { type: 'shell', command: 'pwd' }, cwd: projectPath, leaseKind: 'sites' },
      { accountUserId: 1, roots: [projectPath] },
    ), { identity: operator(3), contributionUserId: 3, sessionId: 'brain-service-owner', workDir: projectPath });

    if (!probe.available) {
      await expect(prepare()).rejects.toThrow(/confined execution is unavailable/);
      return;
    }
    const prepared = await prepare();
    expect(prepared.mode).toBe('confined');
    await prepared.lease.release();
  });

  it('still confines an explicit request to the roots it named', async () => {
    const { registry } = await setup();
    const owned = temp('service-owned');
    const elsewhere = temp('service-elsewhere');
    await expect(registry.control('sandbox')!.prepareExecution(
      { command: { type: 'shell', command: 'pwd' }, cwd: elsewhere, leaseKind: 'sites' },
      { accountUserId: 1, roots: [owned] },
    )).rejects.toThrow(/outside the current account/);
  });

  it('keeps the lease until a foreground shell descendant exits', async () => {
    const { registry, db, projectPath } = await setup(['sandbox', 'terminal']);
    const running = runAs(registry, projectPath, 1, 'brain-descendant', 'Bash', { command: 'sleep 0.4 >/dev/null 2>&1 &' });
    await waitUntil(() => (db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get() as { n: number }).n === 1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    expect((db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get() as { n: number }).n).toBe(1);
    await running;
    expect((db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get() as { n: number }).n).toBe(0);
  });

  it('fails closed without Sandbox for a non-operator and keeps the explicit operator fallback', async () => {
    const { registry, projectPath } = await setup(['terminal']);
    const refused = await runAs(registry, projectPath, 1, 'brain-no-sandbox', 'Bash', { command: 'echo no' });
    expect(refused.content[0]!.text).toMatch(/Sandbox plugin is disabled or failed to load/);
    const allowed = await runWithPolicy(adminPolicy, () => tool(registry, 'Bash').execute('t', { command: 'echo operator', cwd: projectPath }), { identity: operator(1), contributionUserId: 1, sessionId: 'brain-operator', workDir: projectPath });
    expect(allowed.content[0]!.text).toContain('operator');
  });
});

async function withLeaseChild(run: (child: { pid: number; stop(): Promise<void> }) => Promise<void>, script = `
  await new Promise((resolve) => { process.once('message', resolve); process.send('ready'); });
`, args: string[] = []) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const deadline = setTimeout(() => process.exit(2), 10_000);
    process.once('disconnect', () => process.exit(0));
    ${script}
    clearTimeout(deadline);
    if (process.connected) process.disconnect();
  `, ...args], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const stop = async () => {
    if (child.connected) child.send('finish');
    const [code] = await closed;
    expect(code, stderr).toBe(0);
  };
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5_000) });
    expect(message).toBe('ready');
    await run({ pid: child.pid!, stop });
  } finally {
    await stop();
  }
}

describe('sandbox durable repository locks', () => {
  it('does not reclaim a current lease while its exact process owner is still alive', async () => {
    const { db } = await setup();
    const identity = processIdentity();
    expect(identity).toBeTruthy();
    const future = Date.now() + 60_000;
    db.prepare(`INSERT INTO p_sandbox_execution_leases
      (id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('live',1,NULL,1,?,?, 'terminal',0,?)`).run(process.pid, identity, future);
    db.prepare(`INSERT INTO p_sandbox_repo_leases
      (common_dir,owner_id,outer_pid,runner_identity,heartbeat_at,expires_at)
      VALUES ('/repo/live','owner',?,?,0,?)`).run(process.pid, identity, future);
    expect(reconcileStaleLeases(db)).toEqual({ executionRemoved: 0, reposRemoved: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_execution_leases WHERE id='live'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_repo_leases WHERE common_dir='/repo/live'").get()).toEqual({ n: 1 });
  });

  it('retains expired leases while the exact owner process is alive', async () => {
    const { db } = await setup();
    const identity = processIdentity();
    const past = Date.now() - 1_000;
    db.prepare(`INSERT INTO p_sandbox_execution_leases
      (id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('expired',1,'ws_x',1,?,?,'terminal',?,?)`).run(process.pid, identity, past, past);
    db.prepare(`INSERT INTO p_sandbox_repo_leases
      (common_dir,owner_id,outer_pid,runner_identity,heartbeat_at,expires_at)
      VALUES ('/repo/expired','owner',?,?,?,?)`).run(process.pid, identity, past, past);
    expect(reconcileStaleLeases(db)).toEqual({ executionRemoved: 0, reposRemoved: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_execution_leases WHERE id='expired'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_repo_leases WHERE common_dir='/repo/expired'").get()).toEqual({ n: 1 });
  });

  it('counts an expired lease as active until its owner is provably dead', async () => {
    const { db } = await setup();
    const identity = processIdentity();
    const past = Date.now() - 1_000;
    db.prepare(`INSERT INTO p_sandbox_execution_leases
      (id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('expired',1,'ws_x',1,?,?,'terminal',?,?)`).run(process.pid, identity, past, past);
    expect(activeExecutionLeases(db, { workspaceId: 'ws_x' })).toHaveLength(1);
  });

  it('renews an expired retained lease without losing active protection', async () => {
    const { registry, db, projectPath } = await setup();
    const workspace = (await runAs(registry, projectPath, 1, 'brain-heartbeat', 'SandboxCreateWorkspace', { projectId: 1, label: 'Beat', baseRef: 'main' })).details.workspace;
    const lease = registry.control('sandbox')!.acquireDelegationLease({
      accountUserId: 1, workspace: { workspaceId: workspace.id, projectId: 1 },
    });
    expect(activeExecutionLeases(db, { workspaceId: workspace.id })).toHaveLength(1);
    // A missed heartbeat does not prove that the guarded execution stopped.
    db.prepare('UPDATE p_sandbox_execution_leases SET expires_at = ? WHERE id = ?').run(Date.now() - 1, lease.id);
    expect(reconcileStaleLeases(db)).toEqual({ executionRemoved: 0, reposRemoved: 0 });
    await lease.heartbeat();
    expect(activeExecutionLeases(db, { workspaceId: workspace.id })).toHaveLength(1);
    expect(reconcileStaleLeases(db)).toEqual({ executionRemoved: 0, reposRemoved: 0 });
    await lease.release();
    expect(activeExecutionLeases(db, { workspaceId: workspace.id })).toHaveLength(0);
  });

  it('restores a missing execution lease without reviving it after explicit release', async () => {
    const { registry, db, projectPath } = await setup();
    const workspace = (await runAs(registry, projectPath, 1, 'brain-resurrect', 'SandboxCreateWorkspace', { projectId: 1, label: 'Resurrect', baseRef: 'main' })).details.workspace;
    const lease = registry.control('sandbox')!.acquireDelegationLease({
      accountUserId: 1, workspace: { workspaceId: workspace.id, projectId: 1 },
    });
    db.prepare('DELETE FROM p_sandbox_execution_leases WHERE id = ?').run(lease.id);
    expect(activeExecutionLeases(db, { workspaceId: workspace.id })).toEqual([]);

    await lease.heartbeat();
    const active = activeExecutionLeases(db, { workspaceId: workspace.id });
    expect(active.map((row) => row.id)).toEqual([lease.id]);
    expect(active[0]).toMatchObject({ user_id: 1, workspace_id: workspace.id, kind: 'terminal', outer_pid: process.pid });
    // The resurrected row is the same lease: releasing it clears it, and a late heartbeat brings nothing back.
    await lease.release();
    expect(activeExecutionLeases(db, { workspaceId: workspace.id })).toEqual([]);
    await lease.heartbeat();
    expect(activeExecutionLeases(db, { workspaceId: workspace.id })).toEqual([]);
  });

  it('re-claims a reaped repository lease on heartbeat when it is free and reports a foreign holder', async () => {
    const { db } = await setup();
    const identity = processIdentity()!;
    const past = Date.now() - 1_000;
    const mine = 'srl_mine';
    db.prepare(`INSERT INTO p_sandbox_repo_leases
      (common_dir,owner_id,outer_pid,runner_identity,heartbeat_at,expires_at)
      VALUES ('/repo/beat',?,?,?,?,?)`).run(mine, process.pid, identity, past, past);
    db.prepare("DELETE FROM p_sandbox_repo_leases WHERE common_dir='/repo/beat'").run();
    // Free again: the heartbeat takes the row back and the lease is held as before.
    expect(heartbeatRepoLease(db, '/repo/beat', mine, identity)).toBe('reclaimed');
    expect(db.prepare("SELECT owner_id FROM p_sandbox_repo_leases WHERE common_dir='/repo/beat'").get()).toEqual({ owner_id: mine });
    expect(heartbeatRepoLease(db, '/repo/beat', mine, identity)).toBe('held');
    // Somebody else claimed it in the gap: two holders would be worse than a loud failure.
    db.prepare("UPDATE p_sandbox_repo_leases SET owner_id = 'srl_other' WHERE common_dir='/repo/beat'").run();
    expect(heartbeatRepoLease(db, '/repo/beat', mine, identity)).toBe('lost');
    expect(db.prepare("SELECT owner_id FROM p_sandbox_repo_leases WHERE common_dir='/repo/beat'").get()).toEqual({ owner_id: 'srl_other' });
  });

  it.each(['owner_id', 'runner_identity', 'outer_pid'] as const)('detects changed %s before the next heartbeat and preserves the successor', async (column) => {
    const { db } = await setup();
    const replacement = column === 'outer_pid' ? process.pid + 1 : 'successor';
    const holder = withRepoLease(db, '/repo/lost', async () => {
      db.prepare(`UPDATE p_sandbox_repo_leases SET ${column} = ? WHERE common_dir='/repo/lost'`).run(replacement);
    }, { heartbeatMs: 60_000 });
    await expect(holder).rejects.toThrow(/lease was lost/);
    expect(db.prepare(`SELECT ${column} FROM p_sandbox_repo_leases WHERE common_dir='/repo/lost'`).get())
      .toEqual({ [column]: replacement });
  });

  it('keeps a conversation bound after lease expiry until the holder explicitly releases', async () => {
    const { registry, db, projects } = await setup(['sandbox'], false, ['main']);
    db.prepare("INSERT INTO brain_sessions (id, user_id) VALUES ('brain-amy-expired', 1)").run();
    const projectPath = projects[0]!.path;
    const workspace = (await runAs(registry, projectPath, 1, 'brain-amy-expired', 'SandboxCreateWorkspace', { projectId: 1, label: 'Stale', baseRef: 'main' })).details.workspace;
    const lease = registry.control('sandbox')!.acquireDelegationLease({
      accountUserId: 1, workspace: { workspaceId: workspace.id, projectId: 1 },
    });
    const release = () => registry.apiRoute('sandbox', 'workspaces/release', 'POST')!.handler(pluginRequest(
      'POST', {}, { sessionId: 'brain-amy-expired' }, { userId: 1, admin: false, tokenScope: 'user', accessibleProjects: [1, 2] },
    ));
    expect((await release()).status).toBe(409);
    db.prepare('UPDATE p_sandbox_execution_leases SET expires_at = ? WHERE id = ?').run(Date.now() - 1, lease.id);
    expect((await release()).status).toBe(409);
    await lease.release();
    const freed = await release();
    expect(freed.status).toBe(200);
    expect(freed.body).toEqual({ released: 1, workspaceIds: [workspace.id] });
  });

  it('refuses a repository lease whose live owner let it expire', async () => {
    const { db } = await setup();
    const identity = processIdentity();
    const past = Date.now() - 1_000;
    db.prepare(`INSERT INTO p_sandbox_repo_leases
      (common_dir,owner_id,outer_pid,runner_identity,heartbeat_at,expires_at)
      VALUES ('/repo/lapsed','stale-owner',?,?,?,?)`).run(process.pid, identity, past, past);
    await expect(withRepoLease(db, '/repo/lapsed', async () => 'unsafe', { waitMs: 0 })).rejects.toThrow(/busy/);
    expect(db.prepare("SELECT owner_id FROM p_sandbox_repo_leases WHERE common_dir='/repo/lapsed'").get()).toEqual({ owner_id: 'stale-owner' });
  });

  it('reclaims a reused PID only when the stored process identity is provably different', async () => {
    const { db } = await setup();
    db.prepare(`INSERT INTO p_sandbox_execution_leases
      (id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('reused',1,NULL,1,?,'linux:different-boot:1','terminal',0,?)`).run(process.pid, Date.now() + 60_000);
    db.prepare(`INSERT INTO p_sandbox_repo_leases
      (common_dir,owner_id,outer_pid,runner_identity,heartbeat_at,expires_at)
      VALUES ('/repo/reused','old',?,'linux:different-boot:1',0,?)`).run(process.pid, Date.now() + 60_000);
    expect(reconcileStaleLeases(db)).toEqual({ executionRemoved: 1, reposRemoved: 1 });
  });

  it.each(['verified', 'unverifiable'] as const)('keeps expired execution and repo leases for a live subprocess with %s identity', async (kind) => {
    const { db } = await setup();
    await withLeaseChild(async ({ pid, stop }) => {
      const identity = kind === 'verified' ? processIdentity(pid) : 'unverifiable:test';
      expect(identity).toBeTruthy();
      db.prepare(`INSERT INTO p_sandbox_execution_leases
        (id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
        VALUES ('child',1,NULL,1,?,?,'terminal',0,0)`).run(pid, identity);
      db.prepare(`INSERT INTO p_sandbox_repo_leases
        (common_dir,owner_id,outer_pid,runner_identity,heartbeat_at,expires_at)
        VALUES ('/repo/child','child',?,?,0,0)`).run(pid, identity);
      expect.soft(reconcileStaleLeases(db)).toEqual({ executionRemoved: 0, reposRemoved: 0 });
      expect.soft(activeExecutionLeases(db, { accountUserId: 1 })).toHaveLength(1);
      await stop();
      expect(reconcileStaleLeases(db)).toEqual({ executionRemoved: 1, reposRemoved: 1 });
    });
  });

  it('reclaims future leases only after an actual subprocess owner exits', async () => {
    const { db } = await setup();
    await withLeaseChild(async ({ pid, stop }) => {
      const identity = processIdentity(pid);
      expect(identity).toBeTruthy();
      await stop();
      const future = Date.now() + 60_000;
      db.prepare(`INSERT INTO p_sandbox_execution_leases
        (id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
        VALUES ('dead',1,NULL,1,?,?,'terminal',0,?)`).run(pid, identity, future);
      db.prepare(`INSERT INTO p_sandbox_repo_leases
        (common_dir,owner_id,outer_pid,runner_identity,heartbeat_at,expires_at)
        VALUES ('/repo/dead','dead',?,?,0,?)`).run(pid, identity, future);
      expect(reconcileStaleLeases(db)).toEqual({ executionRemoved: 1, reposRemoved: 1 });
      await expect(withRepoLease(db, '/repo/dead', async () => 'reclaimed', { waitMs: 0 })).resolves.toBe('reclaimed');
    });
  });

  it.each([0, -1, 1.5])('keeps an unverifiable lease with invalid PID %s instead of treating it as dead', async (pid) => {
    const { db } = await setup();
    db.prepare(`INSERT INTO p_sandbox_execution_leases
      (id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('unknown',1,NULL,1,?,'unverifiable:test','terminal',0,0)`).run(pid);
    db.prepare(`INSERT INTO p_sandbox_repo_leases
      (common_dir,owner_id,outer_pid,runner_identity,heartbeat_at,expires_at)
      VALUES ('/repo/unknown','unknown',?,'unverifiable:test',0,0)`).run(pid);
    expect(reconcileStaleLeases(db)).toEqual({ executionRemoved: 0, reposRemoved: 0 });
    expect(activeExecutionLeases(db)).toHaveLength(1);
  });

  it('does not admit a second repo holder while an expired actual subprocess holder is alive', async () => {
    const { db } = await setup();
    const databasePath = join(temp('lease-shared'), 'leases.db');
    await db.backup(databasePath);
    const { default: Database } = await import('better-sqlite3');
    const shared = new Database(databasePath);
    try {
      await withLeaseChild(async ({ pid, stop }) => {
        expect(shared.prepare("SELECT outer_pid FROM p_sandbox_repo_leases WHERE common_dir='shared-repo'").get()).toEqual({ outer_pid: pid });
        shared.prepare("UPDATE p_sandbox_repo_leases SET expires_at=0 WHERE common_dir='shared-repo'").run();
        let entered = false;
        await expect.soft(withRepoLease(shared, 'shared-repo', async () => { entered = true; }, { waitMs: 0 })).rejects.toThrow(/busy/);
        expect.soft(entered).toBe(false);
        await stop();
        await expect(withRepoLease(shared, 'shared-repo', async () => 'after-exit', { waitMs: 0 })).resolves.toBe('after-exit');
      }, `
        const { default: Database } = await import('better-sqlite3');
        const { withRepoLease } = await import('./plugins/sandbox/lib/db.mjs');
        const db = new Database(process.argv[1]);
        await withRepoLease(db, 'shared-repo', () => new Promise((resolve) => {
          process.once('message', resolve);
          process.send('ready');
        }), { heartbeatMs: 60_000 });
        db.close();
      `, [databasePath]);
    } finally { shared.close(); }
  });

  it('blocks workspace release, removal and HOME reset under a live child then releases on actual exit', async () => {
    const { registry, db, projectPath, dataRoot } = await setup();
    const session = 'brain-child-lease';
    db.prepare('INSERT INTO brain_sessions (id,user_id) VALUES (?,1)').run(session);
    const workspace = (await runAs(registry, projectPath, 1, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Child lease', baseRef: 'main' })).details.workspace;
    const dataDir = join(dataRoot, 'sandbox');
    const home = ensureUserHome(dataDir, 1);
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP fixture did not bind');
    let socket: Socket | undefined;
    try {
      const prepared = await runWithPolicy(policy(workspace.path), () => registry.control('sandbox')!.prepareExecution({
        command: { type: 'argv', file: process.execPath, args: ['-e', `
          const socket = require('node:net').connect(${address.port}, '127.0.0.1');
          const deadline = setTimeout(() => process.exit(2), 20_000);
          socket.on('end', () => { clearTimeout(deadline); process.stdout.write('child-exited'); });
        `] },
        cwd: workspace.path, leaseKind: 'github',
      }), { identity: nonOperator(1), contributionUserId: 1, sessionId: session, workDir: workspace.path });
      const connected = once(server, 'connection', { signal: AbortSignal.timeout(5_000) });
      const running = runPrepared(prepared);
      // Observe rejection immediately even if the connection fails before the command can report it.
      void running.catch(() => {});
      try {
        [socket] = await connected as [Socket];
        db.prepare('UPDATE p_sandbox_execution_leases SET expires_at=0 WHERE id=?').run(prepared.lease.id);
        expect.soft(activeExecutionLeases(db, { workspaceId: workspace.id })).toHaveLength(1);
        const result = await runAs(registry, projectPath, 1, session, 'SandboxReleaseWorkspace', {});
        expect.soft(result.details).toMatchObject({ ok: false, error: { code: 'workspace_in_use' } });
        const removal = await runAs(registry, projectPath, 1, session, 'SandboxRemoveWorkspace', { workspaceId: workspace.id });
        expect.soft(removal.details).toMatchObject({ ok: false, error: { code: 'workspace_in_use' } });
        expect.soft(() => resetUserHome({ db, dataDir, userId: 1, expectedGeneration: home.generation })).toThrow(/HOME is in use/);
      } finally {
        socket?.end();
        expect((await running).output).toBe('child-exited');
      }
      expect(processIdentity()).toBeTruthy();
      expect(activeExecutionLeases(db, { workspaceId: workspace.id })).toEqual([]);
      expect((await runAs(registry, projectPath, 1, session, 'SandboxReleaseWorkspace', {})).details).toMatchObject({ released: 1 });
    } finally {
      socket?.destroy();
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  }, 30_000);

  it.each(['runner_identity', 'outer_pid'] as const)('execution heartbeat and release preserve a successor with changed %s', async (column) => {
    const { db } = await setup();
    const lease = createExecutionLease(db, { accountUserId: 1, workspaceId: null, homeGeneration: 1, kind: 'terminal' });
    const replacement = column === 'outer_pid' ? process.pid + 1 : 'successor';
    db.prepare(`UPDATE p_sandbox_execution_leases SET ${column}=?, heartbeat_at=123, expires_at=456 WHERE id=?`).run(replacement, lease.id);
    const successor = db.prepare('SELECT * FROM p_sandbox_execution_leases WHERE id=?').get(lease.id);
    await lease.heartbeat();
    expect.soft(db.prepare('SELECT * FROM p_sandbox_execution_leases WHERE id=?').get(lease.id)).toEqual(successor);
    await lease.release();
    await lease.heartbeat();
    expect(db.prepare('SELECT * FROM p_sandbox_execution_leases WHERE id=?').get(lease.id)).toEqual(successor);
  });

  it.each(['runner_identity', 'outer_pid'] as const)('repo heartbeat preserves a successor with changed %s', async (column) => {
    const { db } = await setup();
    const identity = processIdentity()!;
    expect(heartbeatRepoLease(db, '/repo/successor', 'mine', identity)).toBe('reclaimed');
    const replacement = column === 'outer_pid' ? process.pid + 1 : 'successor';
    db.prepare(`UPDATE p_sandbox_repo_leases SET ${column}=?, heartbeat_at=123, expires_at=456 WHERE common_dir='/repo/successor'`).run(replacement);
    const successor = db.prepare("SELECT * FROM p_sandbox_repo_leases WHERE common_dir='/repo/successor'").get();
    expect.soft(heartbeatRepoLease(db, '/repo/successor', 'mine', identity)).toBe('lost');
    expect(db.prepare("SELECT * FROM p_sandbox_repo_leases WHERE common_dir='/repo/successor'").get()).toEqual(successor);
  });

  it('serializes one Git common directory across concurrent owners', async () => {
    const { db } = await setup();
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => { release = resolveHold; });
    const first = withRepoLease(db, '/repo/common.git', () => hold);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    await expect(withRepoLease(db, '/repo/common.git', async () => {}, { waitMs: 60 })).rejects.toThrow(/busy/);
    release();
    await first;
    await expect(withRepoLease(db, '/repo/common.git', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('sandbox ownership contracts', () => {
  it('keeps all isolation implementation out of Terminal and declares the exact Sandbox surface', () => {
    const terminalDir = join(repoRoot, 'plugins', 'terminal');
    const terminalSource = readdirSync(terminalDir)
      .filter((name) => name.endsWith('.mjs') || name.endsWith('.json'))
      .map((name) => readFileSync(join(terminalDir, name), 'utf8')).join('\n');
    for (const forbidden of ['bwrap', 'sandbox-home', 'sandboxNonAdmins', 'mount namespace']) expect(terminalSource).not.toContain(forbidden);
    expect(terminalSource).toContain("ctx.control('sandbox')");

    const manifest = JSON.parse(readFileSync(join(repoRoot, 'plugins', 'sandbox', 'elowen-plugin.json'), 'utf8')) as { userGrantable?: boolean; provides: { tools: string[] } };
    expect(manifest.userGrantable).toBeUndefined();
    expect(manifest.provides.tools).toEqual([
      'SandboxListWorkspaces', 'SandboxCreateWorkspace', 'SandboxUseWorkspace', 'SandboxReleaseWorkspace', 'SandboxCommit', 'SandboxRemoveWorkspace',
    ]);
    const registrations = readdirSync(join(repoRoot, 'plugins')).flatMap((name) => {
      const entry = join(repoRoot, 'plugins', name, 'index.mjs');
      return existsSync(entry) && readFileSync(entry, 'utf8').includes("registerControl('sandbox'") ? [name] : [];
    });
    expect(registrations).toEqual(['sandbox']);
  });
});

describe('sandbox HOME migration', () => {
  it('renames the legacy account HOME atomically and refuses a source/target collision', () => {
    const dataRoot = temp('migration');
    const sandboxData = join(dataRoot, 'sandbox');
    const legacy = join(dataRoot, 'terminal', 'sandbox-home', 'user-1');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, '.gitconfig'), 'legacy');
    const first = migrateLegacyHomes(sandboxData);
    expect(first.migrated).toBe(1);
    expect(readFileSync(join(sandboxData, 'users', '1', 'home', '.gitconfig'), 'utf8')).toBe('legacy');

    const source = join(dataRoot, 'terminal', 'sandbox-home', 'user-1');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'other'), 'source');
    const collision = migrateLegacyHomes(sandboxData);
    expect(collision.collisions).toHaveLength(1);
    expect(existsSync(source)).toBe(true);

    const legacySession = join(dataRoot, 'terminal', 'sandbox-home', 'session-0123456789abcdef');
    mkdirSync(legacySession, { recursive: true });
    writeFileSync(join(legacySession, 'state'), 'unknown owner');
    const retained = migrateLegacyHomes(sandboxData);
    expect(retained.retainedSessions).toContain(legacySession);
    expect(existsSync(legacySession)).toBe(true);
  });
});

/** The PLUGIN declares `/sandbox`, not core. That is what makes disabling the plugin remove the command
 *  from every surface menu: there is no sandbox name in the core catalog left to withhold. */
describe('sandbox slash command declaration', () => {
  const publishedFor = (registry: Awaited<ReturnType<typeof setup>>['registry']) => commandsWithPlugins(
    'cli', true,
    [...registry.commands.values()].map((cmd) => ({ ...cmd, plugin: registry.commandOwner.get(cmd.name) })),
    registry.loadedNames,
  );

  it('registers /sandbox as a picker carrying no prompt', async () => {
    const { registry } = await setup();
    const declared = registry.commands.get('sandbox');
    expect(declared).toMatchObject({ name: 'sandbox', kind: 'picker', surfaces: ['cli', 'web'] });
    expect(declared?.prompt).toBeUndefined();
    expect(registry.commandOwner.get('sandbox')).toBe('sandbox');
    expect(publishedFor(registry).find((cmd) => cmd.name === 'sandbox'))
      .toMatchObject({ kind: 'picker', execution: 'surface-local', plugin: 'sandbox' });
  });

  it('publishes no /sandbox at all when the plugin is not loaded', async () => {
    const { registry } = await setup([]);
    expect(registry.loadedNames.has('sandbox')).toBe(false);
    expect(registry.commands.has('sandbox')).toBe(false);
    expect(publishedFor(registry).some((cmd) => cmd.name === 'sandbox')).toBe(false);
  });
});

/** A create carries a caller-supplied conversation id and BINDS the new workspace to it, so the route is
 *  exactly as much an ownership decision as `workspaces/use` is. The refusal has to land before anything
 *  exists: a worktree and a workspace row created and then rejected would be a cross-account write that
 *  merely reports failure. */
describe('sandbox conversation ownership on create', () => {
  const asAmy = { userId: 1, admin: false, tokenScope: 'user' as const, accessibleProjects: [1] };

  it('refuses a create naming another account’s conversation and leaves no worktree, workspace row or binding', async () => {
    const { registry, db, dataRoot, projectPath } = await setup();
    db.prepare("INSERT INTO brain_sessions (id, user_id) VALUES ('brain-amy-own', 1)").run();
    db.prepare("INSERT INTO brain_sessions (id, user_id) VALUES ('brain-bob-private', 2)").run();
    const route = registry.apiRoute('sandbox', 'workspaces/create', 'POST')!;

    const refused = await route.handler(pluginRequest('POST', {}, {
      projectId: 1, label: 'Stolen', baseRef: 'main', sessionId: 'brain-bob-private',
    }, asAmy));

    expect(refused.status).toBe(403);
    expect((refused.body as { error: string }).error).toBe('session_forbidden');
    expect(existsSync(join(dataRoot, 'sandbox', 'users', '1', 'workspaces', 'stolen'))).toBe(false);
    expect(git(projectPath, 'worktree', 'list')).not.toContain('stolen');
    expect(git(projectPath, 'branch', '--list', 'elowen/u1/stolen')).toBe('');
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_workspaces').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_session_bindings').get()).toEqual({ n: 0 });

    // The same call for the caller's OWN conversation still creates and binds — the guard rejects the
    // foreign session, not the route.
    const allowed = await route.handler(pluginRequest('POST', {}, {
      projectId: 1, label: 'Mine', baseRef: 'main', sessionId: 'brain-amy-own',
    }, asAmy));
    expect(allowed.status).toBe(201);
    const created = (allowed.body as { workspace: { id: string; path: string } }).workspace;
    expect(existsSync(created.path)).toBe(true);
    expect(db.prepare('SELECT session_id, user_id FROM p_sandbox_session_bindings').all())
      .toEqual([{ session_id: 'brain-amy-own', user_id: 1 }]);
  });
});

/** An explicit `projectPath` names the Project the way a caller standing in it already can: the absolute
 *  path is canonicalized and must match EXACTLY one existing, currently accessible Project root. Nothing
 *  is inferred from a cwd, a descendant directory never matches, and an unknown and an inaccessible path
 *  are indistinguishable — the outward error must not disclose which Projects exist. */
describe('sandbox create by project path', () => {
  const create = async (
    registry: Awaited<ReturnType<typeof loadPlugins>>,
    projectPath: string,
    userId: number,
    sessionId: string,
    input: Record<string, unknown>,
  ) => runAs(registry, projectPath, userId, sessionId, 'SandboxCreateWorkspace', { label: 'By path', baseRef: 'main', ...input });

  it('creates a workspace by absolute project path', async () => {
    const { registry, projectPath } = await setup();
    const created = await create(registry, projectPath, 1, 'brain-path', { projectPath });
    const workspace = created.details.workspace;
    expect(workspace.projectId).toBe(1);
    expect(workspace.branch).toBe('elowen/u1/by-path');
    expect(existsSync(workspace.path)).toBe(true);
  });

  it('matches a symlinked and a normalized project path canonically', async () => {
    const { registry, projectPath } = await setup();
    const link = join(temp('link'), 'alias');
    symlinkSync(projectPath, link);
    for (const variant of [link, `${projectPath}/./`]) {
      const created = await create(registry, projectPath, 1, 'brain-canonical', { projectPath: variant });
      expect(created.details.workspace.projectId).toBe(1);
    }
  });

  it('matches a project root ending in a space byte-for-byte and never its plain sibling', async () => {
    const { registry, projects } = await setup();
    const spaced = `${createRepository()} `;
    renameSync(spaced.slice(0, -1), spaced);
    const plain = createRepository();
    projects.push({ id: 2, slug: 'spaced-root', path: spaced, notes: '', icon: '' });
    projects.push({ id: 3, slug: 'plain-root', path: plain, notes: '', icon: '' });
    const create = (path: string) => runWithPolicy(adminPolicy, () => tool(registry, 'SandboxCreateWorkspace').execute('t', {
      projectPath: path, label: 'Spaced', baseRef: 'main',
    }), { identity: operator(3), contributionUserId: 3, sessionId: 'brain-admin', workDir: spaced });
    expect((await create(spaced)).details.workspace.projectId).toBe(2);
    expect((await create(plain)).details.workspace.projectId).toBe(3);
  });

  it('refuses relative and empty paths before any side effect', async () => {
    const { registry, projectPath, dataRoot, db } = await setup();
    for (const bad of ['relative/path', '']) {
      const refused = await create(registry, projectPath, 1, 'brain-relative', { projectPath: bad });
      expect(refused.content[0]!.text).toMatch(/absolute path/i);
    }
    expect(git(projectPath, 'worktree', 'list')).not.toContain('by-path');
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_workspaces').get()).toEqual({ n: 0 });
    expect(existsSync(join(dataRoot, 'sandbox', 'users', '1', 'workspaces'))).toBe(false);
  });

  it('is indistinguishable for unknown and inaccessible paths and discloses no path', async () => {
    const { registry, projectPath, dataRoot, db, projects } = await setup(['sandbox'], false, ['main']);
    const second = projects[1]!.path;
    const unknown = temp('unknown');
    const asUser1 = (path: string) => create(registry, projectPath, 1, 'brain-hidden', { projectPath: path });
    const inaccessible = await asUser1(second);
    const missing = await asUser1(unknown);
    expect(inaccessible.content[0]!.text).toMatch(/no accessible Project matches this path/);
    expect(missing.content[0]!.text).toBe(inaccessible.content[0]!.text);
    expect(inaccessible.details.error.code).toBe('project_not_found');
    expect(missing.details.error.code).toBe('project_not_found');
    expect(git(projectPath, 'worktree', 'list')).not.toContain('by-path');
    expect(db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_workspaces').get()).toEqual({ n: 0 });
    expect(existsSync(join(dataRoot, 'sandbox', 'users', '1', 'workspaces'))).toBe(false);
  });

  it('does not match a descendant of an accessible Project', async () => {
    const { registry, projectPath } = await setup();
    mkdirSync(join(projectPath, 'subdir'));
    const refused = await create(registry, projectPath, 1, 'brain-descendant', { projectPath: join(projectPath, 'subdir') });
    expect(refused.content[0]!.text).toMatch(/no accessible Project matches this path/);
    expect(refused.details.error.code).toBe('project_not_found');
  });

  it('fails ambiguous when two accessible Projects share the canonical root', async () => {
    const { registry, projectPath, projects } = await setup();
    projects.push({ id: 2, slug: 'alias', path: projectPath, notes: '', icon: '' });
    const refused = await runWithPolicy(adminPolicy, () => tool(registry, 'SandboxCreateWorkspace').execute('t', {
      projectPath, label: 'Ambiguous', baseRef: 'main',
    }), { identity: operator(3), contributionUserId: 3, sessionId: 'brain-admin', workDir: projectPath });
    expect(refused.content[0]!.text).toMatch(/share this path/i);
    expect(refused.details.error.code).toBe('project_ambiguous');
  });

  it('accepts agreeing selectors and rejects disagreement and malformed ones', async () => {
    const { registry, projectPath, projects } = await setup(['sandbox'], false, ['main']);
    const second = projects[1]!.path;
    const both = await create(registry, projectPath, 1, 'brain-both', { projectId: 1, projectPath });
    expect(both.details.workspace.projectId).toBe(1);
    const conflict = await runWithPolicy(adminPolicy, () => tool(registry, 'SandboxCreateWorkspace').execute('t', {
      projectId: 1, projectPath: second, label: 'Conflict', baseRef: 'main',
    }), { identity: operator(3), contributionUserId: 3, sessionId: 'brain-admin', workDir: projectPath });
    expect(conflict.content[0]!.text).toMatch(/different Projects/i);
    expect(conflict.details.error.code).toBe('project_conflict');
    const malformedId = await create(registry, projectPath, 1, 'brain-malformed', { projectId: 'nope', projectPath });
    expect(malformedId.content[0]!.text).toMatch(/project id/i);
    expect(malformedId.details.error.code).toBe('invalid_project');
  });

  it('demands an explicit selector when neither is given, on the tool and the HTTP route', async () => {
    const { registry, projectPath } = await setup();
    const toolRefusal = await create(registry, projectPath, 1, 'brain-none', {});
    expect(toolRefusal.content[0]!.text).toMatch(/projectId or projectPath/i);
    const route = registry.apiRoute('sandbox', 'workspaces/create', 'POST')!;
    const httpRefusal = await route.handler(pluginRequest('POST', {}, { label: 'None', baseRef: 'main' }, { userId: 1, admin: false, tokenScope: 'user', accessibleProjects: [1] }));
    expect(httpRefusal.status).toBe(400);
  });

  it('creates through the shared HTTP route by project path', async () => {
    const { registry, projectPath, db } = await setup();
    db.prepare("INSERT INTO brain_sessions (id, user_id) VALUES ('brain-http-path', 1)").run();
    const route = registry.apiRoute('sandbox', 'workspaces/create', 'POST')!;
    const created = await route.handler(pluginRequest('POST', {}, {
      projectPath, label: 'Http path', baseRef: 'main', sessionId: 'brain-http-path',
    }, { userId: 1, admin: false, tokenScope: 'user', accessibleProjects: [1] }));
    expect(created.status).toBe(201);
    const workspace = (created.body as { workspace: { projectId: number; path: string } }).workspace;
    expect(workspace.projectId).toBe(1);
    expect(db.prepare('SELECT session_id, user_id FROM p_sandbox_session_bindings').all())
      .toEqual([{ session_id: 'brain-http-path', user_id: 1 }]);
  });
});

/** The cwd answers "which project am I standing in", which is a DIFFERENT question from "which workspace
 *  did this conversation switch to". The chooser offers every accessible project, so these tests drive the
 *  real resolver and assert the directory the NEXT turn would run in — not the binding row. */
describe('sandbox workspace selection follows the conversation, not the cwd', () => {
  type SandboxRoots = { workspaceRoots(input: { projectIds: readonly number[] }): { projectId: number; path: string }[] };
  const scopedPolicy = (control: SandboxRoots, projects: { id: number; path: string }[]): Policy => resolvePolicy({
    userProjects: { forUser: () => projects.map((project) => project.id), isAdmin: () => false },
    projects: { get: (id: number) => projects.find((project) => project.id === id) ?? null },
    supplementalPaths: (userId, projectIds) => runWithContributionUser(userId, () => control.workspaceRoots({ projectIds })),
  }, 1);

  /** Two registered Projects, both assigned to the same account — the ordinary state the chooser offers
   *  and the one the cwd cannot describe on its own. */
  const twoProjects = async (enabled = ['sandbox']) => {
    const { registry, projects } = await setup(enabled, false, ['main']);
    const control = registry.control('sandbox')!;
    const turnPolicy = scopedPolicy(control, projects);
    const act = (workDir: string, session: string, name: string, input: Record<string, unknown>) =>
      runWithPolicy(turnPolicy, () => tool(registry, name).execute('t', input), {
        identity: nonOperator(1), contributionUserId: 1, sessionId: session, workDir,
      });
    const resolveTurn = (forTurn: Policy, baseWorkDir: string, sessionId: string) => effectiveTurnWorkDir({
      policy: forTurn,
      baseWorkDir,
      accountUserId: 1,
      sessionId,
      projects: { list: () => projects },
      sandbox: control,
    });
    return { registry, projects, control, turnPolicy, act, resolveTurn };
  };

  it('follows a switch within the project the cwd names', async () => {
    const { projects, turnPolicy, act, resolveTurn } = await twoProjects();
    const session = 'brain-switch-same';
    const first = (await act(projects[0]!.path, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'First', baseRef: 'main' })).details.workspace;
    const second = (await act(projects[0]!.path, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Second', baseRef: 'main' })).details.workspace;
    expect(first.path).not.toBe(second.path);

    const effective = resolveTurn(turnPolicy, projects[0]!.path, session);
    expect(effective.workDir).toBe(second.path);
    expect(effective.workspace?.workspaceId).toBe(second.id);
  });

  it('follows a switch into a project the cwd says nothing about', async () => {
    const { projects, turnPolicy, act, resolveTurn } = await twoProjects();
    const session = 'brain-switch-cross';
    const here = (await act(projects[0]!.path, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Here', baseRef: 'main' })).details.workspace;
    const elsewhere = (await act(projects[1]!.path, session, 'SandboxCreateWorkspace', { projectId: 2, label: 'Elsewhere', baseRef: 'main' })).details.workspace;

    // The cwd is still project 1, whose own binding is intact — but the conversation's LAST switch was to
    // project 2, and that is where the next turn belongs.
    const effective = resolveTurn(turnPolicy, projects[0]!.path, session);
    expect(effective.workDir).toBe(elsewhere.path);
    expect(effective.workspace?.projectId).toBe(2);
    expect(effective.workDir).not.toBe(here.path);

    // Switching back is equally visible, so this is a live preference and not a "newest workspace" rule.
    await act(projects[1]!.path, session, 'SandboxUseWorkspace', { workspaceId: here.id });
    expect(resolveTurn(turnPolicy, projects[0]!.path, session).workDir).toBe(here.path);
  });

  it('resolves a switch even when the cwd belongs to no project at all', async () => {
    const { projects, act, resolveTurn } = await twoProjects();
    const session = 'brain-switch-noproject';
    const chosen = (await act(projects[1]!.path, session, 'SandboxCreateWorkspace', { projectId: 2, label: 'Chosen', baseRef: 'main' })).details.workspace;
    // An operator's cwd is frequently outside every registered Project, which leaves nothing to infer from.
    const outside = realpathSync(temp('outside-projects'));

    const effective = resolveTurn(adminPolicy, outside, session);
    expect(effective.baseWorkDir).toBe(outside);
    expect(effective.workDir).toBe(chosen.path);
    expect(effective.workspace?.workspaceId).toBe(chosen.id);
  });

  it('keeps the Policy re-validation: a revoked Project falls back to the base directory', async () => {
    const { projects, control, act, resolveTurn } = await twoProjects();
    const session = 'brain-switch-revoked';
    await act(projects[1]!.path, session, 'SandboxCreateWorkspace', { projectId: 2, label: 'Revoked', baseRef: 'main' });
    // Project 2 is no longer assigned: its workspace root leaves allowedPaths with it, so the selected
    // path fails the final clientDir check and the turn keeps its registered directory.
    const narrowed = resolvePolicy({
      userProjects: { forUser: () => [1], isAdmin: () => false },
      projects: { get: (id: number) => projects.find((project) => project.id === id) ?? null },
      supplementalPaths: (userId, projectIds) => runWithContributionUser(userId, () => control.workspaceRoots({ projectIds })),
    }, 1);

    const effective = resolveTurn(narrowed, projects[0]!.path, session);
    expect(effective.workDir).toBe(projects[0]!.path);
    expect(effective.workspace).toBeNull();
  });

  /** The turn scope installs one workDir at turn start and every tool in that turn reads it from ALS, so a
   *  switch landing mid-turn is by construction invisible to the turn already running. Asserted on the
   *  actual cwd a running turn's shell reports, not on the resolver's return value alone. */
  it('does not retarget a turn already in flight', async () => {
    const { registry, projects, turnPolicy, act, resolveTurn } = await twoProjects(['sandbox', 'terminal']);
    const session = 'brain-switch-inflight';
    const started = (await act(projects[0]!.path, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Started', baseRef: 'main' })).details.workspace;
    const later = (await act(projects[1]!.path, session, 'SandboxCreateWorkspace', { projectId: 2, label: 'Later', baseRef: 'main' })).details.workspace;
    await act(projects[0]!.path, session, 'SandboxUseWorkspace', { workspaceId: started.id });

    // The shell reports its cwd as the confined `/workspace` in either worktree, so the two are told apart
    // by a file only one of them holds.
    writeFileSync(join(started.path, 'marker.txt'), 'started-workspace\n');
    writeFileSync(join(later.path, 'marker.txt'), 'later-workspace\n');

    const turn = resolveTurn(turnPolicy, projects[0]!.path, session);
    expect(turn.workDir).toBe(started.path);

    // The switch happens while the turn is running…
    await runWithPolicy(turnPolicy, async () => {
      await act(projects[1]!.path, session, 'SandboxUseWorkspace', { workspaceId: later.id });
      const marker = await tool(registry, 'Bash').execute('t', { command: 'cat marker.txt' });
      expect(marker.content[0]!.text).toContain('started-workspace');
      expect(marker.content[0]!.text).not.toContain('later-workspace');
    }, { identity: nonOperator(1), contributionUserId: 1, sessionId: session, workDir: turn.workDir });

    // …and takes effect on the NEXT turn, which resolves again.
    expect(resolveTurn(turnPolicy, projects[0]!.path, session).workDir).toBe(later.path);
  });
});

/** Releasing is the inverse of a switch and the ONLY way to undo one without destroying something: until
 *  it existed, a binding could be cleared only by deleting the workspace, orphaning its Project or deleting
 *  the account, so a conversation bound once resolved into that workspace forever. These tests drive the
 *  real resolver and assert the directory the NEXT turn would use, and — because the whole point is that
 *  nothing is destroyed — that the workspace row, its branch and its directory are all still there. */
describe('sandbox releases a conversation back to its project', () => {
  const asAmy = { userId: 1, admin: false, tokenScope: 'user' as const, accessibleProjects: [1, 2] };
  const asBob = { userId: 2, admin: false, tokenScope: 'user' as const, accessibleProjects: [1, 2] };

  /** Two accessible Projects, a real conversation row per account, and the same turn resolver the daemon
   *  runs — so an assertion about "where the next turn goes" is the resolver's answer, not a binding row. */
  const bound = async (enabled = ['sandbox']) => {
    const { registry, db, projects } = await setup(enabled, false, ['main']);
    db.prepare("INSERT INTO brain_sessions (id, user_id) VALUES ('brain-amy-release', 1)").run();
    db.prepare("INSERT INTO brain_sessions (id, user_id) VALUES ('brain-bob-private', 2)").run();
    const control = registry.control('sandbox')!;
    const turnPolicy = resolvePolicy({
      userProjects: { forUser: () => projects.map((project) => project.id), isAdmin: () => false },
      projects: { get: (id: number) => projects.find((project) => project.id === id) ?? null },
      supplementalPaths: (userId, projectIds) => runWithContributionUser(userId, () => control.workspaceRoots({ projectIds })),
    }, 1);
    const act = (workDir: string, session: string, name: string, input: Record<string, unknown>) =>
      runWithPolicy(turnPolicy, () => tool(registry, name).execute('t', input), {
        identity: nonOperator(1), contributionUserId: 1, sessionId: session, workDir,
      });
    const resolveTurn = (baseWorkDir: string, sessionId: string) => effectiveTurnWorkDir({
      policy: turnPolicy, baseWorkDir, accountUserId: 1, sessionId,
      projects: { list: () => projects }, sandbox: control,
    });
    const release = (body: Record<string, unknown>, auth = asAmy) =>
      registry.apiRoute('sandbox', 'workspaces/release', 'POST')!.handler(pluginRequest('POST', {}, body, auth));
    const bindings = () => db.prepare('SELECT session_id, user_id, project_id FROM p_sandbox_session_bindings ORDER BY project_id').all();
    return { registry, db, projects, control, turnPolicy, act, resolveTurn, release, bindings };
  };

  it('clears the bindings and the next turn falls back to the project directory', async () => {
    const { projects, act, resolveTurn, release, bindings } = await bound();
    const session = 'brain-amy-release';
    const workspace = (await act(projects[0]!.path, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Released', baseRef: 'main' })).details.workspace;
    expect(resolveTurn(projects[0]!.path, session).workDir).toBe(workspace.path);

    const response = await release({ sessionId: session });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ released: 1, workspaceIds: [workspace.id] });
    expect(bindings()).toEqual([]);

    // The resolver has nothing left to prefer, so the turn runs where the Project is.
    const effective = resolveTurn(projects[0]!.path, session);
    expect(effective.workDir).toBe(projects[0]!.path);
    expect(effective.workspace).toBeNull();

    // Releasing again is a no-op that says so rather than an error.
    expect((await release({ sessionId: session })).body).toEqual({ released: 0, workspaceIds: [] });
  });

  it('preserves the workspace itself: its row, its branch and its directory all survive', async () => {
    const { projects, act, release, db, registry } = await bound();
    const session = 'brain-amy-release';
    const workspace = (await act(projects[0]!.path, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Kept', baseRef: 'main' })).details.workspace;
    writeFileSync(join(workspace.path, 'work-in-progress.txt'), 'still here\n');

    expect((await release({ sessionId: session })).status).toBe(200);

    expect(db.prepare('SELECT id FROM p_sandbox_workspaces').all()).toEqual([{ id: workspace.id }]);
    expect(existsSync(workspace.path)).toBe(true);
    expect(readFileSync(join(workspace.path, 'work-in-progress.txt'), 'utf8')).toBe('still here\n');
    expect(git(projects[0]!.path, 'branch', '--list', workspace.branch)).toContain(workspace.branch);
    expect(git(projects[0]!.path, 'worktree', 'list')).toContain(workspace.path);
    // …and it can be switched back into, which is the whole difference from a removal.
    await act(projects[0]!.path, session, 'SandboxUseWorkspace', { workspaceId: workspace.id });
    expect(registry.control('sandbox')!.workspacesFor({ userId: 1 }).map((entry) => entry.path)).toEqual([workspace.path]);
  });

  it('refuses a release naming another account’s conversation and touches no binding', async () => {
    const { projects, act, resolveTurn, release, bindings } = await bound();
    const session = 'brain-amy-release';
    const workspace = (await act(projects[0]!.path, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Foreign', baseRef: 'main' })).details.workspace;

    // Bob naming Amy's conversation, and Amy naming Bob's: neither owns the other's, so both fail closed.
    for (const [body, auth] of [
      [{ sessionId: session }, asBob],
      [{ sessionId: 'brain-bob-private' }, asAmy],
    ] as const) {
      const refused = await release(body, auth);
      expect(refused.status).toBe(403);
      expect((refused.body as { error: string }).error).toBe('session_forbidden');
    }

    expect(bindings()).toEqual([{ session_id: session, user_id: 1, project_id: 1 }]);
    expect(resolveTurn(projects[0]!.path, session).workDir).toBe(workspace.path);
  });

  it('refuses while a process holds the workspace, and the binding survives', async () => {
    const { registry, db, projects, act, resolveTurn, release, bindings } = await bound();
    const { registry: leased } = { registry };
    const session = 'brain-amy-release';
    const workspace = (await act(projects[0]!.path, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Busy', baseRef: 'main' })).details.workspace;
    // A real execution lease, minted the way a delegated turn mints one — the same row the removal guard
    // reads, so this is the plugin's own notion of "a process is using it".
    const lease = leased.control('sandbox')!.acquireDelegationLease({
      accountUserId: 1, workspace: { workspaceId: workspace.id, projectId: 1 },
    });

    const refused = await release({ sessionId: session });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toBe('workspace_in_use');
    expect(bindings()).toEqual([{ session_id: session, user_id: 1, project_id: 1 }]);
    expect(resolveTurn(projects[0]!.path, session).workDir).toBe(workspace.path);
    expect(db.prepare('SELECT id FROM p_sandbox_workspaces').all()).toEqual([{ id: workspace.id }]);

    // Once the process is gone the same call succeeds — the guard is the lease, not a permanent lock.
    await lease.release();
    expect((await release({ sessionId: session })).status).toBe(200);
    expect(resolveTurn(projects[0]!.path, session).workDir).toBe(projects[0]!.path);
  });

  /** A release lands on the NEXT turn, exactly like a switch: the turn scope installs one workDir at turn
   *  start and every tool in that turn reads it from ALS. Asserted on the cwd a running turn's shell
   *  actually reports, not on the resolver's return value alone. */
  it('takes effect on the next turn and does not retarget a turn already in flight', async () => {
    const { registry, projects, turnPolicy, act, resolveTurn, release } = await bound(['sandbox', 'terminal']);
    const session = 'brain-amy-release';
    const workspace = (await act(projects[0]!.path, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Inflight', baseRef: 'main' })).details.workspace;
    writeFileSync(join(workspace.path, 'marker.txt'), 'workspace\n');
    writeFileSync(join(projects[0]!.path, 'marker.txt'), 'project\n');

    const turn = resolveTurn(projects[0]!.path, session);
    expect(turn.workDir).toBe(workspace.path);

    await runWithPolicy(turnPolicy, async () => {
      expect((await release({ sessionId: session })).status).toBe(200);
      const marker = await tool(registry, 'Bash').execute('t', { command: 'cat marker.txt' });
      expect(marker.content[0]!.text).toContain('workspace');
      expect(marker.content[0]!.text).not.toContain('project');
    }, { identity: nonOperator(1), contributionUserId: 1, sessionId: session, workDir: turn.workDir });

    expect(resolveTurn(projects[0]!.path, session).workDir).toBe(projects[0]!.path);
  });

  /** An explicit project move and an explicit workspace switch are two statements about where the same
   *  conversation works. The most-recent-binding rule ignored the cwd entirely, so choosing Project B left
   *  the next turn running in Project A's workspace while the picker's label read B. The latest explicit
   *  intent now wins — through the plugin's own release, with the Project being entered kept. */
  it('an explicit move to another project releases the old binding, and a move into the workspace’s own project keeps it', async () => {
    const { projects, control, turnPolicy, act, resolveTurn, bindings } = await bound();
    const session = 'brain-amy-release';
    const workspace = (await act(projects[0]!.path, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Moved', baseRef: 'main' })).details.workspace;
    const move = (workDir: string) => releaseWorkspacesForMove({
      policy: turnPolicy, accountUserId: 1, sessionId: session, workDir,
      projects: { list: () => projects }, sandbox: control,
    });

    // Moving INTO the workspace's own project changes nothing: that is where it belongs.
    expect(move(projects[0]!.path)).toEqual({ released: 0, workspaceIds: [] });
    expect(resolveTurn(projects[0]!.path, session).workDir).toBe(workspace.path);
    // The same holds for a move into the worktree itself — it is that project's directory too.
    expect(move(workspace.path)).toEqual({ released: 0, workspaceIds: [] });
    expect(resolveTurn(projects[0]!.path, session).workDir).toBe(workspace.path);

    // Moving to project 2 is a NEWER explicit statement, so project 1's binding goes and the next turn
    // runs where the picker's own label says it does.
    expect(move(projects[1]!.path)).toEqual({ released: 1, workspaceIds: [workspace.id] });
    expect(bindings()).toEqual([]);
    expect(resolveTurn(projects[1]!.path, session).workDir).toBe(projects[1]!.path);
    // Nothing was destroyed on the way: the worktree is intact and can be switched back into.
    expect(existsSync(workspace.path)).toBe(true);
    await act(projects[0]!.path, session, 'SandboxUseWorkspace', { workspaceId: workspace.id });
    expect(resolveTurn(projects[0]!.path, session).workDir).toBe(workspace.path);
  });

  it('refuses the move rather than trapping the conversation, and degrades safely without the control', async () => {
    const { registry, projects, control, turnPolicy, act, resolveTurn } = await bound();
    const session = 'brain-amy-release';
    const workspace = (await act(projects[0]!.path, session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Pinned', baseRef: 'main' })).details.workspace;
    const lease = registry.control('sandbox')!.acquireDelegationLease({
      accountUserId: 1, workspace: { workspaceId: workspace.id, projectId: 1 },
    });
    const move = (sandbox: typeof control | undefined) => releaseWorkspacesForMove({
      policy: turnPolicy, accountUserId: 1, sessionId: session, workDir: projects[1]!.path,
      projects: { list: () => projects }, ...(sandbox ? { sandbox } : {}),
    });

    // Refusing the move is the honest answer: reporting a move whose next turn would still run in the old
    // workspace is the very contradiction this closes.
    expect(() => move(control)).toThrowError(/in use by an active process/);
    expect(resolveTurn(projects[1]!.path, session).workDir).toBe(workspace.path);

    // A build with no Sandbox control at all releases nothing and must not break the move.
    expect(move(undefined)).toEqual({ released: 0 });
    // …and neither must one whose Sandbox is too old to answer the operation.
    expect(releaseWorkspacesForMove({
      policy: turnPolicy, accountUserId: 1, sessionId: session, workDir: projects[1]!.path,
      projects: { list: () => projects },
      sandbox: { ...control, releaseSessionWorkspaces: undefined } as never,
    })).toEqual({ released: 0 });

    await lease.release();
  });
});

/** The model's own way out of a binding. Until it existed the only non-destructive release was the web
 *  route, so an agent that had bound a workspace (SandboxCreateWorkspace = create + activate) could not
 *  hand the conversation back to its Project without a person clicking. Same operation, same guards:
 *  nothing is destroyed, a live process refuses, and a conversation the account does not own is refused. */
describe('SandboxReleaseWorkspace tool', () => {
  const bound = async () => {
    const { registry, db, projects } = await setup(['sandbox'], false, ['main']);
    db.prepare("INSERT INTO brain_sessions (id, user_id) VALUES ('brain-amy-tool', 1)").run();
    db.prepare("INSERT INTO brain_sessions (id, user_id) VALUES ('brain-bob-room', 2)").run();
    const control = registry.control('sandbox')!;
    const turnPolicy = resolvePolicy({
      userProjects: { forUser: () => projects.map((project) => project.id), isAdmin: () => false },
      projects: { get: (id: number) => projects.find((project) => project.id === id) ?? null },
      supplementalPaths: (userId, projectIds) => runWithContributionUser(userId, () => control.workspaceRoots({ projectIds })),
    }, 1);
    const act = (session: string, name: string, input: Record<string, unknown>, workDir = projects[0]!.path) =>
      runWithPolicy(turnPolicy, () => tool(registry, name).execute('t', input), {
        identity: nonOperator(1), contributionUserId: 1, sessionId: session, workDir,
      });
    const resolveTurn = (baseWorkDir: string, sessionId: string) => effectiveTurnWorkDir({
      policy: turnPolicy, baseWorkDir, accountUserId: 1, sessionId,
      projects: { list: () => projects }, sandbox: control,
    });
    const bindings = () => db.prepare('SELECT session_id, project_id FROM p_sandbox_session_bindings ORDER BY project_id').all();
    return { registry, db, projects, act, resolveTurn, bindings };
  };

  it('is declared in the manifest beside the other workspace tools', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'plugins', 'sandbox', 'elowen-plugin.json'), 'utf8')) as { provides: { tools: string[] }; icons: Record<string, string>; showOutput: string[] };
    expect(manifest.provides.tools).toContain('SandboxReleaseWorkspace');
    expect(manifest.icons.SandboxReleaseWorkspace).toBeTruthy();
    expect(manifest.showOutput).toContain('SandboxReleaseWorkspace');
  });

  it('releases every binding of the conversation and preserves the workspace', async () => {
    const { projects, act, resolveTurn, bindings } = await bound();
    const session = 'brain-amy-tool';
    const first = (await act(session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Tool one', baseRef: 'main' })).details.workspace;
    const second = (await act(session, 'SandboxCreateWorkspace', { projectId: 2, label: 'Tool two', baseRef: 'main' }, projects[1]!.path)).details.workspace;
    expect(bindings()).toHaveLength(2);

    const released = await act(session, 'SandboxReleaseWorkspace', {});
    expect(released.details).toMatchObject({ released: 2 });
    expect(released.details.workspaceIds).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(released.content[0]!.text).toMatch(/preserved/);
    expect(bindings()).toEqual([]);
    expect(resolveTurn(projects[0]!.path, session).workDir).toBe(projects[0]!.path);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
    expect(git(projects[0]!.path, 'branch', '--list', first.branch)).toContain(first.branch);

    // Nothing left to release is an answer, not an error.
    const again = await act(session, 'SandboxReleaseWorkspace', {});
    expect(again.details).toMatchObject({ released: 0, workspaceIds: [] });
  });

  it('releases only the named Project when projectId is given', async () => {
    const { projects, act, bindings } = await bound();
    const session = 'brain-amy-tool';
    await act(session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Keep', baseRef: 'main' });
    const dropped = (await act(session, 'SandboxCreateWorkspace', { projectId: 2, label: 'Drop', baseRef: 'main' }, projects[1]!.path)).details.workspace;

    const released = await act(session, 'SandboxReleaseWorkspace', { projectId: 2 });
    expect(released.details).toMatchObject({ released: 1, workspaceIds: [dropped.id] });
    expect(bindings()).toEqual([{ session_id: session, project_id: 1 }]);
  });

  it('refuses while a process holds the workspace and says so', async () => {
    const { registry, act, bindings } = await bound();
    const session = 'brain-amy-tool';
    const workspace = (await act(session, 'SandboxCreateWorkspace', { projectId: 1, label: 'Busy tool', baseRef: 'main' })).details.workspace;
    const lease = registry.control('sandbox')!.acquireDelegationLease({
      accountUserId: 1, workspace: { workspaceId: workspace.id, projectId: 1 },
    });
    const refused = await act(session, 'SandboxReleaseWorkspace', {});
    expect(refused.details.ok).toBe(false);
    expect(refused.details.error.code).toBe('workspace_in_use');
    expect(refused.content[0]!.text).toMatch(/process/);
    expect(bindings()).toHaveLength(1);
    await lease.release();
    expect((await act(session, 'SandboxReleaseWorkspace', {})).details).toMatchObject({ released: 1 });
  });

  it('refuses a conversation the account does not own and touches no binding', async () => {
    const { act, bindings } = await bound();
    // Amy binds inside a room Bob owns (a create does not check the room's owner — it binds where it is
    // told), then asks to release it: the release is an ownership decision and fails closed.
    await act('brain-bob-room', 'SandboxCreateWorkspace', { projectId: 1, label: 'Foreign room', baseRef: 'main' });
    const refused = await act('brain-bob-room', 'SandboxReleaseWorkspace', {});
    expect(refused.details.ok).toBe(false);
    expect(refused.details.error.code).toBe('session_forbidden');
    expect(bindings()).toHaveLength(1);
  });
});

describe('sandbox release live revocation', () => {
  it.each(['tool', 'api', 'control'] as const)('intersects captured scope with durable grants through %s', async (surface) => {
    const { registry, db, projects, userProjects } = await setup(['sandbox'], false, ['main']);
    const sessionId = 'brain-release-revoked';
    db.prepare('INSERT INTO brain_sessions (id, user_id) VALUES (?, 1)').run(sessionId);
    const control = registry.control('sandbox')!;
    const turnPolicy = resolvePolicy({
      userProjects,
      projects: { get: (id) => projects.find((project) => project.id === id) },
      supplementalPaths: (userId, projectIds) => runWithContributionUser(userId, () => control.workspaceRoots({ projectIds })),
    }, 1);
    const scope = { identity: nonOperator(1), contributionUserId: 1, sessionId, workDir: projects[0]!.path };
    const act = (name: string, input: Record<string, unknown>) =>
      runWithPolicy(turnPolicy, () => tool(registry, name).execute('t', input), scope);
    for (const project of projects) {
      const created = await act('SandboxCreateWorkspace', { projectId: project.id, label: `Revoke ${project.id}`, baseRef: 'main' });
      expect(created.details.workspace.projectId).toBe(project.id);
    }
    const bindings = () => db.prepare('SELECT project_id FROM p_sandbox_session_bindings WHERE session_id = ? ORDER BY project_id').all(sessionId);
    const httpRelease = (input: Record<string, unknown>) => registry.apiRoute('sandbox', 'workspaces/release', 'POST')!.handler(pluginRequest(
      'POST', {}, { sessionId, ...input }, { userId: 1, admin: false, tokenScope: 'user', accessibleProjects: [1, 2] },
    ));
    expect(turnPolicy.allowedPaths()).not.toEqual([]);
    userProjects.unassign(1, 1);
    userProjects.unassign(1, 2);
    // Keep the SAME policy: its captured ids survive, but its live filesystem access is empty.
    expect(turnPolicy.allowedProjectIds).toEqual(new Set([1, 2]));
    expect(turnPolicy.allowedPaths()).toEqual([]);
    if (surface === 'tool') {
      expect((await act('SandboxReleaseWorkspace', { projectId: 1 })).details.error.code).toBe('project_forbidden');
    } else if (surface === 'api') {
      const refused = await httpRelease({ projectId: 1 });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ error: 'project_forbidden' });
    }
    expect(bindings()).toEqual([{ project_id: 1 }, { project_id: 2 }]);
    const release = async () => {
      if (surface === 'tool') return (await act('SandboxReleaseWorkspace', {})).details;
      if (surface === 'api') return (await httpRelease({})).body;
      return runWithContributionUser(1, () => control.releaseSessionWorkspaces!({ sessionId, projectIds: [1, 2] }));
    };
    expect(await release()).toMatchObject({ released: 0 });
    expect(bindings()).toEqual([{ project_id: 1 }, { project_id: 2 }]);
    userProjects.assign(1, 2);
    // A live grant outside an explicit control ceiling must never widen that ceiling.
    expect(runWithContributionUser(1, () => control.releaseSessionWorkspaces!({ sessionId, projectIds: [1] })))
      .toMatchObject({ released: 0 });
    expect(await release()).toMatchObject({ released: 1 });
    expect(bindings()).toEqual([{ project_id: 1 }]);
  });
});

describe('sandbox overview publishes an authoritative base ref', () => {
  it('reports each Project’s real default branch instead of guessing main', async () => {
    const { registry, projects } = await setup(['sandbox'], false, ['trunk']);
    const route = registry.apiRoute('sandbox', 'overview', 'GET')!;
    const response = await route.handler(pluginRequest('GET', {}));
    const listed = (response.body as { projects: { id: number; defaultRef: string | null }[] }).projects;
    expect(listed.find((project) => project.id === 1)?.defaultRef).toBe('main');
    expect(listed.find((project) => project.id === 2)?.defaultRef).toBe('trunk');

    // A registered directory that is not a repository has no ref to offer, and none is invented.
    const plain = temp('not-a-repo');
    projects.push({ id: 3, slug: 'plain', path: plain, notes: '', icon: '' });
    const again = await route.handler(pluginRequest('GET', {}));
    expect((again.body as { projects: { id: number; defaultRef: string | null }[] }).projects
      .find((project) => project.id === 3)?.defaultRef).toBeNull();
  });
});

const confinementProbe = bubblewrapProbe();
const confinementRequired = process.env.ELOWEN_REQUIRE_BWRAP === '1';
describe.skipIf(!confinementRequired && !confinementProbe.available)('sandbox Linux confinement integration', () => {
  it('keeps the own root writable, foreign data unreadable, resolver visible and NoNewPrivs set', async () => {
    expect(confinementProbe.available, confinementProbe.reason ?? 'bubblewrap probe failed').toBe(true);
    const { registry, projectPath, dataRoot } = await setup(['sandbox', 'terminal'], true);
    const foreign = temp('foreign');
    writeFileSync(join(foreign, 'secret.txt'), 'foreign-secret');
    writeFileSync(join(dataRoot, 'daemon-secret.txt'), 'private-daemon-bytes');
    const command = `echo own > own.txt; cat '${join(foreign, 'secret.txt')}'; cat '${join(dataRoot, 'daemon-secret.txt')}'; head -c 0 /etc/resolv.conf && echo DNS_OK; grep NoNewPrivs /proc/self/status`;
    const result = await runAs(registry, projectPath, 1, 'brain-confined', 'Bash', { command });
    expect(result.content[0]!.text).toContain('DNS_OK');
    expect(result.content[0]!.text).toContain('NoNewPrivs:\t1');
    expect(result.content[0]!.text).not.toContain('foreign-secret');
    expect(result.content[0]!.text).not.toContain('private-daemon-bytes');
    expect(readFileSync(join(projectPath, 'own.txt'), 'utf8')).toBe('own\n');
  });
});
