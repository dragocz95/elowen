import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { openAgentsDb } from '../../helpers/agentsDb.js';
import { loadPlugins } from '../../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../../src/plugins/pluginsProvider.js';
import { createServer } from '../../../src/api/server.js';
import { ConfigStore } from '../../../src/store/configStore.js';
import { UserStore } from '../../../src/store/userStore.js';
import { TaskStore } from '../../../src/store/taskStore.js';
import { ProjectStore } from '../../../src/store/projectStore.js';
import { UserProjectStore } from '../../../src/store/userProjectStore.js';
import { MissionStore } from '../../../plugins/agents/src/store/missionStore.js';
import { Readiness } from '../../../src/store/readiness.js';
import { EventBus } from '../../../src/api/sse.js';
import { FakeClock } from '../../../src/shared/clock.js';
import { safeProjectPath } from '../../../src/integrations/projectFiles.js';
import type { PluginHostWiring } from '../../../src/plugins/registry.js';

const pluginsDir = join(process.cwd(), 'plugins');
const logger = { info() {}, warn() {}, error() {} };

function loadWith(enabled: string[], host?: PluginHostWiring) {
  return loadPlugins({ dirs: [pluginsDir], enabled, logger, host });
}

function serverWith(enabled: string[]) {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/tmp')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const projects = new ProjectStore(db);
  const host: PluginHostWiring = { stores: { projects } as never, projectFiles: { safe: safeProjectPath } };
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    tmux: null as never, project: { id: 1, path: '/tmp' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects, userProjects: new UserProjectStore(db),
    plugins: new PluginRegistryProvider(() => loadWith(enabled, host)), pluginDirs: [pluginsDir],
  });
  return { app, token: users.issueToken(admin.id) };
}

describe('editor plugin', () => {
  it('owns every grandfathered project-file root route and browser bundle when enabled', async () => {
    const host: PluginHostWiring = { stores: { projects: { get: () => null } } as never, projectFiles: { safe: safeProjectPath } };
    const registry = await loadWith(['editor'], host);
    expect([...registry.rootApiRoutes.keys()]).toEqual(expect.arrayContaining([
      '/projects/:id/files', '/projects/:id/file', '/projects/:id/raw', '/projects/:id/new-file', '/projects/:id/dir',
      '/projects/:id/rename', '/projects/:id/copy', '/projects/:id/entry', '/projects/:id/diff', '/projects/:id/head',
      '/projects/:id/commit/:hash', '/projects/:id/commit/:hash/diff', '/projects/:id/commits', '/projects/:id/changed', '/projects/:id/changes',
    ]));
    expect(registry.webUi.get('editor')?.nav).toEqual([{ label: 'Editor', icon: 'Code2', route: '' }]);
  });

  it('answers 503 rather than falling through when the editor is disabled', async () => {
    const { app, token } = serverWith([]);
    const response = await app.request('/projects/1/files', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'editor plugin is disabled' });
  });
});
