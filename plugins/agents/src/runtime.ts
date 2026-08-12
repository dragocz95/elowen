/** The agents-subsystem composition root. Everything reaches the host through ONE typed deps object;
 *  this module never touches a PluginContext, so it stays constructible in tests with plain fakes.
 *  index.ts adapts ctx.* onto AgentsRuntimeDeps and registers services/intervals/boot-reconciles —
 *  registration is deliberately NOT done here. */
import type { TmuxDriver } from '../../../src/tmux/types.js';
import type { PluginDbHandle, PluginHostPrompts, PluginHostConfig, PluginHostAdvisor, PluginElowenCli, PluginBrainWorker } from '../../../src/plugins/api.js';
import type { InferenceClient, RelayConfig } from '../../../src/inference/types.js';
import type { ElowenEvent } from '../../../src/api/sse.js';
import type { TaskStore } from '../../../src/store/taskStore.js';
import type { Task } from '../../../src/store/types.js';
import type { Project } from '../../../src/store/projectStore.js';
import type { TaskUsageStore } from '../../../src/store/taskUsageStore.js';
import { AgentStore } from './store/agentStore.js';
import { MissionStore } from './store/missionStore.js';
import { MissionPrStore } from './store/missionPrStore.js';
import { NoteStore } from './store/noteStore.js';
import { SpawnService } from './spawn/spawn.js';
import { Deriver } from './deriver/deriver.js';
import { detectAgentPrompt } from './deriver/shellPatterns/index.js';
import { MissionEngine, type SummaryContext } from './overseer/missionEngine.js';
import { MissionGit } from './overseer/missionGit.js';
import type { AgentsPluginConfig } from './config.js';
import { Scheduler } from './overseer/scheduler.js';
import { sweepFinishedSessions } from './overseer/janitor.js';
import { sweepPrFeedback, type PrFeedbackDeps } from './overseer/prFeedback.js';
import { sweepStuckTasks, deadAgentTasks } from './overseer/stuckDetector.js';
import { decidePrompt, decideChoice, gateVerdict, minConfidenceFor, noOverseerFallback } from './overseer/decision.js';
import { PlanJobStore } from './overseer/planJob.js';
import { DecisionQueue, type DecisionResult } from './overseer/decisionQueue.js';
import { sweepAgentLiveness, checkAction, WORKER_IDLE_MS, OVERSEER_IDLE_MS, DECISION_GRACE_MS, DECISION_HARD_MS, DECISION_SWEEP_MS, PROGRESS_REVIEW_MS } from './overseer/livenessSweep.js';
import { PaneActivityTracker } from './overseer/paneActivity.js';
import { makePilot } from './overseer/pilotAgent.js';
import { makeOverseer } from './overseer/overseerAgent.js';
import { UsageRecorder } from './usage/recorder.js';
import { captureResumeLabel } from './usage/resumeCapture.js';
import { readTaskUsage } from './usage/index.js';
import { AdvisorService } from './advisor/service.js';
import { usagePath } from './usage/usagePath.js';
import type { TokenUsage } from './usage/types.js';
import { PushDispatcher } from './push/pushDispatcher.js';
import type { PushPayload } from './push/messages.js';
import { uniqueName } from './lib/uniqueName.js';
import { resolveOwnerId } from './lib/owner.js';
import { SystemClock } from './lib/clock.js';
import { KeyedMutex } from './lib/keyedMutex.js';
import { stripPrefix } from './lib/text.js';
import type { GitReader } from './lib/git.js';
import type { AgentsBusWithSink } from './lib/bus.js';
import type { Logger } from './lib/logger.js';

/** Everything the subsystem needs from the host, as ONE typed object. index.ts fills it from ctx:
 *  tmux ← ctx.host.tmux(), db ← ctx.db(), stores ← ctx.host.stores() (users adapted to is_admin rows),
 *  prompts/config/relayClient/git/elowenCli ← ctx.host.*, brainWorker ← ctx.host.brainWorker (late),
 *  publishEvent/subscribeEvents ← ctx, push ← the host push transport seam. */
