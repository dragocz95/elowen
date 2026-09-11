import type { ProjectExecutionRef } from '../shared/projectExecution.js';

/** Daemon-level registry of background shell processes started by the terminal plugin's
 *  `Bash(run_in_background:true)`. The plugin used to keep these in a per-registration closure Map, which
 *  no UI or API could reach; lifting the registry into the daemon makes them listable, killable and
 *  observable from the CLI + web (a panel next to the todos) without going through an agent turn.
 *
 *  The plugin owns the actual child process (spawn/output/kill); it registers a thin HANDLE here so the
 *  daemon can list metadata, read output for the modal, and kill on request. Owner-only surfaces gate the
 *  API — the underlying shell can read any absolute path, same as the terminal tools. */

/** A live handle the terminal plugin registers for one background child. The daemon never spawns — it
 *  only reads state and requests a kill through these callbacks. */
export interface ProcessHandle {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  /** Account whose turn started it. This explicit contribution owner wins over every session-row fallback,
   * which is load-bearing in a shared room whose durable owner may be a different writer. */
  accountUserId?: number | null;
  /** Legacy owner field retained for handles registered by an older plugin generation. New callers write
   * `accountUserId`; session ownership is only the final fallback when neither explicit field exists. */
  userId?: number | null;
  /** Sandbox workspace and account-HOME generation captured at launch. Cleanup/reset consult the durable
   * lease carrying the same tuple; the in-memory handle keeps process UI/caps aligned with it. */
  workspaceId?: string | null;
  homeGeneration?: number | null;
  projectRef?: ProjectExecutionRef;
  runtimeGeneration?: number;
  /** The brain session it was started in (e.g. `brain-<uid>`) — the wake is bound to THIS conversation. */
  sessionId?: string | null;
  /** `foreground` is the transient mode of a still-in-flight `Bash` tool call that the CLI's Ctrl+B can
   *  detach; on detach the plugin flips the same handle to `job` and it becomes an ordinary background
   *  process. It is deliberately NOT counted as a running job (see `runningJobCountForSession`). */
  completionMode?: 'job' | 'service' | 'foreground';
  /** True while a blocking `ProcessOutput` read of this process is holding the turn open. Like a
   *  `foreground` handle it is work the user's Ctrl+B can release, so the clients count it as foreground
   *  work — but the process itself stays an ordinary background job throughout. */
  blockedRead?: boolean;
  /** Opaque per-run token stamped into the child's environment (the terminal plugin's direct-run
   *  tracking): the ONE handle on this process that survives this process dying, because the token
   *  lives in the child's own /proc environ and covers descendants that escaped into new groups.
   *  Reported upward so a daemon-side sweep can still stop the tree after an abrupt runner death. */
  killToken?: string | null;
  running: () => boolean;
  exitCode: () => number | null;
  readAll: () => string;
  /** Incremental read for the AGENT's `ProcessOutput` tool: returns the output written since the
   *  previous call and advances the handle's read cursor (`all` returns the whole buffer and still
   *  advances it). The daemon surfaces (API/UI) deliberately use `readAll` instead — a panel refresh must
   *  never consume output the agent has not seen yet. */
  readNew?: (all?: boolean) => string;
  kill: () => void;
}

/** Serializable snapshot of one background process for the API / UI. */
export interface ProcessInfo {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  /** The brain session it was started in — null for a handle registered outside one. The UI derives the
   *  origin badge (sub-agent / channel) from it, so it is always present in the snapshot. */
  sessionId: string | null;
  running: boolean;
  exitCode: number | null;
  completionMode?: 'job' | 'service' | 'foreground';
  /** A blocking `ProcessOutput` read is waiting on this process — foreground work a client can release. */
  blockedRead?: boolean;
  /** NO `killToken` here, deliberately: this shape is serialized into `GET /brain/processes` and into the
   *  `process` event pushed to client streams, and the token is the secret the terminal plugin redacts out
   *  of command output for exactly that reason. It stays on {@link ProcessHandle}, which never leaves the
   *  process that owns it; the post-mortem sweep reads it from the runner heartbeat instead. */
  workspaceId?: string | null;
  homeGeneration?: number | null;
  projectRef?: ProjectExecutionRef;
  runtimeGeneration?: number;
}

