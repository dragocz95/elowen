import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { EventBus } from '../../src/api/sse.js';
import { FakeClock } from '../../src/shared/clock.js';
import { createServer } from '../../src/api/server.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { ENVIRONMENT_CONTROL_METHODS, SITE_ENVIRONMENT_CONTROL_METHODS } from '../../src/plugins/environmentTypes.js';
import type { SandboxControl } from '../../src/plugins/api.js';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup(environmentState: 'running' | 'stopped' | 'unprovisioned' = 'running') {
  const db = openDb(':memory:'); databases.push(db);
  const users = new UserStore(db); const projects = new ProjectStore(db); const userProjects = new UserProjectStore(db);
  const home = projects.create({ slug: 'host', path: '/host' });
  users.create('admin', 'test-password');
  const member = users.create('member', 'test-password');
  const outsider = users.create('outsider', 'test-password');
  const token = users.issueToken(member.id); const outsiderToken = users.issueToken(outsider.id);
  const project = projects.ensureDefault(member.id);
  const registry = new PluginRegistry();
  const projectFiles = vi.fn<SandboxControl['projectFiles']>(async ({ operation }) => {
    if (operation.kind !== 'stat') throw new Error('unexpected operation');
    return { kind: 'stat', entry: { kind: 'file', path: operation.path, size: 3, modifiedAt: '2026-01-01', version: 'v1' } };
  });
  registry.controls.set('sandbox', {
    ...Object.fromEntries([...ENVIRONMENT_CONTROL_METHODS, ...SITE_ENVIRONMENT_CONTROL_METHODS]
      .map(name => [name, () => { throw new Error(`unexpected ${name}`); }])),
    workspaceRoots: () => [], resolveWorkspace() {}, acquireDelegationLease() {}, workspacesFor: () => [], activeWorkspace: () => null,
    prepareExecution() { throw new Error('unexpected execution'); }, projectFiles,
    // A cheap state read that provisions nothing — what a Git inspection consults before it decides
    // whether entering the environment is even possible.
    environmentFor: async () => ({ projectId: 1, generation: 1, state: environmentState, desiredState: 'running', lastError: null, limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512, diskSoftMb: 10240 } }),
  } as never);
  registry.controlOwner.set('sandbox', 'sandbox');
  const prepareExecution = vi.fn<SandboxControl['prepareExecution']>(async (input) => ({
    mode: 'managed', projectRef: input.projectRef, cwd: '/tmp', displayCwd: '/workspace', home: '/root', roots: ['/'], workspace: null,
    launch: { type: 'argv', file: process.execPath, args: ['-e', 'process.stdout.write("/workspace/assets/logo.png\\0")'], env: {} },
    stdin: undefined, cancel: async () => {},
    lease: { id: 'icon-test', accountUserId: member.id, workspaceId: null, homeGeneration: null, heartbeat() {}, release() {} },
    sanitizeOutput: text => text,
  }));
  (registry.controls.get('sandbox') as SandboxControl).prepareExecution = prepareExecution;
  const app = createServer({ bus: new EventBus(), engine: null as never, spawn: null as never, tmux: null as never,
    project: home, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects, userProjects, plugins: new PluginRegistryProvider(async () => registry) });
  const patch = (icon: string, auth = token) => app.request(`/projects/${project.id}`, {
    method: 'PATCH', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify({ icon }),
  });
  return { app, project, member, token, projectFiles, prepareExecution, patch, registry, outsider, outsiderToken, users, userProjects };
}

