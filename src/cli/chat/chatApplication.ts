import type { Component, MarkdownTheme } from '@earendil-works/pi-tui';
import { createChatComposition } from './chatComposition.js';
import type { ChatComposition, ShellInputDeps } from './chatComposition.js';
import type { ChatRuntime } from './runtime.js';
import type { StreamController } from './streamController.js';
import { TerminalLifecycle } from './terminalLifecycle.js';
import type { TuiDiagnostics } from './tuiDiagnostics.js';

export type { ShellInputDeps } from './chatComposition.js';

export interface ChatApplicationOptions {
  rt: ChatRuntime;
  stream: StreamController;
  mdTheme: MarkdownTheme;
  diagnostics: TuiDiagnostics;
}

/** The real application root for one chat session. It constructs one cohesive production composition
 * from narrow runtime dependencies, owns its mounted root/controllers, and is the sole owner of terminal
 * lifecycle transitions. `shell.ts` remains only the stable factory boundary used by runChat. */
export class ChatApplication {
  readonly state: ChatRuntime;
  readonly root: Component;
  readonly terminalLifecycle: TerminalLifecycle;
  private readonly composition: ChatComposition;

  constructor(options: ChatApplicationOptions) {
    this.state = options.rt;
    this.composition = createChatComposition(options.rt, options.stream, options.mdTheme, options.diagnostics);
    this.root = this.composition.root;
    this.terminalLifecycle = new TerminalLifecycle({
      term: options.rt.term,
      tui: options.rt.tui,
      scheduler: {
        pause: () => this.pauseRendering(),
        resume: () => this.resumeRendering(),
        stop: () => this.stopRendering(),
      },
      forceRender: (reason) => this.renderForced(reason),
      beforeStop: () => this.disposeInteraction(),
    });
    options.rt.terminalLifecycle = this.terminalLifecycle;
  }

  render = (reason?: string): void => this.composition.render(reason);
  renderForced = (reason?: string): void => this.composition.renderForced(reason);
  attachInput = (deps: ShellInputDeps): void => this.composition.attachInput(deps);
  reshowPanel = (): void => this.composition.reshowPanel();
  reloadKeymap = (): void => this.composition.reloadKeymap();

  private pauseRendering(): void {
    this.composition.animations.pause();
    this.composition.renderShell.pause();
  }

  private resumeRendering(): void { this.composition.renderShell.resume(); }

  private stopRendering(): void {
    this.disposeInteraction();
    this.composition.renderShell.stop();
  }

  private disposeInteraction(): void {
    // The child drill-in owns an independent SSE + bounded hydration fallback. It is not covered by the
    // parent stream controller that runChat aborts, so the application must close it with the rest of
    // this session's interaction graph. Abort first to cancel fetch/timer work, then discard the view.
    this.state.childAc?.abort();
    this.state.childAc = null;
    this.state.childView = null;
    this.composition.dispose();
    this.composition.animations.stop();
    this.composition.inputRouter()?.stop();
    this.composition.overlays.stop();
  }
}
