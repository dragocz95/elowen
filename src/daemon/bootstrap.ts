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
import { decidePrompt, isDestructive, gateVerdict, minConfidenceFor, noOverseerFallback } from '../overseer/decision.js';
import { PlanJobStore } from '../overseer/planJob.js';
import { DecisionQueue } from '../overseer/decisionQueue.js';
import { makePilot } from '../overseer/pilotAgent.js';
import { makeOverseer } from '../overseer/overseerAgent.js';
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
import { logger } from '../shared/logger.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const log = logger('daemon');

/** Compact, human-readable one-liner for a bus event — the daemon's activity trail in the log file. */
function describeEvent(e: { type: string } & Record<string, unknown>): string {
  switch (e.type) {
    case 'task': return `task ${e.taskId} → ${e.status}`;
    case 'mission': return `mission ${e.missionId} → ${e.state}`;
    case 'plan': return `plan ${e.jobId} → ${e.status}${e.epicId ? ` (epic ${e.epicId})` : ''}${e.error ? ` — ${e.error}` : ''}`;
    case 'signal': return `signal ${e.session} → ${(e.signal as { type?: string })?.type ?? '?'}`;
    default: return e.type;
  }
}

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
    log.warn('no users exist and no ORCA_BOOTSTRAP_USER/PASS set — login will be impossible until a user is seeded');
  }
  const projects = new ProjectStore(db);
  const userProjects = new UserProjectStore(db);
  const git = new RealGitReader();
  // Give spawned agents a way to close their task: the orca CLI path + daemon URL + a service token.
  // The token is AGENT-SCOPED (not the admin's full token): a prompt-injected agent can only drive
  // its own worker/overseer/pilot verbs (close task, plan submit, overseer poll/decide, read-only
  // listings) — never manage users, PUT /config, or register/delete projects (finding S51). Reused
  // across restarts (see ensureAgentToken) so a restart doesn't 401 in-flight agents. Owned by the
  // lowest-id user purely to satisfy the FK; the scope, not the owner, is what bounds it.
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.js');
  // Reuse the existing agent token across restarts so a daemon restart doesn't 401 in-flight agents
  // mid-task (they hold the token they were spawned with); only mints fresh when none is valid.
  const serviceToken = users.count() > 0 ? users.ensureAgentToken(users.list()[0]!.id) : '';
  const orcaCli = { cliPath, url: `http://localhost:${process.env.ORCA_PORT ?? 4400}`, token: serviceToken };
  const spawn = new SpawnService({ tmux, agents, orca: orcaCli, providers: (program) => config.get().providers[program] });
  const bus = new EventBus();
  const events = new EventStore(db);
  bus.subscribe((e) => { try { events.record(e); } catch (err) { log.error('event record failed', err); } });
  // Activity trail: mirror every bus event into the log file as a readable one-liner, so the log on
  // its own tells the story of a run (spawns, advances, plans) without cross-referencing the DB.
  bus.subscribe((e) => log.info(describeEvent(e)));
  // The overseer relay client, rebuilt per-call so a key set/cleared at runtime takes effect.
  // Overseer decisions use their own model when set, else fall back to the planner model.
  // Returns null when no API key is configured (callers then keep their pre-relay behaviour).
  const overseerClient = () => {
    const cfg = config.get(); const key = config.apiKey();
    if (!key) return null;
    return new RelayClient({ baseUrl: cfg.autopilot.apiUrl, apiKey: key, model: cfg.autopilot.overseerModel || cfg.autopilot.model });
  };
  // Shared reasoning stores: the async planning job registry and the per-mission decision queue.
  // The Pilot spawns a repo-aware planning agent for agent-mode plan jobs (relay path needs none);
  // the Overseer parks a per-mission agent that long-polls the decision queue.
  const planJobs = new PlanJobStore();
  const decisionQueue = new DecisionQueue();
  const pilot = makePilot({ spawn, config, projects, nameAgent: uniqueName, cliPath });
  const overseer = makeOverseer({ spawn, tmux, config, queue: decisionQueue, cliPath });

  const engine = new MissionEngine({
    tasks, readiness, missions, spawn, tmux, bus, projects,
    fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: uniqueName, clock: new SystemClock(),
    overseer,
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
  // The active mission owning a session (via its task's parent epic), or null for a manual launch.
  const missionIdForSession = (session: string): string | null => {
    const t = taskForSession(session);
    if (!t?.parent_id) return null;
    return missions.active().find((m) => m.epic_id === t.parent_id)?.id ?? null;
  };
  const deriver = new Deriver({
    tmux, agents, tasks, sink: bus, clock: new SystemClock(),
    // Resolve strictly via the agent:<name> label. No global "first in-progress task" fallback:
    // the parked Overseer (orca-overseer-<id>) and the Pilot have no task row, and the fallback would
    // mis-attribute their panes — even pressing accept-keys into the Overseer's TUI. Unresolved → skip.
    sessionTaskId: (session) => taskForSession(session)?.id ?? null,
    autonomyFor: (session) => {
      const t = taskForSession(session);
      if (!t?.parent_id) return null;
      return missions.active().find((m) => m.epic_id === t.parent_id)?.autonomy ?? null;
    },
    missionFor: missionIdForSession,
    // Overseer decision for an auto-cleared prompt: the parked agent (queue) when overseerExec is set
    // and the prompt belongs to a mission, else the relay.
    decideApproval: async (input) => {
      // Per-autonomy confidence bar: L1 (Assist) is held stricter than L2/L3 so it auto-runs only
      // clearly-safe steps. One source of truth, applied on every gate path below.
      const minConfidence = minConfidenceFor(input.autonomy);
      if (input.missionId && config.get().autopilot.overseerExec) {
        const localDestructive = isDestructive(`${input.question} ${input.context}`);
        const v = await decisionQueue.enqueue(input.missionId, 'prompt', { question: input.question, context: input.context, options: input.options }, localDestructive);
        return gateVerdict(v, { blockDestructive: true, minConfidence });
      }
      const inf = overseerClient();
      // No overseer wired at all: only L3 may wave a non-destructive prompt through; L1/L2 escalate
      // instead of being blindly approved (that blanket-approve was the bug that collapsed L2 into L3).
      if (!inf) return noOverseerFallback(input.autonomy, isDestructive(`${input.question} ${input.context}`));
      const d = await decidePrompt(inf, input);
      return gateVerdict(d, { blockDestructive: false, minConfidence });
    },
  });
  // Setup mode: with no users yet the daemon is open so the onboarding page can run before login;
  // auth (in authMiddleware) re-engages automatically once the first admin is created.
  if (users.count() === 0) {
    log.warn('SETUP MODE — no users yet; the API is open until the first admin is created via onboarding');
  }
  const avatarsDir = opts.dbPath === ':memory:' ? undefined : join(dirname(opts.dbPath), 'avatars');
  // Per-process secret for short-lived signed avatar URLs (finding W2) — keeps the long-lived session
  // token out of <img> src query strings. Rotates on restart; links live ~5 min, so that's harmless.
  const avatarSecret = randomBytes(32).toString('hex');
  const app = createServer({ tasks, readiness, missions, engine, spawn, tmux, bus, events, agents, project: opts.project, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new SystemClock(), config, users, projects, userProjects, git, avatarsDir, avatarSecret, planJobs, decisionQueue, pilot });

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

  // After a restart the parked overseers are gone (their tmux sessions died with the daemon). When an
  // agent overseer is configured, re-park one per active mission and kill any orphan overseer session
  // whose mission is no longer active. Inert when overseerExec is empty (relay handles decisions).
  const reconcileOverseers = async () => {
    if (!config.get().autopilot.overseerExec) return;
    const live = new Set((await tmux.list()).filter((s) => s.startsWith('orca-overseer-')));
    const activeIds = new Set(missions.active().map((m) => m.id));
    for (const s of live) {
      const id = s.replace('orca-overseer-', '');
      if (!activeIds.has(id)) await tmux.kill(s).catch(() => { /* already gone */ });
    }
    for (const m of missions.active()) {
      if (live.has(`orca-overseer-${m.id}`)) continue;
      const epic = tasks.get(m.epic_id);
      const proj = epic ? projects.get(epic.project_id) : null;
      if (proj) await overseer.start(m.id, proj.id, proj.path);
    }
  };

  const startLoops = () => {
    const clock = new SystemClock();
    // One-shot startup sweeps. Log on failure (e.g. tmux missing) so a silent rejection can't leave
    // zombies un-reverted — that would stall every mission until the next restart.
    void reconcileZombies().catch((e) => log.error('reconcileZombies failed', e));
    void reconcileOverseers().catch((e) => log.error('reconcileOverseers failed', e)); // re-park overseers for active missions / kill orphans
    const stopDeriver = deriver.start();
    const stopOverseer = clock.setInterval(() => { for (const m of missions.live()) void engine.tick(m.id); }, 90000);
    const stopScheduler = clock.setInterval(() => { void scheduler.tick(); }, 30000);
    // Janitor: reap finished agents' zombie tmux sessions. Log what it reaps so the trail shows when
    // a session was cleaned up (and that the janitor is alive).
    const stopJanitor = clock.setInterval(() => {
      void sweepFinishedSessions({ tmux, taskForSession })
        .then((reaped) => { if (reaped.length) log.info(`janitor reaped ${reaped.length} finished session(s): ${reaped.join(', ')}`); })
        .catch((e) => log.error('janitor sweep failed', e));
    }, 60000);
    // Stuck detector: an agent that died without `orca close` leaves its task in_progress with a
    // dead session; revert it so the mission re-spawns (bounded), else escalate. 2-min grace
    // covers the spawn→session window; relaunch at most twice before escalating to a human.
    const stopStuck = clock.setInterval(() => {
      void sweepStuckTasks({ tmux, tasks, bus, now: clock.now(), graceMs: 120000, maxRelaunch: 2 })
        .then(({ reverted, escalated }) => {
          if (reverted.length) log.warn(`stuck detector reverted ${reverted.length} dead-agent task(s) to open: ${reverted.join(', ')}`);
          if (escalated.length) log.error(`stuck detector escalated ${escalated.length} task(s) to blocked after max relaunches: ${escalated.join(', ')}`);
        })
        .catch((e) => log.error('stuck sweep failed', e));
    }, 60000);
    // Overseer watchdog: a parked overseer can die mid-mission (TUI crash, OOM) and would otherwise
    // leave the mission running unsupervised until the next daemon restart. reconcileOverseers is
    // idempotent — it re-parks a missing overseer for each active mission and kills orphans — so run
    // it periodically, not just on boot.
    const stopOverseerWatchdog = clock.setInterval(() => { void reconcileOverseers().catch((e) => log.error('overseer watchdog failed', e)); }, 60000);
    // Purge expired auth tokens hourly so the table can't grow unbounded over a long-running daemon.
    const purgeTokens = () => users?.purgeExpiredTokens(config.get().security.tokenTtlDays);
    purgeTokens();
    const stopTokenPurge = clock.setInterval(purgeTokens, 3_600_000);
    // Same for the activity timeline: every bus event is persisted (events.record), so without a
    // retention sweep the `events` table grows without bound. Drop rows past the 30-day window hourly.
    const purgeEvents = () => { try { events.purgeOlderThan(); } catch (e) { log.error('event purge failed', e); } };
    purgeEvents();
    const stopEventPurge = clock.setInterval(purgeEvents, 3_600_000);
    return () => { stopDeriver(); stopOverseer(); stopScheduler(); stopJanitor(); stopStuck(); stopOverseerWatchdog(); stopTokenPurge(); stopEventPurge(); };
  };
  return { app, startLoops };
}
