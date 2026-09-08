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
import { ENVIRONMENT_CONTROL_METHODS } from '../../src/plugins/environmentTypes.js';
import type { SandboxControl } from '../../src/plugins/api.js';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
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
    ...Object.fromEntries(ENVIRONMENT_CONTROL_METHODS.map(name => [name, () => { throw new Error(`unexpected ${name}`); }])),
    workspaceRoots: () => [], resolveWorkspace() {}, acquireDelegationLease() {}, workspacesFor: () => [], activeWorkspace: () => null,
    prepareExecution() { throw new Error('unexpected execution'); }, projectFiles,
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
  return { app, project, member, projectFiles, prepareExecution, patch, registry, outsiderToken };
}

describe('managed project API consumers', () => {
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
});
