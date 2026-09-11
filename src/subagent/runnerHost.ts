import type { PendingAbort } from '../brain/session/liveRegistry.js';
import { fork, type ChildProcess } from 'node:child_process';
import { setPriority } from 'node:os';
import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import type { BrainEvent } from '../brain/events.js';
import type { BrainStreamSnapshot } from '../brain/session/liveEventReplay.js';
import type { ProcessInfo } from '../brain/processRegistry.js';
import {
  SubagentRunnerUnavailable,
  fromDelegatedProgress,
  type DelegatedTurnRequest,
  type DelegatedTurnRunner,
} from '../brain/delegatedTurn.js';
import { RUNNER_ENTRY, parseRunnerMessage, subagentBuildId, type DaemonToRunner, type RunnerSteerOutcome } from './protocol.js';
import type { McpBridgeSnapshot } from '../plugins/mcpSnapshot.js';
import { channelSessionId } from '../brain/sessionId.js';
import { delegatedToolPolicy } from '../brain/delegatedScope.js';
import { toolPermitted } from '../plugins/policyContext.js';
import type { HostRpcHandler } from './hostRpc.js';

const log = logger('subagent-runner');

function hostRpcAllowed(turn: PendingTurn): boolean {
  // The same policy the turn itself will run under, account grant included — a reverse-channel capability
  // must not be decided from a wider view of the child than the child gets.
  return toolPermitted('WorkflowAddNodes', delegatedToolPolicy(turn.request.delegatedAccess, [], turn.request.accountAllow));
}

/** How long the child gets to attach its database, load plugins and build its brain before we give up on
 *  it. Generous: it does everything the daemon's own boot does minus the server, and a cold plugin load on
 *  a loaded box is not fast. */
const BOOT_TIMEOUT_MS = 60_000;
/** After a failed boot, stay in-process for this long instead of forking on every single delegation — a
 *  broken runner must not turn one failure into a fork storm. */
const BOOT_RETRY_COOLDOWN_MS = 60_000;
/** An activity query is a reload safety check, not an excuse to hang reload forever on a wedged IPC peer.
 *  Timeout fails closed as active; the outer bounded reload drain decides when to give up safely. */
const ACTIVITY_TIMEOUT_MS = 1_000;
const ACCOUNT_PROCESS_KILL_TIMEOUT_MS = 2_000;
/** One runner-local process RPC. Same bound as the account kill: a wedged child must degrade the process
 *  panel (a miss reads as "gone"), never hang an owner-facing HTTP route on it. */
const PROCESS_REQUEST_TIMEOUT_MS = 2_000;

export interface SubagentRunnerHostDeps {
  dbPath: string;
  project: { id: number; slug: string; path: string };
  /** The daemon's OWN working directory. A delegated turn resolves its cwd as
   *  `turnWorkDir(...) ?? cwd ?? process.cwd()`, so a child forked with a different one would silently
   *  tell the model it is somewhere else. */
  cwd: string;
  /** The daemon's bridged MCP tool definitions as they stood when the POOL decided to fork this host
   *  (see RunnerBootMessage.mcp). Carried in the boot frame so the child declares the same bridged tools
   *  without connecting a single MCP server. Omitted ⇒ the child connects at boot, as it always did. */
  mcpBridgeSnapshot?: McpBridgeSnapshot;
  /** The fork itself. Injectable ONLY so the handshake and the death path can be exercised without
   *  booting a real brain in a child process; production always takes the default below. */
  fork?: () => ChildProcess;
  /** The child reported its own state. The POOL uses this for the load signal it cannot observe from
   *  outside (event-loop p99) and for the measured runner size; absent when this host stands alone. */
  onHeartbeat?: (beat: RunnerHeartbeat) => void;
  /** The child is gone — for good. The pool drops this host and every route pointing at it here; nothing
   *  re-forks in place, because a host is one process for its whole life. */
  onExit?: () => void;
  /** Execute a reverse RPC in the daemon. The host supplies the caller session from its own pending-turn
   *  table; no identity field from the runner crosses this boundary. */
  hostRpc?: HostRpcHandler;
  /** A background process of `sessionId` changed here (spawn/exit/kill/drop). The snapshot is THIS
   *  registry's rows for the session at change time; the pool forwards both to whoever projects live
   *  process panels, so a runner-local start reaches a drill-in that is open. */
  onProcessesChanged?: (sessionId: string, processes: ProcessInfo[]) => void;
  /** THIS runner exited. `killTokens` are the per-run environment tokens of the children that were
   *  RUNNING at the last heartbeat: a runner that died without a graceful sweep leaves them detached,
   *  and the daemon can still stop those trees by token. */
  onRunnerExited?: (killTokens: string[]) => void;
}

