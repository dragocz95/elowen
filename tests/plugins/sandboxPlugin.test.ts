import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { openDb } from '../../src/store/db.js';
import { RealGitReader } from '../../src/git/gitReader.js';
import { realPathWithin } from '../../src/plugins/pathGuard.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import { processRegistry } from '../../src/brain/processRegistry.js';
import { bubblewrapProbe, migrateLegacyHomes } from '../../plugins/sandbox/lib/execution.mjs';
import { processIdentity, reconcileStaleLeases, withRepoLease } from '../../plugins/sandbox/lib/db.mjs';
import { createWorkspacePathView } from '../../src/plugins/pathView.js';

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

function createRepository(): string {
  const root = temp('repo');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Sandbox Test');
  git(root, 'config', 'user.email', 'sandbox@example.test');
  writeFileSync(join(root, 'README.txt'), 'base\n');
  git(root, 'add', 'README.txt');
  git(root, 'commit', '-m', 'initial');
  return root;
}

async function setup(enabled = ['sandbox'], confineNonOperators = false) {
  const projectPath = createRepository();
  const dataRoot = temp('data');
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (1, 'amy', 'x', 0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (2, 'bob', 'x', 0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (3, 'admin', 'x', 1)").run();
  db.prepare('INSERT INTO projects (id, slug, path, notes) VALUES (1, ?, ?, ?)').run('demo', projectPath, '');
  const project = { id: 1, slug: 'demo', path: projectPath, notes: '', icon: '' };
  const users = new Set([1, 2, 3]);
  const reader = new RealGitReader();
  const host = {
    stores: {
      projects: { get: (id: number) => id === 1 ? project : null, list: () => [project] },
      homeProject: () => project,
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
  return { registry, db, dataRoot, projectPath, users };
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

function pluginRequest(method: string, query: Record<string, string>, value: unknown = {}) {
  const raw = Buffer.from(JSON.stringify(value));
  return {
    method, path: '', query, headers: {}, params: {},
    body: async () => raw,
    json: async <T>() => value as T,
    auth: { userId: 3, admin: true, tokenScope: 'user' as const, accessibleProjects: null },
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
  it('creates, binds and exposes a workspace root only for currently accessible Projects', async () => {
    const { registry, projectPath } = await setup();
    const created = await runAs(registry, projectPath, 1, 'brain-amy', 'SandboxCreateWorkspace', { projectId: 1, label: 'Feature Alpha', baseRef: 'main' });
    const workspace = created.details.workspace;
    expect(workspace.branch).toMatch(/^elowen\/u1\/feature-alpha-/);
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

describe('sandbox durable repository locks', () => {
  it('does not reclaim an expired lease while its exact process owner is still alive', async () => {
    const { db } = await setup();
    const identity = processIdentity();
    expect(identity).toBeTruthy();
    db.prepare(`INSERT INTO p_sandbox_execution_leases
      (id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('live',1,NULL,1,?,?, 'terminal',0,0)`).run(process.pid, identity);
    db.prepare(`INSERT INTO p_sandbox_repo_leases
      (common_dir,owner_id,outer_pid,runner_identity,heartbeat_at,expires_at)
      VALUES ('/repo/live','owner',?,?,0,0)`).run(process.pid, identity);
    expect(reconcileStaleLeases(db, Date.now())).toEqual({ executionRemoved: 0, reposRemoved: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_execution_leases WHERE id='live'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_repo_leases WHERE common_dir='/repo/live'").get()).toEqual({ n: 1 });
  });

  it('reclaims a reused PID only when the stored process identity is provably different', async () => {
    const { db } = await setup();
    db.prepare(`INSERT INTO p_sandbox_execution_leases
      (id,user_id,workspace_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('reused',1,NULL,1,?,'linux:different-boot:1','terminal',0,0)`).run(process.pid);
    expect(reconcileStaleLeases(db, Date.now()).executionRemoved).toBe(1);
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
      'SandboxListWorkspaces', 'SandboxCreateWorkspace', 'SandboxUseWorkspace', 'SandboxCommit', 'SandboxRemoveWorkspace',
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
