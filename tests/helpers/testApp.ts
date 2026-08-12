import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { projectHead, projectRangeDiff } from '../../src/integrations/projectFiles.js';
import { render, setPluginPromptSources } from '../../src/prompts/index.js';
import { setPluginPromptCatalog } from '../../src/prompts/catalog.js';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { TaskUsageStore } from '../../plugins/work/src/store/taskUsageStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { EventBus } from '../../src/api/sse.js';
import { PlanJobStore } from '../../src/api/planJobStore.js';
import { FakeInference } from '../../src/inference/client.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { FakeClock } from '../../src/shared/clock.js';
import { createServer } from '../../src/api/server.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import type { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import type { PlanJob } from '../../src/api/planJobStore.js';
import type { PluginHostAdvisor, PluginHostConfig, PluginHostTerminals } from '../../src/plugins/api.js';

/** The host seam wiring the agents plugin needs to load in tests — brainCore's shape with fakes for
 *  tmux/inference/push. Shared by agentsPluginProvider below and by tests that load EVERY bundled
 *  plugin (toolNaming) and only need the agents plugin to get past register(). */
export function agentsTestHost(w: {
  db: ReturnType<typeof openDb>;
  tasks: TaskStore;
  readiness: Readiness;
  config: ConfigStore;
  projects: ProjectStore;
  users?: UserStore;
  tmux?: FakeTmuxDriver;
  terminals?: PluginHostTerminals;
  /** Override the advisor collaborators seam (default: a real one over `users`, tmp working dirs). */
  advisorHost?: PluginHostAdvisor;
  prompts?: { render(name: string, vars?: Record<string, string>, userId?: number): string; rawTemplate(name: string): string };
}) {
  return {
    tmux: w.tmux ?? new FakeTmuxDriver(),
    brainWorker: () => undefined,
    elowenCli: { cli: 'elowen', cliArgv: ['elowen'], url: 'http://localhost:0', token: 't', tokenForTask: () => undefined },
    stores: {
      tasks: w.tasks,
      projects: w.projects,
      homeProject: () => w.projects.list()[0] ?? { id: 1, slug: 'elowen', path: '/o', notes: '', icon: '', pr_enabled: null },
      usersRead: {
        list: () => (w.users?.list() ?? []).map((u) => ({ id: u.id, username: u.username, isAdmin: u.is_admin })),
        isAdmin: (id: number) => w.users?.isAdmin(id) ?? true,
        allowedExecs: (id: number) => w.users?.list().find((u) => u.id === id)?.allowed_execs ?? null,
      },
      readiness: w.readiness,
      taskUsage: new TaskUsageStore(w.db),
    },
    prompts: w.prompts ?? { render: (n: string, v?: Record<string, string>) => render(n, v), rawTemplate: () => '' },
    config: w.config as unknown as PluginHostConfig,
    relayClient: () => ({ decide: async () => ({ text: '' }) }) as never,
    git: { projectHead, projectRangeDiff } as never,
    push: () => ({ sendToUsers: async () => {} }),
    terminals: () => w.terminals ?? {
      chatTerminalStop: async () => {},
      brainWorkerLive: () => false,
      brainWorkerAbort: async () => {},
      ticketIssue: () => 'test-ticket',
    },
    advisor: () => w.advisorHost ?? (w.users ? advisorHostFor(w.users) : undefined),
  };
}

/** A real PluginHostAdvisor over a test UserStore — the same shape bootstrap wires in the daemon,
 *  with a tmp working dir and fixed personality/brand. Shared by the plugin-served /advisor route
 *  tests and the AdvisorService unit tests. */
export function advisorHostFor(users: UserStore): PluginHostAdvisor {
  return {
    users: {
      get: (id) => {
        const u = users.get(id);
        return u ? { name: u.name, username: u.username, isAdmin: u.is_admin, allowedExecs: u.allowed_execs, advisorExec: u.advisor_exec ?? '', advisorAutostart: u.advisor_autostart ?? false } : null;
      },
      setExec: (id, exec) => { users.setAdvisorExec(id, exec); },
      setAutostart: (id, on) => { users.setAdvisorAutostart(id, on); },
      ensureToken: (id) => users.ensureAdvisorToken(id),
    },
    dir: (id) => { const p = join(tmpdir(), 'elowen-test-advisor', String(id)); mkdirSync(p, { recursive: true }); return p; },
    personality: () => 'Test personality paragraph.',
    brand: () => ({ agentName: 'Elowen', productName: 'Elowen' }),
  };
}