describe('managed project API consumers', () => {
  // A member shares every file and stored credential in this environment with the others, and used to
  // be told only their account numbers. The projection answers who they are — and stops there: it is
  // built from the project's own membership, never from the instance directory.
  it('serves managed project members the identity of their co-members and nothing wider', async () => {
    const { app, project, member, token, users, userProjects, outsider, outsiderToken } = setup();
    users.setProfile(member.id, { name: 'Member One', email: 'member@example.test' });
    const read = (auth: string, query = '') => app.request(`/projects/${project.id}/users${query}`, { headers: { authorization: `Bearer ${auth}` } });

    // The DEFAULT answer is the account-id list every existing client was written against; the profile
    // view is an opt-in that must never become what an unaware caller receives.
    const ids = await read(token);
    expect(ids.status).toBe(200);
    expect(await ids.json()).toEqual([member.id]);
    expect(await (await read(token, '?view=ids')).json()).toEqual([member.id]);

    const profiles = await read(token, '?view=profiles');
    expect(profiles.status).toBe(200);
    expect(await profiles.json()).toEqual([{ id: member.id, username: 'member', name: 'Member One', email: 'member@example.test', avatar: '' }]);

    // The option chooses a shape, never an audience: the profile view answers the same membership
    // authority, so a non-member is refused exactly as they are on the default view.
    expect((await read(outsiderToken)).status).toBe(403);
    expect((await read(outsiderToken, '?view=profiles')).status).toBe(403);

    // And it is not a directory: a member reads their co-members here and still cannot list the instance.
    expect((await app.request('/users', { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);

    // Revoked membership loses both views immediately.
    userProjects.assign(outsider.id, project.id);
    expect(((await (await read(token, '?view=profiles')).json()) as { id: number }[]).map((row) => row.id))
      .toEqual([member.id, outsider.id]);
    expect((await read(outsiderToken, '?view=profiles')).status).toBe(200);
    userProjects.unassign(outsider.id, project.id);
    expect((await read(outsiderToken, '?view=profiles')).status).toBe(403);
    expect(await (await read(token)).json()).toEqual([member.id]);
  });

  it('validates project icons through guest metadata under the current member identity', async () => {
    const { patch, projectFiles, project, member } = setup();
    const response = await patch('assets/logo.png');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ icon: 'assets/logo.png' });
    expect(projectFiles).toHaveBeenCalledWith({ project: { kind: 'managed', projectId: project.id }, accountUserId: member.id,
      operation: { kind: 'stat', path: '/workspace/assets/logo.png' } });
  });

  it('refuses lexical and canonical guest escapes and does not contact a provider for outsiders', async () => {
    const { patch, projectFiles, outsiderToken } = setup();
    expect((await patch('../../etc/logo.png')).status).toBe(400);
    expect((await patch('assets/script.ts')).status).toBe(400);
    expect((await patch('assets/logo.png', outsiderToken)).status).toBe(403);
    expect(projectFiles).not.toHaveBeenCalled();
    projectFiles.mockResolvedValueOnce({ kind: 'stat', entry: { path: '/etc/logo.png', kind: 'file', size: 3, modifiedAt: '2026-01-01', version: 'v1' } });
    expect((await patch('assets/logo.png')).status).toBe(400);
  });

  it('rejects an escaping parent symlink even when stat returns a lexical path', async () => {
    const { patch, prepareExecution, project } = setup();
    const prepared = await prepareExecution({ projectRef: { kind: 'managed', projectId: project.id }, command: { type: 'argv', file: 'realpath', args: [] }, cwd: '/workspace', leaseKind: 'files' });
    prepareExecution.mockResolvedValue({ ...prepared,
      launch: { type: 'argv', file: process.execPath, args: ['-e', 'process.stdout.write("/etc/logo.png\\0")'], env: {} } });
    expect((await patch('assets/logo.png')).status).toBe(400);
  });

  it('distinguishes an unavailable provider from invalid icons and allows clearing without provisioning', async () => {
    const { patch, registry, projectFiles } = setup();
    registry.controls.delete('sandbox');
    expect((await patch('assets/logo.png')).status).toBe(503);
    expect((await patch('')).status).toBe(200);
    expect(projectFiles).not.toHaveBeenCalled();
  });

  // The Overview reads this on open now, so it must never be the thing that starts a container. The
  // execution path provisions an environment that has none and waits for it; a state read costs nothing
  // and is the right answer for a project nobody is working in.
  it.each(['stopped', 'unprovisioned'] as const)('refuses a Git read on a %s environment without entering it', async (state) => {
    const { app, project, token, prepareExecution } = setup(state);
    const response = await app.request(`/projects/${project.id}/git`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'project environment is not running', state });
    expect(prepareExecution).not.toHaveBeenCalled();
  });

  it('reads managed project Git through the canonical provider and parses guest output', async () => {
    const { app, project, member, token, prepareExecution } = setup();
    prepareExecution.mockImplementation(async (input) => {
      if (input.command.type !== 'argv') throw new Error('unexpected shell command');
      return managedExecutionFixture(input, member.id);
    });
    const response = await app.request(`/projects/${project.id}/git`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      isRepo: true,
      status: { branch: 'main', head: '4f2c9ab12c', upstream: 'origin/main', ahead: 1, behind: 2, dirty: 1, untracked: 1, clean: false },
      remotes: [{ name: 'origin', fetchUrl: 'https://github.com/example/repo.git', pushUrl: 'git@github.com:example/repo.git' }],
      branches: [{ name: 'main', current: true }],
      commits: [{ hash: '4f2c9ab', subject: 'initial', author: 'Me', relative: '1 hour ago' }],
    });
    expect(JSON.stringify(body)).not.toContain('top-secret');
    // rev-parse → status + remotes (+2 get-url) → branches + commits.
    expect(prepareExecution).toHaveBeenCalledTimes(7);
    expect(prepareExecution.mock.calls[0]?.[0]).toEqual({
      projectRef: { kind: 'managed', projectId: project.id }, cwd: '/workspace', leaseKind: 'files',
      command: { type: 'argv', file: 'git', args: ['-c', 'core.fsmonitor=false', '-C', '/workspace', 'rev-parse', '--is-inside-work-tree'] },
    });
    expect(prepareExecution.mock.calls[0]?.[1]).toEqual({ accountUserId: member.id, roots: ['/workspace'] });
  });

  it('recovers a genuine git no-repo verdict (exit 128) as an empty repo and stops probing further commands', async () => {
    const { app, project, member, token, prepareExecution } = setup();
    prepareExecution.mockImplementation(async (input) => {
      if (input.command.type !== 'argv') throw new Error('unexpected shell command');
      return managedExecutionFixture(input, member.id, {
        revParse: 'process.stderr.write("fatal: not a git repository (or any of the parent directories): .git\\n");process.exit(128)',
      });
    });
    const response = await app.request(`/projects/${project.id}/git`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ isRepo: false, status: null, remotes: [], branches: [], commits: [] });
    expect(prepareExecution).toHaveBeenCalledTimes(1);
  });

  it('reports managed launcher exits 125, 126 and 127 as unavailable, never as an empty repo', async () => {
    for (const exit of [125, 126, 127]) {
      const { app, project, member, token, prepareExecution } = setup();
      prepareExecution.mockImplementation(async (input) => {
        if (input.command.type !== 'argv') throw new Error('unexpected shell command');
        return managedExecutionFixture(input, member.id, { every: `process.exit(${exit})` });
      });
      const response = await app.request(`/projects/${project.id}/git`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'project environment Git inspection unavailable' });
    }
  });

  it('never reports a provider failure as a successful empty repo', async () => {
    const { app, project, token, prepareExecution } = setup();
    prepareExecution.mockRejectedValue(new Error('provider revoked access'));
    const response = await app.request(`/projects/${project.id}/git`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'project environment Git inspection unavailable' });
  });

  it('returns 503 without contacting any provider when the sandbox control is missing', async () => {
    const { app, project, token, prepareExecution, registry } = setup();
    registry.controls.delete('sandbox');
    const response = await app.request(`/projects/${project.id}/git`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(503);
    expect(prepareExecution).not.toHaveBeenCalled();
  });

  it('does not contact a provider for outsiders or anonymous callers', async () => {
    const { app, project, prepareExecution, outsiderToken } = setup();
    const url = `/projects/${project.id}/git`;
    expect((await app.request(url, { headers: { authorization: `Bearer ${outsiderToken}` } })).status).toBe(403);
    expect((await app.request(url)).status).toBe(401);
    expect(prepareExecution).not.toHaveBeenCalled();
  });
});

