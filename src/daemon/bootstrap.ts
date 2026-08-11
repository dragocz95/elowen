import type { TaskStore } from '../store/taskStore.js';
import type { AgentStore } from '../store/agentStore.js';
import type { MissionStore } from '../store/missionStore.js';
import { MissionPrStore } from '../store/missionPrStore.js';
import { MissionEngine } from '../overseer/missionEngine.js';
import { MissionGit } from '../overseer/missionGit.js';
import type { SummaryContext } from '../overseer/missionEngine.js';
import type { Task } from '../store/types.js';
import { Scheduler } from '../overseer/scheduler.js';
import { sweepFinishedSessions } from '../overseer/janitor.js';
import { sweepPrFeedback, type PrFeedbackDeps } from '../overseer/prFeedback.js';
import { sweepStuckTasks, deadAgentTasks } from '../overseer/stuckDetector.js';
import { decidePrompt, decideChoice, gateVerdict, minConfidenceFor, noOverseerFallback } from '../overseer/decision.js';
import { PlanJobStore } from '../overseer/planJob.js';
import { DecisionQueue, type DecisionResult } from '../overseer/decisionQueue.js';
import { sweepAgentLiveness, checkAction, WORKER_IDLE_MS, OVERSEER_IDLE_MS, DECISION_GRACE_MS, DECISION_HARD_MS, DECISION_SWEEP_MS, PROGRESS_REVIEW_MS } from '../overseer/livenessSweep.js';
import { PaneActivityTracker } from '../overseer/paneActivity.js';
import { detectAgentPrompt } from '../deriver/shellPatterns/index.js';
import { makePilot } from '../overseer/pilotAgent.js';
import { makeOverseer } from '../overseer/overseerAgent.js';
import { RelayClient } from '../inference/client.js';
import { Deriver } from '../deriver/deriver.js';
import type { EventBus } from '../api/sse.js';
import { eventProjectId, type EventProjectDeps } from '../api/eventProject.js';
import { createServer } from '../api/server.js';
import { ELOWEN_VERSION } from '../api/version.js';
import { createSkillService } from '../api/services/skillService.js';
import { createTicketStore } from '../terminal/ticketStore.js';
import { RealTmuxDriver } from '../tmux/driver.js';
import { SystemClock } from '../shared/clock.js';
import type { ConfigStore } from '../store/configStore.js';
import { ensureVapidKeys } from '../push/vapid.js';
import { PushSender } from '../push/pushSender.js';
import { PushDispatcher } from '../push/pushDispatcher.js';
import { buildTurnDone } from '../push/messages.js';
import { KeyedMutex } from '../shared/keyedMutex.js';
import { stripPrefix } from '../shared/text.js';
import { resolveOwnerId } from '../prompts/owner.js';
import { UsageRecorder } from '../integrations/usage/recorder.js';
import { captureResumeLabel } from '../integrations/usage/resumeCapture.js';
import { usagePath } from '../integrations/usage/usagePath.js';
import type { TmuxDriver } from '../tmux/types.js';
import { uniqueName } from './uniqueName.js';
import { lifecycleNotice } from './lifecycleNotices.js';
import { logger, setLogSink } from '../shared/logger.js';
import { PluginLogBuffer } from '../shared/logBuffer.js';
import { AdvisorService } from '../advisor/service.js';
import { writeMcpConfig } from '../advisor/mcpConfig.js';
import type { BrainService } from '../brain/brainService.js';
import { BrainTerminalService } from '../brain/terminalService.js';
import { processRegistry } from '../brain/processRegistry.js';
import { isSubagentSession } from '../brain/sessionId.js';
import type { MemoryStore } from '../store/memoryStore.js';
import { USAGE_HISTORY_DAYS } from '../store/memoryStore.js';
import { isEvictable, vitality, type MemoryRetentionConfig } from '../brain/memoryVitality.js';
import { sweepChatImages } from '../brain/chatImages.js';
import { discoverPlugins } from '../plugins/loader.js';
import { MarketplaceService } from '../plugins/marketplace.js';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { systemctl } from '../cli/systemd.js';
import { BrainWorkerService } from '../brain/worker/brainWorker.js';
import { buildBrainCore } from './brainCore.js';
import { SubagentRunnerPool } from '../subagent/pool.js';
import { resolvePoolMax } from '../subagent/sizing.js';
import type { RuntimeConfig } from '../shared/wireContract.js';
import type { PluginRegistryProvider } from '../plugins/pluginsProvider.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { WORKFLOW_ADD_NODES_RPC, type HostRpcHandler } from '../subagent/hostRpc.js';

const log = logger('daemon');

/** Daemon endpoint for reverse workflow expansion, split out so the post-await liveness fence is testable. */
export function createWorkflowHostRpc(resolvePlugins: () => Promise<PluginRegistry | undefined>): HostRpcHandler {
  return async (caller, request) => {
    if (request.method !== WORKFLOW_ADD_NODES_RPC) throw new Error(`unsupported host RPC: ${request.method}`);
    const workflow = (await resolvePlugins())?.control('workflow');
    if (!workflow) throw new Error('the workflow engine is unavailable in the daemon');
    // Registry loading is asynchronous. A result/error/abort can retire the runner turn while it waits;
    // recheck immediately before the synchronous mutation so expired authority cannot add late nodes.
    if (!caller.isActive()) throw new Error('the host RPC caller turn is no longer active');
    return workflow.addNodesFromSession({
      callerSessionId: caller.sessionId,
      callerAccess: caller.access,
      ...(caller.model ? { callerModel: caller.model } : {}),
      workflowId: request.workflowId,
      nodes: request.nodes,
    });
  };
}

const MEMORY_EVICTION_BATCH_SIZE = 1_000;

export interface MemoryEvictionSweepDeps {
  memories: Pick<MemoryStore, 'listActiveForEviction' | 'softDelete'>;
  users: { list(): Iterable<{ id: number }> };
  retention: () => MemoryRetentionConfig;
  now: () => number;
}