/** What a runner says about itself, as forwarded to whoever owns this host. */
export interface RunnerHeartbeat {
  loopP99Ms: number;
  activeTurns: number;
  sessions: number;
  rssBytes: number;
}

interface PendingTurn {
  request: DelegatedTurnRequest;
  rpcActive: boolean;
  resolve: (reply: string) => void;
  reject: (e: Error) => void;
  onEvent?: (e: BrainEvent) => void;
}

/** One daemon-issued process verb awaiting the runner's answer. The request id is the correlation key; the
 *  `kind` separates the three answer shapes that share one map. */
interface PendingProcessRequest {
  kind: 'list' | 'output' | 'kill' | 'killSession';
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: ProcessInfo[] | string | null | boolean | number) => void;
}

/** Supervises ONE forked sub-agent runner: boot handshake, turn correlation, abort/release verbs and the
 *  death path.
 *
 *  This is the SINGLE construction path for a runner process — {@link SubagentRunnerPool} owns N of these
 *  and nothing else forks a child. Everything about how many there should be, where a turn is placed and
 *  what waits when they are all busy lives in the pool: this class knows only about its own child. */
export class SubagentRunnerHost implements DelegatedTurnRunner {
  private child: ChildProcess | null = null;
  private ready: Promise<ChildProcess> | null = null;
  private readonly pending = new Map<string, PendingTurn>();
  private readonly pendingProcess = new Map<string, PendingProcessRequest>();
  /** The last thing the child said about itself, for `/health`. Undefined until the first beat. */
  private lastBeat: RunnerHeartbeat | undefined;
  /** The kill tokens of the last heartbeat's running children — the pre-captured metadata a post-mortem
   *  sweep needs once this process can no longer report or kill anything itself. */
  private lastKillTokens: string[] = [];
  /** Set once the exit path has run, so a dead host is never handed a turn or counted as live. */
  private dead = false;
  /** Nested edges this runner told us about, so a runner death can retract every one of them instead of
   *  leaving the daemon believing work is still running. */
  private readonly mirroredEdges = new Set<string>();
  private cooldownUntil = 0;
  private readonly buildId = subagentBuildId();
  private childEdgeSink?: (parentSessionId: string, childSessionId: string, running: boolean) => void;

  constructor(private d: SubagentRunnerHostDeps) {}

  /** Mirror a NESTED delegated edge reported by the runner into the daemon's registry — the abort tree,
   *  the status view and the shutdown gate all read it there. Late-bound: this host is a dependency of
   *  the brain, so the brain does not exist yet when it is constructed. */
  attachChildEdgeSink(sink: (parentSessionId: string, childSessionId: string, running: boolean) => void): void {
    this.childEdgeSink = sink;
  }

  /** The child's pid once it exists — identity in `/health`, and the only handle an operator can `top`. */
  get pid(): number | undefined { return this.child?.pid; }

  /** True once this host's process has exited. A dead host is never reused: the pool forks a new one. */
  get isDead(): boolean { return this.dead; }

  /** The child's own last report. The pool deliberately does NOT admit or route from these numbers (they
   *  are up to one heartbeat stale); they are what the runner SEES, surfaced so a divergence is visible. */
  get heartbeat(): RunnerHeartbeat | undefined { return this.lastBeat; }