const toInfo = (h: ProcessHandle): ProcessInfo => ({
  id: h.id, command: h.command, cwd: h.cwd, startedAt: h.startedAt,
  sessionId: h.sessionId ?? null,
  running: h.running(), exitCode: h.exitCode(),
  completionMode: h.completionMode,
  ...(h.blockedRead ? { blockedRead: true } : {}),
  workspaceId: h.workspaceId ?? null,
  homeGeneration: h.homeGeneration ?? null,
  ...(h.projectRef ? { projectRef: h.projectRef } : {}),
  ...(h.runtimeGeneration !== undefined ? { runtimeGeneration: h.runtimeGeneration } : {}),
});

/** Explicit contribution ownership is authoritative. `userId` is the pre-contract compatibility field;
 * session-row ownership is resolved by the higher-level service only when both are absent. */
export const processHandleAccount = (handle: ProcessHandle): number | null | undefined =>
  handle.accountUserId !== undefined
    ? handle.accountUserId
    : typeof handle.userId === 'number'
      ? handle.userId
      : undefined;

/** Whether ONE account may act on a handle: an explicit contribution account wins, else the originating
 *  session's row owner decides — the rule that reaches a delegated child's null-account handle through its
 *  session. Shared by the daemon and the runner teardown sweeps, so the two cannot drift apart. */
export const processHandleOwnedByAccount = (
  handle: ProcessHandle,
  accountUserId: number,
  sessionOwnerOf: (sessionId: string) => number | null | undefined,
): boolean => {
  const explicit = processHandleAccount(handle);
  if (explicit !== undefined && explicit !== null) return explicit === accountUserId;
  const sessionId = handle.sessionId;
  return sessionId != null && sessionOwnerOf(sessionId) === accountUserId;
};

/** How long ONE local kill may take before it is reported as unconfirmed. The same bound the runner-side
 *  process RPC uses (`PROCESS_REQUEST_TIMEOUT_MS` in src/subagent/runnerHost.ts), for the same reason: the
 *  terminal plugin's kill chains guest cancellation, which can wedge, and an unbounded wait here blocks
 *  `killSession`, then the conversation teardown sweep, then the DELETE route — holding the session lock
 *  for as long as the guest stays stuck. The timeout REJECTS: the handle is retained and the caller learns
 *  the stop was never confirmed, which is the same answer a refusing handle already gives. */
const LOCAL_KILL_TIMEOUT_MS = 2_000;

const withKillTimeout = async (killed: void | Promise<void>, id: string): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(killed),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`process ${id} did not confirm its stop in time`)), LOCAL_KILL_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** One pending waiter on a session's background JOBS becoming idle. `settle` fires exactly once — either
 *  from notifySession when the last running job exits ('idle') or from an optional timeout timer
 *  ('timeout') — clearing its own timer and unregistering itself, so a later exit can never re-settle it. */
interface JobIdleWaiter {
  settle: (outcome: 'idle' | 'timeout') => void;
}

/** One pending waiter on a SINGLE process finishing (the agent's blocking `ProcessOutput`). Settles
 *  exactly once — from `settleExitWaiters` when the process exits or leaves the registry, or from its own
 *  timeout timer — so a later exit can never re-settle it. */
interface ProcessExitWaiter {
  settle: (outcome: 'exited' | 'timeout') => void;
}

export class ProcessRegistry {
  private handles = new Map<string, ProcessHandle>();
  private onChange?: (sessionId: string | null, accountUserId: number | null) => void;
  private onExitFn?: (info: ProcessInfo, userId: number | null, sessionId: string | null) => void;
  private exited = new Set<string>();
  private jobIdleWaiters = new Map<string, Set<JobIdleWaiter>>();
  private exitWaiters = new Map<string, Set<ProcessExitWaiter>>();

