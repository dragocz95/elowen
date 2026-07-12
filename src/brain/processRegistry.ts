/** Daemon-level registry of background shell processes started by the terminal plugin's
 *  `run_command(background:true)`. The plugin used to keep these in a per-registration closure Map, which
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
  running: () => boolean;
  exitCode: () => number | null;
  readAll: () => string;
  kill: () => void;
}

/** Serializable snapshot of one background process for the API / UI. */
export interface ProcessInfo {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  running: boolean;
  exitCode: number | null;
}

const toInfo = (h: ProcessHandle): ProcessInfo => ({
  id: h.id, command: h.command, cwd: h.cwd, startedAt: h.startedAt,
  running: h.running(), exitCode: h.exitCode(),
});

export class ProcessRegistry {
  private handles = new Map<string, ProcessHandle>();
  private onChange?: (sessionId: string | null) => void;
  private onExitFn?: (info: ProcessInfo, userId: number | null, sessionId: string | null) => void;
  private exited = new Set<string>();
  private idleWaiters = new Map<string, Set<() => void>>();

  private notifySession(sessionId: string | null | undefined): void {
    this.onChange?.(sessionId ?? null);
    if (!sessionId || this.runningCountForSession(sessionId) > 0) return;
    const waiters = this.idleWaiters.get(sessionId);
    this.idleWaiters.delete(sessionId);
    for (const resolve of waiters ?? []) resolve();
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
    this.notifySession(h.sessionId);
    this.onExitFn?.(toInfo(h), h.userId ?? null, h.sessionId ?? null);
  }

  /** Current processes (running first, newest first). */
  list(): ProcessInfo[] {
    return [...this.handles.values()]
      .map(toInfo)
      .sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt.localeCompare(a.startedAt));
  }

  listForSession(sessionId: string): ProcessInfo[] {
    return [...this.handles.values()]
      .filter((handle) => handle.sessionId === sessionId)
      .map(toInfo)
      .sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt.localeCompare(a.startedAt));
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
    this.notifySession(h.sessionId);
    return true;
  }

  killForSession(sessionId: string, id: string): boolean {
    const handle = this.handles.get(id);
    return handle?.sessionId === sessionId ? this.kill(id) : false;
  }

  killSession(sessionId: string): number {
    const ids = [...this.handles.values()].filter((handle) => handle.sessionId === sessionId).map((handle) => handle.id);
    for (const id of ids) this.kill(id);
    return ids.length;
  }

  /** Drop an entry without killing (e.g. an already-exited process cleared from the panel). */
  remove(id: string): boolean {
    const sessionId = this.handles.get(id)?.sessionId ?? null;
    const existed = this.handles.delete(id);
    this.exited.delete(id);
    if (existed) this.notifySession(sessionId);
    return existed;
  }

  /** Count of processes still running — used to decide whether to show/refresh the panel. */
  runningCount(): number {
    let n = 0;
    for (const h of this.handles.values()) if (h.running()) n++;
    return n;
  }

  runningCountForSession(sessionId: string): number {
    let count = 0;
    for (const handle of this.handles.values()) if (handle.sessionId === sessionId && handle.running()) count++;
    return count;
  }

  waitForSessionIdle(sessionId: string): Promise<void> {
    if (this.runningCountForSession(sessionId) === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.idleWaiters.get(sessionId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.idleWaiters.set(sessionId, waiters);
    });
  }
}

/** Process-global singleton — background processes outlive any single turn, so (unlike the turn-scoped
 *  card/subagent emitters) this is a plain shared instance imported by both the plugin context wiring
 *  (registry.ts, as `ctx.processes`) and the daemon API routes (brain.ts). One Node process, one Map. */
export const processRegistry = new ProcessRegistry();