/** Build a PluginRegistryProvider that loads the REAL agents plugin (its dist build) over the given
 *  stores — the host wiring shape brainCore builds, with test fakes for tmux/inference/push. Local
 *  createServer tests pass the result as `plugins` so the root-mounted '/missions' (…) surfaces serve;
 *  loading is lazy (first dispatched request). */
export function agentsPluginProvider(w: {
  db: ReturnType<typeof openDb>;
  tasks: TaskStore;
  readiness: Readiness;
  config: ConfigStore;
  projects: ProjectStore;
  users?: UserStore;
  bus?: EventBus;
  tmux?: FakeTmuxDriver;
  /** Core terminal controls (chat teardown, brain workers, ws tickets). Tests exercising those
   *  paths pass their real services here; the default is a no-op fake. */
  terminals?: PluginHostTerminals;
  /** Override the advisor collaborators seam (default: a real one over `users`). */
  advisorHost?: PluginHostAdvisor;
  /** Override the prompt seam (default: the core file renderer, no per-user overrides). */
  prompts?: { render(name: string, vars?: Record<string, string>, userId?: number): string; rawTemplate(name: string): string };
}): PluginRegistryProvider {
  const bus = w.bus ?? new EventBus();
  return new PluginRegistryProvider(() => loadPlugins({
    dirs: [join(process.cwd(), 'plugins')],
    enabled: ['agents', 'work'],
    delegatedTurnsOutOfProcess: () => false,
    pluginDb: (plugin) => makePluginDb(w.db, plugin, { canMigrate: true }),
    publishEvent: (e) => bus.publish(e),
    subscribeEvents: (fn) => bus.subscribe(fn),
    host: agentsTestHost(w),
    logger: { info() {}, warn() {}, error() {} },
  }).then((registry) => {
    // Mirror brainCore's post-load snapshot: the plugin owns the agents templates now, so the core
    // renderer needs the source overlay before the first worker/guide render.
    setPluginPromptCatalog(registry.promptEntries.map((p) => p.entry));
    setPluginPromptSources(new Map([...registry.promptSources].map(([n, s]) => [n, s.file])));
    return registry;
  }));
}

export interface TestAppOpts {
  /** Raw LLM output the relay path returns from `decompose` (a JSON array of phases). */
  fakePlan?: string;
  /** Autopilot API key; set non-empty to enable the relay planning path. */
  apiKey?: string;
  /** Stub a mission's isolated worktree dir (mirrors MissionGit.worktreeFor) so launch-path tests can
   *  assert that a mission phase runs in its worktree rather than the shared project checkout. */
  worktreeFor?: (missionId: string) => string | null | undefined;
  /** Extra ServerDeps spread over the defaults — for routes whose collaborators (themes, brain stubs…)
   *  the standard wiring does not construct. */
  extra?: Partial<Parameters<typeof createServer>[0]>;
}

/** Wire a real in-memory daemon app with a bootstrapped admin token, composed EXACTLY like the daemon:
 *  the REAL agents plugin is loaded from disk (its dist build) over the shared in-memory DB, and the
 *  server reaches the subsystem through the loaded registry's 'agents' control — the same instances the
 *  plugin's root-mounted routes use. Exposes the live stores/queues so tests can arrange state and
 *  assert side effects. */
