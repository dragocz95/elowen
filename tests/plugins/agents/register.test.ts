import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { openPluginTablesDb } from '../../helpers/pluginTablesDb.js';
import { makePluginDb } from '../../../src/store/pluginDb.js';
import { TaskRefs } from '../../../src/store/taskRefs.js';
import { TaskStore } from '../../../plugins/work/src/store/taskStore.js';
import { ProjectStore } from '../../../src/store/projectStore.js';
import { Readiness } from '../../../plugins/work/src/store/readiness.js';
import { TaskUsageStore } from '../../../plugins/work/src/store/taskUsageStore.js';
import { FakeTmuxDriver } from '../../../src/tmux/fakeDriver.js';
import { EventBus } from '../../../src/api/sse.js';
import type { ElowenEvent } from '../../../src/api/sse.js';
import { loadPlugins } from '../../../src/plugins/loader.js';
import { logger as coreLogger, setLogSink } from '../../../src/shared/logger.js';
import { PluginLogBuffer } from '../../../src/shared/logBuffer.js';
import type { PluginHostConfig } from '../../../src/plugins/api.js';
import type { PluginLogger } from '../../../src/plugins/api.js';

/** Load the REAL on-disk agents plugin (plugins/agents → dist/index.js, so `npx tsc -b
 *  tsconfig.plugins.json` must have built it) against a full fake host wiring. This is the B2b
 *  activation proof: the daemon reaches the subsystem exclusively through what register() registers. */
async function loadAgentsPlugin(logger?: PluginLogger) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db);
  const projects = new ProjectStore(db);
  const bus = new EventBus();
  const tmux = new FakeTmuxDriver();
  const published: ElowenEvent[] = [];
  bus.subscribe((e) => published.push(e));
  const config = {
    get: () => ({ autopilot: { overseerExec: '', pilotExec: '', model: 'm', overseerModel: '', tddMode: false, prEnabled: false, prBaseBranch: '', prVerifyCommand: '', prAutoOpen: false, prompt: '' }, allowedExecs: [], modelNotes: {}, defaults: {}, providers: {} }),
    autopilotRelay: () => null,
    ghToken: () => null,
  } as unknown as PluginHostConfig;
  const registry = await loadPlugins({
    dirs: [join(process.cwd(), 'plugins')],
    // The plugin under test declares that its control is built on the `tasks` domain, so the generation
    // must contain that domain's OWNER for the control to resolve — the same composition the daemon has.
    enabled: ['agents', 'work'],
    delegatedTurnsOutOfProcess: () => false,
    pluginDb: (plugin) => makePluginDb(db, plugin, { canMigrate: true }),
    publishEvent: (e) => bus.publish(e),
    subscribeEvents: (fn) => bus.subscribe(fn),
    host: {
      tmux,
      brainWorker: () => undefined,
      elowenCli: { cli: 'elowen', cliArgv: ['elowen'], url: 'http://localhost:0', token: 't', tokenForTask: () => undefined },
      stores: {
        tasks, taskRefs: new TaskRefs(db),
        projects,
        homeProject: () => ({ id: 1, slug: 'elowen', path: '/o' }),
        usersRead: { list: () => [{ id: 1, username: 'admin', isAdmin: true }], isAdmin: () => true, allowedExecs: () => [] },
        readiness: new Readiness(db),
        taskUsage: new TaskUsageStore(db),
        // The domain has an owner in this wiring — what the plugin asks before it builds anything.
        tasksAvailable: () => true,
      },
      prompts: { render: (name: string) => `[${name}]`, rawTemplate: (name: string) => `[raw:${name}]` },
      config,
      relayClient: () => ({ decide: async () => ({ text: '' }) }) as never,
      git: { projectHead: async () => '', projectRangeDiff: async () => [] } as never,
      push: () => ({ sendToUsers: async () => {} }),
    },
    logger: logger ?? { info() {}, warn() {}, error() {} },
  });
  return { registry, db, tasks, tmux, bus, published };
}