/** Soft-delete low-vitality active memories while retaining an auditable, restorable trail. */
export function runMemoryEvictionSweep(deps: MemoryEvictionSweepDeps): number {
  const retention = deps.retention();
  if (!retention.enabled) return 0;

  const now = deps.now();
  let removed = 0;
  for (const user of deps.users.list()) {
    for (const memory of deps.memories.listActiveForEviction(user.id, MEMORY_EVICTION_BATCH_SIZE)) {
      if (!isEvictable(memory, retention, now)) continue;
      const score = vitality(memory, retention, now);
      const reason = `auto-evict: vitality ${score.toFixed(2)} < ${retention.vitalityFloor}`;
      if (deps.memories.softDelete(user.id, memory.id, 'daemon', reason)) removed += 1;
    }
  }
  return removed;
}

// Bounded ring of recent log lines, installed as the logger's single sink so it captures every
// emitted line (including plugin output prefixed `[plugin:<name>]` and `plugin skipped: <name>`).
// Feeds the admin per-plugin logs + health views. Best-effort: a full ring just evicts its oldest.
const pluginLogs = new PluginLogBuffer();
setLogSink(pluginLogs);

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

/** A boot announced less than this ago suppresses the next one, so a crash-looping daemon reports the
 *  first restart and then goes quiet instead of flooding the channel. Deliberately longer than systemd's
 *  RestartSec and far shorter than any plausible gap between two real deploys. */
const BOOT_ANNOUNCE_DEBOUNCE_MS = 60_000;

/** How long a shutdown waits for running work to finish before exiting anyway.
 *
 *  Ten minutes, because the work being waited for is a MODEL TURN: an agent thinking, or a sub-agent
 *  researching, routinely runs for minutes, and the first version's 60s cut one off and lost its result.
 *  A budget shorter than the work it is protecting is not a graceful shutdown, just a delayed kill.
 *
 *  MUST stay below the unit's TimeoutStopSec (set to 11 minutes in systemdUnits.ts), because when that
 *  expires systemd sends SIGKILL — the exact outcome this drain exists to prevent. The two numbers are a
 *  pair: raising this one without raising the unit's just moves the kill earlier. `elowen down` waits
 *  longer still, so it observes the exit rather than timing out on it, and `--force` is the way out for
 *  anyone who cannot wait. */
const SHUTDOWN_DRAIN_MS = 600_000;
const SHUTDOWN_POLL_MS = 500;

/** Once the platforms are back up, announce that the daemon is running — for EVERY boot, not just a
 *  user-triggered `/restart`. A deploy, a crash and a host reboot all bring the daemon back without anyone
 *  being told, and the unattended restart is precisely the one worth hearing about.
 *
 *  The wording distinguishes the two, because they answer different questions: after `/restart` the
 *  operator is waiting for a confirmation, while an unexpected boot needs to say WHICH build came up.
 *
 *  The `/restart` marker holds the request timestamp and is honoured only while RECENT — a stale marker
 *  (a failed restart whose cleanup never ran) must not make a later boot claim to be that restart. It is
 *  always cleared, so it can only ever be read once.
 *
 *  A user-triggered restart bypasses the crash-loop debounce: it was explicitly asked for, so it is
 *  confirmed however soon it follows another boot. Best-effort throughout — an announcement failure must
 *  never affect startup. Silent without a state dir (the `:memory:` test daemon), which also keeps the
 *  test suite from posting to real channels. */
/** Drain and exit on SIGTERM/SIGINT instead of dying where we stand.
 *
 *  The daemon had NO signal handler, so a deploy's `systemctl restart` killed it at whatever instruction
 *  it happened to be executing: a turn mid-stream, a sub-agent mid-task, both simply gone. This waits for
 *  the work to finish first, and says so on the platforms — the stop is the half nobody was told about,
 *  since only the following boot ever announced itself.
 *
 *  A SECOND signal exits immediately. Someone sending it twice is telling us they are not waiting, and
 *  that is also the escape hatch if the drain itself ever wedges. `elowen down --force` skips straight to
 *  SIGKILL and never reaches this code at all.
 *
 *  Handlers registered once, at boot. Exit code 0 throughout: a drained shutdown is a clean one, and
 *  `Restart=on-failure` must not read a deliberate stop as a crash to bounce back from. */