export interface AgentsRuntimeDeps {
  tmux: TmuxDriver;
  /** The plugin's handle on the shared main DB — owns agents/missions/mission_pr (grandfathered). */
  db: PluginDbHandle;
  stores: {
    tasks: TaskStore;
    /** The host store seam's shape (PluginHostStores.projects) — reads only, no store class. */
    projects: { get(id: number): Project | null; list(): Project[] };
    /** Dependency-cleared open tasks (PluginHostStores.readiness shape). */
    readiness: { ready(projectId: number): Task[]; readyForEpic(epicId: string): Task[] };
    taskUsage: TaskUsageStore;
    /** Read-only user view with the admin flag (host usersRead rows adapted to is_admin shape). */
    users: { list(): { id: number; is_admin: boolean }[] };
  };
  prompts: PluginHostPrompts;
  config: PluginHostConfig;
  /** The plugin's own effective config: plugins.config.agents (the keys this runtime consumes
   *  exclusively) with the live autopilot values as fallback. See config.ts. */
  pluginConfig: () => AgentsPluginConfig;
  /** Build a relay inference client (the overseer/planner/decision LLM path) — ctx.host.relayClient. */
  relayClient: (cfg: RelayConfig) => InferenceClient;
  git: GitReader;
  elowenCli: PluginElowenCli;
  /** Late-resolved embedded worker executor: bootstrap constructs the BrainWorkerService AFTER the
   *  plugin loads (setPluginHostBrainWorker), so this is an accessor, not a value. Undefined until
   *  wired — an `elowen:` exec launched before that fails exactly like the core's unattached spawn. */
  brainWorker: () => PluginBrainWorker | undefined;
  publishEvent: (e: ElowenEvent) => void;
  subscribeEvents: (fn: (e: ElowenEvent) => void) => () => void;
  /** Push TRANSPORT (the core PushSender stays host-side); recipients are resolved in this plugin. */
  push: { sendToUsers(userIds: number[], payload: PushPayload): Promise<unknown> };
  /** Fallback checkout path when a project row is missing (bootstrap used homeProject.path). */
  homeProjectPath: string;
  /** The daemon's home project id, recorded on the advisor's spawn (the agent store needs one). */
  homeProjectId: number;
  /** Core advisor collaborators (user prefs/token, working dir, personality, brand) — resolved live
   *  because bootstrap wires them AFTER the plugin loads. Undefined ⇒ no tmux advisor in this process
   *  (sub-agent runner, minimal tests): the /advisor routes then degrade to "advisor unavailable". */
  advisorHost: () => PluginHostAdvisor | undefined;
  log: Logger;
}

const NUDGE_MAX = 2;

/** Build the overseer-model prompt that turns a finished mission's phase results into a short,
 *  human-readable Czech summary shown on the epic in the dashboard. Kept terse so the relay returns
 *  prose, not JSON or a plan. */
function missionSummaryPrompt(ctx: SummaryContext): string {
  const phases = ctx.phases
    .map((p, i) => `${i + 1}. ${p.title} — ${p.summary?.trim() || p.outcome || 'dokončeno'}`)
    .join('\n');
  return [
    'Jsi dozorčí autopilota. Mise právě skončila. Napiš stručné shrnutí v češtině (2–4 věty),',
    'co se v misi reálně udělalo, formálním tónem (vykání). Bez nadpisů, bez odrážek, jen plynulá próza.',
    '',
    `Cíl mise: ${ctx.goal}`,
    '',
    'Dokončené fáze:',
    phases,
  ].join('\n');
}

// Everything the agent-liveness sweep and its worker-action helpers read. Bundled once (in
// buildAgentsRuntime) so the persistent per-sweep state (deadSince/inflightChecks/progressLastAt/
// paneTracker) is created ONCE and threaded, not re-created each tick, and every store/service is
// read live exactly as before.
interface LivenessDeps {
  tmux: TmuxDriver;
  tasks: TaskStore;
  missions: MissionStore;
  bus: AgentsBusWithSink;
  config: PluginHostConfig;
  agents: AgentStore;
  decisionQueue: DecisionQueue;
  taskForSession: (session: string) => Task | null;
  missionIdForSession: (session: string) => string | null;
  usagePathFor: (task: { project_id: number; parent_id: string | null }) => string;
  resumeFallback: { program: string; model: string };
  clock: SystemClock;
  paneTracker: PaneActivityTracker;
  decisionDeadSince: Map<string, number>;
  inflightChecks: Set<string>;
  progressLastAt: Map<string, number>;
  log: Logger;
}

/** Escalate a wedged worker to a human — but never if its mission was torn down meanwhile (drain race). */
function escalateWorker(taskId: string, d: LivenessDeps): void {
  const task = d.tasks.get(taskId);
  if (!task || task.status === 'blocked') return;
  if (task.parent_id && !d.missions.activeForEpic(task.parent_id)) return; // mission gone → no-op
  d.tasks.setStatus(taskId, 'blocked');
  d.bus.publish({ type: 'task', taskId, status: 'blocked' });
}

/** Restart a wedged worker: kill its session and revert the task so the scheduler respawns it, resuming
 *  its session. Reuses the dead-agent stuck path (shared `stuck:<n>` budget bounds total churn). */