  /** Fork + handshake now, rather than on the first turn. The pool grows explicitly, so it needs to know
   *  whether a new runner actually came up before it counts on the capacity. */
  async start(): Promise<void> { await this.ensure(); }

  async run(request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void): Promise<string> {
    // A host is ONE process for its whole life. Re-forking in place would give a session a different
    // runner under the same identity, which is exactly the stale route the pool exists to prevent.
    if (this.dead) throw new SubagentRunnerUnavailable('this sub-agent runner has exited');
    const child = await this.ensure();
    const turnId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      this.pending.set(turnId, { request, rpcActive: true, resolve, reject, ...(onEvent ? { onEvent } : {}) });
      if (!this.post(child, { type: 'turn', turnId, request, text })) {
        this.pending.delete(turnId);
        reject(new SubagentRunnerUnavailable('the sub-agent runner channel closed before the turn was sent'));
      }
    });
  }

  abort(channelId: string, abort?: PendingAbort): void {
    // Revocation is synchronous: a reverse call waiting on daemon/plugin work must lose authority before
    // the runner gets around to acknowledging the abort and settling its turn.
    for (const turn of this.pending.values()) {
      if (turn.request.channelId === channelId) turn.rpcActive = false;
    }
    if (this.child) this.post(this.child, { type: 'abort', channelId, ...(abort ? { abort } : {}) });
  }

  async steer(channelId: string, text: string): Promise<{ outcome: RunnerSteerOutcome }> {
    const child = this.child;
    // Nothing forked (or already gone) ⇒ no turn of this channel is running here, by definition.
    if (!child || !this.ready) return { outcome: 'idle' };
    const steerId = randomUUID();
    return new Promise<{ outcome: RunnerSteerOutcome }>((resolve) => {
      const onMessage = (raw: unknown): void => {
        const msg = parseRunnerMessage(raw);
        if (msg?.type !== 'steered' || msg.steerId !== steerId) return;
        child.off('message', onMessage);
        child.off('exit', onExit);
        resolve({ outcome: msg.outcome });
      };
      // A runner that died mid-steer delivered nothing: `idle` sends the caller down the fallback path,
      // which is exactly what a rehydrating continuation needs after a runner death.
      const onExit = (): void => { child.off('message', onMessage); resolve({ outcome: 'idle' }); };
      child.on('message', onMessage);
      child.once('exit', onExit);
      if (!this.post(child, { type: 'steer', steerId, channelId, text })) { onExit(); }
    });
  }

  async tapSessionSnapshot(
    userId: number,
    sessionId: string,
    listener: (event: BrainEvent) => void,
    history?: { before?: number; limit: number },
  ): Promise<{ off: () => void; snapshot: BrainStreamSnapshot } | undefined> {
    const child = this.child;
    // A drill-in is observational: it never cold-starts a runner. No live process means no remote replay
    // exists, and the daemon's durable/local snapshot is the truthful fallback.
    if (!child || !this.ready) return undefined;
    const tapId = randomUUID();
    return new Promise((resolve, reject) => {
      let attached = false;
      let closed = false;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      const off = (): void => {
        cleanup();
        if (child.connected) this.post(child, { type: 'untap', tapId });
      };
      const onMessage = (raw: unknown): void => {
        const msg = parseRunnerMessage(raw);
        if (!msg || !('tapId' in msg) || msg.tapId !== tapId) return;
        if (msg.type === 'tap-event') { listener(msg.event); return; }
        if (msg.type === 'tap-error') {
          cleanup();
          reject(new Error(msg.message));
          return;
        }
        attached = true;
        resolve({ off, snapshot: msg.snapshot });
      };
      const onExit = (): void => {
        cleanup();
        if (attached) listener({ type: 'error', message: 'the sub-agent runner exited' });
        else resolve(undefined);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
      if (!this.post(child, { type: 'tap', tapId, userId, sessionId, ...(history ? { history } : {}) })) onExit();
    });
  }

  async release(channelId: string): Promise<{ busy: boolean }> {
    const child = this.child;
    // Nothing forked (or already gone) ⇒ the runner holds no record for this channel by definition.
    if (!child || !this.ready) return { busy: false };
    const releaseId = randomUUID();
    return new Promise<{ busy: boolean }>((resolve) => {
      const onMessage = (raw: unknown): void => {
        const msg = parseRunnerMessage(raw);
        if (msg?.type !== 'released' || msg.releaseId !== releaseId) return;
        child.off('message', onMessage);
        child.off('exit', onExit);
        resolve({ busy: msg.busy });
      };
      // A runner that died is a runner that holds nothing — the caller may proceed.
      const onExit = (): void => { child.off('message', onMessage); resolve({ busy: false }); };
      child.on('message', onMessage);
      child.once('exit', onExit);
      if (!this.post(child, { type: 'release', releaseId, channelId })) { onExit(); }
    });
  }

  async activeCount(): Promise<number> {
    const child = this.child;
    if (!child || !this.ready) return 0;
    const activityId = randomUUID();
    return new Promise<number>((resolve) => {
      let settled = false;
      const finish = (count: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        resolve(count);
      };
      const onMessage = (raw: unknown): void => {
        const msg = parseRunnerMessage(raw);
        if (msg?.type === 'activity' && msg.activityId === activityId) finish(msg.activeCount);
      };
      const onExit = (): void => finish(0);
      const timer = setTimeout(() => finish(1), ACTIVITY_TIMEOUT_MS);
      timer.unref();
      child.on('message', onMessage);
      child.once('exit', onExit);
      if (!this.post(child, { type: 'activity', activityId })) finish(1);
    });
  }

  async killAccountProcesses(userId: number): Promise<number> {
    const child = this.child;
    if (!child || !this.ready) return 0;
    const requestId = randomUUID();
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, killed = 0): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        if (error) reject(error); else resolve(killed);
      };
      const onMessage = (raw: unknown): void => {
        const msg = parseRunnerMessage(raw);
        if (msg?.type === 'accountProcessesKilled' && msg.requestId === requestId) finish(null, msg.killed);
      };
      const onExit = (): void => finish(null, 0);
      const timer = setTimeout(() => finish(new Error('sub-agent runner did not acknowledge account process teardown')), ACCOUNT_PROCESS_KILL_TIMEOUT_MS);
      timer.unref();
      child.on('message', onMessage);
      child.once('exit', onExit);
      if (!this.post(child, { type: 'killAccountProcesses', requestId, userId })) finish(new Error('sub-agent runner channel closed during account process teardown'));
    });
  }

  /** THIS runner's background-process registry. The process that spawned a child owns its lifetime —
   *  a runner-hosted delegation registers its `Bash(run_in_background:true)` handles in the runner's own
   *  ProcessRegistry, and these verbs are how the daemon's list/output/kill surfaces project from it. A
   *  dead or unwired runner holds nothing by definition, so every verb settles empty rather than throwing. */
  listProcesses(): Promise<ProcessInfo[]> {
    // A list is ONLY ever answered from a live runner; a wedged one rejects, because broadcasting an
    // empty snapshot would hide processes that are actually running.
    return this.request<ProcessInfo[]>('list', [], (requestId) => ({ type: 'processList', requestId }), { strict: true });
  }

  processOutput(processId: string, sessionId: string): Promise<string | null> {
    return this.request<string | null>('output', null, (requestId) => ({ type: 'processOutput', requestId, processId, sessionId }), { strict: true });
  }

  async killProcess(processId: string, sessionId: string): Promise<boolean> {
    return this.request<boolean>('kill', false, (requestId) => ({ type: 'killProcess', requestId, processId, sessionId }), { strict: true });
  }

  async killSessionProcesses(sessionId: string): Promise<number> {
    return this.request<number>('killSession', 0, (requestId) => ({ type: 'killSessionProcesses', requestId, sessionId }), { strict: true });
  }

  /** One bounded runner-local process RPC. `fallback` is what a DEAD runner settles to (an empty list,
   *  unknown output, an honest kill miss — its registry died with it, so "gone" is the truth). A WEDGED
   *  runner is a different case: with `strict`, the timeout REJECTS instead, because a fake answer would
   *  masquerade as a confirmed kill (a teardown would then delete rows it could not clean) or as an
   *  empty list (panels would hide live processes). */
  private request<R>(
    kind: PendingProcessRequest['kind'],
    fallback: R,
    frame: (requestId: string) => DaemonToRunner,
    opts: { strict?: boolean } = {},
  ): Promise<R> {
    const child = this.child;
    if (!child || !this.ready) return Promise.resolve(fallback);
    const requestId = randomUUID();
    return new Promise<R>((resolve, reject) => {
      const settle = (result: R): void => {
        const pending = this.pendingProcess.get(requestId);
        if (!pending) return;
        this.pendingProcess.delete(requestId);
        clearTimeout(pending.timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        const pending = this.pendingProcess.get(requestId);
        if (!pending) return;
        this.pendingProcess.delete(requestId);
        clearTimeout(pending.timer);
        if (opts.strict) reject(new Error('the sub-agent runner did not answer the process request in time'));
        else resolve(fallback);
      }, PROCESS_REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pendingProcess.set(requestId, { kind, timer, resolve: settle as (result: unknown) => void });
      if (!this.post(child, frame(requestId))) {
        clearTimeout(timer);
        this.pendingProcess.delete(requestId);
        if (opts.strict) reject(new Error('the sub-agent runner channel closed before the process request was sent'));
        else resolve(fallback);
      }
    });
  }

  reset(reason: string): void {
    const child = this.child;
    if (!child) return;
    log.info(`stopping the sub-agent runner: ${reason}`);
    this.child = null;
    this.ready = null;
    // The exit handler settles pending turns and retracts mirrored edges; killing is all that is needed
    // here, and SIGTERM lets the child abort its own sessions on the way out.
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }

  /** Fork + handshake, memoized. Throws {@link SubagentRunnerUnavailable} when the child cannot be
   *  brought up, so the caller can fall back to running the turn itself. */
  private ensure(): Promise<ChildProcess> {
    if (this.ready) return this.ready;
    if (Date.now() < this.cooldownUntil) {
      return Promise.reject(new SubagentRunnerUnavailable('the sub-agent runner failed to start recently'));
    }
    this.ready = this.spawn().catch((e: unknown) => {
      this.cooldownUntil = Date.now() + BOOT_RETRY_COOLDOWN_MS;
      this.ready = null;
      this.child = null;
      throw e instanceof SubagentRunnerUnavailable
        ? e
        : new SubagentRunnerUnavailable(e instanceof Error ? e.message : String(e));
    });
    return this.ready;
  }

  private spawn(): Promise<ChildProcess> {
    return new Promise<ChildProcess>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.d.fork?.() ?? fork(RUNNER_ENTRY, [], {
          // Explicit: a delegated turn's cwd falls back to `process.cwd()`, which would otherwise differ
          // between the daemon and its child and change what the model is told about where it runs.
          cwd: this.d.cwd,
          // The whole daemon environment, deliberately: PI_CACHE_RETENTION, ELOWEN_CLI, ELOWEN_PORT and
          // the log dir all shape what a session composes, and a child that missed one of them would
          // produce a subtly different prompt.
          env: process.env,
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
      } catch (e) {
        reject(new SubagentRunnerUnavailable(e instanceof Error ? e.message : String(e)));
        return;
      }
      this.child = child;
      // Child work must yield to the interactive path. Best-effort: an unsupported platform is not a
      // reason to refuse to delegate, it only means the child competes on equal terms.
      try { if (child.pid) setPriority(child.pid, 5); } catch (e) {
        log.warn(`could not lower the sub-agent runner's priority: ${e instanceof Error ? e.message : String(e)}`);
      }
      const timer = setTimeout(() => {
        settleBoot(new SubagentRunnerUnavailable(`the sub-agent runner did not report ready within ${BOOT_TIMEOUT_MS}ms`));
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, BOOT_TIMEOUT_MS);
      timer.unref();
      let booted = false;
      const settleBoot = (e?: Error): void => {
        if (booted) return;
        booted = true;
        clearTimeout(timer);
        if (e) reject(e); else resolve(child);
      };
      child.on('message', (raw: unknown) => {
        const msg = parseRunnerMessage(raw);
        if (!msg) return;
        switch (msg.type) {
          case 'ready':
            if (msg.buildId !== this.buildId) {
              settleBoot(new SubagentRunnerUnavailable(`sub-agent runner build mismatch (${msg.buildId} vs ${this.buildId})`));
              try { child.kill('SIGKILL'); } catch { /* already gone */ }
              return;
            }
            log.info(`sub-agent runner ready (pid ${child.pid})`);
            settleBoot();
            return;
          case 'fatal':
            settleBoot(new SubagentRunnerUnavailable(`sub-agent runner refused to start: ${msg.reason}`));
            return;
          case 'progress': {
            const turn = this.pending.get(msg.turnId);
            try { turn?.onEvent?.(fromDelegatedProgress(msg.event)); } catch { /* a sink of ours threw; the turn continues */ }
            return;
          }
          case 'child': {
            const key = `${msg.parentSessionId}\u0000${msg.childSessionId}`;
            if (msg.running) this.mirroredEdges.add(key); else this.mirroredEdges.delete(key);
            this.childEdgeSink?.(msg.parentSessionId, msg.childSessionId, msg.running);
            return;
          }
          case 'hostCall': {
            const turn = this.pending.get(msg.turnId);
            if (!turn || !turn.rpcActive) {
              this.post(child, { type: 'hostError', callId: msg.callId, message: 'the host RPC caller turn is no longer active' });
              return;
            }
            if (!this.d.hostRpc) {
              this.post(child, { type: 'hostError', callId: msg.callId, message: 'the daemon does not support this host RPC' });
              return;
            }
            if (!hostRpcAllowed(turn)) {
              this.post(child, { type: 'hostError', callId: msg.callId, message: 'the active turn is not allowed to call WorkflowAddNodes' });
              return;
            }
            // The runner names only the daemon-minted turn correlation id. Session, access and liveness all
            // come from the request the daemon placed on THIS IPC connection, never from child-controlled data.
            const caller = {
              sessionId: channelSessionId(turn.request.channelId),
              access: turn.request.delegatedAccess,
              ...(turn.request.model || turn.request.thinkingLevel ? {
                model: {
                  ...(turn.request.model ?? {}),
                  ...(turn.request.thinkingLevel ? { thinkingLevel: turn.request.thinkingLevel } : {}),
                },
              } : {}),
              isActive: () => turn.rpcActive && this.pending.get(msg.turnId) === turn
                && this.child === child && child.connected && !this.dead,
            };
            void this.d.hostRpc(caller, msg.request).then(
              (result) => { this.post(child, { type: 'hostResult', callId: msg.callId, result }); },
              (e: unknown) => {
                this.post(child, {
                  type: 'hostError', callId: msg.callId,
                  message: e instanceof Error ? e.message : String(e),
                });
              },
            );
            return;
          }
          case 'result': {
            const turn = this.pending.get(msg.turnId);
            this.pending.delete(msg.turnId);
            turn?.resolve(msg.reply);
            return;
          }
          case 'error': {
            const turn = this.pending.get(msg.turnId);
            this.pending.delete(msg.turnId);
            turn?.reject(new Error(msg.message));
            return;
          }
          case 'heartbeat': {
            const { loopP99Ms, activeTurns, sessions, rssBytes } = msg;
            this.lastBeat = { loopP99Ms, activeTurns, sessions, rssBytes };
            if (msg.killTokens) this.lastKillTokens = msg.killTokens;
            this.d.onHeartbeat?.(this.lastBeat);
            return;
          }
          case 'processListResult': {
            const pending = this.pendingProcess.get(msg.requestId);
            if (pending?.kind === 'list') (pending.resolve as (result: ProcessInfo[]) => void)(msg.processes);
            return;
          }
          case 'processOutputResult': {
            const pending = this.pendingProcess.get(msg.requestId);
            if (pending?.kind === 'output') (pending.resolve as (result: string | null) => void)(msg.output);
            return;
          }
          case 'processKilled': {
            const pending = this.pendingProcess.get(msg.requestId);
            if (pending?.kind === 'kill') (pending.resolve as (result: boolean) => void)(msg.killed);
            return;
          }
          case 'sessionProcessesKilled': {
            const pending = this.pendingProcess.get(msg.requestId);
            if (pending?.kind === 'killSession') (pending.resolve as (result: number) => void)(msg.killed);
            return;
          }
          case 'processesChanged': {
            // Fire-and-forget: a slow projection must never block the IPC pump that also carries turns.
            try { this.d.onProcessesChanged?.(msg.sessionId, msg.processes); } catch { /* a sink of ours threw */ }
            return;
          }
          default: return; // `released`/`steered` are handled by the per-call listeners in release()/steer()
        }
      });
      child.on('error', (e) => {
        log.error(`sub-agent runner error: ${e.message}`);
        settleBoot(new SubagentRunnerUnavailable(e.message));
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) { this.child = null; this.ready = null; }
        settleBoot(new SubagentRunnerUnavailable(`the sub-agent runner exited during boot (code ${code ?? '?'}, signal ${signal ?? 'none'})`));
        // A dead runner cannot finish what it started. Settle every awaited turn as interrupted so the
        // delegating parents get a terminal answer instead of waiting for a process that is gone.
        const interrupted = new Error('the sub-agent runner exited — this delegated turn was interrupted');
        for (const [turnId, turn] of [...this.pending]) {
          this.pending.delete(turnId);
          turn.reject(interrupted);
        }
        // …and release every process verb: a dead runner's registry died with it, so each reads as empty.
        // Resolve WITHOUT removing the entry first — settle owns the removal, and it settles exactly once.
        for (const pending of this.pendingProcess.values()) {
          if (pending.kind === 'list') (pending.resolve as (result: ProcessInfo[]) => void)([]);
          else if (pending.kind === 'output') (pending.resolve as (result: string | null) => void)(null);
          else if (pending.kind === 'kill') (pending.resolve as (result: boolean) => void)(false);
          // A session sweep answers with a COUNT: `false` here reached `killSessionProcesses`'s sum as a
          // coerced zero and only looked right.
          else (pending.resolve as (result: number) => void)(0);
        }
        // …and retract every edge it had reported, or the daemon keeps believing that work is live.
        for (const key of [...this.mirroredEdges]) {
          this.mirroredEdges.delete(key);
          const [parentSessionId = '', childSessionId = ''] = key.split('\u0000');
          this.childEdgeSink?.(parentSessionId, childSessionId, false);
        }
        if (code !== 0 || signal) log.warn(`sub-agent runner exited (code ${code ?? '?'}, signal ${signal ?? 'none'})`);
        // The last heartbeat's kill tokens are the only handle on children this process can no longer
        // stop itself — hand them to the daemon's post-mortem sweep BEFORE it drops this host.
        try { this.d.onRunnerExited?.([...this.lastKillTokens]); } catch { /* a sink of ours threw */ }
        // LAST: the owner drops this host and every route pointing at it. After the settling above, so a
        // pool that re-places work on hearing this can never race a turn that is still being rejected.
        if (!this.dead) { this.dead = true; this.d.onExit?.(); }
      });
      this.post(child, {
        type: 'boot', buildId: this.buildId, dbPath: this.d.dbPath, project: this.d.project,
        ...(this.d.mcpBridgeSnapshot ? { mcp: this.d.mcpBridgeSnapshot } : {}),
      });
    });
  }

  /** `child.send` throws once the channel is gone; a delegated turn must not die of that. */
  private post(child: ChildProcess, message: DaemonToRunner): boolean {
    try {
      return child.connected ? child.send(message) : false;
    } catch {
      return false;
    }
  }
}
