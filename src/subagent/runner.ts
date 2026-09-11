/** THE SUB-AGENT RUNNER PROCESS.
 *
 *  A delegated turn used to execute on the daemon's single JS thread, next to the interactive path. Under
 *  twenty concurrent sub-agents that path starves — measured: event-loop p99 4366 ms, worst `/health`
 *  8.59 s. This process exists so the turn body runs somewhere else and the daemon's loop stays free.
 *
 *  It is a full brain core (same stores, same plugins, same prompts — see buildBrainCore) with the
 *  daemon's own layers deliberately absent:
 *   - NO boot reconcile. `reconcileDelegationsOnBoot` terminalizes every `running` delegation row it
 *     cannot see live in ITS OWN memory; from here that would kill the daemon's live children.
 *   - NO second HTTP port, no platform gateway, no cron, no platform automation loop or other daemon-only services. The ONE
 *     platform it does start is `subagent` — that adapter is how delegation is wired at all, and without
 *     its `listen` the plugin's `run` handle stays null and a NESTED delegation fails outright. Nested
 *     delegation therefore stays inside this same runner (this process holds no runner of its own).
 *   - NO migrations: the daemon owns the schema and this process is forked only after it finished.
 *   - NO elicitor reachable by a client. A delegated turn has no attached client anyway, so `askUser`
 *     behaves here exactly as it does in-process: it parks and times out.
 *
 *  The abort tree stays authoritative in the DAEMON (its fencing is synchronous in-memory
 *  read-modify-write across sessions), so abort arrives as an explicit verb and this process only carries
 *  it out. Store writes are its own: it holds its own connection and writes its own sessions' rows. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { logger, setLogScopePrefix } from '../shared/logger.js';
import { startLoopLagMonitor } from '../shared/eventLoopLag.js';
import { HEARTBEAT_INTERVAL_MS, LAG_WINDOW_MS } from './sizing.js';
import { buildBrainCore } from '../daemon/brainCore.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { BrainService } from '../brain/brainService.js';
import { DelegationAbortedError } from '../brain/session/liveRegistry.js';
import { processHandleOwnedByAccount, processRegistry } from '../brain/processRegistry.js';
import type { BrainStore } from '../store/brainStore.js';
import { parseDelegatedTurnRequest, toDelegatedProgress } from '../brain/delegatedTurn.js';
import { SUBAGENT_PLATFORM, channelSessionId } from '../brain/sessionId.js';
import { parseDaemonMessage, subagentBuildId, type RunnerToDaemon } from './protocol.js';
import type { McpBridgeSnapshot } from '../plugins/mcpSnapshot.js';
import { currentSessionId } from '../plugins/policyContext.js';
import { HostRpcClient, WORKFLOW_ADD_NODES_RPC, type WorkflowExpansionRpc } from './hostRpc.js';
import { runnerReloadActivityCount } from './activity.js';

// A runner writes into the daemon's own log file and builds the same brain core, so its lines carry the
// same scopes the daemon's do (`[daemon] plugin loaded: …`). The pid is what makes them attributable —
// and with several runners live, tells them apart from each other.
setLogScopePrefix(`runner:${process.pid} `);

const log = logger('subagent-runner');

/** Boot trace: one INFO line per phase, carrying both the phase's own cost and the total since node
 *  started (`process.uptime()`, so the FIRST phase includes node's own start plus the import of every
 *  module above — 2.1 s cold, measured, and invisible to anything started later). The daemon can only see
 *  fork→ready from outside, so where those seconds went is either recorded here or not recorded at all. */
let phaseAtMs = 0;
function phase(name: string, note?: string): void {
  const now = Math.round(process.uptime() * 1000);
  log.info(`boot: ${name} +${now - phaseAtMs}ms (${now}ms total)${note ? ` — ${note}` : ''}`);
  phaseAtMs = now;
}
phase('entry', 'node start + module import');

