import { openDb } from '../store/db.js';
import { TaskStore } from '../store/taskStore.js';
import { Readiness } from '../store/readiness.js';
import { AgentStore } from '../store/agentStore.js';
import { MissionStore } from '../store/missionStore.js';
import { SpawnService } from '../spawn/spawn.js';
import { MissionEngine } from '../overseer/missionEngine.js';
import { Deriver } from '../deriver/deriver.js';
import { EventBus } from '../api/sse.js';
import { createServer } from '../api/server.js';
import { RealTmuxDriver } from '../tmux/driver.js';
import { SystemClock } from '../shared/clock.js';
import { ConfigStore } from '../store/configStore.js';
import { UserStore } from '../store/userStore.js';
import { EventStore } from '../store/eventStore.js';
import type { TmuxDriver } from '../tmux/types.js';

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
  const spawn = new SpawnService({ tmux, agents });
  const bus = new EventBus();
  const events = new EventStore(db);
  bus.subscribe((e) => { try { events.record(e); } catch (err) { console.error('[orca] event record failed', err); } });
  const engine = new MissionEngine({ tasks, readiness, missions, spawn, tmux, bus, project: opts.project, fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => `Agent${Math.floor(performance.now()) % 9999}` });
  // Deriver resolves a session's task via the agent registry / in-progress task (simplified: first in_progress child).
  const deriver = new Deriver({ tmux, agents, tasks, sink: bus, clock: new SystemClock(), sessionTaskId: () => tasks.list({ status: 'in_progress' })[0]?.id ?? null });
  const openMode = users.count() === 0 && opts.allowOpen === true;
  if (openMode) {
    console.warn('[orca] running OPEN (no auth) — ORCA_ALLOW_OPEN is set and no users exist');
  }
  const app = createServer({ tasks, readiness, missions, engine, spawn, tmux, bus, events, project: opts.project, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new SystemClock(), config, users: openMode ? undefined : users });

  const startLoops = () => {
    const clock = new SystemClock();
    const stopDeriver = deriver.start();
    const stopOverseer = clock.setInterval(() => { for (const m of missions.active()) void engine.tick(m.id); }, 90000);
    return () => { stopDeriver(); stopOverseer(); };
  };
  return { app, startLoops };
}