export async function makeTestApp(opts: TestAppOpts = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db);
  const readiness = new Readiness(db);
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const users = new UserStore(db);
  users.create('admin', 'pw');
  const token = users.issueToken(users.list()[0]!.id);
  if (typeof opts.apiKey === 'string' && opts.apiKey) config.update({ autopilot: { apiKey: opts.apiKey } });

  const tmux = new FakeTmuxDriver();
  const bus = new EventBus();

  // The REAL agents plugin over this app's stores. One provider per app: each test gets its own
  // runtime generation over its own :memory: DB.
  const provider = agentsPluginProvider({ db, tasks, readiness, config, projects, users, bus, tmux });
  const registry = await provider.get();
  const control = registry.control('agents');
  if (!control) throw new Error('agents plugin failed to load in makeTestApp');

  // The ONE subsystem instance set — server deps and the plugin's root-mounted routes share it, exactly
  // like the daemon's live control getters.
  const missions = control.missions() as MissionStore;
  // Launch-path tests stub the mission worktree resolution — the plugin's manual-launch handler calls
  // the runtime's REAL MissionGit, so patch that exact instance (own-property assignment over the
  // class method), keeping the core-facing deps.missionGit override below in sync.
  if (opts.worktreeFor) (control.missionGit() as { worktreeFor: (id: string) => string | null | undefined }).worktreeFor = opts.worktreeFor;
  const engine = control.engine();
  const spawn = control.spawn();
  const decisionQueue = control.decisionQueue();
  const planJobs = control.planJobs() as PlanJobStore;
  // No-op pilot backend: whenever the REAL flow would pick the agent backend, park the job instead —
  // it stays 'planning' until a test calls /plan/:id/submit. Every other planFlow decision is real.
  const realPlanFlow = control.planFlow();
  const planFlow: typeof realPlanFlow = {
    ...realPlanFlow,
    pilotBackend: (exec) => realPlanFlow.pilotBackend(exec) ? async (_job: PlanJob, _projectPath: string) => { /* parked */ } : null,
  };

  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), readiness, missions, engine, tmux, bus,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects,
    planJobs, planFlow,
    // Mirror bootstrap: the close path drives the plugin's review gate through the control.
    onTaskClosed: control.onTaskClosed,
    gitLock: control.gitLock(),
    missionGit: control.missionGit(),
    plugins: provider,
    // Mirror bootstrap: login autostart/user-deletion advisor hooks resolve through the control.
    advisor: control.advisor(),
    // Mirror bootstrap: the SSE gate consults the plugin-registered event resolvers (signal/plan tenancy).
    eventProjectResolvers: () => registry.eventProjectResolvers.map((r) => r.fn),
    ...(opts.worktreeFor ? { missionGit: { worktreeFor: opts.worktreeFor } as never } : {}),
    makeInference: () => new FakeInference(opts.fakePlan ?? '[{"title":"Phase A","type":"task"}]'),
    ...(opts.extra ?? {}),
  });

  /** Seed an epic + one in-progress child phase + an active mission `m-<epic>`. */
  const seedMissionWithChild = () => {
    const epic = tasks.create({ id: 'elowen-ep', project_id: 1, title: 'Epic', type: 'epic', description: 'epic' });
    const child = tasks.create({ id: 'elowen-c1', project_id: 1, title: 'Child phase', type: 'task', parent_id: epic.id, description: 'child' });
    tasks.setStatus(child.id, 'in_progress');
    const mission = missions.create({ id: `m-${epic.id}`, epic_id: epic.id, autonomy: 'L3', max_sessions: 1 });
    return { missionId: mission.id, epicId: epic.id, childId: child.id };
  };

  /** Seed an epic with two chained phases (P1 in_progress, P2 open depends on P1) + active mission.
   *  `autonomy` defaults to L3 so the existing self-heal/review tests get full autonomy; pass L1/L2
   *  to exercise the human-in-the-loop branch (no auto self-heal). */
  const seedMissionWithChain = (autonomy = 'L3') => {
    const epic = tasks.create({ id: 'elowen-ep2', project_id: 1, title: 'Epic2', type: 'epic', description: 'epic' });
    const p1 = tasks.create({ id: 'elowen-p1', project_id: 1, title: 'Phase 1', type: 'task', parent_id: epic.id, description: 'p1' });
    const p2 = tasks.create({ id: 'elowen-p2', project_id: 1, title: 'Phase 2', type: 'task', parent_id: epic.id, description: 'p2' });
    tasks.addDep(p2.id, p1.id);
    tasks.setStatus(p1.id, 'in_progress');
    const mission = missions.create({ id: `m-${epic.id}`, epic_id: epic.id, autonomy, max_sessions: 1 });
    return { missionId: mission.id, epicId: epic.id, childId: p1.id, nextId: p2.id };
  };

  return { app, token, control, db, deps: { tasks, readiness, missions, config, users, planJobs, decisionQueue, bus, tmux, engine, spawn, seedMissionWithChild, seedMissionWithChain } };
}
