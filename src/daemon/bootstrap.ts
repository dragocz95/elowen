import { openDb } from '../store/db.js';
import { TaskStore } from '../store/taskStore.js';
import { Readiness } from '../store/readiness.js';
import { AgentStore } from '../store/agentStore.js';
import { MissionStore } from '../store/missionStore.js';
import { SpawnService } from '../spawn/spawn.js';
import { MissionEngine } from '../overseer/missionEngine.js';
import { Scheduler } from '../overseer/scheduler.js';
import { sweepFinishedSessions } from '../overseer/janitor.js';
import { sweepStuckTasks, deadAgentTasks } from '../overseer/stuckDetector.js';
import { decidePrompt, decideTask, isDestructive, MIN_CONFIDENCE } from '../overseer/decision.js';
import { RelayClient } from '../inference/client.js';
import { Deriver } from '../deriver/deriver.js';
import { EventBus } from '../api/sse.js';
import { createServer } from '../api/server.js';
import { RealTmuxDriver } from '../tmux/driver.js';
import { SystemClock } from '../shared/clock.js';
import { ConfigStore } from '../store/configStore.js';
import { UserStore } from '../store/userStore.js';
import { EventStore } from '../store/eventStore.js';
import { ProjectStore } from '../store/projectStore.js';
import { UserProjectStore } from '../store/userProjectStore.js';
import { RealGitReader } from '../git/gitReader.js';
import type { TmuxDriver } from '../tmux/types.js';
import { uniqueName } from './uniqueName.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface BuildOpts {
  dbPath: string;
  project: { id: number; slug: string; path: string };
  relay: { baseUrl: string; apiKey: string; model: string } | null;
  tmux?: TmuxDriver;
  bootstrap?: { username: string; password: string } | null;
  allowOpen?: boolean;
}

