/** Daemon-level registry of background shell processes started by the terminal plugin's
 *  `Bash(background:true)`. The plugin used to keep these in a per-registration closure Map, which
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
  /** The Elowen user (operator) who started it — used to wake the right conversation on exit. */
  userId?: number | null;
  /** The brain session it was started in (e.g. `brain-<uid>`) — the wake is bound to THIS conversation. */
  sessionId?: string | null;
  completionMode?: 'job' | 'service';
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
  completionMode?: 'job' | 'service';
}

const toInfo = (h: ProcessHandle): ProcessInfo => ({
  id: h.id, command: h.command, cwd: h.cwd, startedAt: h.startedAt,
  sessionId: h.sessionId ?? null,
  running: h.running(), exitCode: h.exitCode(),
  completionMode: h.completionMode,
});

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
  private onChange?: (sessionId: string | null) => void;
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

  private notifySession(sessionId: string | null | undefined): void {
    this.onChange?.(sessionId ?? null);
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
  setChangeListener(fn: (sessionId: string | null) => void): void { this.onChange = fn; }

  /** Register a callback fired once when a background process EXITS on its own (not via kill/remove — a
   *  killed process is dropped from the registry before its close fires, so it never notifies). The daemon
   *  wires this to wake the operator's conversation so a finished build/command nudges the agent. */
  setExitListener(fn: (info: ProcessInfo, userId: number | null, sessionId: string | null) => void): void { this.onExitFn = fn; }

  register(handle: ProcessHandle): void {
    this.handles.set(handle.id, handle);
    this.exited.delete(handle.id);
    this.notifySession(handle.sessionId);
  }

  /** The terminal plugin calls this from a child's close handler. Fires the exit listener exactly once for
   *  a process still in the registry (a killed one was already removed → no wake). The entry is KEPT so the
   *  agent can still read its output; it's pruned on the next spawn or an explicit read/kill. */
  markExited(id: string): void {
    const h = this.handles.get(id);
    if (!h || this.exited.has(id)) return;
    this.exited.add(id);
    this.settleExitWaiters(id);
    this.notifySession(h.sessionId);
    this.onExitFn?.(toInfo(h), h.userId ?? null, h.sessionId ?? null);
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

  get(id: string): ProcessHandle | undefined { return this.handles.get(id); }

  /** Full output buffer of a process, or null when unknown. */
  output(id: string): string | null { return this.handles.get(id)?.readAll() ?? null; }
  outputForSession(sessionId: string, id: string): string | null {
    const handle = this.handles.get(id);
    return handle?.sessionId === sessionId ? handle.readAll() : null;
  }

  /** Kill a process and drop it from the registry. Returns false when the id is unknown. */
  kill(id: string): boolean {
    const h = this.handles.get(id);
    if (!h) return false;
    h.kill();
    this.handles.delete(id);
    this.exited.delete(id);
    this.settleExitWaiters(id);
    this.notifySession(h.sessionId);
    return true;
  }

  killForSession(sessionId: string, id: string): boolean {
    const handle = this.handles.get(id);
    return handle?.sessionId === sessionId ? this.kill(id) : false;
  }

  killSession(sessionId: string): number {
    const handles = [...this.handles.values()].filter((handle) => handle.sessionId === sessionId);
    for (const handle of handles) {
      if (handle.running()) this.kill(handle.id);
      else this.remove(handle.id);
    }
    return handles.length;
  }

  /** Drop an entry without killing (e.g. an already-exited process cleared from the panel). */
  remove(id: string): boolean {
    const sessionId = this.handles.get(id)?.sessionId ?? null;
    const existed = this.handles.delete(id);
    this.exited.delete(id);
    if (existed) {
      this.settleExitWaiters(id);
      this.notifySession(sessionId);
    }
    return existed;
  }

  /** Count of processes still running — used to decide whether to show/refresh the panel. */
  runningCount(): number {
    let n = 0;
    for (const h of this.handles.values()) if (h.running()) n++;
    return n;
  }

  runningJobCountForSession(sessionId: string): number {
    let count = 0;
    for (const handle of this.handles.values()) {
      if (handle.sessionId === sessionId && handle.completionMode !== 'service' && handle.running()) count++;
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
