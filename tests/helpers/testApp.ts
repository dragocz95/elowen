import type { Db } from '../../src/store/db.js';
import { TaskRefs } from '../../src/store/taskRefs.js';
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
import type { PluginHostConfig } from '../../src/plugins/api.js';
import { openPluginTablesDb } from './pluginTablesDb.js';
import { RefMissions, RefReadiness, RefTaskStore, RefTaskUsage } from './refStores.js';

export interface TestAppOpts {
  /** Autopilot API key; set non-empty for routes whose behaviour depends on the relay being configured. */
  apiKey?: string;
  /** Register a `userProjects` store so the coarse tenancy gate is live (default: absent = ungated). */
  userProjects?: boolean;
  /** Extra ServerDeps spread over the defaults — for routes whose collaborators (themes, brain stubs,
   *  a plugin registry provider…) the standard wiring does not construct. */
  extra?: Partial<Parameters<typeof createServer>[0]>;
}

/** Wire an in-memory daemon app with a bootstrapped admin token — composed like the daemon MINUS its
 *  plugins. `work` and `agents` install from the plugin registry now, so a daemon test cannot load them:
 *  the task and mission domains are served by the reference contract implementations in refStores.ts,
 *  over a database carrying the frozen plugin DDL (tests/fixtures/pluginSchema.ts).
 *
 *  What this app therefore HAS: every daemon-owned route family, a task domain that really stores and
 *  really enforces its invariants, and mission rows for the tenancy and teardown paths to read. What it
 *  does NOT have: the plugins' own root-mounted surfaces (`/tasks`, `/missions`, `/sessions`, `/notes`,
 *  `/advisor`, `/plan/*`) and the mission engine behind them. A suite that needs one of those is testing
 *  a plugin, and lives in the plugin registry beside it — see the `agents-*` / `work-*` suites there.
 *
 *  Pass `extra.plugins` to give the app a registry provider (a fixture plugin, an intentionally empty
 *  one) when the SUBJECT is the daemon's plugin machinery rather than any particular plugin. */
export async function makeTestApp(opts: TestAppOpts = {}) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new RefTaskStore(db);
  const readiness = new RefReadiness(db);
  const taskUsage = new RefTaskUsage(db);
  const missions = new RefMissions(db);
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const users = new UserStore(db);
  users.create('admin', 'pw');
  const token = users.issueToken(users.list()[0]!.id);
  if (typeof opts.apiKey === 'string' && opts.apiKey) config.update({ autopilot: { apiKey: opts.apiKey } });

  const tmux = new FakeTmuxDriver();
  const bus = new EventBus();

  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), missions, tmux, bus, taskUsage,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects,
    ...(opts.userProjects ? { userProjects: new UserProjectStore(db) } : {}),
    ...(opts.extra ?? {}),
  });

  return { app, token, db, deps: { tasks, readiness, taskUsage, missions, config, users, projects, bus, tmux } };
}

/** The daemon's PLUGIN HOST seam, wired end to end with fakes — the shape `loadPlugins({ host })` hands
 *  every plugin at register() time.
 *
 *  It is deliberately generic: the contract is core's (src/plugins/api.ts), and a plugin that throws in
 *  register() because a seam it declared is missing gets SKIPPED with a logged error, silently
 *  contributing no tools, no routes and no migrations. A suite that loads real plugins off disk to audit
 *  them therefore needs the whole seam present, or it audits a shorter list than it thinks it does. The
 *  task-domain stores are the reference implementations (refStores.ts) over the frozen plugin DDL. */
export function pluginTestHost(w: { db: Db; config?: ConfigStore; projects?: ProjectStore; tmux?: FakeTmuxDriver }) {
  const config = w.config ?? new ConfigStore(w.db);
  const projects = w.projects ?? new ProjectStore(w.db);
  const tasks = new RefTaskStore(w.db);
  return {
    tmux: w.tmux ?? new FakeTmuxDriver(),
    brainWorker: () => undefined,
    elowenCli: {
      cli: 'elowen', cliArgv: ['elowen'], url: 'http://localhost:0', token: 't',
      tokenForTask: () => undefined, tokenForUser: () => undefined,
    },
    stores: {
      tasks,
      projects,
      homeProject: () => projects.list()[0] ?? { id: 1, slug: 'elowen', path: '/o', notes: '', icon: '', pr_enabled: null },
      usersRead: { list: () => [], isAdmin: () => true, allowedExecs: () => null },
      readiness: new RefReadiness(w.db),
      taskUsage: new RefTaskUsage(w.db),
      tasksAvailable: () => true,
    },
    prompts: {
      render: (n: string, v?: Record<string, string>) => render(n, v),
      rawTemplate: () => '',
      userOverride: () => null,
    },
    config: config as unknown as PluginHostConfig,
    relayClient: () => new FakeInference('[]'),
    git: { projectHead, projectRangeDiff, projectRangeLog, projectRangeFileDiff, projectCommitFileDiff },
    push: () => ({ sendToUsers: async () => {} }),
    projectFiles: { safe: safeProjectPath },
    terminals: () => ({
      chatTerminalStop: async () => {},
      brainWorkerLive: () => false,
      brainWorkerAbort: async () => {},
      ticketIssue: () => 'test-ticket',
    }),
    advisor: () => undefined,
  };
}