/** The runner has no business launching tmux panes: agent spawning, the advisor terminal and mission
 *  workers all belong to the daemon. buildBrainCore takes the driver from its caller precisely so a
 *  process like this can hand in one that refuses instead of silently starting panes nobody reaps. */
const REFUSING_TMUX: TmuxDriver = {
  spawn: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  spawnArgv: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  resize: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  sendKeys: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  sendRaw: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  capturePane: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  capturePaneAnsi: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  list: () => Promise.resolve([]),
  kill: () => Promise.resolve(),
};

const send = (message: RunnerToDaemon): boolean => {
  try {
    if (!process.connected || !process.send) return false;
    process.send(message);
    return true;
  } catch {
    return false;
  }
};

const rpcTurn = new AsyncLocalStorage<{ turnId: string; sessionId: string }>();
const hostRpc = new HostRpcClient(send, randomUUID);
const workflowExpansionRpc: WorkflowExpansionRpc = {
  addNodes: ({ workflowId, nodes }) => {
    const caller = rpcTurn.getStore();
    // Async context from the outer dispatched turn is inherited by nested delegations. Requiring the live
    // plugin turn to still be that DIRECT session prevents a grandchild from borrowing its ancestor's RPC
    // identity and expanding a workflow it was never a node of.
    if (!caller || currentSessionId() !== caller.sessionId) {
      return Promise.reject(new Error('WorkflowAddNodes RPC is available only to the directly dispatched sub-agent turn'));
    }
    return hostRpc.call(caller.turnId, { method: WORKFLOW_ADD_NODES_RPC, workflowId, nodes });
  },
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Sessions whose turn is currently in flight here, so an abort/release can tell "working on it" from
 *  "merely holds an idle record". Keyed by CHANNEL id, which is what both verbs address. */
const runningChannels = new Set<string>();
/** The parent→child edges of the turns THIS process was handed. They are already registered in the
 *  daemon's registry (synchronously, before it forwarded anything), so reporting them upward again would
 *  let the runner's own end-of-turn retraction clear an edge the daemon still owns. */
const dispatchedEdges = new Set<string>();
const edgeKey = (parentSessionId: string, childSessionId: string): string => `${parentSessionId}\u0000${childSessionId}`;

/** Channels this process still holds a live session record for. Distinct from {@link runningChannels}:
 *  a channel stays HELD after its turn ends (that is the point — the next turn reuses the warm session)
 *  and is only let go on release. Reported in the heartbeat so a runner's real session count is visible. */
const heldChannels = new Set<string>();
/** Full live streams requested by an authenticated daemon drill-in. These exist only while the matching
 * SSE is open; ordinary delegated progress stays on the deliberately narrow low-frequency wire path. */
const liveTaps = new Map<string, () => void>();

/** How late THIS process runs its own timers. The daemon cannot see this from outside — a runner chewing
 *  through tool results and one idling between provider responses look identical over IPC — so the pool's
 *  whole "is this runner saturated" question is answered here or not at all. The window is a few
 *  heartbeats wide so each beat describes the recent past rather than the last minute (see sizing.ts). */
const loopLag = startLoopLagMonitor(LAG_WINDOW_MS);

const heartbeat = setInterval(() => {
  send({
    type: 'heartbeat',
    loopP99Ms: loopLag.lag().p99,
    activeTurns: runningChannels.size,
    sessions: heldChannels.size,
    rssBytes: process.memoryUsage.rss(),
    // Kill tokens of THIS registry's running children: if the process dies abruptly (SIGKILL, crash),
    // these are what the daemon can still sweep by — the token lives in the child's own /proc environ,
    // immune to PID reuse and covering escaped descendants.
    killTokens: processRegistry.killTokens(),
  });
}, HEARTBEAT_INTERVAL_MS);
// A metric must never be the reason this process outlives the work it was forked for.
heartbeat.unref();

let brain: BrainService | undefined;
/** The core's store, for the ONE cross-check a runner makes on its own: whose session a null-account
 *  (delegated) process handle belongs to when an account is being torn down. */
let brainStore: BrainStore | undefined;
/** Turns accepted before the core finished booting. Node delivers IPC messages as soon as the channel is
 *  up, which is well before plugins are loaded. */
let booting: Promise<void> | undefined;

async function boot(
  dbPath: string,
  project: { id: number; slug: string; path: string },
  mcpBridgeSnapshot: McpBridgeSnapshot | undefined,
): Promise<void> {
  const core = await buildBrainCore({
    dbPath,
    project,
    tmux: REFUSING_TMUX,
    // The daemon already connected every configured MCP server and knows what each one bridges, so this
    // process declares the identical tools from that snapshot and connects a server only if one of its
    // tools is actually CALLED. Without it every runner launched its own copy of every server — in
    // production a whole Chrome per runner, ~2.5 s of this boot, and a process tree the pool's RSS-based
    // sizing cannot see. Absent ⇒ connect at boot, exactly as before.
    ...(mcpBridgeSnapshot ? { mcpBridgeSnapshot } : {}),
    workflowExpansionRpc,
    // The daemon prepared this database; a process attaching to it must not create accounts…
    bootstrap: null,
    // …nor take the write lock to re-prove a schema that is already final.
    migrate: false,
    // `notifyTurnComplete` is deliberately omitted: web push is a daemon transport (it holds the
    // subscriptions and the VAPID keys), and a delegated turn has nobody to notify anyway.
  });
  if (!core.brain) throw new Error('the brain is not available for this database');
  phase('core built');
  // Loading is lazy, and `startPlatforms` below would trigger it anyway — pulled forward ONLY so the
  // plugin load (every plugin, every MCP server) is a phase of its own in the log instead of being
  // charged to platform startup.
  await core.pluginProvider.get();
  // Say WHICH of the two MCP paths this boot took. Without it the difference between "declared 29 tools
  // from a snapshot" and "launched 29 tools' worth of servers" is invisible in the phase timing alone.
  const bridged = mcpBridgeSnapshot?.reduce((n, s) => n + s.tools.length, 0);
  phase('plugins loaded', mcpBridgeSnapshot
    ? `${bridged} bridged MCP tool(s) declared from the daemon's snapshot — no MCP server connected`
    : undefined);
  brain = core.brain;
  brainStore = core.brainStore;
  // Registry changes here would otherwise never reach the daemon's live process panels (the CLI drill-in
  // hydrates once, then rides `process` events). Report the affected session; the daemon re-projects it.
  // The listener dies with this process — there is nothing to unregister.
  processRegistry.setChangeListener((sessionId) => {
    // The snapshot rides the frame: the daemon re-projects exactly what this registry holds for the
    // session at change time, instead of re-asking and mistaking a wedged round trip for "empty".
    if (sessionId) send({ type: 'processesChanged', sessionId, processes: processRegistry.listForSession(sessionId) });
  });
  // Report NESTED delegated edges upward. The daemon's LiveSessionRegistry is the authoritative abort
  // tree, so it has to see work happening over here — but never the edge of the dispatched turn itself,
  // which it registered on its own before forwarding.
  core.brain.attachDelegatedEdgeReporter((parentSessionId, childSessionId, running) => {
    if (dispatchedEdges.has(edgeKey(parentSessionId, childSessionId))) return;
    send({ type: 'child', parentSessionId, childSessionId, running });
  });
  // The `subagent` adapter ONLY — see the header. This is what gives the plugin its `run` handle, so a
  // sub-agent here can delegate further without leaving the process.
  await core.brain.startPlatforms(log, [SUBAGENT_PLATFORM]);
}

async function runTurn(turnId: string, rawRequest: unknown, text: string): Promise<void> {
  await booting;
  const service = brain;
  if (!service) { send({ type: 'error', turnId, message: 'the sub-agent runner has no brain' }); return; }
  // Internal traffic, still validated like persisted JSON: a turn whose boundary does not normalize is
  // REFUSED. Running it under an ambient policy is the one failure mode this whole path must not have.
  const request = parseDelegatedTurnRequest(rawRequest);
  if (!request) { send({ type: 'error', turnId, message: 'invalid delegated access' }); return; }
  const childSessionId = channelSessionId(request.channelId);
  const edge = edgeKey(request.parentSessionId, childSessionId);
  runningChannels.add(request.channelId);
  heldChannels.add(request.channelId);
  dispatchedEdges.add(edge);
  try {
    const reply = await rpcTurn.run({ turnId, sessionId: childSessionId }, () => service.runDelegatedTurn(request, text, (e) => {
      // ONLY the low-frequency shapes the delegating plugin consumes, including nested-work lifecycle
      // signals. Text deltas, tool arguments, DAG bodies and transcripts never cross: re-amplifying them
      // over IPC would put back the event-loop pressure this process removes.
      const progress = toDelegatedProgress(e);
      if (progress) send({ type: 'progress', turnId, event: progress });
    }));
    send({ type: 'result', turnId, reply });
  } catch (e) {
    send({ type: 'error', turnId, message: errorText(e) });
  } finally {
    runningChannels.delete(request.channelId);
    dispatchedEdges.delete(edge);
  }
}

process.on('message', (raw: unknown) => {
  const msg = parseDaemonMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'boot': {
      if (booting) return; // already booted; a second boot frame is not a reason to build a second core
      const own = subagentBuildId();
      if (msg.buildId !== own) {
        // An in-place rebuild under a live daemon is exactly this: a child forked from code its parent is
        // not running. Refuse rather than serve turns from a different build.
        send({ type: 'fatal', reason: `build mismatch (daemon ${msg.buildId}, runner ${own})` });
        process.exit(2);
      }
      booting = boot(msg.dbPath, msg.project, msg.mcp).then(
        () => { phase('ready'); send({ type: 'ready', buildId: own }); },
        (e: unknown) => { send({ type: 'fatal', reason: errorText(e) }); process.exit(3); },
      );
      return;
    }
    case 'turn':
      void runTurn(msg.turnId, msg.request, msg.text);
      return;
    case 'abort':
      // The daemon has already fenced the delegation in its own registry; this is the half only the
      // process holding the PI session can do.
      void brain?.abortChannel(msg.channelId, msg.abort).catch((e: unknown) => log.warn(`abort failed: ${errorText(e)}`));
      return;
    case 'steer': {
      // A DelegateContinue on a child running HERE: inject the parent's follow-up into the live turn.
      // The daemon already authorized the caller; this process only carries the injection out. The
      // answer can take as long as the child's current model call (steerChannel resolves only once the
      // message is confirmed in the child's context), which is exactly what the blocking tool promises.
      // Detached like a turn — a long steer must not stall the IPC handler for every other channel.
      void (async (): Promise<void> => {
        await booting;
        try {
          const outcome = brain ? await brain.steerChannel(msg.channelId, msg.text) : 'idle';
          send({ type: 'steered', steerId: msg.steerId, outcome });
        } catch (e) {
          // The abort fences reject with exactly this message; anything else is a failure to steer, and
          // for the daemon "could not inject here" and "no turn here" oblige the same fallback.
          const aborted = e instanceof DelegationAbortedError || (e instanceof Error && e.message === 'delegation aborted');
          if (!aborted) log.warn(`steer failed: ${errorText(e)}`);
          send({ type: 'steered', steerId: msg.steerId, outcome: aborted ? 'aborted' : 'idle' });
        }
      })();
      return;
    }
    case 'tap': {
      void (async (): Promise<void> => {
        await booting;
        try {
          if (!brain) throw new Error('the sub-agent runner has no brain');
          liveTaps.get(msg.tapId)?.();
          const attached = await brain.tapSessionSnapshot(
            msg.userId,
            msg.sessionId,
            (event) => { send({ type: 'tap-event', tapId: msg.tapId, event }); },
            undefined,
            undefined,
            msg.history,
          );
          liveTaps.set(msg.tapId, attached.off);
          if (!send({ type: 'tapped', tapId: msg.tapId, snapshot: attached.snapshot })) {
            liveTaps.delete(msg.tapId);
            attached.off();
          }
        } catch (e) {
          send({ type: 'tap-error', tapId: msg.tapId, message: errorText(e) });
        }
      })();
      return;
    }
    case 'untap':
      liveTaps.get(msg.tapId)?.();
      liveTaps.delete(msg.tapId);
      return;
    case 'release': {
      // The daemon wants to run this child's next turn itself. Refuse while it is working here — one
      // transcript driven by two live sessions is worse than a refused continuation.
      if (runningChannels.has(msg.channelId)) { send({ type: 'released', releaseId: msg.releaseId, busy: true }); return; }
      void Promise.resolve(brain?.disposeChannel(msg.channelId))
        .catch((e: unknown) => log.warn(`release failed: ${errorText(e)}`))
        .finally(() => {
          // Let go of it whether or not the dispose threw: the daemon is about to run this child itself,
          // and a runner that kept claiming the channel would keep the pool routing turns back here.
          heldChannels.delete(msg.channelId);
          send({ type: 'released', releaseId: msg.releaseId, busy: false });
        });
      return;
    }
    case 'activity': {
      void (async (): Promise<void> => {
        await booting;
        const activeCount = await runnerReloadActivityCount(runningChannels.size, brain);
        send({ type: 'activity', activityId: msg.activityId, activeCount });
      })().catch((e: unknown) => {
        log.warn(`activity query failed: ${errorText(e)}`);
        // Fail closed: the daemon keeps waiting instead of replacing closures whose state it could not read.
        send({ type: 'activity', activityId: msg.activityId, activeCount: 1 });
      });
      return;
    }
    case 'killAccountProcesses':
      // Explicit account ownership first, then the session row for a delegated child's null-account
      // handle — the same rule the daemon's own sweep applies, or an account delete would leave its
      // children's processes running and unreachable. Awaited: the answer must not claim a stop the
      // guest cancellation has not confirmed yet.
      void (async (): Promise<void> => {
        const { killed, failed } = await processRegistry.killWhere((handle) =>
          processHandleOwnedByAccount(handle, msg.userId, (sessionId) => brainStore?.getSession(sessionId)?.user_id));
        if (failed.length) log.warn(`account ${msg.userId} teardown could not confirm ${failed.length} process(es): ${failed.join(', ')}`);
        send({ type: 'accountProcessesKilled', requestId: msg.requestId, killed });
      })().catch((e: unknown) => {
        log.warn(`account process teardown failed: ${errorText(e)}`);
        send({ type: 'accountProcessesKilled', requestId: msg.requestId, killed: 0 });
      });
      return;
    // The daemon's process list/output/kill surfaces project from THIS registry for the children this
    // process hosts, exactly as they do from its own for in-process ones. Ownership stays daemon-side:
    // these verbs answer only what this registry holds, and the daemon filters it per account.
    case 'processList':
      send({ type: 'processListResult', requestId: msg.requestId, processes: processRegistry.list() });
      return;
    case 'processOutput':
      // The daemon authorizes against its snapshot and passes the owning session: the guard is checked
      // against the LIVE handle here, so a snapshot that went stale between list and act can neither act
      // on a process that already exited nor on a same-id process of another session.
      send({ type: 'processOutputResult', requestId: msg.requestId, output: processRegistry.outputForSession(msg.sessionId, msg.processId) });
      return;
    case 'killProcess':
      // Awaited: the kill must be CONFIRMED (guest cancellation can take moments) before the daemon is
      // told it landed; a failure leaves the handle in place and is reported as not-stopped.
      void (async (): Promise<void> => {
        try { send({ type: 'processKilled', requestId: msg.requestId, killed: await processRegistry.killForSession(msg.sessionId, msg.processId) }); }
        catch (e) {
          log.warn(`process ${msg.processId} kill failed: ${errorText(e)}`);
          send({ type: 'processKilled', requestId: msg.requestId, killed: false });
        }
      })();
      return;
    case 'killSessionProcesses':
      void (async (): Promise<void> => {
        try {
          const { killed, failed } = await processRegistry.killSession(msg.sessionId);
          if (failed.length) log.warn(`session ${msg.sessionId} sweep could not confirm ${failed.length} process(es): ${failed.join(', ')}`);
          send({ type: 'sessionProcessesKilled', requestId: msg.requestId, killed });
        } catch (e) {
          log.warn(`session ${msg.sessionId} process sweep failed: ${errorText(e)}`);
          send({ type: 'sessionProcessesKilled', requestId: msg.requestId, killed: 0 });
        }
      })();
      return;
    case 'hostResult':
      hostRpc.settle(msg.callId, msg.result);
      return;
    case 'hostError':
      hostRpc.settleError(msg.callId, msg.message);
      return;
    default:
      return;
  }
});