  /** Release everyone blocked on this process: it exited, was killed, or was dropped — in every case it
   *  will never produce more output, so a blocking read must stop waiting. */
  private settleExitWaiters(id: string): void {
    // settle() removes each waiter from the set (and an emptied set from the map); iterate a snapshot.
    const waiters = this.exitWaiters.get(id);
    if (waiters) for (const waiter of [...waiters]) waiter.settle('exited');
  }

  private notifySession(sessionId: string | null | undefined, accountUserId?: number | null): void {
    this.onChange?.(sessionId ?? null, accountUserId ?? null);
    if (!sessionId) return;
    if (this.runningJobCountForSession(sessionId) === 0) {
      // settle() removes each waiter from the set (and an emptied set from the map); iterate a snapshot.
      const waiters = this.jobIdleWaiters.get(sessionId);
      if (waiters) for (const waiter of [...waiters]) waiter.settle('idle');
    }
  }

  /** Register a callback fired whenever the set of processes changes (spawn/exit/kill/remove). Optional —
   *  the web ProcessPanel polls the list, so out-of-turn updates surface there regardless; a consumer that
   *  wants push (e.g. a future CLI card refresh outside a turn) can wire this. */
  setChangeListener(fn: (sessionId: string | null, accountUserId: number | null) => void): void { this.onChange = fn; }

  /** Register a callback fired once when a background process EXITS on its own (not via kill/remove — a
   *  killed process is dropped from the registry before its close fires, so it never notifies). The daemon
   *  wires this to wake the operator's conversation so a finished build/command nudges the agent. */
  setExitListener(fn: (info: ProcessInfo, userId: number | null, sessionId: string | null) => void): void { this.onExitFn = fn; }

  /** Register (or re-register) a handle. The terminal plugin re-registers the SAME handle when a
   *  foreground run detaches — its mode flips to `job` — so only a DIFFERENT handle under a taken id is a
   *  collision. Silently dropping the previous one would leave a child nothing can list or kill, so its
   *  process is terminated here and everyone blocked on it is released before the id changes owner. */
  register(handle: ProcessHandle): void {
    const previous = this.handles.get(handle.id);
    if (previous && previous !== handle) {
      if (previous.running()) previous.kill();
      this.settleExitWaiters(handle.id);
    }
    this.handles.set(handle.id, handle);
    this.exited.delete(handle.id);
    // The evicted handle may belong to another session OR another account in the same shared room. Both
    // scopes need a refresh because the old process disappeared from one and appeared in the other.
    if (previous && previous !== handle
      && (previous.sessionId !== handle.sessionId || processHandleAccount(previous) !== processHandleAccount(handle))) {
      this.notifySession(previous.sessionId, processHandleAccount(previous));
    }
    this.notifySession(handle.sessionId, processHandleAccount(handle));
  }

  /** The terminal plugin calls this from a child's close handler. Fires the exit listener exactly once for
   *  a process still in the registry (a killed one was already removed → no wake). The entry is KEPT so the
   *  agent can still read its output; it's pruned on the next spawn or an explicit read/kill. */
  markExited(id: string): void {
    const h = this.handles.get(id);
    if (!h || this.exited.has(id)) return;
    this.exited.add(id);
    this.settleExitWaiters(id);
    const accountUserId = processHandleAccount(h) ?? null;
    this.notifySession(h.sessionId, accountUserId);
    this.onExitFn?.(toInfo(h), accountUserId, h.sessionId ?? null);
  }