export function buildApp(opts: BuildOpts) {
  const db = openDb(opts.dbPath);
  db.prepare('INSERT OR IGNORE INTO projects (id,slug,path) VALUES (?,?,?)').run(opts.project.id, opts.project.slug, opts.project.path);
  const tmux = opts.tmux ?? new RealTmuxDriver();
  const tasks = new TaskStore(db); const agents = new AgentStore(db);
  const missions = new MissionStore(db); const readiness = new Readiness(db);
  const config = new ConfigStore(db);
  const users = new UserStore(db);
  if (opts.bootstrap != null) {
    if (users.count() === 0) {
      users.create(opts.bootstrap.username, opts.bootstrap.password);
    }
  } else if (users.count() === 0) {
    console.warn('[orca] no users exist and no ORCA_BOOTSTRAP_USER/PASS set — login will be impossible until a user is seeded');
  }
  const projects = new ProjectStore(db);
  const userProjects = new UserProjectStore(db);
  const git = new RealGitReader();
  // Give spawned agents a way to close their task: the orca CLI path + daemon URL + a service token.
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.js');
  const serviceToken = users.count() > 0 ? users.issueToken(users.list()[0]!.id) : '';
  const orcaCli = { cliPath, url: `http://localhost:${process.env.ORCA_PORT ?? 4400}`, token: serviceToken };
  const spawn = new SpawnService({ tmux, agents, orca: orcaCli, providers: (program) => config.get().providers[program] });
  const bus = new EventBus();
  const events = new EventStore(db);
  bus.subscribe((e) => { try { events.record(e); } catch (err) { console.error('[orca] event record failed', err); } });
  // The overseer relay client, rebuilt per-call so a key set/cleared at runtime takes effect.
  // Overseer decisions use their own model when set, else fall back to the planner model.
  // Returns null when no API key is configured (callers then keep their pre-relay behaviour).
  const overseerClient = () => {
    const cfg = config.get(); const key = config.apiKey();
    if (!key) return null;
    return new RelayClient({ baseUrl: cfg.autopilot.apiUrl, apiKey: key, model: cfg.autopilot.overseerModel || cfg.autopilot.model });
  };
  const engine = new MissionEngine({
    tasks, readiness, missions, spawn, tmux, bus, projects,
    fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: uniqueName, clock: new SystemClock(),
    // Overseer LLM gate for guardrail-triggering tasks. No relay → no-op (approve, non-destructive)
    // so the boolean guardrail behaviour is unchanged; with a relay, escalate on deny/low-confidence.
    decideTask: async (input) => {
      const inf = overseerClient();
      if (!inf) return { approve: true, destructive: false };
      const d = await decideTask(inf, input);
      return { approve: d.approve && d.confidence >= MIN_CONFIDENCE, destructive: d.destructive };
    },
  });
  const scheduler = new Scheduler({ tasks, spawn, bus, projects, fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: uniqueName, clock: new SystemClock() });
  // Deriver resolves a session's task via the agent registry / in-progress task (simplified: first in_progress child).
  // Resolve a session's task via its agent:<name> label. Agent names recur across missions,
  // so pick the MOST RECENT match (list is created_at ASC) — never an old same-named task,
  // which would make the janitor reap a live agent or skip a real zombie.
  const taskForSession = (session: string) => {
    const name = session.replace(/^orca-/, '');
    const matches = tasks.list().filter((t) => t.labels.includes(`agent:${name}`));
    return matches[matches.length - 1] ?? null;
  };
  const deriver = new Deriver({
    tmux, agents, tasks, sink: bus, clock: new SystemClock(),
    sessionTaskId: (session) => taskForSession(session)?.id ?? tasks.list({ status: 'in_progress' })[0]?.id ?? null,
    autonomyFor: (session) => {
      const t = taskForSession(session);
      if (!t?.parent_id) return null;
      return missions.active().find((m) => m.epic_id === t.parent_id)?.autonomy ?? null;
    },
    // Overseer decision: use the configured relay to judge auto-cleared prompts. Without a key,
    // fall back to blanket auto-approve while still honouring the local destructive heuristic.
    decideApproval: async (input) => {
      const inf = overseerClient();
      if (!inf) return { approve: true, destructive: isDestructive(`${input.question} ${input.context}`) };
      const d = await decidePrompt(inf, input);
      return { approve: d.approve && d.confidence >= MIN_CONFIDENCE, destructive: d.destructive };
    },
  });
  // Setup mode: with no users yet the daemon is open so the onboarding page can run before login;
  // auth (in authMiddleware) re-engages automatically once the first admin is created.
  if (users.count() === 0) {
    console.warn('[orca] SETUP MODE — no users yet; the API is open until the first admin is created via onboarding');
  }
  const avatarsDir = opts.dbPath === ':memory:' ? undefined : join(dirname(opts.dbPath), 'avatars');
  const app = createServer({ tasks, readiness, missions, engine, spawn, tmux, bus, events, project: opts.project, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new SystemClock(), config, users, projects, userProjects, git, avatarsDir });

  // Root-cause recovery: after a daemon crash/restart, tasks left 'in_progress' whose tmux
  // session is gone are zombies — revert them to 'open' so they can be picked up again. No grace
  // or relaunch counter here: a restart isn't an agent death, so it shouldn't spend the budget.
  const reconcileZombies = async () => {
    const live = new Set((await tmux.list()).filter((s) => s.startsWith('orca-')));
    for (const t of deadAgentTasks(live, tasks.list({ status: 'in_progress' }))) {
      tasks.setStatus(t.id, 'open');
      bus.publish({ type: 'task', taskId: t.id, status: 'open' });
    }
  };

  const startLoops = () => {
    const clock = new SystemClock();
    void reconcileZombies(); // one-shot zombie sweep on startup
    const stopDeriver = deriver.start();
    const stopOverseer = clock.setInterval(() => { for (const m of missions.live()) void engine.tick(m.id); }, 90000);
    const stopScheduler = clock.setInterval(() => { void scheduler.tick(); }, 30000);
    // Janitor: reap finished agents' zombie tmux sessions.
    const stopJanitor = clock.setInterval(() => { void sweepFinishedSessions({ tmux, taskForSession }); }, 60000);
    // Stuck detector: an agent that died without `orca close` leaves its task in_progress with a
    // dead session; revert it so the mission re-spawns (bounded), else escalate. 2-min grace
    // covers the spawn→session window; relaunch at most twice before escalating to a human.
    const stopStuck = clock.setInterval(() => { void sweepStuckTasks({ tmux, tasks, bus, now: clock.now(), graceMs: 120000, maxRelaunch: 2 }); }, 60000);
    return () => { stopDeriver(); stopOverseer(); stopScheduler(); stopJanitor(); stopStuck(); };
  };
  return { app, startLoops };
}