/** Leave, aborting what is running: the pool told us to (SIGTERM from pool.reset on a plugin reload),
 *  so the turns are being rejected on the daemon side and must not keep spending. */
const leave = (reason: string): void => {
  log.warn(`sub-agent runner shutting down: ${reason}`);
  for (const off of liveTaps.values()) off();
  liveTaps.clear();
  // The registry dies with this process: anything still running in it would survive as a DETACHED
  // orphan no panel can list or stop. The work is being rejected, so its background processes go too —
  // awaited, because each kill confirms the group is really gone before the registry disappears.
  void (async (): Promise<void> => {
    const { killed, failed } = await processRegistry.killWhere(() => true);
    if (killed || failed.length) {
      log.warn(`sub-agent runner stopped ${killed} background process(es) on shutdown${failed.length ? `, ${failed.length} UNCONFIRMED: ${failed.join(', ')}` : ''}`);
    }
  })().finally(() => {
    const channels = [...runningChannels];
    runningChannels.clear();
    void Promise.allSettled(channels.map((channelId) => brain?.abortChannel(channelId, { origin: 'parent_teardown', reason })))
      .finally(() => process.exit(0));
  });
  // A wedged abort (or sweep) must not keep the orphan alive either.
  setTimeout(() => process.exit(0), 5_000).unref();
};
/** The daemon is GONE (a pause-for-restart, or a crash): leave at once, WITHOUT aborting. The turns
 *  running here are checkpointed row by row and the next boot claims and CONTINUES them; an abort would
 *  unwind through the delegation tree first — a nested Delegate call errors, its child's run row is
 *  terminalized as failed before the cgroup takes this process down — and the boot would find finished
 *  failures where it expects interrupted work to resume (a grandchild lost that way is not recoverable).
 *  Nothing here is worth waiting for: the daemon's cgroup kill follows in milliseconds anyway.
 *
 *  The registry is still torn down: it lives only in this process, so its running children would outlive
 *  it as detached orphans no registry can ever list or stop again — worse than a killed job, whose loss
 *  the resumed turn reports as interrupted work. */
process.on('disconnect', () => {
  hostRpc.close();
  log.warn('sub-agent runner leaving: the daemon closed the IPC channel — turns are left for the boot to continue');
  for (const off of liveTaps.values()) off();
  liveTaps.clear();
  void (async (): Promise<void> => {
    const { killed, failed } = await processRegistry.killWhere(() => true);
    if (killed || failed.length) {
      log.warn(`sub-agent runner stopped ${killed} background process(es) on daemon disconnect${failed.length ? `, ${failed.length} UNCONFIRMED: ${failed.join(', ')}` : ''}`);
    }
  })().finally(() => process.exit(0));
});
process.on('SIGTERM', () => leave('SIGTERM'));

// Same reasoning as the daemon: a stray rejection from one of the many fire-and-forget paths inside a
// turn must not take the whole process — and with it every other sub-agent — down.
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