  /** Processes matching a predicate (running first, newest first). The predicate sees the HANDLE, so a
   *  caller can filter on fields the snapshot doesn't carry (e.g. brainService's ownership check on
   *  `userId`). */
  listWhere(predicate: (handle: ProcessHandle) => boolean): ProcessInfo[] {
    return [...this.handles.values()]
      .filter(predicate)
      .map(toInfo)
      .sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt.localeCompare(a.startedAt));
  }

  /** Current processes (running first, newest first). */
  list(): ProcessInfo[] {
    return this.listWhere(() => true);
  }

  listForSession(sessionId: string): ProcessInfo[] {
    return this.listWhere((handle) => handle.sessionId === sessionId);
  }

  /** Processes visible to one contribution account inside one conversation. Explicit account ownership is
   * required for shared-room isolation; legacy handles fall back to their old `userId` field. */
  listForSessionAccount(sessionId: string, accountUserId: number | null): ProcessInfo[] {
    return this.listWhere((handle) =>
      handle.sessionId === sessionId && processHandleAccount(handle) === accountUserId);
  }

  get(id: string): ProcessHandle | undefined { return this.handles.get(id); }

  /** Full output buffer of a process, or null when unknown. */
  output(id: string): string | null { return this.handles.get(id)?.readAll() ?? null; }
  outputForSession(sessionId: string, id: string): string | null {
    const handle = this.handles.get(id);
    return handle?.sessionId === sessionId ? handle.readAll() : null;
  }
  outputForSessionAccount(sessionId: string, accountUserId: number | null, id: string): string | null {
    const handle = this.handles.get(id);
    return handle?.sessionId === sessionId && processHandleAccount(handle) === accountUserId
      ? handle.readAll()
      : null;
  }

  /** Kill a process and drop it from the registry ONLY once the stop is confirmed. The terminal
   *  plugin's kill awaits guest cancellation (workspace/managed children can take moments), so
   *  returning before it settles reported a stopped process that was still running — with its handle
   *  already gone, leaving nothing to retry. On failure the handle is RETAINED (it stays listed and
   *  stoppable) and the error propagates to every caller. Returns false when the id is unknown. */
  async kill(id: string): Promise<boolean> {
    const h = this.handles.get(id);
    if (!h) return false;
    try {
      await withKillTimeout(h.kill(), id);
    } catch (e) {
      this.notifySession(h.sessionId, processHandleAccount(h));
      throw e;
    }
    this.handles.delete(id);
    this.exited.delete(id);
    this.settleExitWaiters(id);
    this.notifySession(h.sessionId, processHandleAccount(h));
    return true;
  }

  async killForSession(sessionId: string, id: string): Promise<boolean> {
    const handle = this.handles.get(id);
    return handle?.sessionId === sessionId ? this.kill(id) : false;
  }

  async killForSessionAccount(sessionId: string, accountUserId: number | null, id: string): Promise<boolean> {
    const handle = this.handles.get(id);
    return handle?.sessionId === sessionId && processHandleAccount(handle) === accountUserId
      ? this.kill(id)
      : false;
  }

  /** Stop every process matching the predicate — running ones killed, exited ones dropped. The one
   *  teardown primitive: the session, account and runner-shutdown sweeps must agree on semantics, so
   *  they all route through here. A kill that cannot be CONFIRMED is reported in `failed` with its
   *  handle retained, never folded into a silent success count. */
  async killWhere(predicate: (handle: ProcessHandle) => boolean): Promise<{ killed: number; failed: string[] }> {
    const handles = [...this.handles.values()].filter(predicate);
    let killed = 0;
    const failed: string[] = [];
    for (const handle of handles) {
      if (!handle.running()) { this.remove(handle.id); continue; }
      try { if (await this.kill(handle.id)) killed += 1; }
      catch { failed.push(handle.id); }
    }
    return { killed, failed };
  }

  async killSession(sessionId: string): Promise<{ killed: number; failed: string[] }> {
    return this.killWhere((handle) => handle.sessionId === sessionId);
  }

  async killAccount(accountUserId: number): Promise<{ killed: number; failed: string[] }> {
    return this.killWhere((handle) => processHandleAccount(handle) === accountUserId);
  }

  /** The kill tokens of every RUNNING handle — what a daemon-side sweep can still stop after this
   *  process dies abruptly and its registry (these closures included) dies with it. */
  killTokens(): string[] {
    return [...this.handles.values()]
      .filter((handle) => handle.running() && handle.killToken)
      .map((handle) => handle.killToken!);
  }

  /** Drop an entry without killing (e.g. an already-exited process cleared from the panel). */
  remove(id: string): boolean {
    const handle = this.handles.get(id);
    const sessionId = handle?.sessionId ?? null;
    const existed = this.handles.delete(id);
    this.exited.delete(id);
    if (existed) {
      this.settleExitWaiters(id);
      this.notifySession(sessionId, handle ? processHandleAccount(handle) : null);
    }
    return existed;
  }

  runningJobCountForSession(sessionId: string): number {
    let count = 0;
    for (const handle of this.handles.values()) {
      // A mode-less handle counts as a job (preserving prior semantics); `service` and the transient
      // `foreground` mode of an in-flight Bash tool call do not — the latter would otherwise deadlock a
      // delegate's collect loop, which blocks on this count, against its own running command.
      if (handle.sessionId === sessionId && (handle.completionMode ?? 'job') === 'job' && handle.running()) count++;
    }
    return count;
  }

  /** Resolve when ONE process finishes, so the agent's `ProcessOutput(block:true)` can wait for a
   *  build/test run instead of polling it in a loop. Returns 'exited' immediately when the id is unknown or
   *  the process already finished, once it exits (or is killed/dropped — either way no more output is
   *  coming), or 'timeout' if a finite `timeoutMs` passes first. The timer is unref'd so a pending wait
   *  never keeps the daemon alive, and each waiter settles exactly once. */
  waitForExit(id: string, timeoutMs?: number): Promise<'exited' | 'timeout'> {
    const handle = this.handles.get(id);
    if (!handle || !handle.running()) return Promise.resolve('exited');
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiters = this.exitWaiters.get(id) ?? new Set<ProcessExitWaiter>();
      const waiter: ProcessExitWaiter = {
        settle: (outcome) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          const set = this.exitWaiters.get(id);
          set?.delete(waiter);
          if (set && set.size === 0) this.exitWaiters.delete(id);
          resolve(outcome);
        },
      };
      waiters.add(waiter);
      this.exitWaiters.set(id, waiters);
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => waiter.settle('timeout'), timeoutMs);
        timer.unref?.();
      }
    });
  }

  /** Resolve when the session has no RUNNING background jobs left (service processes are excluded — a
   *  long-lived service must never block a collect turn). Returns 'idle' immediately when already idle, or
   *  once the last running job exits; with a finite `timeoutMs`, returns 'timeout' if that deadline passes
   *  first. The timer is unref'd so a pending wait never keeps the daemon alive, and each waiter settles
   *  exactly once — a later exit after a timeout (or vice versa) is a no-op. */
  waitForSessionJobsIdle(sessionId: string, timeoutMs?: number): Promise<'idle' | 'timeout'> {
    if (this.runningJobCountForSession(sessionId) === 0) return Promise.resolve('idle');
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiters = this.jobIdleWaiters.get(sessionId) ?? new Set<JobIdleWaiter>();
      const waiter: JobIdleWaiter = {
        settle: (outcome) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          const set = this.jobIdleWaiters.get(sessionId);
          set?.delete(waiter);
          if (set && set.size === 0) this.jobIdleWaiters.delete(sessionId);
          resolve(outcome);
        },
      };
      waiters.add(waiter);
      this.jobIdleWaiters.set(sessionId, waiters);
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => waiter.settle('timeout'), timeoutMs);
        timer.unref?.();
      }
    });
  }
}

/** Process-global singleton — background processes outlive any single turn, so (unlike the turn-scoped
 *  card/subagent emitters) this is a plain shared instance imported by both the plugin context wiring
 *  (registry.ts, as `ctx.processes`) and the daemon API routes (brain.ts). One Node process, one Map. */
export const processRegistry = new ProcessRegistry();