/** Canned guest output per git subcommand; any unexpected command fails the request instead of faking data. */
const GIT_FIXTURE_OUTPUTS: Record<string, string> = {
  'rev-parse --is-inside-work-tree': 'true\n',
  'status --porcelain=v2 --branch': [
    '# branch.oid 4f2c9ab12c',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +1 -2',
    '1 M. N... 100644 100644 100644 111 222 tracked.txt',
    '? new.txt',
    '',
  ].join('\n'),
  remote: 'origin\n',
  'branch --format=%(HEAD)%09%(refname:short)': '*\tmain\n',
  'log -n 15 --pretty=format:%h%x09%s%x09%an%x09%cr': '4f2c9ab\tinitial\tMe\t1 hour ago\n',
};

function gitFixtureOutput(args: string[]): string {
  const mount = args.indexOf('-C');
  if (mount === -1) throw new Error(`unexpected managed git command without a work tree: ${args.join(' ')}`);
  const rest = args.slice(mount + 2);
  if (rest[0] === 'remote' && rest[1] === 'get-url') {
    return rest.includes('--push') ? 'git@github.com:example/repo.git\n' : 'https://oauth2:top-secret@github.com/example/repo.git\n';
  }
  const text = GIT_FIXTURE_OUTPUTS[rest.join(' ')];
  if (text === undefined) throw new Error(`unexpected managed git command: ${args.join(' ')}`);
  return text;
}

/** The canonical provider shape: every consumer-spawned process is a launch argv the mock really executes. */
function managedExecutionFixture(input: Parameters<SandboxControl['prepareExecution']>[0], accountUserId: number,
  scripts: { every?: string; revParse?: string } = {}) {
  const args = input.command.type === 'argv' ? input.command.args : [];
  const subcommand = args[args.indexOf('-C') + 2] ?? '';
  const script = scripts.every
    ?? (scripts.revParse !== undefined && subcommand === 'rev-parse' ? scripts.revParse
      : `process.stdout.write(${JSON.stringify(gitFixtureOutput(args))})`);
  return {
    mode: 'managed' as const, projectRef: input.projectRef, cwd: '/tmp', displayCwd: '/workspace',
    home: '/root', roots: ['/workspace'], workspace: null,
    launch: { type: 'argv' as const, file: process.execPath, args: ['-e', script], env: {} },
    stdin: undefined, cancel: async () => {},
    lease: { id: 'git-test', accountUserId, workspaceId: null, homeGeneration: null, heartbeat() {}, release() {} },
    sanitizeOutput: (text: string) => text,
  };
}