describe('agents plugin register() (B2b activation)', () => {
  it('loads from disk and registers the full host lifecycle: services, intervals, reconciles, resolver', async () => {
    const { registry } = await loadAgentsPlugin();
    const services = registry.services.filter((s) => s.plugin === 'agents').map((s) => s.service.name);
    // runtime-teardown FIRST: PluginServiceRunner.stopAll stops newest-first, so registering the
    // teardown first makes it run LAST — after the deriver loop and every interval has stopped.
    expect(services[0]).toBe('runtime-teardown');
    expect(services).toContain('deriver');
    // The interval sweeps land as services too (registerInterval wraps them) — original core periods.
    for (const name of ['engine-tick', 'scheduler-tick', 'janitor', 'stuck-detector', 'overseer-watchdog', 'decision-sweep', 'pr-feedback']) {
      expect(services).toContain(name);
    }
    expect(services).toHaveLength(9);
    expect(registry.bootReconciles.filter((r) => r.plugin === 'agents')).toHaveLength(3); // zombies + overseers + skill self-heal
    expect(registry.eventProjectResolvers.filter((r) => r.plugin === 'agents')).toHaveLength(1);
    // The persistence side too: mission/review/decision/message/signal rows come from the plugin now.
    const rowResolver = registry.eventRowResolvers.find((r) => r.plugin === 'agents')!.fn;
    expect(rowResolver({ type: 'mission', missionId: 'm-e1', state: 'active' } as ElowenEvent))
      .toEqual({ type: 'mission', target: 'm-e1', detail: 'active', labelTitleId: 'e1' });
    expect(rowResolver({ type: 'task', taskId: 't1', status: 'open' } as ElowenEvent)).toBeUndefined(); // core's
  });

  it("control('missions') passes the registry's typed narrowing and exposes every accessor", async () => {
    const { registry } = await loadAgentsPlugin();
    const control = registry.control('missions');
    expect(control).toBeDefined();
    // The control is keyed by the DOMAIN it implements, never by the plugin that happens to implement it:
    // a consumer asking for a capability must not have to know the package's name (and must keep working
    // if this plugin is renamed or replaced). The registry must therefore hold NO 'agents' key at all.
    expect(registry.controls.has('missions')).toBe(true);
    expect(registry.controls.has('agents')).toBe(false);
    expect(registry.controlOwner.get('missions')).toBe('agents');
    // Accessors build the runtime lazily and return the live services.
    expect(typeof control!.engine().tick).toBe('function');
    expect(typeof control!.spawn().launch).toBe('function');
    expect(typeof control!.planFlow().planEngage).toBe('function');
    expect(typeof control!.planJobs().create).toBe('function');
    expect(typeof control!.decisionQueue().enqueue).toBe('function');
    expect(typeof control!.missionGit().worktreeFor).toBe('function');
    expect(typeof control!.agents().programFor).toBe('function');
    expect(typeof control!.gitLock().run).toBe('function');
    // Repeated access returns the SAME runtime (lazy singleton, not a rebuild per call).
    expect(control!.engine()).toBe(control!.engine());
  });

  it('e2e smoke: engage → tick drives a phase to in_progress with a live fake-tmux session', async () => {
    const { registry, tasks, tmux, published } = await loadAgentsPlugin();
    tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 't1', project_id: 1, title: 'phase one', parent_id: 'epic' });
    const control = registry.control('missions')!;
    const mission = await control.engine().engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(mission.state).toBe('active');
    expect(control.engine().isActive(mission.id)).toBe(true);
    // Engage dispatched the dependency-cleared phase through the plugin's own SpawnService.
    expect(tasks.get('t1')!.status).toBe('in_progress');
    const agent = tasks.get('t1')!.labels.find((l) => l.startsWith('agent:'))!.slice('agent:'.length);
    expect(await tmux.list()).toContain(`elowen-${agent}`);
    expect(published.some((e) => e.type === 'task' && e.taskId === 't1' && e.status === 'in_progress')).toBe(true);
    // A further tick is a no-op (the only phase already runs) — it must not double-spawn.
    await control.engine().tick(mission.id);
    expect((await tmux.list()).filter((s) => s.startsWith('elowen-')).length).toBe(1);
  });

  it('event resolver: a signal event resolves tenancy WITHOUT building the runtime; plan without it is null', async () => {
    const { registry, tasks } = await loadAgentsPlugin();
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 't1', project_id: 1, title: 'T', parent_id: 'e1', labels: ['agent:Nova'] });
    const resolver = registry.eventProjectResolvers.find((r) => r.plugin === 'agents')!.fn;
    expect(resolver({ type: 'signal', session: 'elowen-Nova', signal: 'question' } as ElowenEvent)).toBe(1);
    // No runtime yet (no control access happened) → plan jobs cannot exist → null, not a crash.
    expect(resolver({ type: 'plan', jobId: 'pj-1', status: 'planning' } as ElowenEvent)).toBeNull();
  });

  it('subsystem log lines reach the process-wide sink — the admin per-plugin log ring sees them', async () => {
    // The old lib/logger copy was a separate module instance, so setLogSink (the PluginLogBuffer
    // behind /plugins/:name log/health) never saw a subsystem line. This drives the REAL chain:
    // plugin lib logger → ctx.logger (registry `[plugin:agents]` prefix) → core emit() → sink.
    const buffer = new PluginLogBuffer();
    setLogSink(buffer);
    try {
      const { registry, tasks } = await loadAgentsPlugin(coreLogger('daemon'));
      tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
      tasks.create({ id: 't1', project_id: 1, title: 'phase one', parent_id: 'epic' });
      await registry.control('missions')!.engine().engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
      const lines = buffer.forPlugin('agents').map((e) => e.message);
      // A runtime-service line, with the subsystem scope tag preserved inside the plugin prefix.
      expect(lines.some((m) => m.includes('[spawn] spawned '))).toBe(true);
      expect(buffer.health('agents')).toBe('ok');
    } finally {
      setLogSink(undefined);
    }
  });

  it('plugin stores land in the shared DB via the plugin db seam (missions table usable through the control)', async () => {
    const { registry } = await loadAgentsPlugin();
    const control = registry.control('missions')!;
    control.agents().upsert({ project_id: 1, name: 'Nova', program: 'claude', model: 'opus' });
    expect(control.agents().programFor('Nova')).toBe('claude');
  });
});
