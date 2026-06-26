import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { AgentStore } from '../../src/store/agentStore.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { EventBus } from '../../src/api/sse.js';
import { SpawnService } from '../../src/spawn/spawn.js';
import { MissionEngine } from '../../src/overseer/missionEngine.js';
import { PlanJobStore } from '../../src/overseer/planJob.js';
import { DecisionQueue } from '../../src/overseer/decisionQueue.js';
import { FakeInference } from '../../src/inference/client.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { FakeClock } from '../../src/shared/clock.js';
import { uniqueName } from '../../src/daemon/uniqueName.js';
import { createServer } from '../../src/api/server.js';
import type { PlanJob } from '../../src/overseer/planJob.js';

export interface TestAppOpts {
  /** Raw LLM output the relay path returns from `decompose` (a JSON array of phases). */
  fakePlan?: string;
  /** Autopilot API key; set non-empty to enable the relay planning path. */
  apiKey?: string;
}

/** Wire a real in-memory daemon app (fake tmux + fake inference) with a bootstrapped admin token.
 *  Exposes the live stores/queues so tests can arrange state and assert side effects. */
export async function makeTestApp(opts: TestAppOpts = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const readiness = new Readiness(db);
  const agents = new AgentStore(db);
  const missions = new MissionStore(db);
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const users = new UserStore(db);
  users.create('admin', 'pw');
  const token = users.issueToken(users.list()[0]!.id);
  if (typeof opts.apiKey === 'string' && opts.apiKey) config.update({ autopilot: { apiKey: opts.apiKey } });

  const tmux = new FakeTmuxDriver();
  const bus = new EventBus();
  const spawn = new SpawnService({ tmux, agents, providers: (program) => config.get().providers[program] });
  const planJobs = new PlanJobStore();
  const decisionQueue = new DecisionQueue();
  const engine = new MissionEngine({
    tasks, readiness, missions, spawn, tmux, bus, projects,
    fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: uniqueName, clock: new FakeClock(0),
  });
  // No-op pilot: in agent mode the job simply stays 'planning' until a test calls /plan/:id/submit.
  const pilot = async (_job: PlanJob, _projectPath: string) => { /* parked */ };

  const app = createServer({
    tasks, readiness, missions, engine, spawn, tmux, bus,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects,
    planJobs, decisionQueue, pilot,
    makeInference: () => new FakeInference(opts.fakePlan ?? '[{"title":"Phase A","type":"task"}]'),
  });

  /** Seed an epic + one in-progress child phase + an active mission `m-<epic>`. */
  const seedMissionWithChild = () => {
    const epic = tasks.create({ id: 'orca-ep', project_id: 1, title: 'Epic', type: 'epic', description: 'epic' });
    const child = tasks.create({ id: 'orca-c1', project_id: 1, title: 'Child phase', type: 'task', parent_id: epic.id, description: 'child' });
    tasks.setStatus(child.id, 'in_progress');
    const mission = missions.create({ id: `m-${epic.id}`, epic_id: epic.id, autonomy: 'L3', max_sessions: 1 });
    return { missionId: mission.id, epicId: epic.id, childId: child.id };
  };

  /** Seed an epic with two chained phases (P1 in_progress, P2 open depends on P1) + active mission.
   *  `autonomy` defaults to L3 so the existing self-heal/review tests get full autonomy; pass L1/L2
   *  to exercise the human-in-the-loop branch (no auto self-heal). */
  const seedMissionWithChain = (autonomy = 'L3') => {
    const epic = tasks.create({ id: 'orca-ep2', project_id: 1, title: 'Epic2', type: 'epic', description: 'epic' });
    const p1 = tasks.create({ id: 'orca-p1', project_id: 1, title: 'Phase 1', type: 'task', parent_id: epic.id, description: 'p1' });
    const p2 = tasks.create({ id: 'orca-p2', project_id: 1, title: 'Phase 2', type: 'task', parent_id: epic.id, description: 'p2' });
    tasks.addDep(p2.id, p1.id);
    tasks.setStatus(p1.id, 'in_progress');
    const mission = missions.create({ id: `m-${epic.id}`, epic_id: epic.id, autonomy, max_sessions: 1 });
    return { missionId: mission.id, epicId: epic.id, childId: p1.id, nextId: p2.id };
  };

  return { app, token, deps: { tasks, readiness, missions, config, planJobs, decisionQueue, bus, tmux, seedMissionWithChild, seedMissionWithChain } };
}
