import { openDb } from '../../src/store/db.js';
import { projectHead, projectRangeDiff } from '../../src/integrations/projectFiles.js';

// The plugin engine/scheduler take read-only git helpers as a host seam; the core functions
// stand in (the same ones the pre-extraction core imported directly).
const gitSeam = { projectHead, projectRangeDiff };
import { render } from '../../src/prompts/index.js';
const promptSeam = { render: (n: string, v?: Record<string, string>) => render(n, v), rawTemplate: () => '' };
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { AgentStore } from '../../plugins/agents/src/store/agentStore.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { EventBus } from '../../src/api/sse.js';
import { SpawnService } from '../../plugins/agents/src/spawn/spawn.js';
import { MissionEngine } from '../../plugins/agents/src/overseer/missionEngine.js';
import { PlanJobStore } from '../../src/api/planJobStore.js';
import { DecisionQueue } from '../../src/api/decisionQueue.js';
import { FakeInference } from '../../src/inference/client.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { FakeClock } from '../../src/shared/clock.js';
import { uniqueName } from '../../src/daemon/uniqueName.js';
import { createServer } from '../../src/api/server.js';
import type { PlanJob } from '../../src/api/planJobStore.js';

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

/** Wire a real in-memory daemon app (fake tmux + fake inference) with a bootstrapped admin token.
 *  Exposes the live stores/queues so tests can arrange state and assert side effects. */
export async function makeTestApp(opts: TestAppOpts = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
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
  const spawn = new SpawnService({ prompts: promptSeam, tmux, agents, providers: (program) => config.get().providers[program] });
  const planJobs = new PlanJobStore();
  const decisionQueue = new DecisionQueue();
  const engine = new MissionEngine({ git: gitSeam,
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

  return { app, token, deps: { tasks, readiness, missions, config, users, planJobs, decisionQueue, bus, tmux, engine, seedMissionWithChild, seedMissionWithChain } };
}
