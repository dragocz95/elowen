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
import { processRegistry } from '../brain/processRegistry.js';
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
  });
}, HEARTBEAT_INTERVAL_MS);
// A metric must never be the reason this process outlives the work it was forked for.
heartbeat.unref();

let brain: BrainService | undefined;
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
      // ONLY the three low-frequency shapes the delegating plugin consumes. Text deltas, tool-argument
      // deltas and transcripts must never cross: re-amplifying them over IPC would put back the very
      // event-loop pressure this process removes.
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
      void brain?.abortChannel(msg.channelId).catch((e: unknown) => log.warn(`abort failed: ${errorText(e)}`));
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
          const aborted = e instanceof Error && e.message === 'delegation aborted';
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
    case 'drain':
      // The daemon began its shutdown drain. Latch the local coordinator so every turn running here
      // parks at its next step boundary; the daemon polls convergence via drainStatus.
      void (async (): Promise<void> => { await booting; brain?.beginDrain(); })();
      return;
    case 'drainStatus': {
      void (async (): Promise<number> => {
        await booting;
        // No coordinator (or no brain) → fall back to the raw in-flight turn count, which is the
        // conservative whole-turn answer.
        return (await brain?.midStepWork()) ?? runningChannels.size;
      })().then(
        (midStep) => send({ type: 'drainStatus', drainId: msg.drainId, midStep }),
        (e: unknown) => {
          log.warn(`drain status failed: ${errorText(e)}`);
          // Fail closed: the daemon keeps waiting instead of exiting under a turn it could not observe.
          send({ type: 'drainStatus', drainId: msg.drainId, midStep: 1 });
        },
      );
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
      send({ type: 'accountProcessesKilled', requestId: msg.requestId, killed: processRegistry.killAccount(msg.userId) });
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

/** The daemon is gone. A runner that kept working would be an orphan writing rows nobody is waiting for
 *  — and holding model spend nobody asked for — so abort what is running and leave. */
const leave = (reason: string): void => {
  log.warn(`sub-agent runner shutting down: ${reason}`);
  for (const off of liveTaps.values()) off();
  liveTaps.clear();
  const channels = [...runningChannels];
  runningChannels.clear();
  void Promise.allSettled(channels.map((channelId) => brain?.abortChannel(channelId)))
    .finally(() => process.exit(0));
  // A wedged abort must not keep the orphan alive either.
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('disconnect', () => {
  hostRpc.close();
  leave('the daemon closed the IPC channel');
});
process.on('SIGTERM', () => leave('SIGTERM'));

// Same reasoning as the daemon: a stray rejection from one of the many fire-and-forget paths inside a
// turn must not take the whole process — and with it every other sub-agent — down.
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
