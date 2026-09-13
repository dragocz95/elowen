import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { openDb } from '../../src/store/db.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { RealGitReader } from '../../src/git/gitReader.js';
import { realPathWithin } from '../../src/plugins/pathGuard.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import { processRegistry } from '../../src/brain/processRegistry.js';
import { bubblewrapProbe, ensureUserHome, migrateLegacyHomes, resetUserHome, runPrepared } from '../../plugins/sandbox/lib/execution.mjs';
import { activeExecutionLeases, createExecutionLease, heartbeatRepoLease, processIdentity, reconcileStaleLeases, withRepoLease } from '../../plugins/sandbox/lib/db.mjs';
import { testConversationsRead } from '../helpers/testApp.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = { info() {}, warn() {}, error() {} };
const nonOperator = (userId: number): TurnIdentity => ({ platform: 'elowen', userId: String(userId), elowenUserId: userId, admin: false, owner: false, conversation: 'own' });
const operator = (userId: number): TurnIdentity => ({ platform: 'elowen', userId: String(userId), elowenUserId: userId, admin: true, owner: true, conversation: 'own' });
const policy = (projectPath: string): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => [projectPath] });
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

let roots: string[] = [];
const temp = (tag: string) => { const path = mkdtempSync(join(tmpdir(), `elowen-sandbox-${tag}-`)); roots.push(path); return path; };
// Awaited: the registry kill confirms the plugin's own teardown asynchronously, so a hook that returns
// first would let a still-dying process run into the next test.
afterEach(async () => { await processRegistry.killWhere(() => true); });
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
  const projects = [{ id: 1, slug: 'demo-1', path: projectPath, notes: '', icon: '' }];
  for (const entry of projects) db.prepare('INSERT INTO projects (id, slug, path, notes) VALUES (?, ?, ?, ?)').run(entry.id, entry.slug, entry.path, '');
  const userProjects = new UserProjectStore(db);
  for (const project of projects) {
    for (const userId of [1, 2]) userProjects.assign(userId, project.id);
  }
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
      conversationsRead: testConversationsRead({ isAdmin: (id: number) => id === 3 }),
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

  it('boot reconciliation removes account data left while the plugin was disabled', async () => {
    const { registry, dataRoot, users } = await setup();
    const dataDir = join(dataRoot, 'sandbox');
    const home = ensureUserHome(dataDir, 1);
    expect(existsSync(home.home)).toBe(true);
    users.delete(1);
    const reconcile = registry.bootReconciles.find((entry) => entry.plugin === 'sandbox');
    expect(reconcile).toBeTruthy();
    await reconcile!.fn();
    expect(existsSync(join(dataDir, 'users', '1'))).toBe(false);
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

    // The shared runner is the third route. Its caller — the account gitconfig route — hands the result
    // straight to an API response, so it sanitises there rather than trusting the caller to remember.
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
      (id,user_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('live',1,1,?,?, 'terminal',0,?)`).run(process.pid, identity, future);
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
      (id,user_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('expired',1,1,?,?,'terminal',?,?)`).run(process.pid, identity, past, past);
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
      (id,user_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('expired',1,1,?,?,'terminal',?,?)`).run(process.pid, identity, past, past);
    expect(activeExecutionLeases(db, { accountUserId: 1 })).toHaveLength(1);
  });

  it('renews an expired retained lease without losing active protection', async () => {
    const { db } = await setup();
    const lease = createExecutionLease(db, { accountUserId: 1, homeGeneration: 1, kind: 'terminal' });
    expect(activeExecutionLeases(db, { accountUserId: 1 })).toHaveLength(1);
    // A missed heartbeat does not prove that the guarded execution stopped.
    db.prepare('UPDATE p_sandbox_execution_leases SET expires_at = ? WHERE id = ?').run(Date.now() - 1, lease.id);
    expect(reconcileStaleLeases(db)).toEqual({ executionRemoved: 0, reposRemoved: 0 });
    await lease.heartbeat();
    expect(activeExecutionLeases(db, { accountUserId: 1 })).toHaveLength(1);
    expect(reconcileStaleLeases(db)).toEqual({ executionRemoved: 0, reposRemoved: 0 });
    await lease.release();
    expect(activeExecutionLeases(db, { accountUserId: 1 })).toHaveLength(0);
  });

  it('restores a missing execution lease without reviving it after explicit release', async () => {
    const { db } = await setup();
    const lease = createExecutionLease(db, { accountUserId: 1, homeGeneration: 1, kind: 'terminal' });
    db.prepare('DELETE FROM p_sandbox_execution_leases WHERE id = ?').run(lease.id);
    expect(activeExecutionLeases(db, { accountUserId: 1 })).toEqual([]);

    await lease.heartbeat();
    const active = activeExecutionLeases(db, { accountUserId: 1 });
    expect(active.map((row) => row.id)).toEqual([lease.id]);
    expect(active[0]).toMatchObject({ user_id: 1, kind: 'terminal', outer_pid: process.pid });
    // The resurrected row is the same lease: releasing it clears it, and a late heartbeat brings nothing back.
    await lease.release();
    expect(activeExecutionLeases(db, { accountUserId: 1 })).toEqual([]);
    await lease.heartbeat();
    expect(activeExecutionLeases(db, { accountUserId: 1 })).toEqual([]);
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
      (id,user_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('reused',1,1,?,'linux:different-boot:1','terminal',0,?)`).run(process.pid, Date.now() + 60_000);
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
        (id,user_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
        VALUES ('child',1,1,?,?,'terminal',0,0)`).run(pid, identity);
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
        (id,user_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
        VALUES ('dead',1,1,?,?,'terminal',0,?)`).run(pid, identity, future);
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
      (id,user_id,home_generation,outer_pid,runner_identity,kind,heartbeat_at,expires_at)
      VALUES ('unknown',1,1,?,'unverifiable:test','terminal',0,0)`).run(pid);
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

  it('blocks a HOME reset under a live child then releases on actual exit', async () => {
    const { registry, db, projectPath, dataRoot } = await setup();
    const session = 'brain-child-lease';
    const dataDir = join(dataRoot, 'sandbox');
    const home = ensureUserHome(dataDir, 1);
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP fixture did not bind');
    let socket: Socket | undefined;
    try {
      const prepared = await runWithPolicy(policy(projectPath), () => registry.control('sandbox')!.prepareExecution({
        command: { type: 'argv', file: process.execPath, args: ['-e', `
          const socket = require('node:net').connect(${address.port}, '127.0.0.1');
          const deadline = setTimeout(() => process.exit(2), 20_000);
          socket.on('end', () => { clearTimeout(deadline); process.stdout.write('child-exited'); });
        `] },
        cwd: projectPath, leaseKind: 'github',
      }), { identity: nonOperator(1), contributionUserId: 1, sessionId: session, workDir: projectPath });
      const connected = once(server, 'connection', { signal: AbortSignal.timeout(5_000) });
      const running = runPrepared(prepared);
      // Observe rejection immediately even if the connection fails before the command can report it.
      void running.catch(() => {});
      try {
        [socket] = await connected as [Socket];
        db.prepare('UPDATE p_sandbox_execution_leases SET expires_at=0 WHERE id=?').run(prepared.lease.id);
        expect.soft(activeExecutionLeases(db, { accountUserId: 1 })).toHaveLength(1);
        expect.soft(() => resetUserHome({ db, dataDir, userId: 1, expectedGeneration: home.generation })).toThrow(/HOME is in use/);
      } finally {
        socket?.end();
        expect((await running).output).toBe('child-exited');
      }
      expect(processIdentity()).toBeTruthy();
      expect(activeExecutionLeases(db, { accountUserId: 1 })).toEqual([]);
      // The guard is the live lease, not a permanent lock: once the child is gone the reset goes through.
      expect(resetUserHome({ db, dataDir, userId: 1, expectedGeneration: home.generation }))
        .toEqual({ generation: home.generation + 1 });
    } finally {
      socket?.destroy();
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  }, 30_000);

  it.each(['runner_identity', 'outer_pid'] as const)('execution heartbeat and release preserve a successor with changed %s', async (column) => {
    const { db } = await setup();
    const lease = createExecutionLease(db, { accountUserId: 1, homeGeneration: 1, kind: 'terminal' });
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
      'EnvironmentStatus', 'EnvironmentStart', 'EnvironmentStop', 'EnvironmentSnapshot', 'EnvironmentRestore', 'EnvironmentLogs', 'EnvironmentOperation', 'EnvironmentWorktrees',
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

/** The REGISTRATION half of the workspace retirement. A manifest can say one thing while the plugin
 *  registers another, so the loaded registry is asked what it actually exposes; the manifest's own
 *  declaration is covered in `sandboxWorkspaceRetirement.test.ts`. */
describe('sandbox workspace retirement at the registration level', () => {
  it('registers no workspace tool, command or route and keeps the whole environment surface', async () => {
    const { registry } = await setup();
    const toolNames = registry.tools.map((entry) => entry.name);
    expect(toolNames.filter((name) => name.startsWith('Sandbox'))).toEqual([]);
    for (const name of [
      'EnvironmentStatus', 'EnvironmentStart', 'EnvironmentStop', 'EnvironmentSnapshot',
      'EnvironmentRestore', 'EnvironmentLogs', 'EnvironmentOperation', 'EnvironmentWorktrees',
    ]) expect(toolNames).toContain(name);

    expect(registry.commands.has('sandbox')).toBe(false);
    expect(registry.commandOwner.has('sandbox')).toBe(false);

    // The map is keyed `${plugin}/${full path}`, so the sandbox entries are exactly the mounts this plugin
    // registered: no `overview`, and nothing under the retired `workspaces/` family.
    const routes = [...registry.apiRoutes.keys()]
      .filter((key) => key.startsWith('sandbox/'))
      .map((key) => key.slice('sandbox/'.length));
    expect(routes).not.toContain('overview');
    expect(routes.filter((path) => path.startsWith('workspaces/'))).toEqual([]);
    expect(registry.apiRoute('sandbox', 'workspaces/release', 'POST')).toBeUndefined();
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
