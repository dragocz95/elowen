import { ALT_SCREEN_OFF, ALT_SCREEN_ON, DISABLE_MOUSE, ENABLE_MOUSE } from './terminalProtocol.js';

export type TerminalLifecycleState = 'new' | 'active' | 'suspended' | 'stopped';

export interface TerminalLifecycleDeps {
  term: { write(data: string): void };
  tui: { start(): void; stop(): void };
  scheduler: { pause(): void; resume(): void; stop(): void };
  forceRender(reason: string): void;
  beforeStop?(): void;
  dispose?(): void;
}

/** The sole owner of process-terminal mode for one chat run. State guards make every transition
 * idempotent and keep pi-tui cleanup inside the alternate buffer: `tui.stop()` must always happen before
 * `ALT_SCREEN_OFF`, including the external-editor suspend path. */
export class TerminalLifecycle {
  state: TerminalLifecycleState = 'new';

  constructor(private readonly deps: TerminalLifecycleDeps) {}

  start(): void {
    if (this.state !== 'new') return;
    try {
      this.enterScreen('lifecycle:start');
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  suspend(): void {
    if (this.state !== 'active') return;
    // Claim the transition first so a re-entrant signal/exit handler cannot execute the active teardown
    // twice. Every cleanup is best-effort: one broken tty write must not prevent raw mode or alt-screen
    // restoration attempts that follow it.
    this.state = 'suspended';
    this.attempt(() => this.deps.scheduler.pause());
    this.attempt(() => this.deps.term.write(DISABLE_MOUSE));
    this.attempt(() => this.deps.tui.stop());
    this.attempt(() => this.deps.term.write(ALT_SCREEN_OFF));
  }

  resume(): void {
    if (this.state !== 'suspended') return;
    try {
      this.enterScreen('lifecycle:resume');
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    if (this.state === 'stopped') return;
    const wasActive = this.state === 'active';
    this.state = 'stopped';
    if (wasActive) {
      this.attempt(() => this.deps.scheduler.pause());
      this.attempt(() => this.deps.term.write(DISABLE_MOUSE));
      this.attempt(() => this.deps.beforeStop?.());
      this.attempt(() => this.deps.tui.stop());
      this.attempt(() => this.deps.term.write(ALT_SCREEN_OFF));
    } else {
      this.attempt(() => this.deps.beforeStop?.());
    }
    this.attempt(() => this.deps.scheduler.stop());
    this.attempt(() => this.deps.dispose?.());
  }

  private enterScreen(reason: string): void {
    this.deps.term.write(ALT_SCREEN_ON);
    // Mark ownership immediately: if raw-mode startup or the first paint throws, stop() must still know
    // that the primary screen needs restoring.
    this.state = 'active';
    this.deps.scheduler.resume();
    this.deps.tui.start();
    this.deps.term.write(ENABLE_MOUSE);
    this.deps.forceRender(reason);
  }

  private attempt(action: () => void): void {
    try { action(); } catch { /* terminal teardown must continue through every remaining cleanup */ }
  }
}

export interface ShutdownCoordinatorOptions {
  /** Synchronous local teardown: restore terminal modes and abort application-owned work immediately. */
  teardown(): void | Promise<void>;
  /** Detached from the aborted application signal; bounded independently below. */
  stopBoundSession(signal: AbortSignal): Promise<void>;
  timeoutMs?: number;
}

export interface ShutdownCoordinator {
  (): Promise<void>;
  /** Execute the complete synchronous local boundary (terminal restoration + application abort) now. */
  teardownNow(): void;
}

/** One idempotent shutdown transaction for every exit path. Local terminal restoration starts
 * synchronously; completion waits only for a bounded best-effort daemon stop. */
export function createShutdownCoordinator(options: ShutdownCoordinatorOptions): ShutdownCoordinator {
  let pending: Promise<void> | null = null;
  let localStarted = false;
  let localCleanup: void | Promise<void> = undefined;
  const teardownNow = (): void => {
    if (localStarted) return;
    localStarted = true;
    try { localCleanup = options.teardown(); } catch { /* server stop must still be attempted */ }
  };
  const shutdown = (): Promise<void> => {
    if (pending) return pending;
    let finish!: () => void;
    pending = new Promise<void>((resolve) => { finish = resolve; });
    teardownNow();
    const stopAc = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        stopAc.abort(new Error('chat shutdown timed out'));
        resolve();
      }, options.timeoutMs ?? 750);
    });
    const serverCleanup = Promise.race([
      Promise.resolve().then(() => options.stopBoundSession(stopAc.signal)).catch(() => {}),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    void Promise.all([
      Promise.resolve(localCleanup).catch(() => {}),
      serverCleanup,
    ]).finally(() => {
      finish();
    });
    return pending;
  };
  return Object.assign(shutdown, { teardownNow });
}

/** Install process guards for one chat run. Signal handlers enter the same bounded shutdown transaction
 * as `/quit`; process exit is delayed until the daemon stop settles/times out, while terminal restoration
 * already happened synchronously inside `shutdown()`. */
export function installExitGuards(options: {
  shutdown(): Promise<void>;
  /** Explicit last-chance boundary: must not rely on a Promise continuation or timer. */
  teardownNow(): void;
  exit?(code: number): void;
}): () => void {
  const exit = options.exit ?? ((code: number): void => { process.exit(code); });
  let exiting = false;
  const onSignal = (code: number) => (): void => {
    if (exiting) return;
    exiting = true;
    options.teardownNow();
    void options.shutdown().finally(() => exit(code));
  };
  const onSigTerm = onSignal(143);
  const onSigHup = onSignal(129);
  // Node does not wait for asynchronous work from `exit` or an uncaught-exception monitor. Entering the
  // coordinator still guarantees its synchronous terminal teardown; the detached daemon stop is strictly
  // best-effort on these last-chance hooks. SIGTERM/SIGHUP above explicitly await the bounded promise.
  const onExit = (): void => { options.teardownNow(); void options.shutdown(); };
  const onFatal = (): void => { options.teardownNow(); void options.shutdown(); };
  process.once('exit', onExit);
  process.once('SIGTERM', onSigTerm);
  process.once('SIGHUP', onSigHup);
  process.once('uncaughtExceptionMonitor', onFatal);
  return (): void => {
    process.off('exit', onExit);
    process.off('SIGTERM', onSigTerm);
    process.off('SIGHUP', onSigHup);
    process.off('uncaughtExceptionMonitor', onFatal);
  };
}
