import { openDb, type Db } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { EventBus } from '../../src/api/sse.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { FakeClock } from '../../src/shared/clock.js';
import { FakeInference } from '../../src/inference/client.js';
import { createServer } from '../../src/api/server.js';
import { render } from '../../src/prompts/index.js';
import {
  projectHead, projectRangeDiff, projectRangeLog, projectRangeFileDiff, projectCommitFileDiff, safeProjectPath,
} from '../../src/integrations/projectFiles.js';

export interface TestAppOpts {
  /** Register a `userProjects` store so the coarse tenancy gate is live (default: absent = ungated). */
  userProjects?: boolean;
  /** Extra ServerDeps spread over the defaults — for routes whose collaborators the standard wiring does not construct. */
  extra?: Partial<Parameters<typeof createServer>[0]>;
}

/** Wire an in-memory daemon app with a bootstrapped admin token and no optional domain plugins. */
export async function makeTestApp(opts: TestAppOpts = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const users = new UserStore(db);
  users.create('admin', 'pw');
  const token = users.issueToken(users.list()[0]!.id);
  const tmux = new FakeTmuxDriver();
  const bus = new EventBus();

  const app = createServer({
    tmux, bus,
    project: { id: 1, path: '/o' },
    clock: new FakeClock(0), config, users, projects,
    ...(opts.userProjects ? { userProjects: new UserProjectStore(db) } : {}),
    ...(opts.extra ?? {}),
  });

  return { app, token, db, deps: { config, users, projects, bus, tmux } };
}

/** Complete generic plugin-host wiring for tests that load plugin manifests. */
export function pluginTestHost(w: { db: Db; config?: ConfigStore; projects?: ProjectStore; tmux?: FakeTmuxDriver }) {
  const projects = w.projects ?? new ProjectStore(w.db);
  return {
    tmux: w.tmux ?? new FakeTmuxDriver(),
    elowenCli: {
      cli: 'elowen', cliArgv: ['elowen'], url: 'http://localhost:0',
      tokenForUser: () => undefined,
    },
    stores: {
      projects,
      homeProject: () => projects.list()[0] ?? { id: 1, slug: 'elowen', path: '/o', notes: '', icon: '' },
      usersRead: { list: () => [], isAdmin: () => true, allowedExecs: () => null, mayUsePlugin: () => true },
    },
    externalUsers: {
      resolve: () => null,
      describe: () => null,
      linkOrProvision: () => { throw new Error('not wired in tests'); },
      linkExisting: () => { throw new Error('not wired in tests'); },
    },
    prompts: {
      render: (name: string, vars?: Record<string, string>) => render(name, vars),
      rawTemplate: () => '',
      userOverride: () => null,
    },
    relayClient: () => new FakeInference('[]'),
    git: {
      projectSnapshot: async () => ({ isRepo: false, status: null, remotes: [] }),
      projectHead, projectRangeDiff, projectRangeLog, projectRangeFileDiff, projectCommitFileDiff,
    },
    push: () => ({ sendToUsers: async () => {} }),
    subagentCatalog: { list: () => [], save: async () => ({ ok: true as const }), remove: () => ({ ok: true as const }) },
    projectFiles: { safe: safeProjectPath },
  };
}
