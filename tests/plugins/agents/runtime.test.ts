import { describe, it, expect } from 'vitest';
import { openDb } from '../../../src/store/db.js';
import { makePluginDb } from '../../../src/store/pluginDb.js';
import { FakeTmuxDriver } from '../../../src/tmux/fakeDriver.js';
import type { ElowenEvent } from '../../../src/api/sse.js';
import type { TaskStore } from '../../../src/store/taskStore.js';
import type { ProjectStore } from '../../../src/store/projectStore.js';
import type { Readiness } from '../../../src/store/readiness.js';
import type { TaskUsageStore } from '../../../src/store/taskUsageStore.js';
import type { PluginHostConfig } from '../../../src/plugins/api.js';
import { AGENTS_MIGRATIONS } from '../../../plugins/agents/src/store/migrations.js';
import { buildAgentsRuntime, type AgentsRuntimeDeps } from '../../../plugins/agents/src/runtime.js';
import { DECISION_SWEEP_MS } from '../../../plugins/agents/src/overseer/livenessSweep.js';

/** Fake host deps: the same seams B2 will fill from ctx, here as plain no-op fakes — the smoke proof
 *  that the composition root builds the whole subsystem without a PluginContext. */
function fakeDeps() {
  const db = makePluginDb(openDb(':memory:'), 'agents', { canMigrate: true });
  db.migrate(AGENTS_MIGRATIONS);
  const published: ElowenEvent[] = [];
  const disposed: string[] = [];
  let subs = 0;
  const deps: AgentsRuntimeDeps = {
    tmux: new FakeTmuxDriver(),
    db,
    stores: {
      tasks: { list: () => [], get: () => null, setStatus: () => {} } as unknown as TaskStore,
      projects: { get: () => null, list: () => [] } as unknown as ProjectStore,
      readiness: { ready: () => [], readyForEpic: () => [] } as unknown as Readiness,
      taskUsage: { record: () => {}, get: () => null } as unknown as TaskUsageStore,
      users: { list: () => [{ id: 1, is_admin: true }] },
    },
    prompts: { render: (name) => `[${name}]`, rawTemplate: (name) => `[raw:${name}]` },
    config: {
      get: () => ({ autopilot: { overseerExec: '', pilotExec: '', model: 'm', overseerModel: '', tddMode: false, prEnabled: false, prBaseBranch: '', prVerifyCommand: '', prAutoOpen: false, prompt: '' }, allowedExecs: [], modelNotes: {}, defaults: {}, providers: {} }),
      autopilotRelay: () => null,
      ghToken: () => null,
    } as unknown as PluginHostConfig,
    relayClient: () => ({ decide: async () => ({ text: '' }) }),
    git: { projectHead: async () => '', projectRangeDiff: async () => [] },
    elowenCli: { cli: 'elowen', cliArgv: ['elowen'], url: 'http://localhost:0', token: 't', tokenForTask: () => undefined },
    brainWorker: () => undefined,
    publishEvent: (e) => { published.push(e); },
    subscribeEvents: () => { const id = `sub-${subs++}`; return () => { disposed.push(id); }; },
    push: { sendToUsers: async () => {} },
    homeProjectPath: '/tmp',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
  return { deps, published, disposed, subscribed: () => subs };
}

describe('agents plugin runtime composition root (extraction B1)', () => {
  it('builds every service from fake deps without touching a PluginContext', () => {
    const { deps, subscribed } = fakeDeps();
    const rt = buildAgentsRuntime(deps);
    // The full service graph exists…
    expect(typeof rt.spawn.launch).toBe('function');
    expect(typeof rt.deriver.start).toBe('function');
    expect(typeof rt.deriver.tick).toBe('function');
    expect(typeof rt.engine.tick).toBe('function');
    expect(typeof rt.engine.engage).toBe('function');
    expect(typeof rt.scheduler.tick).toBe('function');
    expect(typeof rt.pilot).toBe('function');
    expect(typeof rt.overseer.start).toBe('function');
    expect(typeof rt.missionGit.worktreeFor).toBe('function');
    expect(typeof rt.overseerClient).toBe('function');
    expect(rt.overseerClient()).toBeNull(); // no relay key configured → pre-relay behaviour
    expect(typeof rt.taskForSession).toBe('function');
    expect(typeof rt.missionIdForSession).toBe('function');
    expect(typeof rt.decisionRenderer('t-1')).toBe('function');
    expect(rt.resumeFallback).toEqual({ program: 'claude-code', model: 'sonnet' });
    // …and the two bus subscribers (push dispatch + usage recorder) attached through the host seam.
    expect(subscribed()).toBe(2);
  });

  it('owns the plugin stores over the shared DB handle', () => {
    const { deps } = fakeDeps();
    const rt = buildAgentsRuntime(deps);
    rt.missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L2', max_sessions: 1 });
    expect(rt.missions.get('m-e1')?.state).toBe('active');
    expect(rt.missionIdForSession('elowen-ghost')).toBeNull(); // no task rows in the fake task store
    rt.agents.upsert({ project_id: 1, name: 'Nova', program: 'claude', model: 'opus' });
    expect(rt.agents.programFor('Nova')).toBe('claude');
  });

  it('exposes the bootstrap interval set with the exact core periods', () => {
    const { deps } = fakeDeps();
    const rt = buildAgentsRuntime(deps);
    const byName = Object.fromEntries(rt.intervals.map((i) => [i.name, i.ms]));
    expect(byName).toEqual({
      'engine-tick': 90000,
      'scheduler-tick': 30000,
      'janitor': 60000,
      'stuck-detector': 60000,
      'overseer-watchdog': 60000,
      'decision-sweep': DECISION_SWEEP_MS,
      'pr-feedback': 60000,
    });
    for (const i of rt.intervals) expect(typeof i.fn).toBe('function');
  });

  it('boot reconciles run against the fake host without throwing', async () => {
    const { deps } = fakeDeps();
    const rt = buildAgentsRuntime(deps);
    await expect(rt.reconcileZombies()).resolves.toBeUndefined();
    await expect(rt.reconcileOverseers()).resolves.toBeUndefined();
  });

  it('dispose tears down exactly the two bus subscriptions', () => {
    const { deps, disposed } = fakeDeps();
    const rt = buildAgentsRuntime(deps);
    rt.dispose();
    expect(disposed).toEqual(['sub-0', 'sub-1']);
  });

  it('spawn refuses an elowen: exec while the brain worker is not yet wired (late binding)', async () => {
    const { deps } = fakeDeps();
    const rt = buildAgentsRuntime(deps);
    await expect(rt.spawn.launch({
      projectId: 1, projectPath: '/tmp', taskId: 't-1', agentName: 'Nova',
      spec: { program: 'elowen', model: 'anthropic/claude' },
    })).rejects.toThrow('elowen exec engine not available');
  });
});
