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

/** Install process guards for one chat run. The disposer is part of the lifecycle contract: returning
 * to the menu and opening chat again must not retain listeners from the previous application. */
export function installExitGuards(teardown: () => void, disableMouse: () => void): () => void {
  const onSignal = (code: number) => (): void => { teardown(); disableMouse(); process.exit(code); };
  const onSigTerm = onSignal(143);
  const onSigHup = onSignal(129);
  const onFatal = (): void => { teardown(); disableMouse(); };
  process.once('exit', disableMouse);
  process.once('SIGTERM', onSigTerm);
  process.once('SIGHUP', onSigHup);
  process.once('uncaughtExceptionMonitor', onFatal);
  return (): void => {
    process.off('exit', disableMouse);
    process.off('SIGTERM', onSigTerm);
    process.off('SIGHUP', onSigHup);
    process.off('uncaughtExceptionMonitor', onFatal);
  };
}

/** Coordinate one idempotent quit. Terminal restoration is synchronous; the bound server session gets
 * one bounded best-effort stop before the application's run promise resolves. */
export function createQuitCoordinator(options: {
  teardown(): void;
  removeExitGuards(): void;
  stopBoundSession(signal: AbortSignal): Promise<void>;
  done(): void;
  timeoutMs?: number;
}): () => void {
  let quitting = false;
  return (): void => {
    if (quitting) return;
    quitting = true;
    options.teardown();
    options.removeExitGuards();
    const stopAc = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        stopAc.abort();
        resolve();
      }, options.timeoutMs ?? 750);
    });
    void Promise.race([
      Promise.resolve().then(() => options.stopBoundSession(stopAc.signal)).catch(() => {}),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      options.done();
    });
  };
}