export function installGracefulShutdown(
  brain: BrainService | undefined,
  log: { info: (m: string) => void; error: (m: string, e?: unknown) => void },
  opts?: { drainMs?: number; pollMs?: number; exit?: (code: number) => never; notify?: boolean },
): void {
  const drainMs = opts?.drainMs ?? SHUTDOWN_DRAIN_MS;
  const pollMs = opts?.pollMs ?? SHUTDOWN_POLL_MS;
  const exit = opts?.exit ?? ((code: number) => process.exit(code));
  let draining = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (draining) {
      log.info(`${signal} again — exiting now, without waiting for the remaining work`);
      exit(0);
      return;
    }
    draining = true;
    // Stop admitting new turns at once, so fresh input arriving through the drain window cannot keep
    // busy() above zero for the whole budget. Existing turns, delegation and result delivery are
    // unaffected — they reach the brain through seams other than the two gated send() entries.
    brain?.beginDrain();
    void (async () => {
      const at = brain?.busy() ?? { turns: 0, children: 0, undelivered: 0 };
      const busy = at.turns > 0 || at.children > 0 || at.undelivered > 0;
      log.info(`${signal} — draining (${at.turns} turn(s), ${at.children} sub-agent(s), ${at.undelivered} undelivered result(s))`);
      if (opts?.notify !== false) {
        // Only worth a message when something is actually being waited for; an idle restart already
        // announces itself on the way back up, and saying it twice is noise.
        const { text, notice } = busy
          ? lifecycleNotice('stopping', at.turns, at.children, at.undelivered)
          : lifecycleNotice('stoppingIdle');
        await brain?.notify(text, undefined, notice).catch(() => { /* best-effort: never block the exit on a chat API */ });
      }
      const deadline = Date.now() + drainMs;
      for (;;) {
        const now = brain?.busy() ?? { turns: 0, children: 0, undelivered: 0 };
        if (now.turns === 0 && now.children === 0 && now.undelivered === 0) break;
        if (Date.now() >= deadline) {
          log.error(`drain budget expired with ${now.turns} turn(s), ${now.children} sub-agent(s) and ${now.undelivered} undelivered result(s) — exiting anyway`);
          break;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      log.info('drained — exiting');
      exit(0);
    })();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

export async function announceBoot(
  brain: BrainService | undefined,
  restartMarker: string | undefined,
  bootMarker: string | undefined,
  version: string,
): Promise<void> {
  if (!bootMarker) return;
  let requested = false;
  if (restartMarker && existsSync(restartMarker)) {
    try { requested = Date.now() - Number(readFileSync(restartMarker, 'utf8')) < 5 * 60_000; } catch { /* unreadable → treat as stale */ }
    try { unlinkSync(restartMarker); } catch { /* already gone */ }
  }
  if (!requested) {
    try {
      const last = Number(readFileSync(bootMarker, 'utf8'));
      if (Number.isFinite(last) && Date.now() - last < BOOT_ANNOUNCE_DEBOUNCE_MS) return;
    } catch { /* no previous announcement — this is the first */ }
  }
  try { writeFileSync(bootMarker, String(Date.now())); } catch { /* the guard is a nicety, not required */ }
  const { text, notice } = requested ? lifecycleNotice('backOnline') : lifecycleNotice('backOnlineVersion', version);
  await brain?.notify(text, undefined, notice).catch(() => { /* best-effort */ });
}

/** Janitor tick: reap finished agents' zombie tmux sessions. Log what it reaps so the trail shows when a
 *  session was cleaned up (and that the janitor is alive). Fire-and-forget — a sweep failure only logs. */
function runJanitorSweep(d: { tmux: TmuxDriver; taskForSession: (session: string) => Pick<Task, 'status'> | null }): void {
  void sweepFinishedSessions({ tmux: d.tmux, taskForSession: d.taskForSession })
    .then((reaped) => { if (reaped.length) log.info(`janitor reaped ${reaped.length} finished session(s): ${reaped.join(', ')}`); })
    .catch((e) => log.error('janitor sweep failed', e));
}

/** Stuck-detector tick: an agent that died without `elowen close` leaves its task in_progress with a dead
 *  session; revert it so the mission re-spawns (bounded), else escalate. 2-min grace covers the
 *  spawn→session window; relaunch at most twice before escalating to a human. `now` is read per tick. */
function runStuckSweep(d: {
  liveSessions: { list(): Promise<string[]> };
  tasks: TaskStore; bus: EventBus; now: number;
  usagePathFor: (task: { project_id: number; parent_id: string | null }) => string;
  resumeFallback: { program: string; model: string };
}): void {
  void sweepStuckTasks({ tmux: d.liveSessions, tasks: d.tasks, bus: d.bus, now: d.now, graceMs: 120000, maxRelaunch: 2,
    // Stamp the dead agent's session for resume so the relaunch continues it (best-effort).
    onReap: (t) => { try { captureResumeLabel({ tasks: d.tasks, pathFor: d.usagePathFor, fallback: d.resumeFallback }, t); } catch (e) { log.warn(`resume capture failed for stuck task ${t.id}`, e); } } })
    .then(({ reverted, escalated }) => {
      if (reverted.length) log.warn(`stuck detector reverted ${reverted.length} dead-agent task(s) to open: ${reverted.join(', ')}`);
      if (escalated.length) log.error(`stuck detector escalated ${escalated.length} task(s) to blocked after max relaunches: ${escalated.join(', ')}`);
    })
    .catch((e) => log.error('stuck sweep failed', e));
}

// Everything the agent-liveness sweep and its worker-action helpers read. Bundled once (in startLoops) so
// the persistent per-sweep state (deadSince/inflightChecks/progressLastAt/paneTracker) is created ONCE and
// threaded, not re-created each tick, and every store/service is read live exactly as before.
interface LivenessDeps {
  tmux: TmuxDriver;
  tasks: TaskStore;
  missions: MissionStore;
  bus: EventBus;
  config: ConfigStore;
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
}

const NUDGE_MAX = 2;

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
    try { captureResumeLabel({ tasks: d.tasks, pathFor: d.usagePathFor, fallback: d.resumeFallback }, task); } catch (e) { log.warn(`resume capture failed for ${task.id}`, e); }
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
  catch (e) { log.error(`check enqueue failed for ${session}`, e); return; }
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
      if (escalated.length) log.warn(`liveness sweep escalated ${escalated.length} unanswered decision(s) to a human: ${escalated.join(', ')}`);
      if (checked.length) log.info(`liveness sweep woke the overseer about ${checked.length} idle worker(s): ${checked.join(', ')}`);
    })
    .catch((e) => log.error('liveness sweep failed', e));
}

export interface BuildOpts {
  dbPath: string;
  project: { id: number; slug: string; path: string };
  relay: { baseUrl: string; apiKey: string; model: string } | null;
  tmux?: TmuxDriver;
  bootstrap?: { username: string; password: string } | null;
  allowOpen?: boolean;
}

