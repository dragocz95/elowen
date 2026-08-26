import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { withRepoLease } from '../../plugins/sandbox/lib/db.mjs';

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
  db.prepare('INSERT INTO projects (id, slug, path, notes) VALUES (1, ?, ?, ?)').run('demo', projectPath, '');
  const project = { id: 1, slug: 'demo', path: projectPath, notes: '', icon: '' };
  const users = new Set([1, 2]);
  const reader = new RealGitReader();
  const host = {
    stores: {
      projects: { get: (id: number) => id === 1 ? project : null, list: () => [project] },
      homeProject: () => project,
      usersRead: {
        list: () => [...users].map((id) => ({ id, username: id === 1 ? 'amy' : 'bob', isAdmin: false })),
        isAdmin: () => false,
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
    expect(control.activeWorkspace({ accountUserId: 1, sessionId: 'brain-amy', projectId: 1 })?.path).toBe(workspace.path);
    expect(control.workspaceRoots({ accountUserId: 1, projectIds: [1] })).toEqual([{ workspaceId: workspace.id, projectId: 1, path: workspace.path }]);
    expect(control.workspaceRoots({ accountUserId: 1, projectIds: [] })).toEqual([]);
    expect(control.workspaceRoots({ accountUserId: 2, projectIds: [1] })).toEqual([]);
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
    expect(registry.control('sandbox')!.activeWorkspace({ accountUserId: 1, sessionId: 'brain-orphan', projectId: 1 })).toBeNull();
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
});

describe('sandbox execution HOME and leases', () => {
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

  it('fails closed without Sandbox for a non-operator and keeps the explicit operator fallback', async () => {
    const { registry, projectPath } = await setup(['terminal']);
    const refused = await runAs(registry, projectPath, 1, 'brain-no-sandbox', 'Bash', { command: 'echo no' });
    expect(refused.content[0]!.text).toMatch(/Sandbox plugin is disabled or failed to load/);
    const allowed = await runWithPolicy(adminPolicy, () => tool(registry, 'Bash').execute('t', { command: 'echo operator', cwd: projectPath }), { identity: operator(1), contributionUserId: 1, sessionId: 'brain-operator', workDir: projectPath });
    expect(allowed.content[0]!.text).toContain('operator');
  });
});

describe('sandbox durable repository locks', () => {
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
  });
});

describe.skipIf(!bubblewrapProbe().available)('sandbox Linux confinement integration', () => {
  it('keeps the own root writable, foreign data unreadable, resolver visible and NoNewPrivs set', async () => {
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
