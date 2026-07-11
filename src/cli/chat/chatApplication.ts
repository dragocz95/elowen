import { TerminalLifecycle } from './terminalLifecycle.js';

export interface ShellInputDeps {
  cycleThinkingLevel(): void;
  openHelpModal(): void;
  openThemePicker(): void;
  openModelPicker(): void;
  openSessionsModal(): void;
}

interface ApplicationRenderOwner {
  pause(): void;
  resume(): void;
  stop(): void;
}

interface ApplicationAnimations {
  pause(): void;
  stop(): void;
}

interface ApplicationOverlays { stop(): void }
interface ApplicationInputRouter { stop(): void }

export interface ChatApplicationOptions {
  term: { write(data: string): void };
  tui: { start(): void; stop(): void };
  renderOwner: ApplicationRenderOwner;
  animations: ApplicationAnimations;
  overlays: ApplicationOverlays;
  inputRouter(): ApplicationInputRouter | null;
  render(reason?: string): void;
  renderForced(reason?: string): void;
  attachInput(deps: ShellInputDeps): void;
  showPanel(hidden?: boolean): void;
  reshowPanel(): void;
  reloadKeymap(): void;
  cleanup(): void;
}

/** Application-level owner for shell composition and terminal lifecycle. The legacy `createShell` factory
 * now returns this class; Task 7 only replaces the outer `runChat` entry graph, not another renderer. */
export class ChatApplication {
  readonly terminalLifecycle: TerminalLifecycle;

  constructor(private readonly options: ChatApplicationOptions) {
    this.terminalLifecycle = new TerminalLifecycle({
      term: options.term,
      tui: options.tui,
      scheduler: {
        pause: () => this.pauseRendering(),
        resume: () => this.resumeRendering(),
        stop: () => this.stopRendering(),
      },
      forceRender: (reason) => this.renderForced(reason),
      beforeStop: () => this.hideOverlays(),
    });
  }

  render = (reason?: string): void => this.options.render(reason);
  renderForced = (reason?: string): void => this.options.renderForced(reason);
  attachInput = (deps: ShellInputDeps): void => this.options.attachInput(deps);
  showPanel = (hidden?: boolean): void => this.options.showPanel(hidden);
  reshowPanel = (): void => this.options.reshowPanel();
  reloadKeymap = (): void => this.options.reloadKeymap();

  pauseRendering = (): void => {
    this.options.animations.pause();
    this.options.renderOwner.pause();
  };

  resumeRendering = (): void => this.options.renderOwner.resume();

  stopRendering = (): void => {
    this.options.animations.stop();
    this.options.inputRouter()?.stop();
    this.options.overlays.stop();
    this.options.renderOwner.stop();
  };

  hideOverlays = (): void => {
    this.options.cleanup();
    this.options.animations.stop();
    this.options.inputRouter()?.stop();
    this.options.overlays.stop();
  };
}
