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