async function restartWorker(task: Task, d: LivenessDeps): Promise<void> {
  const name = task.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
  if (name) {
    try { captureResumeLabel({ tasks: d.tasks, pathFor: d.usagePathFor, fallback: d.resumeFallback }, task); } catch (e) { d.log.warn(`resume capture failed for ${task.id}`, e); }
    await d.tmux.kill(`elowen-${name}`).catch(() => { /* already gone */ });
  }
  if (d.tasks.bumpStuck(task.id) > 2) {
    d.tasks.setStatus(task.id, 'blocked');
    d.bus.publish({ type: 'task', taskId: task.id, status: 'blocked' });
  } else {
    d.tasks.setResumeNote(task.id, 'Your previous run stalled and was relaunched — re-check the current state (git status, build/tests) and carry the task to completion.');
    d.tasks.setStatus(task.id, 'open');
    d.bus.publish({ type: 'task', taskId: task.id, status: 'open' });
  }
}

/** Wake the overseer about a worker whose screen has gone static and act on its verdict. Mirrors the
 *  askService 'message' path: enqueue per-mission, fall straight to a human when there's no overseer. */
async function checkWorker(session: string, taskId: string, snapshot: string, idleMin: number, reason: 'idle' | 'progress', d: LivenessDeps): Promise<void> {
  const task = d.tasks.get(taskId);
  if (!task) return;
  const missionId = d.missionIdForSession(session);
  // No overseer to ask: a wedged worker escalates to a human; a routine progress glance just no-ops —
  // never block a healthy, working agent just because nobody happens to be watching.
  if (!missionId || !(d.missions.get(missionId)?.overseer_exec || d.config.get().autopilot.overseerExec)) { if (reason === 'idle') escalateWorker(taskId, d); return; }
  let verdict: DecisionResult;
  try { verdict = await d.decisionQueue.enqueue(missionId, 'check', { taskId, session, paneSnapshot: snapshot, idleMin, reason }); }
  catch (e) { d.log.error(`check enqueue failed for ${session}`, e); return; }
  const m = d.missions.get(missionId);
  const fresh = d.tasks.get(taskId) ?? task;
  const nudges = Number(fresh.labels.find((l) => l.startsWith('nudge:'))?.slice('nudge:'.length)) || 0;
  const action = checkAction(verdict, { reason, missionLive: !!m && (m.state === 'active' || m.state === 'stalled'), nudges, nudgeMax: NUDGE_MAX });
  switch (action.type) {
    case 'noop': return;
    case 'nudge':
      await d.tmux.sendRaw(session, action.text);
      await d.tmux.sendKeys(session, ['Enter']);
      d.tasks.bumpNudge(taskId);
      return;
    case 'steer':
      // Proactive course-correction to a working agent — delivered like a nudge but NOT counted against
      // the wedge nudge budget (it isn't a "this agent is stuck" poke).
      await d.tmux.sendRaw(session, action.text);
      await d.tmux.sendKeys(session, ['Enter']);
      return;
    case 'restart': await restartWorker(fresh, d); return;
    case 'escalate': escalateWorker(taskId, d); return;
  }
}

/** One liveness sweep tick: one signal — did the agent's tmux pane change since last look? — decides
 *  everything, so it works the same for any CLI tool (no timer/keyword parsing). A live but STATIC worker
 *  is woken via the overseer ('check'); a parked decision escalates only when its overseer is genuinely
 *  unsupervised. `deadSince`/`inflightChecks`/`paneTracker` (in deps) persist across sweeps. */
function runLivenessSweep(d: LivenessDeps): void {
  void sweepAgentLiveness({
    tmux: d.tmux, queue: d.decisionQueue, tracker: d.paneTracker, now: d.clock.now(),
    deadSince: d.decisionDeadSince, inflightChecks: d.inflightChecks, lastProgressAt: d.progressLastAt,
    sessionTaskId: (s) => d.taskForSession(s)?.id ?? null,
    programFor: (s) => d.agents.programFor(stripPrefix(s, 'elowen-')),
    hasPrompt: (content, program) => detectAgentPrompt(content, program) !== null,
    checkWorker: (session, taskId, snapshot, idleMin, reason) => checkWorker(session, taskId, snapshot, idleMin, reason, d),
    workerIdleMs: WORKER_IDLE_MS, overseerIdleMs: OVERSEER_IDLE_MS, graceMs: DECISION_GRACE_MS, hardMs: DECISION_HARD_MS,
    // Routine progress checks only make sense when there's an overseer to do them (0 disables).
    progressReviewMs: (d.config.get().autopilot.overseerExec || d.missions.live().some((m) => m.overseer_exec)) ? PROGRESS_REVIEW_MS : 0,
  })
    .then(({ escalated, checked }) => {
      if (escalated.length) d.log.warn(`liveness sweep escalated ${escalated.length} unanswered decision(s) to a human: ${escalated.join(', ')}`);
      if (checked.length) d.log.info(`liveness sweep woke the overseer about ${checked.length} idle worker(s): ${checked.join(', ')}`);
    })
    .catch((e) => d.log.error('liveness sweep failed', e));
}

/** One interval loop the host drives via ctx.registerInterval. */
interface AgentsInterval { name: string; ms: number; fn: () => void }