export async function buildApp(opts: BuildOpts) {
  const tmux = opts.tmux ?? new RealTmuxDriver();
  // The sub-agent runner POOL. Constructed here — never inside buildBrainCore — because it is the one
  // thing a runner must NOT have: a process built without it always executes a nested delegation itself,
  // so a runner can never fork a runner. Nothing is forked until a delegated turn is dispatched AND the
  // operator's switch is on (Settings → runtime.subagentRunnerEnabled, off by default); it then grows
  // lazily up to a cap it measures off this machine. The in-memory test database has no file for a second
  // process to attach to, so it never gets one.
  //
  // The pool size knob is read through a late-bound getter: the config store is built by buildBrainCore
  // below, and the knob is only ever consulted on a delegated turn, long after that has returned.
  let runtimeConfigForPool: (() => RuntimeConfig) | undefined;
  // Same late binding, same reason: the plugin registry is built by buildBrainCore below, and this is only
  // ever read when a runner is being forked — long after that returned.
  let pluginsForPool: PluginRegistryProvider | undefined;
  const subagentRunner = opts.dbPath !== ':memory:'
    ? new SubagentRunnerPool({
      dbPath: opts.dbPath,
      project: opts.project,
      // What the daemon's OWN registry bridges right now. The mcp plugin is the single source: it holds
      // the tool definitions it registered from, so a runner registers from the same data through the same
      // code. Absent control (plugin disabled, or a registry that will not load) ⇒ no snapshot ⇒ the
      // runner connects at boot, exactly as before.
      mcpBridgeSnapshot: async () => (await pluginsForPool?.get())?.control('mcp')?.bridgeSnapshot(),
      // Reverse calls terminate in the daemon plugin instance that owns the in-memory DAG. The host has
      // already replaced all child-supplied identity with the session derived from its active turn table.
      hostRpc: createWorkflowHostRpc(async () => pluginsForPool?.get()),
      // Explicit: a delegated turn's cwd ends in `process.cwd()`, so a child forked with a different
      // one would change what the model is told about where it is running.
      cwd: process.cwd(),
      poolMax: () => resolvePoolMax(runtimeConfigForPool?.().subagentRunnerPoolMax, process.env.ELOWEN_SUBAGENT_POOL_MAX),
      // The same predicate the dispatcher routes on, so /health reports what delegated turns ACTUALLY do
      // rather than what the machine would allow them to do.
      enabled: () => runtimeConfigForPool?.().subagentRunnerEnabled === true,
    })
    : undefined;
  // Stores, plugin registry and brain services — the part of the daemon that is NOT the daemon: it holds
  // no server, no platform gateway, no scheduler and no loop, so a second process can build the identical
  // brain by calling the same factory instead of re-deriving the wiring.
  const {
    db, tasks, agents, missions, readiness, config, users, homeProject, projects, userProjects,
    pushSubscriptions, userPrompts, userSettings, prompts, taskUsage, git,
    cli, cliArgv, elowenCli, spawn, bus, events, notes,
    avatarsDir, chatImagesDir, pluginDirs, userPluginDir, pluginDataRoot,
    brainRuntime, brainCreds, brainOauth, brainConfig, embeddings,
    brainStore, memoryStore, memoryCategoryStore, embedQueue, memoryCategorizer,
    pluginProvider, hookAudit, brain, themes, brand, loadedPlugins, setPluginHostBrainWorker, setPluginHostPush,
  } = await buildBrainCore({
    dbPath: opts.dbPath,
    project: opts.project,
    tmux,
    bootstrap: opts.bootstrap,
    ...(subagentRunner ? { subagentRunner } : {}),
    // An owner turn finished with the device it was sent from off screen → push it to the user's phone.
    // No subscription registered ⇒ sendToUsers is a no-op, so this needs no separate enable flag. Web push
    // is a daemon transport, so the hook is passed IN: the sender is built below out of the core's own
    // stores (hence resolved on use, not on wiring) and a process without that transport just omits it.
    notifyTurnComplete: (userId, title, preview) => { void pushSender.sendToUsers([userId], buildTurnDone({ title, preview, productName: brand().productName })); },
  });
  // Close the late binding opened above the pool: from here the knob resolves against the live store,
  // so raising or zeroing it takes effect on the next delegated turn with no restart.
  runtimeConfigForPool = () => config.get().runtime;
  pluginsForPool = pluginProvider;
  ensureVapidKeys(config); // generate the web-push VAPID keypair on first boot (idempotent thereafter)
  // The overseer relay client, rebuilt per-call so a key set/cleared at runtime takes effect.
  // Overseer decisions use their own model when set, else fall back to the planner model.
  // Returns null when no API key is configured (callers then keep their pre-relay behaviour).
  const overseerClient = () => {
    const cfg = config.get(); const relay = config.autopilotRelay();
    if (!relay) return null;
    return new RelayClient({ baseUrl: relay.baseUrl, apiKey: relay.apiKey, model: cfg.autopilot.overseerModel || cfg.autopilot.model });
  };
  // Shared reasoning stores: the async planning job registry and the per-mission decision queue.
  // The Pilot spawns a repo-aware planning agent for agent-mode plan jobs (relay path needs none);
  // the Overseer parks a per-mission agent that long-polls the decision queue.
  const planJobs = new PlanJobStore();
  const decisionQueue = new DecisionQueue();
  const pilot = makePilot({ spawn, config, projects, planJobs, tmux, nameAgent: uniqueName, cli, prompts });

  // PR-native git lifecycle (no-op unless Settings → PR workflow is enabled): each mission runs in an
  // isolated worktree on its own branch, commits per approved phase, and (later stages) opens a PR.
  const missionPrs = new MissionPrStore(db);
  const missionGit = new MissionGit({ prs: missionPrs, config, projects, tasks });

  // The overseer must be parked INSIDE the mission's worktree (via missionGit) so its read-only
  // `git diff` judges the agent's actual work, not the unchanged main checkout.
  const overseer = makeOverseer({ spawn, tmux, config, queue: decisionQueue, cli, missionGit, missions, prompts });

  // Phone push: a single bus subscriber maps lifecycle events (review escalation, needs_input, stall,
  // completion) to web-push notifications for the mission's owner + admins. No-op until a user
  // subscribes a device and (implicitly) VAPID keys exist — generated above on first boot.
  // Contact is read per send, so changing it in Settings reaches the next notification without a restart.
  const pushSender = new PushSender(pushSubscriptions, () => config.webPushKeys(), undefined,
    () => ({ configured: config.get().webPushContact, instanceUrl: elowenCli.url }));
  // …and the plugin host's late binding, so ctx.host.push() resolves (the agents plugin's dispatcher).
  setPluginHostPush(pushSender);
  new PushDispatcher({ missions, tasks, users, sender: pushSender, missionGit }).subscribe(bus);
  // Snapshot each task's token/cost usage into task_usage as it settles, so the stats page reads
  // DB aggregates instead of re-scanning the CLIs' session stores. Resolve the same path the live
  // usage endpoint does (mission worktree under PR-native, else the project checkout). The same
  // path + fallback also drive resume-session capture (shared with the stuck detector below).
  const usagePathFor = (task: { project_id: number; parent_id: string | null }) =>
    usagePath(task, (pid) => projects.get(pid)?.path ?? homeProject.path, (id) => missionGit?.worktreeFor(id));
  const resumeFallback = { program: 'claude-code', model: 'sonnet' };
  new UsageRecorder({ usage: taskUsage, tasks, fallback: resumeFallback, pathFor: usagePathFor }).subscribe(bus);

  // One shared per-checkout git lock across the scheduler, mission engine and API server, so a phase's
  // commit+snapshot at close never interleaves with another agent's baseline read on the same checkout.
  const gitLock = new KeyedMutex();
  const engine = new MissionEngine({
    tasks, readiness, missions, users, spawn, tmux, bus, projects,
    fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: uniqueName, clock: new SystemClock(),
    overseer, missionGit, gitLock,
    // On natural completion, ask the overseer model to write the mission's "what happened" prose.
    // No relay key → return blank so the engine writes its own deterministic phase digest instead.
    summarize: async (ctx) => {
      const inf = overseerClient();
      if (!inf) return '';
      const { text } = await inf.decide(missionSummaryPrompt(ctx));
      return text;
    },
  });
  const scheduler = new Scheduler({ tasks, spawn, bus, missions, users, projects, fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: uniqueName, clock: new SystemClock(), gitLock, worktreeFor: (id) => missionGit?.worktreeFor(id) });
  // Deriver resolves a session's task via the agent registry / in-progress task (simplified: first in_progress child).
  // Resolve a session's task via its agent:<name> label. Agent names recur across missions,
  // so pick the MOST RECENT match (list is created_at ASC) — never an old same-named task,
  // which would make the janitor reap a live agent or skip a real zombie.
  const taskForSession = (session: string) => {
    const name = stripPrefix(session, 'elowen-');
    const matches = tasks.list().filter((t) => t.labels.includes(`agent:${name}`));
    return matches[matches.length - 1] ?? null;
  };
  // Persist every bus event into the activity log, stamping its owning project (resolved for ALL event
  // types, not just task/review) so the timeline can be scoped per-tenant. Subscribed here — after
  // taskForSession exists — because resolving a signal event's project needs it.
  const eventDeps: EventProjectDeps = {
    taskProject: (id) => tasks.get(id)?.project_id ?? null,
    sessionProject: (s) => taskForSession(s)?.project_id ?? null,
    jobProject: (id) => planJobs.get(id)?.projectId ?? null,
    // Live registry read (not a snapshot): a plugin reload swaps the resolver set with it.
    pluginResolvers: () => (loadedPlugins()?.eventProjectResolvers ?? []).map((r) => r.fn),
  };
  bus.subscribe((e) => { try { events.record(e, eventProjectId(e, eventDeps)); } catch (err) { log.error('event record failed', err); } });
  // The active mission owning a session (via its task's parent epic), or null for a manual launch.
  const missionIdForSession = (session: string): string | null => {
    const t = taskForSession(session);
    if (!t?.parent_id) return null;
    return missions.activeForEpic(t.parent_id)?.id ?? null;
  };
  // Render an inline overseer decision prompt through the task owner's overrides (else file default),
  // so a user's edited decision-* prompts drive the auto-clear/choice verdicts for their own tasks.
  const decisionRenderer = (taskId: string) => (name: string, vars?: Record<string, string>) =>
    prompts.render(name, vars, resolveOwnerId({ tasks, missions, users }, { taskId }));
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
      if (input.missionId && (missions.get(input.missionId)?.overseer_exec || config.get().autopilot.overseerExec)) {
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
      if (input.missionId && (missions.get(input.missionId)?.overseer_exec || config.get().autopilot.overseerExec)) {
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
  // Setup mode: with no users yet the daemon is open so the onboarding page can run before login;
  // auth (in authMiddleware) re-engages automatically once the first admin is created.
  if (users.count() === 0) {
    log.warn('SETUP MODE — no users yet; the API is open until the first admin is created via onboarding');
  }
  // Per-process secret for short-lived signed avatar URLs (finding W2) — keeps the long-lived session
  // token out of <img> src query strings. Rotates on restart; links live ~5 min, so that's harmless.
  const avatarSecret = randomBytes(32).toString('hex');
  // Per-user advisor: a persistent assistant session controlling Elowen on the user's behalf. Its cwd
  // is a neutral per-user dir (alongside the DB, NOT a project checkout) so the per-program MCP config
  // never pollutes a repo. Disabled for the in-memory DB (tests build their own AdvisorService).
  const mcpUrl = `${elowenCli.url}/mcp`; // the daemon hosts the MCP server on its own /mcp route
  const advisor = opts.dbPath === ':memory:' ? undefined : new AdvisorService({
    spawn, tmux, users, config, fallback: { program: 'claude-code', model: 'sonnet' },
    projectId: homeProject.id, url: elowenCli.url, mcpUrl,
    advisorDir: (id) => { const p = join(dirname(opts.dbPath), 'advisor', String(id)); mkdirSync(p, { recursive: true }); return p; },
    prepareMcp: (program, cwd, token) => writeMcpConfig(program, cwd, token, mcpUrl),
    prompts,
    advisorStyle: (id) => userSettings.cliSettings(id).advisorStyle,
    brand,
  });
  // Admin-only interactive `elowen chat` terminals bound to existing brain conversations. Its cwd is a
  // neutral per-admin scratch dir alongside the DB (never a project checkout), mirroring the advisor dir.
  // Constructed after `brain` (it needs store+users+url); the delete-conversation teardown is attached back
  // onto the brain via a late setter to avoid a constructor cycle (mirrors spawn.attachBrainWorker).
  const brainTerminal = opts.dbPath === ':memory:' ? undefined : new BrainTerminalService({
    tmux, users, store: brainStore, url: elowenCli.url, cliArgv,
    terminalDir: (id) => { const p = join(dirname(opts.dbPath), 'terminal', String(id)); mkdirSync(p, { recursive: true }); return p; },
  });
  if (brain && brainTerminal) brain.attachTerminalTeardown((userId, sessionId) => brainTerminal.stopForSession(userId, sessionId));
  // A delegated child running in the sub-agent runner can delegate FURTHER, inside that same process. The
  // abort tree, `/stop` and the shutdown gate are authoritative here, so those nested edges are mirrored
  // into this registry — and retracted wholesale if the runner dies.
  if (brain && subagentRunner) {
    subagentRunner.attachChildEdgeSink((parentSessionId, childSessionId, running) =>
      brain.mirrorRemoteChildEdge(parentSessionId, childSessionId, running));
  }
  // Wake the operator's conversation when a background command they started finishes ON ITS OWN (a killed
  // one is dropped before its close fires, so it never wakes). Delivered as an INTERNAL turn — no 'you'
  // bubble, and it runs after any in-flight turn — so a completed build/command nudges the agent instead of
  // the operator having to poke it manually. Best-effort: a wake failure is swallowed.
  // Keep the owner's live process panels (CLI + web) in step out of turn: every spawn/exit/kill pushes
  // the fresh snapshot to the owner's client streams, so a killed/finished process leaves the panel
  // without the client polling (single source of truth — no local delete on the click path).
  processRegistry.setChangeListener((sessionId) => {
    if (sessionId) brain?.broadcastProcesses(sessionId, processRegistry.listForSession(sessionId));
  });
  processRegistry.setExitListener((info, userId, sessionId) => {
    if (!brain || userId == null) return;
    // An active delegated child owns its background-process continuation inside the subagent plugin: its
    // collect loop waits for session idle and runs the same child again to collect output before
    // completing the parent result. That loop is the SOLE owner of subagent exit continuation — a second
    // daemon wake here would race and duplicate it. (Real delegate session ids are `brain-ch-subagent-*`.)
    if (sessionId != null && isSubagentSession(sessionId)) return;
    const status = info.exitCode === 0 ? 'finished successfully' : `exited (code ${info.exitCode})`;
    const text = `⚙️ Background command \`${info.command}\` ${status}. If it matters, read its output with `
      + `ProcessOutput("${info.id}") and continue; otherwise just carry on.`;
    // `systemNudge`: no 'you' bubble, dropped if the target session is already streaming, and it never
    // drives the goal loop (so a wake can't spend a goal-budget turn or mis-judge an active goal). Bound to
    // the session the command was started in — not whatever conversation is currently active.
    void brain.send({
      userId,
      text,
      mode: 'build',
      internal: { kind: 'systemNudge' },
      session: sessionId ?? undefined,
    })
      .catch(() => { /* best-effort wake */ });
  });
  // The elowen exec engine: tasks with an `elowen:` exec run on an embedded PI session instead of a
  // spawned CLI. Shares the brain's providers/auth/plugins; closes tasks through the same REST route.
  const brainWorkers = new BrainWorkerService({
    store: brainStore, tasks, bus, taskUsage, chatImagesDir,
    config: brainConfig, runtime: brainRuntime, prompts,
    url: elowenCli.url, token: elowenCli.token,
    plugins: pluginProvider, // the SAME shared registry — a plugin toggle reaches workers too
    userSettings: (userId) => userSettings.cliSettings(userId), // the task owner's auto-compact threshold
  });
  spawn.attachBrainWorker(brainWorkers);
  // …and the plugin host's late binding, so ctx.host.brainWorker() resolves from now on.
  setPluginHostBrainWorker(brainWorkers);
  // Brain workers have no tmux pane — the stuck detector and startup reconcile must see their live
  // sessions or they would reap every running elowen task as dead.
  const liveSessions = { list: async () => [...(await tmux.list()), ...brainWorkers.liveSessionNames()] };
  // Single-use ticket store for the terminal WebSocket stream — shared between the authenticated
  // `POST /sessions/:name/ws-ticket` route and the daemon's `/ws/terminal` upgrade handler.
  const tickets = createTicketStore();
  // The plugin marketplace: install/update/remove plugins from the curated GitHub registry into the
  // writable user plugin dir (pluginDirs[1]), applied live via the brain's plugin hot-reload. The registry
  // repo is a shallow-clone cache next to the DB; ELOWEN_PLUGIN_REGISTRY overrides the repo URL (tests).
  // The host node_modules that installed plugins symlink so their SDK imports resolve. Derived from a real
  // dependency's resolved path (robust to the dist layout) — the SAME modules the daemon itself loads, so a
  // plugin always sees the matching SDK version.
  const hostNodeModules = (() => {
    try {
      const p = createRequire(import.meta.url).resolve('typebox');
      const marker = `${sep}node_modules${sep}`;
      const i = p.lastIndexOf(marker);
      return i >= 0 ? p.slice(0, i + marker.length - 1) : undefined;
    } catch { return undefined; }
  })();
  const marketplace = new MarketplaceService({
    registryUrl: (process.env.ELOWEN_PLUGIN_REGISTRY) || undefined,
    cacheDir: join(dirname(opts.dbPath), 'marketplace'),
    userPluginsDir: userPluginDir,
    hostNodeModules,
    pluginDataRoot,
    discovered: () => discoverPlugins(pluginDirs),
    getEnabled: () => config.get().plugins.enabled,
    setEnabled: (names) => { config.update({ plugins: { enabled: names } }); },
    reload: () => brain?.reloadPlugins() ?? Promise.resolve(),
  });
  marketplace.sweep(); // clear crash debris (.staging-*/.old-*) left by an interrupted install
  // The admin-only `/restart` slash command: announce it on the platforms (Discord main channel), drop a
  // marker so the NEXT boot announces "back online", then hand off to systemd. Runs in prod only (a
  // :memory: test DB has no config dir + no units). `setTimeout` lets the HTTP response flush before the
  // process is torn down. systemctl() self-elevates via sudo when not root (www-data has passwordless).
  const restartMarker = opts.dbPath !== ':memory:' ? join(dirname(opts.dbPath), '.restart-marker') : undefined;
  // Timestamp of the last boot announcement — the crash-loop debounce in announceBoot. Same state dir,
  // and likewise absent under the in-memory test DB so the suite never announces.
  const bootMarker = opts.dbPath !== ':memory:' ? join(dirname(opts.dbPath), '.boot-announce') : undefined;
  const restartDaemon = restartMarker
    ? async (byUserId: number): Promise<void> => {
        log.info(`/restart requested by user ${byUserId}`);
        const restartingNotice = lifecycleNotice('restarting');
        await brain?.notify(restartingNotice.text, undefined, restartingNotice.notice).catch(() => { /* best-effort */ });
        // Drop the marker (timestamped) so the NEXT boot echoes "back online" — but ONLY for a restart that
        // actually takes. systemctl() resolves an exit code (never throws); on failure the daemon keeps
        // running, so we must undo the marker + tell the operator, or a future unrelated boot would falsely
        // announce recovery.
        try { writeFileSync(restartMarker, String(Date.now())); } catch { /* marker is a nicety, not required */ }
        setTimeout(() => {
          void systemctl('restart', 'elowen-daemon').then((r) => {
            if (r.code !== 0) {
              log.error(`/restart failed (systemctl exit ${r.code}): ${r.stdout.trim()}`);
              try { unlinkSync(restartMarker); } catch { /* nothing to undo */ }
              const failed = lifecycleNotice('restartFailed');
              void brain?.notify(failed.text, undefined, failed.notice).catch(() => { /* best-effort */ });
            }
            // On success this process is torn down before the promise settles — nothing more to do.
          });
        }, 800);
      }
    : undefined;
  // Late-bind the restart handler onto the brain so a platform `/restart` slash (Discord) reaches the
  // same systemd path the web/CLI command uses. Built here (needs the units + marker), wired now.
  if (brain && restartDaemon) brain.restartHandler = restartDaemon;

  const app = createServer({ tasks, readiness, missions, engine, missionGit, gitLock, spawn, tmux, bus, events, notes, agents, project: homeProject, fallback: { program: 'claude-code', model: 'sonnet' }, cli, clock: new SystemClock(), config, users, projects, userProjects, pushSubscriptions, userPrompts, userSettings, pluginDirs, pluginDataRoot, brainOauth, brainAuth: brainCreds, prompts, taskUsage, git, avatarsDir, avatarSecret, chatImagesDir, planJobs, decisionQueue, pilot, advisor, brain, brainTerminal, restartDaemon, brainWorkers, brainStore, memoryStore, memoryCategoryStore, memoryCategorizer, embeddings, plugins: pluginProvider, marketplace, pluginLogs, hookAudit, tickets, themes, ...(subagentRunner ? { subagentPool: () => subagentRunner.stats() } : {}) });

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
      if (!(m.overseer_exec || config.get().autopilot.overseerExec)) continue;
      if (live.has(`elowen-overseer-${m.id}`)) continue;
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
    // Restart zombies on the brain side: goals still marked 'active' whose in-memory continuation timers
    // died with the process. Pause them so nothing falsely claims to be running (the user /goal resumes).
    try { brain?.reconcileGoalsOnBoot(); } catch (e) { log.error('reconcileGoalsOnBoot failed', e); }
    // Same on the delegation side: sub-agent runs and workflow DAGs still marked 'running' whose in-memory
    // children died with the process. Synchronous and BEFORE startPlatforms, so no channel turn — and no
    // client connecting the moment the port opens — can observe (or act on) a phantom running delegation.
    try { brain?.reconcileDelegationsOnBoot(); } catch (e) { log.error('reconcileDelegationsOnBoot failed', e); }
    // One-shot: reap chat terminals + tokens orphaned while the daemon was down (tmux died / conversation
    // deleted), and kill stray `elowen-chat-*` panes with no binding. Periodic sweep is scheduled below.
    void brainTerminal?.sweep().catch((e) => log.error('brain terminal sweep failed', e));
    // Bring up plugin platform channels (Discord bot, …). Fail-open per adapter. Once they are connected,
    // announce that the daemon is up — every boot, with the wording depending on whether an operator
    // `/restart` asked for it.
    void brain?.startPlatforms(log)
      .then(() => announceBoot(brain, restartMarker, bootMarker, ELOWEN_VERSION))
      // Boot phase 2 of delegation recovery: respawn the interrupted sub-agents claimed above, now that the
      // platforms are up so their turns can actually run. After announceBoot, with its own catch, so a
      // recovery failure neither blocks the boot announcement nor is misreported as a startPlatforms error.
      .then(() => brain?.runDelegationRecovery().catch((e) => log.error('delegation recovery failed', e)))
      .catch((e) => log.error('startPlatforms failed', e));
    // Registered only once the platforms are coming up, so a stop can actually announce itself. Skipped
    // under the in-memory test DB, where installing process-wide signal handlers would leak across tests.
    if (opts.dbPath !== ':memory:') installGracefulShutdown(brain, log);
    void reconcileOverseers().catch((e) => log.error('reconcileOverseers failed', e)); // re-park overseers for active missions / kill orphans
    // Self-heal the agent-workflow skill: (re)install the bundled `elowen-workflow` SKILL.md into every
    // present provider on boot. Best-effort — installAll catches its own per-provider errors and never
    // throws, so this can't block or crash startup. Covers `elowen install` (first boot) and `elowen update`
    // (restart) with one code path, always as the spawning user. Skipped under the in-memory test DB.
    if (opts.dbPath !== ':memory:') {
      const done = createSkillService().installAll().filter((r) => r.installed).map((r) => r.provider);
      if (done.length) log.info(`installed elowen-workflow skill for: ${done.join(', ')}`);
    }
    const stopDeriver = deriver.start();
    const stopOverseer = clock.setInterval(() => { for (const m of missions.live()) void engine.tick(m.id); }, 90000);
    const stopScheduler = clock.setInterval(() => { void scheduler.tick(); }, 30000);
    // Janitor: reap finished agents' zombie tmux sessions (body: runJanitorSweep).
    const stopJanitor = clock.setInterval(() => runJanitorSweep({ tmux, taskForSession }), 60000);
    // Stuck detector: revert/escalate tasks whose agent died without `elowen close` (body: runStuckSweep).
    const stopStuck = clock.setInterval(() => runStuckSweep({ liveSessions, tasks, bus, now: clock.now(), usagePathFor, resumeFallback }), 60000);
    // Overseer watchdog: a parked overseer can die mid-mission (TUI crash, OOM) and would otherwise
    // leave the mission running unsupervised until the next daemon restart. reconcileOverseers is
    // idempotent — it re-parks a missing overseer for each active mission and kills orphans — so run
    // it periodically, not just on boot.
    const stopOverseerWatchdog = clock.setInterval(() => { void reconcileOverseers().catch((e) => log.error('overseer watchdog failed', e)); }, 60000);
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
      tmux, tasks, missions, bus, config, agents, decisionQueue,
      taskForSession, missionIdForSession, usagePathFor, resumeFallback,
      clock, paneTracker, decisionDeadSince, inflightChecks, progressLastAt,
    };
    const stopDecisionSweep = clock.setInterval(() => runLivenessSweep(livenessDeps), DECISION_SWEEP_MS);
    // Purge expired auth tokens hourly so the table can't grow unbounded over a long-running daemon.
    const purgeTokens = () => users?.purgeExpiredTokens(config.get().security.tokenTtlDays);
    purgeTokens();
    const stopTokenPurge = clock.setInterval(purgeTokens, 3_600_000);
    // Same for the activity timeline: every bus event is persisted (events.record), so without a
    // retention sweep the `events` table grows without bound. Drop rows past the operator's retention
    // window (Elowen AI → Runtime) hourly; read live so a change applies on the next sweep.
    const purgeEvents = () => {
      try { events.purgeOlderThan(config.get().runtime.limits.eventRetentionDays); }
      catch (e) { log.error('event purge failed', e); }
    };
    purgeEvents();
    const stopEventPurge = clock.setInterval(purgeEvents, 3_600_000);
    // Optional session retention (admin, off by default): hourly, delete each user's own idle
    // conversations older than the configured age. Skips running/active/has-running-child sessions,
    // conversations a pending cron wake-up is bound to, and the non-user channel/task shells (enforced
    // in BrainService + the store query). No-op while disabled. Async: the purge consults the plugin
    // registry (the cronjob wake-up seam), so the sweep awaits each user in turn.
    const purgeStaleSessions = async () => {
      const retention = config.get().sessionRetention;
      if (!retention.enabled || !brain || !users) return;
      try {
        let removed = 0;
        for (const user of users.list()) removed += await brain.purgeStaleSessionsForUser(user.id, retention.days);
        if (removed > 0) log.info(`session retention: removed ${removed} conversation(s) older than ${retention.days} days`);
      } catch (e) { log.error('session retention sweep failed', e); }
    };
    void purgeStaleSessions();
    const stopSessionPurge = clock.setInterval(() => void purgeStaleSessions(), 3_600_000);
    // Retention is a daily, bounded soft-delete sweep. Deleted memories remain in the trash and keep
    // their audit trail, so an operator can restore a false positive.
    const sweepMemoryRetention = () => {
      try {
        const removed = runMemoryEvictionSweep({
          memories: memoryStore,
          users: { list: () => users.list() },
          retention: () => config.get().runtime.memoryRetention,
          now: () => clock.now(),
        });
        if (removed > 0) log.info(`memory retention: soft-deleted ${removed} memory item(s)`);
      } catch (e) { log.error('memory retention sweep failed', e); }
      // Recall events are the one memory table that grows with traffic (hundreds of rows a day), so it
      // is pruned by age. Its own try: an eviction failure must not leave the log growing unbounded.
      try {
        const dropped = memoryStore.purgeUsageEventsOlderThan(USAGE_HISTORY_DAYS);
        if (dropped > 0) log.info(`memory retention: dropped ${dropped} recall event(s) older than ${USAGE_HISTORY_DAYS} days`);
      } catch (e) { log.error('memory usage-event purge failed', e); }
    };
    sweepMemoryRetention();
    const stopMemoryRetentionSweep = clock.setInterval(sweepMemoryRetention, 86_400_000);
    // Chat attachments outlive their turn on purpose, but not their message: a turn discarded before it
    // produced output, or a deleted conversation, leaves files nothing points at. Reclaim them daily,
    // keeping anything written in the last hour — a turn writes its files before committing the row that
    // references them, so a sweep landing in between must not delete a live attachment.
    // A message queued mid-turn is the exception the grace period cannot cover: its files are written at
    // admission but its row only at delivery, so a turn running longer than an hour would leave them
    // looking abandoned. Ask the live sessions what is still in flight and treat that as referenced too.
    const sweepChatAttachments = () => {
      if (!chatImagesDir) return;
      try {
        const referenced = brainStore.referencedChatImages();
        for (const file of brain?.pendingChatImageFiles() ?? []) referenced.add(file);
        const removed = sweepChatImages(chatImagesDir, referenced, 3_600_000, clock.now());
        if (removed > 0) log.info(`chat images: removed ${removed} unreferenced attachment(s)`);
      } catch (e) { log.error('chat image sweep failed', e); }
    };
    sweepChatAttachments();
    const stopChatImageSweep = clock.setInterval(sweepChatAttachments, 86_400_000);
    // Sweep expired terminal-WS tickets so a burst of unredeemed tickets can't grow the map unbounded.
    const stopTicketSweep = clock.setInterval(() => tickets.sweep(clock.now()), 60_000);
    // Reconcile chat terminals against live tmux: reap orphaned tokens/bindings and stray `elowen-chat-*`
    // panes. Backstops the proactive teardown (self-exit `/quit`, delete-conversation) so nothing leaks.
    const stopTerminalSweep = clock.setInterval(() => {
      void brainTerminal?.sweep().catch((e) => log.error('brain terminal sweep failed', e));
    }, 60_000);
    // Reap live PI sessions nobody watches and nothing runs in. A client's binding expires on its own
    // TTL, but the RUNTIME was owned by no one: a browser tab closed over a running agent (which no
    // longer stops it) would otherwise leak its session until the daemon restarted. The countdown starts
    // only once a session is both unwatched and idle, so a long unattended run is never cut short.
    const stopIdleSessionReap = clock.setInterval(() => {
      void brain?.reapIdleLiveSessions().catch((e) => log.error('idle live-session reap failed', e));
    }, 60_000);
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
      if (mission.pilot_exec || config.get().autopilot.pilotExec) {
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
    const stopPrFeedback = clock.setInterval(() => {
      void sweepPrFeedback({ prs: missionPrs, missions, missionGit, bus, replan })
        .then((ids) => { if (ids.length) log.info(`PR feedback re-engaged ${ids.length} mission(s): ${ids.join(', ')}`); })
        .catch((e) => log.error('PR feedback sweep failed', e));
    }, 60_000);
    const stopBrainWorkerWatchdog = brainWorkers.startWatchdog();
    // Memory embed queue: fill in missing/stale memory vectors in the background. No-ops until an
    // embedding provider/model is configured; one bad memory never aborts a drain (caught + logged).
    const stopEmbedQueue = clock.setInterval(() => {
      void embedQueue.drain().catch((e) => log.error('embed queue drain failed', e));
    }, 30_000);
    return () => { stopDeriver(); stopOverseer(); stopScheduler(); stopJanitor(); stopStuck(); stopOverseerWatchdog(); stopDecisionSweep(); stopTokenPurge(); stopEventPurge(); stopSessionPurge(); stopMemoryRetentionSweep(); stopChatImageSweep(); stopTicketSweep(); stopTerminalSweep(); stopIdleSessionReap(); stopPrFeedback(); stopBrainWorkerWatchdog(); stopEmbedQueue(); };
  };
  return { app, startLoops, tickets, tmux };
}