/** The interval periods, ms-for-ms what bootstrap's startLoops scheduled for this subsystem. Exported
 *  as a standalone map so the plugin entry can register the host timers WITHOUT constructing the
 *  runtime — construction stays lazy (the first tick builds it), which keeps a sub-agent runner
 *  (register-only, services never started) from ever assembling a second mission engine. */
export const AGENTS_INTERVAL_MS = {
  'engine-tick': 90000,
  'scheduler-tick': 30000,
  'janitor': 60000,
  'stuck-detector': 60000,
  'overseer-watchdog': 60000,
  'decision-sweep': DECISION_SWEEP_MS,
  'pr-feedback': 60_000,
} as const;

/** Assemble the whole tmux-agent subsystem from host deps. Pure construction + bus subscriptions —
 *  no loop is started here (the deriver's 5s loop starts via `deriver.start()`, the intervals are
 *  returned as definitions, and the boot reconciles are returned as functions). */
export function buildAgentsRuntime(deps: AgentsRuntimeDeps) {
  const { tmux, log } = deps;
  const tasks = deps.stores.tasks;
  const projects = deps.stores.projects;
  const users = deps.stores.users;

  // Plugin-owned stores over the shared main DB (grandfathered tables, migrated by the plugin entry).
  const agents = new AgentStore(deps.db);
  const missions = new MissionStore(deps.db);
  const missionPrs = new MissionPrStore(deps.db);
  const notes = new NoteStore(deps.db);

  // The bus adapter: publish/subscribe ride the host seams; `emit` wraps a deriver signal into the
  // `signal` event exactly like the core EventBus does (EventBus.emit).
  const bus: AgentsBusWithSink = {
    publish: deps.publishEvent,
    subscribe: deps.subscribeEvents,
    emit: (session, signal) => deps.publishEvent({ type: 'signal', session, signal }),
  };

  // SpawnService — constructed in brainCore.ts:216 in the core. The elowen CLI credential set and the
  // per-provider overrides come straight off the host seams; TDD mode resolves live from config.
  const spawn = new SpawnService({
    tmux, agents, elowen: deps.elowenCli,
    providers: (program) => deps.config.get().providers[program],
    prompts: deps.prompts,
    tddMode: () => deps.config.get().autopilot.tddMode,
  });
  // Late wiring, mirroring bootstrap's spawn.attachBrainWorker(brainWorkers): the BrainWorkerService is
  // constructed after the plugin loads, so the launcher resolves through the accessor per launch. The
  // error text matches SpawnService's own unattached message so callers see the same failure.
  spawn.attachBrainWorker({
    launch: (input) => {
      const worker = deps.brainWorker();
      if (!worker) throw new Error('elowen exec engine not available (brain not configured)');
      return worker.launch(input);
    },
  });

  // The overseer relay client, rebuilt per-call so a key set/cleared at runtime takes effect.
  // Overseer decisions use their own model when set, else fall back to the planner model.
  // Returns null when no API key is configured (callers then keep their pre-relay behaviour).
  const overseerClient = (): InferenceClient | null => {
    const cfg = deps.config.get(); const relay = deps.config.autopilotRelay();
    if (!relay) return null;
    return deps.relayClient({ baseUrl: relay.baseUrl, apiKey: relay.apiKey, model: deps.pluginConfig().overseerModel || cfg.autopilot.model });
  };
  // Shared reasoning stores: the async planning job registry and the per-mission decision queue.
  // The Pilot spawns a repo-aware planning agent for agent-mode plan jobs (relay path needs none);
  // the Overseer parks a per-mission agent that long-polls the decision queue.
  const planJobs = new PlanJobStore();
  const decisionQueue = new DecisionQueue();
  const pilot = makePilot({ spawn, config: deps.config, projects, planJobs, tmux, nameAgent: uniqueName, cli: deps.elowenCli.cli, prompts: deps.prompts });

  // PR-native git lifecycle (no-op unless Settings → PR workflow is enabled): each mission runs in an
  // isolated worktree on its own branch, commits per approved phase, and (later stages) opens a PR.
  const missionGit = new MissionGit({ prs: missionPrs, config: deps.config, pluginConfig: deps.pluginConfig, projects, tasks });

  // The overseer must be parked INSIDE the mission's worktree (via missionGit) so its read-only
  // `git diff` judges the agent's actual work, not the unchanged main checkout.
  const overseer = makeOverseer({ spawn, tmux, config: deps.config, queue: decisionQueue, cli: deps.elowenCli.cli, missionGit, missions, prompts: deps.prompts });

  // Phone push: a single bus subscriber maps lifecycle events (review escalation, needs_input, stall,
  // completion) to web-push notifications for the mission's owner + admins. The transport (PushSender)
  // stays in the core; this plugin resolves the recipients and hands over ids + payload.
  const stopPushDispatch = new PushDispatcher({ missions, tasks, users, sender: deps.push, missionGit }).subscribe(bus);
  // Snapshot each task's token/cost usage into task_usage as it settles, so the stats page reads
  // DB aggregates instead of re-scanning the CLIs' session stores. Resolve the same path the live
  // usage endpoint does (mission worktree under PR-native, else the project checkout). The same
  // path + fallback also drive resume-session capture (shared with the stuck detector below).
  const usagePathFor = (task: { project_id: number; parent_id: string | null }) =>
    usagePath(task, (pid) => projects.get(pid)?.path ?? deps.homeProjectPath, (id) => missionGit.worktreeFor(id));
  const resumeFallback = { program: 'claude-code', model: 'sonnet' };
  const stopUsageRecorder = new UsageRecorder({ usage: deps.stores.taskUsage, tasks, fallback: resumeFallback, pathFor: usagePathFor }).subscribe(bus);
  // The LIVE usage reader the core /tasks/:id/usage endpoint serves through the control — scans the
  // CLI's on-disk session store at the same path (mission worktree under PR-native, else the project
  // checkout) with the same fallback spec the recorder snapshots with, so live and settled agree.
  const liveTaskUsage = (taskId: string): TokenUsage | null => {
    const task = tasks.get(taskId);
    if (!task) return null;
    return readTaskUsage(task, tasks.list({ project_id: task.project_id }), usagePathFor(task), resumeFallback);
  };

  // The per-user tmux advisor. LAZY: its core collaborators (user prefs/token, dir, personality,
  // brand) are wired by bootstrap AFTER the plugin loads, so resolve them on first use; a process
  // without them (sub-agent runner, minimal tests) simply has no tmux advisor and the /advisor
  // routes degrade to "advisor unavailable".
  let advisorService: AdvisorService | null = null;
  const advisor = (): AdvisorService | undefined => {
    if (!advisorService) {
      const host = deps.advisorHost();
      if (!host) return undefined;
      advisorService = new AdvisorService({
        spawn: () => spawn, tmux: deps.tmux, host, config: deps.config, prompts: deps.prompts,
        fallback: resumeFallback, projectId: deps.homeProjectId,
        url: deps.elowenCli.url, mcpUrl: `${deps.elowenCli.url}/mcp`,
      });
    }
    return advisorService;
  };

  // One shared per-checkout git lock across the scheduler, mission engine and API server, so a phase's
  // commit+snapshot at close never interleaves with another agent's baseline read on the same checkout.
  const gitLock = new KeyedMutex();
  const engine = new MissionEngine({
    tasks, readiness: deps.stores.readiness, missions, users, spawn, tmux, bus, projects,
    fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: uniqueName, clock: new SystemClock(),
    overseer, missionGit, gitLock, git: deps.git,
    // On natural completion, ask the overseer model to write the mission's "what happened" prose.
    // No relay key → return blank so the engine writes its own deterministic phase digest instead.
    summarize: async (ctx) => {
      const inf = overseerClient();
      if (!inf) return '';
      const { text } = await inf.decide(missionSummaryPrompt(ctx));
      return text;
    },
  });
  const scheduler = new Scheduler({ tasks, spawn, bus, missions, users, projects, fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: uniqueName, clock: new SystemClock(), gitLock, git: deps.git, worktreeFor: (id) => missionGit.worktreeFor(id) });
  // Deriver resolves a session's task via the agent registry / in-progress task (simplified: first in_progress child).
  // Resolve a session's task via its agent:<name> label. Agent names recur across missions,
  // so pick the MOST RECENT match (list is created_at ASC) — never an old same-named task,
  // which would make the janitor reap a live agent or skip a real zombie.
  const taskForSession = (session: string): Task | null => {
    const name = stripPrefix(session, 'elowen-');
    const matches = tasks.list().filter((t) => t.labels.includes(`agent:${name}`));
    return matches[matches.length - 1] ?? null;
  };
  // NOTE: the core's bus→events.record subscriber (activity log) stays in bootstrap — the event store
  // is core-owned; it keeps recording plugin-published events through the shared bus unchanged.
  // The active mission owning a session (via its task's parent epic), or null for a manual launch.
  const missionIdForSession = (session: string): string | null => {
    const t = taskForSession(session);
    if (!t?.parent_id) return null;
    return missions.activeForEpic(t.parent_id)?.id ?? null;
  };
  // Render an inline overseer decision prompt through the task owner's overrides (else file default),
  // so a user's edited decision-* prompts drive the auto-clear/choice verdicts for their own tasks.
  const decisionRenderer = (taskId: string) => (name: string, vars?: Record<string, string>) =>
    deps.prompts.render(name, vars, resolveOwnerId({ tasks, missions, users }, { taskId }));
  const deriver = new Deriver({
    tmux, agents, tasks, sink: bus, clock: new SystemClock(),
    // Resolve strictly via the agent:<name> label. No global "first in-progress task" fallback:
    // the parked Overseer (elowen-overseer-<id>) and the Pilot have no task row, and the fallback would
    // mis-attribute their panes — even pressing accept-keys into the Overseer's TUI. Unresolved → skip.
    sessionTaskId: (session) => taskForSession(session)?.id ?? null,
    autonomyFor: (session) => {
      const t = taskForSession(session);
      if (!t?.parent_id) return null;
      return missions.activeForEpic(t.parent_id)?.autonomy ?? null;
    },
    missionFor: missionIdForSession,
    // Overseer decision for an auto-cleared prompt: the parked agent (queue) when overseerExec is set
    // and the prompt belongs to a mission, else the relay.
    decideApproval: async (input) => {
      // Per-autonomy confidence bar: L1 (Assist) is held stricter than L2/L3 so it auto-runs only
      // clearly-safe steps. One source of truth, applied on every gate path below.
      const minConfidence = minConfidenceFor(input.autonomy);
      // Persist what the autopilot decided against the task it ran for, so the detail pane can show the
      // agent↔autopilot conversation. Only the real overseer paths (queue/relay) record — the
      // no-overseer fallback has no verdict/rationale to show.
      const recordPrompt = (gated: { approve: boolean }, rationale: string, confidence: number) =>
        bus.publish({ type: 'decision', taskId: input.taskId, kind: 'prompt', question: input.question, outcome: gated.approve ? 'approved' : 'escalated', rationale, confidence });
      if (input.missionId && (missions.get(input.missionId)?.overseer_exec || deps.config.get().autopilot.overseerExec)) {
        const v = await decisionQueue.enqueue(input.missionId, 'prompt', { question: input.question, context: input.context, options: input.options });
        const gated = gateVerdict(v, { minConfidence });
        recordPrompt(gated, v.rationale, v.confidence);
        return gated;
      }
      const inf = overseerClient();
      // No overseer wired at all: only L3 may wave a prompt through; L1/L2 escalate
      // instead of being blindly approved (that blanket-approve was the bug that collapsed L2 into L3).
      if (!inf) return noOverseerFallback(input.autonomy);
      const d = await decidePrompt(inf, input, decisionRenderer(input.taskId));
      const gated = gateVerdict(d, { minConfidence });
      recordPrompt(gated, d.rationale, d.confidence);
      return gated;
    },
    // The agent asked the user to pick an option. This routes through the SAME overseer that judges
    // prompts/reviews: the parked agent via the decision queue when one is configured, else the relay
    // inference as a fallback. A null choiceId escalates to a human: no overseer, an unknown/absent
    // option id, or below the autonomy confidence bar.
    decideQuestion: async (input) => {
      const minConfidence = minConfidenceFor(input.autonomy);
      // Gate a raw verdict (parked agent OR relay) into a final choiceId: the picked id must be a real
      // option and clear the autonomy confidence bar.
      const gate = (choice: string | undefined, confidence: number) => {
        const chosen = choice ? input.options.find((o) => o.id === choice) : undefined;
        if (!chosen || confidence < minConfidence) return { choiceId: null };
        return { choiceId: chosen.id };
      };
      // Persist the question verdict (chosen option or escalation) for the task's conversation feed.
      const recordChoice = (res: { choiceId: string | null }, rationale: string, confidence: number) =>
        bus.publish({ type: 'decision', taskId: input.taskId, kind: 'choice', question: input.question, outcome: res.choiceId ? 'chose' : 'escalated', rationale, confidence, optionLabel: res.choiceId ? input.options.find((o) => o.id === res.choiceId)?.label : undefined });
      if (input.missionId && (missions.get(input.missionId)?.overseer_exec || deps.config.get().autopilot.overseerExec)) {
        const v = await decisionQueue.enqueue(input.missionId, 'question', { question: input.question, context: input.context, options: input.options });
        const res = gate(v.choice, v.confidence);
        recordChoice(res, v.rationale, v.confidence);
        return res;
      }
      const inf = overseerClient();
      if (!inf) return { choiceId: null };
      const v = await decideChoice(inf, input, decisionRenderer(input.taskId));
      const res = gate(v.choice === 'escalate' ? undefined : v.choice, v.confidence);
      recordChoice(res, v.rationale, v.confidence);
      return res;
    },
  });

  // Brain workers have no tmux pane — the stuck detector and startup reconcile must see their live
  // sessions or they would reap every running elowen task as dead.
  const liveSessions = { list: async () => [...(await tmux.list()), ...(deps.brainWorker()?.liveSessionNames() ?? [])] };

  // Root-cause recovery: after a daemon crash/restart, tasks left 'in_progress' whose tmux
  // session is gone are zombies — revert them to 'open' so they can be picked up again. No grace
  // or relaunch counter here: a restart isn't an agent death, so it shouldn't spend the budget.
  const reconcileZombies = async () => {
    const live = new Set((await liveSessions.list()).filter((s) => s.startsWith('elowen-')));
    for (const t of deadAgentTasks(live, tasks.list({ status: 'in_progress' }))) {
      tasks.setStatus(t.id, 'open');
      bus.publish({ type: 'task', taskId: t.id, status: 'open' });
    }
  };

  // After a restart the parked overseers are gone (their tmux sessions died with the daemon). When an
  // agent overseer is configured, re-park one per active mission and kill any orphan overseer session
  // whose mission is no longer active. Inert when overseerExec is empty (relay handles decisions).
  const reconcileOverseers = async () => {
    const live = new Set((await tmux.list()).filter((s) => s.startsWith('elowen-overseer-')));
    const activeIds = new Set(missions.active().map((m) => m.id));
    for (const s of live) {
      const id = s.replace('elowen-overseer-', '');
      if (!activeIds.has(id)) await tmux.kill(s).catch(() => { /* already gone */ });
    }
    for (const m of missions.active()) {
      if (!(m.overseer_exec || deps.config.get().autopilot.overseerExec)) continue;
      if (live.has(`elowen-overseer-${m.id}`)) continue;
      const epic = tasks.get(m.epic_id);
      const proj = epic ? projects.get(epic.project_id) : null;
      if (proj) await overseer.start(m.id, proj.id, proj.path);
    }
  };

  const clock = new SystemClock();
  // Universal agent-liveness sweep. One signal — did the agent's tmux pane change since last look? —
  // decides everything, so it works the same for any CLI tool (no timer/keyword parsing). A live but
  // STATIC worker is woken via the overseer ('check'); a parked decision escalates only when its
  // overseer is genuinely unsupervised (session dead past grace, or its OWN pane static past the bar),
  // never just because it's thinking. `deadSince`/`inflightChecks`/`paneTracker` persist across sweeps.
  // Persistent per-sweep state — created ONCE here and threaded through livenessDeps so it survives
  // across ticks (re-creating it each tick would forget every worker's last-seen pane / dead-since).
  const decisionDeadSince = new Map<string, number>();
  const inflightChecks = new Set<string>();
  const progressLastAt = new Map<string, number>();
  const paneTracker = new PaneActivityTracker();
  const livenessDeps: LivenessDeps = {
    tmux, tasks, missions, bus, config: deps.config, agents, decisionQueue,
    taskForSession, missionIdForSession, usagePathFor, resumeFallback,
    clock, paneTracker, decisionDeadSince, inflightChecks, progressLastAt, log,
  };

  // PR feedback loop (no-op unless PR mode + open PRs): poll each open PR for fresh actionable review
  // feedback and, within the fix budget, route it through the pilot (1..N fix phases on the mission's
  // exec) then re-engage the mission so an agent applies them. Relay-only (no agent pilot) degrades to
  // a single fix phase. The pilot plans in the mission's WORKTREE (not the main checkout) so it sees
  // the mission's committed changes — the code under review and the bug live on the branch, not in
  // the base checkout. The worker later applies the fix in that same worktree (missionEngine cwd).
  const replan: PrFeedbackDeps['replan'] = async ({ epicId, goal, exec }) => {
    const epic = tasks.get(epicId);
    const project = epic ? projects.get(epic.project_id) : null;
    const mission = missions.get(`m-${epicId}`);
    if (!epic || !project || !mission) return false;
    // PR-feedback CONTINUES a finished mission, so keep the existing review self-heal budgets rather
    // than resetting them on this re-engage. Flows through both the pilot and relay paths below.
    const engage = { autonomy: mission.autonomy, maxSessions: mission.max_sessions, preserveReviewBudget: true, pilotExec: mission.pilot_exec, overseerExec: mission.overseer_exec };
    if (mission.pilot_exec || deps.config.get().autopilot.pilotExec) {
      const cwd = missionGit.worktreeFor(`m-${epicId}`) ?? project.path;
      // engage flag → finalizePlanJob re-engages the mission AFTER the pilot pins the phases, so a
      // completed mission doesn't disengage in the gap between engage and the phases existing.
      const job = planJobs.create({ goal, projectId: epic.project_id, epicId, dryRun: false, exec, pilotExec: mission.pilot_exec || undefined, overseerExec: mission.overseer_exec || undefined, engage, createdBy: epic.created_by ?? null });
      bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
      void pilot(job, cwd).catch((e) => { planJobs.fail(job.id, String(e)); bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); });
      return true;
    }
    // Relay-only fallback: append one fix phase synchronously, then engage (the phase already exists).
    const ok = await missionGit.appendFixPhase(epicId, goal, exec);
    if (ok) await engine.engage({ epicId, ...engage });
    return ok;
  };

  // The interval definitions, ms-for-ms what bootstrap's startLoops schedules for this subsystem
  // (periods from AGENTS_INTERVAL_MS — one source shared with the plugin entry's timer registration).
  // (The deriver's own 5s loop is separate: `deriver.start()` returns its stop fn.)
  const intervals: AgentsInterval[] = [
    // Mission engine beat: tick every live mission.
    { name: 'engine-tick', ms: AGENTS_INTERVAL_MS['engine-tick'], fn: () => { for (const m of missions.live()) void engine.tick(m.id); } },
    // Scheduler: launch due autostart tasks + sync running tasks' change snapshots.
    { name: 'scheduler-tick', ms: AGENTS_INTERVAL_MS['scheduler-tick'], fn: () => { void scheduler.tick(); } },
    // Janitor: reap finished agents' zombie tmux sessions. Log what it reaps so the trail shows when a
    // session was cleaned up (and that the janitor is alive). Fire-and-forget — a sweep failure only logs.
    { name: 'janitor', ms: AGENTS_INTERVAL_MS['janitor'], fn: () => {
      void sweepFinishedSessions({ tmux, taskForSession })
        .then((reaped) => { if (reaped.length) log.info(`janitor reaped ${reaped.length} finished session(s): ${reaped.join(', ')}`); })
        .catch((e) => log.error('janitor sweep failed', e));
    } },
    // Stuck detector: an agent that died without `elowen close` leaves its task in_progress with a dead
    // session; revert it so the mission re-spawns (bounded), else escalate. 2-min grace covers the
    // spawn→session window; relaunch at most twice before escalating to a human. `now` is read per tick.
    { name: 'stuck-detector', ms: AGENTS_INTERVAL_MS['stuck-detector'], fn: () => {
      void sweepStuckTasks({ tmux: liveSessions, tasks, bus, now: clock.now(), graceMs: 120000, maxRelaunch: 2,
        // Stamp the dead agent's session for resume so the relaunch continues it (best-effort).
        onReap: (t) => { try { captureResumeLabel({ tasks, pathFor: usagePathFor, fallback: resumeFallback }, t); } catch (e) { log.warn(`resume capture failed for stuck task ${t.id}`, e); } } })
        .then(({ reverted, escalated }) => {
          if (reverted.length) log.warn(`stuck detector reverted ${reverted.length} dead-agent task(s) to open: ${reverted.join(', ')}`);
          if (escalated.length) log.error(`stuck detector escalated ${escalated.length} task(s) to blocked after max relaunches: ${escalated.join(', ')}`);
        })
        .catch((e) => log.error('stuck sweep failed', e));
    } },
    // Overseer watchdog: a parked overseer can die mid-mission (TUI crash, OOM) and would otherwise
    // leave the mission running unsupervised until the next daemon restart. reconcileOverseers is
    // idempotent — it re-parks a missing overseer for each active mission and kills orphans — so run
    // it periodically, not just on boot.
    { name: 'overseer-watchdog', ms: AGENTS_INTERVAL_MS['overseer-watchdog'], fn: () => { void reconcileOverseers().catch((e) => log.error('overseer watchdog failed', e)); } },
    // Agent-liveness / parked-decision sweep (see runLivenessSweep above).
    { name: 'decision-sweep', ms: AGENTS_INTERVAL_MS['decision-sweep'], fn: () => runLivenessSweep(livenessDeps) },
    // PR feedback loop (see replan above).
    { name: 'pr-feedback', ms: AGENTS_INTERVAL_MS['pr-feedback'], fn: () => {
      void sweepPrFeedback({ prs: missionPrs, missions, missionGit, bus, replan })
        .then((ids) => { if (ids.length) log.info(`PR feedback re-engaged ${ids.length} mission(s): ${ids.join(', ')}`); })
        .catch((e) => log.error('PR feedback sweep failed', e));
    } },
  ];

  return {
    // stores (plugin-owned tables)
    agents, missions, missionPrs, notes,
    // services
    spawn, overseerClient, planJobs, decisionQueue, pilot, missionGit, overseer, engine, scheduler, deriver,
    // resolution helpers (API routes and services build on these in later steps)
    taskForSession, missionIdForSession, decisionRenderer, usagePathFor, resumeFallback, liveSessions, gitLock, liveTaskUsage, advisor,
    // boot reconciles (ctx.registerBootReconcile) + interval loops (ctx.registerInterval)
    reconcileZombies, reconcileOverseers, intervals,
    /** Tear down the bus subscriptions (push dispatch + usage recorder). The registry also disposes
     *  ctx.subscribeEvents handlers on plugin reload, so calling this twice is safe. */
    dispose: () => { stopPushDispatch(); stopUsageRecorder(); },
  };
}

export type AgentsRuntime = ReturnType<typeof buildAgentsRuntime>;
